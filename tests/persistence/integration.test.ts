import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SessionDB,
  HandleRegistry,
  HandleOps,
  FTS5Search,
  CheckpointManager,
} from "../../src/persistence/index.js";

describe("Handle System Integration", () => {
  let db: SessionDB;
  let registry: HandleRegistry;
  let ops: HandleOps;
  let search: FTS5Search;
  let checkpoints: CheckpointManager;

  const sampleDocument = `2024-01-15 ERROR: Database timeout - Connection failed after 30s
2024-01-15 INFO: Server started on port 3000
2024-01-15 ERROR: Authentication failed for user john@example.com
2024-01-15 WARNING: Memory usage at 85%
2024-01-15 ERROR: File not found: /data/config.json
2024-01-15 INFO: Processing batch job #1234
Sales Q1: $1,500,000
Sales Q2: $2,300,000
Sales Q3: $1,800,000
Sales Q4: $2,400,000`;

  beforeEach(() => {
    db = new SessionDB();
    db.loadDocument(sampleDocument);
    registry = new HandleRegistry(db);
    ops = new HandleOps(db, registry);
    search = new FTS5Search(db);
    checkpoints = new CheckpointManager(db, registry);
  });

  afterEach(() => {
    db.close();
  });

  describe("typical analysis workflow", () => {
    it("should handle grep -> filter -> count workflow", () => {
      // Step 1: Search for errors using FTS5
      const searchResults = search.search("ERROR");
      expect(searchResults).toHaveLength(3);

      // Step 2: Store results as handle
      const handle = registry.store(searchResults);
      registry.setResults(handle);
      expect(handle).toBe("$res1");

      // Step 3: Filter for specific error type
      const filteredHandle = ops.filter(handle, "item.content.includes('timeout')");
      registry.setResults(filteredHandle);

      // Step 4: Count filtered results
      const count = ops.count(filteredHandle);
      expect(count).toBe(1);

      // Context should show stubs, not full data
      const context = registry.buildContext();
      expect(context).toContain("$res1");
      expect(context).toContain("$res2");
      expect(context.length).toBeLessThan(500);
    });

    it("should handle sales aggregation workflow", () => {
      // Step 1: Find sales lines
      const salesResults = search.search("Sales");
      expect(salesResults).toHaveLength(4);

      // Step 2: Store and extract amounts
      const handle = registry.store(salesResults);
      const amountsHandle = ops.map(handle, "parseInt(item.content.match(/\\$([\\d,]+)/)?.[1]?.replace(/,/g, '') || '0')");

      // Step 3: Sum the amounts
      const amounts = registry.get(amountsHandle);
      const total = (amounts as number[]).reduce((a, b) => a + b, 0);
      expect(total).toBe(8000000);
    });

    it("should preserve state across operations", () => {
      // First operation
      const errors = search.search("ERROR");
      const h1 = registry.store(errors);
      registry.setResults(h1);

      // Second operation on same data
      const filtered = ops.filter(h1, "item.content.includes('Database')");
      registry.setResults(filtered);

      // Third operation
      const count = ops.count(filtered);
      expect(count).toBe(1);

      // Original handle should still be accessible
      const originalData = registry.get(h1);
      expect(originalData).toHaveLength(3);
    });
  });

  describe("checkpoint and resume", () => {
    it("should checkpoint and restore session state", () => {
      // Build up some state
      const errors = search.search("ERROR");
      const h1 = registry.store(errors);
      registry.setResults(h1);

      const filtered = ops.filter(h1, "item.content.includes('timeout')");
      registry.setResults(filtered);

      // Save checkpoint at turn 2
      checkpoints.save(2);

      // Continue working...
      const moreFiltered = ops.filter(filtered, "false");  // Empty result
      registry.setResults(moreFiltered);

      // Oops, let's go back to turn 2
      checkpoints.restore(2);

      // Should have filtered results again
      const count = ops.count(registry.getResults()!);
      expect(count).toBe(1);
    });

    it("should handle multi-turn session", () => {
      // Turn 1: Search
      const results1 = search.search("ERROR");
      registry.store(results1);
      checkpoints.save(1);

      // Turn 2: Filter
      const h2 = ops.filter("$res1", "item.content.includes('timeout')");
      registry.setResults(h2);
      checkpoints.save(2);

      // Turn 3: Get different errors
      const h3 = ops.filter("$res1", "item.content.includes('Authentication')");
      registry.setResults(h3);
      checkpoints.save(3);

      // Jump back to turn 2
      checkpoints.restore(2);
      expect(ops.count(registry.getResults()!)).toBe(1);

      // Jump to turn 3
      checkpoints.restore(3);
      expect(ops.count(registry.getResults()!)).toBe(1);
    });
  });

  describe("token savings verification", () => {
    it("should achieve 97%+ token savings for large results", () => {
      // Generate large dataset
      const largeData = Array.from({ length: 1500 }, (_, i) => ({
        line: `Error ${i}: Some error message with details about what went wrong at timestamp ${Date.now()}`,
        lineNum: i + 1,
        index: i * 100,
      }));

      // Store and get stub
      const handle = registry.store(largeData);
      const stub = registry.getStub(handle);
      const fullDataSize = JSON.stringify(largeData).length;

      // Calculate savings
      const stubSize = stub.length;
      const savings = (1 - stubSize / fullDataSize) * 100;

      expect(savings).toBeGreaterThan(97);
      expect(stubSize).toBeLessThan(200);  // Stub should be very compact
    });

    it("should maintain minimal context size across operations", () => {
      // Multiple operations that each produce results
      const r1 = search.search("ERROR");
      registry.store(r1);

      const r2 = search.search("INFO");
      registry.store(r2);

      const r3 = search.search("Sales");
      registry.store(r3);

      // Context with all handles should still be compact
      const context = registry.buildContext();
      expect(context.length).toBeLessThan(1000);
    });
  });

  describe("handle operations chain", () => {
    it("should chain filter -> map -> count", () => {
      const results = search.search("Sales");
      const h1 = registry.store(results);

      // Filter Q1 and Q2
      const h2 = ops.filter(h1, "item.content.includes('Q1') || item.content.includes('Q2')");

      // Map to amounts
      const h3 = ops.map(h2, "parseInt(item.content.match(/\\$([\\d,]+)/)?.[1]?.replace(/,/g, '') || '0')");

      // Sum
      const amounts = registry.get(h3) as number[];
      const total = amounts.reduce((a, b) => a + b, 0);

      expect(total).toBe(3800000);  // Q1 + Q2
    });

    it("should handle empty intermediate results", () => {
      const results = search.search("NOTFOUND");
      const h1 = registry.store(results);

      // Filter empty results
      const h2 = ops.filter(h1, "true");

      // Count should be 0
      const count = ops.count(h2);
      expect(count).toBe(0);
    });
  });

  describe("FTS5 vs regex grep comparison", () => {
    it("should match FTS5 results with regex grep for simple patterns", () => {
      const ftsResults = search.search("ERROR");
      const grepResults = search.grepToFTS("ERROR");

      expect(ftsResults).toHaveLength(grepResults.length);
    });

    it("should handle complex patterns with fallback", () => {
      // Date pattern - complex regex that can't be FTS5
      const results = search.grepToFTS("\\d{4}-\\d{2}-\\d{2}");

      // Should still find date lines
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("describe and preview operations", () => {
    it("should describe handle contents", () => {
      const results = search.search("ERROR");
      const handle = registry.store(results);

      const desc = ops.describe(handle);

      expect(desc.count).toBe(3);
      expect(desc.fields).toContain("content");
      expect(desc.fields).toContain("lineNum");
    });

    it("should preview handle contents", () => {
      const results = search.search("ERROR");
      const handle = registry.store(results);

      const preview = ops.preview(handle, 2);

      expect(preview).toHaveLength(2);
      expect(preview[0].content).toContain("ERROR");
    });

    it("should sample handle contents", () => {
      const results = search.search("ERROR");
      const handle = registry.store(results);

      const sample = ops.sample(handle, 2);

      expect(sample).toHaveLength(2);
    });
  });
});

describe("Error handling", () => {
  let db: SessionDB;
  let registry: HandleRegistry;
  let ops: HandleOps;

  beforeEach(() => {
    db = new SessionDB();
    registry = new HandleRegistry(db);
    ops = new HandleOps(db, registry);
  });

  afterEach(() => {
    db.close();
  });

  it("should handle invalid handle gracefully", () => {
    expect(() => ops.count("$resINVALID")).toThrow();
  });

  it("should handle malformed predicate", () => {
    const handle = registry.store([{ a: 1 }]);
    expect(() => ops.filter(handle, "this is not valid javascript")).toThrow();
  });

  it("should handle empty document", () => {
    db.loadDocument("");
    expect(db.getLineCount()).toBe(0);
  });
});
