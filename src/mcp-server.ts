#!/usr/bin/env node
/**
 * MCP Server for RLM
 *
 * Provides an MCP-compatible server that exposes the RLM as a tool.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { runRLM } from "./rlm.js";
import { loadConfig } from "./config.js";
import { createLLMClient } from "./llm/index.js";
import type { LLMQueryFn } from "./llm/types.js";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export type MCPToolResult = CallToolResult;

export interface MCPServerOptions {
  llmClient?: LLMQueryFn;
  onRunRLM?: (opts: { maxTurns?: number }) => void;
}

export interface MCPServerInstance {
  name: string;
  getTools(): MCPTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  start(): Promise<void>;
}

const ANALYZE_DOCUMENT_TOOL: MCPTool = {
  name: "analyze_document",
  description:
    "Analyze a document using the Recursive Language Model (RLM). " +
    "The RLM can process documents larger than the context window by " +
    "iteratively exploring the content with code execution.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question or task to perform on the document",
      },
      filePath: {
        type: "string",
        description: "Path to the document file to analyze",
      },
      maxTurns: {
        type: "number",
        description: "Maximum number of exploration turns (default: 10)",
      },
      timeoutMs: {
        type: "number",
        description: "Timeout per turn in milliseconds (default: 30000)",
      },
    },
    required: ["query", "filePath"],
  },
};

/**
 * Create an MCP server instance for testing or direct use
 */
export function createMCPServer(options: MCPServerOptions = {}): MCPServerInstance {
  let llmClient: LLMQueryFn | undefined = options.llmClient;

  const ensureLLMClient = async (): Promise<LLMQueryFn> => {
    if (llmClient) {
      return llmClient;
    }

    const config = await loadConfig("./config.json");
    const providerName = config.llm.provider;
    const providerConfig = config.providers[providerName];

    if (!providerConfig) {
      throw new Error(`Provider '${providerName}' not found in config`);
    }

    llmClient = createLLMClient(providerName, providerConfig);
    return llmClient;
  };

  return {
    name: "rlm",

    getTools(): MCPTool[] {
      return [ANALYZE_DOCUMENT_TOOL];
    },

    async callTool(
      name: string,
      args: Record<string, unknown>
    ): Promise<MCPToolResult> {
      if (name !== "analyze_document") {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
      }

      const { query, filePath, maxTurns, timeoutMs } = args as {
        query: string;
        filePath: string;
        maxTurns?: number;
        timeoutMs?: number;
      };

      // Notify callback if provided (for testing)
      if (options.onRunRLM) {
        options.onRunRLM({ maxTurns });
      }

      try {
        const client = await ensureLLMClient();
        const result = await runRLM(query, filePath, {
          llmClient: client,
          maxTurns: maxTurns || 10,
          turnTimeoutMs: timeoutMs || 30000,
        });

        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);

        return {
          content: [{ type: "text", text }],
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
        };
      }
    },

    async start(): Promise<void> {
      // This method starts the actual MCP server with stdio transport
      const server = new Server(
        { name: "rlm", version: "1.0.0" },
        { capabilities: { tools: {} } }
      );

      // List tools handler
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [ANALYZE_DOCUMENT_TOOL],
      }));

      // Call tool handler
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await this.callTool(name, args || {});
        return result;
      });

      // Start server
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}

// Main entry point - run server when executed directly
const isTestMode = process.argv.includes("--test");

if (process.argv[1]?.endsWith("mcp-server.ts") || process.argv[1]?.endsWith("mcp-server.js") || process.argv[1]?.endsWith("rlm-mcp")) {
  if (isTestMode) {
    // Test mode - just confirm server can be created and exit
    const server = createMCPServer();
    console.log("MCP server ready");
    console.log(`Available tools: ${server.getTools().map(t => t.name).join(", ")}`);
    process.exit(0);
  } else {
    // Production mode - start the actual server
    const server = createMCPServer();
    server.start().catch((err) => {
      console.error("Failed to start MCP server:", err);
      process.exit(1);
    });
  }
}
