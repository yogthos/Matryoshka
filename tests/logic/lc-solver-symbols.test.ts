import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { solve, type SolverTools, type Bindings } from "../../src/logic/lc-solver.js";
import { parse } from "../../src/logic/lc-parser.js";
import { SessionDB } from "../../src/persistence/session-db.js";
import type { Symbol } from "../../src/treesitter/types.js";

describe("LC Solver - Symbol Commands", () => {
  let db: SessionDB;
  let tools: SolverTools;
  let bindings: Bindings;

  // Sample TypeScript code for testing
  const sampleCode = `
function hello(name: string): string {
  return "Hello, " + name;
}

class Greeter {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return hello(this.name);
  }

  farewell(): void {
    console.log("Goodbye");
  }
}

interface Person {
  name: string;
  age: number;
}

type ID = string | number;
`.trim();

  beforeEach(() => {
    db = new SessionDB();
    db.loadDocument(sampleCode);

    // Store sample symbols (simulating what tree-sitter would extract)
    db.storeSymbol({
      name: "hello",
      kind: "function",
      startLine: 1,
      endLine: 3,
      startCol: 0,
      endCol: 1,
      signature: "function hello(name: string): string",
    });

    db.storeSymbol({
      name: "Greeter",
      kind: "class",
      startLine: 5,
      endLine: 19,
      startCol: 0,
      endCol: 1,
    });

    db.storeSymbol({
      name: "greet",
      kind: "method",
      startLine: 12,
      endLine: 14,
      startCol: 2,
      endCol: 3,
      signature: "greet(): string",
      parentSymbolId: 2, // Greeter class
    });

    db.storeSymbol({
      name: "farewell",
      kind: "method",
      startLine: 16,
      endLine: 18,
      startCol: 2,
      endCol: 3,
      signature: "farewell(): void",
      parentSymbolId: 2, // Greeter class
    });

    db.storeSymbol({
      name: "Person",
      kind: "interface",
      startLine: 21,
      endLine: 24,
      startCol: 0,
      endCol: 1,
    });

    db.storeSymbol({
      name: "ID",
      kind: "type",
      startLine: 26,
      endLine: 26,
      startCol: 0,
      endCol: 24,
    });

    tools = {
      grep: (pattern: string) => {
        const regex = new RegExp(pattern, "gi");
        const lines = sampleCode.split("\n");
        const results: Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }> = [];
        lines.forEach((line, i) => {
          const match = line.match(regex);
          if (match) {
            results.push({
              match: match[0],
              line,
              lineNum: i + 1,
              index: line.indexOf(match[0]),
              groups: match.slice(1),
            });
          }
        });
        return results;
      },
      fuzzy_search: () => [],
      text_stats: () => ({
        length: sampleCode.length,
        lineCount: sampleCode.split("\n").length,
        sample: { start: "", middle: "", end: "" },
      }),
      context: sampleCode,
    };

    bindings = new Map();
    bindings.set("_sessionDB", db);
  });

  afterEach(() => {
    db.close();
  });

  describe("list_symbols", () => {
    it("should return all symbols as array", () => {
      const result = parse("(list_symbols)");
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);
      expect(Array.isArray(solved.value)).toBe(true);

      const symbols = solved.value as Symbol[];
      expect(symbols.length).toBe(6);
    });

    it("should filter symbols by kind", () => {
      const result = parse('(list_symbols "function")');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);

      const symbols = solved.value as Symbol[];
      expect(symbols.length).toBe(1);
      expect(symbols[0].name).toBe("hello");
      expect(symbols[0].kind).toBe("function");
    });

    it("should return methods when filtered", () => {
      const result = parse('(list_symbols "method")');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);

      const symbols = solved.value as Symbol[];
      expect(symbols.length).toBe(2);
      const names = symbols.map(s => s.name);
      expect(names).toContain("greet");
      expect(names).toContain("farewell");
    });

    it("should return symbol metadata", () => {
      const result = parse('(list_symbols "class")');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);

      const symbols = solved.value as Symbol[];
      expect(symbols.length).toBe(1);

      const classSymbol = symbols[0];
      expect(classSymbol.name).toBe("Greeter");
      expect(classSymbol.kind).toBe("class");
      expect(classSymbol.startLine).toBe(5);
      expect(classSymbol.endLine).toBe(19);
    });
  });

  describe("get_symbol_body", () => {
    it("should return code body for symbol by name", () => {
      const result = parse('(get_symbol_body "hello")');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);

      const body = solved.value as string;
      expect(body).toContain("function hello");
      expect(body).toContain('return "Hello, "');
    });

    it("should return code body for symbol from result", () => {
      // First get a symbol
      const listResult = parse('(list_symbols "function")');
      const listSolved = solve(listResult.term!, tools, bindings);
      const symbols = listSolved.value as Symbol[];

      // Store in bindings as RESULTS
      bindings.set("RESULTS", symbols[0]);

      const result = parse("(get_symbol_body RESULTS)");
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);

      const body = solved.value as string;
      expect(body).toContain("function hello");
    });

    it("should return null for non-existent symbol", () => {
      const result = parse('(get_symbol_body "nonExistent")');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);
      expect(solved.value).toBeNull();
    });
  });

  describe("find_references", () => {
    it("should find all references to identifier", () => {
      const result = parse('(find_references "hello")');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);

      const refs = solved.value as Array<{ line: string; lineNum: number }>;
      expect(Array.isArray(refs)).toBe(true);
      expect(refs.length).toBeGreaterThanOrEqual(2); // Declaration + usage in greet()
    });

    it("should find references to class name", () => {
      const result = parse('(find_references "Greeter")');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);

      const refs = solved.value as Array<{ line: string; lineNum: number }>;
      expect(Array.isArray(refs)).toBe(true);
      expect(refs.length).toBeGreaterThanOrEqual(1);
    });

    it("should return empty array for unused identifier", () => {
      const result = parse('(find_references "unusedThing")');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);

      const refs = solved.value as Array<{ line: string; lineNum: number }>;
      expect(Array.isArray(refs)).toBe(true);
      expect(refs.length).toBe(0);
    });
  });

  describe("integration scenarios", () => {
    it("should support grep + symbols workflow", () => {
      // Find all methods then get their bodies
      const listResult = parse('(list_symbols "method")');
      const listSolved = solve(listResult.term!, tools, bindings);
      expect(listSolved.success).toBe(true);

      const methods = listSolved.value as Symbol[];
      expect(methods.length).toBe(2);

      // Get body of first method
      bindings.set("RESULTS", methods[0]);
      const bodyResult = parse("(get_symbol_body RESULTS)");
      const bodySolved = solve(bodyResult.term!, tools, bindings);
      expect(bodySolved.success).toBe(true);
      expect(typeof bodySolved.value).toBe("string");
    });

    it("should count symbols by kind", () => {
      const result = parse('(count (list_symbols "method"))');
      expect(result.success).toBe(true);

      const solved = solve(result.term!, tools, bindings);
      expect(solved.success).toBe(true);
      expect(solved.value).toBe(2);
    });
  });
});
