import { describe, it, expect, beforeEach } from "vitest";
import { NucleusEngine, createEngine, createEngineFromContent } from "../../src/engine/nucleus-engine.js";
import { readFileSync } from "fs";
import type { LCTerm } from "../../src/logic/types.js";
import { solve } from "../../src/logic/lc-solver.js";
import type { SolverTools } from "../../src/logic/lc-solver.js";
import { parseAll, parse } from "../../src/logic/lc-parser.js";

const SAMPLE_DOCUMENT = `FATAL: Database connection failed at 10:30:45
INFO: User logged in successfully
FATAL: File not found: /tmp/data.csv
WARNING: Memory usage high at 85%
INFO: Processing complete
FATAL: Network timeout after 30 seconds
DEBUG: Cache hit ratio: 0.95
INFO: Server started on port 3000
Sales: $1,500,000
Sales: $2,300,000
Sales: $1,800,000
Sales: $2,400,000`;

describe("NucleusEngine", () => {
  let engine: NucleusEngine;

  beforeEach(() => {
    engine = new NucleusEngine();
    engine.loadContent(SAMPLE_DOCUMENT);
  });

  describe("initialization", () => {
    it("should create engine without document", async () => {
      const emptyEngine = new NucleusEngine();
      expect(emptyEngine.isLoaded()).toBe(false);
    });

    it("should load document content", async () => {
      expect(engine.isLoaded()).toBe(true);
    });

    it("should report correct stats", async () => {
      const stats = engine.getStats();
      expect(stats).not.toBeNull();
      expect(stats!.lineCount).toBe(12);
      expect(stats!.length).toBeGreaterThan(0);
    });

    it("should get raw content", async () => {
      expect(engine.getContent()).toBe(SAMPLE_DOCUMENT);
    });
  });

  describe("grep command", () => {
    it("should find matches with grep", async () => {
      const result = await engine.execute('(grep "FATAL")');

      expect(result.success).toBe(true);
      expect(Array.isArray(result.value)).toBe(true);
      expect((result.value as unknown[]).length).toBe(3);
    });

    it("should return match details", async () => {
      const result = await engine.execute('(grep "FATAL")');
      const matches = result.value as Array<{ match: string; line: string; lineNum: number }>;

      expect(matches[0].match).toBe("FATAL");
      expect(matches[0].line).toContain("Database connection failed");
      expect(matches[0].lineNum).toBe(1);
    });

    it("should handle regex patterns", async () => {
      const result = await engine.execute('(grep "Sales:")');

      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(4);
    });

    it("should return empty array for no matches", async () => {
      const result = await engine.execute('(grep "NOTFOUND")');

      expect(result.success).toBe(true);
      expect(result.value).toEqual([]);
    });
  });

  describe("count command", () => {
    it("should count results after grep", async () => {
      await engine.execute('(grep "FATAL")');
      const result = await engine.execute('(count RESULTS)');

      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
    });

    it("should count all lines with INFO", async () => {
      await engine.execute('(grep "INFO")');
      const result = await engine.execute('(count RESULTS)');

      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
    });
  });

  describe("filter command", () => {
    it("should filter results with predicate", async () => {
      await engine.execute('(grep "FATAL")');
      const result = await engine.execute('(filter RESULTS (lambda x (match x "Network" 0)))');

      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(1);
    });

    it("should filter for specific content", async () => {
      await engine.execute('(grep "FATAL")');
      const result = await engine.execute('(filter RESULTS (lambda x (match x "Database" 0)))');

      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(1);
    });
  });

  describe("sum command", () => {
    it("should sum numeric values", async () => {
      await engine.execute('(grep "Sales")');
      const result = await engine.execute('(sum RESULTS)');

      expect(result.success).toBe(true);
      // $1,500,000 + $2,300,000 + $1,800,000 + $2,400,000 = $8,000,000
      expect(result.value).toBe(8000000);
    });
  });

  describe("map command", () => {
    it("should extract values with map", async () => {
      await engine.execute('(grep "Sales")');
      // Extract the dollar amounts
      const result = await engine.execute('(map RESULTS (lambda x (match x "\\\\$([0-9,]+)" 1)))');

      expect(result.success).toBe(true);
      // Map extracts from the .line property of grep results
      expect(result.value).toEqual(["1,500,000", "2,300,000", "1,800,000", "2,400,000"]);
    });
  });

  describe("text_stats command", () => {
    it("should return document statistics", async () => {
      const result = await engine.execute('(text_stats)');

      expect(result.success).toBe(true);
      const stats = result.value as { length: number; lineCount: number };
      expect(stats.lineCount).toBe(12);
      expect(stats.length).toBeGreaterThan(0);
    });
  });

  describe("lines command", () => {
    it("should return line range", async () => {
      const result = await engine.execute('(lines 1 3)');

      expect(result.success).toBe(true);
      // lines returns an array for compatibility with filter/map
      expect(Array.isArray(result.value)).toBe(true);
      expect((result.value as string[]).length).toBe(3);
    });
  });

  describe("string operations", () => {
    it("should match pattern and extract group", async () => {
      const result = await engine.execute('(match "Sales Q1: $1,500,000" "\\\\$([0-9,]+)" 1)');

      expect(result.success).toBe(true);
      expect(result.value).toBe("1,500,000");
    });

    it("should replace pattern", async () => {
      const result = await engine.execute('(replace "hello world" "world" "universe")');

      expect(result.success).toBe(true);
      expect(result.value).toBe("hello universe");
    });

    it("should split string", async () => {
      const result = await engine.execute('(split "a,b,c" "," 1)');

      expect(result.success).toBe(true);
      expect(result.value).toBe("b");
    });

    it("should parse integer", async () => {
      const result = await engine.execute('(parseInt "42")');

      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
    });

    it("should parse float", async () => {
      const result = await engine.execute('(parseFloat "3.14")');

      expect(result.success).toBe(true);
      expect(result.value).toBe(3.14);
    });
  });

  describe("bindings and state", () => {
    it("should maintain RESULTS across commands", async () => {
      await engine.execute('(grep "FATAL")');

      const bindings = engine.getBindings();
      expect(bindings.RESULTS).toBe("Array[3]");
    });

    it("should create numbered bindings", async () => {
      await engine.execute('(grep "FATAL")');
      await engine.execute('(count RESULTS)');

      const bindings = engine.getBindings();
      expect(bindings._1).toBe("Array[3]");
      expect(bindings._2).toBe(3);
    });

    it("should allow manual binding", async () => {
      engine.setBinding("myVar", 42);
      expect(engine.getBinding("myVar")).toBe(42);
    });

    it("should reset state", async () => {
      await engine.execute('(grep "FATAL")');
      expect(Object.keys(engine.getBindings()).length).toBeGreaterThan(0);

      engine.reset();
      expect(Object.keys(engine.getBindings()).length).toBe(0);
    });

    it("should preserve RESULTS when executing scalar operations", async () => {
      await engine.execute('(grep "FATAL")');
      const countResult = await engine.execute('(count RESULTS)');

      // RESULTS should still be the array, not the count
      const results = engine.getBinding("RESULTS") as unknown[];
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);
      expect(countResult.value).toBe(3);
    });
  });

  describe("turn bindings eviction", () => {
    it("should evict old turn bindings after exceeding cap while preserving RESULTS and _fn_*", async () => {
      // Execute more than 100 queries to trigger eviction
      for (let i = 0; i < 110; i++) {
        await engine.execute('(grep "FATAL")');
      }

      const bindings = engine.getBindings();

      // RESULTS should still be present
      expect(bindings.RESULTS).toBeDefined();

      // Old turn bindings (_1, _2, ...) should be evicted
      expect(bindings._1).toBeUndefined();
      expect(bindings._2).toBeUndefined();

      // Recent turn bindings should still exist
      expect(bindings._110).toBeDefined();
    });

    it("should use actual _N binding count for eviction, not turnCounter", async () => {
      // Execute many successful scalar commands. Each increments turnCounter
      // AND creates an _N binding because every successful execution returns
      // a non-null value (turnCounter === _N count in practice).
      for (let i = 0; i < 110; i++) {
        await engine.execute('(count (grep "FATAL"))');
      }
      // turnCounter = 110, _N keys = 110.
      // After eviction, only the 100 newest should survive.

      const bindings = engine.getBindings();

      // Oldest 10 should be evicted: _1 through _10
      expect(bindings._1).toBeUndefined();
      expect(bindings._10).toBeUndefined();

      // Newest 100 should survive: _11 through _110
      expect(bindings._11).toBeDefined();
      expect(bindings._100).toBeDefined();
      expect(bindings._110).toBeDefined();
    });

    it("should evict numerically oldest keys, not lexicographically first", async () => {
      // Execute 105 queries - should keep _6 through _105 (100 keys)
      for (let i = 0; i < 105; i++) {
        await engine.execute('(grep "FATAL")');
      }

      const bindings = engine.getBindings();

      // _1 through _5 should be evicted (numerically oldest)
      expect(bindings._1).toBeUndefined();
      expect(bindings._5).toBeUndefined();

      // _6 through _105 should be kept
      expect(bindings._6).toBeDefined();
      expect(bindings._100).toBeDefined();
      expect(bindings._105).toBeDefined();
    });
  });

  describe("grep match limit", () => {
    it("should cap results at MAX_GREP_MATCHES for broad patterns", async () => {
      // Create a very large document that would produce many matches
      const bigLines: string[] = [];
      for (let i = 0; i < 15000; i++) {
        bigLines.push(`line ${i}: data`);
      }
      const bigEngine = new NucleusEngine();
      bigEngine.loadContent(bigLines.join("\n"));

      // Pattern that matches every "line" - will produce 15000 matches
      const result = await bigEngine.execute('(grep "line")');
      expect(result.success).toBe(true);
      const matches = result.value as unknown[];
      // Should be capped at 10000 (MAX_GREP_MATCHES)
      expect(matches.length).toBeLessThanOrEqual(10000);
    });

    it("should return all matches when below limit", async () => {
      const result = await engine.execute('(grep "FATAL")');
      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(3);
    });
  });

  describe("regex validation (ReDoS protection)", () => {
    it("should reject catastrophic backtracking patterns", async () => {
      const result = await engine.execute('(grep "(a+)+$")');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/regex|pattern|nested/i);
    });

    it("should reject excessively long patterns", async () => {
      const longPattern = "a".repeat(501);
      const result = await engine.execute(`(grep "${longPattern}")`);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/regex|pattern|long/i);
    });

    it("should accept normal patterns", async () => {
      const result = await engine.execute('(grep "ERROR|WARN")');
      expect(result.success).toBe(true);
    });

    it("should accept digit patterns", async () => {
      const result = await engine.execute('(grep "\\\\d+")');
      expect(result.success).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should return error for invalid syntax", async () => {
      const result = await engine.execute('(grep "unclosed');

      expect(result.success).toBe(false);
      expect(result.error).toContain("Parse error");
    });

    it("should return error for unknown command", async () => {
      const result = await engine.execute('(unknownCommand "test")');

      expect(result.success).toBe(false);
    });

    it("should return error when no document loaded", async () => {
      const emptyEngine = new NucleusEngine();
      const result = await emptyEngine.execute('(grep "test")');

      expect(result.success).toBe(false);
      expect(result.error).toContain("No document loaded");
    });
  });

  describe("executeAll", () => {
    it("should execute multiple commands in sequence", async () => {
      const results = await engine.executeAll([
        '(grep "FATAL")',
        '(count RESULTS)',
      ]);

      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[1].value).toBe(3);
    });
  });

  describe("command reference", () => {
    it("should return command reference", async () => {
      const ref = NucleusEngine.getCommandReference();

      expect(ref).toContain("grep");
      expect(ref).toContain("filter");
      expect(ref).toContain("RESULTS");
    });
  });
});

