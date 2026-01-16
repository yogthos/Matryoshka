/**
 * Tests for LC Solver with Synthesis Fallback
 * TDD: These tests are written FIRST to define the expected behavior
 *
 * The solver should automatically fall back to synthesis when built-in
 * parsers fail and :examples are provided in the query.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { solve, SolverTools, Bindings } from "../../src/logic/lc-solver.js";
import { parse } from "../../src/logic/lc-parser.js";
import type { LCTerm } from "../../src/logic/types.js";

/**
 * Helper to create mock tools for testing
 */
function createMockTools(content: string): SolverTools {
  const lines = content.split("\n");

  return {
    context: content,
    grep: (pattern: string) => {
      const regex = new RegExp(pattern, "gi");
      const results: Array<{
        match: string;
        line: string;
        lineNum: number;
        index: number;
        groups: string[];
      }> = [];

      lines.forEach((line, idx) => {
        const match = line.match(regex);
        if (match) {
          results.push({
            match: match[0],
            line,
            lineNum: idx + 1,
            index: line.indexOf(match[0]),
            groups: match.slice(1),
          });
        }
      });

      return results;
    },
    fuzzy_search: (query: string, limit = 10) => {
      // Simple fuzzy search mock
      return lines
        .map((line, idx) => ({
          line,
          lineNum: idx + 1,
          score: line.toLowerCase().includes(query.toLowerCase()) ? 1 : 0,
        }))
        .filter((r) => r.score > 0)
        .slice(0, limit);
    },
    text_stats: () => ({
      length: content.length,
      lineCount: lines.length,
      sample: {
        start: content.slice(0, 50),
        middle: content.slice(Math.floor(content.length / 2), Math.floor(content.length / 2) + 50),
        end: content.slice(-50),
      },
    }),
  };
}

/**
 * Helper to parse and solve
 */
function parseAndSolve(query: string, tools: SolverTools, bindings: Bindings = new Map()) {
  const parseResult = parse(query);
  if (!parseResult.success || !parseResult.term) {
    throw new Error(`Parse failed: ${parseResult.error}`);
  }
  return solve(parseResult.term, tools, bindings);
}

