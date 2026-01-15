import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HttpAdapter } from "../../src/tool/adapters/http.js";

describe("HttpAdapter", () => {
  let adapter: HttpAdapter;

  beforeEach(() => {
    // Use a random port to avoid conflicts
    const port = 10000 + Math.floor(Math.random() * 10000);
    adapter = new HttpAdapter({ port, host: "localhost" });
  });

  afterEach(async () => {
    await adapter.stop();
  });

  describe("constructor", () => {
    it("should use default options", () => {
      const defaultAdapter = new HttpAdapter();
      const info = defaultAdapter.getServerInfo();
      expect(info.port).toBe(3456);
      expect(info.host).toBe("localhost");
    });

    it("should accept custom options", () => {
      const customAdapter = new HttpAdapter({ port: 8080, host: "0.0.0.0" });
      const info = customAdapter.getServerInfo();
      expect(info.port).toBe(8080);
      expect(info.host).toBe("0.0.0.0");
    });
  });

  describe("start/stop", () => {
    it("should start and stop server", async () => {
      await adapter.start();
      await adapter.stop();
      // If we get here without error, the test passes
    });

    it("should stop gracefully when not started", async () => {
      await adapter.stop();
      // Should not throw
    });
  });

  describe("getTool", () => {
    it("should return the underlying NucleusTool", () => {
      const tool = adapter.getTool();
      expect(tool).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });
  });

  describe("getServerInfo", () => {
    it("should return host and port", () => {
      const info = adapter.getServerInfo();
      expect(info).toHaveProperty("host");
      expect(info).toHaveProperty("port");
    });
  });

  describe("HTTP endpoints (integration)", () => {
    it("should handle /health endpoint", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      const response = await fetch(`http://localhost:${port}/health`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.status).toBe("ok");
      expect(data.data.loaded).toBe(false);
    });

    it("should handle /help endpoint", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      const response = await fetch(`http://localhost:${port}/help`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain("grep");
    });

    it("should handle /bindings endpoint", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      const response = await fetch(`http://localhost:${port}/bindings`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should handle /stats without document", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      const response = await fetch(`http://localhost:${port}/stats`);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
    });

    it("should handle /load with content", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      const response = await fetch(`http://localhost:${port}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test line\nanother line", name: "test-doc" }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain("test-doc");
    });

    it("should handle /query after load", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      // Load first
      await fetch(`http://localhost:${port}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "error here\nok line\nerror again" }),
      });

      // Query
      const response = await fetch(`http://localhost:${port}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: '(grep "error")' }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain("2 results");
    });

    it("should handle /reset", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      // Load and query first
      await fetch(`http://localhost:${port}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test" }),
      });
      await fetch(`http://localhost:${port}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: '(grep "test")' }),
      });

      // Reset
      const response = await fetch(`http://localhost:${port}/reset`, {
        method: "POST",
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Verify bindings cleared
      const bindingsResponse = await fetch(`http://localhost:${port}/bindings`);
      const bindingsData = await bindingsResponse.json();
      expect(bindingsData.message).toBe("No bindings");
    });

    it("should return 404 for unknown endpoint", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      const response = await fetch(`http://localhost:${port}/unknown`);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
    });

    it("should return 405 for wrong method", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      const response = await fetch(`http://localhost:${port}/load`, {
        method: "GET",
      });
      const data = await response.json();

      expect(response.status).toBe(405);
      expect(data.success).toBe(false);
    });

    it("should handle CORS preflight", async () => {
      await adapter.start();
      const { port } = adapter.getServerInfo();

      const response = await fetch(`http://localhost:${port}/query`, {
        method: "OPTIONS",
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
