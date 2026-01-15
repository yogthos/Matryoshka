import { describe, it, expect } from "vitest";
import {
  NucleusTool,
  parseCommand,
  formatResponse,
} from "../../src/tool/nucleus-tool.js";

describe("NucleusTool", () => {
  describe("loadContent", () => {
    it("should load content from string", () => {
      const tool = new NucleusTool();
      const result = tool.execute({
        type: "loadContent",
        content: "line1\nline2\nline3",
        name: "test-doc",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("test-doc");
      expect(result.message).toContain("3 lines");
    });

    it("should use default name for inline document", () => {
      const tool = new NucleusTool();
      const result = tool.execute({
        type: "loadContent",
        content: "test data",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("inline-document");
    });
  });

  describe("query", () => {
    it("should execute grep command", () => {
      const tool = new NucleusTool();
      tool.execute({ type: "loadContent", content: "error line\nok line\nerror again" });

      const result = tool.execute({ type: "query", command: '(grep "error")' });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Found 2 results");
    });

    it("should return error when no document loaded", () => {
      const tool = new NucleusTool();
      const result = tool.execute({ type: "query", command: '(grep "test")' });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No document loaded");
    });

    it("should maintain bindings across queries", () => {
      const tool = new NucleusTool();
      tool.execute({ type: "loadContent", content: "a\nb\nc\nd\ne" });
      tool.execute({ type: "query", command: '(grep "[a-z]")' }); // match all lines

      const result = tool.execute({ type: "query", command: "(count RESULTS)" });

      expect(result.success).toBe(true);
      expect(result.data).toBe(5);
    });
  });

  describe("bindings", () => {
    it("should return current bindings", () => {
      const tool = new NucleusTool();
      tool.execute({ type: "loadContent", content: "test" });
      tool.execute({ type: "query", command: '(grep "test")' });

      const result = tool.execute({ type: "bindings" });

      expect(result.success).toBe(true);
      expect(result.message).toContain("RESULTS");
    });

    it("should report no bindings when empty", () => {
      const tool = new NucleusTool();
      const result = tool.execute({ type: "bindings" });

      expect(result.success).toBe(true);
      expect(result.message).toBe("No bindings");
    });
  });

  describe("reset", () => {
    it("should clear bindings", () => {
      const tool = new NucleusTool();
      tool.execute({ type: "loadContent", content: "test" });
      tool.execute({ type: "query", command: '(grep "test")' });
      tool.execute({ type: "reset" });

      const result = tool.execute({ type: "bindings" });

      expect(result.success).toBe(true);
      expect(result.message).toBe("No bindings");
    });
  });

  describe("stats", () => {
    it("should return document statistics", () => {
      const tool = new NucleusTool();
      tool.execute({ type: "loadContent", content: "line1\nline2\nline3", name: "stats-test" });

      const result = tool.execute({ type: "stats" });

      expect(result.success).toBe(true);
      expect(result.message).toContain("stats-test");
      expect(result.message).toContain("3 lines");
    });

    it("should return error when no document loaded", () => {
      const tool = new NucleusTool();
      const result = tool.execute({ type: "stats" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No document loaded");
    });
  });

  describe("help", () => {
    it("should return help text", () => {
      const tool = new NucleusTool();
      const result = tool.execute({ type: "help" });

      expect(result.success).toBe(true);
      expect(result.message).toContain("grep");
      expect(result.message).toContain("filter");
    });
  });

  describe("isLoaded", () => {
    it("should return false initially", () => {
      const tool = new NucleusTool();
      expect(tool.isLoaded()).toBe(false);
    });

    it("should return true after loading", () => {
      const tool = new NucleusTool();
      tool.execute({ type: "loadContent", content: "test" });
      expect(tool.isLoaded()).toBe(true);
    });
  });

  describe("getDocumentName", () => {
    it("should return null initially", () => {
      const tool = new NucleusTool();
      expect(tool.getDocumentName()).toBeNull();
    });

    it("should return document name after loading", () => {
      const tool = new NucleusTool();
      tool.execute({ type: "loadContent", content: "test", name: "my-doc" });
      expect(tool.getDocumentName()).toBe("my-doc");
    });
  });
});

describe("parseCommand", () => {
  it("should parse :load command", () => {
    const cmd = parseCommand(":load ./file.txt");
    expect(cmd).toEqual({ type: "load", filePath: "./file.txt" });
  });

  it("should parse :bindings command", () => {
    expect(parseCommand(":bindings")).toEqual({ type: "bindings" });
    expect(parseCommand(":vars")).toEqual({ type: "bindings" });
  });

  it("should parse :reset command", () => {
    expect(parseCommand(":reset")).toEqual({ type: "reset" });
    expect(parseCommand(":clear")).toEqual({ type: "reset" });
  });

  it("should parse :stats command", () => {
    expect(parseCommand(":stats")).toEqual({ type: "stats" });
    expect(parseCommand(":info")).toEqual({ type: "stats" });
  });

  it("should parse :help command", () => {
    expect(parseCommand(":help")).toEqual({ type: "help" });
    expect(parseCommand(":h")).toEqual({ type: "help" });
    expect(parseCommand(":?")).toEqual({ type: "help" });
  });

  it("should parse S-expression queries", () => {
    const cmd = parseCommand('(grep "error")');
    expect(cmd).toEqual({ type: "query", command: '(grep "error")' });
  });

  it("should return null for invalid commands", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
    expect(parseCommand("invalid")).toBeNull();
    expect(parseCommand(":unknown")).toBeNull();
    expect(parseCommand(":load")).toBeNull(); // missing path
  });
});

describe("formatResponse", () => {
  it("should format success message", () => {
    const output = formatResponse({ success: true, message: "Test message" });
    expect(output).toBe("Test message");
  });

  it("should format error", () => {
    const output = formatResponse({ success: false, error: "Something failed" });
    expect(output).toBe("Error: Something failed");
  });

  it("should format array results", () => {
    const output = formatResponse({
      success: true,
      message: "Found 2 results",
      data: [
        { line: "error here", lineNum: 1 },
        { line: "error there", lineNum: 5 },
      ],
    });

    expect(output).toContain("Found 2 results");
    expect(output).toContain("[1]");
    expect(output).toContain("[5]");
  });

  it("should truncate long arrays", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      line: `line ${i}`,
      lineNum: i,
    }));

    const output = formatResponse({
      success: true,
      data: items,
    });

    expect(output).toContain("... and 10 more");
  });
});
