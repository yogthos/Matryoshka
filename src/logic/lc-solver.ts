/**
 * LC Solver using miniKanren
 *
 * This module bridges the gap between impure document operations
 * (grep, fuzzy_search) and pure logical reasoning (miniKanren).
 *
 * Architecture:
 * 1. Execute impure operations → Get results
 * 2. Convert results to miniKanren facts (conde of eq goals)
 * 3. Use miniKanren to solve filter/classify operations
 *
 * The LLM outputs LC intent, and this solver executes it.
 */

import type { LCTerm, CoercionType } from "./types.js";
import { fuseRRF, type LineResult } from "./rrf.js";
import { applyGravityDampening, type DampenableResult } from "./dampening.js";
import { QValueStore, rerank as rerankFn } from "./qvalue.js";
import { resolveConstraints } from "./constraint-resolver.js";
import { synthesizeExtractor, compileToFunction, prettyPrint, type Example } from "../synthesis/evalo/index.js";
import { synthesizeFromExamples } from "./relational-solver.js";
import { SynthesisIntegrator } from "./synthesis-integrator.js";

// Type for sandbox tools interface
export interface SolverTools {
  grep: (pattern: string) => Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }>;
  /**
   * Phase 3 — grep over an arbitrary haystack instead of the default
   * context. Used by `(grep "pat" HAYSTACK)`. The haystack can be
   * any string the LLM constructs: another loaded context via
   * `(context N)`, a binding's value, or a literal. Returns the
   * same shape as `grep` (line numbers are 1-indexed within the
   * haystack, not the default context). Optional — when undefined,
   * the solver falls back to in-line regex matching so single-doc
   * consumers don't have to wire it.
   */
  grepIn?: (
    pattern: string,
    haystack: string
  ) => Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }>;
  fuzzy_search: (query: string, limit?: number) => Array<{ line: string; lineNum: number; score: number }>;
  bm25: (query: string, limit?: number) => Array<{ line: string; lineNum: number; score: number }>;
  semantic: (query: string, limit?: number) => Array<{ line: string; lineNum: number; score: number }>;
  text_stats: () => { length: number; lineCount: number; sample: { start: string; middle: string; end: string } };
  context: string;
  /**
   * Pre-split document lines, owned by the tools instance.
   *
   * Keeping this on the tools (not in a module-level cache) means each
   * session is self-contained: two concurrent SolverTools for different
   * documents cannot clobber each other's line array, and disposing a
   * session lets the line array be garbage-collected.
   */
  lines: string[];
  /**
   * Phase 3 — multiple loaded documents addressable via `(context N)`.
   *
   * When set, `contexts[0]` is the default that primitives like grep
   * fall back to when no haystack is supplied (i.e., it should mirror
   * `context`). When unset, single-doc back-compat applies and
   * `(context 0)` falls back to the legacy `context` field. The two
   * fields coexist so single-doc consumers don't have to wire
   * `contexts` and so multi-doc consumers don't have to keep `context`
   * in sync — `context` is the source of truth for index 0 unless
   * `contexts` overrides it.
   */
  contexts?: string[];
  /**
   * Optional sub-LLM invoker for the `(llm_query …)` primitive.
   *
   * When present, the solver dispatches every `(llm_query …)` term
   * through this function — both top-level and nested inside
   * `map`/`filter`/`reduce` lambdas. When absent, `(llm_query …)`
   * throws a clear error naming the execution context.
   *
   * Only `runRLM` threads an `llmClient` through to here. Direct
   * `NucleusEngine` / `HandleSession` / `LatticeTool` consumers
   * deliberately leave this undefined — they run deterministic LC
   * queries without the option to recurse into an LLM.
   */
  llmQuery?: (prompt: string) => Promise<string>;
  /**
   * Optional batched sub-LLM invoker for the `(llm_batch …)` primitive.
   *
   * When present, the solver collects every per-item interpolated prompt
   * inside `(llm_batch COLL (lambda x (llm_query …)))` into a single
   * array and dispatches them through this callback in one call,
   * expecting an array of N responses in matching order. When absent,
   * `(llm_batch …)` throws a clear "not available" error naming the
   * execution context — callers that wire `llmQuery` typically wire
   * `llmBatch` too, but `llmBatch` without `llmQuery` is a valid
   * configuration (the batch primitive never delegates item-by-item).
   *
   * The optional `options` argument carries extra flags lifted from
   * the batch's surface syntax — currently only `calibrate`, which
   * tells the bridge to prepend a calibration directive to the
   * batched suspension request. Options are additive: implementers
   * MAY ignore them for wire compatibility.
   */
  llmBatch?: (
    prompts: string[],
    options?: { calibrate?: boolean }
  ) => Promise<string[]>;
  /**
   * Optional recursive child-session invoker for the `(rlm_query …)`
   * primitive. Phase 1 of the recursive-Nucleus port.
   *
   * The solver evaluates the optional `(context EXPR)` form, stringifies
   * the resulting value into a clean line-oriented document (one item
   * per line for arrays, the string itself for strings, `null` when no
   * context is supplied), and dispatches through this callback. The
   * callback is responsible for spawning a child Nucleus FSM session
   * with that document, running it to completion, and returning the
   * child's FINAL string.
   *
   * When undefined, `(rlm_query …)` fails with a clear error naming
   * the execution context — the same pattern llmQuery uses for the
   * standalone-vs-RLM-loop distinction.
   */
  rlmQuery?: (prompt: string, contextDoc: string | null) => Promise<string>;
  /**
   * Optional batched recursive-child invoker for the `(rlm_batch …)`
   * primitive. Phase 2 of the recursive-Nucleus port.
   *
   * The solver collects per-item (prompt, materialized contextDoc)
   * pairs from the inner rlm_query template and dispatches them
   * through this callback in ONE call. The implementation is
   * responsible for fanning the items out concurrently — typically
   * via `Promise.all` over child session spawns, optionally bounded
   * by a worker pool. The returned array MUST have one entry per
   * input item, in the same order.
   *
   * When undefined, `(rlm_batch …)` fails with a clear error naming
   * the execution context — same pattern as rlmQuery / llmBatch.
   */
  rlmBatch?: (
    items: Array<{ prompt: string; contextDoc: string | null }>
  ) => Promise<string[]>;
}

/**
 * Bindings map for cross-turn state
 * Maps variable names to their values from previous turns
 */
export type Bindings = Map<string, unknown>;

const moduleQStore = new QValueStore();

/**
 * Walk the pattern with a paren stack to detect any group that has
 * an internal quantifier AND a trailing quantifier — the canonical
 * shape of catastrophic backtracking, e.g. (a+)+, (a*)+, (.*(.*).*)+,
 * ((a|b)+)+, (?:a+)+. A regex-only check can't see through nested
 * parens; the scanner skips escapes and character classes so it
 * doesn't false-positive on literal `(`/`)`/quantifier chars.
 */
function hasNestedQuantifier(pattern: string): boolean {
  const stack: { hasQuantInside: boolean }[] = [];
  const isQuant = (c: string) => c === "+" || c === "*" || c === "{";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      // Skip character class — its contents aren't group structure.
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "(") {
      stack.push({ hasQuantInside: false });
      i++;
      continue;
    }
    if (c === ")") {
      const top = stack.pop();
      i++;
      if (i < pattern.length && isQuant(pattern[i])) {
        if (top?.hasQuantInside) return true;
        // Trailing quantifier on this group counts as a quantifier
        // in the parent group's body for the next iteration.
        if (stack.length > 0) stack[stack.length - 1].hasQuantInside = true;
      }
      continue;
    }
    if (isQuant(c) && stack.length > 0) {
      stack[stack.length - 1].hasQuantInside = true;
    }
    i++;
  }
  return false;
}

/**
 * Validate a regex pattern for safety (ReDoS protection)
 */
