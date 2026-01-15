/**
 * Claude Code Tool Adapter
 *
 * Provides a stateful Nucleus tool that can be registered with Claude Code.
 * The tool maintains state across calls within the same session.
 *
 * Usage in Claude Code:
 *   1. Register the tool in your MCP config
 *   2. Claude can call nucleus_load to load a document
 *   3. Claude can call nucleus_query repeatedly to explore
 *
 * Example:
 *   > nucleus_load({ filePath: "./logs.txt" })
 *   Loaded logs.txt: 50,000 lines
 *
 *   > nucleus_query({ command: '(grep "ERROR")' })
 *   Found 847 results (bound to RESULTS)
 *
 *   > nucleus_query({ command: '(count RESULTS)' })
 *   Result: 847
 */

import { NucleusTool, type NucleusResponse } from "../nucleus-tool.js";

/**
 * Tool definitions for Claude Code registration
 */
export interface ClaudeCodeToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Stateful Claude Code adapter
 */
export class ClaudeCodeAdapter {
  private tool: NucleusTool;

  constructor() {
    this.tool = new NucleusTool();
  }

  /**
   * Get tool definitions for registration
   */
  getToolDefinitions(): ClaudeCodeToolDefinition[] {
    return [
      {
        name: "nucleus_load",
        description:
          "Load a document for analysis. Call this first before querying. " +
          "The document remains loaded for subsequent queries.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Path to the document file to load",
            },
          },
          required: ["filePath"],
        },
      },
      {
        name: "nucleus_query",
        description:
          "Execute a Nucleus command on the loaded document. " +
          "Commands use S-expression syntax. Results are bound to RESULTS for chaining. " +
          "Examples: (grep \"pattern\"), (filter RESULTS (lambda x (match x \"error\" 0))), (count RESULTS), (sum RESULTS)",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Nucleus S-expression command to execute",
            },
          },
          required: ["command"],
        },
      },
      {
        name: "nucleus_bindings",
        description:
          "Show current variable bindings (RESULTS, _1, _2, etc). " +
          "Use this to see what data is available from previous queries.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "nucleus_reset",
        description:
          "Reset all bindings and state. Use this to start fresh without reloading the document.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "nucleus_stats",
        description: "Get statistics about the currently loaded document.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "nucleus_help",
        description: "Get reference documentation for Nucleus commands.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ];
  }

  /**
   * Handle a tool call
   */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    let response: NucleusResponse;

    switch (name) {
      case "nucleus_load":
        response = await this.tool.executeAsync({
          type: "load",
          filePath: args.filePath as string,
        });
        break;

      case "nucleus_query":
        response = this.tool.execute({
          type: "query",
          command: args.command as string,
        });
        break;

      case "nucleus_bindings":
        response = this.tool.execute({ type: "bindings" });
        break;

      case "nucleus_reset":
        response = this.tool.execute({ type: "reset" });
        break;

      case "nucleus_stats":
        response = this.tool.execute({ type: "stats" });
        break;

      case "nucleus_help":
        response = this.tool.execute({ type: "help" });
        break;

      default:
        response = { success: false, error: `Unknown tool: ${name}` };
    }

    return {
      content: [{ type: "text", text: this.formatResponse(response) }],
    };
  }

  /**
   * Format response for Claude
   */
  private formatResponse(response: NucleusResponse): string {
    if (!response.success) {
      return `Error: ${response.error}`;
    }

    const parts: string[] = [];

    if (response.message) {
      parts.push(response.message);
    }

    if (response.data !== undefined && response.data !== null) {
      if (Array.isArray(response.data)) {
        const arr = response.data;
        // Show preview of array results
        const preview = arr.slice(0, 15).map((item) => {
          if (typeof item === "object" && item !== null && "line" in item) {
            const gr = item as { line: string; lineNum: number };
            return `[${gr.lineNum}] ${gr.line.slice(0, 100)}`;
          }
          return JSON.stringify(item).slice(0, 100);
        });

        parts.push("");
        parts.push(...preview);

        if (arr.length > 15) {
          parts.push(`... and ${arr.length - 15} more`);
        }

        parts.push("");
        parts.push("Use (filter RESULTS ...), (count RESULTS), (sum RESULTS), or (map RESULTS ...) to process.");
      } else if (typeof response.data === "object") {
        // For stats/bindings, show as key-value pairs
        const obj = response.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(obj)) {
          parts.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
        }
      }
    }

    return parts.join("\n");
  }

  /**
   * Get the underlying tool (for testing)
   */
  getTool(): NucleusTool {
    return this.tool;
  }
}

/**
 * Create a standalone Claude Code adapter instance
 */
export function createClaudeCodeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter();
}

/**
 * Generate MCP tool configuration for Claude Code
 */
export function generateMCPConfig(adapter: ClaudeCodeAdapter): string {
  const tools = adapter.getToolDefinitions();

  return JSON.stringify(
    {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    },
    null,
    2
  );
}
