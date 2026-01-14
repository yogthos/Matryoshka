/**
 * Tests for the Nucleus adapter
 */

import { describe, it, expect } from "vitest";
import { createNucleusAdapter } from "../../src/adapters/nucleus.js";
import { getAdapter, resolveAdapter } from "../../src/adapters/index.js";

describe("Nucleus Adapter", () => {
  const adapter = createNucleusAdapter();

  describe("adapter properties", () => {
    it("should have name 'nucleus'", () => {
      expect(adapter.name).toBe("nucleus");
    });

    it("should be registered in the adapter registry", () => {
      const registered = getAdapter("nucleus");
      expect(registered).toBeDefined();
      expect(registered?.name).toBe("nucleus");
    });
  });

  describe("buildSystemPrompt", () => {
    const prompt = adapter.buildSystemPrompt(10000, "");

    it("should explain core operations", () => {
      expect(prompt).toContain("grep");
      expect(prompt).toContain("sum");
      expect(prompt).toContain("count");
    });

    it("should explain available commands", () => {
      expect(prompt).toContain("COMMANDS");
      expect(prompt).toContain("grep");
      expect(prompt).toContain("sum");
    });

    it("should be reasonably sized", () => {
      // Prompt should be under 800 chars for efficiency
      expect(prompt.length).toBeLessThan(800);
    });

    it("should show final answer format", () => {
      expect(prompt).toContain("<<<FINAL>>>");
      expect(prompt).toContain("<<<END>>>");
    });
  });

  describe("extractCode", () => {
    it("should extract S-expression from response", () => {
      const response = 'Here is my search:\n(grep "webhook")';
      expect(adapter.extractCode(response)).toBe('(grep "webhook")');
    });

    it("should extract multi-line S-expression", () => {
      const response = `(classify
  "line1" true
  "line2" false)`;
      const extracted = adapter.extractCode(response);
      expect(extracted).toContain("classify");
    });

    it("should extract constrained term", () => {
      const response = '[Σ⚡μ] ⊗ (grep "test")';
      expect(adapter.extractCode(response)).toBe('[Σ⚡μ] ⊗ (grep "test")');
    });

    it("should extract from code block", () => {
      const response = "```lisp\n(grep \"test\")\n```";
      expect(adapter.extractCode(response)).toBe('(grep "test")');
    });

    it("should return null for no S-expression", () => {
      expect(adapter.extractCode("Just text")).toBeNull();
    });

    // JSON-to-S-expression fallback tests
    it("should convert JSON grep to S-expression", () => {
      const response = '```json\n{"action": "grep", "pattern": "webhook"}\n```';
      expect(adapter.extractCode(response)).toBe('(grep "webhook")');
    });

    it("should convert JSON filter to S-expression", () => {
      const response = '{"action": "filter", "collection": "RESULTS", "pattern": "failed"}';
      expect(adapter.extractCode(response)).toBe('(filter RESULTS (lambda x (match x "failed" 0)))');
    });

    it("should convert JSON search to S-expression", () => {
      const response = '{"operation": "search", "query": "error"}';
      expect(adapter.extractCode(response)).toBe('(grep "error")');
    });

    it("should prefer S-expression over JSON when both present", () => {
      const response = '(grep "direct") and also {"action": "grep", "pattern": "json"}';
      expect(adapter.extractCode(response)).toBe('(grep "direct")');
    });
  });

  describe("extractFinalAnswer", () => {
    it("should extract FINAL delimited answer", () => {
      const response = "<<<FINAL>>>\nFound 5 items\n<<<END>>>";
      expect(adapter.extractFinalAnswer(response)).toBe("Found 5 items");
    });

    it("should extract FINAL from inside code block", () => {
      const response = "```plaintext\n<<<FINAL>>>\nThe answer is 42\n```";
      expect(adapter.extractFinalAnswer(response)).toBe("The answer is 42");
    });

    it("should extract FINAL without END marker", () => {
      const response = "Here is my answer:\n<<<FINAL>>>\nFound 3 items\n```";
      expect(adapter.extractFinalAnswer(response)).toBe("Found 3 items");
    });

    it("should extract FINAL_VAR marker", () => {
      const response = "FINAL_VAR(results)";
      const result = adapter.extractFinalAnswer(response);
      expect(result).toEqual({ type: "var", name: "results" });
    });

    it("should return null for no final answer", () => {
      expect(adapter.extractFinalAnswer("No answer here")).toBeNull();
    });
  });

  describe("getNoCodeFeedback", () => {
    const feedback = adapter.getNoCodeFeedback();

    it("should show example S-expression", () => {
      expect(feedback).toContain("grep");
      expect(feedback).toContain("(");
      expect(feedback).toContain("Next:");
    });
  });

  describe("getErrorFeedback", () => {
    it("should detect Python-style lambda", () => {
      const feedback = adapter.getErrorFeedback("parse error", '(lambda x: "test" in x)');
      expect(feedback).toContain("syntax");
    });

    it("should show valid commands", () => {
      const feedback = adapter.getErrorFeedback("any error");
      expect(feedback).toContain("grep");
      expect(feedback).toContain("filter");
    });
  });

  describe("getSuccessFeedback", () => {
    it("should show count and next prompt when results exist", () => {
      const feedback = adapter.getSuccessFeedback(5, undefined, "test query");
      expect(feedback).toContain("5");
      expect(feedback).toContain("Next:");
    });

    it("should suggest different terms when results empty", () => {
      const feedback = adapter.getSuccessFeedback(0);
      expect(feedback).toContain("different");
      expect(feedback).toContain("Next:");
    });

    it("should warn when filter matched nothing", () => {
      const feedback = adapter.getSuccessFeedback(0, 10);
      expect(feedback).toContain("Filter");
      expect(feedback).toContain("different");
    });
  });

  describe("getRepeatedCodeFeedback", () => {
    it("should encourage using RESULTS when results exist", () => {
      const feedback = adapter.getRepeatedCodeFeedback(5);
      expect(feedback).toContain("RESULTS");
      expect(feedback).toContain("FINAL");
    });

    it("should suggest different keyword when results empty", () => {
      const feedback = adapter.getRepeatedCodeFeedback(0);
      expect(feedback).toContain("different");
    });

    it("should default to RESULTS guidance with no count", () => {
      const feedback = adapter.getRepeatedCodeFeedback();
      expect(feedback).toContain("RESULTS");
    });
  });
});
