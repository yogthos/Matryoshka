/**
 * HandleSession - Handle-based document analysis session
 *
 * Wraps NucleusEngine with handle-based persistence for 97%+ token savings.
 * Query results are stored in SQLite and only handle stubs are returned to the LLM.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { NucleusEngine } from "./nucleus-engine.js";
import { SessionDB } from "../persistence/session-db.js";
import { HandleRegistry } from "../persistence/handle-registry.js";
import { HandleOps } from "../persistence/handle-ops.js";
import { ParserRegistry } from "../treesitter/parser-registry.js";
import { SymbolExtractor } from "../treesitter/symbol-extractor.js";
import { isExtensionSupported } from "../treesitter/language-map.js";

/**
 * Result of a handle-based query execution
 */
export interface HandleResult {
  success: boolean;
  /** Handle reference (e.g., "$res1") if result is an array */
  handle?: string;
  /** Handle stub for LLM context (e.g., "$res1: Array(1000) [preview...]") */
  stub?: string;
  /** Scalar value if result is not an array */
  value?: unknown;
  /** Execution logs */
  logs: string[];
  /** Error message if failed */
  error?: string;
  /** Inferred type */
  type?: string;
}

/**
 * Options for expanding a handle
 */
export interface ExpandOptions {
  /** Maximum number of items to return (default: all) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Format: 'full' returns all fields, 'lines' returns just line content */
  format?: "full" | "lines";
}

/**
 * Result of expanding a handle
 */
export interface ExpandResult {
  success: boolean;
  data?: unknown[];
  total?: number;
  offset?: number;
  limit?: number;
  error?: string;
}

/**
 * HandleSession - combines NucleusEngine with handle-based storage
 */
export class HandleSession {
  private engine: NucleusEngine;
  private db: SessionDB;
  private registry: HandleRegistry;
  private ops: HandleOps;
  private parserRegistry: ParserRegistry;
  private symbolExtractor: SymbolExtractor;
  private parserInitialized: boolean = false;
  private documentPath: string = "";
  private documentSize: number = 0;
  private loadedAt: Date | null = null;
  private lastAccessedAt: Date | null = null;
  private queryCount: number = 0;

  constructor() {
    this.engine = new NucleusEngine();
    this.db = new SessionDB();
    this.registry = new HandleRegistry(this.db);
    this.ops = new HandleOps(this.db, this.registry);
    this.parserRegistry = new ParserRegistry();
    this.symbolExtractor = new SymbolExtractor(this.parserRegistry);
  }

  /**
   * Initialize the parser registry (call before loading code files)
   * This is called automatically by loadContent but can be called early
   * to avoid initialization delay on first code file load.
   */
  async init(): Promise<void> {
    if (!this.parserInitialized) {
      await this.parserRegistry.init();
      this.parserInitialized = true;
    }
  }

  /**
   * Load a document from file
   * Automatically extracts symbols for supported code files
   */
  async loadFile(filePath: string): Promise<{ lineCount: number; size: number }> {
    const content = await readFile(filePath, "utf-8");
    return this.loadContentWithSymbols(content, filePath);
  }

  /**
   * Load a document from string content
   * Automatically extracts symbols for supported code files
   */
  loadContent(content: string, path: string = "<string>"): { lineCount: number; size: number } {
    // Load into NucleusEngine for query execution
    this.engine.loadContent(content);

    // Also load into SessionDB for FTS5 search and handle storage
    const lineCount = this.db.loadDocument(content);

    // Clear any existing symbols before loading new content
    this.db.clearSymbols();

    // Extract symbols for code files (async, but we fire and forget for sync API)
    const ext = extname(path);
    if (ext && isExtensionSupported(ext)) {
      this.extractSymbolsAsync(content, ext);
    }

    // Set SessionDB binding for solver access
    this.engine.setBinding("_sessionDB", this.db);

    this.documentPath = path;
    this.documentSize = content.length;
    this.loadedAt = new Date();
    this.lastAccessedAt = new Date();
    this.queryCount = 0;

    return { lineCount, size: content.length };
  }

  /**
   * Load a document and wait for symbol extraction to complete
   * Use this when you need to query symbols immediately after loading
   */
  async loadContentWithSymbols(content: string, path: string = "<string>"): Promise<{ lineCount: number; size: number }> {
    // Load into NucleusEngine for query execution
    this.engine.loadContent(content);

    // Also load into SessionDB for FTS5 search and handle storage
    const lineCount = this.db.loadDocument(content);

    // Clear any existing symbols before loading new content
    this.db.clearSymbols();

    // Extract symbols for code files
    const ext = extname(path);
    if (ext && isExtensionSupported(ext)) {
      await this.init();
      await this.extractAndStoreSymbols(content, ext);
    }

    // Set SessionDB binding for solver access
    this.engine.setBinding("_sessionDB", this.db);

    this.documentPath = path;
    this.documentSize = content.length;
    this.loadedAt = new Date();
    this.lastAccessedAt = new Date();
    this.queryCount = 0;

    return { lineCount, size: content.length };
  }

  /**
   * Extract and store symbols (async, fire-and-forget for sync load)
   */
  private extractSymbolsAsync(content: string, ext: string): void {
    this.init()
      .then(() => this.extractAndStoreSymbols(content, ext))
      .catch(() => {
        // Silently ignore errors - symbols just won't be available
      });
  }

