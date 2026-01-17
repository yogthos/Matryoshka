import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HandleRegistry } from "../../src/persistence/handle-registry.js";
import { SessionDB } from "../../src/persistence/session-db.js";

describe("HandleRegistry", () => {
  let db: SessionDB;
  let registry: HandleRegistry;

  beforeEach(() => {
    db = new SessionDB();
    registry = new HandleRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("handle creation", () => {
    it("should store array and return handle", () => {
      const data = [
        { line: "Error 1", lineNum: 1 },
        { line: "Error 2", lineNum: 2 },
      ];
      const handle = registry.store(data);
      expect(handle).toMatch(/^\$res\d+$/);
    });

    it("should generate incrementing handles", () => {
      const h1 = registry.store([{ a: 1 }]);
      const h2 = registry.store([{ b: 2 }]);

      expect(h1).toBe("$res1");
      expect(h2).toBe("$res2");
    });

    it("should retrieve full data by handle", () => {
      const data = [
        { line: "Error 1", lineNum: 1 },
        { line: "Error 2", lineNum: 2 },
      ];
      const handle = registry.store(data);
      const retrieved = registry.get(handle);

      expect(retrieved).toEqual(data);
    });

    it("should return null for invalid handle", () => {
      const result = registry.get("$resNOTEXIST");
      expect(result).toBeNull();
    });
  });

  describe("metadata stubs", () => {
    it("should generate metadata stub for array handle", () => {
      const data = [
        { line: "Error 1", lineNum: 1, index: 0 },
        { line: "Error 2", lineNum: 5, index: 100 },
        { line: "Error 3", lineNum: 10, index: 200 },
      ];
      const handle = registry.store(data);
      const stub = registry.getStub(handle);

      expect(stub).toContain("$res1");
      expect(stub).toContain("Array(3)");
      expect(stub).toContain("Error 1");  // Preview of first item
    });

    it("should truncate preview for long data", () => {
      const data = Array.from({ length: 1500 }, (_, i) => ({
        line: `Line ${i}`,
        lineNum: i + 1,
      }));
      const handle = registry.store(data);
      const stub = registry.getStub(handle);

      expect(stub).toContain("Array(1500)");
      expect(stub.length).toBeLessThan(200);  // Stub should be compact
    });

    it("should include type info in stub", () => {
      const data = [
        { line: "Sales: $1,000", lineNum: 1 },
      ];
      const handle = registry.store(data);
      const stub = registry.getStub(handle);

      expect(stub).toContain("Array(1)");
    });
  });

  describe("context building", () => {
    it("should build context with handle stubs only", () => {
      // Store some data
      const data1 = Array.from({ length: 1500 }, (_, i) => ({ line: `Line ${i}`, lineNum: i }));
      const data2 = [{ line: "Single item", lineNum: 1 }];

      const h1 = registry.store(data1);
      const h2 = registry.store(data2);

      const context = registry.buildContext();

      // Context should include stubs, not full data
      expect(context).toContain(h1);
      expect(context).toContain(h2);
      expect(context).toContain("Array(1500)");
      expect(context).toContain("Array(1)");
      expect(context.length).toBeLessThan(500);  // Much smaller than raw data
    });

    it("should format stubs for LLM readability", () => {
      const data = [{ line: "Error", lineNum: 1 }];
      registry.store(data);

      const context = registry.buildContext();
      expect(context).toContain("$res1:");
    });
  });

  describe("RESULTS binding", () => {
    it("should track current RESULTS handle", () => {
      const data = [{ line: "Test", lineNum: 1 }];
      const handle = registry.store(data);
      registry.setResults(handle);

      expect(registry.getResults()).toBe(handle);
    });

    it("should resolve RESULTS to actual data", () => {
      const data = [{ line: "Test", lineNum: 1 }];
      const handle = registry.store(data);
      registry.setResults(handle);

      const resolved = registry.resolveResults();
      expect(resolved).toEqual(data);
    });
  });

  describe("handle deletion", () => {
    it("should delete handle and free data", () => {
      const data = [{ line: "Test", lineNum: 1 }];
      const handle = registry.store(data);
      registry.delete(handle);

      expect(registry.get(handle)).toBeNull();
    });

    it("should allow reuse of deleted handle numbers", () => {
      // This tests that handles are not reused (they increment forever)
      const h1 = registry.store([{ a: 1 }]);
      registry.delete(h1);
      const h2 = registry.store([{ b: 2 }]);

      // Handle counter should continue incrementing
      expect(h2).toBe("$res2");
    });
  });

  describe("handle inspection", () => {
    it("should list all active handles", () => {
      registry.store([{ a: 1 }]);
      registry.store([{ b: 2 }]);
      registry.store([{ c: 3 }]);

      const handles = registry.listHandles();
      expect(handles).toHaveLength(3);
      expect(handles).toContain("$res1");
      expect(handles).toContain("$res2");
      expect(handles).toContain("$res3");
    });

    it("should get handle count info", () => {
      const data = Array.from({ length: 100 }, (_, i) => ({ line: `Line ${i}`, lineNum: i }));
      const handle = registry.store(data);

      const count = registry.getCount(handle);
      expect(count).toBe(100);
    });
  });
});
