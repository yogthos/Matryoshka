/**
 * Tests for the model adapter system
 */

import { describe, it, expect } from "vitest";
import {
  resolveAdapter,
  getAvailableAdapters,
  getAdapter,
  registerAdapter,
  detectAdapter,
} from "../src/adapters/index.js";
import { createBaseAdapter } from "../src/adapters/base.js";
import { createQwenAdapter } from "../src/adapters/qwen.js";
import { createDeepSeekAdapter } from "../src/adapters/deepseek.js";
import type { ModelAdapter } from "../src/adapters/types.js";

describe("Adapter Registry", () => {
  describe("getAvailableAdapters", () => {
    it("should return list of available adapters", () => {
      const adapters = getAvailableAdapters();
      expect(adapters).toContain("base");
      expect(adapters).toContain("qwen");
      expect(adapters).toContain("deepseek");
    });
  });

  describe("getAdapter", () => {
    it("should return adapter by name", () => {
      const base = getAdapter("base");
      expect(base).toBeDefined();
      expect(base?.name).toBe("base");

      const qwen = getAdapter("qwen");
      expect(qwen).toBeDefined();
      expect(qwen?.name).toBe("qwen");
    });

    it("should return undefined for unknown adapter", () => {
      const unknown = getAdapter("nonexistent");
      expect(unknown).toBeUndefined();
    });
  });

  describe("detectAdapter", () => {
    it("should default to nucleus adapter for all models", () => {
      // All models now use nucleus by default for LC-based synthesis
      expect(detectAdapter("qwen2.5-coder:7b")).toBe("nucleus");
      expect(detectAdapter("qwen-1.5:14b")).toBe("nucleus");
      expect(detectAdapter("codeqwen:latest")).toBe("nucleus");
      expect(detectAdapter("deepseek-chat")).toBe("nucleus");
      expect(detectAdapter("deepseek-coder")).toBe("nucleus");
      expect(detectAdapter("llama3:latest")).toBe("nucleus");
      expect(detectAdapter("mistral:7b")).toBe("nucleus");
      expect(detectAdapter("unknown-model")).toBe("nucleus");
    });
  });

  describe("resolveAdapter", () => {
    it("should use explicit adapter when provided", () => {
      const adapter = resolveAdapter("llama3:latest", "qwen");
      expect(adapter.name).toBe("qwen");
    });

    it("should default to nucleus when no explicit adapter provided", () => {
      // All models now default to nucleus for LC-based synthesis
      const adapter = resolveAdapter("qwen2.5-coder:7b");
      expect(adapter.name).toBe("nucleus");
    });

    it("should default to nucleus for any model", () => {
      const adapter = resolveAdapter("unknown-model");
      expect(adapter.name).toBe("nucleus");
    });

    it("should fall back to base for unknown explicit adapter", () => {
      const adapter = resolveAdapter("qwen:7b", "nonexistent");
      expect(adapter.name).toBe("base");
    });
  });

  describe("registerAdapter", () => {
    it("should allow registering custom adapters", () => {
      const customAdapter: ModelAdapter = {
        name: "custom",
        buildSystemPrompt: () => "Custom prompt",
        extractCode: () => null,
        extractFinalAnswer: () => null,
        getNoCodeFeedback: () => "No code",
        getErrorFeedback: () => "Error",
        getSuccessFeedback: () => "Success",
        getRepeatedCodeFeedback: () => "Repeated",
      };

      registerAdapter("custom", () => customAdapter);

      const adapter = getAdapter("custom");
      expect(adapter).toBeDefined();
      expect(adapter?.name).toBe("custom");
      expect(adapter?.buildSystemPrompt(100, "")).toBe("Custom prompt");
    });
  });
});

