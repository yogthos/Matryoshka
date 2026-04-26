/**
 * Type Inference for Nucleus LC
 *
 * Infers types for LC terms BEFORE execution.
 * This allows early rejection of type mismatches.
 *
 * For example, if user asks for "list of dates" but the LC
 * would return a string, we can reject before wasting a turn.
 */

import type { LCTerm, LCType, TypeResult } from "./types.js";

/**
 * Type environment for variable bindings
 */
type TypeEnv = Map<string, LCType>;

/**
 * Infer the type of an LC term
 */
export function inferType(term: LCTerm, env: TypeEnv = new Map()): TypeResult {
  try {
    const type = infer(term, env);
    return { valid: true, type };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Internal type inference
 */
function infer(term: LCTerm, env: TypeEnv): LCType {
  switch (term.tag) {
    case "input":
      return { tag: "string" };

    case "lit":
      if (typeof term.value === "string") return { tag: "string" };
      if (typeof term.value === "number") return { tag: "number" };
      if (typeof term.value === "boolean") return { tag: "boolean" };
      return { tag: "any" };

    case "grep":
      // grep returns array of {match, line, lineNum}
      return { tag: "array", element: { tag: "any" } };

    case "fuzzy_search":
      // fuzzy_search returns array of {line, lineNum, score}
      return { tag: "array", element: { tag: "any" } };

    case "bm25":
      // bm25 returns array of {line, lineNum, score}
      return { tag: "array", element: { tag: "any" } };

    case "fuse":
      // fuse returns array of {line, lineNum, score, signals}
      return { tag: "array", element: { tag: "any" } };

    case "dampen":
      // dampen returns array of {line, lineNum, score} (same shape, adjusted scores)
      return { tag: "array", element: { tag: "any" } };

    case "rerank":
      // rerank returns array of {line, lineNum, score, qScore}
      return { tag: "array", element: { tag: "any" } };

    case "semantic":
      // semantic returns array of {line, lineNum, score}
      return { tag: "array", element: { tag: "any" } };

    case "text_stats":
      // text_stats returns {length, lineCount, sample}
      return { tag: "any" };

    case "filter": {
      // filter returns array of same element type
      const collType = infer(term.collection, env);
      if (collType.tag === "array") {
        return collType;
      }
      return { tag: "array", element: { tag: "any" } };
    }

    case "map": {
      // map returns array, element type depends on transform
      return { tag: "array", element: { tag: "any" } };
    }

    case "add":
      // add returns number
      return { tag: "number" };

    case "match":
      // match returns string | null — use "any" since type system has no nullable
      return { tag: "any" };

    case "replace":
      // replace returns string
      return { tag: "string" };

    case "split":
      // split returns string[] | null — use "any" since type system has no nullable
      return { tag: "any" };

    case "parseInt":
      return { tag: "number" };

    case "parseFloat":
      return { tag: "number" };

    case "if": {
      const thenType = infer(term.then, env);
      const elseType = infer(term.else, env);
      // If branches have same type, return that type
      if (typesEqual(thenType, elseType)) {
        return thenType;
      }
      // Otherwise return any
      return { tag: "any" };
    }

    case "classify":
      // Classify returns a classifier function
      // Classifier: string -> boolean | string | number
      return {
        tag: "function",
        param: { tag: "string" },
        result: { tag: "any" },
      };

    case "constrained":
      // Constraints don't change the type
      return infer(term.term, env);

    case "var": {
      const bound = env.get(term.name);
      if (bound) return bound;
      // Unknown variables have type any
      return { tag: "any" };
    }

    case "app": {
      const fnType = infer(term.fn, env);
      if (fnType.tag === "function") {
        return fnType.result;
      }
      // If not a function type, return any
      return { tag: "any" };
    }

    case "lambda": {
      // Create new environment with parameter bound
      const newEnv = new Map(env);
      newEnv.set(term.param, { tag: "any" });
      const bodyType = infer(term.body, newEnv);
      return {
        tag: "function",
        param: { tag: "any" },
        result: bodyType,
      };
    }

    // Synthesis-related terms
    case "predicate":
      // Predicate returns boolean
      return { tag: "boolean" };

    case "define-fn":
      // define-fn stores function, returns confirmation
      return { tag: "any" };

    case "apply-fn":
      // apply-fn returns whatever the function returns
      return { tag: "any" };

    case "extract":
      // extract returns string or typed value
      return { tag: "any" };

    case "parseCurrency":
      // parseCurrency returns number
      return { tag: "number" };

    case "parseDate":
      // parseDate returns string (ISO format)
      return { tag: "string" };

    case "parseNumber":
      // parseNumber returns number
      return { tag: "number" };

    case "lines":
      // lines returns array of strings
      return { tag: "array", element: { tag: "string" } };

    case "chunk_by_size":
    case "chunk_by_lines":
    case "chunk_by_regex":
      // All three chunking primitives return array<string>.
      return { tag: "array", element: { tag: "string" } };

    case "seq":
      // (seq …) evaluates to the type of the LAST subexpr. Empty seq is
      // rejected by the parser so we can safely take the tail.
      return infer(term.exprs[term.exprs.length - 1], env);

    case "sum":
      return { tag: "number" };

    case "count":
      return { tag: "number" };

    case "reduce":
      return { tag: "any" };

    case "coerce": {
      switch (term.targetType) {
        case "number":
        case "currency":
        case "percent":
          return { tag: "number" };
        case "date":
        case "string":
          return { tag: "string" };
        case "boolean":
          return { tag: "boolean" };
        default:
          return { tag: "any" };
      }
    }

    case "synthesize":
      return { tag: "function", param: { tag: "string" }, result: { tag: "any" } };

    case "list_symbols":
      return { tag: "array", element: { tag: "any" } };

    case "get_symbol_body":
      return { tag: "string" };

    case "find_references":
      return { tag: "array", element: { tag: "any" } };

    case "callers":
      return { tag: "array", element: { tag: "any" } };

    case "callees":
      return { tag: "array", element: { tag: "any" } };

    case "ancestors":
      return { tag: "array", element: { tag: "any" } };

    case "descendants":
      return { tag: "array", element: { tag: "any" } };

    case "implementations":
      return { tag: "array", element: { tag: "any" } };

    case "dependents":
      return { tag: "array", element: { tag: "any" } };

    case "symbol_graph":
      return { tag: "any" };

    case "communities":
      return { tag: "array", element: { tag: "any" } };

    case "community_of":
      return { tag: "any" };

    case "god_nodes":
      return { tag: "array", element: { tag: "any" } };

    case "surprising_connections":
      return { tag: "array", element: { tag: "any" } };

    case "bridge_nodes":
      return { tag: "array", element: { tag: "any" } };

    case "suggest_questions":
      return { tag: "array", element: { tag: "any" } };

    case "graph_report":
      return { tag: "any" };

    case "llm_query":
      return { tag: "string" };

    case "llm_batch":
      return { tag: "array", element: { tag: "string" } };

    case "rlm_query":
      return { tag: "string" };

    case "rlm_batch":
      return { tag: "array", element: { tag: "string" } };

    case "context":
      return { tag: "string" };

    case "show_vars":
      return { tag: "string" };

    default:
      return { tag: "any" };
  }
}

/**
 * Check if two types are equal
 */
function typesEqual(a: LCType, b: LCType): boolean {
  if (a.tag !== b.tag) return false;

  switch (a.tag) {
    case "array":
      return b.tag === "array" && typesEqual(a.element, b.element);

    case "function":
      return (
        b.tag === "function" &&
        typesEqual(a.param, b.param) &&
        typesEqual(a.result, b.result)
      );

    default:
      return true;
  }
}

/**
 * Check if a type satisfies an expected type
 */
export function typeMatches(actual: LCType, expected: LCType): boolean {
  // Any matches anything
  if (actual.tag === "any" || expected.tag === "any") return true;

  // Same tag
  if (actual.tag !== expected.tag) return false;

  // Check nested types
  switch (actual.tag) {
    case "array":
      return expected.tag === "array" && typeMatches(actual.element, expected.element);

    case "function":
      return (
        expected.tag === "function" &&
        typeMatches(expected.param, actual.param) && // contravariant
        typeMatches(actual.result, expected.result) // covariant
      );

    default:
      return true;
  }
}

/**
 * Pretty-print a type
 */
export function typeToString(type: LCType): string {
  switch (type.tag) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${typeToString(type.element)}[]`;
    case "function":
      return `(${typeToString(type.param)} -> ${typeToString(type.result)})`;
    case "any":
      return "any";
    case "void":
      return "void";
    default:
      return "unknown";
  }
}

/**
 * Verify that a term's type matches the expected output type
 */
export function verifyOutputType(
  term: LCTerm,
  expectedType: "string" | "number" | "boolean" | "array" | "object"
): TypeResult {
  const result = inferType(term);
  if (!result.valid || !result.type) {
    return result;
  }

  // Map expected type string to LCType
  let expected: LCType;
  switch (expectedType) {
    case "string":
      expected = { tag: "string" };
      break;
    case "number":
      expected = { tag: "number" };
      break;
    case "boolean":
      expected = { tag: "boolean" };
      break;
    case "array":
      expected = { tag: "array", element: { tag: "any" } };
      break;
    case "object":
      expected = { tag: "any" }; // Objects are 'any' for now
      break;
  }

  if (!typeMatches(result.type, expected)) {
    return {
      valid: false,
      type: result.type,
      error: `Type mismatch: expected ${expectedType}, got ${typeToString(result.type)}`,
    };
  }

  return result;
}

/**
 * Infer expected output type from user query
 */
export function inferExpectedType(query: string): "string" | "number" | "array" | "boolean" | null {
  const lower = query.toLowerCase();

  // List/array patterns
  if (
    lower.includes("list") ||
    lower.includes("all") ||
    lower.includes("find") ||
    lower.includes("which")
  ) {
    return "array";
  }

  // Count/sum patterns
  if (
    lower.includes("count") ||
    lower.includes("how many") ||
    lower.includes("sum") ||
    lower.includes("total") ||
    lower.includes("average")
  ) {
    return "number";
  }

  // Boolean patterns
  if (
    lower.includes("is there") ||
    lower.includes("does") ||
    lower.includes("are there")
  ) {
    return "boolean";
  }

  // String patterns
  if (
    lower.includes("what is") ||
    lower.includes("get the") ||
    lower.includes("extract")
  ) {
    return "string";
  }

  return null; // Can't infer
}
