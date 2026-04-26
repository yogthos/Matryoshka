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
  | LCBm25
  | LCFuse
  | LCDampen
  | LCRerank
  | LCSemantic
  | LCTextStats
  | LCLines
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
  | LCParseDate
  | LCParseCurrency
  | LCParseNumber
  | LCCoerce
  | LCExtract
  | LCSynthesize
  | LCAdd
  | LCIf
  | LCClassify
  | LCConstrained
  | LCVar
  | LCApp
  | LCLambda
  | LCDefineFn
  | LCApplyFn
  | LCPredicate
  | LCListSymbols
  | LCGetSymbolBody
  | LCFindReferences
  | LCCallers
  | LCCallees
  | LCAncestors
  | LCDescendants
  | LCImplementations
  | LCDependents
  | LCSymbolGraph
  | LCCommunities
  | LCCommunityOf
  | LCGodNodes
  | LCSurprisingConnections
  | LCBridgeNodes
  | LCSuggestQuestions
  | LCGraphReport
  | LCLLMQuery
  | LCLLMBatch
  | LCRlmQuery
  | LCRlmBatch
  | LCContext
  | LCShowVars
  | LCChunkBySize
  | LCChunkByLines
  | LCChunkByRegex
  | LCSeq;

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
  value: string | number | boolean | null;
}

/**
 * (grep <pattern> [haystack]) - search a document for a pattern.
 *
 * The optional `haystack` is any term that evaluates to a string.
 * When supplied, grep operates over THAT string instead of the
 * default `tools.context`. Used to scope grep across multiple
 * loaded contexts via `(context N)` or to grep a binding directly:
 *
 *   (grep "ERROR" (context 1))   ; grep the second loaded doc
 *   (grep "X" $some_string)      ; grep a string binding
 *   (grep "ERROR")               ; back-compat — grep tools.context
 */
