#!/usr/bin/env node
/**
 * MCP Server for RLM
 *
 * Provides an MCP-compatible server that exposes the RLM as a tool.
 *
 * Two tools are available:
 * - analyze_document: Full RLM with LLM orchestration (for complex queries)
 * - nucleus_execute: Direct Nucleus command execution (no LLM needed)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { stat } from "node:fs/promises";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { runRLM } from "./rlm.js";
import { loadConfig } from "./config.js";
import { createLLMClient } from "./llm/index.js";
import type { LLMQueryFn } from "./llm/types.js";
import { NucleusEngine } from "./engine/nucleus-engine.js";
import { getVersion } from "./version.js";
import { hasTraversalSegment } from "./utils/path-safety.js";

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

// CLI flags
const skipCwdChecking = process.argv.includes("--dangerously-skip-cwd-checking");

function validateFilePath(filePath: string): string | null {
  if (skipCwdChecking) {
    return null;
  }
  // Reject path traversal (segment-aware — allows legitimate `foo..bar`)
  if (hasTraversalSegment(filePath)) {
    return "Path traversal (..) is not allowed";
  }
  // Resolve to absolute path
  const resolved = resolvePath(filePath);
  const cwd = process.cwd();
  // Absolute paths must be under CWD
  if (!resolved.startsWith(cwd + pathSep) && resolved !== cwd) {
    return "Path outside working directory is not allowed";
  }
  return null;
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
    "iteratively exploring the content with code execution. " +
    "Use this for complex, open-ended queries that need LLM reasoning.",
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
        description:
          "Hard outer timeout for the entire FSM run, in milliseconds. " +
          "Default 900000 (15 min). Raise this for slow models or large " +
          "documents where 10+ turns take longer than the default cap.",
      },
    },
    required: ["query", "filePath"],
  },
};

const NUCLEUS_EXECUTE_TOOL: MCPTool = {
  name: "nucleus_execute",
  description:
    "Execute Nucleus commands directly on a document without LLM orchestration. " +
    "Use this for precise, programmatic document analysis when you know exactly " +
    "what commands to run. Commands use S-expression syntax. " +
    "Examples: (grep \"pattern\"), (filter RESULTS (lambda (x) (match x \"error\" 0))), (count RESULTS)",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Nucleus S-expression command to execute (e.g., '(grep \"ERROR\")')",
      },
      filePath: {
        type: "string",
        description: "Path to the document file to analyze",
      },
      sessionId: {
        type: "string",
        description: "Optional session ID for maintaining state across multiple commands",
      },
    },
    required: ["command", "filePath"],
  },
};

const NUCLEUS_COMMANDS_TOOL: MCPTool = {
  name: "nucleus_commands",
  description:
    "Get reference documentation for available Nucleus commands. " +
    "Call this to see all available commands, their syntax, and examples.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

/**
 * Create an MCP server instance for testing or direct use
 */