export function validateRegex(pattern: string): { valid: boolean; error?: string } {
  // Reject empty patterns
  if (!pattern) {
    return { valid: false, error: "Empty regex pattern" };
  }

  // Reject excessively long patterns
  if (pattern.length > 500) {
    return { valid: false, error: `Regex pattern too long (${pattern.length} chars, max 500)` };
  }

  // Reject nested quantifiers that cause catastrophic backtracking.
  if (hasNestedQuantifier(pattern)) {
    return { valid: false, error: "Regex contains nested quantifiers which may cause catastrophic backtracking" };
  }

  // Verify the pattern is a valid regex
  try {
    new RegExp(pattern);
  } catch (err) {
    return { valid: false, error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { valid: true };
}

/**
 * Module-level synthesis integrator for caching across calls
 */
const synthesisIntegrator = new SynthesisIntegrator();

/**
 * Append a `(one_of …)` enum-constraint directive to a prompt so the
 * sub-LLM knows the exact set of allowed responses. Each value is
 * JSON-stringified so quoting/escaping is unambiguous when a value
 * happens to contain whitespace or special characters.
 */
function appendOneOfDirective(prompt: string, oneOf: string[]): string {
  return (
    prompt +
    `\n\nAnswer with exactly one (no other text): ` +
    oneOf.map((v) => JSON.stringify(v)).join(" | ")
  );
}

/**
 * Validate a sub-LLM response against a `(one_of …)` enum constraint.
 * Trims, lowercases, and matches against the enum set. Returns the
 * CANONICAL value (original casing from the declaration) on success so
 * downstream `(filter …)` / `(count …)` can do exact string comparisons.
 * Returns `null` if no enum value matches.
 */
function canonicalizeOneOf(
  response: string,
  oneOf: string[]
): string | null {
  const normalized = response.trim().toLowerCase();
  for (const candidate of oneOf) {
    if (candidate.toLowerCase() === normalized) {
      return candidate;
    }
  }
  return null;
}

/**
 * Convert a resolved `(context EXPR)` value into a clean line-oriented
 * document for a child Nucleus session.
 *
 * Strings pass through untouched. Arrays join their stringified items
 * by newlines so the child's `^anchor` regexes work — the primary
 * differentiator from the existing llm_query path, which JSON-
 * stringifies the binding and pollutes line starts with `[`/`{`/quotes.
 *
 * Per-item stringification: grep-result-like objects (anything with a
 * string `.line` field) yield that field's value, since that's the
 * "one item per line" representation users expect when piping grep
 * results into a child. Other objects fall back to compact JSON.
 * Strings, numbers, booleans become their natural string form;
 * null/undefined become "".
 *
 * Output is capped at MAX_CONTEXT_DOC_CHARS to bound child memory
 * footprint; longer values are silently truncated. The cap is
 * intentionally larger than llm_query's 500k interpolation cap
 * because rlm_query passes the value as a child DOCUMENT (where the
 * matryoshka 50MB doc limit applies), not as prompt text.
 */
const MAX_CONTEXT_DOC_CHARS = 5_000_000;

function stringifyItem(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  if (typeof item === "object") {
    const obj = item as Record<string, unknown>;
    if (typeof obj.line === "string") return obj.line;
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }
  return String(item);
}

/**
 * Top-level dispatch for `(rlm_query …)` context materialization.
 * Returns a string; an empty string ("") is a valid output (e.g., the
 * user passed `(context [])` — empty array). Callers MUST distinguish
 * this from `null` (no `(context …)` form supplied) when deciding
 * whether to fall back to using the prompt as the child's document.
 */
function materializeContext(value: unknown): string {
  let out: string;
  if (value === null || value === undefined) {
    out = "";
  } else if (typeof value === "string") {
    out = value;
  } else if (Array.isArray(value)) {
    out = value.map(stringifyItem).join("\n");
  } else if (typeof value === "number" || typeof value === "boolean") {
    out = String(value);
  } else {
    // Object that isn't an array — use the same line-extraction
    // heuristic as for array items.
    out = stringifyItem(value);
  }
  if (out.length > MAX_CONTEXT_DOC_CHARS) {
    out = out.slice(0, MAX_CONTEXT_DOC_CHARS);
  }
  return out;
}

/**
 * Solve result
 */
export interface SolveResult {
  success: boolean;
  value: unknown;
  logs: string[];
  error?: string;
}

/**
 * Solve an LC term using miniKanren as the logic engine
 * @param term The LC term to evaluate
 * @param tools Document tools (grep, fuzzy_search, etc.)
 * @param bindings Optional variable bindings from previous turns
 */
export async function solve(
  term: LCTerm,
  tools: SolverTools,
  bindings: Bindings = new Map()
): Promise<SolveResult> {
  const logs: string[] = [];
  const MAX_LOG_ENTRIES = 10000;
  const MAX_LOG_MSG_LENGTH = 2000;
  const log = (msg: string) => {
    if (logs.length < MAX_LOG_ENTRIES) {
      logs.push(msg.length > MAX_LOG_MSG_LENGTH ? msg.slice(0, MAX_LOG_MSG_LENGTH) + "..." : msg);
    }
  };

  // Log available bindings
  if (bindings.size > 0) {
    log(`[Solver] Available bindings: ${[...bindings.keys()].join(", ")}`);
  }

  try {
    // Resolve constraints first
    const resolved = resolveConstraints(term);
    // evaluate() handles every term tag uniformly, including
    // `(llm_query …)` in both top-level and nested positions.
    const value = await evaluate(resolved.term, tools, bindings, log, 0);
    return { success: true, value, logs };
  } catch (err) {
    return {
      success: false,
      value: null,
      logs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}


const MAX_EVAL_DEPTH = 200;

function toItemString(item: unknown): string {
  if (typeof item === "string") return item;
  if (item == null) return "";
  if (typeof item === "object") {
    if ("line" in item) return (item as { line: string }).line;
    if ("name" in item) return (item as { name: string }).name;
    try { return JSON.stringify(item); } catch { return String(item); }
  }
  return String(item);
}

/**
 * Evaluate an LC term
 * Impure operations execute directly, pure operations use miniKanren
 */
async function evaluate(
  term: LCTerm,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): Promise<unknown> {
  if (depth > MAX_EVAL_DEPTH) {
    throw new Error("Maximum evaluation depth exceeded (possible infinite recursion)");
  }
  switch (term.tag) {
    case "lit":
      return term.value;

    case "var":
      if (term.name === "context") {
        return tools.context;
      }
      // Check bindings for cross-turn state
      if (bindings.has(term.name)) {
        log(`[Solver] Resolved variable ${term.name} from bindings`);
        return bindings.get(term.name);
      }
      throw new Error(`Unbound variable: ${term.name}`);

    case "input":
      return tools.context;

    // ==========================
    // IMPURE OPERATIONS - Execute directly, return facts
    // ==========================

    case "grep": {
      // Smart escaping: if pattern contains special regex chars that look like
      // they should be literal (e.g., "$" for currency, "." alone), escape them
      let pattern = term.pattern;

      // Empty pattern means "match all lines" — convert to wildcard
      if (!pattern) {
        pattern = "^";
        log(`[Solver] Empty grep pattern -> "^" (match all lines)`);
      } else if (/^[\$\.\^\*\+\?\[\]\(\)\{\}\|\\]$/.test(pattern)) {
        pattern = "\\" + pattern;
        log(`[Solver] Auto-escaped special regex char: "${term.pattern}" -> "${pattern}"`);
      }

      // Validate regex for safety (ReDoS protection)
      const regexValidation = validateRegex(pattern);
      if (!regexValidation.valid) {
        throw new Error(`Invalid regex pattern: ${regexValidation.error}`);
      }

      // Phase 3 — optional haystack arg. The haystack MUST evaluate
      // to a string. Numbers/booleans get rendered cleanly via
      // String(); arrays/objects/null/undefined are rejected with a
      // specific error so a typo (e.g. `(grep "X" RESULTS)` where
      // RESULTS is the latest grep result array) doesn't silently
      // coerce to "[object Object]" and produce garbage matches.
      // Per project rule: correctness > performance — surface user
      // mistakes loudly.
      if (term.haystack) {
        const hayValue = await evaluate(term.haystack, tools, bindings, log, depth + 1);
        let haystack: string;
        if (typeof hayValue === "string") {
          haystack = hayValue;
        } else if (typeof hayValue === "number" || typeof hayValue === "boolean") {
          haystack = String(hayValue);
        } else {
          const shape = Array.isArray(hayValue)
            ? `array(${hayValue.length})`
            : hayValue === null
              ? "null"
              : hayValue === undefined
                ? "undefined"
                : typeof hayValue;
          throw new Error(
            `(grep "${term.pattern}" HAYSTACK): haystack must evaluate to a string, got ${shape}. ` +
              `If you have an array, materialize it first (e.g., join lines) or grep an individual element.`
          );
        }
        log(
          `[Solver] Executing grep("${pattern}") over haystack (${haystack.length} chars)`
        );
        if (tools.grepIn) {
          const results = tools.grepIn(pattern, haystack);
          log(`[Solver] Found ${results.length} matches in haystack`);
          return results;
        }
        // Fallback in-line search — same shape as the production
        // grep callback. Used by test stubs that don't provide
        // grepIn AND legacy SolverTools instances. ReDoS validated
        // upstream by the same validateRegex call we already ran.
        const flags = "gmi";
        const regex = new RegExp(pattern, flags);
        const lines = haystack.split("\n");
        const results: Array<{
          match: string;
          line: string;
          lineNum: number;
          index: number;
          groups: string[];
        }> = [];
        const MAX_HAYSTACK_MATCHES = 10_000;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(haystack)) !== null) {
          const beforeMatch = haystack.slice(0, m.index);
          const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;
          results.push({
            match: m[0],
            line: lines[lineNum - 1] ?? "",
            lineNum,
            index: m.index,
            groups: m.slice(1).filter((g): g is string => g !== undefined),
          });
          if (m[0].length === 0) regex.lastIndex++;
          if (results.length >= MAX_HAYSTACK_MATCHES) break;
        }
        log(`[Solver] Found ${results.length} matches in haystack (in-line fallback)`);
        return results;
      }

      log(`[Solver] Executing grep("${pattern}")`);
      const results = tools.grep(pattern);
      log(`[Solver] Found ${results.length} matches`);
      if (results.length > 0) {
        log(`[Solver] Sample matches:`);
        results.slice(0, 5).forEach((r, i) => {
          log(`  ${i + 1}. [line ${r.lineNum}] ${r.line.slice(0, 80)}`);
        });
      }
      return results;
    }

    case "show_vars": {
      // Phase 4 — binding introspection. Returns a string summary
      // that can be inlined into a sub-LLM prompt, used in a
      // FINAL_VAR substitution, or just passed back to the user as
      // the answer. Format mirrors `lattice_bindings` in spirit but
      // is reachable from inside a query.
      //
      // Internal bindings start with `_` followed by a non-digit
      // character (e.g., `_sessionDB`, `_compaction_trace`). These
      // are private plumbing the user shouldn't see — surfacing
      // them would expose internal state and confuse the LLM about
      // what it can FINAL_VAR-reference. User-visible bindings:
      // RESULTS, plain names, and `_<digits>` (per-turn results).
      const isInternal = (name: string): boolean =>
        name.startsWith("_") && name.length > 1 && !/^_\d/.test(name);
      const visibleEntries = [...bindings].filter(([n]) => !isInternal(n));
      if (visibleEntries.length === 0) {
        return "No bindings yet — run a query to populate RESULTS or a binding name.";
      }
      const lines: string[] = [];
      for (const [name, value] of visibleEntries) {
        let shape: string;
        if (Array.isArray(value)) {
          shape = `Array(${value.length})`;
        } else if (typeof value === "string") {
          shape = `String(${value.length})`;
        } else if (typeof value === "number") {
          shape = `Number(${value})`;
        } else if (typeof value === "boolean") {
          shape = `Boolean(${value})`;
        } else if (value === null) {
          shape = "null";
        } else if (value === undefined) {
          shape = "undefined";
        } else if (typeof value === "object") {
          shape = "object";
        } else {
          shape = typeof value;
        }
        lines.push(`  ${name}: ${shape}`);
      }
      return `Bindings (${visibleEntries.length}):\n${lines.join("\n")}`;
    }

    case "context": {
      // Phase 3 — `(context N)` selector. Returns the Nth loaded
      // context's content. Falls back to `tools.context` when
      // `contexts` is unset and the index is 0 — back-compat for
      // single-doc workflows that haven't wired the new field.
      const idx = term.index;
      if (tools.contexts) {
        if (idx < 0 || idx >= tools.contexts.length) {
          throw new Error(
            `(context ${idx}): index out of range — ${tools.contexts.length} context(s) loaded`
          );
        }
        return tools.contexts[idx];
      }
      if (idx === 0) return tools.context;
      throw new Error(
        `(context ${idx}): only 1 context loaded — use runRLMFromContent with an array to enable multi-context`
      );
    }

    case "fuzzy_search": {
      const fuzzyLimit = Math.min(Math.max(1, term.limit ?? 10), 1000);
      log(`[Solver] Executing fuzzy_search("${term.query}", ${fuzzyLimit})`);
      const results = tools.fuzzy_search(term.query, fuzzyLimit);
      log(`[Solver] Found ${results.length} fuzzy matches`);
      return results;
    }

    case "bm25": {
      const bm25Limit = Math.min(Math.max(1, term.limit ?? 10), 1000);
      log(`[Solver] Executing bm25("${term.query}", ${bm25Limit})`);
      const results = tools.bm25(term.query, bm25Limit);
      log(`[Solver] Found ${results.length} BM25 matches`);
      if (results.length > 0) {
        log(`[Solver] Top BM25 results:`);
        results.slice(0, 5).forEach((r, i) => {
          log(`  ${i + 1}. [line ${r.lineNum}, score ${r.score.toFixed(2)}] ${r.line.slice(0, 80)}`);
        });
      }
      return results;
    }

    case "fuse": {
      // Evaluate all collection sub-expressions
      const signals: LineResult[][] = [];
      for (const coll of term.collections) {
        const result = await evaluate(coll, tools, bindings, log, depth + 1);
        if (!Array.isArray(result)) {
          throw new Error(`fuse: expected array argument, got ${typeof result}`);
        }
        // Normalize to LineResult format — grep results have {match, line, lineNum, index, groups}
        // bm25/fuzzy have {line, lineNum, score} — ensure all have score
        const normalized: LineResult[] = (result as unknown[]).map((item: unknown) => {
          const obj = item as Record<string, unknown>;
          return {
            ...(obj as object),
            line: typeof obj.line === "string" ? obj.line : obj.line != null ? String(obj.line) : "",
            lineNum: Number(obj.lineNum ?? 0),
            score: Number(obj.score ?? 1),
          };
        });
        signals.push(normalized);
      }
      log(`[Solver] Fusing ${signals.length} signals (${signals.map(s => s.length).join(" + ")} results)`);
      const fused = fuseRRF(signals);
      log(`[Solver] Fused into ${fused.length} results`);
      return fused;
    }

    case "dampen": {
      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`dampen: expected array, got ${typeof collection}`);
      }
      // Normalize to DampenableResult — ensure all have line, lineNum, score
      const results: DampenableResult[] = (collection as unknown[]).map((item: unknown) => {
        const obj = item as Record<string, unknown>;
        return {
          ...(obj as object),
          line: typeof obj.line === "string" ? obj.line : obj.line != null ? String(obj.line) : "",
          lineNum: Number(obj.lineNum ?? 0),
          score: Number(obj.score ?? 1),
        };
      });
      log(`[Solver] Applying gravity dampening to ${results.length} results with query "${term.query}"`);
      const dampened = applyGravityDampening(results, term.query);
      const dampenedCount = results.filter((r, i) => r.score !== dampened[i].score).length;
      log(`[Solver] Dampened ${dampenedCount} of ${results.length} results`);
      return dampened;
    }

    case "rerank": {
      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`rerank: expected array, got ${typeof collection}`);
      }
      // Normalize to LineResult format
      const normalized = (collection as unknown[]).map((item: unknown) => {
        const obj = item as Record<string, unknown>;
        return {
          ...(obj as object),
          line: typeof obj.line === "string" ? obj.line : obj.line != null ? String(obj.line) : "",
          lineNum: Number(obj.lineNum ?? 0),
          score: Number(obj.score ?? 1),
        };
      });
      const store = moduleQStore;
      const prevResults = bindings.get("RESULTS");
      if (Array.isArray(prevResults) && prevResults.length > 0) {
        const prevLineNums = prevResults
          .filter((r: unknown) => typeof r === "object" && r !== null && "lineNum" in (r as Record<string, unknown>))
          .map((r: unknown) => Number((r as Record<string, unknown>).lineNum));
        if (prevLineNums.length > 0) {
          store.rewardReusedLines(prevLineNums, 0.4);
          log(`[Solver] Auto-rewarded ${prevLineNums.length} lines from previous RESULTS`);
        }
      }

      log(`[Solver] Reranking ${normalized.length} results (Q-store: ${store.getTotalUpdates()} updates)`);
      const reranked = rerankFn(normalized, store);
      log(`[Solver] Reranked ${reranked.length} results`);
      return reranked;
    }

    case "semantic": {
      const semanticLimit = Math.min(Math.max(1, term.limit ?? 10), 1000);
      log(`[Solver] Executing semantic("${term.query}", ${semanticLimit})`);
      const results = tools.semantic(term.query, semanticLimit);
      log(`[Solver] Found ${results.length} semantic matches`);
      return results;
    }

    case "text_stats": {
      log(`[Solver] Getting document statistics`);
      const stats = tools.text_stats();
      log(`[Solver] Document: ${stats.length} chars, ${stats.lineCount} lines`);
      return stats;
    }

    case "lines": {
      // Validate start/end are finite positive integers
      if (!Number.isFinite(term.start) || !Number.isFinite(term.end) || term.start < 1 || term.end < 1) {
        log(`[Solver] Invalid line range: ${term.start} to ${term.end}`);
        return [];
      }
      log(`[Solver] Getting lines ${term.start} to ${term.end}`);
      const allLines = tools.lines;
      const startIdx = Math.max(0, Math.floor(term.start) - 1);
      const endIdx = Math.min(allLines.length, Math.floor(term.end));
      const selectedLines = allLines.slice(startIdx, endIdx);
      log(`[Solver] Retrieved ${selectedLines.length} lines`);
      // Return array of strings to be compatible with filter/map
      return selectedLines;
    }

    case "chunk_by_size": {
      // Split the document context into fixed-size character chunks. The
      // last chunk may be shorter than `size`. The primary use-case is
      // feeding each chunk into a per-chunk sub-LLM call via a map lambda.
      const size = term.size;
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`chunk_by_size: size must be a positive finite number, got ${size}`);
      }
      const intSize = Math.floor(size);
      // Cap at MAX_CHUNKS to prevent an adversarial `(chunk_by_size 1)` over
      // a 10MB document from producing a 10M-element array that blows up
      // downstream handle storage. This is large enough that real use-cases
      // (2KB chunks of a 50MB file = 25_000 chunks) stay well under it.
      const MAX_CHUNKS = 100_000;
      const ctx = tools.context;
      if (ctx.length === 0) return [];
      const chunks: string[] = [];
      for (let i = 0; i < ctx.length && chunks.length < MAX_CHUNKS; i += intSize) {
        chunks.push(ctx.slice(i, i + intSize));
      }
      log(`[Solver] chunk_by_size(${intSize}): produced ${chunks.length} chunks`);
      return chunks;
    }

    case "chunk_by_lines": {
      // Split the document into N-line chunks. Trailing remainder (<N lines)
      // becomes its own chunk.
      const n = term.lineCount;
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`chunk_by_lines: lineCount must be a positive finite number, got ${n}`);
      }
      const intN = Math.floor(n);
      const MAX_CHUNKS = 100_000;
      const allLines = tools.lines;
      if (allLines.length === 0) return [];
      const chunks: string[] = [];
      for (let i = 0; i < allLines.length && chunks.length < MAX_CHUNKS; i += intN) {
        chunks.push(allLines.slice(i, i + intN).join("\n"));
      }
      log(`[Solver] chunk_by_lines(${intN}): produced ${chunks.length} chunks`);
      return chunks;
    }

    case "seq": {
      // Evaluate each subexpr in order, threading bindings through.
      // Each subexpr's result is bound to RESULTS (when it's an array)
      // and to a fresh `_seqN` slot, making it visible to later
      // subexprs. The whole seq evaluates to the value of the LAST
      // subexpr.
      //
      // Per project rule (correctness > performance): subexprs run
      // sequentially even though some pairs are independent —
      // dependent expressions are the common case (later steps
      // reference RESULTS of earlier steps), and parallel scheduling
      // would require dataflow analysis we don't have.
      const MAX_SEQ_EXPRS_RUNTIME = 64;
      if (term.exprs.length === 0) {
        throw new Error("seq: empty seq is meaningless");
      }
      if (term.exprs.length > MAX_SEQ_EXPRS_RUNTIME) {
        throw new Error(`seq: too many subexprs (${term.exprs.length} > ${MAX_SEQ_EXPRS_RUNTIME})`);
      }
      let last: unknown = null;
      for (let i = 0; i < term.exprs.length; i++) {
        const sub = term.exprs[i];
        last = await evaluate(sub, tools, bindings, log, depth + 1);
        // Make every step's result available to subsequent steps so the
        // model can write `(seq (grep ...) (count RESULTS))`. Mirror
        // what handleAnalyze does at the FSM boundary, but in-loop so
        // RESULTS is fresh inside the same turn.
        if (Array.isArray(last)) {
          bindings.set("RESULTS", last);
        }
        bindings.set(`_seq${i + 1}`, last);
      }
      return last;
    }

    case "chunk_by_regex": {
      // Split the document wherever `pattern` matches. Empty chunks
      // produced by adjacent delimiters are dropped — the paper's OOLONG
      // pattern wants "substantive" chunks to feed to sub-LLMs, not empty
      // strings between `\n\n\n\n` sequences.
      //
      // We deliberately DO NOT use `String.prototype.split(regex)` here:
      // when the user's pattern contains capturing groups, `split`
      // interleaves the captured text into the output array, producing
      // surprising chunks that include delimiter characters. Instead we
      // manually walk matches via matchAll() and extract the text
      // between them, which treats captures as a no-op.
      const pat = term.pattern;
      if (typeof pat !== "string" || pat.length === 0) {
        throw new Error("chunk_by_regex: pattern must be a non-empty string");
      }
      const validation = validateRegex(pat);
      if (!validation.valid) {
        throw new Error(`chunk_by_regex: invalid pattern "${pat}" — ${validation.error}`);
      }
      // Force the global flag so matchAll() can iterate all matches.
      // new RegExp(pat, "g") is safe even when the user's pattern
      // already implies global — JS accepts duplicate-meaning flags
      // via the string form as long as each character appears once.
      const regex = new RegExp(pat, "g");
      const ctx = tools.context;
      if (ctx.length === 0) return [];
      const MAX_CHUNKS = 100_000;

      const chunks: string[] = [];
      let cursor = 0;
      let matches = 0;
      // Cap match iteration independently so a pathological regex that
      // matches millions of zero-width positions (which would be blocked
      // by the infinite-loop guard below anyway) doesn't burn CPU
      // building an intermediate array via [...matchAll()].
      const MAX_MATCH_ITERATIONS = MAX_CHUNKS + 1;
      for (const m of ctx.matchAll(regex)) {
        if (matches++ >= MAX_MATCH_ITERATIONS) break;
        const start = m.index ?? cursor;
        // Slice content between the previous match end and this match.
        if (start > cursor) {
          chunks.push(ctx.slice(cursor, start));
        }
        // Advance past this match. Zero-width matches would loop
        // forever otherwise, so we force forward progress by at least
        // one char.
        const matchLen = m[0].length;
        cursor = start + (matchLen === 0 ? 1 : matchLen);
        if (chunks.length >= MAX_CHUNKS) break;
      }
      // Trailing content after the last match.
      if (cursor < ctx.length && chunks.length < MAX_CHUNKS) {
        chunks.push(ctx.slice(cursor));
      }

      // Drop empty chunks from adjacent delimiters (e.g. "\n\n\n\n"
      // matched by "\n\n" yields one empty middle piece).
      const nonEmpty = chunks.filter((c) => c.length > 0);
      log(`[Solver] chunk_by_regex(/${pat}/): produced ${nonEmpty.length} chunks from ${matches} matches`);
      return nonEmpty;
    }

    // ==========================
    // PURE OPERATIONS - Use miniKanren for filtering/classification
    // ==========================

    case "filter": {
      // Evaluate the collection first (may be grep, fuzzy_search, etc.)
      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1) as Array<{ line: string; lineNum: number }>;
      if (!Array.isArray(collection)) {
        throw new Error(`filter: expected array, got ${typeof collection}`);
      }

      // The predicate is a lambda - extract pattern to match
      if (term.predicate.tag !== "lambda") {
        throw new Error(`filter: predicate must be a lambda`);
      }

      const predLambda = term.predicate;
      const predBody = predLambda.body;

      log(`[Solver] Converting ${collection.length} items to filter`);

      // Evaluate predicate for each item
      const results: unknown[] = [];

      for (let idx = 0; idx < collection.length; idx++) {
        const item = collection[idx];
        const itemValue = toItemString(item);

        const matches = await evaluatePredicate(predBody, predLambda.param, itemValue, tools, bindings, log, depth + 1);
        if (matches) {
          results.push(item);
        }
      }

      log(`[Solver] Filter kept ${results.length} of ${collection.length} items`);
      return results;
    }

    case "map": {
      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1) as Array<{ line: string; lineNum: number }>;
      if (!Array.isArray(collection)) {
        throw new Error(`map: expected array, got ${typeof collection}`);
      }

      if (term.transform.tag !== "lambda") {
        throw new Error(`map: transform must be a lambda`);
      }

      const transformLambda = term.transform;
      log(`[Solver] Mapping over ${collection.length} items`);

      // Sequential iteration by design. When the lambda is pure (just
      // regex match/extract) the sequential cost is negligible. When
      // the lambda contains `(llm_query …)`, each iteration fires a
      // sub-LLM call and sequential means N blocking round-trips —
      // slow but deterministic. A future optimization can parallelize
      // pure map bodies via `Promise.all`, or run llm_query lambdas
      // with a bounded concurrency limit; both are separate PRs that
      // need their own latency/ordering testing and are flagged in
      // the paper's own limitations as the biggest performance win
      // still on the table.
      const results: unknown[] = [];
      for (const item of collection) {
        const itemValue = toItemString(item);

        const value = await evaluateTransform(
          transformLambda.body,
          transformLambda.param,
          itemValue,
          tools,
          bindings,
          log,
          depth + 1
        );
        results.push(value);
      }

      return results;
    }

    case "sum": {
      // Sum numeric values in array - works with any numeric array
      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`sum: expected array, got ${typeof collection}`);
      }
      log(`[Solver] Summing ${collection.length} values`);
      let skippedCount = 0;
      const total = collection.reduce((acc: number, val: unknown) => {
        if (typeof val === "number") {
          if (!Number.isFinite(val)) { skippedCount++; return acc; }
          return acc + val;
        }
        if (typeof val === "string") {
          // Try to parse numeric string (handles "$1,000" format)
          const cleaned = val.replace(/[$,]/g, "");
          const num = parseFloat(cleaned);
          if (!Number.isFinite(num)) {
            skippedCount++;
            return acc;
          }
          return acc + num;
        }
        // Handle grep result objects - extract first number from line.
        // Prefer a $-prefixed value (e.g. "Sales: $1,500") if present, else
        // fall back to the first numeric token. Summing ALL numbers per line
        // silently conflates unrelated values (e.g. "Error 500: timeout 30s"
        // would contribute 530 instead of 500), which is a data-corruption
        // footgun for log and report analysis.
        if (typeof val === "object" && val !== null && "line" in val) {
          const line = (val as { line: string }).line;
          const dollarMatch = line.match(/\$([\d,]+(?:\.\d+)?)/);
          const firstMatch = dollarMatch ?? line.match(/([\d,]+(?:\.\d+)?)/);
          if (firstMatch) {
            const cleaned = firstMatch[1].replace(/,/g, "");
            const num = parseFloat(cleaned);
            if (Number.isFinite(num)) {
              return acc + num;
            }
          }
        }
        skippedCount++;
        return acc;
      }, 0);
      if (skippedCount > 0) {
        log(`[Solver] Warning: skipped ${skippedCount} non-numeric/unparseable values`);
      }
      if (!Number.isFinite(total)) {
        log(`[Solver] Sum overflow: result is not finite`);
        return null;
      }
      log(`[Solver] Sum = ${total}`);
      return total;
    }

    case "count": {
      // Count items in array
      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`count: expected array, got ${typeof collection}`);
      }
      log(`[Solver] Count = ${collection.length}`);
      return collection.length;
    }

    case "reduce": {
      const MAX_REDUCE_ITERATIONS = 10000;
      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`reduce: expected array, got ${typeof collection}`);
      }
      const init = await evaluate(term.init, tools, bindings, log, depth + 1);
      if (term.fn.tag !== "lambda") {
        throw new Error(`reduce: fn must be a lambda`);
      }
      const items = collection.slice(0, MAX_REDUCE_ITERATIONS);
      if (collection.length > MAX_REDUCE_ITERATIONS) {
        log(`[Solver] Warning: reduce capped at ${MAX_REDUCE_ITERATIONS} of ${collection.length} items`);
      }
      log(`[Solver] Reducing ${items.length} items`);
      let acc = init;
      for (const item of items) {
        acc = await evaluateReduceFn(term.fn, acc, item, tools, bindings, log, depth + 1);
      }
      return acc;
    }

    case "classify": {
      // Classify builds a predicate from examples
      // Use miniKanren to find a pattern that matches the examples
      log(`[Solver] Building classifier from ${term.examples.length} examples`);

      // Filter empty strings — they match everything and corrupt pattern finding
      const trueExamples = term.examples.filter(e => e.output === true).map(e => e.input).filter(s => s.length > 0);
      const falseExamples = term.examples.filter(e => e.output === false).map(e => e.input).filter(s => s.length > 0);

      log(`[Solver] True examples: ${trueExamples.length}, False examples: ${falseExamples.length}`);

      // Use miniKanren to find distinguishing pattern
      const pattern = findDistinguishingPattern(trueExamples, falseExamples);

      if (!pattern) {
        log(`[Solver] Could not find distinguishing pattern`);
        return null;
      }

      log(`[Solver] Found pattern: ${pattern}`);

      // Return a classifier function with case-insensitive matching
      const classifyValidation = validateRegex(pattern);
      if (!classifyValidation.valid) return null;
      const regex = new RegExp(pattern, "i");
      return (line: string) => regex.test(line);
    }

    // ==========================
    // STRING OPERATIONS
    // ==========================

    case "match": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1) as string;
      if (typeof str !== "string") {
        throw new Error(`match: expected string, got ${typeof str}`);
      }
      if (!Number.isInteger(term.group) || term.group < 0 || term.group > 99) return null;
      const matchValidation = validateRegex(term.pattern);
      if (!matchValidation.valid) {
        throw new Error(`match: ${matchValidation.error}`);
      }
      // Case-insensitive for consistency with grep and extract
      const regex = new RegExp(term.pattern, "i");
      const result = str.match(regex);
      if (!result) return null;
      if (term.group >= result.length) {
        log(`[Solver] match: group ${term.group} out of bounds (result has ${result.length} groups)`);
        return null;
      }
      return result[term.group] ?? null;
    }

    case "replace": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1) as string;
      if (typeof str !== "string") {
        throw new Error(`replace: expected string, got ${typeof str}`);
      }
      if (typeof term.to !== "string") {
        throw new Error(`replace: expected string for 'to', got ${typeof term.to}`);
      }
      const replaceValidation = validateRegex(term.from);
      if (!replaceValidation.valid) {
        throw new Error(`replace: ${replaceValidation.error}`);
      }
      // Escape $ in replacement to prevent backreference injection ($1, $&, etc.)
      const safeReplacement = term.to.replace(/\$/g, "$$$$");
      const MAX_RESULT_LENGTH = 1_000_000;
      const result = str.replace(new RegExp(term.from, "g"), safeReplacement);
      if (result.length > MAX_RESULT_LENGTH) return null;
      return result;
    }

    case "split": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1) as string;
      if (typeof str !== "string") {
        throw new Error(`split: expected string, got ${typeof str}`);
      }
      if (!Number.isInteger(term.index) || term.index < 0) return null;
      if (!term.delim || term.delim.length === 0 || term.delim.length > 1000) return null;
      const MAX_SPLIT_PARTS = 10_000;
      // Bound the split itself, not just the post-allocation check —
      // an unbounded `str.split(delim)` on a multi-MB string with a
      // common delimiter materializes the full part array (potentially
      // millions of strings) before we ever look at .length. Asking
      // for one extra part is enough to detect overflow.
      const parts = str.split(term.delim, MAX_SPLIT_PARTS + 1);
      if (parts.length > MAX_SPLIT_PARTS) return null;
      return parts[term.index] ?? null;
    }

    case "parseInt": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1);
      const strForInt = String(str);
      if (strForInt.length > 200) return null;
      const intResult = parseInt(strForInt, 10);
      return isNaN(intResult) || !Number.isSafeInteger(intResult) ? null : intResult;
    }

    case "parseFloat": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1);
      const strForFloat = String(str);
      if (strForFloat.length > 200) return null;
      const floatResult = parseFloat(strForFloat);
      return isNaN(floatResult) || !isFinite(floatResult) ? null : floatResult;
    }

    case "parseDate": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1);
      log(`[Lattice] Parsing date from: "${str}"`);

      // If examples are provided, prefer synthesis for consistency
      if (term.examples && term.examples.length > 0) {
        log(`[Lattice] Using synthesis with ${term.examples.length} examples`);
        const result = synthesisIntegrator.synthesizeOnFailure({
          operation: "parseDate",
          input: String(str),
          examples: term.examples,
        });
        if (result.success && result.fn) {
          const synthesized = result.fn(String(str));
          log(`[Lattice] Synthesized result: ${synthesized}`);
          return synthesized;
        }
      }

      // Fall back to built-in parser
      const parsed = parseDate(String(str), term.format);
      log(`[Lattice] Parsed date: ${parsed}`);
      return parsed;
    }

    case "parseCurrency": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1);
      log(`[Lattice] Parsing currency from: "${str}"`);

      // If examples are provided, prefer synthesis for consistency
      if (term.examples && term.examples.length > 0) {
        log(`[Lattice] Using synthesis with ${term.examples.length} examples`);
        const result = synthesisIntegrator.synthesizeOnFailure({
          operation: "parseCurrency",
          input: String(str),
          examples: term.examples,
        });
        if (result.success && result.fn) {
          const synthesized = result.fn(String(str));
          log(`[Lattice] Synthesized result: ${synthesized}`);
          return synthesized;
        }
      }

      // Fall back to built-in parser
      const parsed = parseCurrency(String(str));
      log(`[Lattice] Parsed currency: ${parsed}`);
      return parsed;
    }

    case "parseNumber": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1);
      log(`[Lattice] Parsing number from: "${str}"`);

      // If examples are provided, prefer synthesis for consistency
      if (term.examples && term.examples.length > 0) {
        log(`[Lattice] Using synthesis with ${term.examples.length} examples`);
        const result = synthesisIntegrator.synthesizeOnFailure({
          operation: "parseNumber",
          input: String(str),
          examples: term.examples,
        });
        if (result.success && result.fn) {
          const synthesized = result.fn(String(str));
          log(`[Lattice] Synthesized result: ${synthesized}`);
          return synthesized;
        }
      }

      // Fall back to built-in parser
      const parsed = parseNumber(String(str));
      log(`[Lattice] Parsed number: ${parsed}`);
      return parsed;
    }

    case "coerce": {
      const value = await evaluate(term.term, tools, bindings, log, depth + 1);
      log(`[Lattice] Coercing "${value}" to ${term.targetType}`);
      const coerced = coerceValue(value, term.targetType);
      log(`[Lattice] Coerced result: ${coerced}`);
      return coerced;
    }

    case "extract": {
      const str = await evaluate(term.str, tools, bindings, log, depth + 1) as string;
      if (typeof str !== "string") {
        throw new Error(`extract: expected string, got ${typeof str}`);
      }
      if (!Number.isInteger(term.group) || term.group < 0 || term.group > 99) return null;
      const extractValidation = validateRegex(term.pattern);
      if (!extractValidation.valid) {
        throw new Error(`extract: ${extractValidation.error}`);
      }
      const regex = new RegExp(term.pattern, "i");
      const result = str.match(regex);
      let extracted: string | null = null;
      if (result) {
        if (term.group >= result.length) {
          log(`[Solver] extract: group ${term.group} out of bounds (result has ${result.length} groups)`);
        } else {
          extracted = (result[term.group] as string) ?? null;
        }
      }

      // If extraction failed and examples are provided, use synthesis
      if (extracted === null && term.examples && term.examples.length > 0) {
        log(`[Lattice] Regex extraction failed, trying synthesis with ${term.examples.length} examples`);
        const synthesisResult = synthesisIntegrator.synthesizeOnFailure({
          operation: "extract",
          input: str,
          examples: term.examples,
        });
        if (synthesisResult.success && synthesisResult.fn) {
          const synthesized = synthesisResult.fn(str);
          log(`[Lattice] Synthesized result: ${synthesized}`);
          return synthesized;
        }
      }

      if (extracted !== null && term.targetType) {
        log(`[Lattice] Extracting and coercing to ${term.targetType}`);
        const coerced = coerceValue(extracted, term.targetType);
        // If coercion failed and examples are provided, use synthesis
        if (coerced === null && term.examples && term.examples.length > 0) {
          log(`[Lattice] Coercion failed, trying synthesis with ${term.examples.length} examples`);
          const synthesisResult = synthesisIntegrator.synthesizeOnFailure({
            operation: "extract",
            input: str,
            expectedType: term.targetType,
            examples: term.examples,
          });
          if (synthesisResult.success && synthesisResult.fn) {
            const synthesized = synthesisResult.fn(str);
            log(`[Lattice] Synthesized result: ${synthesized}`);
            return synthesized;
          }
        }
        return coerced;
      }
      return extracted;
    }

    case "synthesize": {
      log(`[Lattice] Synthesizing function from ${term.examples.length} examples`);
      term.examples.slice(0, 3).forEach((ex, i) => {
        log(`  [${i + 1}] "${ex.input}" -> ${JSON.stringify(ex.output)}`);
      });

      // Try evalo-based synthesis first
      try {
        const examples: Example[] = term.examples.map(e => ({
          input: e.input,
          output: e.output as string | number | boolean | null,
        }));

        const extractors = synthesizeExtractor(examples, 1);
        if (extractors.length > 0) {
          const extractor = extractors[0];
          const fn = compileToFunction(extractor);
          log(`[Lattice] Synthesized (evalo): ${prettyPrint(extractor)}`);
          return fn;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`[Lattice] Evalo synthesis failed: ${errMsg}`);
      }

      // Fallback to relational solver for automatic composition
      try {
        const relExamples = term.examples.map(e => ({
          input: e.input,
          output: e.output,
        }));
        const result = synthesizeFromExamples(relExamples);
        if (result.success) {
          log(`[Lattice] Synthesized (relational): composition with ${result.composition?.steps.length || 0} steps`);
          return result.apply;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`[Lattice] Relational synthesis failed: ${errMsg}`);
      }

      log(`[Lattice] Could not synthesize function from examples`);
      return null;
    }

    case "add": {
      const left = await evaluate(term.left, tools, bindings, log, depth + 1);
      const right = await evaluate(term.right, tools, bindings, log, depth + 1);
      if (typeof left !== "number" || typeof right !== "number") {
        throw new Error(`add: expected numbers, got ${typeof left} and ${typeof right}`);
      }
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return null;
      }
      const addResult = left + right;
      return Number.isFinite(addResult) ? addResult : null;
    }

    case "if": {
      const cond = await evaluate(term.cond, tools, bindings, log, depth + 1);
      if (cond) {
        return await evaluate(term.then, tools, bindings, log, depth + 1);
      } else {
        return await evaluate(term.else, tools, bindings, log, depth + 1);
      }
    }

    case "lambda":
      // Return a closure representation
      return { _type: "closure", param: term.param, body: term.body };

    case "app": {
      const fn = await evaluate(term.fn, tools, bindings, log, depth + 1);
      if (!fn || typeof fn !== "object" || (fn as { _type?: string })._type !== "closure") {
        throw new Error(`app: expected closure, got ${typeof fn}`);
      }
      const closure = fn as { _type: "closure"; param: string; body: LCTerm };
      const arg = await evaluate(term.arg, tools, bindings, log, depth + 1);
      // Substitute arg for param in body and evaluate
      // For simplicity, we evaluate directly here
      return await evaluateWithBinding(closure.body, closure.param, arg, tools, bindings, log, depth + 1);
    }

    case "constrained":
      return await evaluate(term.term, tools, bindings, log, depth + 1);

    case "define-fn": {
      // Synthesize a function from examples and return it for storage
      if (!term.examples || term.examples.length === 0) return null;
      log(`[Lattice] Defining function "${term.name}" from ${term.examples.length} examples`);
      const result = synthesisIntegrator.synthesizeOnFailure({
        operation: "define-fn",
        input: term.examples[0]?.input ?? "",
        examples: term.examples,
      });
      if (result.success && result.fn) {
        log(`[Lattice] Successfully synthesized function "${term.name}"`);
        // Return an object that includes both the function and metadata
        return {
          _type: "synthesized-fn",
          name: term.name,
          fn: result.fn,
          code: result.code,
        };
      }
      log(`[Lattice] Failed to synthesize function "${term.name}"`);
      return null;
    }

    case "apply-fn": {
      // Look up stored function and apply it
      const fnKey = `_fn_${term.name}`;
      const storedRaw = bindings.get(fnKey);
      if (!storedRaw || typeof storedRaw !== "object" || storedRaw === null) {
        throw new Error(`apply-fn: function "${term.name}" not found in bindings`);
      }
      const storedFn = storedRaw as Record<string, unknown>;
      if (storedFn._type !== "synthesized-fn" || typeof storedFn.fn !== "function") {
        throw new Error(`apply-fn: function "${term.name}" not found or invalid in bindings`);
      }
      const arg = await evaluate(term.arg, tools, bindings, log, depth + 1);
      log(`[Lattice] Applying function "${term.name}" to "${arg}"`);
      return (storedFn.fn as (input: string) => unknown)(String(arg));
    }

    case "predicate": {
      // Synthesize a predicate from examples
      const str = await evaluate(term.str, tools, bindings, log, depth + 1);
      if (term.examples && term.examples.length > 0) {
        log(`[Lattice] Synthesizing predicate from ${term.examples.length} examples`);
        const result = synthesisIntegrator.synthesizeOnFailure({
          operation: "predicate",
          input: String(str),
          expectedType: "boolean",
          examples: term.examples,
        });
        if (result.success && result.fn) {
          const predicateResult = result.fn(String(str));
          log(`[Lattice] Predicate result: ${predicateResult}`);
          return Boolean(predicateResult);
        }
      }
      // No examples - return truthiness of input
      return Boolean(str);
    }

    // ==========================
    // SYMBOL OPERATIONS - Tree-sitter AST queries
    // ==========================

    case "list_symbols": {
      // Get SessionDB from bindings
      const db = bindings.get("_sessionDB") as import("../persistence/session-db.js").SessionDB | undefined;
      if (!db) {
        throw new Error("list_symbols: No symbol database available. Load a code file first.");
      }

      if (term.kind) {
        log(`[Solver] Listing symbols of kind: ${term.kind}`);
        const symbols = db.getSymbolsByKind(term.kind as import("../treesitter/types.js").SymbolKind);
        log(`[Solver] Found ${symbols.length} ${term.kind} symbols`);
        return symbols;
      } else {
        log(`[Solver] Listing all symbols`);
        const symbols = db.getAllSymbols();
        log(`[Solver] Found ${symbols.length} total symbols`);
        return symbols;
      }
    }

    case "get_symbol_body": {
      // Get SessionDB from bindings
      const db = bindings.get("_sessionDB") as import("../persistence/session-db.js").SessionDB | undefined;
      if (!db) {
        throw new Error("get_symbol_body: No symbol database available. Load a code file first.");
      }

      const symbolRef = await evaluate(term.symbol, tools, bindings, log, depth + 1);
      let symbol: import("../treesitter/types.js").Symbol | null = null;

      // Handle different input types
      if (typeof symbolRef === "string") {
        // Lookup symbol by name
        log(`[Solver] Looking up symbol by name: ${symbolRef}`);
        symbol = db.findSymbolByName(symbolRef);
      } else if (typeof symbolRef === "object" && symbolRef !== null && "startLine" in symbolRef) {
        // Already a symbol object
        symbol = symbolRef as import("../treesitter/types.js").Symbol;
      }

      if (!symbol) {
        log(`[Solver] Symbol not found`);
        return null;
      }

      // Extract lines from document
      log(`[Solver] Getting body for symbol ${symbol.name} (lines ${symbol.startLine}-${symbol.endLine})`);
      const lines = tools.context.split("\n");
      const body = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
      return body;
    }

    case "find_references": {
      // Find all occurrences of the identifier in the document
      log(`[Solver] Finding references to: ${term.name}`);

      // Limit name length to prevent performance issues
      if (term.name.length > 500) {
        log(`[Solver] Name too long for find_references: ${term.name.length} chars`);
        return [];
      }

      // Use word boundary matching to find whole-word references
      const escaped = term.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (escaped.length > 1000) return [];
      const pattern = `\\b${escaped}\\b`;
      const patternValidation = validateRegex(pattern);
      if (!patternValidation.valid) {
        log(`[Solver] Invalid find_references pattern: ${patternValidation.error}`);
        return [];
      }
      const results = tools.grep(pattern);

      log(`[Solver] Found ${results.length} references to "${term.name}"`);
      return results;
    }

    // ==========================
    // GRAPH OPERATIONS - Knowledge graph queries
    // ==========================

    case "callers": {
      const graph = bindings.get("_symbolGraph") as import("../graph/symbol-graph.js").SymbolGraph | undefined;
      if (!graph) {
        throw new Error("callers: No symbol graph available. Load a code file first.");
      }
      log(`[Solver] Finding callers of "${term.name}"`);
      const callerSymbols = graph.callers(term.name);
      log(`[Solver] Found ${callerSymbols.length} callers`);
      return callerSymbols;
    }

    case "callees": {
      const graph = bindings.get("_symbolGraph") as import("../graph/symbol-graph.js").SymbolGraph | undefined;
      if (!graph) {
        throw new Error("callees: No symbol graph available. Load a code file first.");
      }
      log(`[Solver] Finding callees of "${term.name}"`);
      const calleeSymbols = graph.callees(term.name);
      log(`[Solver] Found ${calleeSymbols.length} callees`);
      return calleeSymbols;
    }

    case "ancestors": {
      const graph = bindings.get("_symbolGraph") as import("../graph/symbol-graph.js").SymbolGraph | undefined;
      if (!graph) {
        throw new Error("ancestors: No symbol graph available. Load a code file first.");
      }
      log(`[Solver] Finding ancestors of "${term.name}"`);
      const ancestorSymbols = graph.ancestors(term.name);
      log(`[Solver] Found ${ancestorSymbols.length} ancestors`);
      return ancestorSymbols;
    }

    case "descendants": {
      const graph = bindings.get("_symbolGraph") as import("../graph/symbol-graph.js").SymbolGraph | undefined;
      if (!graph) {
        throw new Error("descendants: No symbol graph available. Load a code file first.");
      }
      log(`[Solver] Finding descendants of "${term.name}"`);
      const descendantSymbols = graph.descendants(term.name);
      log(`[Solver] Found ${descendantSymbols.length} descendants`);
      return descendantSymbols;
    }

    case "implementations": {
      const graph = bindings.get("_symbolGraph") as import("../graph/symbol-graph.js").SymbolGraph | undefined;
      if (!graph) {
        throw new Error("implementations: No symbol graph available. Load a code file first.");
      }
      log(`[Solver] Finding implementations of "${term.name}"`);
      const implSymbols = graph.implementations(term.name);
      log(`[Solver] Found ${implSymbols.length} implementations`);
      return implSymbols;
    }

    case "dependents": {
      const graph = bindings.get("_symbolGraph") as import("../graph/symbol-graph.js").SymbolGraph | undefined;
      if (!graph) {
        throw new Error("dependents: No symbol graph available. Load a code file first.");
      }
      log(`[Solver] Finding dependents of "${term.name}" (depth: ${term.depth ?? "unlimited"})`);
      const depSymbols = graph.dependents(term.name, term.depth);
      log(`[Solver] Found ${depSymbols.length} dependents`);
      return depSymbols;
    }

    case "symbol_graph": {
      const graph = bindings.get("_symbolGraph") as import("../graph/symbol-graph.js").SymbolGraph | undefined;
      if (!graph) {
        throw new Error("symbol_graph: No symbol graph available. Load a code file first.");
      }
      const depth = term.depth ?? 1;
      log(`[Solver] Getting symbol graph around "${term.name}" (depth: ${depth})`);
      const neighborhood = graph.neighborhood(term.name, depth);
      log(`[Solver] Graph: ${neighborhood.nodes.length} nodes, ${neighborhood.edges.length} edges`);
      return neighborhood;
    }

    case "communities":
    case "community_of":
    case "god_nodes":
    case "surprising_connections":
    case "bridge_nodes":
    case "suggest_questions":
    case "graph_report": {
      const graph = bindings.get("_symbolGraph") as import("../graph/symbol-graph.js").SymbolGraph | undefined;
      const detector = bindings.get("_graphDetector") as import("../graph/community-detector.js").GraphCommunityDetector | undefined;
      if (!graph || !detector) {
        throw new Error(`${term.tag}: No symbol graph available. Load a code file first.`);
      }

      if (term.tag === "communities") {
        log("[Solver] Listing communities");
        return detector.communityList();
      }

      if (term.tag === "community_of") {
        log(`[Solver] Finding community of "${term.name}"`);
        if (!graph.hasSymbol(term.name)) {
          throw new Error(`community_of: Node "${term.name}" not found in graph`);
        }
        const cid = detector.nodeCommunity(term.name);
        if (cid === undefined) {
          throw new Error(`community_of: Node "${term.name}" has no community assignment (graph may have been modified since detection)`);
        }
        const community = detector.communityList().find((c) => c.id === cid);
        if (!community) {
          throw new Error(`community_of: Node "${term.name}" has community ID ${cid} but no matching community in the cached list. Call invalidate() on the detector and retry.`);
        }
        return community;
      }

      const { GraphAnalyzer } = await import("../graph/graph-analyzer.js");
      const analyzer = new GraphAnalyzer(graph, detector);

      switch (term.tag) {
        case "god_nodes": {
          const topN = term.topN ?? 10;
          log(`[Solver] Finding top ${topN} god nodes`);
          return analyzer.godNodes(topN);
        }
        case "surprising_connections": {
          const topN = term.topN ?? 10;
          log(`[Solver] Finding top ${topN} surprising connections`);
          return analyzer.surprisingConnections(topN);
        }
        case "bridge_nodes": {
          const topN = term.topN ?? 10;
          log(`[Solver] Finding top ${topN} bridge nodes`);
          return analyzer.bridgeNodes(topN);
        }
        case "suggest_questions":
          log("[Solver] Generating suggested questions");
          return analyzer.suggestQuestions();
        case "graph_report":
          log("[Solver] Generating full graph report");
          return analyzer.fullReport();
      }
    }

    case "llm_query": {
      // Symbolic-recursion primitive. Works in any position the LC
      // grammar allows — top-level, and nested inside map/filter/
      // reduce lambdas — because evaluate() is async. The common
      // OOLONG pattern looks like:
      //   (map RESULTS (lambda x (llm_query "classify: {item}" (item x))))
      if (!tools.llmQuery) {
        throw new Error(
          "llm_query is not available in this execution context. " +
          "The RLM loop provides it via the caller's llmClient, and " +
          "lattice-mcp provides it when the MCP client advertises " +
          "`sampling` capability. Standalone NucleusEngine / HandleSession " +
          "instances must pass an llmQuery option to enable it."
        );
      }
      let interpolated = term.prompt;
      const MAX_INTERP_LEN = 500_000;
      for (const b of term.bindings) {
        const val = await evaluate(b.value, tools, bindings, log, depth + 1);
        let serialized: string;
        try {
          serialized =
            typeof val === "string" ? val : JSON.stringify(val, null, 2);
        } catch {
          serialized = String(val);
        }
        if (serialized.length > MAX_INTERP_LEN) {
          serialized =
            serialized.slice(0, MAX_INTERP_LEN) +
            `\n…[truncated ${serialized.length - MAX_INTERP_LEN} chars]`;
        }
        const escapedName = b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        interpolated = interpolated.replace(
          new RegExp(`\\{${escapedName}\\}`, "g"),
          serialized.replace(/\$/g, "$$$$")
        );
      }
      // Optional (one_of …) constraint — augment the prompt with the
      // allowed set so the model answers in the expected format.
      const finalPrompt = term.oneOf
        ? appendOneOfDirective(interpolated, term.oneOf)
        : interpolated;

      log(`[Solver] llm_query prompt length: ${finalPrompt.length} chars`);
      log(
        `[Solver] llm_query bindings: ${term.bindings.map((b) => b.name).join(", ") || "(none)"}`
      );
      if (term.oneOf) {
        log(`[Solver] llm_query one_of: ${term.oneOf.join(" | ")}`);
      }
      const response = await tools.llmQuery(finalPrompt);
      log(`[Solver] llm_query response length: ${response.length} chars`);

      if (term.oneOf) {
        const canonical = canonicalizeOneOf(response, term.oneOf);
        if (canonical === null) {
          throw new Error(
            `llm_query (one_of): response ${JSON.stringify(response)} ` +
            `is not in the allowed set [${term.oneOf.join(", ")}]`
          );
        }
        return canonical;
      }
      return response;
    }

    case "rlm_query": {
      // Phase 1 recursive primitive — spawn a child Nucleus FSM with
      // an explicit query and (optional) clean line-oriented document.
      // The actual child-spawning logic lives behind the `rlmQuery`
      // callback the parent's RLM loop wires up; this case is just
      // the materialization-and-dispatch layer.
      if (!tools.rlmQuery) {
        throw new Error(
          "rlm_query is not available in this execution context. " +
          "The RLM loop provides it once the parent threads an " +
          "rlmQuery callback through SolverTools. Standalone " +
          "NucleusEngine / HandleSession instances must pass an " +
          "rlmQuery option to enable it."
        );
      }

      // Resolve (context EXPR) when present. The materialized form is
      // line-oriented: arrays join their stringified items by \n;
      // strings pass through unchanged; null/undefined become null.
      // This is the structural difference from llm_query — the child
      // gets a clean document its grep/lines/chunk primitives can
      // operate on, not a JSON-stringified blob.
      let contextDoc: string | null = null;
      if (term.context) {
        const resolved = await evaluate(term.context, tools, bindings, log, depth + 1);
        contextDoc = materializeContext(resolved);
      }

      log(
        `[Solver] rlm_query prompt length: ${term.prompt.length} chars, ` +
          `context: ${contextDoc === null ? "null" : `${contextDoc.length} chars`}`
      );
      const response = await tools.rlmQuery(term.prompt, contextDoc);
      log(`[Solver] rlm_query response length: ${response.length} chars`);
      return response;
    }

    case "rlm_batch": {
      // Phase 2 — concurrent variant of `(map COLL (lambda x (rlm_query …)))`.
      // Builds N (prompt, contextDoc) pairs from the inner rlm_query
      // template and dispatches them through tools.rlmBatch in a
      // single call. The implementation fans them out concurrently
      // (typically Promise.all over child sessions); the solver
      // itself is just the materialization-and-dispatch layer.
      if (!tools.rlmBatch) {
        throw new Error(
          "rlm_batch is not available in this execution context. " +
          "The RLM loop provides it once the parent threads an " +
          "rlmBatch callback through SolverTools. Standalone " +
          "NucleusEngine / HandleSession instances must pass an " +
          "rlmBatch option to enable it."
        );
      }

      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`rlm_batch: expected array, got ${typeof collection}`);
      }

      // Empty collection short-circuit — match llm_batch's behavior
      // so callers don't pay a dispatch round-trip for zero work.
      if (collection.length === 0) {
        log(`[Solver] rlm_batch: empty collection, skipping dispatch`);
        return [];
      }

      const items: Array<{ prompt: string; contextDoc: string | null }> = [];
      for (const item of collection) {
        // Bind the lambda param to the RAW item (no toItemString
        // coercion). rlm_batch funnels each item through
        // materializeContext, which knows how to render arrays as
        // line-oriented documents and objects with a `.line` field
        // as their line text. Stringifying the item up-front would
        // collapse all that structure into a flat string and defeat
        // the handle-as-document property we built for rlm_query.
        const scopedBindings = new Map(bindings);
        scopedBindings.set(term.param, item);

        let contextDoc: string | null = null;
        if (term.context) {
          const resolved = await evaluate(
            term.context,
            tools,
            scopedBindings,
            log,
            depth + 1
          );
          contextDoc = materializeContext(resolved);
        }
        items.push({ prompt: term.prompt, contextDoc });
      }

      log(
        `[Solver] rlm_batch dispatching ${items.length} child sessions in a single call`
      );
      const responses = await tools.rlmBatch(items);
      if (!Array.isArray(responses)) {
        throw new Error(
          `rlm_batch: tools.rlmBatch must return an array, got ${typeof responses}`
        );
      }
      if (responses.length !== items.length) {
        throw new Error(
          `rlm_batch: expected ${items.length} responses, got ${responses.length}`
        );
      }
      log(`[Solver] rlm_batch received ${responses.length} responses`);
      return responses;
    }

    case "llm_batch": {
      // Batched sibling of `llm_query`. Drop-in replacement for
      //   (map COLL (lambda x (llm_query "…" …bindings)))
      // that collects every interpolated prompt into a single array and
      // dispatches them through `tools.llmBatch` in ONE call — one
      // suspension for N items instead of N serial suspensions.
      if (!tools.llmBatch) {
        throw new Error(
          "llm_batch is not available in this execution context. " +
          "The RLM loop and the lattice-mcp bridge thread it through " +
          "alongside llmQuery; standalone NucleusEngine / HandleSession " +
          "consumers must pass an llmBatch option to enable it."
        );
      }

      const collection = await evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`llm_batch: expected array, got ${typeof collection}`);
      }

      // Empty collection: no prompts → skip the batch call entirely so
      // callers don't pay a round-trip for zero work.
      if (collection.length === 0) {
        log(`[Solver] llm_batch: empty collection, skipping dispatch`);
        return [];
      }

      const MAX_INTERP_LEN = 500_000;

      // Build the N interpolated prompts. Each iteration binds the
      // lambda param to the current item (coerced to a string in the
      // same way map does) and evaluates every binding's value term
      // against that bound scope before string-substituting placeholders.
      const prompts: string[] = [];
      for (const item of collection) {
        const itemValue = toItemString(item);
        const scopedBindings = new Map(bindings);
        scopedBindings.set(term.param, itemValue);

        let interpolated = term.prompt;
        for (const b of term.bindings) {
          const val = await evaluate(b.value, tools, scopedBindings, log, depth + 1);
          let serialized: string;
          try {
            serialized =
              typeof val === "string" ? val : JSON.stringify(val, null, 2);
          } catch {
            serialized = String(val);
          }
          if (serialized.length > MAX_INTERP_LEN) {
            serialized =
              serialized.slice(0, MAX_INTERP_LEN) +
              `\n…[truncated ${serialized.length - MAX_INTERP_LEN} chars]`;
          }
          const escapedName = b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          interpolated = interpolated.replace(
            new RegExp(`\\{${escapedName}\\}`, "g"),
            serialized.replace(/\$/g, "$$$$")
          );
        }
        // Apply the per-item (one_of …) directive the same way
        // llm_query does. The constraint is hoisted out of the inner
        // llm_query at parse time, so every prompt in the batch gets
        // the same allowed set.
        const finalPrompt = term.oneOf
          ? appendOneOfDirective(interpolated, term.oneOf)
          : interpolated;
        prompts.push(finalPrompt);
      }

      log(
        `[Solver] llm_batch dispatching ${prompts.length} prompts in a single call` +
        (term.oneOf ? ` with one_of ${term.oneOf.join(" | ")}` : "") +
        (term.calibrate ? " [calibrate]" : "")
      );
      // Only pass options when we have something to say. Keeping the
      // default shape identical to the pre-calibrate signature means
      // existing llmBatch implementations that only accept `prompts`
      // remain backwards compatible at the call site.
      const batchOptions = term.calibrate ? { calibrate: true } : undefined;
      const responses = batchOptions
        ? await tools.llmBatch(prompts, batchOptions)
        : await tools.llmBatch(prompts);
      if (!Array.isArray(responses)) {
        throw new Error(
          `llm_batch: tools.llmBatch must return an array, got ${typeof responses}`
        );
      }
      if (responses.length !== prompts.length) {
        throw new Error(
          `llm_batch: expected ${prompts.length} responses, got ${responses.length}`
        );
      }
      log(`[Solver] llm_batch received ${responses.length} responses`);

      // Per-item enum validation. Any out-of-set response fails the
      // whole batch with a specific index so the caller can debug.
      if (term.oneOf) {
        const canonicalized: string[] = [];
        for (let i = 0; i < responses.length; i++) {
          const canonical = canonicalizeOneOf(responses[i], term.oneOf);
          if (canonical === null) {
            throw new Error(
              `llm_batch (one_of): item ${i + 1} (index ${i}) response ` +
              `${JSON.stringify(responses[i])} is not in the allowed set ` +
              `[${term.oneOf.join(", ")}]`
            );
          }
          canonicalized.push(canonical);
        }
        return canonicalized;
      }
      return responses;
    }

    default:
      throw new Error(`Unknown term tag: ${(term as LCTerm).tag}`);
  }
}

