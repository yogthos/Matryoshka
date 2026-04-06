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

import type { LCTerm, CoercionType, SynthesisExample } from "./types.js";
import { fuseRRF, type LineResult } from "./rrf.js";
import { resolveConstraints } from "./constraint-resolver.js";
import { run, Rel, eq, conde, exist, failo, type Var, type Substitution } from "../minikanren/index.js";
import { synthesizeExtractor, compileToFunction, prettyPrint, type Example } from "../synthesis/evalo/index.js";
import { synthesizeFromExamples, deriveFunction } from "./relational-solver.js";
import { SynthesisIntegrator } from "./synthesis-integrator.js";

// Type for sandbox tools interface
export interface SolverTools {
  grep: (pattern: string) => Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }>;
  fuzzy_search: (query: string, limit?: number) => Array<{ line: string; lineNum: number; score: number }>;
  bm25: (query: string, limit?: number) => Array<{ line: string; lineNum: number; score: number }>;
  text_stats: () => { length: number; lineCount: number; sample: { start: string; middle: string; end: string } };
  context: string;
}

/**
 * Bindings map for cross-turn state
 * Maps variable names to their values from previous turns
 */
export type Bindings = Map<string, unknown>;

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

  // Reject nested quantifiers that cause catastrophic backtracking
  // Patterns like (a+)+, (a*)+, (a+)*, (a{1,})+, etc.
  if (/(\((?:[^()]*[+*{])[^()]*\))[+*{]|\(\?[^)]*[+*{][^)]*\)[+*{]/.test(pattern)) {
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
export function solve(
  term: LCTerm,
  tools: SolverTools,
  bindings: Bindings = new Map()
): SolveResult {
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
    const value = evaluate(resolved.term, tools, bindings, log, 0);
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

const MAX_EVAL_DEPTH = 1000;

/**
 * Evaluate an LC term
 * Impure operations execute directly, pure operations use miniKanren
 */
function evaluate(
  term: LCTerm,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): unknown {
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
        const result = evaluate(coll, tools, bindings, log, depth + 1);
        if (!Array.isArray(result)) {
          throw new Error(`fuse: expected array argument, got ${typeof result}`);
        }
        // Normalize to LineResult format — grep results have {match, line, lineNum, index, groups}
        // bm25/fuzzy have {line, lineNum, score} — ensure all have score
        const normalized: LineResult[] = (result as unknown[]).map((item: unknown) => {
          const obj = item as Record<string, unknown>;
          return {
            ...(obj as object),             // base fields first (preserves extra fields like match, groups)
            line: String(obj.line ?? ""),    // sanitized overrides after spread
            lineNum: Number(obj.lineNum ?? 0),
            score: Number(obj.score ?? 1),  // grep results lack score — default 1
          };
        });
        signals.push(normalized);
      }
      log(`[Solver] Fusing ${signals.length} signals (${signals.map(s => s.length).join(" + ")} results)`);
      const fused = fuseRRF(signals);
      log(`[Solver] Fused into ${fused.length} results`);
      return fused;
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
      const allLines = tools.context.split("\n");
      // Convert to 0-indexed and clamp to valid range
      const startIdx = Math.max(0, Math.floor(term.start) - 1);
      const endIdx = Math.min(allLines.length, Math.floor(term.end));
      const selectedLines = allLines.slice(startIdx, endIdx);
      log(`[Solver] Retrieved ${selectedLines.length} lines`);
      // Return array of strings to be compatible with filter/map
      return selectedLines;
    }

    // ==========================
    // PURE OPERATIONS - Use miniKanren for filtering/classification
    // ==========================

    case "filter": {
      // Evaluate the collection first (may be grep, fuzzy_search, etc.)
      const collection = evaluate(term.collection, tools, bindings, log, depth + 1) as Array<{ line: string; lineNum: number }>;
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
      // Handle both grep results (objects with .line) and raw values
      const results: unknown[] = [];

      for (let idx = 0; idx < collection.length; idx++) {
        const item = collection[idx];
        const itemValue = typeof item === "object" && item !== null && "line" in item
          ? (item as { line: string }).line
          : String(item ?? "");

        const matches = evaluatePredicate(predBody, predLambda.param, itemValue, tools, bindings, log, depth + 1);
        if (matches) {
          results.push(item);
        }
      }

      log(`[Solver] Filter kept ${results.length} of ${collection.length} items`);
      return results;
    }

    case "map": {
      const collection = evaluate(term.collection, tools, bindings, log, depth + 1) as Array<{ line: string; lineNum: number }>;
      if (!Array.isArray(collection)) {
        throw new Error(`map: expected array, got ${typeof collection}`);
      }

      if (term.transform.tag !== "lambda") {
        throw new Error(`map: transform must be a lambda`);
      }

      const transformLambda = term.transform;
      log(`[Solver] Mapping over ${collection.length} items`);

      const results: unknown[] = [];
      for (const item of collection) {
        // Handle both grep results (objects with .line) and raw values
        const itemValue = typeof item === "object" && item !== null && "line" in item
          ? (item as { line: string }).line
          : String(item ?? "");

        const value = evaluateTransform(
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
      const collection = evaluate(term.collection, tools, bindings, log, depth + 1);
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
        // Handle grep result objects - extract number from line
        if (typeof val === "object" && val !== null && "line" in val) {
          const line = (val as { line: string }).line;
          // Look for dollar amounts like "$1,234,567" or plain numbers
          const numMatch = line.match(/\$?([\d,]+(?:\.\d+)?)/);
          if (numMatch) {
            const cleaned = numMatch[1].replace(/,/g, "");
            const num = parseFloat(cleaned);
            if (!Number.isFinite(num)) {
              skippedCount++;
              return acc;
            }
            return acc + num;
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
      const collection = evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`count: expected array, got ${typeof collection}`);
      }
      log(`[Solver] Count = ${collection.length}`);
      return collection.length;
    }

    case "reduce": {
      // Generic reduce - (reduce collection init (lambda (acc x) ...))
      const collection = evaluate(term.collection, tools, bindings, log, depth + 1);
      if (!Array.isArray(collection)) {
        throw new Error(`reduce: expected array, got ${typeof collection}`);
      }
      const init = evaluate(term.init, tools, bindings, log, depth + 1);
      if (term.fn.tag !== "lambda") {
        throw new Error(`reduce: fn must be a lambda`);
      }
      log(`[Solver] Reducing ${collection.length} items`);
      let acc = init;
      for (const item of collection) {
        // Evaluate lambda with acc and item bound
        acc = evaluateReduceFn(term.fn, acc, item, tools, bindings, log, depth + 1);
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
      const pattern = findDistinguishingPattern(trueExamples, falseExamples, log);

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
      const str = evaluate(term.str, tools, bindings, log, depth + 1) as string;
      if (typeof str !== "string") {
        throw new Error(`match: expected string, got ${typeof str}`);
      }
      if (!Number.isInteger(term.group) || term.group < 0 || term.group > 99) return null;
      const matchValidation = validateRegex(term.pattern);
      if (!matchValidation.valid) {
        throw new Error(`match: ${matchValidation.error}`);
      }
      const regex = new RegExp(term.pattern);
      const result = str.match(regex);
      if (!result) return null;
      if (term.group >= result.length) {
        log(`[Solver] match: group ${term.group} out of bounds (result has ${result.length} groups)`);
        return null;
      }
      return result[term.group] ?? null;
    }

    case "replace": {
      const str = evaluate(term.str, tools, bindings, log, depth + 1) as string;
      if (typeof str !== "string") {
        throw new Error(`replace: expected string, got ${typeof str}`);
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
      const str = evaluate(term.str, tools, bindings, log, depth + 1) as string;
      if (typeof str !== "string") {
        throw new Error(`split: expected string, got ${typeof str}`);
      }
      if (!Number.isInteger(term.index) || term.index < 0) return null;
      if (!term.delim || term.delim.length === 0 || term.delim.length > 1000) return null;
      const MAX_SPLIT_PARTS = 10_000;
      const parts = str.split(term.delim);
      if (parts.length > MAX_SPLIT_PARTS) return null;
      return parts[term.index] ?? null;
    }

    case "parseInt": {
      const str = evaluate(term.str, tools, bindings, log, depth + 1);
      const strForInt = String(str);
      if (strForInt.length > 200) return null;
      const intResult = parseInt(strForInt, 10);
      return isNaN(intResult) || !Number.isSafeInteger(intResult) ? null : intResult;
    }

    case "parseFloat": {
      const str = evaluate(term.str, tools, bindings, log, depth + 1);
      const strForFloat = String(str);
      if (strForFloat.length > 200) return null;
      const floatResult = parseFloat(strForFloat);
      return isNaN(floatResult) || !isFinite(floatResult) ? null : floatResult;
    }

    case "parseDate": {
      const str = evaluate(term.str, tools, bindings, log, depth + 1);
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
      const str = evaluate(term.str, tools, bindings, log, depth + 1);
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
      const str = evaluate(term.str, tools, bindings, log, depth + 1);
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
      const value = evaluate(term.term, tools, bindings, log, depth + 1);
      log(`[Lattice] Coercing "${value}" to ${term.targetType}`);
      const coerced = coerceValue(value, term.targetType);
      log(`[Lattice] Coerced result: ${coerced}`);
      return coerced;
    }

    case "extract": {
      const str = evaluate(term.str, tools, bindings, log, depth + 1) as string;
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
      const left = evaluate(term.left, tools, bindings, log, depth + 1);
      const right = evaluate(term.right, tools, bindings, log, depth + 1);
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
      const cond = evaluate(term.cond, tools, bindings, log, depth + 1);
      if (cond) {
        return evaluate(term.then, tools, bindings, log, depth + 1);
      } else {
        return evaluate(term.else, tools, bindings, log, depth + 1);
      }
    }

    case "lambda":
      // Return a closure representation
      return { _type: "closure", param: term.param, body: term.body };

    case "app": {
      const fn = evaluate(term.fn, tools, bindings, log, depth + 1);
      if (!fn || typeof fn !== "object" || (fn as { _type?: string })._type !== "closure") {
        throw new Error(`app: expected closure, got ${typeof fn}`);
      }
      const closure = fn as { _type: "closure"; param: string; body: LCTerm };
      const arg = evaluate(term.arg, tools, bindings, log, depth + 1);
      // Substitute arg for param in body and evaluate
      // For simplicity, we evaluate directly here
      return evaluateWithBinding(closure.body, closure.param, arg, tools, bindings, log, depth + 1);
    }

    case "constrained":
      return evaluate(term.term, tools, bindings, log, depth + 1);

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
      const arg = evaluate(term.arg, tools, bindings, log, depth + 1);
      log(`[Lattice] Applying function "${term.name}" to "${arg}"`);
      return (storedFn.fn as (input: string) => unknown)(String(arg));
    }

    case "predicate": {
      // Synthesize a predicate from examples
      const str = evaluate(term.str, tools, bindings, log, depth + 1);
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

      const symbolRef = evaluate(term.symbol, tools, bindings, log, depth + 1);
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

    default:
      throw new Error(`Unknown term tag: ${(term as LCTerm).tag}`);
  }
}

/**
 * Evaluate a predicate term with a bound variable
 * Returns true if the predicate matches
 */
function evaluatePredicate(
  body: LCTerm,
  param: string,
  value: string,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): boolean {
  // Simple pattern: (match var "pattern" 0)
  if (body.tag === "match") {
    if (!Number.isInteger(body.group) || body.group < 0) return false;
    const str = body.str.tag === "var" && body.str.name === param ? value : String(evaluate(body.str, tools, bindings, log, depth + 1));
    const patternValidation = validateRegex(body.pattern);
    if (!patternValidation.valid) return false;
    const regex = new RegExp(body.pattern);
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
  const result = evaluateWithBinding(body, param, value, tools, bindings, log, depth + 1);
  return Boolean(result);
}

/**
 * Evaluate a transform term with a bound variable
 */
function evaluateTransform(
  body: LCTerm,
  param: string,
  value: string,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): unknown {
  return evaluateWithBinding(body, param, value, tools, bindings, log, depth + 1);
}

/**
 * Evaluate reduce function with two bindings (acc, item)
 */
function evaluateReduceFn(
  fn: LCTerm & { tag: "lambda" },
  acc: unknown,
  item: unknown,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): unknown {
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
    return evaluate(innerBody, tools, newBindings, log, depth + 1);
  }

  // Single param - bind it to the item, use existing bindings for acc
  const newBindings = new Map(bindings);
  newBindings.set(param, item);
  // Only set "acc" if it won't collide with the lambda parameter name
  if (param !== "acc") {
    newBindings.set("acc", acc);
  }
  return evaluate(body, tools, newBindings, log, depth + 1);
}

/**
 * Evaluate a term with a variable binding
 */
function evaluateWithBinding(
  body: LCTerm,
  param: string,
  value: unknown,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void,
  depth: number = 0
): unknown {
  if (depth > MAX_EVAL_DEPTH) {
    throw new Error("evaluateWithBinding: maximum recursion depth exceeded");
  }
  // Substitute variables and evaluate
  switch (body.tag) {
    case "var":
      if (body.name === param) return value;
      return evaluate(body, tools, bindings, log, depth + 1);

    case "lit":
      return body.value;

    case "match": {
      const str = body.str.tag === "var" && body.str.name === param
        ? String(value)
        : String(evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1));
      const matchVal = validateRegex(body.pattern);
      if (!matchVal.valid) {
        throw new Error(`match: ${matchVal.error}`);
      }
      if (!Number.isInteger(body.group) || body.group < 0) return null;
      const regex = new RegExp(body.pattern);
      const result = str.match(regex);
      return result ? (result[body.group] ?? null) : null;
    }

    case "replace": {
      const str = body.str.tag === "var" && body.str.name === param
        ? String(value)
        : String(evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1));
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
        : String(evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1));
      const MAX_EVAL_SPLIT_PARTS = 10_000;
      const parts = str.split(body.delim);
      if (parts.length > MAX_EVAL_SPLIT_PARTS) return null;
      return parts[body.index] ?? null;
    }

    case "parseInt": {
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
      const strForInt = String(str);
      if (strForInt.length > 200) return null;
      const intResult = parseInt(strForInt, 10);
      return isNaN(intResult) || !Number.isSafeInteger(intResult) ? null : intResult;
    }

    case "parseFloat": {
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
      const strForFloat = String(str);
      if (strForFloat.length > 200) return null;
      const floatResult = parseFloat(strForFloat);
      return isNaN(floatResult) || !isFinite(floatResult) ? null : floatResult;
    }

    case "add": {
      const left = evaluateWithBinding(body.left, param, value, tools, bindings, log, depth + 1);
      const right = evaluateWithBinding(body.right, param, value, tools, bindings, log, depth + 1);
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
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
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
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
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
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
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
      const termValue = evaluateWithBinding(body.term, param, value, tools, bindings, log, depth + 1);
      return coerceValue(termValue, body.targetType);
    }

    case "extract": {
      if (!Number.isInteger(body.group) || body.group < 0) return null;
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1) as string;
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
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log, depth + 1);
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
      return evaluate(body, tools, newBindings, log, depth + 1);
  }
}

/**
 * Use miniKanren to find a regex pattern that matches true examples
 * but not false examples
 */
function findDistinguishingPattern(
  trueExamples: string[],
  falseExamples: string[],
  log: (msg: string) => void
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
      return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
