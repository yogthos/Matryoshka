/**
 * Tests for fixes from the 2026-04-17 bug review.
 *
 * Each block targets one severity-ranked finding with the minimum
 * test case needed to drive the fix and prevent regression.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../src/logic/lc-parser.js";
import { validateRegex, solve, type SolverTools } from "../../src/logic/lc-solver.js";
import { evaluate, type SandboxTools } from "../../src/logic/lc-interpreter.js";
import { HandleRegistry } from "../../src/persistence/handle-registry.js";
import { SessionDB } from "../../src/persistence/session-db.js";
import { makePendingId, sweepStalePending } from "../../src/lattice-mcp-server.js";

describe("Bug review fixes", () => {
  describe("Fix #1: lc-parser string tokenizer overflow", () => {
    it("fails with a length-specific error when a string literal exceeds MAX_STRING_LENGTH", () => {
      // Pre-fix: the body loop exits on size cap, then `i++` consumes the
      // next char as if it were the closing `"`. The eventual error (if any)
      // is "Unterminated string literal" — misleading and not actionable.
      // Post-fix: parse must fail with a clearly length-related message.
      const huge = "a".repeat(100_001);
      const src = `(grep "${huge}")`;

      const result = parse(src);

      expect(result.success).toBe(false);
      expect(result.error ?? "").toMatch(/too long|length|max|exceed/i);
    });

    it("does not silently produce a corrupt AST when overflow is followed by more tokens", () => {
      // With `(grep "<huge>" "ok")`, the pre-fix tokenizer can mis-pair
      // quotes and yield a successful but wrong AST. Verify either an
      // explicit failure, OR — if it parses — that the literal value
      // actually equals the original input (i.e., no silent truncation).
      const huge = "a".repeat(100_001);
      const src = `(grep "${huge}" "ok")`;

      const result = parse(src);

      if (result.success) {
        // If a future implementation chooses to accept rather than reject,
        // the parsed string must at least equal the source — not a
        // truncated or quote-shifted variant.
        const term = result.term;
        expect(term?.tag).toBe("grep");
        if (term?.tag === "grep") {
          expect(term.pattern).toBe(huge);
        }
      } else {
        expect(result.error ?? "").toMatch(/too long|length|max|exceed/i);
      }
    });

    it("still parses a normal string just under the cap", () => {
      const ok = "a".repeat(99_999);
      const result = parse(`"${ok}"`);
      expect(result.success).toBe(true);
    });
  });

  describe("Fix #2: split caps allocation before length check", () => {
    const tools: SandboxTools = {
      grep: () => [],
      fuzzy_search: () => [],
      text_stats: () => ({ length: 0, lineCount: 0, sample: { start: "", middle: "", end: "" } }),
      context: "",
    };

    const solverTools: SolverTools = {
      grep: () => [],
      fuzzy_search: () => [],
      bm25: () => [],
      semantic: () => [],
      text_stats: () => ({ length: 0, lineCount: 0, sample: { start: "", middle: "", end: "" } }),
      context: "",
      lines: [],
    };

    // Pre-fix: `str.split(delim)` materializes every part before checking
    // MAX_SPLIT_PARTS. Post-fix: the call must use a bounded limit so the
    // intermediate array size is capped. We verify the bound by spying on
    // String.prototype.split and asserting the limit argument is set.
    it("interpreter split passes a bounded limit to String.prototype.split", () => {
      const big = "x".repeat(50_000); // enough parts that an unbounded call is wasteful
      const term = {
        tag: "split" as const,
        str: { tag: "lit" as const, value: big },
        delim: "x",
        index: 0,
      };
      const env = new Map();
      const log = () => {};

      const original = String.prototype.split;
      const calls: Array<{ limit: number | undefined }> = [];
      String.prototype.split = function (this: string, sep: any, limit?: number) {
        calls.push({ limit });
        return original.call(this, sep, limit);
      } as any;

      try {
        evaluate(term as any, tools, env, log);
      } finally {
        String.prototype.split = original;
      }

      // The split inside the interpreter must have been called with a
      // numeric limit (the MAX_SPLIT_PARTS bound or smaller).
      const splitCalls = calls.filter(c => c.limit !== undefined);
      expect(splitCalls.length).toBeGreaterThan(0);
      for (const c of splitCalls) {
        expect(c.limit).toBeLessThanOrEqual(100_000);
      }
    });

    it("solver split passes a bounded limit to String.prototype.split", async () => {
      const big = "x".repeat(50_000);
      const term = {
        tag: "split" as const,
        str: { tag: "lit" as const, value: big },
        delim: "x",
        index: 0,
      };

      const original = String.prototype.split;
      const calls: Array<{ limit: number | undefined }> = [];
      String.prototype.split = function (this: string, sep: any, limit?: number) {
        calls.push({ limit });
        return original.call(this, sep, limit);
      } as any;

      try {
        await solve(term as any, solverTools);
      } finally {
        String.prototype.split = original;
      }

      const splitCalls = calls.filter(c => c.limit !== undefined);
      expect(splitCalls.length).toBeGreaterThan(0);
      for (const c of splitCalls) {
        expect(c.limit).toBeLessThanOrEqual(100_000);
      }
    });

    it("oversized split still returns null (post-fix semantics preserved)", () => {
      const big = "x".repeat(50_000);
      const term = {
        tag: "split" as const,
        str: { tag: "lit" as const, value: big },
        delim: "x",
        index: 0,
      };
      expect(evaluate(term as any, tools, new Map(), () => {})).toBeNull();
    });

    it("normal-sized split still returns the requested index", () => {
      const term = {
        tag: "split" as const,
        str: { tag: "lit" as const, value: "a,b,c,d" },
        delim: ",",
        index: 2,
      };
      expect(evaluate(term as any, tools, new Map(), () => {})).toBe("c");
    });
  });

  describe("Fix #4: replace validates term.to type", () => {
    const tools: SandboxTools = {
      grep: () => [],
      fuzzy_search: () => [],
      text_stats: () => ({ length: 0, lineCount: 0, sample: { start: "", middle: "", end: "" } }),
      context: "",
    };

    const solverTools: SolverTools = {
      grep: () => [],
      fuzzy_search: () => [],
      bm25: () => [],
      semantic: () => [],
      text_stats: () => ({ length: 0, lineCount: 0, sample: { start: "", middle: "", end: "" } }),
      context: "",
      lines: [],
    };

    // Pre-fix: a malformed term where `to` is not a string would
    // throw an opaque "Cannot read properties of undefined / not a
    // function" TypeError when we call `term.to.replace(...)`.
    // Post-fix: clear, intentional error mentioning the type problem.
    it("interpreter rejects non-string `to` with a clear error", () => {
      const term = {
        tag: "replace" as const,
        str: { tag: "lit" as const, value: "hello" },
        from: "hello",
        to: null as any,
      };
      expect(() => evaluate(term as any, tools, new Map(), () => {}))
        .toThrow(/replace.*string|to.*string/i);
    });

    it("solver rejects non-string `to` with a clear error", async () => {
      const term = {
        tag: "replace" as const,
        str: { tag: "lit" as const, value: "hello" },
        from: "hello",
        to: 42 as any,
      };
      const result = await solve(term as any, solverTools);
      expect(result.success).toBe(false);
      expect(result.error ?? "").toMatch(/replace.*string|to.*string/i);
    });

    it("normal string-to-string replace still works", () => {
      const term = {
        tag: "replace" as const,
        str: { tag: "lit" as const, value: "hello world" },
        from: "world",
        to: "there",
      };
      expect(evaluate(term as any, tools, new Map(), () => {})).toBe("hello there");
    });
  });

  describe("Fix #5: evictOldest surfaces failure instead of silently no-op", () => {
    // Build a minimal SessionDB-shaped stub where handleCount() and
    // listHandles() are inconsistent — count says we're at capacity,
    // but listHandles() returns nothing to evict. Pre-fix: store()
    // loops forever calling evictOldest(), which silently returns.
    // Post-fix: the inconsistency is surfaced as a thrown error so
    // the caller stops spinning.
    function makeStubDB(): SessionDB {
      return {
        handleCount: () => 250, // above MAX_HANDLES (200)
        listHandles: () => [],   // nothing to evict
        deleteHandle: () => {},
        createHandle: () => "$x",
        getHandleMetadata: () => null,
        getHandleData: () => [],
        listHandleMetadata: () => [],
        getHandleDataSlice: () => [],
      } as unknown as SessionDB;
    }

    it("store() does not loop forever when eviction can't free space", () => {
      const reg = new HandleRegistry(makeStubDB());
      const start = Date.now();
      let threw = false;
      try {
        reg.store([1, 2, 3]);
      } catch {
        threw = true;
      }
      const elapsed = Date.now() - start;
      // Must either throw or return promptly — never spin past 1s.
      expect(elapsed).toBeLessThan(1000);
      expect(threw).toBe(true);
    });

    it("evictOldest throws on inconsistent state", () => {
      const reg = new HandleRegistry(makeStubDB());
      expect(() => reg.evictOldest()).toThrow(/evict|inconsistent|empty/i);
    });
  });

  describe("Fix #6: pending-request IDs have high entropy", () => {
    it("never collides across many same-tick generations", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10_000; i++) {
        ids.add(makePendingId("q"));
      }
      expect(ids.size).toBe(10_000);
    });

    it("preserves the prefix for routing", () => {
      expect(makePendingId("q").startsWith("q_")).toBe(true);
      expect(makePendingId("b").startsWith("b_")).toBe(true);
    });
  });

  describe("Fix #7: loadDocument signals truncation", () => {
    // Pre-fix: a document over the size or line cap is silently
    // truncated; the caller has no way to know that downstream
    // queries are operating on incomplete data.
    // Post-fix: getLastLoadStatus() returns truncation metadata.

    it("flags line-count truncation", () => {
      const db = new SessionDB();
      try {
        // 600,000 lines, each "x" — exceeds MAX_LINES (500,000)
        const content = Array.from({ length: 600_000 }, () => "x").join("\n");
        db.loadDocument(content);
        const status = db.getLastLoadStatus();
        expect(status.truncated).toBe(true);
        expect(status.reason ?? "").toMatch(/line/i);
      } finally {
        db.close();
      }
    }, 30_000);

    it("does not flag truncation on a normal load", () => {
      const db = new SessionDB();
      try {
        db.loadDocument("a\nb\nc\n");
        const status = db.getLastLoadStatus();
        expect(status.truncated).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  describe("Fix #3: ReDoS validator catches nested-group quantifiers", () => {
    it("rejects (.*(.*).*)+", () => {
      const result = validateRegex("(.*(.*).*)+");
      expect(result.valid).toBe(false);
    });

    it("rejects ((a|b)+)+", () => {
      const result = validateRegex("((a|b)+)+");
      expect(result.valid).toBe(false);
    });

    it("still accepts harmless patterns", () => {
      expect(validateRegex("foo").valid).toBe(true);
      expect(validateRegex("[A-Z]+").valid).toBe(true);
      expect(validateRegex("\\bword\\b").valid).toBe(true);
    });
  });

  describe("Fix #8: sweepStalePending rejects abandoned LLM suspension queries", () => {
    it("returns 0 when no stale entries exist (clean state)", () => {
      // Fresh import — no pending queries should exist.
      const cleaned = sweepStalePending(1); // 1ms threshold — even fresh entries are stale
      expect(cleaned).toBe(0);
    });

    it("does not throw on edge-case inputs", () => {
      // Negative age, zero, huge values — all should complete without error.
      expect(sweepStalePending(-1)).toBe(0);
      expect(sweepStalePending(0)).toBeGreaterThanOrEqual(0);
      expect(sweepStalePending(Number.MAX_SAFE_INTEGER)).toBe(0);
    });

    it("makePendingId generates unique, collision-resistant IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(makePendingId("q"));
        ids.add(makePendingId("b"));
      }
      expect(ids.size).toBe(200);
    });
  });
});