describe("Base Adapter", () => {
  const adapter = createBaseAdapter();

  describe("buildSystemPrompt", () => {
    it("should include document length", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");
      expect(prompt).toContain("1,000");
    });

    it("should include tool interfaces", () => {
      const tools = "function grep(pattern: string): Result[];";
      const prompt = adapter.buildSystemPrompt(1000, tools);
      expect(prompt).toContain(tools);
    });

    it("should include FINAL markers instruction", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");
      expect(prompt).toContain("<<<FINAL>>>");
      expect(prompt).toContain("<<<END>>>");
    });
  });

  describe("extractCode", () => {
    it("should extract javascript code blocks", () => {
      const response = "```javascript\nconsole.log('hello');\n```";
      expect(adapter.extractCode(response)).toBe("console.log('hello');");
    });

    it("should extract typescript code blocks", () => {
      const response = "```typescript\nconst x: number = 1;\n```";
      expect(adapter.extractCode(response)).toBe("const x: number = 1;");
    });

    it("should return null for no code block", () => {
      expect(adapter.extractCode("Just some text")).toBeNull();
    });
  });

  describe("extractFinalAnswer", () => {
    it("should extract FINAL delimited answer", () => {
      const response = "<<<FINAL>>>\nThe answer is 42\n<<<END>>>";
      expect(adapter.extractFinalAnswer(response)).toBe("The answer is 42");
    });

    it("should extract FINAL_VAR marker", () => {
      const response = "FINAL_VAR(memory)";
      const result = adapter.extractFinalAnswer(response);
      expect(result).toEqual({ type: "var", name: "memory" });
    });

    it("should extract JSON answer with totalSales field", () => {
      const response = '```json\n{"totalSales": "$13,000"}\n```';
      const result = adapter.extractFinalAnswer(response);
      expect(result).not.toBeNull();
      expect(result).toContain("totalSales");
    });

    it("should return null for no answer marker", () => {
      expect(adapter.extractFinalAnswer("Still working...")).toBeNull();
    });
  });

  describe("feedback methods", () => {
    it("should provide no-code feedback", () => {
      const feedback = adapter.getNoCodeFeedback();
      expect(feedback).toContain("code");
      expect(feedback).toContain("```javascript");
    });

    it("should provide error feedback", () => {
      const feedback = adapter.getErrorFeedback("TypeError: x is undefined");
      expect(feedback).toContain("error");
    });

    it("should provide success feedback", () => {
      const feedback = adapter.getSuccessFeedback();
      expect(feedback).toContain("persist");
      expect(feedback).toContain("FINAL");
    });

    it("should provide repeated code feedback", () => {
      const feedback = adapter.getRepeatedCodeFeedback();
      expect(feedback).toContain("repeating");
      expect(feedback).toContain("DIFFERENT");
    });
  });
});

describe("Qwen Adapter", () => {
  const adapter = createQwenAdapter();

  it("should have name 'qwen'", () => {
    expect(adapter.name).toBe("qwen");
  });

  describe("buildSystemPrompt", () => {
    it("should include code-only emphasis", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");
      expect(prompt).toContain("ONLY output");
    });

    it("should include document length", () => {
      const prompt = adapter.buildSystemPrompt(5000, "");
      expect(prompt).toContain("5,000");
    });
  });

  describe("extractCode", () => {
    it("should extract standard code blocks", () => {
      const response = "```javascript\nconsole.log('test');\n```";
      expect(adapter.extractCode(response)).toBe("console.log('test');");
    });

    it("should extract loose js code blocks", () => {
      const response = "```js\nconst x = 1;\n```";
      expect(adapter.extractCode(response)).toBe("const x = 1;");
    });
  });

  describe("extractFinalAnswer", () => {
    it("should extract bare JSON with answer fields", () => {
      const response = '{"totalSales": 1000, "count": 5}';
      const result = adapter.extractFinalAnswer(response);
      expect(result).not.toBeNull();
    });

    it("should not extract bare JSON without answer fields", () => {
      const response = '{"foo": "bar", "baz": 123}';
      const result = adapter.extractFinalAnswer(response);
      expect(result).toBeNull();
    });
  });

  describe("feedback methods", () => {
    it("should provide success feedback with JavaScript emphasis", () => {
      const feedback = adapter.getSuccessFeedback();
      expect(feedback).toContain("javascript");
      expect(feedback).toContain("NO PYTHON");
    });

    it("should provide repeated code feedback with JavaScript example", () => {
      const feedback = adapter.getRepeatedCodeFeedback();
      expect(feedback).toContain("JavaScript");
      expect(feedback).toContain("```javascript");
    });
  });
});

describe("DeepSeek Adapter", () => {
  const adapter = createDeepSeekAdapter();

  it("should have name 'deepseek'", () => {
    expect(adapter.name).toBe("deepseek");
  });

  describe("buildSystemPrompt", () => {
    it("should include role definition", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");
      expect(prompt).toContain("Role");
    });

    it("should include structured format", () => {
      const prompt = adapter.buildSystemPrompt(1000, "");
      expect(prompt).toContain("# ");
    });
  });

  describe("extractCode", () => {
    it("should extract code blocks", () => {
      const response = "```javascript\ngrep('test');\n```";
      expect(adapter.extractCode(response)).toBe("grep('test');");
    });
  });
});
