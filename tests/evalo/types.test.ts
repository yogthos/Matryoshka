/**
 * Tests for the Data Extraction DSL types
 */

import { describe, it, expect } from "vitest";
import type { Extractor, Example, Type } from "../../src/synthesis/evalo/types.js";

describe("Extractor DSL Types", () => {
  describe("basic extractors", () => {
    it("should allow input extractor", () => {
      const e: Extractor = { tag: "input" };
      expect(e.tag).toBe("input");
    });

    it("should allow string literal", () => {
      const e: Extractor = { tag: "lit", value: "hello" };
      expect(e.tag).toBe("lit");
      expect(e.value).toBe("hello");
    });

    it("should allow number literal", () => {
      const e: Extractor = { tag: "lit", value: 42 };
      expect(e.tag).toBe("lit");
      expect(e.value).toBe(42);
    });
  });

  describe("string operations", () => {
    it("should allow match with pattern and group", () => {
      const e: Extractor = {
        tag: "match",
        str: { tag: "input" },
        pattern: "\\$(\\d+)",
        group: 1,
      };
      expect(e.tag).toBe("match");
      expect(e.pattern).toBe("\\$(\\d+)");
      expect(e.group).toBe(1);
    });

    it("should allow replace", () => {
      const e: Extractor = {
        tag: "replace",
        str: { tag: "input" },
        from: ",",
        to: "",
      };
      expect(e.tag).toBe("replace");
      expect(e.from).toBe(",");
      expect(e.to).toBe("");
    });

    it("should allow slice", () => {
      const e: Extractor = {
        tag: "slice",
        str: { tag: "input" },
        start: 0,
        end: 5,
      };
      expect(e.tag).toBe("slice");
      expect(e.start).toBe(0);
      expect(e.end).toBe(5);
    });

    it("should allow split with index", () => {
      const e: Extractor = {
        tag: "split",
        str: { tag: "input" },
        delim: ":",
        index: 1,
      };
      expect(e.tag).toBe("split");
      expect(e.delim).toBe(":");
      expect(e.index).toBe(1);
    });
  });

  describe("numeric operations", () => {
    it("should allow parseInt", () => {
      const e: Extractor = {
        tag: "parseInt",
        str: { tag: "input" },
      };
      expect(e.tag).toBe("parseInt");
    });

    it("should allow parseFloat", () => {
      const e: Extractor = {
        tag: "parseFloat",
        str: { tag: "input" },
      };
      expect(e.tag).toBe("parseFloat");
    });

    it("should allow add", () => {
      const e: Extractor = {
        tag: "add",
        left: { tag: "lit", value: 1 },
        right: { tag: "lit", value: 2 },
      };
      expect(e.tag).toBe("add");
    });
  });

  describe("conditional", () => {
    it("should allow if expression", () => {
      const e: Extractor = {
        tag: "if",
        cond: { tag: "input" },
        then: { tag: "lit", value: 1 },
        else: { tag: "lit", value: 0 },
      };
      expect(e.tag).toBe("if");
    });
  });

  describe("nested extractors", () => {
    it("should allow complex nested extraction", () => {
      // Example: parseFloat(replace(match(input, /\$([\d,]+)/, 1), /,/, ""))
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
      expect(e.tag).toBe("parseFloat");
    });
  });
});

describe("Example type", () => {
  it("should allow string input and number output", () => {
    const ex: Example = { input: "$100", output: 100 };
    expect(ex.input).toBe("$100");
    expect(ex.output).toBe(100);
  });

  it("should allow string input and string output", () => {
    const ex: Example = { input: "hello world", output: "hello" };
    expect(ex.output).toBe("hello");
  });

  it("should allow boolean output", () => {
    const ex: Example = { input: "true", output: true };
    expect(ex.output).toBe(true);
  });

  it("should allow null output", () => {
    const ex: Example = { input: "nothing", output: null };
    expect(ex.output).toBe(null);
  });
});

describe("Type system", () => {
  it("should define valid types", () => {
    const types: Type[] = ["string", "number", "boolean", "null", "unknown"];
    expect(types).toHaveLength(5);
  });
});
