import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HandleOps } from "../../src/persistence/handle-ops.js";
import { HandleRegistry } from "../../src/persistence/handle-registry.js";
import { SessionDB } from "../../src/persistence/session-db.js";

describe("HandleOps", () => {
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

  describe("count_handle", () => {
    it("should count items in handle", () => {
      const data = [
        { line: "Error 1", lineNum: 1 },
        { line: "Error 2", lineNum: 2 },
        { line: "Error 3", lineNum: 3 },
      ];
      const handle = registry.store(data);
      const count = ops.count(handle);

      expect(count).toBe(3);
    });

    it("should return 0 for empty handle", () => {
      const handle = registry.store([]);
      const count = ops.count(handle);

      expect(count).toBe(0);
    });

    it("should throw for invalid handle", () => {
      expect(() => ops.count("$resINVALID")).toThrow();
    });
  });

  describe("sum_handle", () => {
    it("should sum numeric field in handle data", () => {
      const data = [
        { line: "Sales: $1000", lineNum: 1, amount: 1000 },
        { line: "Sales: $2000", lineNum: 2, amount: 2000 },
        { line: "Sales: $3000", lineNum: 3, amount: 3000 },
      ];
      const handle = registry.store(data);
      const sum = ops.sum(handle, "amount");

      expect(sum).toBe(6000);
    });

    it("should sum by extracting numbers from line field", () => {
      const data = [
        { line: "Sales: $1,000", lineNum: 1 },
        { line: "Sales: $2,000", lineNum: 2 },
        { line: "Sales: $3,000", lineNum: 3 },
      ];
      const handle = registry.store(data);
      const sum = ops.sumFromLine(handle);

      expect(sum).toBe(6000);
    });

    it("should return 0 for empty handle", () => {
      const handle = registry.store([]);
      const sum = ops.sum(handle, "amount");

      expect(sum).toBe(0);
    });
  });

  describe("filter_handle", () => {
    const sampleData = [
      { line: "Error: timeout", lineNum: 1, type: "error" },
      { line: "Warning: slow", lineNum: 2, type: "warning" },
      { line: "Error: crash", lineNum: 3, type: "error" },
      { line: "Info: started", lineNum: 4, type: "info" },
    ];

    it("should filter by predicate string", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.filter(handle, "item.type === 'error'");

      const result = registry.get(resultHandle);
      expect(result).toHaveLength(2);
      expect(result![0].line).toContain("timeout");
      expect(result![1].line).toContain("crash");
    });

    it("should filter by line content match", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.filter(handle, "item.line.includes('Error')");

      const result = registry.get(resultHandle);
      expect(result).toHaveLength(2);
    });

    it("should filter with regex pattern", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.filter(handle, "/timeout|crash/.test(item.line)");

      const result = registry.get(resultHandle);
      expect(result).toHaveLength(2);
    });

    it("should return new handle, not mutate original", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.filter(handle, "item.type === 'error'");

      expect(resultHandle).not.toBe(handle);
      expect(registry.get(handle)).toHaveLength(4);  // Original unchanged
      expect(registry.get(resultHandle)).toHaveLength(2);  // Filtered copy
    });

    it("should return empty handle for no matches", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.filter(handle, "item.type === 'notexist'");

      const result = registry.get(resultHandle);
      expect(result).toHaveLength(0);
    });
  });

  describe("map_handle", () => {
    const sampleData = [
      { line: "Sales: $1,000", lineNum: 1 },
      { line: "Sales: $2,000", lineNum: 2 },
      { line: "Sales: $3,000", lineNum: 3 },
    ];

    it("should transform data with expression", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.map(handle, "item.lineNum");

      const result = registry.get(resultHandle);
      expect(result).toEqual([1, 2, 3]);
    });

    it("should extract values from line", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.map(handle, "item.line.match(/\\$([\\d,]+)/)?.[1] || null");

      const result = registry.get(resultHandle);
      expect(result).toEqual(["1,000", "2,000", "3,000"]);
    });

    it("should allow complex transformations", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.map(handle, "({ lineNum: item.lineNum, doubled: item.lineNum * 2 })");

      const result = registry.get(resultHandle);
      expect(result).toHaveLength(3);
      expect(result![0]).toEqual({ lineNum: 1, doubled: 2 });
    });
  });

  describe("sort_handle", () => {
    const sampleData = [
      { line: "C item", lineNum: 3, score: 50 },
      { line: "A item", lineNum: 1, score: 100 },
      { line: "B item", lineNum: 2, score: 75 },
    ];

    it("should sort by field ascending", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.sort(handle, "lineNum", "asc");

      const result = registry.get(resultHandle);
      expect(result![0].lineNum).toBe(1);
      expect(result![1].lineNum).toBe(2);
      expect(result![2].lineNum).toBe(3);
    });

    it("should sort by field descending", () => {
      const handle = registry.store(sampleData);
      const resultHandle = ops.sort(handle, "score", "desc");

      const result = registry.get(resultHandle);
      expect(result![0].score).toBe(100);
      expect(result![1].score).toBe(75);
      expect(result![2].score).toBe(50);
    });
  });

  describe("preview", () => {
    it("should return first N items", () => {
      const data = Array.from({ length: 100 }, (_, i) => ({ line: `Line ${i}`, lineNum: i }));
      const handle = registry.store(data);

      const preview = ops.preview(handle, 5);
      expect(preview).toHaveLength(5);
      expect(preview[0].lineNum).toBe(0);
      expect(preview[4].lineNum).toBe(4);
    });

    it("should return all if less than N items", () => {
      const data = [{ line: "One", lineNum: 1 }, { line: "Two", lineNum: 2 }];
      const handle = registry.store(data);

      const preview = ops.preview(handle, 10);
      expect(preview).toHaveLength(2);
    });
  });

  describe("sample", () => {
    it("should return random N items", () => {
      const data = Array.from({ length: 100 }, (_, i) => ({ line: `Line ${i}`, lineNum: i }));
      const handle = registry.store(data);

      const sample = ops.sample(handle, 5);
      expect(sample).toHaveLength(5);
    });

    it("should return different items on multiple calls", () => {
      const data = Array.from({ length: 100 }, (_, i) => ({ line: `Line ${i}`, lineNum: i }));
      const handle = registry.store(data);

      const sample1 = ops.sample(handle, 5);
      const sample2 = ops.sample(handle, 5);

      // With 100 items and 5 samples, it's extremely unlikely to get same set twice
      const same = sample1.every((item, i) => item.lineNum === sample2[i].lineNum);
      // This might rarely fail but is acceptable for testing randomness
      expect(same).toBe(false);
    });
  });

  describe("describe", () => {
    it("should return schema and stats for handle", () => {
      const data = [
        { line: "Error 1", lineNum: 1, type: "error" },
        { line: "Error 2", lineNum: 2, type: "warning" },
      ];
      const handle = registry.store(data);

      const desc = ops.describe(handle);

      expect(desc.count).toBe(2);
      expect(desc.fields).toContain("line");
      expect(desc.fields).toContain("lineNum");
      expect(desc.fields).toContain("type");
    });

    it("should include sample values", () => {
      const data = [{ value: 100 }, { value: 200 }];
      const handle = registry.store(data);

      const desc = ops.describe(handle);
      expect(desc.sample).toBeDefined();
      expect(desc.sample[0].value).toBe(100);
    });
  });
});