export function createMCPServer(options: MCPServerOptions = {}): MCPServerInstance {
  let llmClient: LLMQueryFn | undefined = options.llmClient;

  // Session-based engine cache for stateful Nucleus execution
  const MAX_ENGINE_SESSIONS = 20;
  const engineSessions = new Map<string, NucleusEngine>();
  const engineMtimes = new Map<string, number>();
  const engineFilePaths = new Map<string, string>();

  const ensureLLMClient = async (): Promise<LLMQueryFn> => {
    if (llmClient) {
      return llmClient;
    }

    const config = await loadConfig();
    const providerName = config.llm.provider;
    const providerConfig = config.providers[providerName];

    if (!providerConfig) {
      throw new Error(`Provider '${providerName}' not found in config`);
    }

    llmClient = createLLMClient(providerName, providerConfig);
    return llmClient;
  };

  /**
   * Get or create a NucleusEngine for a session
   */
  const getEngine = async (filePath: string, sessionId?: string): Promise<NucleusEngine> => {
    const key = sessionId || filePath;

    let engine = engineSessions.get(key);
    const cachedFilePath = engineFilePaths.get(key);

    // If sessionId is reused with a different file, dispose old engine
    if (engine && cachedFilePath && cachedFilePath !== filePath) {
      engine.dispose();
      engineSessions.delete(key);
      engineMtimes.delete(key);
      engineFilePaths.delete(key);
      engine = undefined;
    }

    if (engine && engine.isLoaded()) {
      // Check if file was modified since cached
      try {
        const fileStat = await stat(filePath);
        const cachedMtime = engineMtimes.get(key);
        if (cachedMtime && fileStat.mtimeMs > cachedMtime) {
          // File changed, dispose old engine and reload
          engine.dispose();
          engine = new NucleusEngine();
          await engine.loadFile(filePath);
          engineSessions.delete(key);
          engineSessions.set(key, engine);
          engineFilePaths.set(key, filePath);
          engineMtimes.set(key, fileStat.mtimeMs);
          return engine;
        }
      } catch { /* stat failed, use cached */ }

      // Move to end for LRU ordering (most recently accessed = last)
      engineSessions.delete(key);
      engineSessions.set(key, engine);
      engineFilePaths.set(key, filePath);
      return engine;
    }

    // Evict oldest session if at capacity
    if (engineSessions.size >= MAX_ENGINE_SESSIONS) {
      const oldestKey = engineSessions.keys().next().value;
      if (oldestKey !== undefined) {
        const oldEngine = engineSessions.get(oldestKey);
        engineSessions.delete(oldestKey);
        engineMtimes.delete(oldestKey);
        engineFilePaths.delete(oldestKey);
        oldEngine?.dispose();
      }
    }

    engine = new NucleusEngine();
    await engine.loadFile(filePath);
    engineSessions.set(key, engine);
    engineFilePaths.set(key, filePath);
    try {
      const fileStat = await stat(filePath);
      engineMtimes.set(key, fileStat.mtimeMs);
    } catch { /* ignore */ }
    return engine;
  };

  return {
    name: "rlm",

    getTools(): MCPTool[] {
      return [ANALYZE_DOCUMENT_TOOL, NUCLEUS_EXECUTE_TOOL, NUCLEUS_COMMANDS_TOOL];
    },

    async callTool(
      name: string,
      args: Record<string, unknown>
    ): Promise<MCPToolResult> {
      // Handle nucleus_commands (no args needed)
      if (name === "nucleus_commands") {
        return {
          content: [{ type: "text", text: NucleusEngine.getCommandReference() }],
        };
      }

      // Handle nucleus_execute
      if (name === "nucleus_execute") {
        const { command, filePath, sessionId } = args as {
          command: string;
          filePath: string;
          sessionId?: string;
        };

        if (!command || !filePath) {
          return {
            content: [{ type: "text", text: "Error: 'command' and 'filePath' are required" }],
          };
        }

        const pathError = validateFilePath(filePath);
        if (pathError) {
          return { content: [{ type: "text", text: `Error: ${pathError}` }] };
        }

        try {
          const engine = await getEngine(filePath, sessionId);
          const result = await engine.execute(command);

          if (!result.success) {
            return {
              content: [{ type: "text", text: `Error: ${result.error}` }],
            };
          }

          // Format the result
          let text: string;
          if (Array.isArray(result.value)) {
            const arr = result.value as unknown[];
            const preview = arr.slice(0, 20).map(item => {
              if (typeof item === "object" && item !== null && "line" in item) {
                const gr = item as { line: string; lineNum: number };
                return `[${gr.lineNum}] ${gr.line.slice(0, 100)}`;
              }
              return JSON.stringify(item);
            });
            text = `Found ${arr.length} results:\n${preview.join("\n")}`;
            if (arr.length > 20) {
              text += `\n... and ${arr.length - 20} more`;
            }
            text += `\n\nResults bound to RESULTS. Use (filter RESULTS ...), (count RESULTS), (sum RESULTS) etc.`;
          } else {
            text = typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2);
          }

          // Include logs if any useful info
          if (result.logs.length > 0) {
            const importantLogs = result.logs.filter(l =>
              l.includes("Found") || l.includes("Sum") || l.includes("Count") || l.includes("Filter")
            );
            if (importantLogs.length > 0) {
              text = importantLogs.join("\n") + "\n\n" + text;
            }
          }

          return {
            content: [{ type: "text", text }],
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
          };
        }
      }

      // Handle analyze_document
      if (name === "analyze_document") {
        const { query, filePath, maxTurns, timeoutMs } = args as {
          query: string;
          filePath: string;
          maxTurns?: number;
          timeoutMs?: number;
        };

        const analyzePathError = validateFilePath(filePath);
        if (analyzePathError) {
          return { content: [{ type: "text", text: `Error: ${analyzePathError}` }] };
        }

        // Notify callback if provided (for testing)
        if (options.onRunRLM) {
          options.onRunRLM({ maxTurns });
        }

        try {
          const client = await ensureLLMClient();
          const result = await runRLM(query, filePath, {
            llmClient: client,
            maxTurns: maxTurns || 10,
            fsmTimeoutMs: typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined,
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
      }

      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    },

    async start(): Promise<void> {
      // This method starts the actual MCP server with stdio transport
      const server = new Server(
        { name: "rlm", version: getVersion() },
        { capabilities: { tools: {} } }
      );

      // List tools handler
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [ANALYZE_DOCUMENT_TOOL, NUCLEUS_EXECUTE_TOOL, NUCLEUS_COMMANDS_TOOL],
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
const showVersion = process.argv.includes("-v") || process.argv.includes("--version");

if (process.argv[1]?.endsWith("mcp-server.ts") || process.argv[1]?.endsWith("mcp-server.js") || process.argv[1]?.endsWith("rlm-mcp")) {
  if (showVersion) {
    console.log(`rlm-mcp v${getVersion()}`);
    process.exit(0);
  } else if (isTestMode) {
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
