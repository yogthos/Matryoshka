import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "fs";
import { hasTraversalSegment } from "../src/utils/path-safety.js";

// For these tests, we'll use a simpler approach that doesn't require the MCP SDK
// We'll test the server module directly

describe("MCP Server", () => {
  describe("server module", () => {
    it("should export createMCPServer function", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      expect(typeof createMCPServer).toBe("function");
    });

    it("should create server with tool definitions", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      expect(server).toBeDefined();
      expect(server.name).toBe("rlm");
    });

    it("should have analyze_document tool", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const tools = server.getTools();
      const analyzeTool = tools.find((t) => t.name === "analyze_document");

      expect(analyzeTool).toBeDefined();
      expect(analyzeTool?.description).toContain("Recursive Language Model");
    });

    it("should have nucleus_execute tool", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const tools = server.getTools();
      const nucleusTool = tools.find((t) => t.name === "nucleus_execute");

      expect(nucleusTool).toBeDefined();
      expect(nucleusTool?.description).toContain("Nucleus commands");
    });

    it("should have nucleus_commands tool", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const tools = server.getTools();
      const commandsTool = tools.find((t) => t.name === "nucleus_commands");

      expect(commandsTool).toBeDefined();
      expect(commandsTool?.description).toContain("reference");
    });

    it("should have correct input schema for nucleus_execute", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const tools = server.getTools();
      const nucleusTool = tools.find((t) => t.name === "nucleus_execute");

      expect(nucleusTool?.inputSchema.properties).toHaveProperty("command");
      expect(nucleusTool?.inputSchema.properties).toHaveProperty("filePath");
      expect(nucleusTool?.inputSchema.required).toContain("command");
      expect(nucleusTool?.inputSchema.required).toContain("filePath");
    });

    it("should have correct input schema for analyze_document", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const tools = server.getTools();
      const analyzeTool = tools.find((t) => t.name === "analyze_document");

      expect(analyzeTool?.inputSchema.properties).toHaveProperty("query");
      expect(analyzeTool?.inputSchema.properties).toHaveProperty("filePath");
      expect(analyzeTool?.inputSchema.required).toContain("query");
      expect(analyzeTool?.inputSchema.required).toContain("filePath");
    });

    it("should support optional maxTurns parameter", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const tools = server.getTools();
      const analyzeTool = tools.find((t) => t.name === "analyze_document");

      expect(analyzeTool?.inputSchema.properties).toHaveProperty("maxTurns");
      expect(analyzeTool?.inputSchema.required).not.toContain("maxTurns");
    });
  });

  describe("tool handler", () => {
    it("should execute analyze_document with mock LLM", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");

      // Create a mock LLM that first runs LC code, then returns final answer
      // (LC execution is required before final answer is accepted)
      const mockLLMClient = vi
        .fn()
        .mockResolvedValueOnce('(grep "test")')
        .mockResolvedValueOnce("<<<FINAL>>>\nTest result\n<<<END>>>");

      const server = createMCPServer({ llmClient: mockLLMClient });

      const result = await server.callTool("analyze_document", {
        query: "What is the first line?",
        filePath: "./test-fixtures/small.txt",
      });

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Test result");
    });

    it("should handle missing file gracefully", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");

      const mockLLMClient = vi.fn();
      const server = createMCPServer({ llmClient: mockLLMClient });

      const result = await server.callTool("analyze_document", {
        query: "test",
        filePath: "./nonexistent.txt",
      });

      expect(result.content[0].text).toMatch(/error|not found/i);
    });

    it("should pass maxTurns to RLM", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");

      let capturedMaxTurns: number | undefined;
      let callCount = 0;
      const mockLLMClient = vi.fn().mockImplementation(() => {
        callCount++;
        // First call: execute code, second call: final answer
        if (callCount === 1) {
          return Promise.resolve("```javascript\nconsole.log('test');\n```");
        }
        return Promise.resolve("<<<FINAL>>>\ndone\n<<<END>>>");
      });

      const server = createMCPServer({
        llmClient: mockLLMClient,
        onRunRLM: (opts) => {
          capturedMaxTurns = opts.maxTurns;
        },
      });

      await server.callTool("analyze_document", {
        query: "test",
        filePath: "./test-fixtures/small.txt",
        maxTurns: 5,
      });

      expect(capturedMaxTurns).toBe(5);
    });

    it("should emit notifications/progress for each FSM turn when a progressSink is supplied", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");

      // Mock LLM that takes 3 turns: grep, then more code, then final.
      // Each LLM round-trip corresponds to one handleQueryLLM turn, so we
      // expect 3 progress notifications.
      const mockLLMClient = vi
        .fn()
        .mockResolvedValueOnce('(grep "test")')
        .mockResolvedValueOnce('(count RESULTS)')
        .mockResolvedValueOnce("<<<FINAL>>>\ndone\n<<<END>>>");

      const server = createMCPServer({ llmClient: mockLLMClient });

      const notifications: Array<{
        method: string;
        params: { progressToken: string | number; progress: number; total?: number; message?: string };
      }> = [];

      const result = await server.callTool(
        "analyze_document",
        {
          query: "test",
          filePath: "./test-fixtures/small.txt",
          maxTurns: 5,
        },
        {
          progressToken: "test-token-123",
          sendNotification: async (n) => {
            notifications.push(n);
          },
        }
      );

      expect(result.content[0].text).toContain("done");
      // Heartbeat timer fires every 30s; the test runs in <1s so only
      // the per-turn pings should appear. Allow >=3 to keep the test
      // resilient if heartbeats land later.
      const turnPings = notifications.filter((n) =>
        (n.params.message ?? "").startsWith("Turn ")
      );
      expect(turnPings.length).toBe(3);
      // Wire-format checks across every notification.
      for (const n of notifications) {
        expect(n.method).toBe("notifications/progress");
        expect(n.params.progressToken).toBe("test-token-123");
        expect(typeof n.params.message).toBe("string");
        // `total` intentionally omitted — sub-RLMs make a useful
        // total unknowable, and stale totals confuse percent renderers.
        expect(n.params.total).toBeUndefined();
      }
      // Monotonic, strictly increasing progress counter — the
      // top-level run cannot rewind below 1, and a sub-RLM (if added)
      // would continue counting forward from wherever the parent left.
      expect(turnPings[0].params.progress).toBe(1);
      expect(turnPings[1].params.progress).toBe(2);
      expect(turnPings[2].params.progress).toBe(3);
      // Top-level run has depth 0, so the message must NOT mention
      // sub-RLM depth.
      for (const n of turnPings) {
        expect(n.params.message).not.toContain("sub-RLM");
      }
    });

    it("should not call sendNotification when no progressSink is supplied", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");

      const mockLLMClient = vi
        .fn()
        .mockResolvedValueOnce('(grep "test")')
        .mockResolvedValueOnce("<<<FINAL>>>\ndone\n<<<END>>>");

      const server = createMCPServer({ llmClient: mockLLMClient });

      // No progressSink — runRLM should run cleanly without trying to
      // call any notification path.
      const result = await server.callTool("analyze_document", {
        query: "test",
        filePath: "./test-fixtures/small.txt",
      });

      expect(result.content[0].text).toContain("done");
    });

    it("should swallow sendNotification errors without breaking the FSM", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");

      const mockLLMClient = vi
        .fn()
        .mockResolvedValueOnce('(grep "test")')
        .mockResolvedValueOnce("<<<FINAL>>>\ndone\n<<<END>>>");

      const server = createMCPServer({ llmClient: mockLLMClient });

      // sendNotification rejects every time — simulating a closed
      // transport. The FSM must still complete and return the result.
      const result = await server.callTool(
        "analyze_document",
        {
          query: "test",
          filePath: "./test-fixtures/small.txt",
        },
        {
          progressToken: 7,
          sendNotification: async () => {
            throw new Error("transport closed");
          },
        }
      );

      expect(result.content[0].text).toContain("done");
    });
  });

  describe("nucleus_execute tool", () => {
    it("should execute grep command directly", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const result = await server.callTool("nucleus_execute", {
        command: '(grep "test")',
        filePath: "./test-fixtures/small.txt",
      });

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("results");
    });

    it("should execute count command", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      // First grep to populate RESULTS
      await server.callTool("nucleus_execute", {
        command: '(grep ".")',
        filePath: "./test-fixtures/small.txt",
        sessionId: "test-session",
      });

      // Then count
      const result = await server.callTool("nucleus_execute", {
        command: '(count RESULTS)',
        filePath: "./test-fixtures/small.txt",
        sessionId: "test-session",
      });

      expect(result.content[0].text).toMatch(/\d+/);
    });

    it("should handle invalid command gracefully", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const result = await server.callTool("nucleus_execute", {
        command: '(invalid',
        filePath: "./test-fixtures/small.txt",
      });

      expect(result.content[0].text).toContain("Error");
    });

    it("should handle missing file gracefully", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const result = await server.callTool("nucleus_execute", {
        command: '(grep "test")',
        filePath: "./nonexistent-file.txt",
      });

      expect(result.content[0].text).toMatch(/error/i);
    });

    it("should require command and filePath", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const result = await server.callTool("nucleus_execute", {});

      expect(result.content[0].text).toContain("required");
    });
  });

  describe("session eviction", () => {
    it("should evict oldest session when exceeding max sessions", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      // Create many sessions to exceed limit (default MAX_ENGINE_SESSIONS = 20)
      for (let i = 0; i < 25; i++) {
        await server.callTool("nucleus_execute", {
          command: '(grep "test")',
          filePath: "./test-fixtures/small.txt",
          sessionId: `session-${i}`,
        });
      }

      // The server should not throw - eviction should have occurred
      const result = await server.callTool("nucleus_execute", {
        command: '(grep "test")',
        filePath: "./test-fixtures/small.txt",
        sessionId: "session-new",
      });
      expect(result.content[0].text).toContain("results");
    });
  });

  describe("nucleus_commands tool", () => {
    it("should return command reference", async () => {
      const { createMCPServer } = await import("../src/mcp-server.js");
      const server = createMCPServer();

      const result = await server.callTool("nucleus_commands", {});

      expect(result.content[0].text).toContain("grep");
      expect(result.content[0].text).toContain("filter");
      expect(result.content[0].text).toContain("RESULTS");
    });
  });

  describe("server startup", () => {
    let serverProcess: ChildProcess | null = null;

    afterAll(() => {
      if (serverProcess) {
        serverProcess.kill();
      }
    });

    it("should start without errors", async () => {
      return new Promise<void>((resolveTest, rejectTest) => {
        serverProcess = spawn("npx", ["tsx", "src/mcp-server.ts", "--test"], {
          cwd: resolve(import.meta.dirname, ".."),
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        serverProcess.stdout?.on("data", (data) => {
          stdout += data.toString();
          // Server indicates it's ready
          if (stdout.includes("MCP server ready")) {
            serverProcess?.kill();
            resolveTest();
          }
        });

        serverProcess.stderr?.on("data", (data) => {
          stderr += data.toString();
        });

        serverProcess.on("close", (code) => {
          if (code !== 0 && !stdout.includes("MCP server ready")) {
            rejectTest(new Error(`Server exited with code ${code}: ${stderr}`));
          }
        });

        // Timeout after 5 seconds
        setTimeout(() => {
          serverProcess?.kill();
          if (!stdout.includes("MCP server ready")) {
            rejectTest(new Error("Server did not start within timeout"));
          }
        }, 5000);
      });
    });
  });
});

