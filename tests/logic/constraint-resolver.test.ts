/**
 * Tests for the Constraint Resolver
 */

import { describe, it, expect } from "vitest";
import { resolveConstraints, hasConstraints, extractConstraints } from "../../src/logic/constraint-resolver.js";
import { parse } from "../../src/logic/lc-parser.js";

describe("Constraint Resolver", () => {
  describe("resolveConstraints", () => {
    it("should pass through unconstrained terms", () => {
      const parsed = parse('(grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const resolved = resolveConstraints(parsed.term);
      expect(resolved.term.tag).toBe("grep");
      expect(resolved.transformations).toHaveLength(0);
    });

    it("should resolve [Σ⚡μ] constraint", () => {
      const parsed = parse('[Σ⚡μ] ⊗ (grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const resolved = resolveConstraints(parsed.term);
      expect(resolved.transformations).toContain("Applied [Σ⚡μ]");
      expect(resolved.simplified).toBe(true);
      // The resolved term should be the inner grep
      expect(resolved.term.tag).toBe("grep");
    });

    it("should resolve [∞/0] constraint", () => {
      const parsed = parse('[∞/0] ⊗ (match (input) "\\\\d+" 0)');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const resolved = resolveConstraints(parsed.term);
      expect(resolved.transformations).toContain("Applied [∞/0]");
      expect(resolved.nullChecksInjected).toBe(true);
    });
  });

  describe("hasConstraints", () => {
    it("should return false for unconstrained terms", () => {
      const parsed = parse('(grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      expect(hasConstraints(parsed.term)).toBe(false);
    });

    it("should return true for constrained terms", () => {
      const parsed = parse('[Σ⚡μ] ⊗ (grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      expect(hasConstraints(parsed.term)).toBe(true);
    });
  });

  describe("extractConstraints", () => {
    it("should extract all constraints from term", () => {
      const parsed = parse('[Σ⚡μ] ⊗ (grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const constraints = extractConstraints(parsed.term);
      expect(constraints).toContain("Σ⚡μ");
    });

    it("should return empty array for unconstrained terms", () => {
      const parsed = parse('(grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const constraints = extractConstraints(parsed.term);
      expect(constraints).toHaveLength(0);
    });
  });
});
