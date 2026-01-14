/**
 * Type definitions for Nucleus Lambda Calculus
 *
 * These types represent the LC terms that the LLM outputs.
 * They map directly to the evalo DSL for synthesis.
 */

/**
 * Nucleus constraint operators
 * [Σ⚡μ] - maximize information, minimize complexity
 * [∞/0] - handle edge cases (null checks)
 */
export type ConstraintOp = "Σ⚡μ" | "∞/0" | "ε⚡φ";

/**
 * LC Term - the abstract syntax tree for Lambda Calculus expressions
 */
export type LCTerm =
  | LCInput
  | LCLit
  | LCGrep
  | LCFuzzySearch
  | LCTextStats
  | LCFilter
  | LCMap
  | LCReduce
  | LCSum
  | LCCount
  | LCMatch
  | LCReplace
  | LCSplit
  | LCParseInt
  | LCParseFloat
  | LCAdd
  | LCIf
  | LCClassify
  | LCConstrained
  | LCVar
  | LCApp
  | LCLambda;

/**
 * (input) - reference to the current input string
 */
export interface LCInput {
  tag: "input";
}

/**
 * (lit <value>) - literal value
 */
export interface LCLit {
  tag: "lit";
  value: string | number | boolean;
}

/**
 * (grep <pattern>) - search document for pattern
 */
export interface LCGrep {
  tag: "grep";
  pattern: string;
}

/**
 * (fuzzy_search <query> <limit>) - fuzzy text search
 */
export interface LCFuzzySearch {
  tag: "fuzzy_search";
  query: string;
  limit?: number;
}

/**
 * (text_stats) - get document metadata
 */
export interface LCTextStats {
  tag: "text_stats";
}

/**
 * (filter <collection> <predicate>) - filter array by predicate
 */
export interface LCFilter {
  tag: "filter";
  collection: LCTerm;
  predicate: LCTerm;
}

/**
 * (map <collection> <transform>) - transform array elements
 */
export interface LCMap {
  tag: "map";
  collection: LCTerm;
  transform: LCTerm;
}

/**
 * (reduce <collection> <init> <fn>) - reduce array to single value
 */
export interface LCReduce {
  tag: "reduce";
  collection: LCTerm;
  init: LCTerm;
  fn: LCTerm; // (lambda (acc x) ...)
}

/**
 * (sum <collection>) - sum numeric values in array
 * Shorthand for reduce with addition
 */
export interface LCSum {
  tag: "sum";
  collection: LCTerm;
}

/**
 * (count <collection>) - count items in array
 */
export interface LCCount {
  tag: "count";
  collection: LCTerm;
}

/**
 * (add <left> <right>) - arithmetic addition
 */
export interface LCAdd {
  tag: "add";
  left: LCTerm;
  right: LCTerm;
}

/**
 * (match <term> <pattern> <group>) - regex match
 */
export interface LCMatch {
  tag: "match";
  str: LCTerm;
  pattern: string;
  group: number;
}

/**
 * (replace <term> <from> <to>) - string replacement
 */
export interface LCReplace {
  tag: "replace";
  str: LCTerm;
  from: string;
  to: string;
}

/**
 * (split <term> <delim> <index>) - split string and get part
 */
export interface LCSplit {
  tag: "split";
  str: LCTerm;
  delim: string;
  index: number;
}

/**
 * (parseInt <term>) - parse string as integer
 */
export interface LCParseInt {
  tag: "parseInt";
  str: LCTerm;
}

/**
 * (parseFloat <term>) - parse string as float
 */
export interface LCParseFloat {
  tag: "parseFloat";
  str: LCTerm;
}

/**
 * (if <cond> <then> <else>) - conditional
 */
export interface LCIf {
  tag: "if";
  cond: LCTerm;
  then: LCTerm;
  else: LCTerm;
}

/**
 * (classify <examples>...) - build classifier from examples
 * Examples are pairs of (input output)
 */
export interface LCClassify {
  tag: "classify";
  examples: Array<{ input: string; output: boolean | string | number }>;
}

/**
 * [Constraint] ⊗ <term> - apply constraint to term
 */
export interface LCConstrained {
  tag: "constrained";
  constraint: ConstraintOp;
  term: LCTerm;
}

/**
 * Variable reference
 */
export interface LCVar {
  tag: "var";
  name: string;
}

/**
 * Function application (f x)
 */
export interface LCApp {
  tag: "app";
  fn: LCTerm;
  arg: LCTerm;
}

/**
 * Lambda abstraction λx.body
 */
export interface LCLambda {
  tag: "lambda";
  param: string;
  body: LCTerm;
}

/**
 * Parse result
 */
export interface ParseResult {
  success: boolean;
  term?: LCTerm;
  error?: string;
  remaining?: string;
}

/**
 * Inferred type for a term
 */
export type LCType =
  | { tag: "string" }
  | { tag: "number" }
  | { tag: "boolean" }
  | { tag: "array"; element: LCType }
  | { tag: "function"; param: LCType; result: LCType }
  | { tag: "any" }
  | { tag: "void" };

/**
 * Type inference result
 */
export interface TypeResult {
  valid: boolean;
  type?: LCType;
  error?: string;
}
