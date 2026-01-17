import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FTS5Search } from "../../src/persistence/fts5-search.js";
import { SessionDB } from "../../src/persistence/session-db.js";

describe("FTS5Search", () => {
  let db: SessionDB;
  let search: FTS5Search;

  const sampleDocument = `2024-01-15 10:30:45 ERROR: Database connection failed
2024-01-15 10:31:00 INFO: Retrying connection attempt 1
2024-01-15 10:31:15 ERROR: Connection timeout after 30 seconds
2024-01-15 10:31:30 WARNING: Memory usage at 85%
2024-01-15 10:32:00 INFO: Connection established successfully
2024-01-15 10:32:15 ERROR: Query execution failed: syntax error
2024-01-15 10:32:30 DEBUG: Cache hit ratio: 0.95
Sales Report Q1: Total revenue $1,500,000
Sales Report Q2: Total revenue $2,300,000
Sales Report Q3: Total revenue $1,800,000
Customer: John Smith purchased item #12345
Customer: Jane Doe purchased item #67890`;

  beforeEach(() => {
    db = new SessionDB();
    db.loadDocument(sampleDocument);
    search = new FTS5Search(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("basic search", () => {
    it("should find simple term matches", () => {
      const results = search.search("ERROR");

      expect(results).toHaveLength(3);
      results.forEach(r => {
        expect(r.content.toLowerCase()).toContain("error");
      });
    });

    it("should be case-insensitive", () => {
      const results1 = search.search("error");
      const results2 = search.search("ERROR");
      const results3 = search.search("Error");

      expect(results1).toHaveLength(results2.length);
      expect(results2).toHaveLength(results3.length);
    });

    it("should return line numbers", () => {
      const results = search.search("ERROR");

      expect(results[0].lineNum).toBe(1);  // First error on line 1
      expect(results[1].lineNum).toBe(3);  // Second error on line 3
    });

    it("should return empty for no matches", () => {
      const results = search.search("NOTFOUND");

      expect(results).toHaveLength(0);
    });
  });

  describe("phrase search", () => {
    it("should find exact phrases", () => {
      const results = search.search('"Database connection"');

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("Database connection failed");
    });

    it("should not match non-adjacent words", () => {
      const results = search.search('"connection Database"');  // Wrong order

      expect(results).toHaveLength(0);
    });
  });

  describe("boolean search", () => {
    it("should support AND (implicit)", () => {
      const results = search.search("ERROR connection");

      expect(results).toHaveLength(2);  // Lines with both ERROR and connection
    });

    it("should support OR operator", () => {
      const results = search.search("WARNING OR DEBUG");

      expect(results).toHaveLength(2);  // One WARNING, one DEBUG
    });

    it("should support NOT operator", () => {
      const results = search.search("ERROR NOT connection");

      expect(results).toHaveLength(1);  // Error without connection = syntax error line
    });
  });

  describe("prefix search", () => {
    it("should match word prefixes with *", () => {
      const results = search.search("connect*");

      expect(results.length).toBeGreaterThan(1);
      results.forEach(r => {
        expect(r.content.toLowerCase()).toMatch(/connect/);
      });
    });
  });

  describe("proximity search", () => {
    it("should find words within distance with NEAR", () => {
      const results = search.search("NEAR(connection failed, 2)");

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("connection failed");
    });

    it("should not match words too far apart", () => {
      const results = search.search("NEAR(ERROR successfully, 2)");

      expect(results).toHaveLength(0);  // Too far apart
    });
  });

  describe("column filtering", () => {
    it("should search specific content", () => {
      // Search only in the indexed content column
      const results = search.search("Sales");

      expect(results).toHaveLength(3);
    });
  });

  describe("result ordering", () => {
    it("should return results in line order by default", () => {
      const results = search.search("ERROR");

      expect(results[0].lineNum).toBeLessThan(results[1].lineNum);
      expect(results[1].lineNum).toBeLessThan(results[2].lineNum);
    });

    it("should support relevance ranking", () => {
      // Create document with varying relevance
      const testDoc = `error error error on line 1
just one error here
error error on this line`;

      const testDb = new SessionDB();
      testDb.loadDocument(testDoc);
      const testSearch = new FTS5Search(testDb);

      const results = testSearch.searchByRelevance("error");

      // Line with most occurrences should rank highest
      expect(results[0].content).toContain("error error error");

      testDb.close();
    });
  });

  describe("highlighting", () => {
    it("should highlight matching terms", () => {
      const results = search.searchWithHighlights("ERROR");

      expect(results[0].highlighted).toContain("<mark>ERROR</mark>");
    });

    it("should support custom highlight markers", () => {
      const results = search.searchWithHighlights("ERROR", {
        openTag: "**",
        closeTag: "**"
      });

      expect(results[0].highlighted).toContain("**ERROR**");
    });
  });

  describe("snippets", () => {
    it("should extract relevant snippets", () => {
      const results = search.searchWithSnippets("revenue");

      expect(results).toHaveLength(3);
      results.forEach(r => {
        expect(r.snippet).toContain("revenue");
        expect(r.snippet.length).toBeLessThan(r.content.length + 20);  // Snippet may include markers
      });
    });
  });

  describe("batch operations", () => {
    it("should execute multiple searches efficiently", () => {
      const queries = ["ERROR", "WARNING", "INFO"];
      const results = search.searchBatch(queries);

      expect(results.ERROR).toHaveLength(3);
      expect(results.WARNING).toHaveLength(1);
      expect(results.INFO).toHaveLength(2);
    });
  });

  describe("integration with grep pattern", () => {
    it("should convert simple regex to FTS5 query", () => {
      const results = search.grepToFTS("error");

      expect(results).toHaveLength(3);
    });

    it("should handle alternation pattern", () => {
      const results = search.grepToFTS("error|warning");

      // FTS5 OR query
      expect(results.length).toBeGreaterThan(3);
    });

    it("should fall back to regex for complex patterns", () => {
      // Complex regex that can't be converted to FTS5
      const results = search.grepToFTS("\\d{4}-\\d{2}-\\d{2}");

      // Should still work, just uses regex fallback
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
