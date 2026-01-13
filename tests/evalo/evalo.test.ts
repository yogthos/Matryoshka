/**
 * Tests for the Relational Interpreter (evalo)
 *
 * evalo is the core relation that makes synthesis possible:
 * - Forward mode: evalo(extractor, input, ?output) => evaluates to output
 * - Backwards mode: evalo(?extractor, input, output) => synthesizes extractor
 */

import { describe, it, expect } from "vitest";
import {
  evalExtractor,
  evalo,
  synthesizeExtractor,
} from "../../src/synthesis/evalo/evalo.js";
import type { Extractor } from "../../src/synthesis/evalo/types.js";

describe("evalExtractor (forward mode)", () => {
  describe("base cases", () => {
    it("should return input unchanged", () => {
      const result = evalExtractor({ tag: "input" }, "hello");
      expect(result).toBe("hello");
    });

    it("should return string literal", () => {
      const result = evalExtractor({ tag: "lit", value: "world" }, "ignored");
      expect(result).toBe("world");
    });

    it("should return number literal", () => {
      const result = evalExtractor({ tag: "lit", value: 42 }, "ignored");
      expect(result).toBe(42);
    });
  });

  describe("match operation", () => {
    it("should extract regex group 0 (full match)", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "\\d+",
        group: 0,
      };
      const result = evalExtractor(e, "abc123def");
      expect(result).toBe("123");
    });

    it("should extract regex group 1", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "\\$(\\d+)",
        group: 1,
      };
      const result = evalExtractor(e, "Price: $100");
      expect(result).toBe("100");
    });

    it("should return null for no match", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "\\d+",
        group: 0,
      };
      const result = evalExtractor(e, "no numbers here");
      expect(result).toBe(null);
    });

    it("should handle currency with commas", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "\\$([\\d,]+)",
        group: 1,
      };
      const result = evalExtractor(e, "SALES: $1,234,567");
      expect(result).toBe("1,234,567");
    });
  });

  describe("replace operation", () => {
    it("should replace all occurrences", () => {
      const e: Extractor = {
        tag: "replace",
        str: { tag: "input" },
        from: ",",
        to: "",
      };
      const result = evalExtractor(e, "1,234,567");
      expect(result).toBe("1234567");
    });

    it("should handle no matches", () => {
      const e: Extractor = {
        tag: "replace",
        str: { tag: "input" },
        from: "x",
        to: "y",
      };
      const result = evalExtractor(e, "hello");
      expect(result).toBe("hello");
    });
  });

  describe("slice operation", () => {
    it("should extract substring", () => {
      const e: Extractor = {
        tag: "slice",
        str: { tag: "input" },
        start: 0,
        end: 5,
      };
      const result = evalExtractor(e, "hello world");
      expect(result).toBe("hello");
    });

    it("should handle negative end", () => {
      const e: Extractor = {
        tag: "slice",
        str: { tag: "input" },
        start: 0,
        end: -1,
      };
      const result = evalExtractor(e, "hello");
      expect(result).toBe("hell");
    });
  });

  describe("split operation", () => {
    it("should split and get index", () => {
      const e: Extractor = {
        tag: "split",
        str: { tag: "input" },
        delim: ":",
        index: 1,
      };
      const result = evalExtractor(e, "key: value");
      expect(result).toBe(" value");
    });

    it("should return null for out of bounds", () => {
      const e: Extractor = {
        tag: "split",
        str: { tag: "input" },
        delim: ":",
        index: 5,
      };
      const result = evalExtractor(e, "a:b");
      expect(result).toBe(null);
    });
  });

  describe("parseInt operation", () => {
    it("should parse integer string", () => {
      const e: Extractor = {
        tag: "parseInt",
        str: { tag: "input" },
      };
      const result = evalExtractor(e, "42");
      expect(result).toBe(42);
    });

    it("should parse from matched string", () => {
      const e: Extractor = {
        tag: "parseInt",
        str: {
          tag: "match",
          str: { tag: "input" },
          pattern: "\\d+",
          group: 0,
        },
      };
      const result = evalExtractor(e, "abc123def");
      expect(result).toBe(123);
    });

    it("should return NaN for non-numeric", () => {
      const e: Extractor = {
        tag: "parseInt",
        str: { tag: "input" },
      };
      const result = evalExtractor(e, "hello");
      expect(result).toBeNaN();
    });
  });

  describe("parseFloat operation", () => {
    it("should parse float string", () => {
      const e: Extractor = {
        tag: "parseFloat",
        str: { tag: "input" },
      };
      const result = evalExtractor(e, "3.14");
      expect(result).toBe(3.14);
    });

    it("should handle currency extraction", () => {
      // parseFloat(replace(match(input, /\$([\d,]+)/, 1), /,/, ""))
      const e: Extractor = {
        tag: "parseFloat",
        str: {
          tag: "replace",
          str: {
            tag: "match",
            str: { tag: "input" },
            pattern: "\\$([\\d,]+)",
            group: 1,
          },
          from: ",",
          to: "",
        },
      };
      const result = evalExtractor(e, "SALES: $1,234,567");
      expect(result).toBe(1234567);
    });
  });

  describe("add operation", () => {
    it("should add two numbers", () => {
      const e: Extractor = {
        tag: "add",
        left: { tag: "lit", value: 1 },
        right: { tag: "lit", value: 2 },
      };
      const result = evalExtractor(e, "ignored");
      expect(result).toBe(3);
    });

    it("should add parsed numbers", () => {
      const e: Extractor = {
        tag: "add",
        left: { tag: "parseInt", str: { tag: "lit", value: "10" } },
        right: { tag: "parseInt", str: { tag: "lit", value: "20" } },
      };
      const result = evalExtractor(e, "ignored");
      expect(result).toBe(30);
    });
  });

  describe("if operation", () => {
    it("should return then branch for truthy", () => {
      const e: Extractor = {
        tag: "if",
        cond: { tag: "lit", value: "truthy" },
        then: { tag: "lit", value: 1 },
        else: { tag: "lit", value: 0 },
      };
      const result = evalExtractor(e, "ignored");
      expect(result).toBe(1);
    });

    it("should return else branch for falsy", () => {
      const e: Extractor = {
        tag: "if",
        cond: { tag: "lit", value: "" },
        then: { tag: "lit", value: 1 },
        else: { tag: "lit", value: 0 },
      };
      const result = evalExtractor(e, "ignored");
      expect(result).toBe(0);
    });

    it("should return else branch for null", () => {
      const e: Extractor = {
        tag: "if",
        cond: {
          tag: "match",
          str: { tag: "input" },
          pattern: "xyz",
          group: 0,
        },
        then: { tag: "lit", value: "found" },
        else: { tag: "lit", value: "not found" },
      };
      const result = evalExtractor(e, "abc");
      expect(result).toBe("not found");
    });
  });
});

