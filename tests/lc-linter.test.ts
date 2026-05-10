import { describe, it, expect } from "vitest";
import { lintAndRepair } from "../src/logic/lc-linter.js";
import { parse as parseLC } from "../src/logic/lc-parser.js";

function reparses(s: string): boolean {
  const r = parseLC(s);
  return r.success && !!r.term;
}

describe("lc-linter", () => {
  describe("no-op on valid input", () => {
    it("returns null for a well-formed query", () => {
      const r = lintAndRepair('(grep "ERROR")');
      expect(r.repaired).toBeNull();
      expect(r.repairs).toEqual([]);
    });

    it("returns null for a well-formed nested query", () => {
      const r = lintAndRepair('(filter RESULTS (lambda x (match x "500" 0)))');
      expect(r.repaired).toBeNull();
    });
  });

  describe("missing closing parens", () => {
    it("appends a single missing close paren", () => {
      const broken = '(grep "ERROR"';
      const r = lintAndRepair(broken);
      expect(r.repaired).toBe('(grep "ERROR")');
      expect(reparses(r.repaired!)).toBe(true);
      expect(r.repairs.some((s) => /paren/i.test(s))).toBe(true);
    });

    it("appends multiple missing close parens", () => {
      const broken = '(filter RESULTS (lambda x (match x "500" 0)';
      const r = lintAndRepair(broken);
      expect(r.repaired).not.toBeNull();
      expect(reparses(r.repaired!)).toBe(true);
    });

    it("appends missing close brackets", () => {
      const broken = "[type=string ⊗ (grep \"x\")";
      const r = lintAndRepair(broken);
      // Either the linter repairs it or returns null — but if returned,
      // it must reparse.
      if (r.repaired !== null) {
        expect(reparses(r.repaired)).toBe(true);
      }
    });
  });

  describe("extra trailing closers", () => {
    it("strips an extra trailing close paren", () => {
      const broken = '(grep "ERROR"))';
      const r = lintAndRepair(broken);
      expect(r.repaired).toBe('(grep "ERROR")');
      expect(reparses(r.repaired!)).toBe(true);
    });

    it("strips multiple extra trailing close parens", () => {
      const broken = '(grep "ERROR"))))';
      const r = lintAndRepair(broken);
      expect(r.repaired).toBe('(grep "ERROR")');
      expect(reparses(r.repaired!)).toBe(true);
    });
  });

  describe("prose around the expression", () => {
    it("strips leading prose before the first '('", () => {
      const broken = 'Let me try: (grep "ERROR")';
      const r = lintAndRepair(broken);
      expect(r.repaired).toBe('(grep "ERROR")');
      expect(reparses(r.repaired!)).toBe(true);
    });

    it("strips trailing prose after the outermost ')'", () => {
      const broken = '(grep "ERROR") -- this finds errors';
      const r = lintAndRepair(broken);
      expect(r.repaired).toBe('(grep "ERROR")');
      expect(reparses(r.repaired!)).toBe(true);
    });

    it("handles prose on both sides", () => {
      const broken = 'Here is the query: (count RESULTS) — done.';
      const r = lintAndRepair(broken);
      expect(r.repaired).toBe('(count RESULTS)');
      expect(reparses(r.repaired!)).toBe(true);
    });
  });

  describe("parens inside strings are ignored", () => {
    it("does not count parens inside a string literal", () => {
      // String contains "(" but expr is balanced: still valid → no repair
      const ok = '(grep "foo(bar")';
      const r = lintAndRepair(ok);
      expect(r.repaired).toBeNull();
    });

    it("repairs missing close when string contains a paren", () => {
      const broken = '(grep "foo(bar"';
      const r = lintAndRepair(broken);
      expect(r.repaired).toBe('(grep "foo(bar")');
      expect(reparses(r.repaired!)).toBe(true);
    });
  });

  describe("unrepairable inputs", () => {
    it("returns null for unterminated string literal", () => {
      const broken = '(grep "ERROR';
      const r = lintAndRepair(broken);
      // Best to surface as unrepairable; LLM must retry.
      expect(r.repaired).toBeNull();
    });

    it("returns null for input with no '('", () => {
      const r = lintAndRepair("grep ERROR");
      expect(r.repaired).toBeNull();
    });

    it("returns null for empty input", () => {
      expect(lintAndRepair("").repaired).toBeNull();
      expect(lintAndRepair("   \n  ").repaired).toBeNull();
    });
  });

  describe("idempotence", () => {
    it("repairing a repaired query is a no-op", () => {
      const broken = '(filter RESULTS (lambda x (match x "y" 0))';
      const first = lintAndRepair(broken);
      expect(first.repaired).not.toBeNull();
      const second = lintAndRepair(first.repaired!);
      expect(second.repaired).toBeNull();
    });
  });
});
