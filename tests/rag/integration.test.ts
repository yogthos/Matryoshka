/**
 * Integration tests for RAG with Adapters
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRAGManager, type RAGManager } from "../../src/rag/manager.js";
import { createBaseAdapter } from "../../src/adapters/base.js";
import { createQwenAdapter } from "../../src/adapters/qwen.js";
import { createDeepSeekAdapter } from "../../src/adapters/deepseek.js";
import type { RAGHints } from "../../src/adapters/types.js";

describe("RAG + Adapter Integration", () => {
  let manager: RAGManager;

  beforeEach(() => {
    manager = createRAGManager();
  });

  describe("hints injection into system prompts", () => {
    it("should inject hints into base adapter prompt", () => {
      const hints = manager.getHints("sum up total sales revenue", 2);
      const hintsText = manager.formatHintsForPrompt(hints);

      const ragHints: RAGHints = {
        hintsText,
        selfCorrectionText: undefined,
      };

      const adapter = createBaseAdapter();
      const prompt = adapter.buildSystemPrompt(1000, "// tools here", ragHints);

      expect(prompt).toContain("RELEVANT PATTERNS FROM MEMORY");
      expect(prompt).toContain("```javascript");
    });

    it("should inject hints into Qwen adapter prompt", () => {
      const hints = manager.getHints("count errors in log", 2);
      const hintsText = manager.formatHintsForPrompt(hints);

      const ragHints: RAGHints = {
        hintsText,
        selfCorrectionText: undefined,
      };

      const adapter = createQwenAdapter();
      const prompt = adapter.buildSystemPrompt(1000, "// tools here", ragHints);

      expect(prompt).toContain("RELEVANT PATTERNS FROM MEMORY");
    });

    it("should inject hints into DeepSeek adapter prompt", () => {
      const hints = manager.getHints("extract dates from document", 2);
      const hintsText = manager.formatHintsForPrompt(hints);

      const ragHints: RAGHints = {
        hintsText,
        selfCorrectionText: undefined,
      };

      const adapter = createDeepSeekAdapter();
      const prompt = adapter.buildSystemPrompt(1000, "// tools here", ragHints);

      expect(prompt).toContain("RELEVANT PATTERNS FROM MEMORY");
    });

    it("should handle empty hints gracefully", () => {
      const ragHints: RAGHints = {
        hintsText: "",
        selfCorrectionText: undefined,
      };

      const adapter = createBaseAdapter();
      const prompt = adapter.buildSystemPrompt(1000, "// tools here", ragHints);

      // Should not have hints section when empty
      expect(prompt).not.toContain("RELEVANT PATTERNS FROM MEMORY");
      // But should still have core prompt content
      expect(prompt).toContain("JavaScript runtime");
    });

    it("should handle undefined hints gracefully", () => {
      const adapter = createBaseAdapter();
      const prompt = adapter.buildSystemPrompt(1000, "// tools here", undefined);

      expect(prompt).not.toContain("RELEVANT PATTERNS FROM MEMORY");
      expect(prompt).toContain("JavaScript runtime");
    });
  });

  describe("self-correction feedback injection", () => {
    it("should inject self-correction feedback into prompt", () => {
      manager.recordFailure({
        query: "sum values",
        code: "const x = broken;",
        error: "ReferenceError: broken is not defined",
        timestamp: Date.now(),
        sessionId: "test-session",
      });

      const hints = manager.getHints("sum values", 2);
      const hintsText = manager.formatHintsForPrompt(hints);
      const selfCorrectionText = manager.generateSelfCorrectionFeedback("test-session");

      const ragHints: RAGHints = {
        hintsText,
        selfCorrectionText: selfCorrectionText || undefined,
      };

      const adapter = createBaseAdapter();
      const prompt = adapter.buildSystemPrompt(1000, "// tools here", ragHints);

      expect(prompt).toContain("SELF-CORRECTION");
      expect(prompt).toContain("ReferenceError");
    });

    it("should include both hints and self-correction when both present", () => {
      manager.recordFailure({
        query: "count items",
        code: "const x = undefined.length;",
        error: "TypeError: Cannot read property 'length' of undefined",
        timestamp: Date.now(),
        sessionId: "test-session-2",
      });

      const hints = manager.getHints("count items", 2);
      const hintsText = manager.formatHintsForPrompt(hints);
      const selfCorrectionText = manager.generateSelfCorrectionFeedback("test-session-2");

      const ragHints: RAGHints = {
        hintsText,
        selfCorrectionText: selfCorrectionText || undefined,
      };

      const adapter = createBaseAdapter();
      const prompt = adapter.buildSystemPrompt(1000, "// tools here", ragHints);

      // Should have both sections
      expect(prompt).toContain("RELEVANT PATTERNS");
      expect(prompt).toContain("SELF-CORRECTION");
    });
  });

  describe("hint relevance for different task types", () => {
    it("should return aggregation hints for sum queries", () => {
      const hints = manager.getHints("add up all the values", 3);
      const hasAggregation = hints.some(h =>
        h.content.includes("total") || h.content.includes("sum")
      );
      expect(hasAggregation).toBe(true);
    });

    it("should return search hints for find queries", () => {
      const hints = manager.getHints("find all occurrences of ERROR", 3);
      const hasSearch = hints.some(h => h.content.includes("grep"));
      expect(hasSearch).toBe(true);
    });

    it("should return extraction hints for parse queries", () => {
      const hints = manager.getHints("extract the price values", 3);
      const hasExtraction = hints.some(h =>
        h.content.includes("match") || h.content.includes("extract") || h.content.includes("map")
      );
      expect(hasExtraction).toBe(true);
    });

    it("should return classification hints for filter queries", () => {
      const hints = manager.getHints("find all failed items", 3);
      const hasClassification = hints.some(h =>
        h.content.includes("classify") || h.content.includes("filter") || h.content.includes("classifier")
      );
      expect(hasClassification).toBe(true);
    });
  });
});
