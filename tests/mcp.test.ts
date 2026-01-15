import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { resolve } from "node:path";

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
