/**
 * Type definitions for Tree-sitter symbol extraction
 */

/**
 * Types of symbols that can be extracted from code
 */
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "struct"
  | "variable"
  | "constant"
  | "property"
  | "enum"
  | "module"
  | "namespace";

/**
 * Represents a symbol extracted from source code
 */
export interface Symbol {
  /** Symbol name */
  name: string;
  /** Type of symbol */
  kind: SymbolKind;
  /** Start line (1-indexed) */
  startLine: number;
  /** End line (1-indexed) */
  endLine: number;
  /** Start column (0-indexed) */
  startCol: number;
  /** End column (0-indexed) */
  endCol: number;
  /** Function/method signature if applicable */
  signature?: string;
  /** Database ID if stored */
  id?: number;
  /** Parent symbol ID for nested symbols */
  parentSymbolId?: number | null;
}

/**
 * Result from symbol extraction
 */
export interface ExtractionResult {
  success: boolean;
  symbols: Symbol[];
  error?: string;
}

/**
 * Supported programming languages
 */
export type SupportedLanguage = "typescript" | "javascript" | "python" | "go";

/**
 * Language configuration for parsing
 */
export interface LanguageConfig {
  /** Language identifier */
  language: SupportedLanguage;
  /** File extensions for this language */
  extensions: string[];
  /** WASM grammar file name */
  wasmFile: string;
}
