/**
 * Tests for Parser :examples syntax extension
 * TDD: These tests are written FIRST to define the expected behavior
 *
 * The :examples syntax allows inline examples for synthesis fallback:
 * (parseCurrency x :examples [("€100" 100) ("€50" 50)])
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../src/logic/lc-parser.js";
import type { LCTerm, LCParseCurrency, LCParseDate, LCExtract } from "../../src/logic/types.js";

describe("Parser with :examples syntax", () => {
  describe("parseCurrency with examples", () => {
    it("parses parseCurrency with inline examples", () => {
      const result = parse('(parseCurrency x :examples [("€100" 100) ("€50" 50)])');

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("parseCurrency");

      const term = result.term as LCParseCurrency;
      expect(term.examples).toBeDefined();
      expect(term.examples).toHaveLength(2);
      expect(term.examples![0]).toEqual({ input: "€100", output: 100 });
      expect(term.examples![1]).toEqual({ input: "€50", output: 50 });
    });

    it("parses parseCurrency without examples (backwards compatible)", () => {
      const result = parse("(parseCurrency x)");

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("parseCurrency");

      const term = result.term as LCParseCurrency;
      expect(term.examples).toBeUndefined();
    });

    it("parses parseCurrency with parenthesized examples", () => {
      const result = parse('(parseCurrency x :examples (("$1,000" 1000) ("$500" 500)))');

      expect(result.success).toBe(true);
      const term = result.term as LCParseCurrency;
      expect(term.examples).toHaveLength(2);
    });
  });

  describe("parseDate with examples", () => {
    it("parses parseDate with inline examples", () => {
      const result = parse(
        '(parseDate x :examples [("15-Jan-2024" "2024-01-15") ("20-Feb-2024" "2024-02-20")])'
      );

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("parseDate");

      const term = result.term as LCParseDate;
      expect(term.examples).toBeDefined();
      expect(term.examples).toHaveLength(2);
      expect(term.examples![0]).toEqual({ input: "15-Jan-2024", output: "2024-01-15" });
    });

    it("parses parseDate with format and examples", () => {
      const result = parse(
        '(parseDate x "custom" :examples [("Jan 15, 24" "2024-01-15")])'
      );

      expect(result.success).toBe(true);
      const term = result.term as LCParseDate;
      expect(term.format).toBe("custom");
      expect(term.examples).toHaveLength(1);
    });
  });

  describe("parseNumber with examples", () => {
    it("parses parseNumber with inline examples", () => {
      const result = parse(
        '(parseNumber x :examples [("1,234 units" 1234) ("500 units" 500)])'
      );

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("parseNumber");
    });
  });

  describe("extract with examples and type hint", () => {
    it("parses extract with examples", () => {
      const result = parse(
        '(extract x "Revenue: (.+)" 1 :examples [("Revenue: $1,234" 1234)])'
      );

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("extract");

      const term = result.term as LCExtract;
      expect(term.examples).toBeDefined();
      expect(term.examples![0]).toEqual({ input: "Revenue: $1,234", output: 1234 });
    });

    it("parses extract with type and examples", () => {
      const result = parse(
        '(extract x "([\\d,]+)" 1 "currency" :examples [("$1,234" 1234)])'
      );

      expect(result.success).toBe(true);
      const term = result.term as LCExtract;
      expect(term.targetType).toBe("currency");
      expect(term.examples).toHaveLength(1);
    });
  });

  describe("define-fn for reusable synthesized functions", () => {
    it("parses define-fn with name and examples", () => {
      const result = parse(
        '(define-fn "eu-currency" :examples [("1.234€" 1234) ("500€" 500)])'
      );

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("define-fn");

      const term = result.term as { tag: "define-fn"; name: string; examples: Array<{ input: string; output: unknown }> };
      expect(term.name).toBe("eu-currency");
      expect(term.examples).toHaveLength(2);
    });
  });

  describe("apply-fn for using synthesized functions", () => {
    it("parses apply-fn with function name", () => {
      const result = parse('(apply-fn "eu-currency" x)');

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("apply-fn");

      const term = result.term as { tag: "apply-fn"; name: string; arg: LCTerm };
      expect(term.name).toBe("eu-currency");
    });
  });

  describe("complex nested expressions with examples", () => {
    it("parses map with parseCurrency examples in lambda", () => {
      const result = parse(
        '(map RESULTS (lambda x (parseCurrency x :examples [("€100" 100)])))'
      );

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("map");
    });

    it("parses filter with predicate examples", () => {
      const result = parse(
        '(filter RESULTS (lambda x (predicate x :examples [("ERROR" true) ("INFO" false)])))'
      );

      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("filter");
    });
  });

  describe("keyword parsing", () => {
    it("recognizes :examples as keyword", () => {
      // The keyword should not be confused with a symbol
      const result = parse('(parseCurrency x :examples [("test" 1)])');
      expect(result.success).toBe(true);
    });

    it("recognizes :type as keyword", () => {
      const result = parse('(extract x "pattern" 1 :type "currency")');
      expect(result.success).toBe(true);
    });

    it("recognizes :constraints as keyword", () => {
      const result = parse('(extract x "pattern" 1 :constraints {:min 0 :max 100})');
      expect(result.success).toBe(true);
    });
  });

  describe("example list formats", () => {
    it("supports bracket notation [(...) (...)]", () => {
      const result = parse('(parseCurrency x :examples [("a" 1) ("b" 2)])');
      expect(result.success).toBe(true);
    });

    it("supports parenthesis notation ((...) (...))", () => {
      const result = parse('(parseCurrency x :examples (("a" 1) ("b" 2)))');
      expect(result.success).toBe(true);
    });

    it("handles string outputs in examples", () => {
      const result = parse('(parseDate x :examples [("15/01/24" "2024-01-15")])');
      expect(result.success).toBe(true);
    });

    it("handles boolean outputs in examples", () => {
      const result = parse('(predicate x :examples [("ERROR" true) ("INFO" false)])');
      expect(result.success).toBe(true);
    });
  });
});

describe("Types with examples field", () => {
  it("LCParseCurrency can have optional examples", () => {
    // Type check - these should compile without error
    const withoutExamples: LCParseCurrency = {
      tag: "parseCurrency",
      str: { tag: "var", name: "x" },
    };

    const withExamples: LCParseCurrency = {
      tag: "parseCurrency",
      str: { tag: "var", name: "x" },
      examples: [{ input: "$100", output: 100 }],
    };

    expect(withoutExamples.tag).toBe("parseCurrency");
    expect(withExamples.examples).toHaveLength(1);
  });
});
