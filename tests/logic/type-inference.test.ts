/**
 * Tests for Type Inference
 */

import { describe, it, expect } from "vitest";
import { inferType, typeMatches, typeToString, inferExpectedType, verifyOutputType } from "../../src/logic/type-inference.js";
import { parse } from "../../src/logic/lc-parser.js";

describe("Type Inference", () => {
  describe("inferType", () => {
    it("should infer string type for input", () => {
      const parsed = parse("(input)");
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = inferType(parsed.term);
      expect(result.valid).toBe(true);
      expect(result.type?.tag).toBe("string");
    });

    it("should infer array type for grep", () => {
      const parsed = parse('(grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = inferType(parsed.term);
      expect(result.valid).toBe(true);
      expect(result.type?.tag).toBe("array");
    });

    it("should infer number type for parseInt", () => {
      const parsed = parse('(parseInt (match (input) "\\\\d+" 0))');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = inferType(parsed.term);
      expect(result.valid).toBe(true);
      expect(result.type?.tag).toBe("number");
    });

    it("should infer number type for parseFloat", () => {
      const parsed = parse('(parseFloat (input))');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = inferType(parsed.term);
      expect(result.valid).toBe(true);
      expect(result.type?.tag).toBe("number");
    });

    it("should infer string type for match", () => {
      const parsed = parse('(match (input) "\\\\d+" 0)');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = inferType(parsed.term);
      expect(result.valid).toBe(true);
      expect(result.type?.tag).toBe("string");
    });

    it("should infer function type for classify", () => {
      const parsed = parse('(classify "a" true "b" false)');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = inferType(parsed.term);
      expect(result.valid).toBe(true);
      expect(result.type?.tag).toBe("function");
    });

    it("should infer type through constrained terms", () => {
      const parsed = parse('[Σ⚡μ] ⊗ (grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = inferType(parsed.term);
      expect(result.valid).toBe(true);
      expect(result.type?.tag).toBe("array");
    });
  });

  describe("typeMatches", () => {
    it("should match same types", () => {
      expect(typeMatches({ tag: "string" }, { tag: "string" })).toBe(true);
      expect(typeMatches({ tag: "number" }, { tag: "number" })).toBe(true);
    });

    it("should not match different types", () => {
      expect(typeMatches({ tag: "string" }, { tag: "number" })).toBe(false);
    });

    it("should match any with anything", () => {
      expect(typeMatches({ tag: "any" }, { tag: "string" })).toBe(true);
      expect(typeMatches({ tag: "number" }, { tag: "any" })).toBe(true);
    });
  });

  describe("typeToString", () => {
    it("should format basic types", () => {
      expect(typeToString({ tag: "string" })).toBe("string");
      expect(typeToString({ tag: "number" })).toBe("number");
      expect(typeToString({ tag: "boolean" })).toBe("boolean");
    });

    it("should format array types", () => {
      expect(typeToString({ tag: "array", element: { tag: "string" } })).toBe("string[]");
    });

    it("should format function types", () => {
      expect(typeToString({
        tag: "function",
        param: { tag: "string" },
        result: { tag: "boolean" }
      })).toBe("(string -> boolean)");
    });
  });

  describe("inferExpectedType", () => {
    it("should infer array for 'find' queries", () => {
      expect(inferExpectedType("find all failed webhooks")).toBe("array");
    });

    it("should infer array for 'list' queries", () => {
      expect(inferExpectedType("list the errors")).toBe("array");
    });

    it("should infer number for 'count' queries", () => {
      expect(inferExpectedType("count the errors")).toBe("number");
    });

    it("should infer number for 'sum' queries", () => {
      expect(inferExpectedType("sum up total sales")).toBe("number");
    });

    it("should infer string for 'extract' queries", () => {
      expect(inferExpectedType("extract the date")).toBe("string");
    });

    it("should return null for ambiguous queries", () => {
      expect(inferExpectedType("analyze the data")).toBeNull();
    });
  });

  describe("verifyOutputType", () => {
    it("should pass when types match", () => {
      const parsed = parse('(grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = verifyOutputType(parsed.term, "array");
      expect(result.valid).toBe(true);
    });

    it("should fail when types mismatch", () => {
      const parsed = parse('(grep "test")');
      expect(parsed.success).toBe(true);
      if (!parsed.term) return;

      const result = verifyOutputType(parsed.term, "string");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Type mismatch");
    });
  });
});
