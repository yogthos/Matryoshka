/**
 * Tests for LC Solver type coercion and parsing
 */

import { describe, it, expect } from "vitest";
import { solve, type SolverTools, type Bindings } from "../../src/logic/lc-solver.js";
import { parse } from "../../src/logic/lc-parser.js";

// Helper to create mock tools
function createMockTools(context: string): SolverTools {
  const lines = context.split("\n");
  return {
    context,
    grep: (pattern: string) => {
      const regex = new RegExp(pattern, "gi");
      const results: Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }> = [];
      let match;
      while ((match = regex.exec(context)) !== null) {
        const beforeMatch = context.slice(0, match.index);
        const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;
        results.push({
          match: match[0],
          line: lines[lineNum - 1] || "",
          lineNum,
          index: match.index,
          groups: match.slice(1),
        });
      }
      return results;
    },
    fuzzy_search: (query: string, limit = 10) => {
      return lines
        .map((line, idx) => ({
          line,
          lineNum: idx + 1,
          score: line.toLowerCase().includes(query.toLowerCase()) ? 100 : 0,
        }))
        .filter(r => r.score > 0)
        .slice(0, limit);
    },
    text_stats: () => ({
      length: context.length,
      lineCount: lines.length,
      sample: { start: "", middle: "", end: "" },
    }),
  };
}

