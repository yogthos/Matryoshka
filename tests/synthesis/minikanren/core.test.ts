/**
 * Tests for miniKanren core implementation
 * Following TDD - these tests are written first
 */

import { describe, it, expect } from "vitest";
import {
  LVar,
  walk,
  unify,
  eq,
  conj,
  disj,
  fresh,
  run,
  reify,
} from "../../../src/synthesis/minikanren/core.js";

describe("miniKanren Core", () => {
  describe("LVar", () => {
    it("should create a logic variable with a name", () => {
      const x = new LVar("x");
      expect(x.name).toBe("x");
    });

    it("should have a string representation", () => {
      const x = new LVar("x");
      expect(x.toString()).toBe("_.x");
    });

    it("should be distinguishable from other LVars", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      expect(x).not.toBe(y);
    });
  });

  describe("walk", () => {
    it("should return non-LVar values unchanged", () => {
      const s = new Map();
      expect(walk(5, s)).toBe(5);
      expect(walk("hello", s)).toBe("hello");
      expect(walk(null, s)).toBe(null);
    });

    it("should return unbound LVar unchanged", () => {
      const x = new LVar("x");
      const s = new Map();
      expect(walk(x, s)).toBe(x);
    });

    it("should resolve bound LVar to its value", () => {
      const x = new LVar("x");
      const s = new Map([[x, 5]]);
      expect(walk(x, s)).toBe(5);
    });

    it("should follow chains of bindings", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      const s = new Map<LVar, unknown>([
        [x, y],
        [y, 42],
      ]);
      expect(walk(x, s)).toBe(42);
    });

    it("should stop at unbound LVar in chain", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      const s = new Map<LVar, unknown>([[x, y]]);
      expect(walk(x, s)).toBe(y);
    });
  });

  describe("unify", () => {
    it("should unify identical primitive values", () => {
      const s = unify(5, 5, new Map());
      expect(s).not.toBeNull();
    });

    it("should unify identical strings", () => {
      const s = unify("hello", "hello", new Map());
      expect(s).not.toBeNull();
    });

    it("should fail on different primitive values", () => {
      const s = unify(5, 6, new Map());
      expect(s).toBeNull();
    });

    it("should fail on different types", () => {
      const s = unify(5, "5", new Map());
      expect(s).toBeNull();
    });

    it("should unify LVar with value", () => {
      const x = new LVar("x");
      const s = unify(x, 5, new Map());
      expect(s).not.toBeNull();
      expect(s?.get(x)).toBe(5);
    });

    it("should unify value with LVar", () => {
      const x = new LVar("x");
      const s = unify(5, x, new Map());
      expect(s).not.toBeNull();
      expect(s?.get(x)).toBe(5);
    });

    it("should unify two LVars", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      const s = unify(x, y, new Map());
      expect(s).not.toBeNull();
      // One should point to the other
      expect(s?.get(x) === y || s?.get(y) === x).toBe(true);
    });

    it("should unify arrays element-wise", () => {
      const s = unify([1, 2, 3], [1, 2, 3], new Map());
      expect(s).not.toBeNull();
    });

    it("should fail on different-length arrays", () => {
      const s = unify([1, 2], [1, 2, 3], new Map());
      expect(s).toBeNull();
    });

    it("should unify arrays with LVars", () => {
      const x = new LVar("x");
      const s = unify([1, x, 3], [1, 2, 3], new Map());
      expect(s).not.toBeNull();
      expect(walk(x, s!)).toBe(2);
    });

    it("should unify nested arrays", () => {
      const x = new LVar("x");
      const s = unify([1, [2, x]], [1, [2, 3]], new Map());
      expect(s).not.toBeNull();
      expect(walk(x, s!)).toBe(3);
    });

    it("should unify objects", () => {
      const s = unify({ a: 1, b: 2 }, { a: 1, b: 2 }, new Map());
      expect(s).not.toBeNull();
    });

    it("should fail on objects with different keys", () => {
      const s = unify({ a: 1 }, { b: 1 }, new Map());
      expect(s).toBeNull();
    });

    it("should unify objects with LVars", () => {
      const x = new LVar("x");
      const s = unify({ a: x, b: 2 }, { a: 1, b: 2 }, new Map());
      expect(s).not.toBeNull();
      expect(walk(x, s!)).toBe(1);
    });

    it("should preserve existing substitution", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      const initial = new Map<LVar, unknown>([[x, 10]]);
      const s = unify(y, 20, initial);
      expect(s).not.toBeNull();
      expect(s?.get(x)).toBe(10);
      expect(s?.get(y)).toBe(20);
    });

    it("should fail when LVar already bound to different value", () => {
      const x = new LVar("x");
      const initial = new Map<LVar, unknown>([[x, 10]]);
      const s = unify(x, 20, initial);
      expect(s).toBeNull();
    });
  });

  describe("eq goal", () => {
    it("should succeed when values unify", () => {
      const results = run(eq(5, 5));
      expect(results.length).toBe(1);
    });

    it("should fail when values do not unify", () => {
      const results = run(eq(5, 6));
      expect(results.length).toBe(0);
    });

    it("should bind logic variable to value", () => {
      const x = new LVar("x");
      const results = run(eq(x, 42));
      expect(results.length).toBe(1);
      expect(walk(x, results[0])).toBe(42);
    });

    it("should bind value to logic variable", () => {
      const x = new LVar("x");
      const results = run(eq(42, x));
      expect(results.length).toBe(1);
      expect(walk(x, results[0])).toBe(42);
    });
  });

  describe("conj (conjunction)", () => {
    it("should succeed when all goals succeed", () => {
      const results = run(conj(eq(1, 1), eq(2, 2)));
      expect(results.length).toBe(1);
    });

    it("should fail if any goal fails", () => {
      const results = run(conj(eq(1, 1), eq(1, 2)));
      expect(results.length).toBe(0);
    });

    it("should bind multiple variables", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      const results = run(conj(eq(x, 1), eq(y, 2)));
      expect(results.length).toBe(1);
      expect(walk(x, results[0])).toBe(1);
      expect(walk(y, results[0])).toBe(2);
    });

    it("should fail when same variable bound to different values", () => {
      const x = new LVar("x");
      const results = run(conj(eq(x, 1), eq(x, 2)));
      expect(results.length).toBe(0);
    });

    it("should handle empty conjunction", () => {
      const results = run(conj());
      expect(results.length).toBe(1);
    });

    it("should handle single goal", () => {
      const results = run(conj(eq(1, 1)));
      expect(results.length).toBe(1);
    });

    it("should chain substitutions correctly", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      const results = run(conj(eq(x, y), eq(y, 5)));
      expect(results.length).toBe(1);
      expect(walk(x, results[0])).toBe(5);
      expect(walk(y, results[0])).toBe(5);
    });
  });

  describe("disj (disjunction)", () => {
    it("should return results from all succeeding goals", () => {
      const x = new LVar("x");
      const results = run(disj(eq(x, 1), eq(x, 2), eq(x, 3)));
      expect(results.length).toBe(3);
    });

    it("should skip failing goals", () => {
      const x = new LVar("x");
      const results = run(disj(eq(x, 1), eq(5, 6), eq(x, 3)));
      expect(results.length).toBe(2);
    });

    it("should return empty for all failing goals", () => {
      const results = run(disj(eq(1, 2), eq(3, 4)));
      expect(results.length).toBe(0);
    });

    it("should handle empty disjunction", () => {
      const results = run(disj());
      expect(results.length).toBe(0);
    });

    it("should produce correct values", () => {
      const x = new LVar("x");
      const results = run(disj(eq(x, "a"), eq(x, "b")));
      const values = results.map((s) => walk(x, s));
      expect(values).toContain("a");
      expect(values).toContain("b");
    });
  });

  describe("fresh", () => {
    it("should create fresh logic variables", () => {
      const results = run(fresh((x) => eq(x, 5)));
      expect(results.length).toBe(1);
    });

    it("should create multiple fresh variables", () => {
      const results = run(
        fresh((x, y) => conj(eq(x, 1), eq(y, 2)), 2)
      );
      expect(results.length).toBe(1);
    });

    it("should keep fresh variables independent", () => {
      const results = run(
        fresh((x, y) => disj(eq(x, 1), eq(y, 2)), 2)
      );
      expect(results.length).toBe(2);
    });

    it("should allow relating fresh variables", () => {
      const results = run(
        fresh((x, y) => conj(eq(x, y), eq(y, 10)), 2)
      );
      expect(results.length).toBe(1);
    });
  });

  describe("run", () => {
    it("should limit results to maxResults", () => {
      const x = new LVar("x");
      const results = run(
        disj(eq(x, 1), eq(x, 2), eq(x, 3), eq(x, 4), eq(x, 5)),
        3
      );
      expect(results.length).toBe(3);
    });

    it("should return all results when fewer than maxResults", () => {
      const x = new LVar("x");
      const results = run(disj(eq(x, 1), eq(x, 2)), 10);
      expect(results.length).toBe(2);
    });

    it("should use default maxResults of 10", () => {
      const x = new LVar("x");
      const manyGoals = Array.from({ length: 20 }, (_, i) => eq(x, i));
      const results = run(disj(...manyGoals));
      expect(results.length).toBe(10);
    });
  });

  describe("reify", () => {
    it("should extract value of LVar from substitution", () => {
      const x = new LVar("x");
      const results = run(eq(x, 42));
      expect(reify(x, results[0])).toBe(42);
    });

    it("should reify nested structures", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      const results = run(conj(eq(x, [1, y]), eq(y, 2)));
      expect(reify(x, results[0])).toEqual([1, 2]);
    });

    it("should return LVar name for unbound variables", () => {
      const x = new LVar("x");
      const results = run(eq(1, 1)); // x not bound
      const reified = reify(x, results[0]);
      expect(reified).toBe("_.x");
    });

    it("should reify object structures", () => {
      const x = new LVar("x");
      const results = run(eq(x, { a: 1, b: 2 }));
      expect(reify(x, results[0])).toEqual({ a: 1, b: 2 });
    });
  });

  describe("complex queries", () => {
    it("should solve append-like relation", () => {
      // appendo: append two lists
      const x = new LVar("x");
      const results = run(
        disj(
          // Base case: appending empty list
          eq(x, [1, 2, 3]),
          // Another option
          eq(x, [4, 5, 6])
        )
      );
      expect(results.length).toBe(2);
    });

    it("should handle deeply nested goals", () => {
      const x = new LVar("x");
      const y = new LVar("y");
      const z = new LVar("z");

      const results = run(
        conj(
          eq(x, [1, y]),
          conj(eq(y, [2, z]), eq(z, 3))
        )
      );

      expect(results.length).toBe(1);
      expect(reify(x, results[0])).toEqual([1, [2, 3]]);
    });

    it("should handle disjunction within conjunction", () => {
      const x = new LVar("x");
      const y = new LVar("y");

      const results = run(
        conj(
          eq(x, 1),
          disj(eq(y, "a"), eq(y, "b"))
        )
      );

      expect(results.length).toBe(2);
      results.forEach((s) => {
        expect(walk(x, s)).toBe(1);
      });
    });
  });
});
