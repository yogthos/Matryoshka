/**
 * Data Extraction DSL Types
 *
 * A small language for data extraction that is:
 * 1. Small enough to implement relationally (~10 forms)
 * 2. Expressive enough for data extraction (covers 95% of use cases)
 * 3. Compilable to efficient JavaScript
 * 4. Composable - complex extractors from simple parts
 */

/**
 * The core Extractor type - a small language for data extraction
 */
export type Extractor =
  // Base cases
  | { tag: "input" }                                    // raw input string
  | { tag: "lit"; value: string | number }              // literal value

  // String operations
  | { tag: "match"; str: Extractor; pattern: string; group: number }     // regex match
  | { tag: "replace"; str: Extractor; from: string; to: string }         // string replace
  | { tag: "slice"; str: Extractor; start: number; end: number }         // substring
  | { tag: "split"; str: Extractor; delim: string; index: number }       // split and index

  // Numeric operations
  | { tag: "parseInt"; str: Extractor }                 // parse as integer
  | { tag: "parseFloat"; str: Extractor }               // parse as float
  | { tag: "add"; left: Extractor; right: Extractor }   // addition

  // Conditional
  | { tag: "if"; cond: Extractor; then: Extractor; else: Extractor };    // conditional

/**
 * Types for early pruning during synthesis
 *
 * If we know the output must be a number, we can skip extractors
 * that only produce strings.
 */
export type Type = "string" | "number" | "boolean" | "null" | "unknown";

/**
 * An input/output example for synthesis
 */
export interface Example {
  input: string;
  output: string | number | boolean | null;
}

/**
 * Result of running an extractor
 */
export type Value = string | number | boolean | null;

/**
 * Helper to determine the type of a value
 */
export function typeOf(value: Value): Type {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "unknown";
}

/**
 * Check if an extractor is a "leaf" (no sub-extractors)
 */
export function isLeaf(e: Extractor): boolean {
  return e.tag === "input" || e.tag === "lit";
}

/**
 * Get the children of an extractor
 */
export function children(e: Extractor): Extractor[] {
  switch (e.tag) {
    case "input":
    case "lit":
      return [];
    case "match":
    case "replace":
    case "slice":
    case "split":
    case "parseInt":
    case "parseFloat":
      return [e.str];
    case "add":
      return [e.left, e.right];
    case "if":
      return [e.cond, e.then, e.else];
  }
}
