import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionDB } from "../../src/persistence/session-db.js";

describe("SessionDB", () => {
  let db: SessionDB;

  beforeEach(() => {
    db = new SessionDB();
  });

  afterEach(() => {
    db.close();
  });

  describe("initialization", () => {
    it("should create an in-memory database", () => {
      expect(db.isOpen()).toBe(true);
    });

    it("should create required tables on init", () => {
      const tables = db.getTables();
      expect(tables).toContain("document_lines");
      expect(tables).toContain("handles");
      expect(tables).toContain("handle_data");
      expect(tables).toContain("checkpoints");
    });

    it("should create FTS5 virtual table for document lines", () => {
      const ftsTable = db.hasFTS5();
      expect(ftsTable).toBe(true);
    });
  });

  describe("document operations", () => {
    const sampleDoc = `Line 1: Hello world
Line 2: Error occurred
Line 3: Success message
Line 4: Another error here
Line 5: Final line`;

    it("should load document lines into database", () => {
      const count = db.loadDocument(sampleDoc);
      expect(count).toBe(5);
    });

    it("should store line numbers correctly", () => {
      db.loadDocument(sampleDoc);
      const lines = db.getLines(1, 3);
      expect(lines).toHaveLength(3);
      expect(lines[0].lineNum).toBe(1);
      expect(lines[0].content).toBe("Line 1: Hello world");
      expect(lines[2].lineNum).toBe(3);
    });

    it("should clear previous document on new load", () => {
      db.loadDocument("First doc");
      db.loadDocument(sampleDoc);
      const count = db.getLineCount();
      expect(count).toBe(5);
    });

    it("should search document lines with FTS5", () => {
      db.loadDocument(sampleDoc);
      const results = db.search("error");
      expect(results).toHaveLength(2);
      expect(results[0].content).toContain("Error");
    });

    it("should support FTS5 phrase queries", () => {
      db.loadDocument(sampleDoc);
      const results = db.search('"Hello world"');
      expect(results).toHaveLength(1);
    });
  });

  describe("handle storage", () => {
    it("should create a handle for data array", () => {
      const data = [
        { line: "Error 1", lineNum: 1 },
        { line: "Error 2", lineNum: 5 },
      ];
      const handle = db.createHandle(data);
      expect(handle).toMatch(/^\$res\d+$/);
    });

    it("should store handle metadata", () => {
      const data = [{ line: "Test", lineNum: 1 }];
      const handle = db.createHandle(data);
      const meta = db.getHandleMetadata(handle);

      expect(meta).not.toBeNull();
      expect(meta!.count).toBe(1);
      expect(meta!.type).toBe("array");
    });

    it("should retrieve data by handle", () => {
      const data = [
        { line: "Error 1", lineNum: 1 },
        { line: "Error 2", lineNum: 5 },
      ];
      const handle = db.createHandle(data);
      const retrieved = db.getHandleData(handle);

      expect(retrieved).toHaveLength(2);
      expect(retrieved[0].line).toBe("Error 1");
    });

    it("should increment handle counter", () => {
      const h1 = db.createHandle([{ a: 1 }]);
      const h2 = db.createHandle([{ b: 2 }]);
      const h3 = db.createHandle([{ c: 3 }]);

      expect(h1).toBe("$res1");
      expect(h2).toBe("$res2");
      expect(h3).toBe("$res3");
    });

    it("should delete handle and its data", () => {
      const data = [{ line: "Test", lineNum: 1 }];
      const handle = db.createHandle(data);
      db.deleteHandle(handle);

      const meta = db.getHandleMetadata(handle);
      expect(meta).toBeNull();
    });
  });

  describe("checkpoint operations", () => {
    it("should save checkpoint with bindings", () => {
      const bindings = new Map<string, string>([
        ["RESULTS", "$res1"],
        ["_1", "$res1"],
      ]);
      db.saveCheckpoint(1, bindings);

      const restored = db.getCheckpoint(1);
      expect(restored).not.toBeNull();
      expect(restored!.get("RESULTS")).toBe("$res1");
    });

    it("should overwrite checkpoint for same turn", () => {
      const bindings1 = new Map<string, string>([["RESULTS", "$res1"]]);
      const bindings2 = new Map<string, string>([["RESULTS", "$res2"]]);

      db.saveCheckpoint(1, bindings1);
      db.saveCheckpoint(1, bindings2);

      const restored = db.getCheckpoint(1);
      expect(restored!.get("RESULTS")).toBe("$res2");
    });

    it("should list available checkpoints", () => {
      db.saveCheckpoint(1, new Map([["a", "b"]]));
      db.saveCheckpoint(3, new Map([["c", "d"]]));
      db.saveCheckpoint(5, new Map([["e", "f"]]));

      const turns = db.getCheckpointTurns();
      expect(turns).toEqual([1, 3, 5]);
    });
  });

  describe("cleanup", () => {
    it("should close database connection", () => {
      db.close();
      expect(db.isOpen()).toBe(false);
    });

    it("should clear all data", () => {
      db.loadDocument("Test line");
      db.createHandle([{ data: 1 }]);
      db.saveCheckpoint(1, new Map([["a", "b"]]));

      db.clearAll();

      expect(db.getLineCount()).toBe(0);
      expect(db.getCheckpointTurns()).toHaveLength(0);
    });
  });
});