describe("evalo (relational mode)", () => {
  describe("forward mode", () => {
    it("should unify output with evaluation result", () => {
      const results = evalo({ tag: "input" }, "hello", null);
      expect(results).toContain("hello");
    });

    it("should return empty for wrong expected output", () => {
      const results = evalo({ tag: "input" }, "hello", "wrong");
      expect(results).not.toContain("hello");
    });
  });
});

describe("synthesizeExtractor (backwards mode)", () => {
  describe("simple cases", () => {
    it("should synthesize identity for same input/output", () => {
      const extractors = synthesizeExtractor([
        { input: "hello", output: "hello" },
        { input: "world", output: "world" },
      ]);
      expect(extractors.length).toBeGreaterThan(0);
      // The simplest solution is { tag: "input" }
      expect(extractors.some(e => e.tag === "input")).toBe(true);
    });

    it("should synthesize literal for constant output", () => {
      const extractors = synthesizeExtractor([
        { input: "anything", output: 42 },
        { input: "different", output: 42 },
      ]);
      expect(extractors.length).toBeGreaterThan(0);
      // The simplest solution is { tag: "lit", value: 42 }
      expect(extractors.some(e => e.tag === "lit" && e.value === 42)).toBe(true);
    });
  });

  describe("extraction patterns", () => {
    it("should synthesize currency extractor", () => {
      const extractors = synthesizeExtractor([
        { input: "$100", output: 100 },
        { input: "$200", output: 200 },
      ]);
      expect(extractors.length).toBeGreaterThan(0);

      // Verify the extractor works
      const extractor = extractors[0];
      expect(evalExtractor(extractor, "$100")).toBe(100);
      expect(evalExtractor(extractor, "$200")).toBe(200);
      expect(evalExtractor(extractor, "$300")).toBe(300);
    });

    it("should synthesize currency with commas extractor", () => {
      const extractors = synthesizeExtractor([
        { input: "$1,234", output: 1234 },
        { input: "$5,678", output: 5678 },
      ]);
      expect(extractors.length).toBeGreaterThan(0);

      const extractor = extractors[0];
      expect(evalExtractor(extractor, "$1,234")).toBe(1234);
      expect(evalExtractor(extractor, "$9,999")).toBe(9999);
    });

    it("should synthesize percentage extractor", () => {
      const extractors = synthesizeExtractor([
        { input: "50%", output: 50 },
        { input: "75%", output: 75 },
      ]);
      expect(extractors.length).toBeGreaterThan(0);

      const extractor = extractors[0];
      expect(evalExtractor(extractor, "50%")).toBe(50);
      expect(evalExtractor(extractor, "100%")).toBe(100);
    });
  });

  describe("error cases", () => {
    it("should detect conflicting examples", () => {
      expect(() =>
        synthesizeExtractor([
          { input: "abc", output: 1 },
          { input: "abc", output: 2 },
        ])
      ).toThrow(/conflict/i);
    });

    it("should require at least 2 examples", () => {
      expect(() => synthesizeExtractor([{ input: "x", output: 1 }])).toThrow(
        /at least 2/i
      );
    });

    it("should return empty for impossible extraction", () => {
      const extractors = synthesizeExtractor([
        { input: "abc", output: 1 },
        { input: "xyz", output: 2 },
      ]);
      // No simple pattern connects these
      expect(extractors.length).toBe(0);
    });
  });
});
