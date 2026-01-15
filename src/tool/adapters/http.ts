#!/usr/bin/env node
/**
 * HTTP Server Adapter for Nucleus
 *
 * Provides a stateful REST API for document analysis. Sessions are maintained
 * server-side, allowing multiple clients or a single client to make multiple
 * requests against the same loaded document.
 *
 * Endpoints:
 *   POST /load          - Load a document (file path or content)
 *   POST /query         - Execute a Nucleus command
 *   GET  /bindings      - Get current variable bindings
 *   POST /reset         - Reset bindings
 *   GET  /stats         - Get document statistics
 *   GET  /help          - Get command reference
 *   GET  /health        - Health check
 *
 * Usage:
 *   nucleus-http --port 3456
 *
 *   curl -X POST http://localhost:3456/load -d '{"filePath":"./data.txt"}'
 *   curl -X POST http://localhost:3456/query -d '{"command":"(grep \"error\")"}'
 *   curl http://localhost:3456/bindings
 */

import * as http from "node:http";
import {
  NucleusTool,
  type NucleusResponse,
} from "../nucleus-tool.js";

export interface HttpAdapterOptions {
  /** Port to listen on (default: 3456) */
  port?: number;
  /** Host to bind to (default: localhost) */
  host?: string;
  /** Enable CORS (default: true) */
  cors?: boolean;
}

/**
 * HTTP server adapter
 */
export class HttpAdapter {
  private tool: NucleusTool;
  private server: http.Server | null = null;
  private port: number;
  private host: string;
  private cors: boolean;

  constructor(options: HttpAdapterOptions = {}) {
    this.tool = new NucleusTool();
    this.port = options.port ?? 3456;
    this.host = options.host ?? "localhost";
    this.cors = options.cors ?? true;
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.on("error", reject);

      this.server.listen(this.port, this.host, () => {
        console.log(`Nucleus HTTP server running at http://${this.host}:${this.port}`);
        console.log("Endpoints:");
        console.log("  POST /load      - Load a document");
        console.log("  POST /query     - Execute Nucleus command");
        console.log("  GET  /bindings  - Get current bindings");
        console.log("  POST /reset     - Reset state");
        console.log("  GET  /stats     - Get document stats");
        console.log("  GET  /help      - Command reference");
        console.log("  GET  /health    - Health check");
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle an HTTP request
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // CORS headers
    if (this.cors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    res.setHeader("Content-Type", "application/json");

    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      let response: NucleusResponse;

      switch (path) {
        case "/load":
          if (req.method !== "POST") {
            this.sendError(res, 405, "Method not allowed");
            return;
          }
          response = await this.handleLoad(req);
          break;

        case "/query":
          if (req.method !== "POST") {
            this.sendError(res, 405, "Method not allowed");
            return;
          }
          response = await this.handleQuery(req);
          break;

        case "/bindings":
          response = this.tool.execute({ type: "bindings" });
          break;

        case "/reset":
          if (req.method !== "POST") {
            this.sendError(res, 405, "Method not allowed");
            return;
          }
          response = this.tool.execute({ type: "reset" });
          break;

        case "/stats":
          response = this.tool.execute({ type: "stats" });
          break;

        case "/help":
          response = this.tool.execute({ type: "help" });
          break;

        case "/health":
          response = {
            success: true,
            data: {
              status: "ok",
              loaded: this.tool.isLoaded(),
              document: this.tool.getDocumentName(),
            },
          };
          break;

        default:
          this.sendError(res, 404, `Unknown endpoint: ${path}`);
          return;
      }

      this.sendResponse(res, response);
    } catch (err) {
      this.sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Handle /load endpoint
   */
  private async handleLoad(req: http.IncomingMessage): Promise<NucleusResponse> {
    const body = await this.readBody(req);

    if (typeof body.filePath === "string") {
      return this.tool.executeAsync({ type: "load", filePath: body.filePath });
    }

    if (typeof body.content === "string") {
      return this.tool.execute({
        type: "loadContent",
        content: body.content,
        name: typeof body.name === "string" ? body.name : undefined,
      });
    }

    return { success: false, error: "Provide 'filePath' or 'content'" };
  }

  /**
   * Handle /query endpoint
   */
  private async handleQuery(req: http.IncomingMessage): Promise<NucleusResponse> {
    const body = await this.readBody(req);

    if (typeof body.command !== "string") {
      return { success: false, error: "Missing 'command' field" };
    }

    return this.tool.execute({ type: "query", command: body.command });
  }

  /**
   * Read and parse JSON body
   */
  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let data = "";

      req.on("data", (chunk) => {
        data += chunk;
      });

      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });

      req.on("error", reject);
    });
  }

  /**
   * Send a successful response
   */
  private sendResponse(res: http.ServerResponse, response: NucleusResponse): void {
    res.writeHead(response.success ? 200 : 400);
    res.end(JSON.stringify(response, null, 2));
  }

  /**
   * Send an error response
   */
  private sendError(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status);
    res.end(JSON.stringify({ success: false, error: message }));
  }

  /**
   * Get the underlying tool
   */
  getTool(): NucleusTool {
    return this.tool;
  }

  /**
   * Get server info
   */
  getServerInfo(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }
}

/**
 * Create and start an HTTP adapter
 */
export async function startHttpAdapter(options?: HttpAdapterOptions): Promise<HttpAdapter> {
  const adapter = new HttpAdapter(options);
  await adapter.start();
  return adapter;
}

/**
 * CLI entry point
 */
function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Nucleus HTTP Server

Usage:
  nucleus-http [options]

Options:
  --port <n>      Port to listen on (default: 3456)
  --host <addr>   Host to bind to (default: localhost)
  --no-cors       Disable CORS headers
  --help, -h      Show this help

Endpoints:
  POST /load      Load a document
                  Body: {"filePath": "..."} or {"content": "...", "name": "..."}

  POST /query     Execute Nucleus command
                  Body: {"command": "(grep \\"pattern\\")"}

  GET  /bindings  Get current variable bindings

  POST /reset     Reset bindings (clear state)

  GET  /stats     Get document statistics

  GET  /help      Get Nucleus command reference

  GET  /health    Health check

Examples:
  # Start server
  nucleus-http --port 8080

  # Load a document
  curl -X POST http://localhost:8080/load \\
    -H "Content-Type: application/json" \\
    -d '{"filePath": "./logs.txt"}'

  # Query
  curl -X POST http://localhost:8080/query \\
    -H "Content-Type: application/json" \\
    -d '{"command": "(grep \\"ERROR\\")"}'

  # Get count
  curl -X POST http://localhost:8080/query \\
    -H "Content-Type: application/json" \\
    -d '{"command": "(count RESULTS)"}'
`);
    process.exit(0);
  }

  // Parse options
  let port = 3456;
  let host = "localhost";
  let cors = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--host" && args[i + 1]) {
      host = args[++i];
    } else if (args[i] === "--no-cors") {
      cors = false;
    }
  }

  startHttpAdapter({ port, host, cors }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

// Run if executed directly
if (process.argv[1]?.endsWith("http.ts") || process.argv[1]?.endsWith("http.js") || process.argv[1]?.endsWith("nucleus-http")) {
  main();
}
