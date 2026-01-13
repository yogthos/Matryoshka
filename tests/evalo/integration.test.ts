/**
 * Integration Tests for the Relational Synthesis Engine
 *
 * Tests the complete pipeline:
 * 1. Provide examples
 * 2. Synthesize extractor
 * 3. Compile to JavaScript
 * 4. Execute on new data
 */

import { describe, it, expect } from "vitest";
import {
  synthesizeExtractor,
  compileToFunction,
  evalExtractor,
  prettyPrint,
  inferType,
} from "../../src/synthesis/evalo/index.js";

describe("Full Synthesis Pipeline", () => {
  describe("currency extraction", () => {
    it("should synthesize and execute currency extractor", () => {
      // Step 1: Provide examples
      const examples = [
        { input: "$100", output: 100 },
        { input: "$200", output: 200 },
      ];

      // Step 2: Synthesize
      const extractors = synthesizeExtractor(examples);
      expect(extractors.length).toBeGreaterThan(0);

      const extractor = extractors[0];
      console.log("Synthesized:", prettyPrint(extractor));
      expect(inferType(extractor)).toBe("number");

      // Step 3: Compile
      const fn = compileToFunction(extractor);

      // Step 4: Execute on new data
      expect(fn("$100")).toBe(100);
      expect(fn("$200")).toBe(200);
      expect(fn("$300")).toBe(300);
      expect(fn("$999")).toBe(999);
    });

    it("should handle currency with commas", () => {
      const examples = [
        { input: "SALES: $1,234", output: 1234 },
        { input: "SALES: $5,678", output: 5678 },
      ];

      const extractors = synthesizeExtractor(examples);
      expect(extractors.length).toBeGreaterThan(0);

      const fn = compileToFunction(extractors[0]);

      expect(fn("SALES: $1,234")).toBe(1234);
      expect(fn("SALES: $9,999")).toBe(9999);
      expect(fn("SALES: $1,000,000")).toBe(1000000);
    });

    it("should handle large currency values", () => {
      const examples = [
        { input: "SALES_DATA_NORTH: $2,340,000", output: 2340000 },
        { input: "SALES_DATA_SOUTH: $3,120,000", output: 3120000 },
      ];

      const extractors = synthesizeExtractor(examples);
      expect(extractors.length).toBeGreaterThan(0);

      const fn = compileToFunction(extractors[0]);

      expect(fn("SALES_DATA_NORTH: $2,340,000")).toBe(2340000);
      expect(fn("SALES_DATA_EAST: $2,890,000")).toBe(2890000);
      expect(fn("SALES_DATA_WEST: $100,000,000")).toBe(100000000);
    });
  });

  describe("percentage extraction", () => {
    it("should synthesize percentage extractor", () => {
      const examples = [
        { input: "Growth: 50%", output: 50 },
        { input: "Growth: 75%", output: 75 },
      ];

      const extractors = synthesizeExtractor(examples);
      expect(extractors.length).toBeGreaterThan(0);

      const fn = compileToFunction(extractors[0]);

      expect(fn("Growth: 50%")).toBe(50);
      expect(fn("Growth: 100%")).toBe(100);
      expect(fn("Growth: 25%")).toBe(25);
    });
  });

  describe("key-value extraction", () => {
    it("should extract values from key: value format", () => {
      const examples = [
        { input: "count: 42", output: 42 },
        { input: "count: 100", output: 100 },
      ];

      const extractors = synthesizeExtractor(examples);
      expect(extractors.length).toBeGreaterThan(0);

      const fn = compileToFunction(extractors[0]);

      expect(fn("count: 42")).toBe(42);
      expect(fn("count: 999")).toBe(999);
    });
  });

  describe("identity and literal", () => {
    it("should synthesize identity for pass-through", () => {
      const examples = [
        { input: "hello", output: "hello" },
        { input: "world", output: "world" },
      ];

      const extractors = synthesizeExtractor(examples);
      expect(extractors.some(e => e.tag === "input")).toBe(true);

      const fn = compileToFunction(extractors[0]);
      expect(fn("anything")).toBe("anything");
    });

    it("should synthesize literal for constant output", () => {
      const examples = [
        { input: "anything", output: "CONSTANT" },
        { input: "different", output: "CONSTANT" },
      ];

      const extractors = synthesizeExtractor(examples);
      expect(extractors.some(e => e.tag === "lit")).toBe(true);

      const fn = compileToFunction(extractors[0]);
      expect(fn("ignored")).toBe("CONSTANT");
    });
  });

  describe("error handling", () => {
    it("should throw for conflicting examples", () => {
      expect(() =>
        synthesizeExtractor([
          { input: "same", output: 1 },
          { input: "same", output: 2 },
        ])
      ).toThrow(/conflict/i);
    });

    it("should throw for single example", () => {
      expect(() => synthesizeExtractor([{ input: "x", output: 1 }])).toThrow(
        /at least 2/i
      );
    });

    it("should return empty for impossible extraction", () => {
      const extractors = synthesizeExtractor([
        { input: "abc", output: 1 },
        { input: "xyz", output: 2 },
      ]);
      expect(extractors.length).toBe(0);
    });
  });
});

describe("Barliman-Style Workflow", () => {
  it("should follow the Barliman constraint-based workflow", () => {
    // 1. LLM explores document and finds data like:
    //    SALES_DATA_NORTH: $2,340,000
    //    SALES_DATA_SOUTH: $3,120,000

    // 2. LLM provides examples (constraints) to the synthesizer
    const examples = [
      { input: "$2,340,000", output: 2340000 },
      { input: "$3,120,000", output: 3120000 },
    ];

    // 3. Synthesizer finds an extractor that satisfies all constraints
    const extractors = synthesizeExtractor(examples);
    expect(extractors.length).toBeGreaterThan(0);

    // 4. The extractor is guaranteed to work on the examples
    const extractor = extractors[0];
    for (const { input, output } of examples) {
      expect(evalExtractor(extractor, input)).toBe(output);
    }

    // 5. Compile to JavaScript for runtime use
    const fn = compileToFunction(extractor);

    // 6. Apply to all matching data
    const allData = ["$2,340,000", "$3,120,000", "$2,890,000", "$2,670,000", "$1,980,000"];
    const results = allData.map(fn);

    expect(results).toEqual([2340000, 3120000, 2890000, 2670000, 1980000]);

    // 7. Sum the results
    const total = results.reduce((a, b) => (a as number) + (b as number), 0);
    expect(total).toBe(13000000);
  });
});