/**
 * Evaluate a predicate term with a bound variable
 * Returns true if the predicate matches
 */
async function evaluatePredicate(
  body: LCTerm,
  param: string,
  value: string,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): Promise<boolean> {
  // Simple pattern: (match var "pattern" 0)
  if (body.tag === "match") {
    if (!Number.isInteger(body.group) || body.group < 0) return false;
    // Use evaluateWithBinding (not evaluate) for the non-var fast path
    // so the predicate's lambda parameter remains in scope. Without
    // this, a nested term like (llm_query "…" (item x)) would look up
    // `x` against the outer bindings and fail. Discovered when the
    // filter-with-llm_query test from llm-query-nested.test.ts broke
    // after the async refactor removed the top-level-only restriction.
    const str = body.str.tag === "var" && body.str.name === param
      ? value
      : String(await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1));
    const patternValidation = validateRegex(body.pattern);
    if (!patternValidation.valid) return false;
    // Case-insensitive for consistency with grep and extract
    const regex = new RegExp(body.pattern, "i");
    const result = str.match(regex);
    return result !== null && body.group < result.length && result[body.group] !== undefined;
  }

  // Variable reference - check if value is truthy
  if (body.tag === "var" && body.name === param) {
    return Boolean(value);
  }

  // Literal boolean
  if (body.tag === "lit" && typeof body.value === "boolean") {
    return body.value;
  }

  // For complex predicates, evaluate and check truthiness
  const result = await evaluateWithBinding(body, param, value, tools, bindings, log, depth + 1);
  return Boolean(result);
}