describe("LC Solver with Synthesis Fallback", () => {
  describe("parseCurrency synthesis", () => {
    it("auto-synthesizes when built-in fails on EU format", () => {
      const tools = createMockTools("Price: 1.234,56€\nPrice: 500,00€");

      // EU format with trailing euro sign - built-in should handle this
      // but with examples, it should use synthesis for complex formats
      const result = parseAndSolve(
        `(map (grep "Price")
           (lambda x
             (parseCurrency (match x "([0-9.,]+€)" 1)
               :examples [("1.234,56€" 1234.56) ("500,00€" 500)])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual([1234.56, 500]);
    });

    it("synthesizes currency parser for unfamiliar format", () => {
      const tools = createMockTools("Amount: CHF 1'234.50\nAmount: CHF 500.00");

      // Swiss format with apostrophe thousand separator
      const result = parseAndSolve(
        `(map (grep "Amount")
           (lambda x
             (parseCurrency (match x "CHF ([0-9'.,]+)" 1)
               :examples [("1'234.50" 1234.50) ("500.00" 500)])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual([1234.5, 500]);
    });

    it("uses built-in parser when no examples and format is standard", () => {
      const tools = createMockTools("Price: $1,234.56\nPrice: $500.00");

      // Standard US format - should work without examples
      const result = parseAndSolve(
        `(map (grep "Price")
           (lambda x
             (parseCurrency (match x "\\$([0-9,.]+)" 1))))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual([1234.56, 500]);
    });
  });

  describe("parseDate synthesis", () => {
    it("synthesizes date parser for DD-Mon-YYYY format", () => {
      const tools = createMockTools("Date: 15-Jan-2024\nDate: 20-Feb-2024");

      const result = parseAndSolve(
        `(map (grep "Date")
           (lambda x
             (parseDate (match x "Date: (.+)" 1)
               :examples [("15-Jan-2024" "2024-01-15") ("20-Feb-2024" "2024-02-20")])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual(["2024-01-15", "2024-02-20"]);
    });

    it("synthesizes date parser for short year format", () => {
      const tools = createMockTools("Date: 15/01/24\nDate: 28/02/24");

      const result = parseAndSolve(
        `(map (grep "Date")
           (lambda x
             (parseDate (match x "Date: (.+)" 1)
               :examples [("15/01/24" "2024-01-15") ("28/02/24" "2024-02-28")])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual(["2024-01-15", "2024-02-28"]);
    });
  });

  describe("parseNumber synthesis", () => {
    it("synthesizes number extractor from text", () => {
      const tools = createMockTools("Total: 1,234 units\nTotal: 500 units");

      const result = parseAndSolve(
        `(map (grep "Total")
           (lambda x
             (parseNumber (match x "Total: ([0-9,]+)" 1)
               :examples [("1,234" 1234) ("500" 500)])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual([1234, 500]);
    });

    it("extracts percentages and handles numeric values", () => {
      const tools = createMockTools("Growth: 25.5%\nGrowth: 10%");

      // parseNumber with % converts to decimals (0.255, 0.10)
      // To get raw numbers, extract without the % and parse as number
      const result = parseAndSolve(
        `(map (grep "Growth")
           (lambda x
             (parseNumber (match x "Growth: ([0-9.]+)" 1)
               :examples [("25.5" 25.5) ("10" 10)])))`,
        tools
      );

      expect(result.success).toBe(true);
      // Built-in parseNumber handles these as regular numbers
      expect(result.value).toEqual([25.5, 10]);
    });
  });

  describe("predicate synthesis", () => {
    it("synthesizes predicate from true/false examples", () => {
      const tools = createMockTools(
        "ERROR: Connection failed\nINFO: Started\nERROR: Timeout\nDEBUG: trace"
      );

      const result = parseAndSolve(
        `(filter (grep "")
           (lambda x
             (predicate x
               :examples [
                 ("ERROR: Connection failed" true)
                 ("INFO: Started" false)
                 ("ERROR: Timeout" true)
                 ("DEBUG: trace" false)
               ])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toHaveLength(2);
      // Should contain both ERROR lines
      const lines = (result.value as Array<{ line: string }>).map((r) => r.line);
      expect(lines.every((l) => l.includes("ERROR"))).toBe(true);
    });

    it("synthesizes predicate for log levels (ERROR or WARN)", () => {
      const tools = createMockTools(
        "[ERROR] Failed to connect\n[WARN] High memory\n[INFO] Server started\n[DEBUG] Query"
      );

      const result = parseAndSolve(
        `(filter (grep "")
           (lambda x
             (predicate x
               :examples [
                 ("[ERROR] Failed to connect" true)
                 ("[WARN] High memory" true)
                 ("[INFO] Server started" false)
                 ("[DEBUG] Query" false)
               ])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toHaveLength(2);
      const lines = (result.value as Array<{ line: string }>).map((r) => r.line);
      expect(lines.some((l) => l.includes("[ERROR]"))).toBe(true);
      expect(lines.some((l) => l.includes("[WARN]"))).toBe(true);
    });
  });

  describe("extract with examples", () => {
    it("synthesizes extractor from examples", () => {
      const tools = createMockTools(
        "Order #1234: $500.00\nOrder #5678: $1,200.00"
      );

      // Use :type "number" for type coercion
      const result = parseAndSolve(
        `(map (grep "Order")
           (lambda x
             (extract x "Order #(\\d+)" 1 "number"
               :examples [("Order #1234: $500.00" 1234) ("Order #5678: $1,200.00" 5678)])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual([1234, 5678]);
    });

    it("synthesizes extractor with type coercion", () => {
      const tools = createMockTools(
        "Revenue: $1,234.56\nRevenue: $500.00"
      );

      const result = parseAndSolve(
        `(map (grep "Revenue")
           (lambda x
             (extract x "\\$([\\d,\\.]+)" 1 "currency"
               :examples [("$1,234.56" 1234.56) ("$500.00" 500)])))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual([1234.56, 500]);
    });
  });

  describe("define-fn and apply-fn", () => {
    it("defines and applies a synthesized function", () => {
      const tools = createMockTools("€100\n€200\n€300");

      // Define the function
      const defineResult = parseAndSolve(
        `(define-fn "euro-parser" :examples [("€100" 100) ("€200" 200)])`,
        tools
      );

      expect(defineResult.success).toBe(true);

      // The define-fn should store the function in bindings
      const bindings: Bindings = new Map();
      if (defineResult.value && typeof defineResult.value === "object") {
        bindings.set("_fn_euro-parser", defineResult.value);
      }

      // Apply the function
      const applyResult = parseAndSolve(
        `(apply-fn "euro-parser" "€300")`,
        tools,
        bindings
      );

      expect(applyResult.success).toBe(true);
      expect(applyResult.value).toBe(300);
    });

    it("applies synthesized function in map", () => {
      const tools = createMockTools("€100\n€200\n€300");

      // Define first
      const bindings: Bindings = new Map();
      const defineResult = parseAndSolve(
        `(define-fn "euro-parser" :examples [("€100" 100) ("€200" 200)])`,
        tools
      );
      if (defineResult.value && typeof defineResult.value === "object") {
        bindings.set("_fn_euro-parser", defineResult.value);
      }

      // Now map over lines using the defined function
      const result = parseAndSolve(
        `(map (grep "€")
           (lambda x
             (apply-fn "euro-parser" x)))`,
        tools,
        bindings
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual([100, 200, 300]);
    });
  });

  describe("chained synthesis operations", () => {
    it("synthesizes multiple extractors in pipeline", () => {
      const tools = createMockTools(
        "Order #1234: $1,500.00 - Status: SHIPPED\n" +
        "Order #5678: $250.00 - Status: PENDING\n" +
        "Order #9012: $3,200.00 - Status: DELIVERED"
      );

      // Extract order numbers - use :type "number" for coercion
      const orderNumsResult = parseAndSolve(
        `(map (grep "Order")
           (lambda line
             (extract line "Order #(\\d+)" 1 "number"
               :examples [("Order #1234" 1234)])))`,
        tools
      );

      expect(orderNumsResult.success).toBe(true);
      expect(orderNumsResult.value).toEqual([1234, 5678, 9012]);

      // Extract amounts
      const amountsResult = parseAndSolve(
        `(map (grep "Order")
           (lambda line
             (parseCurrency (match line "\\$([\\d,\\.]+)" 1)
               :examples [("1,500.00" 1500) ("250.00" 250)])))`,
        tools
      );

      expect(amountsResult.success).toBe(true);
      expect(amountsResult.value).toEqual([1500, 250, 3200]);
    });
  });

  describe("synthesis with constraints", () => {
    it("respects type constraints during synthesis", () => {
      const tools = createMockTools("Temperature: 72.5°F\nTemperature: 68.0°F");

      const result = parseAndSolve(
        `(map (grep "Temperature")
           (lambda x
             (extract x "([0-9.]+)°F" 1
               :type "number"
               :examples [("72.5°F" 72.5)]
               :constraints {:min 0 :max 150})))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toEqual([72.5, 68.0]);
    });
  });

  describe("synthesis caching", () => {
    it("caches synthesized functions for reuse", () => {
      const tools = createMockTools("€100\n€200\n€100");

      // First call synthesizes
      const result1 = parseAndSolve(
        `(parseCurrency "€100" :examples [("€100" 100) ("€200" 200)])`,
        tools
      );
      expect(result1.success).toBe(true);
      expect(result1.value).toBe(100);

      // Second call with same pattern should reuse cached function
      const result2 = parseAndSolve(
        `(parseCurrency "€200" :examples [("€100" 100) ("€200" 200)])`,
        tools
      );
      expect(result2.success).toBe(true);
      expect(result2.value).toBe(200);
    });
  });

  describe("classify with miniKanren", () => {
    it("uses relational solver for pattern discovery", () => {
      const tools = createMockTools(
        "2024-01-15 10:30:00 [ERROR] auth.service - Login failed\n" +
        "2024-01-15 10:30:05 [INFO] auth.service - Login successful\n" +
        "2024-01-15 10:30:10 [ERROR] db.service - Connection failed"
      );

      // Use classify with examples
      const result = parseAndSolve(
        `(classify
           :examples [
             ("2024-01-15 10:30:00 [ERROR] auth.service - Login failed" true)
             ("2024-01-15 10:30:05 [INFO] auth.service - Login successful" false)
             ("2024-01-15 10:30:10 [ERROR] db.service - Connection failed" true)
           ])`,
        tools
      );

      expect(result.success).toBe(true);
      // Result should be a function that classifies lines
      expect(typeof result.value).toBe("function");
      const classifier = result.value as (line: string) => boolean;
      expect(classifier("[ERROR] Something")).toBe(true);
      expect(classifier("[INFO] Something")).toBe(false);
    });
  });

  describe("error handling", () => {
    it("falls back to built-in when conflicting examples provided", () => {
      const tools = createMockTools("random text");

      // Conflicting examples cause synthesis to fail, but solver falls back to built-in
      const result = parseAndSolve(
        `(parseCurrency "test" :examples [("test" 100) ("test" 200)])`,
        tools
      );

      // Synthesis fails but built-in returns null for unparseable input
      // The solve itself succeeds, just returns null
      expect(result.success).toBe(true);
      expect(result.value).toBe(null);
    });

    it("falls back to null when no examples and parse fails", () => {
      const tools = createMockTools("gibberish: xyz");

      const result = parseAndSolve(
        `(parseCurrency "xyz")`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toBe(null);
    });
  });

  describe("integration with existing solver features", () => {
    it("combines synthesis with filter and count", () => {
      const tools = createMockTools(
        "[ERROR] Failed\n[INFO] OK\n[ERROR] Timeout\n[WARN] Slow"
      );

      // Count errors using synthesized predicate
      const result = parseAndSolve(
        `(count
           (filter (grep "")
             (lambda x
               (predicate x
                 :examples [
                   ("[ERROR] Failed" true)
                   ("[INFO] OK" false)
                 ]))))`,
        tools
      );

      expect(result.success).toBe(true);
      expect(result.value).toBe(2); // Two ERROR lines
    });

    it("combines synthesis with sum", () => {
      const tools = createMockTools(
        "Sales: 1.234,56€\nSales: 500,00€\nSales: 750,00€"
      );

      // Sum EU-formatted currency using synthesis
      const result = parseAndSolve(
        `(sum
           (map (grep "Sales")
             (lambda x
               (parseCurrency (match x "([0-9.,]+€)" 1)
                 :examples [("1.234,56€" 1234.56) ("500,00€" 500)]))))`,
        tools
      );

      expect(result.success).toBe(true);
      // 1234.56 + 500 + 750 = 2484.56
      expect(result.value).toBeCloseTo(2484.56, 2);
    });
  });
});

describe("Solver synthesis integration edge cases", () => {
  it("handles empty examples array gracefully", () => {
    const tools = createMockTools("$100");

    const result = parseAndSolve(
      `(parseCurrency "$100" :examples [])`,
      tools
    );

    // Should fall back to built-in parser
    expect(result.success).toBe(true);
    expect(result.value).toBe(100);
  });

  it("handles single example", () => {
    const tools = createMockTools("€50");

    const result = parseAndSolve(
      `(parseCurrency "€50" :examples [("€50" 50)])`,
      tools
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe(50);
  });

  it("preserves bindings across synthesis operations", () => {
    const tools = createMockTools("$100\n$200");
    const bindings: Bindings = new Map([["RESULTS", [{ line: "$100" }, { line: "$200" }]]]);

    const result = parseAndSolve(
      `(map RESULTS
         (lambda x
           (parseCurrency x :examples [("$100" 100)])))`,
      tools,
      bindings
    );

    expect(result.success).toBe(true);
    expect(result.value).toEqual([100, 200]);
  });
});
