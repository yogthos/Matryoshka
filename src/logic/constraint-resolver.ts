/**
 * Constraint Resolver for Nucleus
 *
 * Handles Nucleus-style symbolic constraints:
 * - [Σ⚡μ] - maximize information, minimize complexity
 * - [∞/0] - handle edge cases (null checks)
 * - [ε⚡φ] - efficiency (optimize performance)
 *
 * Constraints are applied BEFORE execution to transform
 * the LC term into a safer/simpler form.
 */

import type { LCTerm, LCConstrained, ConstraintOp } from "./types.js";

/**
 * Result of constraint resolution
 */
export interface ResolvedTerm {
  term: LCTerm;
  transformations: string[];
  nullChecksInjected: boolean;
  simplified: boolean;
}

/**
 * Apply all constraints to a term recursively
 */
export function resolveConstraints(term: LCTerm): ResolvedTerm {
  const transformations: string[] = [];
  let nullChecksInjected = false;
  let simplified = false;

  const MAX_RESOLVE_DEPTH = 500;
  function resolve(t: LCTerm, depth: number = 0): LCTerm {
    if (depth > MAX_RESOLVE_DEPTH) return t;
    // Handle constrained terms
    if (t.tag === "constrained") {
      const resolved = applyConstraint(t.constraint, resolve(t.term, depth + 1));
      transformations.push(`Applied [${t.constraint}]`);

      if (t.constraint === "∞/0") {
        nullChecksInjected = true;
      }
      if (t.constraint === "Σ⚡μ") {
        simplified = true;
      }

      return resolved;
    }

    // Recurse into nested terms
    switch (t.tag) {
      case "input":
      case "lit":
      case "grep":
      case "var":
        return t;

      case "match":
        return { ...t, str: resolve(t.str, depth + 1) };

      case "replace":
        return { ...t, str: resolve(t.str, depth + 1) };

      case "split":
        return { ...t, str: resolve(t.str, depth + 1) };

      case "parseInt":
        return { ...t, str: resolve(t.str, depth + 1) };

      case "parseFloat":
        return { ...t, str: resolve(t.str, depth + 1) };

      case "if":
        return {
          ...t,
          cond: resolve(t.cond, depth + 1),
          then: resolve(t.then, depth + 1),
          else: resolve(t.else, depth + 1),
        };

      case "classify":
        return t;

      case "add":
        return { ...t, left: resolve(t.left, depth + 1), right: resolve(t.right, depth + 1) };

      case "extract":
        return { ...t, str: resolve(t.str, depth + 1) };

      case "reduce":
        return { ...t, collection: resolve(t.collection, depth + 1), init: resolve(t.init, depth + 1), fn: resolve(t.fn, depth + 1) };

      case "filter":
        return { ...t, collection: resolve(t.collection, depth + 1), predicate: resolve(t.predicate, depth + 1) };

      case "map":
        return { ...t, collection: resolve(t.collection, depth + 1), transform: resolve(t.transform, depth + 1) };

      case "app":
        return { ...t, fn: resolve(t.fn, depth + 1), arg: resolve(t.arg, depth + 1) };

      case "lambda":
        return { ...t, body: resolve(t.body, depth + 1) };

      case "sum":
        return { ...t, collection: resolve(t.collection, depth + 1) };

      case "count":
        return { ...t, collection: resolve(t.collection, depth + 1) };

      case "parseCurrency":
      case "parseDate":
      case "parseNumber":
      case "predicate":
        return { ...t, str: resolve(t.str, depth + 1) };

      case "coerce":
        return { ...t, term: resolve(t.term, depth + 1) };

      case "apply-fn":
        return { ...t, arg: resolve(t.arg, depth + 1) };

      case "get_symbol_body":
        return { ...t, symbol: resolve(t.symbol, depth + 1) };

      case "synthesize":
      case "define-fn":
      case "lines":
      case "chunk_by_size":
      case "chunk_by_lines":
      case "chunk_by_regex":
      case "fuzzy_search":
      case "text_stats":
      case "find_references":
      case "list_symbols":
        return t;

      case "seq":
        return { ...t, exprs: t.exprs.map((e) => resolve(e, depth + 1)) };

      default:
        return t;
    }
  }

  const resolvedTerm = resolve(term);

  return {
    term: resolvedTerm,
    transformations,
    nullChecksInjected,
    simplified,
  };
}

/**
 * Apply a specific constraint to a term
 */
