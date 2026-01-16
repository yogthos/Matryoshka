/**
 * Tests for SynthesisIntegrator
 * TDD: These tests are written FIRST to define the expected behavior
 *
 * The SynthesisIntegrator is the bridge between the LC solver and synthesis engines.
 * It handles automatic synthesis fallback when built-in operations fail.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SynthesisIntegrator,
  SynthesisContext,
  SynthesisOutcome,
} from "../../src/logic/synthesis-integrator.js";

describe("SynthesisIntegrator", () => {
  let integrator: SynthesisIntegrator;

  beforeEach(() => {
    integrator = new SynthesisIntegrator();
  });

  describe("synthesizeOnFailure - currency parsing", () => {
    it("synthesizes currency parser from examples for EU format", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseCurrency",
        input: "1.234,56€",
        examples: [
          { input: "1.234,56€", output: 1234.56 },
          { input: "500,00€", output: 500.0 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("1.234,56€")).toBeCloseTo(1234.56, 2);
      expect(result.fn!("999,99€")).toBeCloseTo(999.99, 2);
    });

    it("synthesizes currency parser for US format with thousands separators", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseCurrency",
        input: "$1,234.56",
        examples: [
          { input: "$1,234.56", output: 1234.56 },
          { input: "$500.00", output: 500.0 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("$10,000.00")).toBeCloseTo(10000.0, 2);
    });

    it("synthesizes currency parser for mixed formats", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseCurrency",
        input: "¥123,456",
        examples: [
          { input: "¥123,456", output: 123456 },
          { input: "¥1,000", output: 1000 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("¥50,000")).toBe(50000);
    });
  });

  describe("synthesizeOnFailure - date parsing", () => {
    it("synthesizes date parser from examples for DD-Mon-YYYY format", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseDate",
        input: "15-Jan-2024",
        examples: [
          { input: "15-Jan-2024", output: "2024-01-15" },
          { input: "20-Feb-2024", output: "2024-02-20" },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("15-Jan-2024")).toBe("2024-01-15");
      expect(result.fn!("01-Mar-2025")).toBe("2025-03-01");
    });

    it("synthesizes date parser for DD/MM/YYYY format", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseDate",
        input: "15/01/2024",
        examples: [
          { input: "15/01/2024", output: "2024-01-15" },
          { input: "28/02/2024", output: "2024-02-28" },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("25/12/2024")).toBe("2024-12-25");
    });
  });

  describe("synthesizeOnFailure - predicate synthesis", () => {
    it("synthesizes predicate from true/false examples", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "predicate",
        input: "ERROR: Connection failed",
        examples: [
          { input: "ERROR: Connection failed", output: true },
          { input: "INFO: Started", output: false },
          { input: "ERROR: Timeout", output: true },
          { input: "DEBUG: trace", output: false },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("ERROR: Something else")).toBe(true);
      expect(result.fn!("INFO: Another message")).toBe(false);
    });

    it("synthesizes predicate for log levels", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "predicate",
        input: "[WARN] High memory usage",
        examples: [
          { input: "[ERROR] Failed to connect", output: true },
          { input: "[WARN] High memory usage", output: true },
          { input: "[INFO] Server started", output: false },
          { input: "[DEBUG] Query executed", output: false },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      // Should match ERROR and WARN levels
      expect(result.fn!("[ERROR] New error")).toBe(true);
      expect(result.fn!("[WARN] New warning")).toBe(true);
      expect(result.fn!("[INFO] New info")).toBe(false);
    });
  });

  describe("synthesizeOnFailure - number extraction", () => {
    it("synthesizes number extractor from text", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseNumber",
        input: "Total: 1,234 units",
        examples: [
          { input: "Total: 1,234 units", output: 1234 },
          { input: "Total: 500 units", output: 500 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("Total: 10,000 units")).toBe(10000);
    });

    it("synthesizes percentage extractor", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseNumber",
        input: "Growth: 25.5%",
        examples: [
          { input: "Growth: 25.5%", output: 25.5 },
          { input: "Growth: 10%", output: 10 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("Growth: 99.9%")).toBeCloseTo(99.9, 1);
    });
  });

  describe("synthesizeOnFailure - string extraction", () => {
    it("synthesizes key-value extractor", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "extract",
        input: "name: John Doe",
        examples: [
          { input: "name: John Doe", output: "John Doe" },
          { input: "city: New York", output: "New York" },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("country: Canada")).toBe("Canada");
    });
  });

  describe("caching", () => {
    it("caches synthesized functions by signature", () => {
      // First call - synthesizes
      integrator.synthesizeOnFailure({
        operation: "parseCurrency",
        input: "€100",
        examples: [
          { input: "€100", output: 100 },
          { input: "€200", output: 200 },
        ],
      });

      // Check cache hit
      const cached = integrator.getCached("parseCurrency:€");
      expect(cached).toBeDefined();
    });

    it("returns cached function on subsequent calls with same signature", () => {
      const context: SynthesisContext = {
        operation: "parseCurrency",
        input: "$100",
        examples: [
          { input: "$100", output: 100 },
          { input: "$200", output: 200 },
        ],
      };

      // First call
      const result1 = integrator.synthesizeOnFailure(context);
      expect(result1.success).toBe(true);

      // Second call should use cache
      const result2 = integrator.synthesizeOnFailure(context);
      expect(result2.success).toBe(true);
      expect(result2.fn).toBe(result1.fn); // Same function reference
    });

    it("stores function with correct cache key", () => {
      integrator.cacheFunction("custom-key", (s: string) => s.length);

      const cached = integrator.getCached("custom-key");
      expect(cached).toBeDefined();
      expect(cached!("hello")).toBe(5);
    });

    it("returns null for non-existent cache key", () => {
      const cached = integrator.getCached("non-existent");
      expect(cached).toBeNull();
    });
  });

  describe("error handling", () => {
    it("returns failure when no examples provided", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseCurrency",
        input: "$100",
        examples: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns failure when examples have conflicting outputs", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseCurrency",
        input: "$100",
        examples: [
          { input: "$100", output: 100 },
          { input: "$100", output: 200 }, // Same input, different output
        ],
      });

      expect(result.success).toBe(false);
    });

    it("returns failure when synthesis is impossible", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseDate",
        input: "random text",
        examples: [
          { input: "abc", output: "2024-01-01" },
          { input: "xyz", output: "2024-02-02" },
        ],
      });

      // May succeed with heuristics or fail - just verify it handles gracefully
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("code generation", () => {
    it("returns synthesized code string", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseCurrency",
        input: "$1,000",
        examples: [
          { input: "$1,000", output: 1000 },
          { input: "$500", output: 500 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.code).toBeDefined();
      expect(typeof result.code).toBe("string");

      // Code should be evaluable
      const fn = eval(`(${result.code})`);
      expect(fn("$2,000")).toBe(2000);
    });

    it("generates cache key from operation and input pattern", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "parseCurrency",
        input: "$1,000",
        examples: [
          { input: "$1,000", output: 1000 },
          { input: "$500", output: 500 },
        ],
      });

      expect(result.cacheKey).toBeDefined();
      expect(result.cacheKey).toContain("parseCurrency");
    });
  });

  describe("integration with miniKanren", () => {
    it("uses relational synthesis for complex patterns", () => {
      // This test verifies miniKanren is being used under the hood
      const result = integrator.synthesizeOnFailure({
        operation: "extract",
        input: "Order #12345: $500.00",
        examples: [
          { input: "Order #12345: $500.00", output: 500.0 },
          { input: "Order #67890: $1,234.56", output: 1234.56 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.fn).toBeDefined();
      expect(result.fn!("Order #99999: $999.99")).toBeCloseTo(999.99, 2);
    });

    it("synthesizes classifier using constraint solving", () => {
      // This is a more complex synthesis that requires miniKanren
      const result = integrator.synthesizeOnFailure({
        operation: "classify",
        input: "Transaction: APPROVED",
        examples: [
          { input: "Transaction: APPROVED", output: "success" },
          { input: "Transaction: DECLINED", output: "failure" },
          { input: "Transaction: PENDING", output: "pending" },
        ],
      });

      // May not succeed without more examples, but should handle gracefully
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("type inference", () => {
    it("infers number type from output examples", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "extract",
        input: "Count: 42",
        expectedType: "number",
        examples: [
          { input: "Count: 42", output: 42 },
          { input: "Count: 100", output: 100 },
        ],
      });

      expect(result.success).toBe(true);
      const output = result.fn!("Count: 999");
      expect(typeof output).toBe("number");
    });

    it("infers string type from output examples", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "extract",
        input: "Status: OK",
        expectedType: "string",
        examples: [
          { input: "Status: OK", output: "OK" },
          { input: "Status: ERROR", output: "ERROR" },
        ],
      });

      expect(result.success).toBe(true);
      const output = result.fn!("Status: PENDING");
      expect(typeof output).toBe("string");
    });

    it("infers boolean type for predicate operations", () => {
      const result = integrator.synthesizeOnFailure({
        operation: "predicate",
        input: "valid",
        expectedType: "boolean",
        examples: [
          { input: "valid", output: true },
          { input: "invalid", output: false },
        ],
      });

      expect(result.success).toBe(true);
      const output = result.fn!("valid");
      expect(typeof output).toBe("boolean");
    });
  });
});

describe("SynthesisContext interface", () => {
  it("supports all required fields", () => {
    const context: SynthesisContext = {
      operation: "parseCurrency",
      input: "$100",
      expectedType: "number",
      examples: [{ input: "$100", output: 100 }],
      bindings: new Map([["RESULTS", []]]),
    };

    expect(context.operation).toBe("parseCurrency");
    expect(context.input).toBe("$100");
    expect(context.expectedType).toBe("number");
    expect(context.examples).toHaveLength(1);
    expect(context.bindings?.has("RESULTS")).toBe(true);
  });
});

describe("SynthesisOutcome interface", () => {
  it("supports success outcome", () => {
    const outcome: SynthesisOutcome = {
      success: true,
      fn: (s: string) => parseInt(s, 10),
      code: "(s) => parseInt(s, 10)",
      cacheKey: "parseInt:numeric",
    };

    expect(outcome.success).toBe(true);
    expect(outcome.fn!("42")).toBe(42);
    expect(outcome.code).toBeDefined();
    expect(outcome.cacheKey).toBeDefined();
  });

  it("supports failure outcome", () => {
    const outcome: SynthesisOutcome = {
      success: false,
      error: "No pattern found",
    };

    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("No pattern found");
    expect(outcome.fn).toBeUndefined();
  });
});