// =====================================================================
// Source-pattern checks (from audits)
// =====================================================================
describe("Source-pattern checks (from audits)", () => {
  // from tests/audit32.test.ts #8 — engine cache should validate filePath matches
  describe("#8 — engine cache should validate filePath matches", () => {
        it("should include filePath in cache validation logic", () => {
          const source = readFileSync("src/mcp-server.ts", "utf-8");
          const getEngine = source.match(/getEngine[\s\S]*?return engine;\s*\}\s*\n/);
          expect(getEngine).not.toBeNull();
          // When sessionId is used as key, must also check that filePath matches
          // Either by storing filePath alongside or by including it in the key
          expect(getEngine![0]).toMatch(/filePath/g);
          // Should have more than just the parameter reference — needs comparison
          const filePathRefs = getEngine![0].match(/filePath/g);
          expect(filePathRefs!.length).toBeGreaterThan(3);
        });
      });

  // from tests/audit34.test.ts #5 — mcp-server should validate file paths
  describe("#5 — mcp-server should validate file paths", () => {
        it("should have path validation in getEngine or its callers", () => {
          const source = readFileSync("src/mcp-server.ts", "utf-8");
          // Path validation may be in a separate helper called before getEngine
          expect(source).toMatch(/validateFilePath|traversal|startsWith|\.\./i);
        });

        it("should validate filePath in nucleus_execute handler", () => {
          const source = readFileSync("src/mcp-server.ts", "utf-8");
          const handler = source.match(/nucleus_execute[\s\S]*?catch.*\{/);
          expect(handler).not.toBeNull();
          expect(handler![0]).toMatch(/validatePath|traversal|startsWith|resolve/i);
        });
      });

  // from tests/audit34.test.ts #6 — lattice-mcp-server should validate file paths
  describe("#6 — lattice-mcp-server should validate file paths", () => {
        it("should validate filePath in lattice_load", () => {
          const source = readFileSync("src/lattice-mcp-server.ts", "utf-8");
          const handler = source.match(/lattice_load[\s\S]*?new HandleSession/);
          expect(handler).not.toBeNull();
          expect(handler![0]).toMatch(/validatePath|traversal|startsWith|resolve|\.\.|\babsolute\b/i);
        });
      });

  // from tests/audit34.test.ts #10 — engine should be disposed on mtime reload
  describe("#10 — engine should be disposed on mtime reload", () => {
        it("should dispose old engine when file mtime changes", () => {
          const source = readFileSync("src/mcp-server.ts", "utf-8");
          const mtimeBlock = source.match(/mtimeMs > cachedMtime[\s\S]*?return engine;/);
          expect(mtimeBlock).not.toBeNull();
          // Should call dispose on old engine
          expect(mtimeBlock![0]).toMatch(/\.dispose\(\)/);
        });
      });

  // from tests/audit96.test.ts #15 — path-traversal check is segment-aware
  describe("#15 — path-traversal check is segment-aware", () => {
      it("rejects true parent-directory traversal", async () => {
        expect(hasTraversalSegment("../etc/passwd")).toBe(true);
        expect(hasTraversalSegment("..")).toBe(true);
        expect(hasTraversalSegment("foo/../bar")).toBe(true);
        expect(hasTraversalSegment("foo/bar/..")).toBe(true);
        expect(hasTraversalSegment("..\\windows\\path")).toBe(true);
        expect(hasTraversalSegment("a/b/../c/d")).toBe(true);
      });

      it("accepts legitimate filenames containing the `..` substring", async () => {
        // Before the fix these would have been rejected as path traversal.
        expect(hasTraversalSegment("readme..txt")).toBe(false);
        expect(hasTraversalSegment("foo..bar.md")).toBe(false);
        expect(hasTraversalSegment("sub/dir/file..backup")).toBe(false);
        expect(hasTraversalSegment("weird...name")).toBe(false); // 3 dots, no `..` segment
        expect(hasTraversalSegment("my.file..v2")).toBe(false);
      });

      it("accepts normal relative paths and edge cases", async () => {
        expect(hasTraversalSegment("")).toBe(false);
        expect(hasTraversalSegment(".")).toBe(false);
        expect(hasTraversalSegment("./file.txt")).toBe(false);
        expect(hasTraversalSegment("a/b/c.ts")).toBe(false);
        expect(hasTraversalSegment("/absolute/path/x.md")).toBe(false);
      });
    });

});
