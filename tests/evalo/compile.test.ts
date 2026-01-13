/**
 * Tests for JavaScript Compilation
 *
 * The compile module converts Extractor DSL to executable JavaScript.
 * This allows synthesized extractors to be used at runtime.
 */

import { describe, it, expect } from "vitest";
import { compile, compileToFunction } from "../../src/synthesis/evalo/compile.js";
import type { Extractor } from "../../src/synthesis/evalo/types.js";

describe("compile", () => {
  describe("base cases", () => {
    it("should compile input to identity", () => {
      const e: Extractor = { tag: "input" };
      const code = compile(e);
      expect(code).toBe("input");
    });

    it("should compile string literal", () => {
      const e: Extractor = { tag: "lit", value: "hello" };
      const code = compile(e);
      expect(code).toBe('"hello"');
    });

    it("should compile number literal", () => {
      const e: Extractor = { tag: "lit", value: 42 };
      const code = compile(e);
      expect(code).toBe("42");
    });

    it("should escape special characters in string literals", () => {
      const e: Extractor = { tag: "lit", value: 'he"llo' };
      const code = compile(e);
      expect(code).toBe('"he\\"llo"');
    });
  });

  describe("string operations", () => {
    it("should compile match", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "\\d+",
        group: 0,
      };
      const code = compile(e);
      expect(code).toContain("match");
      expect(code).toContain("/\\d+/");
    });

    it("should compile match with group", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "\\$(\\d+)",
        group: 1,
      };
      const code = compile(e);
      expect(code).toContain("[1]");
    });

    it("should compile replace", () => {
      const e: Extractor = {
        tag: "replace",
        str: { tag: "input" },
        from: ",",
        to: "",
      };
      const code = compile(e);
      expect(code).toContain("replace");
      expect(code).toContain("/,/g");
    });

    it("should compile slice", () => {
      const e: Extractor = {
        tag: "slice",
        str: { tag: "input" },
        start: 0,
        end: 5,
      };
      const code = compile(e);
      expect(code).toContain("slice");
      expect(code).toContain("0, 5");
    });

    it("should compile split", () => {
      const e: Extractor = {
        tag: "split",
        str: { tag: "input" },
        delim: ":",
        index: 1,
      };
      const code = compile(e);
      expect(code).toContain("split");
      expect(code).toContain("[1]");
    });
  });

  describe("numeric operations", () => {
    it("should compile parseInt", () => {
      const e: Extractor = {
        tag: "parseInt",
        str: { tag: "input" },
      };
      const code = compile(e);
      expect(code).toContain("parseInt");
      expect(code).toContain("10");
    });

    it("should compile parseFloat", () => {
      const e: Extractor = {
        tag: "parseFloat",
        str: { tag: "input" },
      };
      const code = compile(e);
      expect(code).toContain("parseFloat");
    });

    it("should compile add", () => {
      const e: Extractor = {
        tag: "add",
        left: { tag: "lit", value: 1 },
        right: { tag: "lit", value: 2 },
      };
      const code = compile(e);
      expect(code).toContain("+");
    });
  });

  describe("conditional", () => {
    it("should compile if as ternary", () => {
      const e: Extractor = {
        tag: "if",
        cond: { tag: "input" },
        then: { tag: "lit", value: 1 },
        else: { tag: "lit", value: 0 },
      };
      const code = compile(e);
      expect(code).toContain("?");
      expect(code).toContain(":");
    });
  });

  describe("nested extractors", () => {
    it("should compile parseFloat of match", () => {
      const e: Extractor = {
        tag: "parseFloat",
        str: {
          tag: "match",
          str: { tag: "input" },
          pattern: "\\d+",
          group: 0,
        },
      };
      const code = compile(e);
      expect(code).toContain("parseFloat");
      expect(code).toContain("match");
    });

    it("should compile currency extractor", () => {
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
      const code = compile(e);
      expect(code).toContain("parseFloat");
      expect(code).toContain("replace");
      expect(code).toContain("match");
    });
  });
});

describe("compileToFunction", () => {
  describe("execution", () => {
    it("should create working identity function", () => {
      const e: Extractor = { tag: "input" };
      const fn = compileToFunction(e);
      expect(fn("hello")).toBe("hello");
      expect(fn("world")).toBe("world");
    });

    it("should create working literal function", () => {
      const e: Extractor = { tag: "lit", value: 42 };
      const fn = compileToFunction(e);
      expect(fn("anything")).toBe(42);
    });

    it("should create working match function", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "\\$(\\d+)",
        group: 1,
      };
      const fn = compileToFunction(e);
      expect(fn("$100")).toBe("100");
      expect(fn("$200")).toBe("200");
    });

    it("should create working parseInt function", () => {
      const e: Extractor = {
        tag: "parseInt",
        str: {
          tag: "match",
          str: { tag: "input" },
          pattern: "\\d+",
          group: 0,
        },
      };
      const fn = compileToFunction(e);
      expect(fn("abc123def")).toBe(123);
    });

    it("should create working currency extractor", () => {
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
      const fn = compileToFunction(e);
      expect(fn("$1,234")).toBe(1234);
      expect(fn("$5,678,900")).toBe(5678900);
    });
  });

  describe("error handling", () => {
    it("should return null for no match", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "xyz",
        group: 0,
      };
      const fn = compileToFunction(e);
      expect(fn("abc")).toBe(null);
    });
  });
});