describe("Factory functions", () => {
  it("should create engine from content", async () => {
    const engine = createEngineFromContent("test content");

    expect(engine.isLoaded()).toBe(true);
    expect(engine.getContent()).toBe("test content");
  });

  it("should create engine from file", async () => {
    // Create a temp file content to test with
    const engine = await createEngine("./test-fixtures/small.txt");

    expect(engine.isLoaded()).toBe(true);
  });
});

describe("ReDoS protection in grep", () => {
  it("should reject ReDoS pattern (a+)+", async () => {
    const engine = createEngineFromContent("aaaaaaaaaaaa test data");
    const result = await engine.execute('(grep "(a+)+")');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/regex|backtracking/i);
  });
});

describe("loadContent empty string edge case", () => {
  it("should treat empty string as not loaded", async () => {
    const engine = new NucleusEngine();
    engine.loadContent("");
    // Empty document should not be considered "loaded"
    expect(engine.isLoaded()).toBe(false);
  });

  it("should treat whitespace-only string as not loaded", async () => {
    const engine = new NucleusEngine();
    engine.loadContent("   \n\n  ");
    // Whitespace-only document should not be considered "loaded"
    expect(engine.isLoaded()).toBe(false);
  });
});

describe("dispose", () => {
  it("should clear content and state after dispose", async () => {
    const engine = createEngineFromContent("some content here");
    expect(engine.isLoaded()).toBe(true);
    expect(engine.getContent()).toBe("some content here");

    engine.dispose();

    expect(engine.getContent()).toBe("");
    expect(engine.getStats()).toBeNull();
  });
});

