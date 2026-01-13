/**
 * Tests for Qwen Synthesis Adapter
 * TDD tests for Phase 7: Synthesis-aware adapter
 */

import { describe, it, expect } from "vitest";
import { createQwenSynthesisAdapter } from "../../src/adapters/qwen-synthesis.js";

describe("Qwen Synthesis Adapter", () => {
  const adapter = createQwenSynthesisAdapter();

  describe("adapter properties", () => {
    it("should have name 'qwen-synthesis'", () => {
      expect(adapter.name).toBe("qwen-synthesis");
    });

    it("should have all required methods", () => {
      expect(typeof adapter.buildSystemPrompt).toBe("function");
      expect(typeof adapter.extractCode).toBe("function");
      expect(typeof adapter.extractFinalAnswer).toBe("function");
      expect(typeof adapter.getNoCodeFeedback).toBe("function");
      expect(typeof adapter.getErrorFeedback).toBe("function");
    });
  });

  describe("buildSystemPrompt", () => {
    it("should include synthesis instructions", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");

      expect(prompt).toContain("synthesize_regex");
      expect(prompt).toContain("synthesize_extractor");
      expect(prompt).toContain("extract_with_regex");
    });

    it("should include step-by-step process for synthesis", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");

      expect(prompt).toContain("Step 1");
      expect(prompt).toContain("Step 2");
      expect(prompt).toContain("Step 3");
    });

    it("should warn against manual regex writing", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");

      // Should discourage manual regex
      expect(prompt.toLowerCase()).toContain("do not write regex");
    });

    it("should include tool interfaces", () => {
      const toolInterfaces = "function grep(pattern: string): Array<...>";
      const prompt = adapter.buildSystemPrompt(1000, toolInterfaces);

      expect(prompt).toContain(toolInterfaces);
    });

    it("should include context length", () => {
      const prompt = adapter.buildSystemPrompt(50000, "");

      expect(prompt).toContain("50,000");
    });

    it("should include synthesis tool documentation", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");

      // Should document the synthesis tools
      expect(prompt).toContain("positive");
      expect(prompt).toContain("negative");
      expect(prompt).toContain("examples");
    });

    it("should include examples of synthesis usage", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");

      // Should show how to use synthesis
      expect(prompt).toContain("synthesize_regex(");
      expect(prompt).toContain("synthesize_extractor([");
    });
  });

  describe("getErrorFeedback", () => {
    it("should suggest synthesis for invalid regex error", () => {
      const feedback = adapter.getErrorFeedback(
        "Invalid regular expression: /[/"
      );

      expect(feedback).toContain("synthesize_regex");
    });

    it("should suggest synthesis for regex syntax error", () => {
      const feedback = adapter.getErrorFeedback(
        "SyntaxError: Invalid regular expression"
      );

      expect(feedback).toContain("synthesize_regex");
    });

    it("should remind about hit.line for match errors", () => {
      const feedback = adapter.getErrorFeedback(
        "TypeError: hit.match is not a function"
      );

      expect(feedback).toContain("hit.line");
    });

    it("should suggest extract_with_regex for extraction errors", () => {
      const feedback = adapter.getErrorFeedback(
        "TypeError: hit.match is not a function"
      );

      expect(feedback).toContain("extract_with_regex");
    });

    it("should handle generic errors", () => {
      const feedback = adapter.getErrorFeedback("Some random error");

      expect(feedback).toContain("error");
      expect(feedback).toContain("javascript");
    });
  });

  describe("getNoCodeFeedback", () => {
    it("should remind about synthesis tools", () => {
      const feedback = adapter.getNoCodeFeedback();

      // Should mention synthesis as an option
      expect(feedback).toContain("synthesize");
    });

    it("should provide code example", () => {
      const feedback = adapter.getNoCodeFeedback();

      expect(feedback).toContain("```javascript");
    });
  });

  describe("extractCode", () => {
    it("should extract standard JavaScript code block", () => {
      const response = `Here's the code:
\`\`\`javascript
const result = 42;
console.log(result);
\`\`\``;

      const code = adapter.extractCode(response);
      expect(code).toContain("const result = 42");
    });

    it("should extract code with js shorthand", () => {
      const response = `\`\`\`js
console.log("test");
\`\`\``;

      const code = adapter.extractCode(response);
      expect(code).toContain('console.log("test")');
    });

    it("should return null for no code", () => {
      const response = "Just some text without code";

      const code = adapter.extractCode(response);
      expect(code).toBeNull();
    });
  });

  describe("extractFinalAnswer", () => {
    it("should extract FINAL marker answer", () => {
      const response = `\`\`\`javascript
console.log("done");
\`\`\`
<<<FINAL>>>
The total is $500.
<<<END>>>`;

      const answer = adapter.extractFinalAnswer(response);
      expect(answer).toContain("$500");
    });

    it("should return null for no final answer", () => {
      const response = `\`\`\`javascript
console.log("working");
\`\`\``;

      const answer = adapter.extractFinalAnswer(response);
      expect(answer).toBeNull();
    });

    it("should handle JSON answers", () => {
      const response = `{
  "answer": "The total is $500",
  "total": 500
}`;

      const answer = adapter.extractFinalAnswer(response);
      expect(answer).not.toBeNull();
    });
  });
});

describe("Synthesis prompt quality", () => {
  const adapter = createQwenSynthesisAdapter();

  it("should explain when to use synthesis vs manual regex", () => {
    const prompt = adapter.buildSystemPrompt(1000, "");

    // Should explain the benefits of synthesis
    expect(prompt.toLowerCase()).toMatch(/correct|accurate|reliable/);
  });

  it("should show both positive and negative examples for regex", () => {
    const prompt = adapter.buildSystemPrompt(1000, "");

    // Should show how to use negative examples
    expect(prompt).toContain('["');
    expect(prompt).toMatch(/negative|should not match/i);
  });

  it("should show input/output pairs for extractor", () => {
    const prompt = adapter.buildSystemPrompt(1000, "");

    // Should show extractor example format
    expect(prompt).toContain("input:");
    expect(prompt).toContain("output:");
  });
});