/**
 * Evaluate a transform term with a bound variable
 */
async function evaluateTransform(
  body: LCTerm,
  param: string,
  value: string,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): Promise<unknown> {
  return await evaluateWithBinding(body, param, value, tools, bindings, log, depth + 1);
}

/**
 * Evaluate reduce function with two bindings (acc, item)
 */
async function evaluateReduceFn(
  fn: LCTerm & { tag: "lambda" },
  acc: unknown,
  item: unknown,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): Promise<unknown> {
  // For now, assume a simple two-parameter lambda pattern
  // The lambda body references the accumulator and current item
  const body = fn.body;
  const param = fn.param; // First param is typically "acc"

  // If body is also a lambda, handle two-param case
  if (body.tag === "lambda") {
    const itemParam = body.param;
    const innerBody = body.body;
    // Create a temporary bindings with both params
    const newBindings = new Map(bindings);
    newBindings.set(param, acc);
    newBindings.set(itemParam, item);
    return await evaluate(innerBody, tools, newBindings, log, depth + 1);
  }

  // Single param - bind it to the item, use existing bindings for acc
  const newBindings = new Map(bindings);
  newBindings.set(param, item);
  // Only set "acc" if it won't collide with the lambda parameter name
  if (param !== "acc") {
    newBindings.set("acc", acc);
  }
  return await evaluate(body, tools, newBindings, log, depth + 1);
}

