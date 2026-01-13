/**
 * Type Inference for the Data Extraction DSL
 *
 * typeo infers the output type of an extractor WITHOUT running it.
 * This enables early pruning during synthesis:
 * - If output must be number, skip string-only extractors
 * - If output must be string, skip numeric extractors
 *
 * This is one of Barliman's "superpowers" - we can reject
 * impossible candidates without executing them.
 */

import type { Extractor, Type } from "./types.js";

/**
 * Infer the output type of an extractor
 *
 * This is a static analysis - we don't run the extractor,
 * we just analyze its structure to determine what type it produces.
 */
export function inferType(extractor: Extractor): Type {
  switch (extractor.tag) {
    case "input":
      // Input is always a string
      return "string";

    case "lit":
      // Literal has the type of its value
      if (typeof extractor.value === "string") return "string";
      if (typeof extractor.value === "number") return "number";
      return "unknown";

    case "match":
      // Match returns a string (or null on no match, but primary type is string)
      return "string";

    case "replace":
      // Replace returns a string
      return "string";

    case "slice":
      // Slice returns a string
      return "string";

    case "split":
      // Split returns a string
      return "string";

    case "parseInt":
      // parseInt returns a number
      return "number";

    case "parseFloat":
      // parseFloat returns a number
      return "number";

    case "add":
      // Add returns a number
      return "number";

    case "if": {
      // If returns the common type of both branches
      const thenType = inferType(extractor.then);
      const elseType = inferType(extractor.else);

      if (thenType === elseType) {
        return thenType;
      }
      // Different types - return unknown
      return "unknown";
    }
  }
}

/**
 * Check if an extractor CAN produce a given type
 *
 * This is used during synthesis to prune candidates:
 * - If we need a number, skip extractors that only produce strings
 * - This is a key optimization for synthesis speed
 */
export function canProduceType(extractor: Extractor, targetType: Type): boolean {
  // Unknown always matches (conservative)
  if (targetType === "unknown") {
    return true;
  }

  const extractorType = inferType(extractor);

  // Direct match
  if (extractorType === targetType) {
    return true;
  }

  // Unknown extractor type can produce anything (conservative)
  if (extractorType === "unknown") {
    return true;
  }

  // Special case: extractors that return string/number can also return null
  // (e.g., match returns null on no match)
  if (targetType === "null") {
    // Operations that can return null:
    // - match (no match)
    // - split (index out of bounds)
    switch (extractor.tag) {
      case "match":
      case "split":
        return true;
      default:
        return false;
    }
  }

  // No match
  return false;
}

/**
 * Get all possible types an extractor can produce
 *
 * Some extractors can produce multiple types:
 * - match: string | null
 * - split: string | null
 */
export function possibleTypes(extractor: Extractor): Type[] {
  const primary = inferType(extractor);
  const types: Type[] = [primary];

  // Add null for operations that can fail
  switch (extractor.tag) {
    case "match":
    case "split":
      if (!types.includes("null")) {
        types.push("null");
      }
      break;
  }

  return types;
}

/**
 * Filter extractors by output type
 *
 * Used during synthesis to prune candidates that can't produce
 * the required output type.
 */
export function filterByType(
  extractors: Extractor[],
  targetType: Type
): Extractor[] {
  return extractors.filter(e => canProduceType(e, targetType));
}

/**
 * Determine the type of a value
 */
export function typeOfValue(value: unknown): Type {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "unknown";
}
