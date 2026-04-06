/**
 * Tests for (fuse ...) Nucleus integration
 * Covers: parser, solver, type inference, prettyPrint
 */

import { describe, it, expect } from "vitest";
import { parse, prettyPrint } from "../../src/logic/lc-parser.js";
import { solve, type SolverTools, type Bindings } from "../../src/logic/lc-solver.js";
import { inferType } from "../../src/logic/type-inference.js";

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
    bm25: (query: string, limit = 10) => {
      const queryTerms = query.toLowerCase().split(/\s+/);
      return lines
        .map((line, idx) => {
          const lower = line.toLowerCase();
          const score = queryTerms.reduce((s, t) => s + (lower.includes(t) ? 10 : 0), 0);
          return { line, lineNum: idx + 1, score };
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
    text_stats: () => ({
      length: context.length,
      lineCount: lines.length,
      sample: { start: "", middle: "", end: "" },
    }),
  };
}

const testContext = `[10:00] INFO: System started
[10:01] ERROR: Failed to connect to database
[10:02] INFO: Retry scheduled
[10:03] ERROR: Connection timeout
[10:04] INFO: Connection established`;

describe("fuse Parser", () => {
  it("should parse fuse with two sub-expressions", () => {
    const result = parse('(fuse (grep "ERROR") (bm25 "error"))');
    expect(result.success).toBe(true);
    expect(result.term?.tag).toBe("fuse");
    if (result.term?.tag === "fuse") {
      expect(result.term.collections.length).toBe(2);
      expect(result.term.collections[0].tag).toBe("grep");
      expect(result.term.collections[1].tag).toBe("bm25");
    }
  });

  it("should parse fuse with three sub-expressions", () => {
    const result = parse('(fuse (grep "ERROR") (bm25 "error") (fuzzy_search "error"))');
    expect(result.success).toBe(true);
    if (result.term?.tag === "fuse") {
      expect(result.term.collections.length).toBe(3);
    }
  });

  it("should parse fuse with variable references", () => {
    const result = parse("(fuse RESULTS _1)");
    expect(result.success).toBe(true);
    if (result.term?.tag === "fuse") {
      expect(result.term.collections.length).toBe(2);
      expect(result.term.collections[0].tag).toBe("var");
      expect(result.term.collections[1].tag).toBe("var");
    }
  });

  it("should fail on fuse with fewer than 2 arguments", () => {
    const result = parse('(fuse (grep "ERROR"))');
    expect(result.success).toBe(false);
  });

  it("should fail on empty fuse", () => {
    const result = parse("(fuse)");
    expect(result.success).toBe(false);
  });
});

describe("fuse prettyPrint", () => {
  it("should round-trip fuse with two sub-expressions", () => {
    const result = parse('(fuse (grep "ERROR") (bm25 "error"))');
    expect(result.success).toBe(true);
    const printed = prettyPrint(result.term!);
    expect(printed).toBe('(fuse (grep "ERROR") (bm25 "error"))');
  });
});

describe("fuse Type Inference", () => {
  it("should infer array type for fuse", () => {
    const result = parse('(fuse (grep "ERROR") (bm25 "error"))');
    expect(result.success).toBe(true);
    const typeResult = inferType(result.term!);
    expect(typeResult.valid).toBe(true);
    expect(typeResult.type?.tag).toBe("array");
  });
});

describe("fuse Solver", () => {
  it("should fuse grep and bm25 results", () => {
    const tools = createMockTools(testContext);
    const result = parse('(fuse (grep "ERROR") (bm25 "error"))');
    expect(result.success).toBe(true);

    const solveResult = solve(result.term!, tools);
    expect(solveResult.success).toBe(true);
    expect(Array.isArray(solveResult.value)).toBe(true);
    const results = solveResult.value as Array<{ line: string; lineNum: number; score: number }>;
    expect(results.length).toBeGreaterThan(0);
    // Fused results should be sorted by score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("should fuse bindings with fresh results", () => {
    const tools = createMockTools(testContext);
    const bindings: Bindings = new Map();

    // Simulate a previous grep result stored in _1
    const grepParse = parse('(grep "ERROR")');
    const grepResult = solve(grepParse.term!, tools);
    bindings.set("_1", grepResult.value);

    // Fuse _1 with fresh bm25
    const fuseParse = parse('(fuse _1 (bm25 "connection"))');
    expect(fuseParse.success).toBe(true);
    const fuseResult = solve(fuseParse.term!, tools, bindings);
    expect(fuseResult.success).toBe(true);
    expect(Array.isArray(fuseResult.value)).toBe(true);
  });

  it("should work with filter on fused results", () => {
    const tools = createMockTools(testContext);
    const bindings: Bindings = new Map();

    // Fuse and store
    const fuseParse = parse('(fuse (grep "ERROR") (bm25 "connection"))');
    const fuseResult = solve(fuseParse.term!, tools);
    expect(fuseResult.success).toBe(true);
    bindings.set("RESULTS", fuseResult.value);

    // Filter fused results
    const filterParse = parse('(filter RESULTS (lambda x (match x "timeout" 0)))');
    expect(filterParse.success).toBe(true);
    const filterResult = solve(filterParse.term!, tools, bindings);
    expect(filterResult.success).toBe(true);
  });

  it("should normalize grep results that lack score field", () => {
    const tools = createMockTools(testContext);
    // grep results have {match, line, lineNum, index, groups} but NO score
    // fuse must assign default score=1 to them
    const result = parse('(fuse (grep "ERROR") (bm25 "error"))');
    expect(result.success).toBe(true);

    const solveResult = solve(result.term!, tools);
    expect(solveResult.success).toBe(true);
    const results = solveResult.value as Array<{ line: string; lineNum: number; score: number }>;
    // All fused results must have numeric scores
    for (const r of results) {
      expect(typeof r.score).toBe("number");
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("should fuse three signals", () => {
    const tools = createMockTools(testContext);
    const result = parse('(fuse (grep "ERROR") (bm25 "error") (fuzzy_search "error"))');
    expect(result.success).toBe(true);

    const solveResult = solve(result.term!, tools);
    expect(solveResult.success).toBe(true);
    expect(Array.isArray(solveResult.value)).toBe(true);
  });
});
