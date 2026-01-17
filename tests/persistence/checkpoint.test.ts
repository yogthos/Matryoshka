import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CheckpointManager } from "../../src/persistence/checkpoint.js";
import { HandleRegistry } from "../../src/persistence/handle-registry.js";
import { SessionDB } from "../../src/persistence/session-db.js";

describe("CheckpointManager", () => {
  let db: SessionDB;
  let registry: HandleRegistry;
  let checkpoints: CheckpointManager;

  beforeEach(() => {
    db = new SessionDB();
    registry = new HandleRegistry(db);
    checkpoints = new CheckpointManager(db, registry);
  });

  afterEach(() => {
    db.close();
  });

  describe("save checkpoint", () => {
    it("should save checkpoint with handle references", () => {
      // Create some handles
      const h1 = registry.store([{ line: "Error 1", lineNum: 1 }]);
      const h2 = registry.store([{ line: "Error 2", lineNum: 2 }]);
      registry.setResults(h2);

      // Save checkpoint
      checkpoints.save(1);

      // Verify checkpoint exists
      const turns = checkpoints.listTurns();
      expect(turns).toContain(1);
    });

    it("should save current binding state", () => {
      const h1 = registry.store([{ line: "Test", lineNum: 1 }]);
      registry.setResults(h1);

      checkpoints.save(1);

      // Clear registry
      registry.delete(h1);

      // Restore should bring back the state
      const restored = checkpoints.restore(1);
      expect(restored).toBe(true);
      expect(registry.getResults()).not.toBeNull();
    });

    it("should overwrite checkpoint for same turn", () => {
      registry.store([{ a: 1 }]);
      checkpoints.save(1);

      const h2 = registry.store([{ b: 2 }]);
      registry.setResults(h2);
      checkpoints.save(1);

      // There should still be only one checkpoint for turn 1
      const turns = checkpoints.listTurns();
      expect(turns.filter(t => t === 1)).toHaveLength(1);
    });
  });

  describe("restore checkpoint", () => {
    it("should restore bindings from checkpoint", () => {
      // Setup initial state
      const data = [
        { line: "Error 1", lineNum: 1 },
        { line: "Error 2", lineNum: 2 },
      ];
      const handle = registry.store(data);
      registry.setResults(handle);

      checkpoints.save(1);

      // Modify state
      const newData = [{ line: "New data", lineNum: 100 }];
      const newHandle = registry.store(newData);
      registry.setResults(newHandle);

      // Restore
      checkpoints.restore(1);

      // Should have original RESULTS
      const results = registry.resolveResults();
      expect(results).toHaveLength(2);
      expect(results![0].lineNum).toBe(1);
    });

    it("should return false for non-existent checkpoint", () => {
      const result = checkpoints.restore(999);
      expect(result).toBe(false);
    });

    it("should restore multiple bindings", () => {
      const h1 = registry.store([{ a: 1 }]);
      const h2 = registry.store([{ b: 2 }]);
      registry.setResults(h2);

      checkpoints.save(3);
      checkpoints.restore(3);

      // Both handles should be accessible
      expect(registry.get(h1)).not.toBeNull();
      expect(registry.get(h2)).not.toBeNull();
    });
  });

  describe("checkpoint listing", () => {
    it("should list all checkpoint turns", () => {
      registry.store([{ a: 1 }]);
      checkpoints.save(1);
      registry.store([{ b: 2 }]);
      checkpoints.save(3);
      registry.store([{ c: 3 }]);
      checkpoints.save(5);

      const turns = checkpoints.listTurns();
      expect(turns).toEqual([1, 3, 5]);
    });

    it("should return empty list when no checkpoints", () => {
      const turns = checkpoints.listTurns();
      expect(turns).toHaveLength(0);
    });
  });

  describe("checkpoint deletion", () => {
    it("should delete specific checkpoint", () => {
      registry.store([{ a: 1 }]);
      checkpoints.save(1);
      checkpoints.save(2);
      checkpoints.save(3);

      checkpoints.delete(2);

      const turns = checkpoints.listTurns();
      expect(turns).toEqual([1, 3]);
    });

    it("should clear all checkpoints", () => {
      checkpoints.save(1);
      checkpoints.save(2);
      checkpoints.save(3);

      checkpoints.clearAll();

      const turns = checkpoints.listTurns();
      expect(turns).toHaveLength(0);
    });
  });

  describe("session persistence", () => {
    it("should generate session ID", () => {
      const sessionId = checkpoints.getSessionId();
      expect(sessionId).toMatch(/^session-\d+$/);
    });

    it("should maintain session ID across checkpoints", () => {
      const id1 = checkpoints.getSessionId();
      checkpoints.save(1);
      checkpoints.save(2);
      const id2 = checkpoints.getSessionId();

      expect(id1).toBe(id2);
    });

    it("should allow custom session ID", () => {
      const custom = "my-custom-session";
      checkpoints.setSessionId(custom);

      expect(checkpoints.getSessionId()).toBe(custom);
    });
  });

  describe("checkpoint metadata", () => {
    it("should include timestamp in checkpoint", () => {
      checkpoints.save(1);

      const meta = checkpoints.getMetadata(1);
      expect(meta).not.toBeNull();
      expect(meta!.timestamp).toBeDefined();
      expect(meta!.timestamp).toBeGreaterThan(0);
    });

    it("should include handle count in metadata", () => {
      registry.store([{ a: 1 }]);
      registry.store([{ b: 2 }]);
      registry.store([{ c: 3 }]);

      checkpoints.save(1);

      const meta = checkpoints.getMetadata(1);
      expect(meta!.handleCount).toBe(3);
    });
  });

  describe("auto-checkpoint", () => {
    it("should auto-save on each operation when enabled", () => {
      checkpoints.enableAutoCheckpoint(true);

      // Simulate operations
      registry.store([{ a: 1 }]);
      checkpoints.onOperation(1);

      registry.store([{ b: 2 }]);
      checkpoints.onOperation(2);

      const turns = checkpoints.listTurns();
      expect(turns).toContain(1);
      expect(turns).toContain(2);
    });

    it("should not auto-save when disabled", () => {
      checkpoints.enableAutoCheckpoint(false);

      registry.store([{ a: 1 }]);
      checkpoints.onOperation(1);

      const turns = checkpoints.listTurns();
      expect(turns).toHaveLength(0);
    });
  });
});
