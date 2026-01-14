/**
 * Tests for the Qwen Barliman adapter
 * Verifies Barliman-style constraint-based synthesis prompting
 */

import { describe, it, expect } from "vitest";
import { createQwenBarlimanAdapter } from "../../src/adapters/qwen-barliman.js";
import { getAdapter, resolveAdapter } from "../../src/adapters/index.js";

describe("Qwen Barliman Adapter", () => {
  const adapter = createQwenBarlimanAdapter();

  describe("adapter properties", () => {
    it("should have name 'qwen-barliman'", () => {
      expect(adapter.name).toBe("qwen-barliman");
    });

    it("should be registered in the adapter registry", () => {
      const registered = getAdapter("qwen-barliman");
      expect(registered).toBeDefined();
      expect(registered?.name).toBe("qwen-barliman");
    });

    it("should be available when explicitly requested", () => {
      // Note: nucleus is now the default for all models
      // qwen-barliman is still available when explicitly requested
      const resolved = resolveAdapter("qwen2.5-coder:7b", "qwen-barliman");
      expect(resolved.name).toBe("qwen-barliman");
    });
  });

  describe("buildSystemPrompt", () => {
    const prompt = adapter.buildSystemPrompt(10000, "");

    it("should explain synthesize_extractor", () => {
      expect(prompt).toContain("synthesize_extractor");
      expect(prompt).toContain("input");
      expect(prompt).toContain("output");
    });

    it("should show classification workflow", () => {
      expect(prompt).toContain("classifier");
      expect(prompt).toContain("true");
      expect(prompt).toContain("false");
    });

    it("should explain grep API", () => {
      expect(prompt).toContain("grep");
    });

    it("should explain grep returns objects", () => {
      expect(prompt).toContain("line");
      expect(prompt).toContain("lineNum");
    });

    it("should emphasize two-step process", () => {
      expect(prompt).toContain("TURN 1");
      expect(prompt).toContain("TURN 2");
      expect(prompt).toContain("SEARCH ONLY");
    });

    it("should be generic - not domain specific", () => {
      expect(prompt).toContain("keyword");
      expect(prompt).not.toContain("SALES_DATA");
    });
  });

  describe("extractCode", () => {
    it("should extract javascript code blocks", () => {
      const response = "```javascript\nconst hits = grep('test');\n```";
      expect(adapter.extractCode(response)).toBe("const hits = grep('test');");
    });

    it("should return null for no code block", () => {
      expect(adapter.extractCode("Just text")).toBeNull();
    });
  });

  describe("extractFinalAnswer", () => {
    it("should extract FINAL delimited answer", () => {
      const response = "<<<FINAL>>>\nThe answer is 42\n<<<END>>>";
      expect(adapter.extractFinalAnswer(response)).toBe("The answer is 42");
    });
  });

  describe("getErrorFeedback", () => {
    it("should detect floating object literal errors", () => {
      const code = `{ input: "a", output: 1 }
{ input: "b", output: 2 }`;
      const feedback = adapter.getErrorFeedback("Unexpected token ':'", code);

      expect(feedback).toContain("Floating object literals");
      expect(feedback).toContain("inside an array");
    });

    it("should provide helpful feedback for grep misuse", () => {
      const feedback = adapter.getErrorFeedback(
        "Invalid flags supplied to RegExp constructor 'regionm'"
      );

      expect(feedback).toContain("ONE argument");
    });

    it("should provide helpful feedback for string method on object", () => {
      const feedback = adapter.getErrorFeedback("match is not a function");

      expect(feedback).toContain(".line");
    });
  });

  describe("getNoCodeFeedback", () => {
    const feedback = adapter.getNoCodeFeedback();

    it("should show generic example", () => {
      expect(feedback).toContain("grep");
      expect(feedback).toContain("keyword");
    });
  });
});

describe("Generic Prompting", () => {
  const adapter = createQwenBarlimanAdapter();
  const prompt = adapter.buildSystemPrompt(5000, "");

  it("should use generic placeholders", () => {
    expect(prompt).toContain("keyword");
  });

  it("should explain workflow: search then synthesize", () => {
    expect(prompt).toContain("SEARCH ONLY");
    expect(prompt).toContain("synthesize_extractor");
  });

  it("should emphasize copying exact lines", () => {
    expect(prompt).toContain("EXACT");
    expect(prompt).toContain("COPY");
  });
});
