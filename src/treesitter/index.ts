/**
 * Tree-sitter integration for Lattice
 *
 * Provides code-aware operations like symbol extraction,
 * structural queries, and reference finding.
 */

export * from "./types.js";
export * from "./language-map.js";
export { ParserRegistry } from "./parser-registry.js";
export { SymbolExtractor } from "./symbol-extractor.js";
