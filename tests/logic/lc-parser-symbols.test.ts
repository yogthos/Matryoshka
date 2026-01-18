import { describe, it, expect } from "vitest";
import { parse } from "../../src/logic/lc-parser.js";

describe("LC Parser - Symbol Commands", () => {
  describe("list_symbols", () => {
    it("should parse (list_symbols)", () => {
      const result = parse("(list_symbols)");
      expect(result.success).toBe(true);
      expect(result.term).toEqual({ tag: "list_symbols" });
    });

    it("should parse (list_symbols \"function\")", () => {
      const result = parse('(list_symbols "function")');
      expect(result.success).toBe(true);
      expect(result.term).toEqual({ tag: "list_symbols", kind: "function" });
    });

    it("should parse (list_symbols \"class\")", () => {
      const result = parse('(list_symbols "class")');
      expect(result.success).toBe(true);
      expect(result.term).toEqual({ tag: "list_symbols", kind: "class" });
    });

    it("should parse (list_symbols \"method\")", () => {
      const result = parse('(list_symbols "method")');
      expect(result.success).toBe(true);
      expect(result.term).toEqual({ tag: "list_symbols", kind: "method" });
    });
  });

  describe("get_symbol_body", () => {
    it("should parse (get_symbol_body RESULTS)", () => {
      const result = parse("(get_symbol_body RESULTS)");
      expect(result.success).toBe(true);
      expect(result.term).toEqual({
        tag: "get_symbol_body",
        symbol: { tag: "var", name: "RESULTS" },
      });
    });

    it("should parse (get_symbol_body (first RESULTS))", () => {
      const result = parse("(get_symbol_body (first RESULTS))");
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("get_symbol_body");
      if (result.term?.tag === "get_symbol_body") {
        expect(result.term.symbol.tag).toBe("app");
      }
    });

    it("should parse (get_symbol_body \"functionName\")", () => {
      const result = parse('(get_symbol_body "functionName")');
      expect(result.success).toBe(true);
      expect(result.term).toEqual({
        tag: "get_symbol_body",
        symbol: { tag: "lit", value: "functionName" },
      });
    });
  });

  describe("find_references", () => {
    it("should parse (find_references \"myFunc\")", () => {
      const result = parse('(find_references "myFunc")');
      expect(result.success).toBe(true);
      expect(result.term).toEqual({ tag: "find_references", name: "myFunc" });
    });

    it("should parse (find_references \"ClassName\")", () => {
      const result = parse('(find_references "ClassName")');
      expect(result.success).toBe(true);
      expect(result.term).toEqual({ tag: "find_references", name: "ClassName" });
    });

    it("should parse (find_references \"_private_var\")", () => {
      const result = parse('(find_references "_private_var")');
      expect(result.success).toBe(true);
      expect(result.term).toEqual({ tag: "find_references", name: "_private_var" });
    });
  });
});
