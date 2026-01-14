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

    it("should explain DSL forms", () => {
      expect(prompt).toContain("grep");
      expect(prompt).toContain("filter");
      expect(prompt).toContain("map");
    });

    it("should explain workflow", () => {
      expect(prompt).toContain("Turn 1");
      expect(prompt).toContain("Turn 2");
      expect(prompt).toContain("RESULTS");
    });

    it("should emphasize S-expression output", () => {
      expect(prompt).toContain("S-expression");
      expect(prompt).toContain("SEARCH STRATEGY");
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
    });
  });

  describe("getErrorFeedback", () => {
    it("should show the failed code", () => {
      const feedback = adapter.getErrorFeedback("parse error", '{"bad": "json"}');
      expect(feedback).toContain('{"bad": "json"}');
    });

    it("should show valid commands", () => {
      const feedback = adapter.getErrorFeedback("any error");
      expect(feedback).toContain("grep");
      expect(feedback).toContain("filter");
      expect(feedback).toContain("FINAL");
    });
  });

  describe("getSuccessFeedback", () => {
    it("should mention RESULTS and FINAL when results exist", () => {
      const feedback = adapter.getSuccessFeedback(5);
      expect(feedback).toContain("RESULTS");
      expect(feedback).toContain("FINAL");
    });

    it("should encourage different search when results empty", () => {
      const feedback = adapter.getSuccessFeedback(0);
      expect(feedback).toContain("DIFFERENT search");
    });

    it("should warn when filter removed all results", () => {
      const feedback = adapter.getSuccessFeedback(0, 10);
      expect(feedback).toContain("Filter removed all results");
      expect(feedback).toContain("_1");
    });
  });

  describe("getRepeatedCodeFeedback", () => {
    it("should encourage reporting the answer when results exist", () => {
      const feedback = adapter.getRepeatedCodeFeedback(5);
      expect(feedback).toContain("REPORT YOUR ANSWER");
      expect(feedback).toContain("RESULTS");
      expect(feedback).toContain("<<<FINAL>>>");
    });

    it("should suggest different search when results empty", () => {
      const feedback = adapter.getRepeatedCodeFeedback(0);
      expect(feedback).toContain("DIFFERENT search");
      expect(feedback).toContain("single keywords");
    });

    it("should default to answer encouragement with no count", () => {
      const feedback = adapter.getRepeatedCodeFeedback();
      expect(feedback).toContain("REPORT YOUR ANSWER");
    });
  });
});
