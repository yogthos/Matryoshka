/**
 * LC Interpreter
 *
 * Directly evaluates Lambda Calculus terms using the sandbox tools.
 * This is the core solver that interprets the model's intent.
 *
 * The model outputs LC terms, and this interpreter executes them
 * using the actual primitives (grep, fuzzy_search, filter, map, etc.)
 */

import type { LCTerm } from "./types.js";
import { resolveConstraints } from "./constraint-resolver.js";

// Type for sandbox tools interface
export interface SandboxTools {
  grep: (pattern: string) => Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }>;
  fuzzy_search: (query: string, limit?: number) => Array<{ line: string; lineNum: number; score: number }>;
  text_stats: () => { length: number; lineCount: number; sample: { start: string; middle: string; end: string } };
  llm_query?: (prompt: string) => Promise<string>;
  context: string;
}

// Runtime value types
export type LCValue =
  | null
  | boolean
  | number
  | string
  | LCValue[]
  | { [key: string]: LCValue }
  | LCClosure;

// A closure captures a lambda's environment
export interface LCClosure {
  tag: "closure";
  param: string;
  body: LCTerm;
  env: Environment;
}

// Environment maps variable names to values
export type Environment = Map<string, LCValue>;

/**
 * Interpretation result
 */
export interface InterpretResult {
  success: boolean;
  value: LCValue;
  logs: string[];
  error?: string;
}

/**
 * Interpret an LC term with the given sandbox tools
 */
