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

  function resolve(t: LCTerm): LCTerm {
    // Handle constrained terms
    if (t.tag === "constrained") {
      const resolved = applyConstraint(t.constraint, resolve(t.term));
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
        return { ...t, str: resolve(t.str) };

      case "replace":
        return { ...t, str: resolve(t.str) };

      case "split":
        return { ...t, str: resolve(t.str) };

      case "parseInt":
        return { ...t, str: resolve(t.str) };

      case "parseFloat":
        return { ...t, str: resolve(t.str) };

      case "if":
        return {
          ...t,
          cond: resolve(t.cond),
          then: resolve(t.then),
          else: resolve(t.else),
        };

      case "classify":
        return t;

      case "app":
        return { ...t, fn: resolve(t.fn), arg: resolve(t.arg) };

      case "lambda":
        return { ...t, body: resolve(t.body) };

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
      // These can return null, wrap in conditional
      return {
        tag: "if",
        cond: term,
        then: term,
        else: { tag: "lit", value: null as unknown as string },
      };

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

    case "app":
      return hasConstraints(term.fn) || hasConstraints(term.arg);

    case "lambda":
      return hasConstraints(term.body);

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

      case "app":
        extract(t.fn);
        extract(t.arg);
        break;

      case "lambda":
        extract(t.body);
        break;
    }
  }

  extract(term);
  return constraints;
}
