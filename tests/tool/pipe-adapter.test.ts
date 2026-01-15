import { describe, it, expect } from "vitest";
import { PipeAdapter } from "../../src/tool/adapters/pipe.js";

describe("PipeAdapter", () => {
  describe("executeCommand", () => {
    it("should execute loadContent command", async () => {
      const adapter = new PipeAdapter();
      const result = await adapter.executeCommand({
        type: "loadContent",
        content: "test line\nanother line",
        name: "test-doc",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("test-doc");
    });

    it("should execute query command", async () => {
      const adapter = new PipeAdapter();
      await adapter.executeCommand({
        type: "loadContent",
        content: "error here\nok line\nerror again",
      });

      const result = await adapter.executeCommand({
        type: "query",
        command: '(grep "error")',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("2 results");
    });

    it("should execute bindings command", async () => {
      const adapter = new PipeAdapter();
      await adapter.executeCommand({ type: "loadContent", content: "test" });
      await adapter.executeCommand({ type: "query", command: '(grep "test")' });

      const result = await adapter.executeCommand({ type: "bindings" });

      expect(result.success).toBe(true);
      expect(result.message).toContain("RESULTS");
    });

    it("should execute reset command", async () => {
      const adapter = new PipeAdapter();
      await adapter.executeCommand({ type: "loadContent", content: "test" });
      await adapter.executeCommand({ type: "query", command: '(grep "test")' });
      await adapter.executeCommand({ type: "reset" });

      const result = await adapter.executeCommand({ type: "bindings" });

      expect(result.success).toBe(true);
      expect(result.message).toBe("No bindings");
    });

    it("should execute stats command", async () => {
      const adapter = new PipeAdapter();
      await adapter.executeCommand({
        type: "loadContent",
        content: "a\nb\nc",
        name: "stats-test",
      });

      const result = await adapter.executeCommand({ type: "stats" });

      expect(result.success).toBe(true);
      expect(result.message).toContain("3 lines");
    });

    it("should execute help command", async () => {
      const adapter = new PipeAdapter();
      const result = await adapter.executeCommand({ type: "help" });

      expect(result.success).toBe(true);
      expect(result.message).toContain("grep");
    });
  });

  describe("getTool", () => {
    it("should return the underlying NucleusTool", () => {
      const adapter = new PipeAdapter();
      const tool = adapter.getTool();

      expect(tool).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    it("should share state with executeCommand", async () => {
      const adapter = new PipeAdapter();

      // Load via executeCommand
      await adapter.executeCommand({
        type: "loadContent",
        content: "shared state test",
      });

      // Check via getTool
      expect(adapter.getTool().isLoaded()).toBe(true);
    });
  });
});
