/**
 * ParserRegistry - Manages Tree-sitter parsers
 *
 * Handles initialization and lazy-loading of language grammars.
 * Uses native Node.js tree-sitter bindings for optimal performance.
 * Falls back to web-tree-sitter (WASM) for grammars that require it.
 * Supports both built-in and custom grammars from config.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { SupportedLanguage } from "./types.js";
import {
  getLanguageForExtension,
  getSupportedExtensions,
  getLanguageConfig,
  isLanguageAvailable,
  getAvailableLanguages,
} from "./language-map.js";

// Use createRequire for native tree-sitter bindings (CommonJS only)
const require = createRequire(import.meta.url);
const Parser = require("tree-sitter");

// Tree-sitter types (using any for dynamic loading)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterParser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterLanguage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeSitterTree = any;

// Lazy-loaded WASM parser components
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let WasmParserClass: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let WasmLanguageClass: any = null;

async function initWasm(): Promise<void> {
  if (!WasmParserClass) {
    const mod = require("web-tree-sitter");
    WasmLanguageClass = mod.Language;
    await mod.Parser.init();
    WasmParserClass = mod.Parser;
  }
}

/**
 * ParserRegistry manages Tree-sitter parsers
 */
export class ParserRegistry {
  // One parser instance per language, keyed by language name. Sharing a
  // single parser and calling `setLanguage` on every `parseDocument` works
  // today because JavaScript is single-threaded and the setLanguage+parse
  // pair is synchronous — but any future `await` inserted between them
  // would open a race where a concurrent call could overwrite the language
  // setting mid-parse. Per-language parsers eliminate the risk entirely
  // and avoid the setLanguage overhead on repeat calls.
  private parsers: Map<string, TreeSitterParser> = new Map();
  private wasmParsers: Map<string, TreeSitterParser> = new Map();
  private languages: Map<string, { lang: TreeSitterLanguage; wasm: boolean }> = new Map();
  private initialized: boolean = false;

  /**
   * Initialize the Tree-sitter parser
   */
  async init(): Promise<void> {
    if (this.initialized) return;

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
  private async loadLanguage(language: string): Promise<{ lang: TreeSitterLanguage; wasm: boolean }> {
    // Return cached language if available
    const cached = this.languages.get(language);
    if (cached) return cached;

    // Get language config
    const config = getLanguageConfig(language);
    if (!config) {
      throw new Error(`Unknown language: ${language}`);
    }

    // WASM path: load via web-tree-sitter for ESM/WASM grammars
    if (config.esm && config.wasmFile) {
      try {
        await initWasm();
        const pkgPath = require.resolve(`${config.package}/package.json`);
        const pkgDir = dirname(pkgPath);
        const wasmPath = resolve(pkgDir, config.wasmFile);
        const lang = await WasmLanguageClass.load(wasmPath);
        const entry = { lang, wasm: true };
        this.languages.set(language, entry);
        return entry;
      } catch (err) {
        throw new Error(
          `Grammar package '${config.package}' not installed or WASM file missing. ` +
            `Run: pnpm add ${config.package}`
        );
      }
    }

    // Native path: load via require() for CJS grammars
    let grammarModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      grammarModule = require(config.package);
    } catch (err) {
      throw new Error(
        `Grammar package '${config.package}' not installed. ` +
          `Run: pnpm add ${config.package}`
      );
    }

    if (!grammarModule || typeof grammarModule !== "object") {
      throw new Error(`Grammar package '${config.package}' loaded but module is invalid`);
    }

    // Extract the grammar (some modules export multiple languages)
    let lang: TreeSitterLanguage;
    const DANGEROUS_EXPORT_NAMES = new Set(["__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "hasOwnProperty", "toString", "valueOf", "toLocaleString", "isPrototypeOf", "propertyIsEnumerable"]);
    if (config.moduleExport) {
      // Guard against prototype pollution via moduleExport
      if (DANGEROUS_EXPORT_NAMES.has(config.moduleExport)) {
        throw new Error(`Unsafe module export name: '${config.moduleExport}'`);
      }
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
    const entry = { lang, wasm: false };
    this.languages.set(language, entry);
    return entry;
  }

  /**
   * Parse a document and return the syntax tree
   *
   * @param content Source code content
   * @param ext File extension (e.g., ".ts", ".py")
   * @returns Syntax tree or throws if extension not supported
   */
  private static readonly MAX_PARSE_CONTENT_LENGTH = 10_000_000; // 10MB

  async parseDocument(content: string, ext: string): Promise<TreeSitterTree | null> {
    if (!this.initialized) {
      throw new Error("ParserRegistry not initialized. Call init() first.");
    }

    // Limit content size to prevent memory exhaustion
    if (content.length > ParserRegistry.MAX_PARSE_CONTENT_LENGTH) {
      throw new Error(`Content too large to parse: ${content.length} chars exceeds limit of ${ParserRegistry.MAX_PARSE_CONTENT_LENGTH}`);
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
          `Run: pnpm add ${config?.package ?? `tree-sitter-${language}`}`
      );
    }

    // Load the language grammar
    const loaded = await this.loadLanguage(language);

    if (loaded.wasm) {
      // Use web-tree-sitter. One parser per language; created once, never
      // re-set, so no race between setLanguage and parse.
      await initWasm();
      let parser = this.wasmParsers.get(language);
      if (!parser) {
        parser = new WasmParserClass();
        parser.setLanguage(loaded.lang);
        this.wasmParsers.set(language, parser);
      }
      return parser.parse(content);
    }

    // Native tree-sitter. Same per-language pattern.
    let parser = this.parsers.get(language);
    if (!parser) {
      parser = new Parser();
      parser.setLanguage(loaded.lang);
      this.parsers.set(language, parser);
    }
    return parser.parse(content);
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
    this.parsers.clear();
    this.wasmParsers.clear();
    this.languages.clear();
    this.initialized = false;
  }
}