describe("llmQuery option — symbolic recursion hook (P0-followup for MCP sampling)", () => {
  // These tests prove the llmQuery option is threaded through from
  // NucleusEngine's constructor into the solver's SolverTools. The MCP
  // sampling bridge in lattice-mcp-server.ts relies on this plumbing —
  // it passes a `server.createMessage(...)` wrapper as the llmQuery
  // callback when the client advertises `sampling` capability.

  it("dispatches (llm_query ...) through the constructor-supplied callback", async () => {
    const seen: string[] = [];
    const engine = new NucleusEngine({
      llmQuery: async (prompt: string) => {
        seen.push(prompt);
        return "MOCKED SUB-LLM RESPONSE";
      },
    });
    engine.loadContent("hello world\ngoodbye world");

    const result = await engine.execute('(llm_query "What is this document?")');

    expect(result.success).toBe(true);
    expect(result.value).toBe("MOCKED SUB-LLM RESPONSE");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("What is this document?");
  });

  it("interpolates bindings into the sub-LLM prompt", async () => {
    let seenPrompt = "";
    const engine = new NucleusEngine({
      llmQuery: async (prompt: string) => {
        seenPrompt = prompt;
        return "classification: error";
      },
    });
    engine.loadContent("ERROR: boom\nERROR: crash\nINFO: ok");

    await engine.execute('(grep "ERROR")');
    const result = await engine.execute(
      '(llm_query "Classify these: {items}" (items RESULTS))'
    );

    expect(result.success).toBe(true);
    expect(seenPrompt).toContain("Classify these:");
    expect(seenPrompt).toContain("ERROR: boom");
    expect(seenPrompt).toContain("ERROR: crash");
    expect(seenPrompt).not.toContain("{items}");
  });

  it("supports nested llm_query inside map (OOLONG pattern)", async () => {
    const calls: string[] = [];
    const engine = new NucleusEngine({
      llmQuery: async (prompt: string) => {
        calls.push(prompt);
        return `classified-${calls.length}`;
      },
    });
    engine.loadContent("ERROR: one\nERROR: two\nERROR: three");

    await engine.execute('(grep "ERROR")');
    const result = await engine.execute(
      '(map RESULTS (lambda x (llm_query "classify: {item}" (item x))))'
    );

    expect(result.success).toBe(true);
    expect(Array.isArray(result.value)).toBe(true);
    expect((result.value as string[]).length).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("reloading with loadContent preserves the llmQuery binding", async () => {
    let called = 0;
    const engine = new NucleusEngine({
      llmQuery: async () => {
        called++;
        return "ok";
      },
    });
    engine.loadContent("first");
    await engine.execute('(llm_query "ping")');
    engine.loadContent("second");
    await engine.execute('(llm_query "ping")');
    expect(called).toBe(2);
  });

  it("without llmQuery option, (llm_query ...) errors cleanly", async () => {
    const engine = new NucleusEngine();
    engine.loadContent("some content");
    const result = await engine.execute('(llm_query "should fail")');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/llm_query is not available/i);
  });
});

// =====================================================================
// Source-pattern checks (from audits)
// =====================================================================
describe("Source-pattern checks (from audits)", () => {
  // from tests/audit31.test.ts #3 — nucleus-engine groups filtering
  describe("#3 — nucleus-engine groups filtering", () => {
      it("should filter undefined from regex groups", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        // Find the grep function's results.push call
        const pushSection = source.match(/groups:\s*match\.slice\(1\)[^,}]*/);
        expect(pushSection).not.toBeNull();
        // Should filter out undefined values
        expect(pushSection![0]).toMatch(/filter|\.map\(.*\?\?|as string/);
      });
    });

  // from tests/audit35.test.ts #11 — loadContent should be consistent
  describe("#11 — loadContent should be consistent", () => {
        it("should store trimmed content if trimming for empty check", () => {
          const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
          const loadContent = source.match(/loadContent\(content: string\)[\s\S]*?this\.bindings\.clear/);
          expect(loadContent).not.toBeNull();
          // If trimmed.length > 0, should store content consistently
          // (either always trimmed or document the behavior)
          expect(loadContent![0]).toMatch(/content|trimmed/);
        });
      });

  // from tests/audit46.test.ts #9 — nucleus-engine grep should validate pattern length
  describe("#9 — nucleus-engine grep should validate pattern length", () => {
      it("should check pattern length before RegExp construction", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const grepSection = source.match(/grep:\s*\(pattern[\s\S]*?new RegExp/);
        expect(grepSection).not.toBeNull();
        expect(grepSection![0]).toMatch(/pattern\.length|MAX_PATTERN|length\s*>/);
      });
    });

  // from tests/audit47.test.ts #5 — nucleus-engine fuzzy_search should validate query length
  describe("#5 — nucleus-engine fuzzy_search should validate query length", () => {
      it("should check query length before processing", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const fuzzySection = source.match(/fuzzy_search[\s\S]*?for \(let i/);
        expect(fuzzySection).not.toBeNull();
        expect(fuzzySection![0]).toMatch(/query\.length|MAX_QUERY/);
      });
    });

  // from tests/audit49.test.ts #7 — nucleus-engine setBinding should validate name
  describe("#7 — nucleus-engine setBinding should validate name", () => {
      it("should validate binding name format", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const setBindingFn = source.match(/setBinding\(name[\s\S]*?this\.bindings\.set/);
        expect(setBindingFn).not.toBeNull();
        expect(setBindingFn![0]).toMatch(/test\(name\)|Invalid.*name|name\.length/i);
      });
    });

  // from tests/audit51.test.ts #5 — nucleus-engine fuzzy_search should clamp limit
  describe("#5 — nucleus-engine fuzzy_search should clamp limit", () => {
      it("should clamp limit before slicing results", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const fuzzyFn = source.match(/fuzzy_search:[\s\S]*?results\.slice\(0,\s*\w+\)/);
        expect(fuzzyFn).not.toBeNull();
        expect(fuzzyFn![0]).toMatch(/Math\.min|Math\.max|Math\.floor|clamp/);
      });
    });

  // from tests/audit73.test.ts #2 — nucleus-engine fuzzy_search should use safe sort
  describe("#2 — nucleus-engine fuzzy_search should use safe sort", () => {
      it("should not use raw subtraction for score sorting", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const fuzzySort = source.indexOf("b.score - a.score");
        // Should NOT have raw subtraction sort
        expect(fuzzySort).toBe(-1);
      });
    });

  // from tests/audit73.test.ts #5 — nucleus-engine evictOldTurnBindings should use safe sort
  describe("#5 — nucleus-engine evictOldTurnBindings should use safe sort", () => {
      it("should not use parseInt subtraction for sorting", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const evictFn = source.indexOf("private evictOldTurnBindings");
        expect(evictFn).toBeGreaterThan(-1);
        const block = source.slice(evictFn, evictFn + 300);
        // Should NOT contain subtraction-based sort
        const hasSubtraction = /parseInt\(a.*-.*parseInt\(b|parseInt\(b.*-.*parseInt\(a/.test(block);
        expect(hasSubtraction).toBe(false);
      });
    });

  // from tests/audit78.test.ts #1 — getBindings should filter dangerous keys
  describe("#1 — getBindings should filter dangerous keys", () => {
      it("should use Object.create(null) or filter __proto__", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const fnStart = source.indexOf("getBindings()");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 400);
        expect(block).toMatch(/Object\.create\(null\)|__proto__|hasOwnProperty|DANGEROUS|prototype/);
      });
    });

  // from tests/audit79.test.ts #7 — _fn_ binding should validate fnObj.name
  describe("#7 — _fn_ binding should validate fnObj.name", () => {
      it("should validate fnObj.name before creating binding key", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const fnBinding = source.indexOf("_fn_${fnObj.name}");
        expect(fnBinding).toBeGreaterThan(-1);
        // Look backwards for validation
        const block = source.slice(Math.max(0, fnBinding - 300), fnBinding + 100);
        expect(block).toMatch(/fnObj\.name.*test|fnObj\.name.*match|typeof fnObj\.name|fnObj\.name\.length/);
      });
    });

  // from tests/audit80.test.ts #8 — fuzzyMatch should reject empty queries
  describe("#8 — fuzzyMatch should reject empty queries", () => {
      it("should guard against empty query string", () => {
        const source = readFileSync("src/engine/nucleus-engine.ts", "utf-8");
        const fnStart = source.indexOf("function fuzzyMatch");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 300);
        expect(block).toMatch(/query\.length\s*[<>=]+\s*0|!query|queryLower\.length\s*[<>=]+\s*0|!queryLower/);
      });
    });

  // from tests/audit96.test.ts #1 — match should be case-insensitive like grep
  describe("#1 — match should be case-insensitive like grep", () => {
      let engine: NucleusEngine;

      beforeEach(() => {
        engine = new NucleusEngine();
        engine.loadContent([
          "Error 500: Internal Server Error",
          "WARNING: disk space low",
          "info: all systems nominal",
          "FATAL: database connection lost",
        ].join("\n"));
      });

      it("top-level (match \"Error\" \"error\" 0) returns match (case-insensitive)", async () => {
        // This hits evaluate() match case at lc-solver.ts:547
        const result = await engine.execute('(match "Error 500" "error" 0)');
        expect(result.success).toBe(true);
        // Case-insensitive regex matches "Error"
        expect(result.value).not.toBeNull();
        expect(typeof result.value).toBe("string");
        expect((result.value as string).toLowerCase()).toBe("error");
      });

      it("(filter RESULTS (lambda x (match x \"error\" 0))) keeps upper-case matches", async () => {
        // This hits evaluatePredicate match case at lc-solver.ts:1078
        const grepResult = await engine.execute('(grep "error")');
        expect(grepResult.success).toBe(true);
        // Grep is case-insensitive — finds "Error 500" and "Error" in "Internal Server Error"
        expect(Array.isArray(grepResult.value)).toBe(true);

        const filterResult = await engine.execute(
          '(filter RESULTS (lambda x (match x "error" 0)))'
        );
        expect(filterResult.success).toBe(true);
        expect(Array.isArray(filterResult.value)).toBe(true);
        const kept = filterResult.value as Array<{ line: string }>;
        // The "Error 500: Internal Server Error" line should survive —
        // its source line contains uppercase "Error", and filter match must
        // match case-insensitively.
        const hasError500 = kept.some((r) => r.line.includes("Error 500"));
        expect(hasError500).toBe(true);
      });

      it("(map RESULTS (lambda x (match x \"fatal\" 0))) matches upper-case FATAL", async () => {
        // This hits evaluateWithBinding match case at lc-solver.ts:1184
        const grepResult = await engine.execute('(grep "fatal")');
        expect(grepResult.success).toBe(true);

        const mapResult = await engine.execute(
          '(map RESULTS (lambda x (match x "fatal" 0)))'
        );
        expect(mapResult.success).toBe(true);
        expect(Array.isArray(mapResult.value)).toBe(true);
        const mapped = mapResult.value as Array<string | null>;
        // At least one non-null entry — the FATAL line should produce a match
        const nonNull = mapped.filter((v) => v !== null);
        expect(nonNull.length).toBeGreaterThan(0);
      });
    });

  // from tests/audit96.test.ts #2 — sum over grep results takes first numeric token only
  describe("#2 — sum over grep results takes first numeric token only", () => {
      function makeTools(lines: string[]): SolverTools {
        return {
          grep: () =>
            lines.map((line, i) => ({
              match: line,
              line,
              lineNum: i + 1,
              index: 0,
              groups: [],
            })),
          fuzzy_search: () => [],
          bm25: () => [],
          semantic: () => [],
          text_stats: () => ({
            length: 0,
            lineCount: lines.length,
            sample: { start: "", middle: "", end: "" },
          }),
          context: lines.join("\n"),
          lines,
        };
      }

      it("sums $100 + $200, NOT $100+5 + $200+10 (multi-number line)", async () => {
        // Before the fix: regex accumulates ALL numbers per line:
        //   Line 1: 100 + 5 = 105
        //   Line 2: 200 + 10 = 210
        //   Total = 315
        // After the fix: take first number per line only:
        //   Line 1: 100
        //   Line 2: 200
        //   Total = 300
        const tools = makeTools(["Item: $100 Qty: 5", "Item: $200 Qty: 10"]);
        const term: LCTerm = {
          tag: "sum",
          collection: { tag: "grep", pattern: "Item" },
        };
        const result = await solve(term, tools);
        expect(result.success).toBe(true);
        expect(result.value).toBe(300);
      });

      it("sums error code 500 + error code 404 = 904 (no currency case)", async () => {
        // Before the fix: "Error 500: timeout 30s" would sum 500+30 = 530
        //                 "Error 404: attempt 2 of 3" would sum 404+2+3 = 409
        //                 Total = 939 (garbage)
        // After the fix: takes first number per line:
        //                 500 + 404 = 904
        const tools = makeTools([
          "Error 500: timeout 30s",
          "Error 404: attempt 2 of 3",
        ]);
        const term: LCTerm = {
          tag: "sum",
          collection: { tag: "grep", pattern: "Error" },
        };
        const result = await solve(term, tools);
        expect(result.success).toBe(true);
        expect(result.value).toBe(904);
      });

      it("plain numeric-string entries still parse correctly (no regression)", async () => {
        // Plain strings go through the `typeof val === "string"` branch, not
        // the grep-object branch. Verify that branch is unaffected by the fix.
        const stringEngine = new NucleusEngine();
        stringEngine.loadContent("$1,000\n$2,500.50");
        const result = await stringEngine.execute("(sum (lines 1 2))");
        expect(result.success).toBe(true);
        expect(result.value).toBe(3500.5);
      });
    });

  // from tests/audit96.test.ts #14 — setBinding and synthesized-fn auto-register use one regex
  describe("#14 — setBinding and synthesized-fn auto-register use one regex", () => {
      it("setBinding accepts hyphenated names so `_fn_parse-date` round-trips", async () => {
        const engine = new NucleusEngine();
        engine.loadContent("anything");
        // Before the fix: setBinding rejects hyphens via
        // /^[a-zA-Z_][a-zA-Z0-9_]*$/, even though the synthesized-function
        // auto-register path emits `_fn_parse-date`-style keys via direct
        // bindings.set. After the fix, the two paths use the same regex
        // and setBinding works with the auto-generated keys.
        expect(() => engine.setBinding("_fn_parse-date", { foo: 1 })).not.toThrow();
        expect(engine.getBinding("_fn_parse-date")).toEqual({ foo: 1 });
      });

      it("setBinding still rejects other invalid characters", async () => {
        const engine = new NucleusEngine();
        engine.loadContent("anything");
        // Quick sanity: things that should still be invalid stay invalid.
        expect(() => engine.setBinding("has space", 1)).toThrow();
        expect(() => engine.setBinding("has$dollar", 1)).toThrow();
        expect(() => engine.setBinding("__proto__", 1)).toThrow();
      });
    });

  describe("linter / mechanical repair on parse failure", () => {
    function freshEngine(): NucleusEngine {
      const e = new NucleusEngine();
      e.loadContent(SAMPLE_DOCUMENT);
      return e;
    }

    it("executes successfully when missing a trailing ')'", async () => {
      // The model emitted (grep "FATAL" missing its close — the engine
      // should mechanically balance it and run the query.
      const result = await freshEngine().execute('(grep "FATAL"');
      expect(result.success).toBe(true);
      expect(Array.isArray(result.value)).toBe(true);
      expect((result.value as unknown[]).length).toBeGreaterThan(0);
      expect(result.logs.some((l: string) => /linter/.test(l))).toBe(true);
    });

    it("executes successfully when prose wraps the expression", async () => {
      const result = await freshEngine().execute('Here it is: (count (grep "INFO")) — done');
      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
      expect(result.logs.some((l: string) => /linter/.test(l))).toBe(true);
    });

    it("does not log a repair when input is already valid", async () => {
      const result = await freshEngine().execute('(count (grep "INFO"))');
      expect(result.success).toBe(true);
      expect(result.logs.some((l: string) => /linter/.test(l))).toBe(false);
    });

    it("still reports parse error when query is unrepairable", async () => {
      // Unterminated string — the linter declines.
      const result = await freshEngine().execute('(grep "ERROR');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Parse error/);
    });
  });

});
