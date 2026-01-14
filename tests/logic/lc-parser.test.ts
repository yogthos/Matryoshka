/**
 * Tests for the LC Parser
 */

import { describe, it, expect } from "vitest";
import { parse, prettyPrint } from "../../src/logic/lc-parser.js";

describe("LC Parser", () => {
  describe("basic terms", () => {
    it("should parse input", () => {
      const result = parse("(input)");
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("input");
    });

    it("should parse literal string", () => {
      const result = parse('"hello world"');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("lit");
      if (result.term?.tag === "lit") {
        expect(result.term.value).toBe("hello world");
      }
    });

    it("should parse literal number", () => {
      const result = parse("42");
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("lit");
      if (result.term?.tag === "lit") {
        expect(result.term.value).toBe(42);
      }
    });

    it("should parse literal boolean", () => {
      const result = parse("true");
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("lit");
      if (result.term?.tag === "lit") {
        expect(result.term.value).toBe(true);
      }
    });
  });

  describe("grep", () => {
    it("should parse grep term", () => {
      const result = parse('(grep "webhook")');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("grep");
      if (result.term?.tag === "grep") {
        expect(result.term.pattern).toBe("webhook");
      }
    });
  });

  describe("match", () => {
    it("should parse match term", () => {
      const result = parse('(match (input) "\\\\d+" 0)');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("match");
      if (result.term?.tag === "match") {
        expect(result.term.str.tag).toBe("input");
        expect(result.term.pattern).toBe("\\d+");
        expect(result.term.group).toBe(0);
      }
    });
  });

  describe("classify", () => {
    it("should parse classify term with examples", () => {
      const result = parse('(classify "line1 ERROR" true "line2 INFO" false)');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("classify");
      if (result.term?.tag === "classify") {
        expect(result.term.examples).toHaveLength(2);
        expect(result.term.examples[0].input).toBe("line1 ERROR");
        expect(result.term.examples[0].output).toBe(true);
        expect(result.term.examples[1].input).toBe("line2 INFO");
        expect(result.term.examples[1].output).toBe(false);
      }
    });

    it("should reject classify with fewer than 2 examples", () => {
      const result = parse('(classify "line1" true)');
      expect(result.success).toBe(false);
    });
  });

  describe("parseInt and parseFloat", () => {
    it("should parse parseInt", () => {
      const result = parse('(parseInt (match (input) "\\\\d+" 0))');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("parseInt");
    });

    it("should parse parseFloat", () => {
      const result = parse('(parseFloat (match (input) "[\\\\d.]+" 0))');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("parseFloat");
    });
  });

  describe("replace and split", () => {
    it("should parse replace", () => {
      const result = parse('(replace (input) "," "")');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("replace");
      if (result.term?.tag === "replace") {
        expect(result.term.from).toBe(",");
        expect(result.term.to).toBe("");
      }
    });

    it("should parse split", () => {
      const result = parse('(split (input) ":" 1)');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("split");
      if (result.term?.tag === "split") {
        expect(result.term.delim).toBe(":");
        expect(result.term.index).toBe(1);
      }
    });
  });

  describe("if", () => {
    it("should parse if term", () => {
      const result = parse("(if true 1 0)");
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("if");
      if (result.term?.tag === "if") {
        expect(result.term.cond.tag).toBe("lit");
        expect(result.term.then.tag).toBe("lit");
        expect(result.term.else.tag).toBe("lit");
      }
    });
  });

  describe("constrained terms", () => {
    it("should parse constrained term with tensor operator", () => {
      const result = parse('[Σ⚡μ] ⊗ (grep "test")');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("constrained");
      if (result.term?.tag === "constrained") {
        expect(result.term.constraint).toBe("Σ⚡μ");
        expect(result.term.term.tag).toBe("grep");
      }
    });
  });

  describe("lambda", () => {
    it("should parse lambda term", () => {
      const result = parse("(lambda x (input))");
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("lambda");
      if (result.term?.tag === "lambda") {
        expect(result.term.param).toBe("x");
        expect(result.term.body.tag).toBe("input");
      }
    });
  });

  describe("prettyPrint", () => {
    it("should round-trip grep term", () => {
      const original = '(grep "test")';
      const parsed = parse(original);
      expect(parsed.success).toBe(true);
      if (parsed.term) {
        const printed = prettyPrint(parsed.term);
        expect(printed).toBe(original);
      }
    });

    it("should round-trip classify term", () => {
      const parsed = parse('(classify "a" true "b" false)');
      expect(parsed.success).toBe(true);
      if (parsed.term) {
        const printed = prettyPrint(parsed.term);
        expect(printed).toContain("classify");
        expect(printed).toContain('"a"');
        expect(printed).toContain("true");
      }
    });
  });

  describe("error handling", () => {
    it("should return error for empty input", () => {
      const result = parse("");
      expect(result.success).toBe(false);
    });

    it("should return error for unbalanced parens", () => {
      const result = parse("(grep");
      expect(result.success).toBe(false);
    });
  });
});
