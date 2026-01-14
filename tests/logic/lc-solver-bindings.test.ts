/**
 * Tests for LC Solver bindings (cross-turn state)
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

describe("LC Solver Bindings", () => {
  const testContext = `[10:00] INFO: System started
[10:01] ERROR: Failed to connect to database
[10:02] INFO: Retry scheduled
[10:03] ERROR: Connection timeout
[10:04] INFO: Connection established`;

  describe("basic binding lookup", () => {
    it("should resolve RESULTS from bindings", () => {
      const tools = createMockTools(testContext);
      const bindings: Bindings = new Map();

      // Simulate previous turn: grep returned results
      const grepResults = tools.grep("ERROR");
      bindings.set("RESULTS", grepResults);

      // Now use RESULTS in a filter
      const parseResult = parse('(filter RESULTS (lambda line (match line "timeout" 0)))');
      expect(parseResult.success).toBe(true);

      const result = solve(parseResult.term!, tools, bindings);
      console.log("Result error:", result.error);
      console.log("Result logs:", result.logs);
      expect(result.success).toBe(true);
      expect(result.value).toBeInstanceOf(Array);
      expect((result.value as Array<{ line: string }>).length).toBe(1);
      expect((result.value as Array<{ line: string }>)[0].line).toContain("timeout");
    });

    it("should resolve turn-specific bindings like _1", () => {
      const tools = createMockTools(testContext);
      const bindings: Bindings = new Map();

      // Simulate turn 1 result
      const grepResults = tools.grep("INFO");
      bindings.set("_1", grepResults);

      // Reference _1
      const parseResult = parse('(filter _1 (lambda line (match line "started" 0)))');
      expect(parseResult.success).toBe(true);

      const result = solve(parseResult.term!, tools, bindings);
      expect(result.success).toBe(true);
      expect((result.value as Array<{ line: string }>).length).toBe(1);
    });

    it("should throw error for unbound variable when not in bindings", () => {
      const tools = createMockTools(testContext);
      const bindings: Bindings = new Map();

      const parseResult = parse('(filter UNKNOWN_VAR (lambda line (match line "test" 0)))');
      expect(parseResult.success).toBe(true);

      const result = solve(parseResult.term!, tools, bindings);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unbound variable");
    });
  });

  describe("multi-turn workflow simulation", () => {
    it("should support search → filter → extract workflow", () => {
      const tools = createMockTools(testContext);
      const bindings: Bindings = new Map();

      // Turn 1: Search
      const turn1 = parse('(grep "ERROR")');
      expect(turn1.success).toBe(true);
      const result1 = solve(turn1.term!, tools, bindings);
      expect(result1.success).toBe(true);
      expect((result1.value as Array<unknown>).length).toBe(2);

      // Bind result for next turn
      bindings.set("RESULTS", result1.value);
      bindings.set("_1", result1.value);

      // Turn 2: Filter
      const turn2 = parse('(filter RESULTS (lambda line (match line "timeout" 0)))');
      expect(turn2.success).toBe(true);
      const result2 = solve(turn2.term!, tools, bindings);
      expect(result2.success).toBe(true);
      expect((result2.value as Array<unknown>).length).toBe(1);

      // Bind result for next turn
      bindings.set("RESULTS", result2.value);
      bindings.set("_2", result2.value);

      // Turn 3: Can still access _1 (original grep results)
      const turn3 = parse('(filter _1 (lambda line (match line "database" 0)))');
      expect(turn3.success).toBe(true);
      const result3 = solve(turn3.term!, tools, bindings);
      expect(result3.success).toBe(true);
      expect((result3.value as Array<{ line: string }>)[0].line).toContain("database");
    });

    it("should allow chaining map after filter", () => {
      const tools = createMockTools(`Total: $100
Total: $250
Total: $75`);
      const bindings: Bindings = new Map();

      // Turn 1: Search for totals
      const turn1 = parse('(grep "Total")');
      const result1 = solve(turn1.term!, tools, bindings);
      bindings.set("RESULTS", result1.value);

      // Turn 2: Extract numeric values
      const turn2 = parse('(map RESULTS (lambda line (parseFloat (match line "[0-9]+" 0))))');
      const result2 = solve(turn2.term!, tools, bindings);
      expect(result2.success).toBe(true);
      expect(result2.value).toEqual([100, 250, 75]);
    });
  });

  describe("binding log messages", () => {
    it("should log when resolving from bindings", () => {
      const tools = createMockTools(testContext);
      const bindings: Bindings = new Map([["RESULTS", [{ line: "test", lineNum: 1 }]]]);

      const parseResult = parse('(filter RESULTS (lambda line (match line "test" 0)))');
      const result = solve(parseResult.term!, tools, bindings);

      expect(result.logs.some(log => log.includes("Available bindings"))).toBe(true);
      expect(result.logs.some(log => log.includes("Resolved variable RESULTS"))).toBe(true);
    });
  });
});
