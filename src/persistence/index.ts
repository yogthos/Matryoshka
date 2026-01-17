/**
 * Handle-based SQLite persistence module
 *
 * Provides 97%+ token savings by storing data in SQLite
 * and passing only handle references to the LLM.
 */

export { SessionDB } from "./session-db.js";
export type { DocumentLine, HandleMetadata } from "./session-db.js";

export { HandleRegistry } from "./handle-registry.js";
export type { HandleStub } from "./handle-registry.js";

export { HandleOps } from "./handle-ops.js";
export type { DescribeResult } from "./handle-ops.js";

export { PredicateCompiler } from "./predicate-compiler.js";
export type { PredicateFn, TransformFn } from "./predicate-compiler.js";

export { FTS5Search } from "./fts5-search.js";
export type { SearchResult, HighlightResult, SnippetResult, HighlightOptions } from "./fts5-search.js";

export { CheckpointManager } from "./checkpoint.js";
export type { CheckpointMetadata } from "./checkpoint.js";
