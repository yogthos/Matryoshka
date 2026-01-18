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
 * Built-in language identifiers (for type safety with original languages)
 * Additional languages can be loaded dynamically via config
 */
export type BuiltinLanguage = "typescript" | "javascript" | "python" | "go";

/**
 * Supported language - can be a built-in or dynamically loaded language
 */
export type SupportedLanguage = string;

/**
 * Language configuration for parsing
 */
export interface LanguageConfig {
  /** Language identifier */
  language: string;
  /** File extensions for this language */
  extensions: string[];
  /** npm package name */
  package: string;
  /** Optional: how to extract grammar from module */
  moduleExport?: string;
  /** AST node type to symbol kind mapping */
  symbols: Record<string, SymbolKind>;
}