export interface LCGrep {
  tag: "grep";
  pattern: string;
  haystack?: LCTerm;
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
 * (bm25 <query> [<limit>]) - BM25 ranked text search
 * Returns array of {line, lineNum, score} ranked by BM25 relevance
 */
export interface LCBm25 {
  tag: "bm25";
  query: string;
  limit?: number;
}

/**
 * (fuse <coll1> <coll2> [<coll3> ...]) - fuse multiple result arrays using RRF
 * Combines results from different search operations (grep, bm25, fuzzy_search)
 * using score-weighted Reciprocal Rank Fusion
 */
export interface LCFuse {
  tag: "fuse";
  collections: LCTerm[];
}

/**
 * (dampen <collection> <query>) - apply gravity dampening to results
 * Halves score for results that lack overlap with query terms.
 * Catches false positives from fuzzy/BM25 scoring.
 */
export interface LCDampen {
  tag: "dampen";
  collection: LCTerm;
  query: string;
}

/**
 * (rerank <collection>) - rerank results using Q-value learning
 * Blends similarity scores with learned Q-values + UCB exploration bonus
 */
export interface LCRerank {
  tag: "rerank";
  collection: LCTerm;
}

/**
 * (semantic <query> [<limit>]) - TF-IDF cosine similarity search
 * Returns lines ranked by semantic similarity to query
 */
export interface LCSemantic {
  tag: "semantic";
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
 * (lines <start> <end>) - get lines from document
 * Returns the text content from line start to line end (1-indexed, inclusive)
 */
export interface LCLines {
  tag: "lines";
  start: number;
  end: number;
}

/**
 * (chunk_by_size N) - split the document context into chunks of N characters.
 * Returns an array of string slices, the last of which may be shorter than N.
 * Primary use: `(map (chunk_by_size 2000) (lambda c (llm_query ...)))` to
 * fire a sub-LLM call per chunk of a document too big for the root window.
 */
export interface LCChunkBySize {
  tag: "chunk_by_size";
  size: number;
}

/**
 * (chunk_by_lines N) - split the document context into chunks of N lines.
 * Returns an array of newline-joined slices. Trailing remainder (less than
 * N lines) becomes its own chunk. Primary use: chunk a log file / code file
 * into N-line slices before mapping per-chunk semantic work over them.
 */
export interface LCChunkByLines {
  tag: "chunk_by_lines";
  lineCount: number;
}

/**
 * (chunk_by_regex "pattern") - split the document context wherever `pattern`
 * matches. Returns an array of string slices with empty chunks dropped (so
 * adjacent delimiters don't produce `""` entries). Primary use: split on
 * paragraph breaks (`\n\n`), section headers, or explicit delimiters. The
 * pattern is validated via `validateRegex` before splitting.
 */
export interface LCChunkByRegex {
  tag: "chunk_by_regex";
  pattern: string;
}

/**
 * (seq <expr1> <expr2> ... <exprN>) - evaluate exprs in order, threading
 * solver bindings through. The result of each subexpr is bound to a
 * fresh `_seqN` slot (and to `RESULTS` if it's an array), making it
 * available to later subexprs. The whole `seq` evaluates to the value
 * of the LAST subexpr.
 *
 * Paper-conformance: lets the model emit a multi-step program in a
 * single turn — the paper's Algorithm 1 has each REPL turn run a full
 * code block, not one statement. Without this primitive, our
 * "ONE command per turn" forced 3-step strategies into 3 turns, which
 * is a major contributor to the timeout problem on large docs.
 *
 * Example:
 *   (seq (grep "ERROR")
 *        (filter RESULTS (lambda x (match x "timeout" 0)))
 *        (count RESULTS))
 *
 * Empty seq is rejected by the parser (a no-op seq is meaningless).
 */
export interface LCSeq {
  tag: "seq";
  exprs: LCTerm[];
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
 * (parseDate <term> [format]) - parse string as date
 * Format hints: "ISO", "US", "EU", "auto" (default)
 * Returns ISO date string (YYYY-MM-DD) or null
 * With :examples, synthesis fallback will be used if parsing fails
 */
export interface LCParseDate {
  tag: "parseDate";
  str: LCTerm;
  format?: string;
  examples?: SynthesisExample[];
}

/**
 * Example pair for synthesis
 */
export interface SynthesisExample {
  input: string;
  output: unknown;
}

/**
 * (parseCurrency <term>) - parse currency string
 * Handles: $1,234.56, €1.234,56, 1,234, etc.
 * Returns number or null
 * With :examples, synthesis fallback will be used if parsing fails
 */
export interface LCParseCurrency {
  tag: "parseCurrency";
  str: LCTerm;
  examples?: SynthesisExample[];
}

/**
 * (parseNumber <term>) - parse number with various formats
 * Handles: 1,234.56, 1.234,56 (EU), percentages, etc.
 * Returns number or null
 * With :examples, synthesis fallback will be used if parsing fails
 */
export interface LCParseNumber {
  tag: "parseNumber";
  str: LCTerm;
  examples?: SynthesisExample[];
}

/**
 * Supported coercion types
 */
export type CoercionType = "date" | "currency" | "number" | "percent" | "boolean" | "string";

/**
 * (coerce <term> <type>) - coerce value to specified type
 * General type coercion hint
 */
export interface LCCoerce {
  tag: "coerce";
  term: LCTerm;
  targetType: CoercionType;
}

/**
 * (extract <term> <pattern> [type]) - extract and optionally coerce
 * Combines match + coerce in one operation
 * With :examples, synthesis fallback will be used if extraction fails
 */
export interface LCExtract {
  tag: "extract";
  str: LCTerm;
  pattern: string;
  group: number;
  targetType?: CoercionType;
  examples?: SynthesisExample[];
  constraints?: Record<string, unknown>;
}

/**
 * (synthesize <examples>) - synthesize function from input/output examples
 * Barliman-style program synthesis using miniKanren
 */
export interface LCSynthesize {
  tag: "synthesize";
  examples: Array<{ input: string; output: string | number | boolean | null }>;
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
 * (define-fn <name> :examples [...]) - define a named synthesized function
 */
export interface LCDefineFn {
  tag: "define-fn";
  name: string;
  examples: SynthesisExample[];
}

/**
 * (apply-fn <name> <arg>) - apply a named synthesized function
 */
export interface LCApplyFn {
  tag: "apply-fn";
  name: string;
  arg: LCTerm;
}

/**
 * (predicate <term> :examples [...]) - synthesize a predicate function
 */
export interface LCPredicate {
  tag: "predicate";
  str: LCTerm;
  examples?: SynthesisExample[];
}

/**
 * (list_symbols [kind]) - list symbols from tree-sitter AST
 * Optionally filter by kind: "function", "class", "method", "interface", etc.
 */
export interface LCListSymbols {
  tag: "list_symbols";
  kind?: string;
}

/**
 * (get_symbol_body <symbol>) - get the source code body for a symbol
 * Symbol can be a name string or a symbol object from list_symbols
 */
export interface LCGetSymbolBody {
  tag: "get_symbol_body";
  symbol: LCTerm;
}

/**
 * (find_references <name>) - find all references to an identifier
 * Returns array of lines containing references
 */
export interface LCFindReferences {
  tag: "find_references";
  name: string;
}

/**
 * (callers "name") - find all symbols that call this symbol
 */
export interface LCCallers {
  tag: "callers";
  name: string;
}

/**
 * (callees "name") - find all symbols that this symbol calls
 */
export interface LCCallees {
  tag: "callees";
  name: string;
}

/**
 * (ancestors "name") - transitive inheritance chain (extends)
 */
export interface LCAncestors {
  tag: "ancestors";
  name: string;
}

/**
 * (descendants "name") - all types that extend this type (transitive)
 */
export interface LCDescendants {
  tag: "descendants";
  name: string;
}

/**
 * (implementations "name") - all classes implementing this interface
 */
export interface LCImplementations {
  tag: "implementations";
  name: string;
}

/**
 * (dependents "name" [depth]) - all transitive dependents of a symbol
 */
export interface LCDependents {
  tag: "dependents";
  name: string;
  depth?: number;
}

/**
 * (symbol_graph "name" [depth]) - neighborhood subgraph around a symbol
 */
export interface LCSymbolGraph {
  tag: "symbol_graph";
  name: string;
  depth?: number;
}


/**
 * (communities) - detect communities with cohesion scores
 */
export interface LCCommunities {
  tag: "communities";
}

/**
 * (community_of "name") - get community for a specific node
 */
export interface LCCommunityOf {
  tag: "community_of";
  name: string;
}

/**
 * (god_nodes [topN]) - top-N highest-degree nodes
 */
export interface LCGodNodes {
  tag: "god_nodes";
  topN?: number;
}

/**
 * (surprising_connections [topN]) - cross-community/inferred edges
 */
export interface LCSurprisingConnections {
  tag: "surprising_connections";
  topN?: number;
}

/**
 * (bridge_nodes [topN]) - nodes bridging communities
 */
export interface LCBridgeNodes {
  tag: "bridge_nodes";
  topN?: number;
}

/**
 * (suggest_questions) - questions the graph can answer
 */
export interface LCSuggestQuestions {
  tag: "suggest_questions";
}

/**
 * (graph_report) - full analysis report
 */
export interface LCGraphReport {
  tag: "graph_report";
}

/**
 * (llm_query "prompt" [(name binding) ...]) — symbolic recursion primitive
 *
 * Invokes a sub-LLM with a literal prompt string. The prompt may contain
 * `{name}` placeholders, each of which is filled by a named binding
 * argument. The result is a string bound to the next auto-sequenced `_N`.
 *
 * Top-level only in the POC — nested use inside `map`/`filter`/etc.
 * throws an error. Full nested support requires making `solve()` async.
 *
 * Examples:
 *   (llm_query "Summarize in one sentence.")
 *   (llm_query "Classify each: {errors}" (errors _1))
 *   (llm_query "Apply {rules} to {data}" (rules _1) (data _2))
 */
export interface LCLLMQuery {
  tag: "llm_query";
  prompt: string;
  /** Named bindings that fill `{name}` placeholders in the prompt. */
  bindings: Array<{ name: string; value: LCTerm }>;
  /**
   * Optional enum constraint from a `(one_of "v1" "v2" …)` trailing
   * form. When present, the solver augments the prompt with a
   * directive naming the allowed set, validates the response against
   * the list case-insensitively, canonicalizes matches to the
   * declared spelling, and fails the query if the response is not in
   * the set. This turns free-text LLM output into a validated token
   * that downstream `(filter …)` / `(count …)` can rely on.
   */
  oneOf?: string[];
  /**
   * Optional `(calibrate)` marker. Meaningful only inside `llm_batch`
   * — at the llm_query level it parses harmlessly so that the exact
   * same `(lambda x (llm_query … (calibrate)))` shape works in both
   * contexts without special casing. When set, the llm_batch solver
   * forwards a `calibrate: true` flag to `tools.llmBatch`, which the
   * MCP bridge uses to prepend a calibration directive to the
   * batched suspension request.
   */
  calibrate?: boolean;
}

/**
 * (llm_batch COLLECTION (lambda x (llm_query "prompt" [(name bind) ...])))
 *   — batched suspension variant of `(llm_query …)`.
 *
 * The plain `(map COLL (lambda x (llm_query …)))` pattern fires one
 * suspension per item — N serial round-trips of protocol overhead. For
 * independent per-item judgment tasks (tag, rate, classify) that N-times
 * overhead is pure waste: a single round-trip carrying all N prompts is
 * sufficient.
 *
 * `llm_batch` keeps the same surface syntax as map + llm_query so that a
 * user can drop-in replace `map` with `llm_batch` when the lambda body is
 * directly an `llm_query`. The solver statically extracts the prompt
 * template and its bindings from the llm_query, evaluates the template
 * once per item in the collection (substituting the lambda param on each
 * iteration), collects the N interpolated prompts into an array, and
 * dispatches them through `tools.llmBatch` in one call. The returned
 * array is bound to the next `_N` just like any other collection result.
 *
 * Example:
 *   (llm_batch RESULTS
 *     (lambda x
 *       (llm_query "Rate complexity: {name}\n{body}"
 *                  (name x)
 *                  (body (get_symbol_body x)))))
 */
export interface LCLLMBatch {
  tag: "llm_batch";
  /** The collection to iterate — any term that evaluates to an array. */
  collection: LCTerm;
  /** The lambda parameter name bound to each item in turn. */
  param: string;
  /** The prompt template from the wrapped (llm_query …). */
  prompt: string;
  /**
   * Named bindings that fill `{name}` placeholders in the prompt. Each
   * binding's value term is evaluated with the lambda param bound to the
   * current item before interpolation.
   */
  bindings: Array<{ name: string; value: LCTerm }>;
  /**
   * Optional enum constraint lifted from the wrapped `(llm_query …)`'s
   * `(one_of …)` form. Validated per-item after the batch returns —
   * any invalid item fails the whole batch with a specific error
   * naming the offending index.
   */
  oneOf?: string[];
  /**
   * Optional `(calibrate)` marker lifted from the wrapped
   * `(llm_query …)`. When true, the solver forwards a
   * `calibrate: true` options flag to `tools.llmBatch`, letting the
   * bridge prepend a calibration directive to the batched suspension
   * request so the model scans the whole distribution before
   * committing to per-item ratings.
   */
  calibrate?: boolean;
}

/**
 * (rlm_query "prompt" [(context EXPR)]) — Phase 1 recursive primitive.
 *
 * Spawns a CHILD Nucleus FSM session. The child runs its own loop —
 * emitting Nucleus terms, executing them, accumulating bindings —
 * until it produces a FINAL answer. That FINAL string becomes the
 * bound value of this term in the parent.
 *
 * The optional `(context EXPR)` form supplies the child's working
 * document. EXPR is evaluated against the parent's bindings; if the
 * value is an array, items are stringified and joined by newlines so
 * the child's `(grep …)` / `(lines …)` / `(chunk_by_lines …)`
 * primitives operate on a clean line-oriented document. If the value
 * is a string, it is used as-is. If `(context …)` is omitted, the
 * child's document is the prompt itself (matching the existing
 * `subRLMSpawner` semantics for backwards compat).
 *
 * Differs from `(llm_query …)`:
 *   - llm_query interpolates bindings into the prompt; the result is
 *     a FLAT sub-LLM call (or, when subRLMMaxDepth > 0, a recursive
 *     child whose document IS the interpolated prompt).
 *   - rlm_query separates the child's QUERY (the prompt) from the
 *     child's WORKING DOCUMENT (the resolved context). The child can
 *     run document-level primitives over a structured handle without
 *     the JSON-stringification noise the llm_query path imposes.
 */
export interface LCRlmQuery {
  tag: "rlm_query";
  /** Query string handed to the child as its top-level user message. */
  prompt: string;
  /**
   * Optional context expression. Evaluated by the solver; the result
   * is materialized into a line-oriented string and used as the
   * child's working document. Omitted when the prompt itself is the
   * complete instruction.
   */
  context?: LCTerm;
}

/**
 * (rlm_batch COLL (lambda x (rlm_query "prompt" [(context EXPR)])))
 *   — Phase 2 concurrent variant of `(rlm_query …)`.
 *
 * Drop-in replacement for `(map COLL (lambda x (rlm_query …)))`. The
 * solver evaluates the collection, fans the per-item child sessions
 * out via `tools.rlmBatch` in ONE call carrying all N items, and
 * returns the array of N child responses in input order.
 *
 * Same lambda-of-direct-rlm_query restriction as LCLLMBatch: the
 * solver must statically extract the inner rlm_query's prompt and
 * context expression at parse time, so wrapping the rlm_query in
 * another form (e.g. `(if cond (rlm_query …) "default")`) is not
 * batchable.
 */
export interface LCRlmBatch {
  tag: "rlm_batch";
  /** The collection — any term that evaluates to an array. */
  collection: LCTerm;
  /** Lambda parameter name bound to each item in turn. */
  param: string;
  /**
   * The inner rlm_query's prompt template. Constant across items
   * for now (rlm_query has no per-item placeholder interpolation).
   * Could become a templated string in a future phase.
   */
  prompt: string;
  /**
   * The inner rlm_query's optional `(context EXPR)` clause. Each
   * item evaluates this expression with the lambda parameter bound
   * to the current item before materialization.
   */
  context?: LCTerm;
}

/**
 * (context N) — Phase 3 multi-context selector.
 *
 * Returns the Nth loaded context's content as a string. Contexts are
 * loaded by `runRLMFromContent` (or its callers) and exposed via
 * `SolverTools.contexts`. Index 0 is the default context for
 * primitives that don't specify a haystack — back-compat for
 * single-doc workflows. When `contexts` is undefined, `(context 0)`
 * falls back to `tools.context` so single-doc consumers don't need
 * to wire the new field.
 *
 * Usage patterns:
 *   (grep "ERROR" (context 1))         — grep the second loaded doc
 *   (rlm_query "scan" (context (context 2)))  — pass doc 2 as child doc
 */
export interface LCContext {
  tag: "context";
  /** Zero-based index into the loaded contexts array. */
  index: number;
}

/**
 * (show_vars) — Phase 4 binding-introspection term.
 *
 * Returns a string summarizing every binding currently in scope:
 * one entry per name with a shape descriptor (Array(N), String(N),
 * Number(v), Boolean(v), object). Lets a query inspect what's
 * available without a separate tool call. The Python RLM's
 * `SHOW_VARS()` helper is the spiritual cousin.
 *
 * Returns "No bindings" (or similar) when the map is empty.
 */
export interface LCShowVars {
  tag: "show_vars";
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
  | { tag: "date" }
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