/**
 * Evaluate a term with a variable binding
 */
async function evaluateWithBinding(
  body: LCTerm,
  param: string,
  value: unknown,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): Promise<unknown> {
  if (depth > MAX_EVAL_DEPTH) {
    throw new Error("evaluateWithBinding: maximum recursion depth exceeded");
  }
  // Substitute variables and evaluate
  switch (body.tag) {
    case "var":
      if (body.name === param) return value;
      return await evaluate(body, tools, bindings, log, depth + 1);

    case "lit":
      return body.value;

    case "match": {
      const str = body.str.tag === "var" && body.str.name === param
        ? String(value)
        : String(await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1));
      const matchVal = validateRegex(body.pattern);
      if (!matchVal.valid) {
        throw new Error(`match: ${matchVal.error}`);
      }
      if (!Number.isInteger(body.group) || body.group < 0) return null;
      // Case-insensitive for consistency with grep and extract
      const regex = new RegExp(body.pattern, "i");
      const result = str.match(regex);
      return result ? (result[body.group] ?? null) : null;
    }

    case "replace": {
      const str = body.str.tag === "var" && body.str.name === param
        ? String(value)
        : String(await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1));
      if (typeof body.to !== "string") {
        throw new Error(`replace: expected string for 'to', got ${typeof body.to}`);
      }
      const replaceVal = validateRegex(body.from);
      if (!replaceVal.valid) {
        throw new Error(`replace: ${replaceVal.error}`);
      }
      const safeReplacement = body.to.replace(/\$/g, "$$$$");
      return str.replace(new RegExp(body.from, "g"), safeReplacement);
    }

    case "split": {
      if (!Number.isInteger(body.index) || body.index < 0) return null;
      if (!body.delim || body.delim.length === 0 || body.delim.length > 1000) return null;
      const str = body.str.tag === "var" && body.str.name === param
        ? String(value)
        : String(await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1));
      const MAX_EVAL_SPLIT_PARTS = 10_000;
      const parts = str.split(body.delim);
      if (parts.length > MAX_EVAL_SPLIT_PARTS) return null;
      return parts[body.index] ?? null;
    }

    case "parseInt": {
      const str = await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
      const strForInt = String(str);
      if (strForInt.length > 200) return null;
      const intResult = parseInt(strForInt, 10);
      return isNaN(intResult) || !Number.isSafeInteger(intResult) ? null : intResult;
    }

    case "parseFloat": {
      const str = await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
      const strForFloat = String(str);
      if (strForFloat.length > 200) return null;
      const floatResult = parseFloat(strForFloat);
      return isNaN(floatResult) || !isFinite(floatResult) ? null : floatResult;
    }

    case "add": {
      const left = await evaluateWithBinding(body.left, param, value, tools, bindings, log, depth + 1);
      const right = await evaluateWithBinding(body.right, param, value, tools, bindings, log, depth + 1);
      if (typeof left !== "number" || typeof right !== "number") {
        throw new Error(`add: expected numbers, got ${typeof left} and ${typeof right}`);
      }
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return null;
      }
      const addResult = left + right;
      return Number.isFinite(addResult) ? addResult : null;
    }

    case "parseDate": {
      const str = await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
      const strValue = String(str);

      // If examples are provided, prefer synthesis for consistency
      if (body.examples && body.examples.length > 0) {
        const result = synthesisIntegrator.synthesizeOnFailure({
          operation: "parseDate",
          input: strValue,
          examples: body.examples,
        });
        if (result.success && result.fn) {
          return result.fn(strValue);
        }
      }

      // Fall back to built-in parser
      return parseDate(strValue, body.format);
    }

    case "parseCurrency": {
      const str = await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
      const strValue = String(str);

      // If examples are provided, prefer synthesis for consistency
      if (body.examples && body.examples.length > 0) {
        const result = synthesisIntegrator.synthesizeOnFailure({
          operation: "parseCurrency",
          input: strValue,
          examples: body.examples,
        });
        if (result.success && result.fn) {
          return result.fn(strValue);
        }
      }

      // Fall back to built-in parser
      return parseCurrency(strValue);
    }

    case "parseNumber": {
      const str = await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
      const strValue = String(str);

      // If examples are provided, prefer synthesis for consistency
      if (body.examples && body.examples.length > 0) {
        const result = synthesisIntegrator.synthesizeOnFailure({
          operation: "parseNumber",
          input: strValue,
          examples: body.examples,
        });
        if (result.success && result.fn) {
          return result.fn(strValue);
        }
      }

      // Fall back to built-in parser
      return parseNumber(strValue);
    }

    case "coerce": {
      const termValue = await evaluateWithBinding(body.term, param, value, tools, bindings, log, depth + 1);
      return coerceValue(termValue, body.targetType);
    }

    case "extract": {
      if (!Number.isInteger(body.group) || body.group < 0) return null;
      const str = await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1) as string;
      if (typeof str !== "string") return null;
      const extractPatternValidation = validateRegex(body.pattern);
      if (!extractPatternValidation.valid) return null;
      const regex = new RegExp(body.pattern, "i");
      const result = str.match(regex);
      let extracted = result ? (result[body.group] ?? null) : null;

      // If extraction failed and examples are provided, use synthesis
      if (extracted === null && body.examples && body.examples.length > 0) {
        const synthesisResult = synthesisIntegrator.synthesizeOnFailure({
          operation: "extract",
          input: str,
          examples: body.examples,
        });
        if (synthesisResult.success && synthesisResult.fn) {
          return synthesisResult.fn(str);
        }
      }

      if (extracted !== null && body.targetType) {
        const coerced = coerceValue(extracted, body.targetType);
        // If coercion failed and examples are provided, use synthesis
        if (coerced === null && body.examples && body.examples.length > 0) {
          const synthesisResult = synthesisIntegrator.synthesizeOnFailure({
            operation: "extract",
            input: str,
            expectedType: body.targetType,
            examples: body.examples,
          });
          if (synthesisResult.success && synthesisResult.fn) {
            return synthesisResult.fn(str);
          }
        }
        return coerced;
      }
      return extracted;
    }

    case "predicate": {
      const str = await evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
      // Handle grep result objects - extract the line property
      const strValue =
        typeof str === "object" && str !== null && "line" in str
          ? String((str as { line: string }).line)
          : String(str);
      if (body.examples && body.examples.length > 0) {
        const result = synthesisIntegrator.synthesizeOnFailure({
          operation: "predicate",
          input: strValue,
          expectedType: "boolean",
          examples: body.examples,
        });
        if (result.success && result.fn) {
          return Boolean(result.fn(strValue));
        }
      }
      return Boolean(str);
    }

    default:
      // For unhandled cases, create a temporary binding and evaluate
      const newBindings = new Map(bindings);
      newBindings.set(param, value);
      return await evaluate(body, tools, newBindings, log, depth + 1);
  }
}

