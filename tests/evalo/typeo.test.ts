/**
 * Tests for Type Inference (typeo)
 *
 * typeo infers the output type of an extractor without running it.
 * This enables early pruning during synthesis:
 * - If output must be number, skip string-only extractors
 * - If output must be string, skip numeric extractors
 */

import { describe, it, expect } from "vitest";
import { inferType, canProduceType } from "../../src/synthesis/evalo/typeo.js";
import type { Extractor, Type } from "../../src/synthesis/evalo/types.js";

describe("inferType", () => {
  describe("base cases", () => {
    it("should infer string for input", () => {
      const e: Extractor = { tag: "input" };
      expect(inferType(e)).toBe("string");
    });

    it("should infer string for string literal", () => {
      const e: Extractor = { tag: "lit", value: "hello" };
      expect(inferType(e)).toBe("string");
    });

    it("should infer number for number literal", () => {
      const e: Extractor = { tag: "lit", value: 42 };
      expect(inferType(e)).toBe("number");
    });
  });

  describe("string operations", () => {
    it("should infer string for match", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: ".*",
        group: 0,
      };
      expect(inferType(e)).toBe("string");
    });

    it("should infer string for replace", () => {
      const e: Extractor = {
        tag: "replace",
        str: { tag: "input" },
        from: "a",
        to: "b",
      };
      expect(inferType(e)).toBe("string");
    });

    it("should infer string for slice", () => {
      const e: Extractor = {
        tag: "slice",
        str: { tag: "input" },
        start: 0,
        end: 5,
      };
      expect(inferType(e)).toBe("string");
    });

    it("should infer string for split", () => {
      const e: Extractor = {
        tag: "split",
        str: { tag: "input" },
        delim: ":",
        index: 0,
      };
      expect(inferType(e)).toBe("string");
    });
  });

  describe("numeric operations", () => {
    it("should infer number for parseInt", () => {
      const e: Extractor = {
        tag: "parseInt",
        str: { tag: "input" },
      };
      expect(inferType(e)).toBe("number");
    });

    it("should infer number for parseFloat", () => {
      const e: Extractor = {
        tag: "parseFloat",
        str: { tag: "input" },
      };
      expect(inferType(e)).toBe("number");
    });

    it("should infer number for add", () => {
      const e: Extractor = {
        tag: "add",
        left: { tag: "lit", value: 1 },
        right: { tag: "lit", value: 2 },
      };
      expect(inferType(e)).toBe("number");
    });
  });

  describe("conditional", () => {
    it("should infer unknown for if with different branch types", () => {
      const e: Extractor = {
        tag: "if",
        cond: { tag: "input" },
        then: { tag: "lit", value: 1 },
        else: { tag: "lit", value: "no" },
      };
      expect(inferType(e)).toBe("unknown");
    });

    it("should infer common type for if with same branch types", () => {
      const e: Extractor = {
        tag: "if",
        cond: { tag: "input" },
        then: { tag: "lit", value: 1 },
        else: { tag: "lit", value: 2 },
      };
      expect(inferType(e)).toBe("number");
    });
  });

  describe("nested extractors", () => {
    it("should infer number for parseFloat of match", () => {
      const e: Extractor = {
        tag: "parseFloat",
        str: {
          tag: "match",
          str: { tag: "input" },
          pattern: "\\d+",
          group: 0,
        },
      };
      expect(inferType(e)).toBe("number");
    });

    it("should infer number for parseInt of replace of match", () => {
      const e: Extractor = {
        tag: "parseInt",
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
      expect(inferType(e)).toBe("number");
    });
  });
});

describe("canProduceType", () => {
  it("should return true if extractor can produce the type", () => {
    const e: Extractor = { tag: "parseInt", str: { tag: "input" } };
    expect(canProduceType(e, "number")).toBe(true);
  });

  it("should return false if extractor cannot produce the type", () => {
    const e: Extractor = { tag: "input" };
    expect(canProduceType(e, "number")).toBe(false);
  });

  it("should return true for unknown type (conservative)", () => {
    const e: Extractor = { tag: "input" };
    expect(canProduceType(e, "unknown")).toBe(true);
  });

  it("should handle nullable types", () => {
    const e: Extractor = {
      tag: "match",
      str: { tag: "input" },
      pattern: "xyz",
      group: 0,
    };
    // Match can return null if no match, but type is still "string"
    expect(canProduceType(e, "string")).toBe(true);
    expect(canProduceType(e, "null")).toBe(true); // can also produce null
  });
});
