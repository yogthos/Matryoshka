/**
 * ParserRegistry - Manages Tree-sitter parsers
 *
 * Handles initialization and lazy-loading of language grammars.
 * Uses native Node.js tree-sitter bindings for optimal performance.
 */

import type { SupportedLanguage } from "./types.js";
import { getLanguageForExtension, getSupportedExtensions } from "./language-map.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Parser = require("tree-sitter");

/**
 * Language grammar modules (lazy-loaded)
 */
const GRAMMAR_MODULES: Record<SupportedLanguage, string> = {
  typescript: "tree-sitter-typescript",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
  go: "tree-sitter-go",
};

// Tree-sitter types (using any for dynamic loading)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterParser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterLanguage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterTree = any;

/**
 * ParserRegistry manages Tree-sitter parsers
 */
export class ParserRegistry {
  private parser: TreeSitterParser | null = null;
  private languages: Map<SupportedLanguage, TreeSitterLanguage> = new Map();
  private initialized: boolean = false;

  /**
   * Initialize the Tree-sitter parser
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.parser = new Parser();
    this.initialized = true;
  }

  /**
   * Check if the registry has been initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get supported file extensions
   */
  getSupportedExtensions(): string[] {
    return getSupportedExtensions();
  }

  /**
   * Load a language grammar (lazy-loaded on first use)
   */
  private loadLanguage(language: SupportedLanguage): TreeSitterLanguage {
    // Return cached language if available
    const cached = this.languages.get(language);
    if (cached) return cached;

    // Load the grammar module
    const moduleName = GRAMMAR_MODULES[language];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const grammarModule = require(moduleName);

    // TypeScript module exports both typescript and tsx
    // JavaScript module exports both javascript and jsx
    let lang: TreeSitterLanguage;
    if (language === "typescript") {
      lang = grammarModule.typescript;
    } else if (language === "javascript") {
      lang = grammarModule;
    } else {
      lang = grammarModule;
    }

    // Cache the language
    this.languages.set(language, lang);
    return lang;
  }

  /**
   * Parse a document and return the syntax tree
   *
   * @param content Source code content
   * @param ext File extension (e.g., ".ts", ".py")
   * @returns Syntax tree or throws if extension not supported
   */
  async parseDocument(content: string, ext: string): Promise<TreeSitterTree | null> {
    if (!this.initialized || !this.parser) {
      throw new Error("ParserRegistry not initialized. Call init() first.");
    }

    // Get language for extension
    const language = getLanguageForExtension(ext);
    if (!language) {
      throw new Error(`Unsupported extension: ${ext}`);
    }

    // Load the language grammar
    const lang = this.loadLanguage(language);

    // Set the parser language and parse
    this.parser.setLanguage(lang);
    return this.parser.parse(content);
  }

  /**
   * Parse document and return tree with language info
   */
  async parseWithLanguage(
    content: string,
    ext: string
  ): Promise<{ tree: TreeSitterTree; language: SupportedLanguage } | null> {
    const language = getLanguageForExtension(ext);
    if (!language) {
      return null;
    }

    const tree = await this.parseDocument(content, ext);
    if (!tree) return null;

    return { tree, language };
  }

  /**
   * Check if a language is loaded
   */
  isLanguageLoaded(language: SupportedLanguage): boolean {
    return this.languages.has(language);
  }

  /**
   * Get list of currently loaded languages
   */
  getLoadedLanguages(): SupportedLanguage[] {
    return [...this.languages.keys()];
  }

  /**
   * Dispose of all resources
   */
  dispose(): void {
    this.parser = null;
    this.languages.clear();
    this.initialized = false;
  }
}