  /**
   * Extract symbols and store them in the database
   */
  private async extractAndStoreSymbols(content: string, ext: string): Promise<void> {
    const symbols = await this.symbolExtractor.extractSymbols(content, ext);
    for (const symbol of symbols) {
      this.db.storeSymbol(symbol);
    }
  }

  /**
   * Check if a document is loaded
   */
  isLoaded(): boolean {
    return this.engine.isLoaded();
  }

  /**
   * Get document statistics
   */
  getStats(): { path: string; lineCount: number; size: number; loadedAt: Date | null } | null {
    const engineStats = this.engine.getStats();
    if (!engineStats) return null;

    return {
      path: this.documentPath,
      lineCount: engineStats.lineCount,
      size: this.documentSize,
      loadedAt: this.loadedAt,
    };
  }

  /**
   * Execute a Nucleus query and return handle-based result
   *
   * Arrays are stored in SQLite and a handle stub is returned.
   * Scalars are returned directly.
   */
  execute(command: string): HandleResult {
    this.lastAccessedAt = new Date();
    this.queryCount++;

    // Execute via NucleusEngine
    const result = this.engine.execute(command);

    if (!result.success) {
      return {
        success: false,
        logs: result.logs,
        error: result.error,
        type: result.type,
      };
    }

    // If result is an array, store in handle registry
    if (Array.isArray(result.value)) {
      const handle = this.registry.store(result.value);
      this.registry.setResults(handle);

      // Get the stub for LLM context
      const stub = this.registry.getStub(handle);

      return {
        success: true,
        handle,
        stub,
        logs: result.logs,
        type: result.type,
      };
    }

    // Scalar result - return directly
    return {
      success: true,
      value: result.value,
      logs: result.logs,
      type: result.type,
    };
  }

  /**
   * Expand a handle to get full data
   *
   * Use this when the LLM needs to see actual data for decision-making.
   */
  expand(handle: string, options: ExpandOptions = {}): ExpandResult {
    this.lastAccessedAt = new Date();

    const data = this.registry.get(handle);
    if (data === null) {
      return {
        success: false,
        error: `Invalid handle: ${handle}`,
      };
    }

    const total = data.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? total;

    // Slice the data
    let sliced = data.slice(offset, offset + limit);

    // Format if requested
    if (options.format === "lines") {
      sliced = sliced.map((item) => {
        if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          // Extract line content
          const line = obj.line ?? obj.content ?? obj.text;
          if (line !== undefined) {
            const lineNum = obj.lineNum ?? obj.lineNumber ?? obj.num;
            if (lineNum !== undefined) {
              return `[${lineNum}] ${line}`;
            }
            return String(line);
          }
        }
        return item;
      });
    }

    return {
      success: true,
      data: sliced,
      total,
      offset,
      limit,
    };
  }

  /**
   * Get a preview of handle contents (first N items)
   */
  preview(handle: string, n: number = 5): unknown[] {
    this.lastAccessedAt = new Date();
    return this.ops.preview(handle, n);
  }

  /**
   * Get a random sample from a handle
   */
  sample(handle: string, n: number = 5): unknown[] {
    this.lastAccessedAt = new Date();
    return this.ops.sample(handle, n);
  }

  /**
   * Describe handle contents (schema + stats)
   */
  describe(handle: string): { count: number; fields: string[]; sample: unknown[] } {
    this.lastAccessedAt = new Date();
    return this.ops.describe(handle);
  }

  /**
   * Get current handle bindings as stubs
   */
  getBindings(): Record<string, string> {
    const handles = this.registry.listHandles();
    const bindings: Record<string, string> = {};

    for (const handle of handles) {
      bindings[handle] = this.registry.getStub(handle);
    }

    // Mark current RESULTS
    const resultsHandle = this.registry.getResults();
    if (resultsHandle) {
      bindings["RESULTS"] = `-> ${resultsHandle}`;
    }

    return bindings;
  }

  /**
   * Build context string with all handle stubs
   */
  buildContext(): string {
    return this.registry.buildContext();
  }

  /**
   * Reset bindings but keep document loaded
   */
  reset(): void {
    // Clear handles
    const handles = this.registry.listHandles();
    for (const handle of handles) {
      this.registry.delete(handle);
    }

    // Reset engine state
    this.engine.reset();
  }

  /**
   * Get session info
   */
  getSessionInfo(): {
    documentPath: string;
    documentSize: number;
    loadedAt: Date | null;
    lastAccessedAt: Date | null;
    queryCount: number;
    handleCount: number;
  } {
    return {
      documentPath: this.documentPath,
      documentSize: this.documentSize,
      loadedAt: this.loadedAt,
      lastAccessedAt: this.lastAccessedAt,
      queryCount: this.queryCount,
      handleCount: this.registry.listHandles().length,
    };
  }

  /**
   * Close the session and free resources
   */
  close(): void {
    this.parserRegistry.dispose();
    this.db.close();
  }

  /**
   * Get command reference
   */
  static getCommandReference(): string {
    return NucleusEngine.getCommandReference();
  }
}
