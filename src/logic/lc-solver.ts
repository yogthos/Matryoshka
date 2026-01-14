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

import type { LCTerm } from "./types.js";
import { resolveConstraints } from "./constraint-resolver.js";
import { run, Rel, eq, conde, exist, failo, type Var, type Substitution } from "../minikanren/index.js";

// Type for sandbox tools interface
export interface SolverTools {
  grep: (pattern: string) => Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }>;
  fuzzy_search: (query: string, limit?: number) => Array<{ line: string; lineNum: number; score: number }>;
  text_stats: () => { length: number; lineCount: number; sample: { start: string; middle: string; end: string } };
  context: string;
}

/**
 * Bindings map for cross-turn state
 * Maps variable names to their values from previous turns
 */
export type Bindings = Map<string, unknown>;

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
  const log = (msg: string) => logs.push(msg);

  // Log available bindings
  if (bindings.size > 0) {
    log(`[Solver] Available bindings: ${[...bindings.keys()].join(", ")}`);
  }

  try {
    // Resolve constraints first
    const resolved = resolveConstraints(term);
    const value = evaluate(resolved.term, tools, bindings, log);
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

/**
 * Evaluate an LC term
 * Impure operations execute directly, pure operations use miniKanren
 */
function evaluate(
  term: LCTerm,
  tools: SolverTools,
  bindings: Bindings,
  log: (msg: string) => void
): unknown {
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
      const specialChars = /^[\$\.\^\*\+\?\[\]\(\)\{\}\|\\]$/;
      if (specialChars.test(pattern)) {
        pattern = "\\" + pattern;
        log(`[Solver] Auto-escaped special regex char: "${term.pattern}" -> "${pattern}"`);
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
      log(`[Solver] Executing fuzzy_search("${term.query}", ${term.limit ?? 10})`);
      const results = tools.fuzzy_search(term.query, term.limit ?? 10);
      log(`[Solver] Found ${results.length} fuzzy matches`);
      return results;
    }

    case "text_stats": {
      log(`[Solver] Getting document statistics`);
      const stats = tools.text_stats();
      log(`[Solver] Document: ${stats.length} chars, ${stats.lineCount} lines`);
      return stats;
    }

    // ==========================
    // PURE OPERATIONS - Use miniKanren for filtering/classification
    // ==========================

    case "filter": {
      // Evaluate the collection first (may be grep, fuzzy_search, etc.)
      const collection = evaluate(term.collection, tools, bindings, log) as Array<{ line: string; lineNum: number }>;
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

        const matches = evaluatePredicate(predBody, predLambda.param, itemValue, tools, bindings, log);
        if (matches) {
          results.push(item);
        }
      }

      log(`[Solver] Filter kept ${results.length} of ${collection.length} items`);
      return results;
    }

    case "map": {
      const collection = evaluate(term.collection, tools, bindings, log) as Array<{ line: string; lineNum: number }>;
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
          log
        );
        results.push(value);
      }

      return results;
    }

    case "sum": {
      // Sum numeric values in array - works with any numeric array
      const collection = evaluate(term.collection, tools, bindings, log);
      if (!Array.isArray(collection)) {
        throw new Error(`sum: expected array, got ${typeof collection}`);
      }
      log(`[Solver] Summing ${collection.length} values`);
      const total = collection.reduce((acc: number, val: unknown) => {
        if (typeof val === "number") return acc + val;
        if (typeof val === "string") {
          // Try to parse numeric string (handles "$1,000" format)
          const cleaned = val.replace(/[$,]/g, "");
          const num = parseFloat(cleaned);
          return isNaN(num) ? acc : acc + num;
        }
        // Handle grep result objects - extract number from line
        if (typeof val === "object" && val !== null && "line" in val) {
          const line = (val as { line: string }).line;
          // Look for dollar amounts like "$1,234,567" or plain numbers
          const numMatch = line.match(/\$?([\d,]+(?:\.\d+)?)/);
          if (numMatch) {
            const cleaned = numMatch[1].replace(/,/g, "");
            const num = parseFloat(cleaned);
            return isNaN(num) ? acc : acc + num;
          }
        }
        return acc;
      }, 0);
      log(`[Solver] Sum = ${total}`);
      return total;
    }

    case "count": {
      // Count items in array
      const collection = evaluate(term.collection, tools, bindings, log);
      if (!Array.isArray(collection)) {
        throw new Error(`count: expected array, got ${typeof collection}`);
      }
      log(`[Solver] Count = ${collection.length}`);
      return collection.length;
    }

    case "reduce": {
      // Generic reduce - (reduce collection init (lambda (acc x) ...))
      const collection = evaluate(term.collection, tools, bindings, log);
      if (!Array.isArray(collection)) {
        throw new Error(`reduce: expected array, got ${typeof collection}`);
      }
      const init = evaluate(term.init, tools, bindings, log);
      if (term.fn.tag !== "lambda") {
        throw new Error(`reduce: fn must be a lambda`);
      }
      log(`[Solver] Reducing ${collection.length} items`);
      let acc = init;
      for (const item of collection) {
        // Evaluate lambda with acc and item bound
        acc = evaluateReduceFn(term.fn, acc, item, tools, bindings, log);
      }
      return acc;
    }

    case "classify": {
      // Classify builds a predicate from examples
      // Use miniKanren to find a pattern that matches the examples
      log(`[Solver] Building classifier from ${term.examples.length} examples`);

      const trueExamples = term.examples.filter(e => e.output === true).map(e => e.input);
      const falseExamples = term.examples.filter(e => e.output === false).map(e => e.input);

      log(`[Solver] True examples: ${trueExamples.length}, False examples: ${falseExamples.length}`);

      // Use miniKanren to find distinguishing pattern
      const pattern = findDistinguishingPattern(trueExamples, falseExamples, log);

      if (!pattern) {
        log(`[Solver] Could not find distinguishing pattern`);
        return null;
      }

      log(`[Solver] Found pattern: ${pattern}`);

      // Return a classifier function
      return (line: string) => {
        const regex = new RegExp(pattern);
        return regex.test(line);
      };
    }

    // ==========================
    // STRING OPERATIONS
    // ==========================

    case "match": {
      const str = evaluate(term.str, tools, bindings, log) as string;
      if (typeof str !== "string") {
        throw new Error(`match: expected string, got ${typeof str}`);
      }
      const regex = new RegExp(term.pattern, "i"); // Case-insensitive like grep
      const result = str.match(regex);
      return result ? (result[term.group] ?? null) : null;
    }

    case "replace": {
      const str = evaluate(term.str, tools, bindings, log) as string;
      if (typeof str !== "string") {
        throw new Error(`replace: expected string, got ${typeof str}`);
      }
      return str.replace(new RegExp(term.from, "g"), term.to);
    }

    case "split": {
      const str = evaluate(term.str, tools, bindings, log) as string;
      if (typeof str !== "string") {
        throw new Error(`split: expected string, got ${typeof str}`);
      }
      const parts = str.split(term.delim);
      return parts[term.index] ?? null;
    }

    case "parseInt": {
      const str = evaluate(term.str, tools, bindings, log);
      return parseInt(String(str), 10);
    }

    case "parseFloat": {
      const str = evaluate(term.str, tools, bindings, log);
      return parseFloat(String(str));
    }

    case "add": {
      const left = evaluate(term.left, tools, bindings, log) as number;
      const right = evaluate(term.right, tools, bindings, log) as number;
      return left + right;
    }

    case "if": {
      const cond = evaluate(term.cond, tools, bindings, log);
      if (cond) {
        return evaluate(term.then, tools, bindings, log);
      } else {
        return evaluate(term.else, tools, bindings, log);
      }
    }

    case "lambda":
      // Return a closure representation
      return { _type: "closure", param: term.param, body: term.body };

    case "app": {
      const fn = evaluate(term.fn, tools, bindings, log) as { _type: "closure"; param: string; body: LCTerm };
      if (!fn || fn._type !== "closure") {
        throw new Error(`app: expected closure, got ${typeof fn}`);
      }
      const arg = evaluate(term.arg, tools, bindings, log);
      // Substitute arg for param in body and evaluate
      // For simplicity, we evaluate directly here
      return evaluateWithBinding(fn.body, fn.param, arg, tools, bindings, log);
    }

    case "constrained":
      return evaluate(term.term, tools, bindings, log);

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
  log: (msg: string) => void
): boolean {
  // Simple pattern: (match var "pattern" 0)
  if (body.tag === "match") {
    const str = body.str.tag === "var" && body.str.name === param ? value : String(evaluate(body.str, tools, bindings, log));
    const regex = new RegExp(body.pattern, "i"); // Case-insensitive like grep
    const result = str.match(regex);
    return result !== null && result[body.group] !== undefined;
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
  const result = evaluateWithBinding(body, param, value, tools, bindings, log);
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
  log: (msg: string) => void
): unknown {
  return evaluateWithBinding(body, param, value, tools, bindings, log);
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
  log: (msg: string) => void
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
    return evaluate(innerBody, tools, newBindings, log);
  }

  // Single param - bind it to the item, use existing bindings for acc
  const newBindings = new Map(bindings);
  newBindings.set(param, item);
  newBindings.set("acc", acc); // Convention: acc is available
  return evaluate(body, tools, newBindings, log);
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
  log: (msg: string) => void
): unknown {
  // Substitute variables and evaluate
  switch (body.tag) {
    case "var":
      if (body.name === param) return value;
      return evaluate(body, tools, bindings, log);

    case "lit":
      return body.value;

    case "match": {
      const str = body.str.tag === "var" && body.str.name === param
        ? String(value)
        : String(evaluateWithBinding(body.str, param, value, tools, bindings, log));
      const regex = new RegExp(body.pattern, "i"); // Case-insensitive like grep
      const result = str.match(regex);
      return result ? (result[body.group] ?? null) : null;
    }

    case "replace": {
      const str = body.str.tag === "var" && body.str.name === param
        ? String(value)
        : String(evaluateWithBinding(body.str, param, value, tools, bindings, log));
      return str.replace(new RegExp(body.from, "g"), body.to);
    }

    case "split": {
      const str = body.str.tag === "var" && body.str.name === param
        ? String(value)
        : String(evaluateWithBinding(body.str, param, value, tools, bindings, log));
      const parts = str.split(body.delim);
      return parts[body.index] ?? null;
    }

    case "parseInt": {
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log);
      return parseInt(String(str), 10);
    }

    case "parseFloat": {
      const str = evaluateWithBinding(body.str, param, value, tools, bindings, log);
      return parseFloat(String(str));
    }

    case "add": {
      const left = evaluateWithBinding(body.left, param, value, tools, bindings, log) as number;
      const right = evaluateWithBinding(body.right, param, value, tools, bindings, log) as number;
      return left + right;
    }

    default:
      return evaluate(body, tools, bindings, log);
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
  const trueWords = new Set(trueExamples.flatMap(ex => ex.toLowerCase().split(/\W+/)));
  const falseWords = new Set(falseExamples.flatMap(ex => ex.toLowerCase().split(/\W+/)));

  for (const word of trueWords) {
    if (word.length > 3 && !falseWords.has(word)) {
      return word;
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