/**
 * Use miniKanren to find a regex pattern that matches true examples
 * but not false examples
 */
function findDistinguishingPattern(
  trueExamples: string[],
  falseExamples: string[]
): string | null {
  // Common patterns to try
  const candidatePatterns = [
    // Extract common substrings from true examples
    ...extractCommonSubstrings(trueExamples),
    // Standard patterns
    "failed",
    "error",
    "ERROR",
    "FAILED",
    "success",
    "completed",
    "\\bfail",
    "\\berror",
  ];

  // Find pattern that matches all true and no false
  for (const pattern of candidatePatterns) {
    try {
      const patternValidation = validateRegex(pattern);
      if (!patternValidation.valid) continue;
      const regex = new RegExp(pattern, "i");
      const matchesAllTrue = trueExamples.every(ex => regex.test(ex));
      const matchesNoFalse = falseExamples.every(ex => !regex.test(ex));

      if (matchesAllTrue && matchesNoFalse) {
        return pattern;
      }
    } catch {
      // Invalid regex, skip
    }
  }

  // Fallback: use the most common word in true examples not in false
  const trueWords = new Set(trueExamples.flatMap(ex => ex.toLowerCase().split(/\W+/).filter(w => w.length > 0)));
  const falseWords = new Set(falseExamples.flatMap(ex => ex.toLowerCase().split(/\W+/).filter(w => w.length > 0)));

  for (const word of trueWords) {
    if (word.length > 3 && !falseWords.has(word)) {
      // Escape regex metacharacters so the word is safe for new RegExp()
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Route through validateRegex for consistency with every other
      // regex-compilation site in this file — catches length caps and
      // any future validator rules without requiring a separate audit.
      if (!validateRegex(escaped).valid) continue;
      return escaped;
    }
  }

  return null;
}

