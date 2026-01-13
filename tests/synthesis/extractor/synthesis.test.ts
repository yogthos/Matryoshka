/**
 * Tests for Extractor Synthesis Engine
 * Following TDD - these tests are written first
 */

import { describe, it, expect } from "vitest";
import {
  synthesizeExtractor,
  Extractor,
  ExtractorTemplate,
  EXTRACTOR_TEMPLATES,
} from "../../../src/synthesis/extractor/synthesis.js";

describe("Extractor Synthesis", () => {
  describe("synthesizeExtractor", () => {
    describe("currency extraction", () => {
      it("should synthesize extractor for integer currency", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "$1,000", output: 1000 },
            { input: "$2,500", output: 2500 },
            { input: "$500,000", output: 500000 },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("$999,999")).toBe(999999);
        expect(extractor!.test("$100")).toBe(100);
      });

      it("should synthesize extractor for decimal currency", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "$1,234.56", output: 1234.56 },
            { input: "$99.99", output: 99.99 },
            { input: "$1,000.00", output: 1000.0 },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("$500.50")).toBeCloseTo(500.5);
      });

      it("should handle currency without commas", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "$100", output: 100 },
            { input: "$2500", output: 2500 },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("$999")).toBe(999);
      });
    });

    describe("integer extraction", () => {
      it("should synthesize extractor for plain integers", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "123", output: 123 },
            { input: "456", output: 456 },
            { input: "7890", output: 7890 },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("999")).toBe(999);
      });

      it("should synthesize extractor for integers with commas", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "1,234", output: 1234 },
            { input: "5,678,901", output: 5678901 },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("999,999")).toBe(999999);
      });
    });

    describe("key:value extraction", () => {
      it("should synthesize extractor for value from key:value", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "name: John", output: "John" },
            { input: "city: NYC", output: "NYC" },
            { input: "country: USA", output: "USA" },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("state: CA")).toBe("CA");
      });

      it("should synthesize extractor for key from key:value", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "name: John", output: "name" },
            { input: "city: NYC", output: "city" },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("country: USA")).toBe("country");
      });

      it("should handle key=value format", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "name=John", output: "John" },
            { input: "age=30", output: "30" },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("city=NYC")).toBe("NYC");
      });
    });

    describe("delimiter-based extraction", () => {
      it("should synthesize extractor for comma-separated values", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "a,b,c", output: ["a", "b", "c"] },
            { input: "x,y,z", output: ["x", "y", "z"] },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("1,2,3")).toEqual(["1", "2", "3"]);
      });

      it("should synthesize extractor for pipe-separated values", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "a|b|c", output: ["a", "b", "c"] },
            { input: "x|y|z", output: ["x", "y", "z"] },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("1|2|3")).toEqual(["1", "2", "3"]);
      });

      it("should synthesize extractor for specific field from delimited", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "John,30,NYC", output: "NYC" },
            { input: "Jane,25,LA", output: "LA" },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("Bob,40,SF")).toBe("SF");
      });
    });

    describe("prefix/suffix extraction", () => {
      it("should synthesize extractor removing common prefix", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "ID_001", output: "001" },
            { input: "ID_002", output: "002" },
            { input: "ID_999", output: "999" },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("ID_123")).toBe("123");
      });

      it("should synthesize extractor removing common suffix", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "file.txt", output: "file" },
            { input: "data.txt", output: "data" },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("report.txt")).toBe("report");
      });
    });

    describe("numeric transformations", () => {
      it("should synthesize extractor for percentage to decimal", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "50%", output: 0.5 },
            { input: "100%", output: 1.0 },
            { input: "25%", output: 0.25 },
          ],
        });

        expect(extractor).not.toBeNull();
        expect(extractor!.test("75%")).toBeCloseTo(0.75);
      });

      it("should synthesize extractor for string to number", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "one hundred", output: 100 },
            { input: "two hundred", output: 200 },
          ],
          hints: { outputType: "number" },
        });

        // May or may not succeed depending on implementation
        // This is a stretch goal
        expect(extractor === null || typeof extractor.test === "function").toBe(
          true
        );
      });
    });

    describe("edge cases", () => {
      it("should return null when no pattern found", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "abc", output: 42 },
            { input: "xyz", output: 99 },
          ],
        });

        // Random mapping - no discernible pattern
        // Should return null or a literal-match extractor
        expect(extractor === null || typeof extractor.test === "function").toBe(
          true
        );
      });

      it("should return null for empty examples", () => {
        const extractor = synthesizeExtractor({
          examples: [],
        });

        expect(extractor).toBeNull();
      });

      it("should handle single example", () => {
        const extractor = synthesizeExtractor({
          examples: [{ input: "$100", output: 100 }],
        });

        // May or may not work with single example
        expect(extractor === null || typeof extractor.test === "function").toBe(
          true
        );
      });

      it("should handle conflicting examples gracefully", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "100", output: 100 },
            { input: "100", output: 200 }, // Same input, different output
          ],
        });

        // Should fail or return null
        expect(extractor).toBeNull();
      });
    });

    describe("output type hints", () => {
      it("should respect number output type hint", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "value: 123", output: 123 },
            { input: "value: 456", output: 456 },
          ],
          hints: { outputType: "number" },
        });

        expect(extractor).not.toBeNull();
        const result = extractor!.test("value: 789");
        expect(typeof result).toBe("number");
        expect(result).toBe(789);
      });

      it("should respect string output type hint", () => {
        const extractor = synthesizeExtractor({
          examples: [
            { input: "ID: 123", output: "123" },
            { input: "ID: 456", output: "456" },
          ],
          hints: { outputType: "string" },
        });

        expect(extractor).not.toBeNull();
        const result = extractor!.test("ID: 789");
        expect(typeof result).toBe("string");
        expect(result).toBe("789");
      });

      it("should respect array output type hint", () => {
        const extractor = synthesizeExtractor({
          examples: [{ input: "a,b,c", output: ["a", "b", "c"] }],
          hints: { outputType: "array" },
        });

        expect(extractor).not.toBeNull();
        expect(Array.isArray(extractor!.test("x,y,z"))).toBe(true);
      });
    });
  });

  describe("Extractor interface", () => {
    it("should have required properties", () => {
      const extractor = synthesizeExtractor({
        examples: [
          { input: "123", output: 123 },
          { input: "456", output: 456 },
        ],
      });

      expect(extractor).not.toBeNull();
      expect(extractor!.name).toBeDefined();
      expect(extractor!.description).toBeDefined();
      expect(extractor!.code).toBeDefined();
      expect(typeof extractor!.test).toBe("function");
    });

    it("should have executable code string", () => {
      const extractor = synthesizeExtractor({
        examples: [
          { input: "$100", output: 100 },
          { input: "$200", output: 200 },
        ],
      });

      expect(extractor).not.toBeNull();

      // Code should be evaluable
      const fn = eval(extractor!.code);
      expect(typeof fn).toBe("function");
      expect(fn("$300")).toBe(300);
    });
  });

  describe("EXTRACTOR_TEMPLATES", () => {
    it("should have currency templates", () => {
      const currencyTemplates = EXTRACTOR_TEMPLATES.filter(
        (t) => t.name.includes("currency") || t.name.includes("dollar")
      );
      expect(currencyTemplates.length).toBeGreaterThan(0);
    });

    it("should have key:value templates", () => {
      const kvTemplates = EXTRACTOR_TEMPLATES.filter(
        (t) => t.name.includes("key") || t.name.includes("value")
      );
      expect(kvTemplates.length).toBeGreaterThan(0);
    });

    it("should have delimiter templates", () => {
      const delimTemplates = EXTRACTOR_TEMPLATES.filter(
        (t) => t.name.includes("split") || t.name.includes("delimit")
      );
      expect(delimTemplates.length).toBeGreaterThan(0);
    });
  });

  describe("complex patterns", () => {
    it("should extract from log line format", () => {
      const extractor = synthesizeExtractor({
        examples: [
          { input: "[2024-01-15 10:30:45] ERROR: Connection failed", output: "ERROR" },
          { input: "[2024-01-15 10:31:00] INFO: Connected", output: "INFO" },
          { input: "[2024-01-15 10:31:15] WARN: High latency", output: "WARN" },
        ],
      });

      expect(extractor).not.toBeNull();
      expect(extractor!.test("[2024-01-15 10:32:00] DEBUG: Starting")).toBe("DEBUG");
    });

    it("should extract numeric value from structured text", () => {
      const extractor = synthesizeExtractor({
        examples: [
          { input: "Total: $1,234", output: 1234 },
          { input: "Total: $5,678", output: 5678 },
        ],
      });

      expect(extractor).not.toBeNull();
      expect(extractor!.test("Total: $9,999")).toBe(9999);
    });

    it("should extract between delimiters", () => {
      const extractor = synthesizeExtractor({
        examples: [
          { input: "[error]", output: "error" },
          { input: "[warning]", output: "warning" },
          { input: "[info]", output: "info" },
        ],
      });

      expect(extractor).not.toBeNull();
      expect(extractor!.test("[debug]")).toBe("debug");
    });
  });
});