describe("LC Solver Type Coercion", () => {
  const tools = createMockTools("");
  const bindings: Bindings = new Map();

  describe("parseDate", () => {
    it("should parse ISO date format", () => {
      const result = solve(parse('(parseDate "2024-01-15")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe("2024-01-15");
    });

    it("should parse US date format with hint", () => {
      const result = solve(parse('(parseDate "01/15/2024" "US")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe("2024-01-15");
    });

    it("should parse EU date format with hint", () => {
      const result = solve(parse('(parseDate "15/01/2024" "EU")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe("2024-01-15");
    });

    it("should parse natural language date (Month Day, Year)", () => {
      const result = solve(parse('(parseDate "January 15, 2024")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe("2024-01-15");
    });

    it("should parse natural language date (Day Month Year)", () => {
      const result = solve(parse('(parseDate "15 Jan 2024")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe("2024-01-15");
    });

    it("should return null for invalid date", () => {
      const result = solve(parse('(parseDate "not a date")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(null);
    });
  });

  describe("parseCurrency", () => {
    it("should parse US dollar format", () => {
      const result = solve(parse('(parseCurrency "$1,234.56")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1234.56);
    });

    it("should parse EU format (dot thousands, comma decimal)", () => {
      const result = solve(parse('(parseCurrency "€1.234,56")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1234.56);
    });

    it("should parse large currency amounts", () => {
      const result = solve(parse('(parseCurrency "$2,340,000")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(2340000);
    });

    it("should handle negative currency (parentheses)", () => {
      const result = solve(parse('(parseCurrency "($1,234)")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(-1234);
    });

    it("should handle negative currency (minus sign)", () => {
      const result = solve(parse('(parseCurrency "-$1,234")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(-1234);
    });
  });

  describe("parseNumber", () => {
    it("should parse comma-separated number", () => {
      const result = solve(parse('(parseNumber "1,234,567")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1234567);
    });

    it("should parse percentage", () => {
      const result = solve(parse('(parseNumber "50%")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(0.5);
    });

    it("should parse decimal", () => {
      const result = solve(parse('(parseNumber "3.14159")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(3.14159);
    });

    it("should parse scientific notation", () => {
      const result = solve(parse('(parseNumber "1.5e6")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1500000);
    });
  });

  describe("coerce", () => {
    it("should coerce string to date", () => {
      const result = solve(parse('(coerce "2024-01-15" "date")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe("2024-01-15");
    });

    it("should coerce string to currency", () => {
      const result = solve(parse('(coerce "$1,234" "currency")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1234);
    });

    it("should coerce string to number", () => {
      const result = solve(parse('(coerce "1,234" "number")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1234);
    });

    it("should coerce to boolean", () => {
      expect(solve(parse('(coerce "true" "boolean")').term!, tools, bindings).value).toBe(true);
      expect(solve(parse('(coerce "yes" "boolean")').term!, tools, bindings).value).toBe(true);
      expect(solve(parse('(coerce "false" "boolean")').term!, tools, bindings).value).toBe(false);
      expect(solve(parse('(coerce "no" "boolean")').term!, tools, bindings).value).toBe(false);
    });
  });

  describe("extract with type coercion", () => {
    it("should extract and coerce to currency", () => {
      const result = solve(parse('(extract "Total: $1,234.56" "\\\\$[\\\\d,.]+" 0 "currency")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(1234.56);
    });

    it("should extract and coerce to date", () => {
      const result = solve(parse('(extract "Date: 2024-01-15" "\\\\d{4}-\\\\d{2}-\\\\d{2}" 0 "date")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe("2024-01-15");
    });

    it("should extract without coercion when type not specified", () => {
      const result = solve(parse('(extract "Value: 42" "\\\\d+" 0)').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe("42"); // String, not number
    });
  });

  describe("map with type coercion", () => {
    it("should parse dates in map", () => {
      const context = `Event: Jan 15, 2024
Event: Feb 20, 2024
Event: Mar 10, 2024`;
      const mapTools = createMockTools(context);
      const mapBindings: Bindings = new Map();

      // First grep
      const grepResult = solve(parse('(grep "Event")').term!, mapTools, mapBindings);
      mapBindings.set("RESULTS", grepResult.value);

      // Map to extract and parse dates
      const mapResult = solve(
        parse('(map RESULTS (lambda x (parseDate (match x "[A-Za-z]+ \\\\d+, \\\\d+" 0))))').term!,
        mapTools,
        mapBindings
      );
      expect(mapResult.success).toBe(true);
      expect(mapResult.value).toEqual(["2024-01-15", "2024-02-20", "2024-03-10"]);
    });

    it("should parse currencies in map", () => {
      const context = `SALES_NORTH: $2,340,000
SALES_SOUTH: $3,120,000
SALES_EAST: $1,890,000`;
      const mapTools = createMockTools(context);
      const mapBindings: Bindings = new Map();

      // First grep
      const grepResult = solve(parse('(grep "SALES")').term!, mapTools, mapBindings);
      mapBindings.set("RESULTS", grepResult.value);

      // Map to extract and parse currencies
      const mapResult = solve(
        parse('(map RESULTS (lambda x (parseCurrency (match x "\\\\$[\\\\d,]+" 0))))').term!,
        mapTools,
        mapBindings
      );
      expect(mapResult.success).toBe(true);
      expect(mapResult.value).toEqual([2340000, 3120000, 1890000]);
    });
  });
});

describe("LC Solver Synthesis", () => {
  const tools = createMockTools("");
  const bindings: Bindings = new Map();

  describe("synthesize command", () => {
    it("should parse synthesize with bracket pairs", () => {
      const parseResult = parse('(synthesize ["SALES: $100" 100] ["SALES: $200" 200])');
      expect(parseResult.success).toBe(true);
      expect(parseResult.term?.tag).toBe("synthesize");
    });

    it("should parse synthesize with paren pairs", () => {
      const parseResult = parse('(synthesize ("input1" "output1") ("input2" "output2"))');
      expect(parseResult.success).toBe(true);
    });

    it("should synthesize a simple extractor", () => {
      const result = solve(
        parse('(synthesize ("$100" 100) ("$200" 200) ("$50" 50))').term!,
        tools,
        bindings
      );
      expect(result.success).toBe(true);
      // Should return a function
      expect(typeof result.value).toBe("function");

      // Test the synthesized function
      const fn = result.value as (s: string) => unknown;
      expect(fn("$300")).toBe(300);
    });

    it("should synthesize date parser via relational solver", () => {
      // This tests the relational solver fallback - unusual date format
      const result = solve(
        parse('(synthesize ("Q1-2024" "2024-01") ("Q2-2024" "2024-04") ("Q3-2024" "2024-07") ("Q4-2024" "2024-10"))').term!,
        tools,
        bindings
      );
      expect(result.success).toBe(true);
      expect(typeof result.value).toBe("function");

      const fn = result.value as (s: string) => unknown;
      expect(fn("Q1-2025")).toBe("2025-01");
    });

    it("should synthesize number extractor from complex pattern", () => {
      const result = solve(
        parse('(synthesize ("Order #12345 (SHIPPED)" 12345) ("Order #67890 (PENDING)" 67890))').term!,
        tools,
        bindings
      );
      expect(result.success).toBe(true);
      expect(typeof result.value).toBe("function");

      const fn = result.value as (s: string) => unknown;
      expect(fn("Order #11111 (DELIVERED)")).toBe(11111);
    });
  });
});

describe("LC Solver Lines Command", () => {
  const multiLineContext = `Line 1: Introduction
Line 2: Start of config
{
  "name": "example",
  "value": 42
}
Line 7: End of config
Line 8: Conclusion`;

  const tools = createMockTools(multiLineContext);
  const bindings: Bindings = new Map();

  it("should get specific line range", () => {
    const result = solve(parse("(lines 3 6)").term!, tools, bindings);
    expect(result.success).toBe(true);
    // lines returns an array of strings for compatibility with filter/map
    expect(result.value).toEqual([
      "{",
      '  "name": "example",',
      '  "value": 42',
      "}",
    ]);
  });

  it("should handle 1-indexed lines", () => {
    const result = solve(parse("(lines 1 2)").term!, tools, bindings);
    expect(result.success).toBe(true);
    expect(result.value).toEqual([
      "Line 1: Introduction",
      "Line 2: Start of config",
    ]);
  });

  it("should clamp to valid range", () => {
    const result = solve(parse("(lines 7 100)").term!, tools, bindings);
    expect(result.success).toBe(true);
    expect(result.value).toEqual([
      "Line 7: End of config",
      "Line 8: Conclusion",
    ]);
  });
});
