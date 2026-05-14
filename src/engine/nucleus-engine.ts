/**
 * NucleusEngine - Standalone logic engine for document analysis
 *
 * This module provides a standalone interface to the Nucleus command execution
 * engine without requiring an LLM in the loop. It can be used:
 * - As a library API for programmatic document analysis
 * - As the backend for a REPL
 * - As an MCP tool for direct command execution
 */

import { readFile } from "node:fs/promises";
import { parse as parseLC } from "../logic/lc-parser.js";
import { lintAndRepair } from "../logic/lc-linter.js";
import { inferType, typeToString } from "../logic/type-inference.js";
import { solve as solveTerm, validateRegex, type SolverTools, type Bindings } from "../logic/lc-solver.js";
import { buildBM25Index, searchBM25, type BM25Index } from "../logic/bm25.js";
import { buildSemanticIndex, searchSemantic, type SemanticIndex } from "../logic/semantic.js";

/**
 * Result of executing a Nucleus command
 */
export interface ExecutionResult {
  success: boolean;
  value: unknown;
  logs: string[];
  error?: string;
  type?: string;
}

/**
 * Options for creating a NucleusEngine
 */
export interface NucleusEngineOptions {
  /** Enable verbose logging */
  verbose?: boolean;
  /**
   * Optional sub-LLM bridge for the `(llm_query ...)` primitive.
   *
   * When present, the engine threads this callback through to `createSolverTools`
   * every time a document is loaded, so the solver can dispatch `(llm_query ...)`
   * terms through it. The main consumer is the MCP sampling bridge in
   * `lattice-mcp-server.ts`, which wraps `server.createMessage(...)` so that
   * sub-LLM calls are routed back to the MCP client's model.
   *
   * When omitted, `(llm_query ...)` throws a clear "not available" error.
   */
  llmQuery?: (prompt: string) => Promise<string>;
  /**
   * Optional batched sub-LLM bridge for the `(llm_batch ...)` primitive.
   *
   * Same contract as `llmQuery` but receives all N interpolated prompts
   * from a `(llm_batch COLL (lambda x (llm_query …)))` dispatch in one
   * call, and must return N responses in matching order. When omitted,
   * `(llm_batch ...)` throws a clear "not available" error.
   *
   * The optional `options` argument carries per-dispatch flags lifted
   * from the batch's surface syntax — currently `calibrate`. It is
   * always safe to ignore if the bridge doesn't need them.
   */
  llmBatch?: (
    prompts: string[],
    options?: { calibrate?: boolean }
  ) => Promise<string[]>;
  /**
   * Optional recursive child-session bridge for `(rlm_query …)`.
   *
   * When wired (typically via the MCP path's samplingRlmBridge),
   * spawning a child Nucleus FSM is delegated to this callback.
   * The contract: receive (prompt, materialized contextDoc) and
   * return the child's FINAL string. The MCP bridge implementation
   * runs `runRLMFromContent` with the same llmClient as the parent
   * so the child's LLM calls flow through the same MCP protocol.
   */
  rlmQuery?: (prompt: string, contextDoc: string | null) => Promise<string>;
  /**
   * Optional batched recursive bridge for `(rlm_batch …)`.
   *
   * Receives N (prompt, contextDoc) pairs in one call and must
   * return N response strings in matching order. The MCP bridge
   * fans out to N rlmQuery calls in parallel.
   */
  rlmBatch?: (
    items: Array<{ prompt: string; contextDoc: string | null }>
  ) => Promise<string[]>;
}

/**
 * Create SolverTools from document content
 *
 * @param context - Document content to expose via grep/fuzzy/bm25/etc.
 * @param llmQuery - Optional sub-LLM bridge for the `(llm_query ...)` primitive.
 *   When passed through (e.g. by the MCP sampling bridge in lattice-mcp-server),
 *   the solver dispatches every `(llm_query ...)` term through this callback,
 *   both top-level and nested inside map/filter/reduce lambdas. When omitted,
 *   `(llm_query ...)` throws a clear "not available" error from the solver.
 */
