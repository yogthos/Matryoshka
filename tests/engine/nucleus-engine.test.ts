import { describe, it, expect, beforeEach } from "vitest";
import { NucleusEngine, createEngine, createEngineFromContent } from "../../src/engine/nucleus-engine.js";

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
    it("should create engine without document", () => {
      const emptyEngine = new NucleusEngine();
      expect(emptyEngine.isLoaded()).toBe(false);
    });

    it("should load document content", () => {
      expect(engine.isLoaded()).toBe(true);
    });

    it("should report correct stats", () => {
      const stats = engine.getStats();
      expect(stats).not.toBeNull();
      expect(stats!.lineCount).toBe(12);
      expect(stats!.length).toBeGreaterThan(0);
    });

    it("should get raw content", () => {
      expect(engine.getContent()).toBe(SAMPLE_DOCUMENT);
    });
  });

  describe("grep command", () => {
    it("should find matches with grep", () => {
      const result = engine.execute('(grep "FATAL")');

      expect(result.success).toBe(true);
      expect(Array.isArray(result.value)).toBe(true);
      expect((result.value as unknown[]).length).toBe(3);
    });

    it("should return match details", () => {
      const result = engine.execute('(grep "FATAL")');
      const matches = result.value as Array<{ match: string; line: string; lineNum: number }>;

      expect(matches[0].match).toBe("FATAL");
      expect(matches[0].line).toContain("Database connection failed");
      expect(matches[0].lineNum).toBe(1);
    });

    it("should handle regex patterns", () => {
      const result = engine.execute('(grep "Sales:")');

      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(4);
    });

    it("should return empty array for no matches", () => {
      const result = engine.execute('(grep "NOTFOUND")');

      expect(result.success).toBe(true);
      expect(result.value).toEqual([]);
    });
  });

  describe("count command", () => {
    it("should count results after grep", () => {
      engine.execute('(grep "FATAL")');
      const result = engine.execute('(count RESULTS)');

      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
    });

    it("should count all lines with INFO", () => {
      engine.execute('(grep "INFO")');
      const result = engine.execute('(count RESULTS)');

      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
    });
  });

  describe("filter command", () => {
    it("should filter results with predicate", () => {
      engine.execute('(grep "FATAL")');
      const result = engine.execute('(filter RESULTS (lambda x (match x "Network" 0)))');

      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(1);
    });

    it("should filter for specific content", () => {
      engine.execute('(grep "FATAL")');
      const result = engine.execute('(filter RESULTS (lambda x (match x "Database" 0)))');

      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(1);
    });
  });

  describe("sum command", () => {
    it("should sum numeric values", () => {
      engine.execute('(grep "Sales")');
      const result = engine.execute('(sum RESULTS)');

      expect(result.success).toBe(true);
      // $1,500,000 + $2,300,000 + $1,800,000 + $2,400,000 = $8,000,000
      expect(result.value).toBe(8000000);
    });
  });

  describe("map command", () => {
    it("should extract values with map", () => {
      engine.execute('(grep "Sales")');
      // Extract the dollar amounts
      const result = engine.execute('(map RESULTS (lambda x (match x "\\\\$([0-9,]+)" 1)))');

      expect(result.success).toBe(true);
      // Map extracts from the .line property of grep results
      expect(result.value).toEqual(["1,500,000", "2,300,000", "1,800,000", "2,400,000"]);
    });
  });

  describe("text_stats command", () => {
    it("should return document statistics", () => {
      const result = engine.execute('(text_stats)');

      expect(result.success).toBe(true);
      const stats = result.value as { length: number; lineCount: number };
      expect(stats.lineCount).toBe(12);
      expect(stats.length).toBeGreaterThan(0);
    });
  });

  describe("lines command", () => {
    it("should return line range", () => {
      const result = engine.execute('(lines 1 3)');

      expect(result.success).toBe(true);
      expect(typeof result.value).toBe("string");
      expect((result.value as string).split("\n").length).toBe(3);
    });
  });

  describe("string operations", () => {
    it("should match pattern and extract group", () => {
      const result = engine.execute('(match "Sales Q1: $1,500,000" "\\\\$([0-9,]+)" 1)');

      expect(result.success).toBe(true);
      expect(result.value).toBe("1,500,000");
    });

    it("should replace pattern", () => {
      const result = engine.execute('(replace "hello world" "world" "universe")');

      expect(result.success).toBe(true);
      expect(result.value).toBe("hello universe");
    });

    it("should split string", () => {
      const result = engine.execute('(split "a,b,c" "," 1)');

      expect(result.success).toBe(true);
      expect(result.value).toBe("b");
    });

    it("should parse integer", () => {
      const result = engine.execute('(parseInt "42")');

      expect(result.success).toBe(true);
      expect(result.value).toBe(42);
    });

    it("should parse float", () => {
      const result = engine.execute('(parseFloat "3.14")');

      expect(result.success).toBe(true);
      expect(result.value).toBe(3.14);
    });
  });

  describe("bindings and state", () => {
    it("should maintain RESULTS across commands", () => {
      engine.execute('(grep "FATAL")');

      const bindings = engine.getBindings();
      expect(bindings.RESULTS).toBe("Array[3]");
    });

    it("should create numbered bindings", () => {
      engine.execute('(grep "FATAL")');
      engine.execute('(count RESULTS)');

      const bindings = engine.getBindings();
      expect(bindings._1).toBe("Array[3]");
      expect(bindings._2).toBe(3);
    });

    it("should allow manual binding", () => {
      engine.setBinding("myVar", 42);
      expect(engine.getBinding("myVar")).toBe(42);
    });

    it("should reset state", () => {
      engine.execute('(grep "FATAL")');
      expect(Object.keys(engine.getBindings()).length).toBeGreaterThan(0);

      engine.reset();
      expect(Object.keys(engine.getBindings()).length).toBe(0);
    });

    it("should preserve RESULTS when executing scalar operations", () => {
      engine.execute('(grep "FATAL")');
      const countResult = engine.execute('(count RESULTS)');

      // RESULTS should still be the array, not the count
      const results = engine.getBinding("RESULTS") as unknown[];
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);
      expect(countResult.value).toBe(3);
    });
  });

  describe("error handling", () => {
    it("should return error for invalid syntax", () => {
      const result = engine.execute('(grep "unclosed');

      expect(result.success).toBe(false);
      expect(result.error).toContain("Parse error");
    });

    it("should return error for unknown command", () => {
      const result = engine.execute('(unknownCommand "test")');

      expect(result.success).toBe(false);
    });

    it("should return error when no document loaded", () => {
      const emptyEngine = new NucleusEngine();
      const result = emptyEngine.execute('(grep "test")');

      expect(result.success).toBe(false);
      expect(result.error).toContain("No document loaded");
    });
  });

  describe("executeAll", () => {
    it("should execute multiple commands in sequence", () => {
      const results = engine.executeAll([
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
    it("should return command reference", () => {
      const ref = NucleusEngine.getCommandReference();

      expect(ref).toContain("grep");
      expect(ref).toContain("filter");
      expect(ref).toContain("RESULTS");
    });
  });
});

describe("Factory functions", () => {
  it("should create engine from content", () => {
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
