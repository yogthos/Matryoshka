/**
 * Language mapping for Tree-sitter
 *
 * Maps file extensions to languages and WASM grammar files.
 */

import type { SupportedLanguage, LanguageConfig } from "./types.js";

/**
 * Language configurations indexed by language name
 */
export const LANGUAGE_CONFIGS: Record<SupportedLanguage, LanguageConfig> = {
  typescript: {
    language: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    wasmFile: "tree-sitter-typescript.wasm",
  },
  javascript: {
    language: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    wasmFile: "tree-sitter-javascript.wasm",
  },
  python: {
    language: "python",
    extensions: [".py", ".pyw", ".pyi"],
    wasmFile: "tree-sitter-python.wasm",
  },
  go: {
    language: "go",
    extensions: [".go"],
    wasmFile: "tree-sitter-go.wasm",
  },
};

/**
 * Extension to language mapping for quick lookup
 */
const extensionToLanguage: Map<string, SupportedLanguage> = new Map();

// Build the extension map
for (const [lang, config] of Object.entries(LANGUAGE_CONFIGS)) {
  for (const ext of config.extensions) {
    extensionToLanguage.set(ext, lang as SupportedLanguage);
  }
}

/**
 * Get the language for a file extension
 * @param ext File extension (including dot, e.g., ".ts")
 */
export function getLanguageForExtension(ext: string): SupportedLanguage | null {
  return extensionToLanguage.get(ext.toLowerCase()) ?? null;
}

/**
 * Get the WASM file name for a language
 */
export function getWasmFile(language: SupportedLanguage): string {
  return LANGUAGE_CONFIGS[language].wasmFile;
}

/**
 * Check if an extension is supported
 */
export function isExtensionSupported(ext: string): boolean {
  return extensionToLanguage.has(ext.toLowerCase());
}

/**
 * Get all supported extensions
 */
export function getSupportedExtensions(): string[] {
  return [...extensionToLanguage.keys()];
}

/**
 * Get all supported languages
 */
export function getSupportedLanguages(): SupportedLanguage[] {
  return Object.keys(LANGUAGE_CONFIGS) as SupportedLanguage[];
}