function createSolverTools(
  context: string,
  llmQuery?: (prompt: string) => Promise<string>,
  llmBatch?: (
    prompts: string[],
    options?: { calibrate?: boolean }
  ) => Promise<string[]>,
  rlmQuery?: (prompt: string, contextDoc: string | null) => Promise<string>,
  rlmBatch?: (
    items: Array<{ prompt: string; contextDoc: string | null }>
  ) => Promise<string[]>
): SolverTools {
  const lines = context.split("\n");

  // Build newline offset index for O(log N) line-number lookup from byte offset
  const newlineOffsets: number[] = [];
  for (let i = 0; i < context.length; i++) {
    if (context[i] === "\n") newlineOffsets.push(i);
  }

  function lineAtOffset(offset: number): number {
    let lo = 0, hi = newlineOffsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (newlineOffsets[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1; // 1-indexed line number
  }

  const textStats = {
    length: context.length,
    lineCount: lines.length,
    sample: {
      start: lines.slice(0, 5).join("\n"),
      middle: lines
        .slice(
          Math.max(0, Math.floor(lines.length / 2) - 2),
          Math.floor(lines.length / 2) + 3
        )
        .join("\n"),
      end: lines.slice(-5).join("\n"),
    },
  };

  function fuzzyMatch(str: string, query: string): number {
    if (!query || query.length === 0) return 0;
    const strLower = str.toLowerCase();
    const queryLower = query.toLowerCase();

    if (strLower.includes(queryLower)) {
      return 100 + queryLower.length;
    }

    let score = 0;
    let queryIndex = 0;
    let prevMatchIndex = -1;

    for (let i = 0; i < strLower.length && queryIndex < queryLower.length; i++) {
      if (strLower[i] === queryLower[queryIndex]) {
        score += 10;
        if (prevMatchIndex === i - 1) {
          score += 5;
        }
        prevMatchIndex = i;
        queryIndex++;
      }
    }

    return queryIndex === queryLower.length ? score : 0;
  }

  return {
    context,
    lines,

    grep: (pattern: string) => {
      const MAX_GREP_MATCHES = 10000;
      const MAX_PATTERN_LENGTH = 1000;
      const MAX_CAPTURE_GROUPS = 50;
      const GREP_TIME_BUDGET_MS = 5000;
      if (pattern.length > MAX_PATTERN_LENGTH) return [];
      const validation = validateRegex(pattern);
      if (!validation.valid) return [];
      const unescapedParens = pattern.replace(/\\\\/g, "").replace(/\\./g, "").match(/\(/g);
      if (unescapedParens && unescapedParens.length > MAX_CAPTURE_GROUPS) return [];
      const flags = "gmi";
      const regex = new RegExp(pattern, flags);
      const results: Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }> = [];
      let match;
      const deadline = Date.now() + GREP_TIME_BUDGET_MS;

      while ((match = regex.exec(context)) !== null) {
        if (Date.now() > deadline) break;
        const lineNum = lineAtOffset(match.index);
        const line = lines[lineNum - 1] || "";

        results.push({
          match: match[0],
          line: line,
          lineNum: lineNum,
          index: match.index,
          groups: match.slice(1).filter((g): g is string => g !== undefined),
        });

        if (match[0].length === 0) {
          regex.lastIndex++;
        }

        if (results.length >= MAX_GREP_MATCHES) break;
      }

      return results;
    },

    fuzzy_search: (query: string, limit: number = 10) => {
      const MAX_QUERY_LENGTH = 500;
      const MAX_FUZZY_LINES = 50_000;
      if (query.length > MAX_QUERY_LENGTH) return [];
      if (!Number.isFinite(limit)) limit = 10;
      const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
      const results: Array<{ line: string; lineNum: number; score: number }> = [];
      const lineCount = Math.min(lines.length, MAX_FUZZY_LINES);

      for (let i = 0; i < lineCount; i++) {
        const score = fuzzyMatch(lines[i], query);
        if (score > 0) {
          results.push({
            line: lines[i],
            lineNum: i + 1,
            score,
          });
        }
      }

      results.sort((a, b) => {
        if (b.score > a.score) return 1;
        if (b.score < a.score) return -1;
        return 0;
      });
      return results.slice(0, clampedLimit);
    },

    bm25: (() => {
      let index: BM25Index | null = null;
      return (query: string, limit: number = 10) => {
        if (!index) {
          index = buildBM25Index(lines);
        }
        return searchBM25(query, lines, index, undefined, limit);
      };
    })(),

    semantic: (() => {
      let index: SemanticIndex | null = null;
      return (query: string, limit: number = 10) => {
        if (!index) {
          index = buildSemanticIndex(lines);
        }
        return searchSemantic(query, lines, index, limit);
      };
    })(),

    text_stats: () => ({ ...textStats }),

    // Symbolic-recursion hook — only present if the caller threaded one in
    // (e.g. the MCP sampling bridge). Omitted means `(llm_query ...)` throws.
    llmQuery,
    // Batched sibling of llmQuery — dispatches all N prompts from
    // `(llm_batch …)` in a single call. Omitted means `(llm_batch …)` throws.
    llmBatch,
    // Phase 1/2 — recursive child Nucleus session bridges. Wired
    // by the MCP path (samplingRlmBridge / samplingRlmBatchBridge)
    // so `(rlm_query …)` and `(rlm_batch …)` work end-to-end via
    // the same llmClient suspension protocol the parent uses.
    rlmQuery,
    rlmBatch,
  };
}

/**
 * NucleusEngine - Execute Nucleus commands against documents
 *
 * @example
 * ```typescript
 * const engine = new NucleusEngine();
 * await engine.loadDocument("./logs.txt");
 *
 * const hits = engine.execute("(grep \"ERROR\")");
 * const filtered = engine.execute("(filter RESULTS (lambda (x) (match x \"500\" 0)))");
 * const count = engine.execute("(count RESULTS)");
 *
 * console.log(`Found ${count.value} errors`);
 * ```
 */
export class NucleusEngine {
  private static readonly MAX_TURN_BINDINGS = 100;
  private context: string = "";
  private bindings: Bindings = new Map();
  private solverTools: SolverTools | null = null;
  private verbose: boolean;
  private turnCounter: number = 0;
  private llmQuery?: (prompt: string) => Promise<string>;
  private llmBatch?: (
    prompts: string[],
    options?: { calibrate?: boolean }
  ) => Promise<string[]>;
  private rlmQuery?: (prompt: string, contextDoc: string | null) => Promise<string>;
  private rlmBatch?: (
    items: Array<{ prompt: string; contextDoc: string | null }>
  ) => Promise<string[]>;

  constructor(options: NucleusEngineOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.llmQuery = options.llmQuery;
    this.llmBatch = options.llmBatch;
    this.rlmQuery = options.rlmQuery;
    this.rlmBatch = options.rlmBatch;
  }

  /**
   * Load a document from a file path
   */
  async loadFile(filePath: string): Promise<void> {
    const content = await readFile(filePath, "utf-8");
    this.loadContent(content);
  }

  /**
   * Load a document from a string
   */
  loadContent(content: string): void {
    const trimmed = content.trim();
    this.context = trimmed.length > 0 ? content : "";
    this.solverTools =
      trimmed.length > 0
        ? createSolverTools(
            content,
            this.llmQuery,
            this.llmBatch,
            this.rlmQuery,
            this.rlmBatch
          )
        : null;
    this.bindings.clear();
    this.turnCounter = 0;

    if (this.verbose) {
      const lines = content.split("\n").length;
      console.log(`[Engine] Loaded document: ${content.length.toLocaleString()} chars, ${lines.toLocaleString()} lines`);
    }
  }

  /**
   * Check if a document is loaded
   */
  isLoaded(): boolean {
    return this.context.length > 0 && this.solverTools !== null;
  }

  /**
   * Get document statistics
   */
  getStats(): { length: number; lineCount: number } | null {
    if (!this.solverTools) return null;
    const stats = this.solverTools.text_stats();
    return { length: stats.length, lineCount: stats.lineCount };
  }

  /**
   * Execute a Nucleus command
   *
   * Became async in the chunked refactor that made `solve()` return
   * `Promise<SolveResult>`. Callers that previously did
   * `const r = engine.execute(cmd)` must now `await` it.
   *
   * @param command - Nucleus S-expression (e.g., "(grep \"pattern\")")
   * @returns Execution result with value, logs, and any errors
   */
  async execute(command: string): Promise<ExecutionResult> {
    if (!this.solverTools) {
      return {
        success: false,
        value: null,
        logs: [],
        error: "No document loaded. Call loadFile() or loadContent() first.",
      };
    }

    // Parse the LC term — fall back to a mechanical repair pass for the
    // common LLM near-misses (missing/extra trailing parens, prose
    // wrapping the expression) before reporting a parse error. We also
    // attempt repair when parse succeeded but left `remaining` tokens
    // unconsumed — that's almost always prose around the expression
    // (the parser would otherwise return a meaningless one-symbol term
    // like `var "Here"` from "Here it is: (count …)"). The repaired
    // form must reparse cleanly AND with no remaining tokens; otherwise
    // the original outcome is preserved.
    let parseResult = parseLC(command);
    const repairLogs: string[] = [];
    const parseIsClean =
      parseResult.success && !!parseResult.term && !parseResult.remaining;
    if (!parseIsClean) {
      const lint = lintAndRepair(command);
      if (lint.repaired !== null) {
        const repaired = parseLC(lint.repaired);
        if (repaired.success && repaired.term && !repaired.remaining) {
          repairLogs.push(`linter: ${lint.repairs.join("; ")}`);
          if (this.verbose) {
            console.log(`[Engine] Linter repaired query (${lint.repairs.join("; ")})`);
          }
          parseResult = repaired;
        }
      }
    }
    if (!parseResult.success || !parseResult.term) {
      return {
        success: false,
        value: null,
        logs: [],
        error: `Parse error: ${parseResult.error}`,
      };
    }

    // Type inference
    const typeResult = inferType(parseResult.term);
    if (!typeResult.valid) {
      return {
        success: false,
        value: null,
        logs: [],
        error: `Type error: ${typeResult.error}`,
      };
    }

    // Execute the term
    const solverResult = await solveTerm(parseResult.term, this.solverTools, this.bindings);

    // Update bindings for cross-query state
    this.turnCounter++;
    if (solverResult.success && solverResult.value !== null && solverResult.value !== undefined) {
      this.bindings.set(`_${this.turnCounter}`, solverResult.value);

      // Handle synthesized functions - store with _fn_ prefix for apply-fn
      if (
        typeof solverResult.value === "object" &&
        solverResult.value !== null &&
        "_type" in solverResult.value &&
        (solverResult.value as { _type: string })._type === "synthesized-fn"
      ) {
        const fnObj = solverResult.value as { _type: string; name: string; fn: unknown; code: string };
        if (typeof fnObj.name === "string" && fnObj.name.length <= 256 && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(fnObj.name)) {
          this.bindings.set(`_fn_${fnObj.name}`, fnObj);
        }
        if (this.verbose) {
          console.log(`[Engine] Registered function "${fnObj.name}" as _fn_${fnObj.name}`);
        }
      } else if (Array.isArray(solverResult.value)) {
        this.bindings.set("RESULTS", solverResult.value);
        if (this.verbose) {
          console.log(`[Engine] Bound ${solverResult.value.length} items to RESULTS and _${this.turnCounter}`);
        }
      } else {
        if (this.verbose) {
          console.log(`[Engine] Bound scalar result to _${this.turnCounter}`);
        }
      }
    }

    // Evict old turn bindings to prevent unbounded growth
    this.evictOldTurnBindings();

    return {
      success: solverResult.success,
      value: solverResult.value,
      logs: repairLogs.length > 0 ? [...repairLogs, ...solverResult.logs] : solverResult.logs,
      error: solverResult.error,
      type: typeResult.type ? typeToString(typeResult.type) : undefined,
    };
  }

  /**
   * Evict oldest turn bindings (_N) when exceeding the cap
   */
  private evictOldTurnBindings(): void {
    const turnKeys: string[] = [];
    for (const key of this.bindings.keys()) {
      if (/^_\d+$/.test(key)) turnKeys.push(key);
    }
    if (turnKeys.length <= NucleusEngine.MAX_TURN_BINDINGS) return;
    turnKeys.sort((a, b) => {
      const aNum = parseInt(a.slice(1), 10);
      const bNum = parseInt(b.slice(1), 10);
      if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) return 0;
      return aNum - bNum;
    });
    while (turnKeys.length > NucleusEngine.MAX_TURN_BINDINGS) {
      const oldest = turnKeys.shift()!;
      this.bindings.delete(oldest);
    }
  }

  /**
   * Execute multiple commands in sequence
   *
   * Must be sequential, not parallel (`Promise.all(map(execute))`),
   * because each command may mutate cross-turn bindings (`_1`, `_2`,
   * `RESULTS`) that a later command reads.
   *
   * @param commands - Array of Nucleus commands
   * @returns Array of execution results
   */
  async executeAll(commands: string[]): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    for (const cmd of commands) {
      results.push(await this.execute(cmd));
    }
    return results;
  }

  /**
   * Get current variable bindings
   */
  private static readonly DANGEROUS_KEYS = new Set([
    "__proto__", "constructor", "prototype",
    "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  ]);

  getBindings(): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of this.bindings) {
      if (NucleusEngine.DANGEROUS_KEYS.has(key)) continue;
      // Summarize arrays to avoid huge output
      if (Array.isArray(value)) {
        result[key] = `Array[${value.length}]`;
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Get a specific binding value
   */
  getBinding(name: string): unknown {
    return this.bindings.get(name);
  }

  /**
   * Set a binding manually.
   *
   * The name regex must match the one used at the auto-registration site
   * in execute() (where `_fn_${fnObj.name}` keys are built for synthesized
   * functions). If they diverge, setBinding rejects names that the engine
   * itself generates — a surprising asymmetry. Keep both on the hyphen-
   * allowing regex so Lisp-style names like `parse-date` round-trip
   * through both code paths.
   */
  setBinding(name: string, value: unknown): void {
    if (!name || name.length > 256 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
      throw new Error("Invalid binding name");
    }
    if (NucleusEngine.DANGEROUS_KEYS.has(name)) {
      throw new Error("Reserved binding name");
    }
    this.bindings.set(name, value);
  }

  /**
   * Reset all bindings (clear state)
   */
  reset(): void {
    this.bindings.clear();
    this.turnCounter = 0;
    if (this.verbose) {
      console.log("[Engine] State reset");
    }
  }

  dispose(): void {
    this.bindings.clear();
    this.turnCounter = 0;
    this.context = "";
    this.solverTools = null;
  }

  /**
   * Get the raw document content
   */
  getContent(): string {
    return this.context;
  }

  /**
   * Get available commands reference
   */
  static getCommandReference(): string {
    return `
Nucleus Command Reference
=========================

SEARCH OPERATIONS (impure - access document):
  (grep "pattern")              Search for regex pattern, returns matches
  (fuzzy_search "query" limit)  Fuzzy search, returns top matches by relevance
  (bm25 "query" limit)          BM25 ranked keyword search, returns by relevance
  (semantic "query" limit)      TF-IDF cosine similarity search, semantic ranking
  (text_stats)                  Get document statistics
  (lines start end)             Get lines in range (1-indexed)

CHUNKING (pre-slice a large document before mapping over it):
  (chunk_by_size N)             Split document into N-character slices
  (chunk_by_lines N)            Split document into N-line slices
  (chunk_by_regex "pat")        Split wherever pat matches; capture groups ignored
    Canonical pattern:
      (map (chunk_by_lines 100)
           (lambda c (llm_query "summarize: {chunk}" (chunk c))))
    fires one sub-LLM call per chunk — the paper's OOLONG-Pairs
    pattern applied to a document too large for the context window.

SUB-LLM (symbolic recursion):
  (llm_query "prompt")                        Direct prompt with no bindings
  (llm_query "...{name}..." (name VALUE))     With named placeholders
  (llm_query "..." (one_of "a" "b" "c"))      Enum-validated classification
  (llm_batch COLL (lambda x (llm_query ...))) Batched variant — ONE call instead of N
  (llm_batch COLL (lambda x (llm_query "..." (one_of "a" "b") (calibrate))))
  Rules:
    — prompt is a literal string with {name} placeholders; each
      (name TERM) fills one with TERM's evaluated value
    — llm_query returns string; llm_batch returns string[]; bound to _N
    — llm_query nests inside map/filter/reduce; llm_batch takes the
      same map-style lambda but fires ONE suspension for all N items
    — (one_of "v1" …) validates + canonicalizes response against enum;
      out-of-set fails the query (llm_batch names the offending index)
    — (calibrate) on llm_batch asks the model to scan the full
      distribution before committing to any individual rating
  Works with any MCP client via the multi-turn suspension protocol
  (lattice_llm_respond / lattice_llm_batch_respond); clients that
  advertise "sampling" get the faster native path.

SYMBOL OPERATIONS (requires tree-sitter - .ts, .js, .py, .go, .md, etc.):
  (list_symbols)                List all symbols (functions, classes, methods, headings, etc.)
  (list_symbols "kind")         Filter by kind: "function", "class", "method", "interface", "type", "struct"
  (get_symbol_body "name")      Get source code body for a symbol by name
  (get_symbol_body RESULTS)     Get source code body for symbol from previous query
  (find_references "name")      Find all references to an identifier

FUSION:
  (fuse expr1 expr2 ...)        Fuse results from multiple searches using RRF
                                Example: (fuse (grep "ERROR") (bm25 "error handling"))
  (dampen results "query")      Remove false positives by checking term overlap
                                Example: (dampen (bm25 "error") "database error")
  (rerank results)              Rerank using Q-value learning (learns across turns)
                                Example: (rerank (fuse (grep "ERROR") (bm25 "error")))

COLLECTION OPERATIONS (pure - work on RESULTS):
  (filter RESULTS pred)         Keep items matching predicate
  (map RESULTS transform)       Transform each item
  (count RESULTS)               Count items
  (sum RESULTS)                 Sum numeric values
  (reduce RESULTS init fn)      Generic reduce

PREDICATES (for filter):
  (lambda (x) (match x "pattern" group))   Regex match predicate
  (classify "line1" true "line2" false)    Build classifier from examples

STRING OPERATIONS:
  (match str "pattern" group)   Extract regex group from string
  (replace str "from" "to")     Replace pattern in string
  (split str "delim" index)     Split and get part at index
  (parseInt str)                Parse string to integer
  (parseFloat str)              Parse string to float

TYPE COERCION:
  (parseDate str)               Parse date string to ISO format
  (parseCurrency str)           Parse currency string to number
  (parseNumber str)             Parse numeric string with separators
  (coerce term "type")          Coerce value to type (date/currency/number/boolean/string)

SYNTHESIS:
  (synthesize (example "in1" out1) (example "in2" out2) ...)
                                Synthesize function from examples

VARIABLES (for use in queries):
  RESULTS                       Last array result (auto-bound)
  _1, _2, _3, ...              Results from turn N (auto-bound)
  context                       Raw document content

NOTE: Handle stubs (e.g. $grep_error, $filter_timeout) are for lattice_expand only.
      Use RESULTS or _1, _2, _3 to reference previous results in queries.

SUPPORTED LANGUAGES FOR SYMBOLS:
  TypeScript (.ts, .tsx), JavaScript (.js, .jsx), Python (.py), Go (.go)
`;
  }
}

/**
 * Create a NucleusEngine instance with a document already loaded
 */
export async function createEngine(filePath: string, options?: NucleusEngineOptions): Promise<NucleusEngine> {
  const engine = new NucleusEngine(options);
  await engine.loadFile(filePath);
  return engine;
}

/**
 * Create a NucleusEngine instance from string content
 */
export function createEngineFromContent(content: string, options?: NucleusEngineOptions): NucleusEngine {
  const engine = new NucleusEngine(options);
  engine.loadContent(content);
  return engine;
}
