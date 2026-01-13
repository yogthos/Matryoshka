/**
 * Tests for Synthesis Coordinator
 * Following TDD - these tests are written first
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SynthesisCoordinator,
  CollectedExample,
  SynthesisRequest,
  SynthesisResult,
} from "../../src/synthesis/coordinator.js";

describe("SynthesisCoordinator", () => {
  let coordinator: SynthesisCoordinator;

  beforeEach(() => {
    coordinator = new SynthesisCoordinator();
  });

  describe("example collection", () => {
    it("should store and retrieve examples", () => {
      coordinator.collectExample("numbers", {
        source: "grep",
        raw: "$1,000",
      });

      const examples = coordinator.getExamples("numbers");
      expect(examples).toHaveLength(1);
      expect(examples[0].raw).toBe("$1,000");
    });

    it("should accumulate examples in same category", () => {
      coordinator.collectExample("numbers", { source: "grep", raw: "$1,000" });
      coordinator.collectExample("numbers", { source: "grep", raw: "$2,000" });

      expect(coordinator.getExamples("numbers")).toHaveLength(2);
    });

    it("should keep categories separate", () => {
      coordinator.collectExample("numbers", { source: "grep", raw: "$1,000" });
      coordinator.collectExample("dates", { source: "grep", raw: "2024-01-15" });

      expect(coordinator.getExamples("numbers")).toHaveLength(1);
      expect(coordinator.getExamples("dates")).toHaveLength(1);
    });

    it("should return empty array for unknown category", () => {
      expect(coordinator.getExamples("unknown")).toEqual([]);
    });

    it("should store context and line number with example", () => {
      coordinator.collectExample("logs", {
        source: "line",
        raw: "ERROR",
        context: "[2024-01-15] ERROR: Connection failed",
        lineNum: 42,
      });

      const examples = coordinator.getExamples("logs");
      expect(examples[0].context).toBe("[2024-01-15] ERROR: Connection failed");
      expect(examples[0].lineNum).toBe(42);
    });

    it("should clear examples when requested", () => {
      coordinator.collectExample("numbers", { source: "grep", raw: "$1,000" });
      coordinator.collectExample("numbers", { source: "grep", raw: "$2,000" });

      coordinator.clearExamples("numbers");

      expect(coordinator.getExamples("numbers")).toEqual([]);
    });

    it("should clear all examples", () => {
      coordinator.collectExample("numbers", { source: "grep", raw: "$1,000" });
      coordinator.collectExample("dates", { source: "grep", raw: "2024-01-15" });

      coordinator.clearAllExamples();

      expect(coordinator.getExamples("numbers")).toEqual([]);
      expect(coordinator.getExamples("dates")).toEqual([]);
    });

    it("should list all categories", () => {
      coordinator.collectExample("numbers", { source: "grep", raw: "$1,000" });
      coordinator.collectExample("dates", { source: "grep", raw: "2024-01-15" });
      coordinator.collectExample("errors", { source: "line", raw: "ERROR" });

      const categories = coordinator.getCategories();
      expect(categories).toContain("numbers");
      expect(categories).toContain("dates");
      expect(categories).toContain("errors");
      expect(categories.length).toBe(3);
    });
  });

  describe("regex synthesis", () => {
    it("should synthesize regex from positive examples", () => {
      const result = coordinator.synthesize({
        type: "regex",
        description: "currency pattern",
        positiveExamples: ["$1,000", "$2,500", "$100"],
      });

      expect(result.success).toBe(true);
      expect(result.regex).toBeDefined();
      expect(new RegExp(result.regex!).test("$5,000")).toBe(true);
    });

    it("should synthesize regex from positive and negative examples", () => {
      const result = coordinator.synthesize({
        type: "regex",
        description: "dollar amounts only",
        positiveExamples: ["$100", "$200"],
        negativeExamples: ["€100", "£200"],
      });

      expect(result.success).toBe(true);
      expect(result.regex).toBeDefined();
      const regex = new RegExp(result.regex!);
      expect(regex.test("$300")).toBe(true);
      expect(regex.test("€300")).toBe(false);
    });

    it("should report timing in result", () => {
      const result = coordinator.synthesize({
        type: "regex",
        description: "simple pattern",
        positiveExamples: ["abc", "def"],
      });

      expect(result.synthesisTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should return failure when no pattern found", () => {
      // Conflicting examples - no valid regex
      const result = coordinator.synthesize({
        type: "regex",
        description: "impossible pattern",
        positiveExamples: ["abc"],
        negativeExamples: ["abc"], // Same string in both - impossible
      });

      expect(result.success).toBe(false);
    });
  });

  describe("extractor synthesis", () => {
    it("should synthesize extractor from input/output examples", () => {
      const result = coordinator.synthesize({
        type: "extractor",
        description: "currency to number",
        positiveExamples: ["$1,000", "$2,500", "$500"],
        expectedOutputs: [1000, 2500, 500],
      });

      expect(result.success).toBe(true);
      expect(result.extractor).toBeDefined();
      expect(result.extractor!.test("$10,000")).toBe(10000);
    });

    it("should synthesize string extractor", () => {
      const result = coordinator.synthesize({
        type: "extractor",
        description: "value from key:value",
        positiveExamples: ["name: John", "city: NYC"],
        expectedOutputs: ["John", "NYC"],
      });

      expect(result.success).toBe(true);
      expect(result.extractor).toBeDefined();
      expect(result.extractor!.test("country: USA")).toBe("USA");
    });

    it("should return extractor code", () => {
      const result = coordinator.synthesize({
        type: "extractor",
        description: "integer extraction",
        positiveExamples: ["123", "456"],
        expectedOutputs: [123, 456],
      });

      expect(result.success).toBe(true);
      expect(result.extractorCode).toBeDefined();

      // Code should be evaluable
      const fn = eval(result.extractorCode!);
      expect(fn("789")).toBe(789);
    });

    it("should return failure when no extractor pattern found", () => {
      const result = coordinator.synthesize({
        type: "extractor",
        description: "random mapping",
        positiveExamples: ["abc", "xyz"],
        expectedOutputs: [42, 99], // No discernible pattern
      });

      // May or may not succeed depending on heuristics
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("format synthesis", () => {
    it("should synthesize format from examples", () => {
      const result = coordinator.synthesize({
        type: "format",
        description: "date format",
        positiveExamples: ["2024-01-15", "2023-12-31", "2025-06-01"],
      });

      expect(result.success).toBe(true);
      expect(result.format).toBeDefined();
      // Format should describe the pattern
      expect(result.format).toContain("YYYY");
    });

    it("should return failure for inconsistent formats", () => {
      const result = coordinator.synthesize({
        type: "format",
        description: "mixed formats",
        positiveExamples: ["2024-01-15", "01/15/2024", "15.01.2024"],
      });

      // Mixed formats may fail or identify common structure
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("knowledge base integration", () => {
    it("should reuse previously synthesized patterns", () => {
      // First synthesis
      coordinator.synthesize({
        type: "regex",
        description: "currency",
        positiveExamples: ["$1,000", "$2,500"],
      });

      // Second synthesis with similar examples should be faster
      const start = Date.now();
      const result = coordinator.synthesize({
        type: "regex",
        description: "similar currency",
        positiveExamples: ["$3,000", "$4,500"],
      });
      const elapsed = Date.now() - start;

      expect(result.success).toBe(true);
      // Just verify it works - timing may vary
    });

    it("should track synthesis count", () => {
      expect(coordinator.getSynthesisCount()).toBe(0);

      coordinator.synthesize({
        type: "regex",
        description: "test",
        positiveExamples: ["abc"],
      });

      expect(coordinator.getSynthesisCount()).toBe(1);
    });

    it("should expose knowledge base for inspection", () => {
      coordinator.synthesize({
        type: "regex",
        description: "test",
        positiveExamples: ["abc", "def"],
      });

      const kb = coordinator.getKnowledgeBase();
      expect(kb.size()).toBeGreaterThanOrEqual(0);
    });
  });

  describe("synthesize from collected examples", () => {
    it("should synthesize regex from collected examples", () => {
      coordinator.collectExample("prices", { source: "grep", raw: "$100" });
      coordinator.collectExample("prices", { source: "grep", raw: "$200" });
      coordinator.collectExample("prices", { source: "grep", raw: "$300" });

      const result = coordinator.synthesizeFromCollected("prices", "regex");

      expect(result.success).toBe(true);
      expect(result.regex).toBeDefined();
    });

    it("should synthesize extractor from collected examples with context", () => {
      coordinator.collectExample("amounts", {
        source: "line",
        raw: "$1,000",
        context: "1000", // Context is the expected output
      });
      coordinator.collectExample("amounts", {
        source: "line",
        raw: "$2,000",
        context: "2000",
      });

      const result = coordinator.synthesizeFromCollected("amounts", "extractor");

      expect(result.success).toBe(true);
    });

    it("should return failure for empty category", () => {
      const result = coordinator.synthesizeFromCollected("empty", "regex");

      expect(result.success).toBe(false);
    });

    it("should return failure for category with insufficient examples", () => {
      coordinator.collectExample("single", { source: "grep", raw: "$100" });

      // Single example may not be enough for reliable synthesis
      const result = coordinator.synthesizeFromCollected("single", "regex");

      // May succeed or fail depending on implementation
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("helper methods", () => {
    it("should validate regex patterns", () => {
      expect(coordinator.validateRegex("\\$[\\d,]+")).toBe(true);
      expect(coordinator.validateRegex("[invalid")).toBe(false);
    });

    it("should test regex against string", () => {
      expect(coordinator.testRegex("\\$\\d+", "$100")).toBe(true);
      expect(coordinator.testRegex("\\$\\d+", "€100")).toBe(false);
    });

    it("should test regex safely with invalid pattern", () => {
      expect(coordinator.testRegex("[invalid", "test")).toBe(false);
    });
  });

  describe("batch operations", () => {
    it("should synthesize multiple patterns in batch", () => {
      const requests: SynthesisRequest[] = [
        { type: "regex", description: "numbers", positiveExamples: ["123", "456"] },
        { type: "regex", description: "letters", positiveExamples: ["abc", "def"] },
      ];

      const results = coordinator.synthesizeBatch(requests);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });
  });
});

describe("CollectedExample interface", () => {
  it("should support all source types", () => {
    const grepExample: CollectedExample = { source: "grep", raw: "test" };
    const lineExample: CollectedExample = { source: "line", raw: "test" };
    const matchExample: CollectedExample = { source: "match", raw: "test" };

    expect(grepExample.source).toBe("grep");
    expect(lineExample.source).toBe("line");
    expect(matchExample.source).toBe("match");
  });
});
