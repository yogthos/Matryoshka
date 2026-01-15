/**
 * NucleusTool - Stateful document analysis tool
 *
 * Provides a unified interface for interactive document analysis
 * that can be used via multiple adapters:
 * - Claude Code tool registration
 * - Pipe-based REPL
 * - HTTP server
 */

import { NucleusEngine, type ExecutionResult } from "../engine/nucleus-engine.js";

/**
 * Command types supported by the tool
 */
export type NucleusCommand =
  | { type: "load"; filePath: string }
  | { type: "loadContent"; content: string; name?: string }
  | { type: "query"; command: string }
  | { type: "bindings" }
  | { type: "reset" }
  | { type: "stats" }
  | { type: "help" };

/**
 * Unified response type
 */
export interface NucleusResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

/**
 * NucleusTool - Stateful wrapper around NucleusEngine
 *
 * Maintains state across multiple commands, allowing iterative
 * document exploration.
 */
export class NucleusTool {
  private engine: NucleusEngine;
  private documentPath: string | null = null;
  private documentName: string | null = null;

  constructor() {
    this.engine = new NucleusEngine();
  }

  /**
   * Execute a command
   */
  execute(command: NucleusCommand): NucleusResponse {
    switch (command.type) {
      case "load":
        return this.load(command.filePath);

      case "loadContent":
        return this.loadContent(command.content, command.name);

      case "query":
        return this.query(command.command);

      case "bindings":
        return this.getBindings();

      case "reset":
        return this.reset();

      case "stats":
        return this.getStats();

      case "help":
        return this.getHelp();

      default:
        return { success: false, error: `Unknown command type` };
    }
  }

  /**
   * Execute a command asynchronously (for file loading)
   */
  async executeAsync(command: NucleusCommand): Promise<NucleusResponse> {
    if (command.type === "load") {
      return this.loadAsync(command.filePath);
    }
    return this.execute(command);
  }