/**
 * Extract common substrings from examples
 */
function extractCommonSubstrings(examples: string[]): string[] {
  if (examples.length === 0) return [];

  const substrings: string[] = [];

  // Find words common to all examples
  const wordSets = examples.map(ex =>
    new Set(ex.toLowerCase().split(/\W+/).filter(w => w.length > 2))
  );

  if (wordSets.length > 0) {
    const common = [...wordSets[0]].filter(word =>
      wordSets.every(set => set.has(word))
    );
    substrings.push(...common);
  }

  return substrings;
}

// ============================================================================
// VALUE PARSING AND COERCION HELPERS
// ============================================================================

/**
 * Returns the number of days in a given month (1-indexed), accounting for leap years.
 */
function daysInMonth(month: number, year: number): number {
  const days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) {
    return 29;
  }
  return days[month] ?? 0;
}

/**
 * Parse a date string into ISO format (YYYY-MM-DD)
 * Handles various formats: ISO, US (MM/DD/YYYY), EU (DD/MM/YYYY), natural language
 */
function parseDate(str: string, formatHint?: string): string | null {
  if (!str || typeof str !== "string") return null;
  if (str.length > MAX_PARSE_INPUT_LENGTH) return null;

  const cleaned = str.trim();

  // ISO format: 2024-01-15, 2024/01/15
  const isoMatch = cleaned.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(m, parseInt(year, 10))) {
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }

  // US format: MM/DD/YYYY, MM-DD-YYYY
  if (formatHint === "US" || (!formatHint && cleaned.includes("/"))) {
    const usMatch = cleaned.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (usMatch) {
      const [, month, day, year] = usMatch;
      const m = parseInt(month, 10);
      const d = parseInt(day, 10);
      // Validate US format (month 1-12, day within month's max)
      if (m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(m, parseInt(year, 10))) {
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      }
    }
  }

  // EU format: DD/MM/YYYY, DD-MM-YYYY
  if (formatHint === "EU") {
    const euMatch = cleaned.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (euMatch) {
      const [, day, month, year] = euMatch;
      const m = parseInt(month, 10);
      const d = parseInt(day, 10);
      if (m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(m, parseInt(year, 10))) {
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      }
    }
  }

  // Natural language: Jan 15, 2024 | January 15, 2024 | 15 Jan 2024
  const months: Record<string, string> = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", sept: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12",
  };

  // Month Day, Year
  const mdy = cleaned.match(/^([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdy) {
    const monthNum = months[mdy[1].toLowerCase()];
    if (monthNum) {
      const m = parseInt(monthNum, 10);
      const d = parseInt(mdy[2], 10);
      if (d >= 1 && d <= daysInMonth(m, parseInt(mdy[3], 10))) {
        return `${mdy[3]}-${monthNum}-${mdy[2].padStart(2, "0")}`;
      }
      return null; // Recognized month but invalid day — don't fall through to JS Date
    }
  }

  // Day Month Year
  const dmy = cleaned.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})/);
  if (dmy) {
    const monthNum = months[dmy[2].toLowerCase()];
    if (monthNum) {
      const m = parseInt(monthNum, 10);
      const d = parseInt(dmy[1], 10);
      if (d >= 1 && d <= daysInMonth(m, parseInt(dmy[3], 10))) {
        return `${dmy[3]}-${monthNum}-${dmy[1].padStart(2, "0")}`;
      }
      return null; // Recognized month but invalid day — don't fall through to JS Date
    }
  }

  // Try JavaScript Date parsing as fallback, but only for non-numeric formats
  // to avoid JS Date silently normalizing invalid dates (e.g., Feb 31 → Mar 3)
  const looksNumeric = /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(cleaned)
    || /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(cleaned);
  if (!looksNumeric) {
    const jsDate = new Date(cleaned);
    if (!isNaN(jsDate.getTime())) {
      const year = jsDate.getUTCFullYear();
      const month = String(jsDate.getUTCMonth() + 1).padStart(2, "0");
      const day = String(jsDate.getUTCDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

/**
 * Parse a currency string into a number
 * Handles: $1,234.56, €1.234,56, £1,234, ¥1234, etc.
 */
const MAX_PARSE_INPUT_LENGTH = 100;

function parseCurrency(str: string): number | null {
  if (!str || typeof str !== "string") return null;
  if (str.length > MAX_PARSE_INPUT_LENGTH) return null;

  let cleaned = str.trim();

  // Handle negative: (1,234) or -1,234 or -$1,234 or $-1,234
  const isNegative = (cleaned.startsWith("(") && cleaned.endsWith(")")) ||
                     cleaned.startsWith("-") ||
                     cleaned.endsWith("-") ||
                     /^-[\$€£¥₹₽₿]/.test(cleaned) ||
                     /^[\$€£¥₹₽₿]-/.test(cleaned);

  // Remove currency symbols, parentheses, minus signs, and whitespace
  cleaned = cleaned.replace(/[\$€£¥₹₽₿\s\(\)\-]/g, "");

  if (!cleaned) return null;

  // Detect format by analyzing separator patterns
  // US/UK: 1,234,567.89 (comma thousands, dot decimal)
  // EU: 1.234.567,89 (dot thousands, comma decimal)

  const commaCount = (cleaned.match(/,/g) || []).length;
  const dotCount = (cleaned.match(/\./g) || []).length;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let normalized: string;

  // If there's no decimal separator, just remove thousand separators
  if (dotCount === 0 && commaCount === 0) {
    normalized = cleaned;
  }
  // If only commas exist, they're thousand separators (US) unless it's like "1,23" (EU decimal)
  else if (dotCount === 0) {
    // Check if last comma has exactly 2 digits after it (EU decimal)
    const afterLastComma = cleaned.slice(lastComma + 1);
    if (afterLastComma.length <= 2 && commaCount === 1) {
      // Likely EU decimal: "1234,56"
      normalized = cleaned.replace(",", ".");
    } else {
      // US thousands: "1,234,567"
      normalized = cleaned.replace(/,/g, "");
    }
  }
  // If only dots exist, they're thousand separators (EU) unless it's a decimal
  else if (commaCount === 0) {
    // If there's only one dot, it's likely a decimal separator
    if (dotCount === 1) {
      // US decimal: "1234.56" or "3.14159"
      normalized = cleaned;
    } else {
      // EU thousands: "1.234.567"
      normalized = cleaned.replace(/\./g, "");
    }
  }
  // Both exist - determine which is decimal
  else if (lastComma > lastDot) {
    // EU format: comma is decimal separator (1.234,56)
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    // US format: dot is decimal separator (1,234.56)
    normalized = cleaned.replace(/,/g, "");
  }

  const value = parseFloat(normalized);
  if (isNaN(value) || !isFinite(value)) return null;

  return isNegative ? -value : value;
}

/**
 * Parse a number string with various formats
 * Handles: 1,234.56, 1.234,56, 50%, 1e6, etc.
 */
function parseNumber(str: string): number | null {
  if (!str || typeof str !== "string") return null;
  if (str.length > MAX_PARSE_INPUT_LENGTH) return null;

  const cleaned = str.trim();

  // Handle percentage — strip iteratively to avoid recursive stack overflow
  if (cleaned.endsWith("%")) {
    let pct = cleaned;
    let percentCount = 0;
    const MAX_PERCENT_DEPTH = 10;
    while (pct.endsWith("%") && percentCount < MAX_PERCENT_DEPTH) {
      pct = pct.slice(0, -1);
      percentCount++;
    }
    if (pct.endsWith("%")) return null; // too many nested %
    const num = parseNumber(pct);
    if (num === null) return null;
    let result = num;
    for (let i = 0; i < percentCount; i++) {
      result = result / 100;
    }
    return Number.isFinite(result) ? result : null;
  }

  // Handle scientific notation
  if (/^-?\d+\.?\d*e[+-]?\d+$/i.test(cleaned)) {
    const sci = parseFloat(cleaned);
    return isFinite(sci) ? sci : null;
  }

  // Use currency parser logic for formatted numbers
  return parseCurrency(cleaned);
}

/**
 * Coerce a value to a specified type
 */
function coerceValue(value: unknown, targetType: CoercionType): unknown {
  if (value === null || value === undefined) return null;

  const str = String(value);

  switch (targetType) {
    case "date":
      return parseDate(str);

    case "currency":
      return parseCurrency(str);

    case "number":
      return parseNumber(str);

    case "percent": {
      // If already has %, parse as percentage
      if (str.includes("%")) {
        return parseNumber(str);
      }
      // Otherwise treat as decimal that needs to be percentage
      const num = parseNumber(str);
      return num !== null ? num / 100 : null;
    }

    case "boolean": {
      const lower = str.toLowerCase().trim();
      if (["true", "yes", "1", "on"].includes(lower)) return true;
      if (["false", "no", "0", "off", ""].includes(lower)) return false;
      return null;
    }

    case "string":
      return str;

    default:
      return value;
  }
}
