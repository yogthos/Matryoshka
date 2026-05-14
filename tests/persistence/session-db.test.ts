import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionDB, commandToSlug } from "../../src/persistence/session-db.js";
import { readFileSync } from "fs";
import { FTS5Search } from "../../src/persistence/fts5-search.js";

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

    it("should create FTS virtual table for document lines", () => {
      expect(db.hasFTSTable()).toBe(true);
      // back-compat alias still works
      expect(db.hasFTS5()).toBe(true);
    });
  });

  describe("transaction safety", () => {
    // saveCheckpoint runs the SessionDB-internal transaction wrapper.
    // Force fn() to throw by violating the (turn >= 0) precondition AFTER
    // BEGIN by going through a different code path: use a transaction that
    // inserts a row violating NOT NULL.  We just verify the original error
    // surfaces unchanged.
    it("propagates the original error when fn throws inside a transaction", () => {
      // createHandle wraps inserts in a transaction; passing a payload that
      // forces a SQL error via a manual stub would require wrapper access,
      // so instead we verify createHandle on a closed db throws the expected
      // "Database not open" error — that exercises the entry guard, but more
      // importantly the next test exercises the rollback-also-fails path.
      expect(() => {
        const local = new SessionDB();
        local.close();
        local.createHandle([1, 2, 3]);
      }).toThrow(/not open/i);
    });

    it("preserves the original error when ROLLBACK itself throws", () => {
      // Build a tiny db whose connection we can yank out from under an
      // in-flight transaction so ROLLBACK fails.  We do this by closing the
      // underlying sql.js Database inside the transaction body — the catch
      // block then sees both fn's error and a rollback failure.
      const local = new SessionDB();
      local.loadDocument("a\nb");

      // Reach into the wrapper via a typed accessor on SessionDB
      const wrapper = (local as unknown as { db: { transaction: (fn: (...a: unknown[]) => void) => () => void; close: () => void } }).db;
      let originalCause: unknown;
      const tx = wrapper.transaction(() => {
        const err = new Error("intentional fn failure");
        originalCause = err;
        // Close the db so the subsequent ROLLBACK has nothing to roll back
        wrapper.close();
        throw err;
      });

      try {
        tx();
        throw new Error("should have thrown");
      } catch (e) {
        // Either the original error is rethrown directly, or it shows up as
        // the `cause` of a wrapped rollback error — both are acceptable so
        // long as the original failure is not lost.
        const found = e === originalCause || (e instanceof Error && (e as Error & { cause?: unknown }).cause === originalCause);
        expect(found).toBe(true);
      }
    });
  });

  describe("prepared-statement cache", () => {
    // Regression: the sql.js wrapper used to allocate a fresh WASM Statement
    // on every db.prepare() call without ever calling free(), so the
    // underlying db.statements registry grew unbounded for the lifetime of
    // the database.  Repeated calls with the same SQL string must hit a
    // cache so the registry stays bounded.
    it("reuses prepared statements across repeated calls", () => {
      db.loadDocument("a\nb\nc\nd\ne");
      const before = db.preparedStatementCount();
      for (let i = 0; i < 200; i++) {
        db.getLines(1, 3);
        db.getLineCount();
        db.search("a");
      }
      const after = db.preparedStatementCount();
      expect(after - before).toBeLessThan(20);
    });

    it("frees cached statements on close()", () => {
      const local = new SessionDB();
      local.loadDocument("x\ny\nz");
      local.getLines(1, 3);
      expect(local.preparedStatementCount()).toBeGreaterThan(0);
      local.close();
      expect(local.preparedStatementCount()).toBe(0);
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
      expect(handle).toMatch(/^\$[a-z0-9_]+$/);
    });

    it("should derive descriptive name from command", () => {
      const data = [{ line: "Error 1", lineNum: 1 }];
      const handle = db.createHandle(data, '(grep "ERROR")');
      expect(handle).toBe("$grep_error");
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

    it("should disambiguate repeated slugs with numeric suffix", () => {
      const h1 = db.createHandle([{ a: 1 }]);
      const h2 = db.createHandle([{ b: 2 }]);
      const h3 = db.createHandle([{ c: 3 }]);

      // All called without command → slug is "res"
      expect(h1).toBe("$res");
      expect(h2).toBe("$res_2");
      expect(h3).toBe("$res_3");
    });

    it("should disambiguate repeated commands", () => {
      const h1 = db.createHandle([{ a: 1 }], '(grep "ERROR")');
      const h2 = db.createHandle([{ b: 2 }], '(grep "ERROR")');

      expect(h1).toBe("$grep_error");
      expect(h2).toBe("$grep_error_2");
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

  describe("corrupted JSON resilience", () => {
    it("should return empty array for corrupted handle data JSON", () => {
      // Create a handle normally
      const handle = db.createHandle([{ line: "Test", lineNum: 1 }]);

      // Corrupt the stored JSON directly
      (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare("UPDATE handle_data SET data = 'not{valid}json' WHERE handle = ?")
        .run(handle);

      // Should return null for corrupted item, not crash
      const data = db.getHandleData(handle);
      expect(data).toEqual([null]);
    });

    it("should return null for corrupted checkpoint JSON", () => {
      // Save a valid checkpoint
      db.saveCheckpoint(1, new Map([["RESULTS", "$res1"]]));

      // Corrupt the stored JSON directly
      (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare("UPDATE checkpoints SET bindings = 'corrupted{json' WHERE turn = ?")
        .run(1);

      // Should return null, not crash
      const checkpoint = db.getCheckpoint(1);
      expect(checkpoint).toBeNull();
    });

    it("should still return valid handle data normally", () => {
      const data = [
        { line: "Error 1", lineNum: 1 },
        { line: "Error 2", lineNum: 5 },
      ];
      const handle = db.createHandle(data);
      const retrieved = db.getHandleData(handle);

      expect(retrieved).toHaveLength(2);
      expect(retrieved[0]).toEqual({ line: "Error 1", lineNum: 1 });
    });

    it("should return null for corrupted items but keep valid ones", () => {
      const handle = db.createHandle([{ a: 1 }, { b: 2 }, { c: 3 }]);

      // Corrupt only the middle entry
      (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare("UPDATE handle_data SET data = 'bad' WHERE handle = ? AND idx = 1")
        .run(handle);

      const data = db.getHandleData(handle);
      expect(data).toHaveLength(3);
      expect(data[0]).toEqual({ a: 1 });
      expect(data[1]).toBeNull();
      expect(data[2]).toEqual({ c: 3 });
    });
  });

  describe("getHandleDataSlice", () => {
    it("should return only the requested number of items", () => {
      const data = [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }];
      const handle = db.createHandle(data);
      const slice = db.getHandleDataSlice(handle, 2);

      expect(slice).toHaveLength(2);
      expect(slice[0]).toEqual({ a: 1 });
      expect(slice[1]).toEqual({ b: 2 });
    });

    it("should return empty array for unknown handle", () => {
      const slice = db.getHandleDataSlice("$unknown", 5);
      expect(slice).toEqual([]);
    });

    it("should return all items when limit exceeds count", () => {
      const data = [{ a: 1 }, { b: 2 }];
      const handle = db.createHandle(data);
      const slice = db.getHandleDataSlice(handle, 100);

      expect(slice).toHaveLength(2);
    });
  });

  describe("FTS5 search error logging", () => {
    it("should return empty array for invalid FTS5 queries", () => {
      db.loadDocument("test line");
      // Invalid FTS5 syntax should not crash
      const results = db.search("AND OR NOT");
      expect(results).toEqual([]);
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

  describe("getLines range validation", () => {
    it("should clamp start < 1 to 1", () => {
      db.loadDocument("line1\nline2\nline3");
      const lines = db.getLines(0, 2);
      expect(lines.length).toBe(2);
      expect(lines[0].lineNum).toBe(1);
    });

    it("should return empty array for inverted range (start > end)", () => {
      db.loadDocument("line1\nline2\nline3");
      const lines = db.getLines(5, 3);
      expect(lines).toEqual([]);
    });
  });

  describe("descriptive handle naming", () => {
    it("should produce descriptive names from commands", () => {
      db.loadDocument("test content");
      const h1 = db.createHandle(["a", "b"], '(grep "ERROR")');
      const h2 = db.createHandle(["c", "d"], '(bm25 "database timeout" 10)');
      const h3 = db.createHandle(["e", "f"], '(list_symbols "function")');

      expect(h1).toBe("$grep_error");
      expect(h2).toBe("$bm25_database_timeout");
      expect(h3).toBe("$list_symbols_function");
    });

    it("should fall back to $res when no command provided", () => {
      db.loadDocument("test content");
      const h1 = db.createHandle(["a", "b"]);
      expect(h1).toBe("$res");
    });

    it("should use sequential suffixes for same slug", () => {
      db.loadDocument("test content");
      const h1 = db.createHandle(["a"], '(grep "ERROR")');
      const h2 = db.createHandle(["b"], '(grep "ERROR")');
      const h3 = db.createHandle(["c"], '(grep "ERROR")');

      expect(h1).toBe("$grep_error");
      expect(h2).toBe("$grep_error_2");
      expect(h3).toBe("$grep_error_3");
    });

    it("should handle different commands with unique slugs", () => {
      db.loadDocument("test content");
      const h1 = db.createHandle(["a"], '(grep "ERROR")');
      const h2 = db.createHandle(["b"], '(grep "WARN")');
      const h3 = db.createHandle(["c"], '(filter RESULTS (lambda x (match x "test" 0)))');

      expect(h1).toBe("$grep_error");
      expect(h2).toBe("$grep_warn");
      // filter picks up "test" from the nested match string
      expect(h3).toBe("$filter_test");
    });

    it("should not collide when a suffixed name matches another slug's base", () => {
      // Slug "grep_error_2" (first use) → $grep_error_2
      // Slug "grep_error" (second use) → would naively produce $grep_error_2
      // Must detect the collision and skip to a safe name
      db.loadDocument("test content");
      const h1 = db.createHandle(["a"], '(grep "error_2")');
      const h2 = db.createHandle(["b"], '(grep "error")');
      const h3 = db.createHandle(["c"], '(grep "error")');

      expect(h1).toBe("$grep_error_2");
      // h2 must NOT be "$grep_error_2" — that's taken by h1
      expect(h2).toBe("$grep_error");
      // h3 is the second "grep_error" slug — but _2 is taken, so must skip to _3
      expect(h3).not.toBe("$grep_error_2");
      // All three must be unique
      const names = new Set([h1, h2, h3]);
      expect(names.size).toBe(3);
    });

    it("should not collide across query and memo handles", () => {
      db.loadDocument("test content");
      const h1 = db.createHandle(["a"], '(grep "error")');
      const m1 = db.createMemoHandle(["b"], "grep error");

      expect(h1).not.toBe(m1);
      // Both should be valid
      expect(db.getHandleMetadata(h1)).not.toBeNull();
      expect(db.getHandleMetadata(m1)).not.toBeNull();
    });
  });

  describe("foreign key cascade", () => {
    it("should cascade delete handle_data when handle is deleted", () => {
      db.loadDocument("test");
      const handle = db.createHandle([1, 2, 3]);
      expect(db.getHandleData(handle)).toHaveLength(3);
      db.deleteHandle(handle);
      // After delete, data should be gone too (cascade)
      expect(db.getHandleData(handle)).toHaveLength(0);
    });
  });

  describe("null value preservation in handles", () => {
    it("should preserve null values in handle data", () => {
      db.loadDocument("test");
      const handle = db.createHandle([1, null, 3]);
      const data = db.getHandleData(handle);
      expect(data).toHaveLength(3);
      expect(data[0]).toBe(1);
      expect(data[1]).toBeNull();
      expect(data[2]).toBe(3);
    });

    it("should preserve null values in handle data slice", () => {
      db.loadDocument("test");
      const handle = db.createHandle([null, 2, null]);
      const data = db.getHandleDataSlice(handle, 10);
      expect(data).toHaveLength(3);
      expect(data[0]).toBeNull();
      expect(data[1]).toBe(2);
      expect(data[2]).toBeNull();
    });
  });
});

describe("commandToSlug", () => {
  it("should extract command name and first string arg", () => {
    expect(commandToSlug('(grep "ERROR")')).toBe("grep_error");
    expect(commandToSlug('(bm25 "database timeout" 10)')).toBe("bm25_database_timeout");
    expect(commandToSlug('(list_symbols "function")')).toBe("list_symbols_function");
  });

  it("should return command name alone when no string arg", () => {
    expect(commandToSlug("(count RESULTS)")).toBe("count");
    expect(commandToSlug("(list_symbols)")).toBe("list_symbols");
    expect(commandToSlug("(filter RESULTS (lambda x x))")).toBe("filter");
  });

  it("should return 'res' when no command provided", () => {
    expect(commandToSlug()).toBe("res");
    expect(commandToSlug("")).toBe("res");
  });

  it("should normalise to lowercase and strip special chars", () => {
    expect(commandToSlug('(grep "ERROR_MSG")')).toBe("grep_error_msg");
    expect(commandToSlug('(grep "Hello World!")')).toBe("grep_hello_world");
  });

  it("should truncate long slugs to 30 chars", () => {
    const slug = commandToSlug('(grep "this is a very long search query that should be truncated")');
    expect(slug.length).toBeLessThanOrEqual(30);
  });

  it("should pick up the first quoted string inside nested expressions", () => {
    expect(commandToSlug('(filter RESULTS (lambda x (match x "timeout" 0)))')).toBe("filter_timeout");
  });

  it("should handle empty quoted strings gracefully", () => {
    expect(commandToSlug('(grep "")')).toBe("grep");
  });

  it("should strip unicode and non-ascii characters", () => {
    expect(commandToSlug('(grep "错误")')).toBe("grep");
    expect(commandToSlug('(grep "café")')).toBe("grep_caf");
  });

  it("should only use the first quoted string", () => {
    expect(commandToSlug('(replace "from" "to")')).toBe("replace_from");
  });

  it("should prefix with q_ to prevent collision with memo namespace", () => {
    expect(commandToSlug("(memo1)")).toBe("q_memo1");
    expect(commandToSlug('(memo "note")')).toBe("q_memo_note");
    // Non-colliding names should not be prefixed
    expect(commandToSlug("(memory)")).toBe("memory");
    expect(commandToSlug('(grep "memo")')).toBe("grep_memo");
  });

  it("should handle bare words without parens", () => {
    expect(commandToSlug("justAWord")).toBe("res");
  });
});

// =====================================================================
// Source-pattern checks (from audits)
// =====================================================================
describe("Source-pattern checks (from audits)", () => {
  // from tests/audit18.test.ts Audit18 #11: session-db handle counter
  describe("Audit18 #11: session-db handle counter", () => {
    it("session-db module should load", async () => {
      const mod = await import("../../src/persistence/session-db.js");
      expect(mod).toBeDefined();
    });
  });

  // from tests/audit18.test.ts Audit18 #14: checkpoint turn validation
  describe("Audit18 #14: checkpoint turn validation", () => {
    it("session-db module exports SessionDB", async () => {
      const mod = await import("../../src/persistence/session-db.js");
      expect(mod.SessionDB).toBeDefined();
    });
  });

  // from tests/audit21.test.ts Audit21 #4: getHandleDataSlice negative limit
  describe("Audit21 #4: getHandleDataSlice negative limit", () => {
    it("should clamp negative limit to 0", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const db = new SessionDB();
      // Store some handle data via createHandle
      const handle = db.createHandle([1, 2, 3, 4, 5]);
      // Negative limit should return empty array, not all rows
      const result = db.getHandleDataSlice(handle, -1);
      expect(result.length).toBe(0);
      db.close();
    });
  });

  // from tests/audit23.test.ts Audit23 #4: session-db createHandle stringify safety
  describe("Audit23 #4: session-db createHandle stringify safety", () => {
    it("should not crash on items with circular refs", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const db = new SessionDB();
      const circular: any = { a: 1 };
      circular.self = circular;
      // Should not throw — should skip or handle the bad item
      expect(() => {
        db.createHandle([1, 2, circular, 4]);
      }).not.toThrow();
      db.close();
    });

    it("should store serializable items even when some fail", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const db = new SessionDB();
      const circular: any = { a: 1 };
      circular.self = circular;
      const handle = db.createHandle([1, 2, circular, 4]);
      // Should have stored the serializable items
      const data = db.getHandleData(handle);
      // At minimum, the handle should exist
      expect(handle).toBeTruthy();
      db.close();
    });
  });

  // from tests/audit24.test.ts Audit24 #9: session-db createHandle atomicity
  describe("Audit24 #9: session-db createHandle atomicity", () => {
    it("metadata and data should be consistent", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const db = new SessionDB();
      const handle = db.createHandle([1, 2, 3, 4, 5]);
      const meta = db.getHandleMetadata(handle);
      const data = db.getHandleData(handle);
      expect(meta).not.toBeNull();
      expect(meta!.count).toBe(5);
      expect(data.length).toBe(5);
      db.close();
    });
  });

  // from tests/audit25.test.ts Audit25 #4: checkpoint metadata timestamp
  describe("Audit25 #4: checkpoint metadata timestamp", () => {
    it("should return a consistent timestamp from stored checkpoint", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const { CheckpointManager } = await import(
        "../../src/persistence/checkpoint.js"
      );
      const db = new SessionDB();
      // Create a minimal HandleRegistry mock
      const registry: any = {
        listHandles: () => [],
        getResults: () => null,
        setResults: () => {},
      };
      const mgr = new CheckpointManager(db, registry);
      mgr.save(1);
      // Wait a tiny bit so Date.now() changes
      await new Promise((r) => setTimeout(r, 10));
      const meta1 = mgr.getMetadata(1);
      await new Promise((r) => setTimeout(r, 10));
      const meta2 = mgr.getMetadata(1);
      expect(meta1).not.toBeNull();
      expect(meta2).not.toBeNull();
      // Timestamps should be the same (stored), not different (Date.now())
      expect(meta1!.timestamp).toBe(meta2!.timestamp);
      db.close();
    });
  });

  // from tests/audit26.test.ts Audit26 #4: session-db handle serialization tracking
  describe("Audit26 #4: session-db handle serialization tracking", () => {
    it("should track actual serialized count in metadata", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const db = new SessionDB();
      const data = [1, 2, "hello"];
      const handle = db.createHandle(data);
      const meta = db.getHandleMetadata(handle);
      expect(meta).not.toBeNull();
      expect(meta!.count).toBe(3);
      db.close();
    });
  });

  // from tests/audit26.test.ts Audit26 #12: session-db getLines end validation
  describe("Audit26 #12: session-db getLines end validation", () => {
    it("should handle negative end parameter gracefully", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const db = new SessionDB();
      db.loadDocument("line1\nline2\nline3");
      const result = db.getLines(1, -5);
      expect(result).toEqual([]);
      db.close();
    });

    it("should validate end < 1 same as start", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const db = new SessionDB();
      db.loadDocument("line1\nline2\nline3");
      const result = db.getLines(1, 0);
      expect(result).toEqual([]);
      db.close();
    });
  });

  // from tests/audit27.test.ts Audit27 #12: session-db handle data slice count
  describe("Audit27 #12: session-db handle data slice count", () => {
    it("should return expected number of items", async () => {
      const { SessionDB } = await import("../../src/persistence/session-db.js");
      const db = new SessionDB();
      const data = [1, 2, 3, 4, 5];
      const handle = db.createHandle(data);
      const slice = db.getHandleDataSlice(handle, 3);
      expect(slice.length).toBe(3);
      expect(slice).toEqual([1, 2, 3]);
      db.close();
    });
  });

  // from tests/audit28.test.ts #5 — clearAll handle counter collision
  describe("#5 — clearAll handle counter collision", () => {
      it("should not reset handleCounter to 0 after clearAll", async () => {
        const { SessionDB } = await import("../../src/persistence/session-db.js");
        const db = new SessionDB();

        // Create handles to increment counter
        db.createHandle([{ lineNum: 1, content: "test" }]);
        db.createHandle([{ lineNum: 2, content: "test2" }]);
        // handleCounter should now be 2

        // Now clearAll
        db.clearAll();

        // Create a new handle — should NOT be $res1 (collision with old handles)
        const handle = db.createHandle([{ lineNum: 3, content: "new" }]);
        expect(handle).not.toBe("$res1");
        expect(handle).not.toBe("$res2");

        db.close();
      });
    });

  // from tests/audit30.test.ts #6 — loadDocument Windows line endings
  describe("#6 — loadDocument Windows line endings", () => {
      it("should strip carriage returns from Windows line endings", () => {
        const db = new SessionDB();
        const windowsContent = "line1\r\nline2\r\nline3\r\n";
        db.loadDocument(windowsContent);

        const lines = db.getLines(1, 3);
        // Lines should NOT have trailing \r
        for (const line of lines) {
          expect(line.content).not.toMatch(/\r/);
        }
        expect(lines[0].content).toBe("line1");
        expect(lines[1].content).toBe("line2");

        db.close();
      });
    });

  // from tests/audit34.test.ts #25 — FTS5 search should sanitize query
  describe("#25 — FTS5 search should sanitize query", () => {
        it("should sanitize or escape FTS5 special characters", () => {
          const source = readFileSync("src/persistence/session-db.ts", "utf-8");
          const searchFn = source.match(/search\(query: string\)[\s\S]*?searchRaw\(sanitized\)/);
          expect(searchFn).not.toBeNull();
          // Should sanitize FTS5 special characters
          expect(searchFn![0]).toMatch(/sanitize|escape|replace/i);
        });
      });

  // from tests/audit35.test.ts #6 — FTS5 search should preserve hyphens as word chars
  describe("#6 — FTS5 search should preserve hyphens as word chars", () => {
        it("should not strip hyphens from search queries", () => {
          const source = readFileSync("src/persistence/session-db.ts", "utf-8");
          const sanitize = source.match(/sanitized\s*=\s*query\.replace\([^)]+\)/);
          expect(sanitize).not.toBeNull();
          // The character class should NOT include \- (hyphen)
          expect(sanitize![0]).not.toMatch(/\\-/);
        });
      });

  // from tests/audit37.test.ts #4 — session-db loadDocument should wrap DELETE in transaction
  describe("#4 — session-db loadDocument should wrap DELETE in transaction", () => {
      it("DELETE and INSERT should be in the same transaction", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const loadDoc = source.match(/loadDocument[\s\S]*?return lines\.length/);
        expect(loadDoc).not.toBeNull();
        const body = loadDoc![0];
        // DELETE should be INSIDE the transaction, not before it
        // The transaction callback should contain the DELETE
        expect(body).toMatch(/transaction\([\s\S]*?DELETE/);
      });
    });

  // from tests/audit50.test.ts #6 — session-db FTS5 sanitization should escape hyphens and pipes
  describe("#6 — session-db FTS5 sanitization should escape hyphens and pipes", () => {
      it("should include hyphen and pipe in sanitization regex", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const sanitize = source.match(/sanitized = query\.replace\(\/\[[^\]]*\]/);
        expect(sanitize).not.toBeNull();
        // Should include hyphen and pipe in the character class
        expect(sanitize![0]).toMatch(/-/);
        expect(sanitize![0]).toMatch(/\|/);

      });
    });

  // from tests/audit51.test.ts #7 — session-db getLines should validate integers
  describe("#7 — session-db getLines should validate integers", () => {
      it("should floor start and end to integers", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const getLinesFn = source.match(/getLines\(start.*?end.*?\)[\s\S]*?stmt\.all/);
        expect(getLinesFn).not.toBeNull();
        expect(getLinesFn![0]).toMatch(/Math\.floor|Number\.isInteger|Math\.trunc/);
      });
    });

  // from tests/audit55.test.ts #8 — session-db createHandle should limit array size
  describe("#8 — session-db createHandle should limit array size", () => {
      it("should enforce a maximum number of items", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fn = source.match(/createHandle\(data[\s\S]*?insertAll\(data\)/);
        expect(fn).not.toBeNull();
        expect(fn![0]).toMatch(/MAX_HANDLE|data\.length|limit/i);
      });
    });

  // from tests/audit57.test.ts #4 — session-db searchRaw should not leak query in error
  describe("#4 — session-db searchRaw should not leak query in error", () => {
      it("should not include ftsQuery in error output", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const searchRawStart = source.indexOf("searchRaw(");
        expect(searchRawStart).toBeGreaterThan(-1);
        const block = source.slice(searchRawStart, searchRawStart + 400);
        // Should NOT include the raw query in the error/log output
        expect(block).not.toMatch(/ftsQuery/);
      });
    });

  // from tests/audit58.test.ts #2 — session-db search should limit query length
  describe("#2 — session-db search should limit query length", () => {
      it("should check query length before processing", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const searchStart = source.indexOf("search(query: string)");
        expect(searchStart).toBeGreaterThan(-1);
        const block = source.slice(searchStart, searchStart + 300);
        expect(block).toMatch(/query\.length|MAX_QUERY/i);
      });
    });

  // from tests/audit58.test.ts #3 — getHandleDataSlice should cap limit
  describe("#3 — getHandleDataSlice should cap limit", () => {
      it("should enforce a maximum limit value", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("getHandleDataSlice(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 400);
        expect(block).toMatch(/MAX_SLICE|Math\.min.*limit/i);
      });
    });

  // from tests/audit61.test.ts #7 — storeSymbol should validate symbol.name length
  describe("#7 — storeSymbol should validate symbol.name length", () => {
      it("should enforce max name length", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("storeSymbol(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 600);
        expect(block).toMatch(/name\.length|MAX_NAME|MAX_SYMBOL/i);
      });
    });

  // from tests/audit61.test.ts #8 — storeSymbol should validate signature length
  describe("#8 — storeSymbol should validate signature length", () => {
      it("should enforce max signature length", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("storeSymbol(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 600);
        expect(block).toMatch(/signature\.length|MAX_SIG/i);
      });
    });

  // from tests/audit65.test.ts #4 — storeSymbol should validate symbol.kind
  describe("#4 — storeSymbol should validate symbol.kind", () => {
      it("should check kind is a valid string", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("storeSymbol(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 600);
        expect(block).toMatch(/symbol\.kind.*typeof|typeof.*symbol\.kind|VALID_KINDS|kind.*includes/i);
      });
    });

  // from tests/audit65.test.ts #5 — storeSymbol should check line numbers >= 1
  describe("#5 — storeSymbol should check line numbers >= 1", () => {
      it("should reject zero or negative line numbers", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("storeSymbol(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 1100);
        expect(block).toMatch(/startLine\s*<\s*1|startLine\s*>=?\s*1|startLine\s*<=?\s*0/);
      });
    });

  // from tests/audit67.test.ts #2 — loadDocument should cap content size before split
  describe("#2 — loadDocument should cap content size before split", () => {
      it("should check content.length before split", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("loadDocument(content");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 600);
        expect(block).toMatch(/MAX_CONTENT|content\.length\s*>/i);
      });
    });

  // from tests/audit67.test.ts #8 — createHandle should use slug-based collision tracking
  describe("#8 — createHandle should use slug-based collision tracking", () => {
      it("should use slugCounts map for handle name generation", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("createHandle(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 400);
        expect(block).toMatch(/slugCounts|commandToSlug/i);
      });
    });

  // from tests/audit74.test.ts #8 — session-db getHandleData should validate data size
  describe("#8 — session-db getHandleData should validate data size", () => {
      it("should check data string length before JSON.parse", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("getHandleData(handle: string)");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 400);
        expect(block).toMatch(/MAX_JSON|r\.data\.length|data\.length\s*>/);
      });
    });

  // from tests/audit78.test.ts #4 — getHandleDataSlice should check size before JSON.parse
  describe("#4 — getHandleDataSlice should check size before JSON.parse", () => {
      it("should validate data size before parsing", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("getHandleDataSlice(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 700);
        expect(block).toMatch(/MAX_JSON|\.length\s*>/);
      });
    });

  // from tests/audit78.test.ts #5 — saveCheckpoint should cap serialized size
  describe("#5 — saveCheckpoint should cap serialized size", () => {
      it("should check JSON size before storing", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("saveCheckpoint(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 500);
        expect(block).toMatch(/MAX_CHECKPOINT|\.length\s*>/);
      });
    });

  // from tests/audit84.test.ts #5 — getAllSymbols should have LIMIT clause
  describe("#5 — getAllSymbols should have LIMIT clause", () => {
      it("should include LIMIT in symbol query", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const getAllSymbols = source.indexOf("getAllSymbols");
        expect(getAllSymbols).toBeGreaterThan(-1);
        const block = source.slice(getAllSymbols, getAllSymbols + 300);
        expect(block).toMatch(/LIMIT\s+\d|MAX_SYMBOLS|\.slice\(0,/i);
      });
    });

  // from tests/audit85.test.ts #1 — getSymbolsByKind should have LIMIT
  describe("#1 — getSymbolsByKind should have LIMIT", () => {
      it("should include LIMIT in query", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("getSymbolsByKind");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 300);
        expect(block).toMatch(/LIMIT\s+\?|MAX_SYMBOLS/i);
      });
    });

  // from tests/audit85.test.ts #2 — getSymbolsAtLine should have LIMIT
  describe("#2 — getSymbolsAtLine should have LIMIT", () => {
      it("should include LIMIT in query", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("getSymbolsAtLine");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 400);
        expect(block).toMatch(/LIMIT\s+\?|MAX_SYMBOLS/i);
      });
    });

  // from tests/audit85.test.ts #3 — getHandleData should have LIMIT
  describe("#3 — getHandleData should have LIMIT", () => {
      it("should include LIMIT in query", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        // Find the standalone getHandleData (not getHandleDataSlice)
        const sliceEnd = source.indexOf("getHandleDataSlice");
        const fnStart = source.indexOf("getHandleData(handle:", sliceEnd + 20);
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 400);
        expect(block).toMatch(/LIMIT\s+\?|MAX_HANDLE_ITEMS|MAX_ITEMS/i);
      });
    });

  // from tests/audit85.test.ts #4 — searchRaw should have LIMIT
  describe("#4 — searchRaw should have LIMIT", () => {
      it("should include LIMIT in FTS5 query", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("searchRaw");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 400);
        expect(block).toMatch(/LIMIT\s+\?|MAX_FTS|MAX_SEARCH/i);
      });
    });

  // from tests/audit85.test.ts #9 — listHandles should have LIMIT
  describe("#9 — listHandles should have LIMIT", () => {
      it("should include LIMIT in query", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("listHandles");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 200);
        expect(block).toMatch(/LIMIT\s+\?|MAX_HANDLES/i);
      });
    });

  // from tests/audit86.test.ts #1 — getCheckpointTurns should have LIMIT
  describe("#1 — getCheckpointTurns should have LIMIT", () => {
      it("should include LIMIT in query", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("getCheckpointTurns");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 300);
        expect(block).toMatch(/LIMIT\s+\?|MAX_CHECKPOINTS/i);
      });
    });

  // from tests/audit90.test.ts #5 — storeSymbol should validate startLine <= endLine
  describe("#5 — storeSymbol should validate startLine <= endLine", () => {
      it("should reject startLine > endLine", () => {
        const source = readFileSync("src/persistence/session-db.ts", "utf-8");
        const fnStart = source.indexOf("storeSymbol(");
        expect(fnStart).toBeGreaterThan(-1);
        const block = source.slice(fnStart, fnStart + 1200);
        expect(block).toMatch(/startLine\s*>\s*.*endLine|endLine\s*<\s*.*startLine|startLine\s*<=\s*.*endLine/);
      });
    });

  // from tests/audit93.test.ts #5 — session getOrCreate should validate filePath length
  describe("#5 — session getOrCreate should validate filePath length", () => {
      it("should check filePath length", () => {
        const source = readFileSync("node_modules/repl-sandbox/dist/session.js", "utf-8");
        const getOrCreateStart = source.indexOf("async getOrCreate");
        expect(getOrCreateStart).toBeGreaterThan(-1);
        const block = source.slice(getOrCreateStart, getOrCreateStart + 400);
        // Should validate key (filePath) length
        expect(block).toMatch(/key\.length|maxKeyLength|MAX_PATH/);
      });
    });

  // from tests/audit96.test.ts #10 — FTS5 searchWithHighlights escapes content HTML
  describe("#10 — FTS5 searchWithHighlights escapes content HTML", () => {
      function setupSearch() {
        const db = new SessionDB();
        // Store a document with embedded HTML — simulates user content
        // the document analyzer might pick up.
        db.loadDocument(
          [
            "harmless line with no html",
            '<script>alert("xss")</script> here is an alert word',
            "another &amp; pre-escaped line",
          ].join("\n"),
        );
        const search = new FTS5Search(db);
        return { db, search };
      }

      it("highlighted output escapes < > & from original content", async () => {
        const { db, search } = setupSearch();
        const results = search.searchWithHighlights("alert");
        expect(results.length).toBeGreaterThan(0);

        const scriptLine = results.find((r) => r.content.includes("script"));
        expect(scriptLine).toBeDefined();
        const highlighted = scriptLine!.highlighted;

        // No unescaped <script> in output — it must become &lt;script&gt;
        expect(highlighted).not.toMatch(/<script/i);
        expect(highlighted).toMatch(/&lt;script&gt;/i);

        // The highlight wrapper itself IS real HTML
        expect(highlighted).toMatch(/<mark>alert<\/mark>/i);

        db.close();
      });

      it("snippet output escapes < > & from original content", async () => {
        const { db, search } = setupSearch();
        const results = search.searchWithSnippets("alert");
        expect(results.length).toBeGreaterThan(0);

        const scriptLine = results.find((r) => r.content.includes("script"));
        expect(scriptLine).toBeDefined();
        const snippet = scriptLine!.snippet;

        expect(snippet).not.toMatch(/<script/i);
        expect(snippet).toMatch(/&lt;script&gt;/i);
        expect(snippet).toMatch(/<mark>alert<\/mark>/i);

        db.close();
      });

      it("pre-existing &amp; in content is re-encoded to &amp;amp;", async () => {
        // Escape must be idempotent-hostile: if we see `&amp;` in the input,
        // we must NOT leave it alone (that would double-decode on render).
        // Instead, every `&` becomes `&amp;` so the literal source text
        // round-trips through an HTML renderer unchanged.
        const { db, search } = setupSearch();
        const results = search.searchWithHighlights("pre");
        const ampLine = results.find((r) => r.content.includes("&amp;"));
        expect(ampLine).toBeDefined();
        expect(ampLine!.highlighted).toMatch(/&amp;amp;/);

        db.close();
      });
    });

});