  /**
   * Load a document from file (async)
   */
  async loadAsync(filePath: string): Promise<NucleusResponse> {
    try {
      await this.engine.loadFile(filePath);
      this.documentPath = filePath;
      this.documentName = filePath.split("/").pop() || filePath;

      const stats = this.engine.getStats();
      return {
        success: true,
        message: `Loaded ${this.documentName}: ${stats?.lineCount.toLocaleString()} lines, ${stats?.length.toLocaleString()} chars`,
        data: stats,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to load ${filePath}: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  /**
   * Load a document from file (sync - requires pre-loaded content)
   */
  private load(_filePath: string): NucleusResponse {
    // For sync operation, return instruction to use async
    return {
      success: false,
      error: "Use executeAsync for file loading",
    };
  }

  /**
   * Load a document from string content
   */
  private loadContent(content: string, name?: string): NucleusResponse {
    try {
      this.engine.loadContent(content);
      this.documentPath = null;
      this.documentName = name || "inline-document";

      const stats = this.engine.getStats();
      return {
        success: true,
        message: `Loaded ${this.documentName}: ${stats?.lineCount.toLocaleString()} lines, ${stats?.length.toLocaleString()} chars`,
        data: stats,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to load content: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  /**
   * Execute a Nucleus query
   */
  private query(command: string): NucleusResponse {
    if (!this.engine.isLoaded()) {
      return {
        success: false,
        error: "No document loaded. Use 'load' first.",
      };
    }

    const result = this.engine.execute(command);

    if (!result.success) {
      return {
        success: false,
        error: result.error,
      };
    }

    return {
      success: true,
      data: result.value,
      message: this.formatResultMessage(result),
    };
  }

  /**
   * Format a result message for display
   */
  private formatResultMessage(result: ExecutionResult): string {
    const value = result.value;

    if (Array.isArray(value)) {
      return `Found ${value.length} results (bound to RESULTS)`;
    }

    if (typeof value === "number") {
      return `Result: ${value.toLocaleString()}`;
    }

    if (typeof value === "string") {
      const lines = value.split("\n").length;
      if (lines > 1) {
        return `Retrieved ${lines} lines`;
      }
      return `Result: ${value.slice(0, 100)}${value.length > 100 ? "..." : ""}`;
    }

    return `Result: ${JSON.stringify(value)}`;
  }

  /**
   * Get current bindings
   */
  private getBindings(): NucleusResponse {
    const bindings = this.engine.getBindings();
    return {
      success: true,
      data: bindings,
      message: Object.keys(bindings).length > 0
        ? `Current bindings: ${Object.keys(bindings).join(", ")}`
        : "No bindings",
    };
  }

  /**
   * Reset state
   */
  private reset(): NucleusResponse {
    this.engine.reset();
    return {
      success: true,
      message: "State reset (bindings cleared)",
    };
  }

  /**
   * Get document stats
   */
  private getStats(): NucleusResponse {
    if (!this.engine.isLoaded()) {
      return {
        success: false,
        error: "No document loaded",
      };
    }

    const stats = this.engine.getStats();
    return {
      success: true,
      data: {
        ...stats,
        documentName: this.documentName,
        documentPath: this.documentPath,
      },
      message: `Document: ${this.documentName} (${stats?.lineCount.toLocaleString()} lines, ${stats?.length.toLocaleString()} chars)`,
    };
  }

  /**
   * Get help text
   */
  private getHelp(): NucleusResponse {
    return {
      success: true,
      message: NucleusEngine.getCommandReference(),
    };
  }

  /**
   * Check if document is loaded
   */
  isLoaded(): boolean {
    return this.engine.isLoaded();
  }

  /**
   * Get the underlying engine (for advanced use)
   */
  getEngine(): NucleusEngine {
    return this.engine;
  }

  /**
   * Get document name
   */
  getDocumentName(): string | null {
    return this.documentName;
  }
}

/**
 * Parse a text command into a NucleusCommand
 */
export function parseCommand(input: string): NucleusCommand | null {
  const trimmed = input.trim();

  if (!trimmed) return null;

  // Meta commands (start with :)
  if (trimmed.startsWith(":")) {
    const parts = trimmed.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");

    switch (cmd) {
      case "load":
        if (!arg) return null;
        return { type: "load", filePath: arg };

      case "bindings":
      case "vars":
        return { type: "bindings" };

      case "reset":
      case "clear":
        return { type: "reset" };

      case "stats":
      case "info":
        return { type: "stats" };

      case "help":
      case "h":
      case "?":
        return { type: "help" };

      default:
        return null;
    }
  }

  // Nucleus command (S-expression)
  if (trimmed.startsWith("(")) {
    return { type: "query", command: trimmed };
  }

  return null;
}

/**
 * Format a response for text output
 */
export function formatResponse(response: NucleusResponse): string {
  if (!response.success) {
    return `Error: ${response.error}`;
  }

  const parts: string[] = [];

  if (response.message) {
    parts.push(response.message);
  }

  if (response.data !== undefined && response.data !== null) {
    if (Array.isArray(response.data)) {
      // Format array results
      const arr = response.data;
      const preview = arr.slice(0, 10).map((item) => {
        if (typeof item === "object" && item !== null && "line" in item) {
          const gr = item as { line: string; lineNum: number };
          return `  [${gr.lineNum}] ${gr.line.slice(0, 80)}${gr.line.length > 80 ? "..." : ""}`;
        }
        return `  ${JSON.stringify(item).slice(0, 80)}`;
      });

      if (!response.message) {
        parts.push(`Array[${arr.length}]:`);
      }
      parts.push(...preview);

      if (arr.length > 10) {
        parts.push(`  ... and ${arr.length - 10} more`);
      }
    } else if (typeof response.data === "object") {
      // Format object results (stats, bindings)
      if (!response.message) {
        parts.push(JSON.stringify(response.data, null, 2));
      }
    }
  }

  return parts.join("\n");
}