export function interpret(
  term: LCTerm,
  tools: SandboxTools,
  env: Environment = new Map()
): InterpretResult {
  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  try {
    // Resolve constraints first
    const resolved = resolveConstraints(term);
    const value = evaluate(resolved.term, tools, env, log);
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
 * Core evaluation function
 */
function evaluate(
  term: LCTerm,
  tools: SandboxTools,
  env: Environment,
  log: (msg: string) => void
): LCValue {
  switch (term.tag) {
    case "lit":
      return term.value as LCValue;

    case "var": {
      // Check environment first
      if (env.has(term.name)) {
        return env.get(term.name)!;
      }
      // Check for built-in constants
      if (term.name === "context") {
        return tools.context;
      }
      throw new Error(`Unbound variable: ${term.name}`);
    }

    case "input":
      return tools.context;

    case "grep": {
      log(`Searching for pattern: "${term.pattern}"`);
      const results = tools.grep(term.pattern);
      log(`Found ${results.length} matches`);
      if (results.length > 0) {
        log(`First 5 matches:`);
        results.slice(0, 5).forEach((r, i) => {
          log(`  ${i + 1}. [line ${r.lineNum}] ${r.line}`);
        });
      }
      return results as LCValue;
    }

    case "fuzzy_search": {
      log(`Fuzzy searching for: "${term.query}"`);
      const limit = term.limit ?? 10;
      const results = tools.fuzzy_search(term.query, limit);
      log(`Found ${results.length} fuzzy matches`);
      return results as LCValue;
    }

    case "text_stats": {
      log(`Getting document statistics`);
      const stats = tools.text_stats();
      log(`Document: ${stats.length} chars, ${stats.lineCount} lines`);
      return stats as LCValue;
    }

    case "filter": {
      // Evaluate the collection
      const collection = evaluate(term.collection, tools, env, log);
      if (!Array.isArray(collection)) {
        throw new Error(`filter: expected array, got ${typeof collection}`);
      }

      // Evaluate the predicate (should be a closure or lambda)
      const predicate = evaluate(term.predicate, tools, env, log);
      if (!isClosure(predicate)) {
        throw new Error(`filter: predicate must be a function`);
      }

      log(`Filtering ${collection.length} items`);

      // Apply predicate to each element
      const results: LCValue[] = [];
      for (const item of collection) {
        const newEnv = new Map(predicate.env);
        newEnv.set(predicate.param, item);
        const result = evaluate(predicate.body, tools, newEnv, log);
        if (result === true) {
          results.push(item);
        }
      }

      log(`Filter kept ${results.length} items`);
      return results;
    }

    case "map": {
      // Evaluate the collection
      const collection = evaluate(term.collection, tools, env, log);
      if (!Array.isArray(collection)) {
        throw new Error(`map: expected array, got ${typeof collection}`);
      }

      // Evaluate the transform function
      const transform = evaluate(term.transform, tools, env, log);
      if (!isClosure(transform)) {
        throw new Error(`map: transform must be a function`);
      }

      log(`Mapping over ${collection.length} items`);

      // Apply transform to each element
      const results: LCValue[] = [];
      for (const item of collection) {
        const newEnv = new Map(transform.env);
        newEnv.set(transform.param, item);
        const result = evaluate(transform.body, tools, newEnv, log);
        results.push(result);
      }

      return results;
    }

    case "match": {
      const str = evaluate(term.str, tools, env, log);
      if (typeof str !== "string") {
        throw new Error(`match: expected string, got ${typeof str}`);
      }
      const regex = new RegExp(term.pattern);
      const result = str.match(regex);
      return result ? (result[term.group] ?? null) : null;
    }

    case "replace": {
      const str = evaluate(term.str, tools, env, log);
      if (typeof str !== "string") {
        throw new Error(`replace: expected string, got ${typeof str}`);
      }
      return str.replace(new RegExp(term.from, "g"), term.to);
    }

    case "split": {
      const str = evaluate(term.str, tools, env, log);
      if (typeof str !== "string") {
        throw new Error(`split: expected string, got ${typeof str}`);
      }
      const parts = str.split(term.delim);
      return parts[term.index] ?? null;
    }

    case "parseInt": {
      const str = evaluate(term.str, tools, env, log);
      if (typeof str !== "string" && typeof str !== "number") {
        throw new Error(`parseInt: expected string or number, got ${typeof str}`);
      }
      return parseInt(String(str), 10);
    }

    case "parseFloat": {
      const str = evaluate(term.str, tools, env, log);
      if (typeof str !== "string" && typeof str !== "number") {
        throw new Error(`parseFloat: expected string or number, got ${typeof str}`);
      }
      return parseFloat(String(str));
    }

    case "add": {
      const left = evaluate(term.left, tools, env, log);
      const right = evaluate(term.right, tools, env, log);
      if (typeof left !== "number" || typeof right !== "number") {
        throw new Error(`add: expected numbers`);
      }
      return left + right;
    }

    case "if": {
      const cond = evaluate(term.cond, tools, env, log);
      if (cond) {
        return evaluate(term.then, tools, env, log);
      } else {
        return evaluate(term.else, tools, env, log);
      }
    }

    case "lambda":
      // Return a closure capturing the current environment
      return {
        tag: "closure",
        param: term.param,
        body: term.body,
        env: new Map(env),
      };

    case "app": {
      // Evaluate the function
      const fn = evaluate(term.fn, tools, env, log);
      if (!isClosure(fn)) {
        throw new Error(`app: expected function, got ${typeof fn}`);
      }

      // Evaluate the argument
      const arg = evaluate(term.arg, tools, env, log);

      // Apply: extend the closure's environment with the argument
      const newEnv = new Map(fn.env);
      newEnv.set(fn.param, arg);

      // Evaluate the body in the extended environment
      return evaluate(fn.body, tools, newEnv, log);
    }

    case "classify": {
      // Classify builds a predicate function from examples
      log(`Building classifier from ${term.examples.length} examples`);

      // For now, return a simple classifier function
      // In the future, this could use the miniKanren synthesizer
      const trueExamples = term.examples.filter(e => e.output === true).map(e => e.input);
      const falseExamples = term.examples.filter(e => e.output === false).map(e => e.input);

      log(`  True examples: ${trueExamples.length}`);
      log(`  False examples: ${falseExamples.length}`);

      // Create a simple matching classifier
      // This is where the solver would synthesize a more sophisticated function
      return {
        tag: "closure",
        param: "line",
        body: {
          tag: "var",
          name: "__classify_check__",
        } as LCTerm,
        env: new Map([
          ["__true_patterns__", trueExamples],
          ["__false_patterns__", falseExamples],
        ] as [string, LCValue][]),
      };
    }

    case "constrained":
      // Constraints should be resolved before evaluation
      return evaluate(term.term, tools, env, log);

    default:
      throw new Error(`Unknown term tag: ${(term as LCTerm).tag}`);
  }
}

/**
 * Type guard for closures
 */
function isClosure(value: LCValue): value is LCClosure {
  return (
    value !== null &&
    typeof value === "object" &&
    "tag" in value &&
    (value as LCClosure).tag === "closure"
  );
}

/**
 * Pretty-print an LC value for display
 */
export function formatValue(value: LCValue, indent: number = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3 && value.every(v => typeof v !== "object")) {
      return `[${value.map(v => formatValue(v)).join(", ")}]`;
    }
    const items = value.slice(0, 10).map(v => `${pad}  ${formatValue(v, indent + 1)}`).join(",\n");
    const more = value.length > 10 ? `\n${pad}  ... (${value.length - 10} more)` : "";
    return `[\n${items}${more}\n${pad}]`;
  }

  if (isClosure(value)) {
    return `<function (${value.param}) => ...>`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const items = entries.slice(0, 5).map(([k, v]) => `${pad}  ${k}: ${formatValue(v, indent + 1)}`).join(",\n");
    return `{\n${items}\n${pad}}`;
  }

  return String(value);
}
