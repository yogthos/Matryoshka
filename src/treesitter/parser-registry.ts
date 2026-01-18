/**
 * ParserRegistry - Manages Tree-sitter parsers
 *
 * Handles initialization and lazy-loading of language grammars.
 * Uses native Node.js tree-sitter bindings for optimal performance.
 * Supports both built-in and custom grammars from config.
 */

import type { SupportedLanguage } from "./types.js";
import {
  getLanguageForExtension,
  getSupportedExtensions,
  getLanguageConfig,
  isLanguageAvailable,
  getAvailableLanguages,
} from "./language-map.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Parser = require("tree-sitter");

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
  private languages: Map<string, TreeSitterLanguage> = new Map();
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
   * Get available languages (with packages installed)
   */
  getAvailableLanguages(): string[] {
    return getAvailableLanguages();
  }

  /**
   * Check if a language is available
   */
  isLanguageAvailable(language: string): boolean {
    return isLanguageAvailable(language);
  }

  /**
   * Load a language grammar (lazy-loaded on first use)
   */
  private loadLanguage(language: string): TreeSitterLanguage {
    // Return cached language if available
    const cached = this.languages.get(language);
    if (cached) return cached;

    // Get language config
    const config = getLanguageConfig(language);
    if (!config) {
      throw new Error(`Unknown language: ${language}`);
    }

    // Load the grammar module
    let grammarModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      grammarModule = require(config.package);
    } catch (err) {
      throw new Error(
        `Grammar package '${config.package}' not installed. ` +
          `Run: npm install ${config.package}`
      );
    }

    // Extract the grammar (some modules export multiple languages)
    let lang: TreeSitterLanguage;
    if (config.moduleExport) {
      // Use specific export (e.g., "typescript" from tree-sitter-typescript)
      lang = grammarModule[config.moduleExport];
      if (!lang) {
        throw new Error(
          `Module '${config.package}' does not export '${config.moduleExport}'`
        );
      }
    } else {
      // Use default export
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

    // Check if package is installed
    if (!isLanguageAvailable(language)) {
      const config = getLanguageConfig(language);
      throw new Error(
        `Grammar for '${language}' not available. ` +
          `Run: npm install ${config?.package ?? `tree-sitter-${language}`}`
      );
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

    // Check if package is available
    if (!isLanguageAvailable(language)) {
      return null;
    }

    const tree = await this.parseDocument(content, ext);
    if (!tree) return null;

    return { tree, language };
  }

  /**
   * Check if a language is loaded
   */
  isLanguageLoaded(language: string): boolean {
    return this.languages.has(language);
  }

  /**
   * Get list of currently loaded languages
   */
  getLoadedLanguages(): string[] {
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
