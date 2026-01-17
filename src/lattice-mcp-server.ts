#!/usr/bin/env node
/**
 * Lattice MCP Server
 *
 * A stateful document analysis tool for LLM agents with session lifecycle management.
 * Uses Nucleus S-expression syntax for queries.
 *
 * SESSION LIFECYCLE:
 * - Sessions auto-expire after inactivity (default: 10 minutes)
 * - Loading a new document closes the previous session
 * - Explicit lattice_close tool for cleanup
 * - Memory is freed when session ends
 *
 * Usage:
 *   1. lattice_load - Load a document (starts session)
 *   2. lattice_query - Run queries (resets inactivity timer)
 *   3. lattice_close - Explicitly end session (or wait for timeout)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { NucleusEngine } from "./engine/nucleus-engine.js";
import { getVersion } from "./version.js";

// Configuration
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB limit

// Session state
interface Session {
  engine: NucleusEngine;
  documentPath: string;
  documentSize: number;
  loadedAt: Date;
  lastAccessedAt: Date;
  queryCount: number;
}

let session: Session | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

function resetInactivityTimer(): void {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  timeoutHandle = setTimeout(() => {
    if (session) {
      console.error(`[Lattice] Session expired after ${SESSION_TIMEOUT_MS / 1000}s inactivity`);
      closeSession("timeout");
    }
  }, SESSION_TIMEOUT_MS);
}

function closeSession(reason: string): void {
  if (session) {
    const duration = Date.now() - session.loadedAt.getTime();
    console.error(
      `[Lattice] Session closed: ${reason} | ` +
      `Document: ${session.documentPath} | ` +
      `Duration: ${Math.round(duration / 1000)}s | ` +
      `Queries: ${session.queryCount}`
    );
    session = null;
  }

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
}

function getSessionInfo(): string {
  if (!session) {
    return "No active session";
  }

  const now = new Date();
  const age = Math.round((now.getTime() - session.loadedAt.getTime()) / 1000);
  const idle = Math.round((now.getTime() - session.lastAccessedAt.getTime()) / 1000);
  const timeout = Math.round((SESSION_TIMEOUT_MS - idle * 1000) / 1000);

  return `Session active:
  Document: ${session.documentPath}
  Size: ${(session.documentSize / 1024).toFixed(1)} KB
  Age: ${age}s
  Idle: ${idle}s
  Timeout in: ${Math.max(0, timeout)}s
  Queries: ${session.queryCount}`;
}

const TOOLS = [
  {
    name: "lattice_load",
    description: `Load a document for analysis. Starts a new session (closes any existing session).

RECOMMENDED WORKFLOW:
1. Use Glob first to discover relevant files
2. Read small files (<300 lines) directly
3. Use Lattice for large files (>500 lines) - saves 80%+ tokens
4. Chain queries: grep → filter → count/sum

EFFICIENT QUERY PATTERNS:
- Start broad: (grep "ERROR") to find all errors
- Then narrow: (filter RESULTS (lambda x (match x "timeout" 0)))
- Finally aggregate: (count RESULTS) or (sum RESULTS)

TOKEN EFFICIENCY:
- Results show preview (first 20 items), not full data
- Use (count RESULTS) to get totals without listing all
- Chain operations to refine without re-reading

SESSION: Document stays loaded for ${SESSION_TIMEOUT_MS / 60000} minutes.
Call lattice_close when done.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description: "Path to the document to analyze",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "lattice_query",
    description: `Execute a Nucleus query on the loaded document.

SEARCH (returns matches bound to RESULTS):
  (grep "pattern")              Regex search - finds all matching lines
  (fuzzy_search "query" 10)     Fuzzy search - top N matches by relevance
  (lines 10 20)                 Get specific line range

AGGREGATE (returns scalar, RESULTS unchanged):
  (count RESULTS)               Count items
  (sum RESULTS)                 Sum numbers (auto-extracts from $1,234 format)

TRANSFORM (returns new array, updates RESULTS):
  (filter RESULTS (lambda x (match x "pattern" 0)))
  (map RESULTS (lambda x (match x "(\\d+)" 1)))

EXTRACT:
  (match str "pattern" 1)       Extract regex group from string

EFFICIENT WORKFLOW:
1. (grep "ERROR")                    → Find all errors
2. (filter RESULTS ...)              → Narrow down
3. (count RESULTS) or (sum RESULTS)  → Get final answer

Results are bound to RESULTS. Each turn also saves to _1, _2, etc.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: 'Nucleus S-expression command, e.g., (grep "ERROR")',
        },
      },
      required: ["command"],
    },
  },
  {
    name: "lattice_close",
    description:
      "Close the current session and free memory. " +
      "Call this when done analyzing a document. " +
      "Sessions also auto-close after 10 minutes of inactivity.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_status",
    description: "Get current session status including document info, memory usage, and timeout.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_bindings",
    description: "Show current variable bindings (RESULTS, _1, _2, etc).",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_reset",
    description: "Reset variable bindings but keep document loaded.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_help",
    description: "Get complete Nucleus command reference documentation.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

function formatResult(result: { success: boolean; value?: unknown; error?: string }): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const value = result.value;

  if (Array.isArray(value)) {
    const preview = value.slice(0, 20).map((item) => {
      if (typeof item === "object" && item !== null && "line" in item) {
        const gr = item as { line: string; lineNum: number };
        return `[${gr.lineNum}] ${gr.line.slice(0, 100)}`;
      }
      return JSON.stringify(item).slice(0, 100);
    });

    let text = `Found ${value.length} results:\n${preview.join("\n")}`;
    if (value.length > 20) {
      text += `\n... and ${value.length - 20} more`;
    }
    text += "\n\nChain with (count RESULTS), (filter RESULTS ...), (map RESULTS ...), etc.";
    return text;
  }

  if (typeof value === "number") {
    return `Result: ${value.toLocaleString()}`;
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    switch (name) {
      case "lattice_load": {
        const filePath = args.filePath as string;
        if (!filePath) {
          return { content: [{ type: "text", text: "Error: filePath is required" }] };
        }

        // Close existing session
        if (session) {
          closeSession("new document loaded");
        }

        // Create new engine and load
        const engine = new NucleusEngine();
        await engine.loadFile(filePath);

        const stats = engine.getStats();
        if (!stats) {
          return { content: [{ type: "text", text: "Error: Failed to get document stats" }] };
        }

        // Check size limit
        if (stats.length > MAX_DOCUMENT_SIZE) {
          return {
            content: [{
              type: "text",
              text: `Error: Document too large (${(stats.length / 1024 / 1024).toFixed(1)}MB). ` +
                `Maximum size is ${MAX_DOCUMENT_SIZE / 1024 / 1024}MB.`,
            }],
          };
        }

        // Create session
        session = {
          engine,
          documentPath: filePath,
          documentSize: stats.length,
          loadedAt: new Date(),
          lastAccessedAt: new Date(),
          queryCount: 0,
        };

        // Start inactivity timer
        resetInactivityTimer();

        console.error(`[Lattice] Session started: ${filePath} (${stats.lineCount} lines)`);

        return {
          content: [{
            type: "text",
            text: `Loaded ${filePath}:\n` +
              `  Lines: ${stats.lineCount.toLocaleString()}\n` +
              `  Size: ${(stats.length / 1024).toFixed(1)} KB\n` +
              `  Session timeout: ${SESSION_TIMEOUT_MS / 60000} minutes\n\n` +
              `Ready for queries. Call lattice_close when done.`,
          }],
        };
      }

      case "lattice_query": {
        if (!session) {
          return {
            content: [{
              type: "text",
              text: "Error: No active session. Use lattice_load first.",
            }],
          };
        }

        const command = args.command as string;
        if (!command) {
          return { content: [{ type: "text", text: "Error: command is required" }] };
        }

        // Update session
        session.lastAccessedAt = new Date();
        session.queryCount++;
        resetInactivityTimer();

        const result = session.engine.execute(command);
        return { content: [{ type: "text", text: formatResult(result) }] };
      }

      case "lattice_close": {
        if (!session) {
          return { content: [{ type: "text", text: "No active session to close." }] };
        }

        const info = `Closed session for ${session.documentPath} (${session.queryCount} queries)`;
        closeSession("explicit close");
        return { content: [{ type: "text", text: info }] };
      }

      case "lattice_status": {
        return { content: [{ type: "text", text: getSessionInfo() }] };
      }

      case "lattice_bindings": {
        if (!session) {
          return { content: [{ type: "text", text: "No active session." }] };
        }

        // Update access time
        session.lastAccessedAt = new Date();
        resetInactivityTimer();

        const bindings = session.engine.getBindings();
        if (Object.keys(bindings).length === 0) {
          return { content: [{ type: "text", text: "No bindings yet. Run a query first." }] };
        }

        const lines = Object.entries(bindings).map(([k, v]) => `  ${k}: ${v}`);
        return {
          content: [{
            type: "text",
            text: `Current bindings:\n${lines.join("\n")}`,
          }],
        };
      }

      case "lattice_reset": {
        if (!session) {
          return { content: [{ type: "text", text: "No active session." }] };
        }

        session.engine.reset();
        session.lastAccessedAt = new Date();
        resetInactivityTimer();

        return { content: [{ type: "text", text: "Bindings reset. Document still loaded." }] };
      }

      case "lattice_help": {
        return {
          content: [{ type: "text", text: NucleusEngine.getCommandReference() }],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
}

// Cleanup on exit
process.on("SIGINT", () => {
  closeSession("process interrupted");
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeSession("process terminated");
  process.exit(0);
});

async function main() {
  // Handle version flag
  if (process.argv.includes("-v") || process.argv.includes("--version")) {
    console.log(`lattice-mcp v${getVersion()}`);
    process.exit(0);
  }

  const server = new Server(
    {
      name: "lattice",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, (args as Record<string, unknown>) || {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[Lattice] MCP server started");
  console.error(`[Lattice] Session timeout: ${SESSION_TIMEOUT_MS / 1000}s`);
  console.error(`[Lattice] Max document size: ${MAX_DOCUMENT_SIZE / 1024 / 1024}MB`);
}

main().catch((err) => {
  console.error("[Lattice] Fatal error:", err);
  process.exit(1);
});