function applyConstraint(constraint: ConstraintOp, term: LCTerm): LCTerm {
  switch (constraint) {
    case "Σ⚡μ":
      // Maximize info, minimize complexity
      // Prefer simpler patterns, remove redundant operations
      return simplifyTerm(term);

    case "∞/0":
      // Handle edge cases - wrap in null check
      return wrapWithNullCheck(term);

    case "ε⚡φ":
      // Efficiency - optimize for performance
      return optimizeTerm(term);

    default:
      return term;
  }
}

/**
 * [Σ⚡μ] - Simplify term by removing redundant operations
 */
function simplifyTerm(term: LCTerm): LCTerm {
  switch (term.tag) {
    case "match":
      // If pattern is simple, keep as is
      return term;

    case "replace":
      // If from === to, remove replace
      if (term.from === term.to) {
        return term.str;
      }
      return term;

    case "if":
      // If condition is literal true/false, simplify
      if (term.cond.tag === "lit") {
        if (term.cond.value === true) {
          return term.then;
        }
        if (term.cond.value === false) {
          return term.else;
        }
      }
      return term;

    default:
      return term;
  }
}

/**
 * [∞/0] - Wrap term with null/edge case handling
 */
function wrapWithNullCheck(term: LCTerm): LCTerm {
  // For operations that can return null, wrap in if-else
  switch (term.tag) {
    case "match":
    case "split":
      // These can return null - return the term as-is since the evaluator
      // already handles null returns via ?? null. Wrapping in if(term, term, null)
      // would evaluate the operation twice unnecessarily.
      return term;

    case "parseInt":
    case "parseFloat":
      // These can return NaN, but keep as-is for now
      return term;

    default:
      return term;
  }
}

/**
 * [ε⚡φ] - Optimize term for performance
 */
function optimizeTerm(term: LCTerm): LCTerm {
  // For now, just return the term unchanged
  // Future: could reorder operations, cache patterns, etc.
  return term;
}

/**
 * Check if a term has any constraints applied
 */
export function hasConstraints(term: LCTerm): boolean {
  if (term.tag === "constrained") return true;

  switch (term.tag) {
    case "match":
    case "replace":
    case "split":
    case "parseInt":
    case "parseFloat":
      return hasConstraints(term.str);

    case "if":
      return (
        hasConstraints(term.cond) ||
        hasConstraints(term.then) ||
        hasConstraints(term.else)
      );

    case "add":
      return hasConstraints(term.left) || hasConstraints(term.right);

    case "extract":
      return hasConstraints(term.str);

    case "reduce":
      return hasConstraints(term.collection) || hasConstraints(term.init) || hasConstraints(term.fn);

    case "filter":
      return hasConstraints(term.collection) || hasConstraints(term.predicate);

    case "map":
      return hasConstraints(term.collection) || hasConstraints(term.transform);

    case "app":
      return hasConstraints(term.fn) || hasConstraints(term.arg);

    case "lambda":
      return hasConstraints(term.body);

    case "sum":
    case "count":
      return hasConstraints(term.collection);

    case "parseCurrency":
    case "parseDate":
    case "parseNumber":
    case "predicate":
      return hasConstraints(term.str);

    case "coerce":
      return hasConstraints(term.term);

    case "apply-fn":
      return hasConstraints(term.arg);

    case "get_symbol_body":
      return hasConstraints(term.symbol);

    default:
      return false;
  }
}

/**
 * Extract all constraints from a term
 */
export function extractConstraints(term: LCTerm): ConstraintOp[] {
  const constraints: ConstraintOp[] = [];

  function extract(t: LCTerm): void {
    if (t.tag === "constrained") {
      constraints.push(t.constraint);
      extract(t.term);
      return;
    }

    switch (t.tag) {
      case "match":
      case "replace":
      case "split":
      case "parseInt":
      case "parseFloat":
        extract(t.str);
        break;

      case "if":
        extract(t.cond);
        extract(t.then);
        extract(t.else);
        break;

      case "add":
        extract(t.left);
        extract(t.right);
        break;

      case "extract":
        extract(t.str);
        break;

      case "reduce":
        extract(t.collection);
        extract(t.init);
        extract(t.fn);
        break;

      case "filter":
        extract(t.collection);
        extract(t.predicate);
        break;

      case "map":
        extract(t.collection);
        extract(t.transform);
        break;

      case "app":
        extract(t.fn);
        extract(t.arg);
        break;

      case "lambda":
        extract(t.body);
        break;

      case "sum":
      case "count":
        extract(t.collection);
        break;

      case "parseCurrency":
      case "parseDate":
      case "parseNumber":
      case "predicate":
        extract(t.str);
        break;

      case "coerce":
        extract(t.term);
        break;

      case "apply-fn":
        extract(t.arg);
        break;

      case "get_symbol_body":
        extract(t.symbol);
        break;
    }
  }

  extract(term);
  return constraints;
}
