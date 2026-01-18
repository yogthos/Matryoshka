/**
 * Tree-sitter integration for Lattice
 *
 * Provides code-aware operations like symbol extraction,
 * structural queries, and reference finding.
 *
 * Supports built-in grammars and custom grammars via ~/.matryoshka/config.json
 */

export * from "./types.js";
export * from "./language-map.js";
export * from "./builtin-grammars.js";
export { ParserRegistry } from "./parser-registry.js";
export { SymbolExtractor } from "./symbol-extractor.js";
