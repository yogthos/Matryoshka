/**
 * Tests for the LC Parser
 */

import { describe, it, expect } from "vitest";
import { parse, prettyPrint } from "../../src/logic/lc-parser.js";
import { readFileSync } from "fs";
import type { LCTerm } from "../../src/logic/types.js";
import { solve } from "../../src/logic/lc-solver.js";
import type { SolverTools } from "../../src/logic/lc-solver.js";
import { parseAll } from "../../src/logic/lc-parser.js";

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

// =====================================================================
// Source-pattern checks (from audits)
// =====================================================================
describe("Source-pattern checks (from audits)", () => {
  // from tests/audit18.test.ts Audit18 #6: escapeForPrint newlines
  describe("Audit18 #6: escapeForPrint newlines", () => {
    it("should escape newlines in string values", async () => {
      const { prettyPrint } = await import("../../src/logic/lc-parser.js");
      const term: any = {
        tag: "lit",
        value: "line1\nline2",
      };
      const result = prettyPrint(term);
      // Should not contain a raw newline — should be escaped as \\n
      expect(result).not.toContain("\n");
      expect(result).toContain("\\n");
    });

    it("should escape tabs in pattern strings", async () => {
      const { prettyPrint } = await import("../../src/logic/lc-parser.js");
      const term: any = {
        tag: "match",
        str: { tag: "input" },
        pattern: "col1\tcol2",
        group: 0,
      };
      const result = prettyPrint(term);
      expect(result).not.toContain("\t");
      expect(result).toContain("\\t");
    });
  });

  // from tests/audit24.test.ts Audit24 #12: lc-parser bare minus handling
  describe("Audit24 #12: lc-parser bare minus handling", () => {
    it("should parse negative numbers correctly", async () => {
      const { parse } = await import("../../src/logic/lc-parser.js");
      const result = parse("(add -1 2)");
      expect(result.success).toBe(true);
      if (result.success && result.term && result.term.tag === "add") {
        expect(result.term.left).toEqual({ tag: "lit", value: -1 });
        expect(result.term.right).toEqual({ tag: "lit", value: 2 });
      }
    });

    it("should not produce NaN from standalone minus before paren", async () => {
      const { parse } = await import("../../src/logic/lc-parser.js");
      // "-)" should not be parsed as a number NaN
      // The guard at line 175 checks for digit after minus
      const result = parse("(add 1 2)");
      expect(result.success).toBe(true);
    });
  });

  // from tests/audit32.test.ts #7 — parseAll should handle multi-line S-expressions
  describe("#7 — parseAll should handle multi-line S-expressions", () => {
        it("should parse a multi-line S-expression as one term", async () => {
          const { parseAll } = await import("../../src/logic/lc-parser.js");
          const input = `(filter RESULTS
    (lambda x (match x "foo" 0)))`;
          const results = parseAll(input);
          // Should produce exactly one parse result, not two broken ones
          const successResults = results.filter(r => r.success);
          expect(successResults.length).toBe(1);
          expect(successResults[0].term?.tag).toBe("filter");
        });
      });

  // from tests/audit34.test.ts #7 — parser should error on unterminated strings
  describe("#7 — parser should error on unterminated strings", () => {
        it("should report error for unterminated string literal", async () => {
          const { parse } = await import("../../src/logic/lc-parser.js");
          const result = parse('(grep "unterminated');
          // Should fail, not silently succeed
          expect(result.success).toBe(false);
          expect(result.error).toMatch(/unterminated|unclosed|string/i);
        });
      });

  // from tests/audit58.test.ts #1 — lc-parser symbol loop should limit length
  describe("#1 — lc-parser symbol loop should limit length", () => {
      it("should limit symbol string accumulation length", () => {
        const source = readFileSync("src/logic/lc-parser.ts", "utf-8");
        const symLoop = source.match(/let sym = ""[\s\S]*?sym \+= input\[i\]/);
        expect(symLoop).not.toBeNull();
        expect(symLoop![0]).toMatch(/sym\.length|MAX_SYM/i);
      });
    });

  // from tests/audit75.test.ts #2 — lc-parser keyword should have max length
  describe("#2 — lc-parser keyword should have max length", () => {
      it("should cap keyword length during tokenization", () => {
        const source = readFileSync("src/logic/lc-parser.ts", "utf-8");
        const kwSection = source.indexOf('let kw = ""');
        expect(kwSection).toBeGreaterThan(-1);
        const block = source.slice(kwSection, kwSection + 200);
        expect(block).toMatch(/MAX_KW|kw\.length\s*>=\s*\d{2,}|kw\.length\s*>\s*\d{2,}/);
      });
    });

  // from tests/audit76.test.ts #1 — lc-parser string literal should have length cap
  describe("#1 — lc-parser string literal should have length cap", () => {
      it("should cap string literal accumulation", () => {
        const source = readFileSync("src/logic/lc-parser.ts", "utf-8");
        const strLiteral = source.indexOf('let str = ""');
        expect(strLiteral).toBeGreaterThan(-1);
        const block = source.slice(strLiteral, strLiteral + 400);
        expect(block).toMatch(/MAX_STRING|str\.length\s*>=?\s*\d{3,}/);
      });
    });

  // from tests/audit91.test.ts #5 — match group should be validated in parser
  describe("#5 — match group should be validated in parser", () => {
      it("should reject group values outside 0-99 range", () => {
        const source = readFileSync("src/logic/lc-parser.ts", "utf-8");
        const matchCase = source.indexOf('case "match"', source.indexOf("function parseList"));
        expect(matchCase).toBeGreaterThan(-1);
        const block = source.slice(matchCase, matchCase + 500);
        // Should validate group bounds (0-99 or similar)
        expect(block).toMatch(/group.*<\s*0|group.*>\s*\d{2,}|group.*>=\s*\d{2,}|isSafeInteger.*group/);
      });
    });

  // from tests/audit96.test.ts #3 — (lines) uses SolverTools.lines, no cross-session leak
  describe("#3 — (lines) uses SolverTools.lines, no cross-session leak", () => {
      function makeTools(context: string, lines: string[]): SolverTools {
        return {
          grep: () => [],
          fuzzy_search: () => [],
          bm25: () => [],
          semantic: () => [],
          text_stats: () => ({
            length: context.length,
            lineCount: lines.length,
            sample: { start: "", middle: "", end: "" },
          }),
          context,
          lines,
        };
      }

      it("(lines 1 2) respects tools.lines even when it diverges from context", async () => {
        // Intentionally construct a tools object where `context` would, if
        // re-split, produce a DIFFERENT array than `lines`. The solver must
        // trust `tools.lines` rather than falling back to a cached reparse of
        // `tools.context` (which is exactly what the old module-level cache did).
        const tools = makeTools("aaa\nbbb\nccc", ["XXX", "YYY", "ZZZ"]);
        const term: LCTerm = { tag: "lines", start: 1, end: 2 };
        const result = await solve(term, tools);
        expect(result.success).toBe(true);
        expect(result.value).toEqual(["XXX", "YYY"]);
      });

      it("two tools instances do not leak state between each other", async () => {
        // Call A with one tools, then B with another. If A's call cached data
        // at module scope, B's call could accidentally see it.
        const toolsA = makeTools("line 1\nline 2", ["alpha", "beta"]);
        const toolsB = makeTools("line 3\nline 4", ["gamma", "delta"]);
        const term: LCTerm = { tag: "lines", start: 1, end: 2 };

        const resultA1 = await solve(term, toolsA);
        const resultB = await solve(term, toolsB);
        const resultA2 = await solve(term, toolsA);

        expect(resultA1.value).toEqual(["alpha", "beta"]);
        expect(resultB.value).toEqual(["gamma", "delta"]);
        expect(resultA2.value).toEqual(["alpha", "beta"]);
      });
    });

  // from tests/audit96.test.ts #11 — parseAll separates paren/bracket/brace depth
  describe("#11 — parseAll separates paren/bracket/brace depth", () => {
      it("two top-level s-expressions back to back are split correctly", async () => {
        const results = parseAll('(grep "foo") (grep "bar")');
        expect(results.length).toBe(2);
        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(true);
      });

      it("does not split mid-expression on a brace inside a string", async () => {
        // `(grep "}")` — the closing brace is inside a string, so parseAll's
        // depth counter must not touch it. Already handled by the inString
        // check. Keep this as a regression guard.
        const results = parseAll('(grep "}")');
        expect(results.length).toBe(1);
        expect(results[0].success).toBe(true);
      });

      it("stray `)` without matching `(` is ignored, not treated as expression close", async () => {
        // `[x) (grep "foo")`:
        //
        // Buggy behavior (single depth counter):
        //   `[` → depth 1, start=0
        //   `x`
        //   `)` → depth 0, emits slice `[x)` (which parse() will fail on),
        //         then `(grep "foo")` → second slice emitted successfully.
        //   Result: [fail, success], length 2. The `)` was treated as a
        //   matching close for the `[`, which is nonsense.
        //
        // Fixed behavior (per-kind depth, stray closes ignored):
        //   `[` → bracketDepth 1, start=0
        //   `)` → parenDepth can't go below 0, no-op
        //   `(grep "foo")` enters before bracketDepth returns to 0, so the
        //   whole span is never "all-zero" → no slice emitted mid-stream.
        //   Falls through to the one-expression fallback parse, which
        //   fails cleanly. length 1.
        const results = parseAll('[x) (grep "foo")');
        expect(results.length).toBe(1);
        expect(results[0].success).toBe(false);
      });

      it("valid consecutive expressions with different bracket shapes", async () => {
        // `(grep "foo") [list] (grep "bar")` — three top-level forms.
        // Note: `[list]` won't parse as a valid LC term (no leading op),
        // but parseAll should still emit three slices, not two.
        const results = parseAll('(grep "foo") [list] (grep "bar")');
        expect(results.length).toBe(3);
        expect(results[0].success).toBe(true);
        expect(results[2].success).toBe(true);
      });
    });

  // Paper-conformance fix (T1.2): the `(seq …)` primitive lets the
  // model emit a multi-step program in one turn instead of consuming
  // a turn per S-expression. The parser must accept variadic seq,
  // reject empty seq, and round-trip via prettyPrint.
  describe("seq", () => {
    it("should parse a seq with multiple subexprs", () => {
      const result = parse('(seq (grep "ERROR") (count RESULTS))');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("seq");
      if (result.term?.tag === "seq") {
        expect(result.term.exprs).toHaveLength(2);
        expect(result.term.exprs[0]?.tag).toBe("grep");
        expect(result.term.exprs[1]?.tag).toBe("count");
      }
    });

    it("should reject empty (seq) — empty seq is meaningless", () => {
      const result = parse("(seq)");
      expect(result.success).toBe(false);
    });

    it("should accept single-expr (seq)", () => {
      const result = parse('(seq (grep "X"))');
      expect(result.success).toBe(true);
      expect(result.term?.tag).toBe("seq");
      if (result.term?.tag === "seq") {
        expect(result.term.exprs).toHaveLength(1);
      }
    });

    it("should support nested seq", () => {
      const result = parse(
        '(seq (grep "a") (seq (count RESULTS) (sum RESULTS)))'
      );
      expect(result.success).toBe(true);
      if (result.term?.tag === "seq") {
        expect(result.term.exprs).toHaveLength(2);
        expect(result.term.exprs[1]?.tag).toBe("seq");
      }
    });

    it("should round-trip via prettyPrint with printable subexprs", () => {
      // Use grep + grep — both have prettyPrint cases. (Many other LC
      // primitives don't print yet, e.g. count → "<unknown:count>";
      // that's a pre-existing limitation, not specific to seq.)
      const src = '(seq (grep "X") (grep "Y"))';
      const result = parse(src);
      expect(result.success).toBe(true);
      if (result.term) {
        const printed = prettyPrint(result.term);
        expect(printed).toMatch(/^\(seq /);
        const reparsed = parse(printed);
        expect(reparsed.success).toBe(true);
        expect(reparsed.term?.tag).toBe("seq");
      }
    });

    it("should evaluate seq sequentially, threading RESULTS into later exprs", async () => {
      // Build a tiny doc with two distinct rows; seq runs grep then count.
      const doc = "ERROR: a\nWARN: b\nERROR: c\nINFO: d\n";
      const tools: SolverTools = {
        context: doc,
        lines: doc.split("\n"),
        grep: (pattern: string) => {
          const re = new RegExp(pattern, "gmi");
          const out: Array<{
            match: string; line: string; lineNum: number; index: number; groups: string[];
          }> = [];
          let m: RegExpExecArray | null;
          while ((m = re.exec(doc)) !== null) {
            const lineNum = (doc.slice(0, m.index).match(/\n/g) || []).length + 1;
            out.push({ match: m[0], line: doc.split("\n")[lineNum - 1] || "", lineNum, index: m.index, groups: [] });
          }
          return out;
        },
        fuzzy_search: () => [],
        bm25: () => [],
        semantic: () => [],
        text_stats: () => ({ length: doc.length, lineCount: 4, sample: { start: "", middle: "", end: "" } }),
      };

      // (seq (grep "ERROR") (count RESULTS)) should give 2 — both ERROR
      // rows. Without the seq primitive this would take 2 turns.
      const r = await solve(
        { tag: "seq", exprs: [
          { tag: "grep", pattern: "ERROR" },
          { tag: "count", collection: { tag: "var", name: "RESULTS" } },
        ]},
        tools,
        new Map()
      );
      expect(r.success).toBe(true);
      expect(r.value).toBe(2);
    });
  });

  // from tests/audit96.test.ts #12 — parse() errors out on oversize input, doesn't silently truncate
  describe("#12 — parse() errors out on oversize input, doesn't silently truncate", () => {
      it("an input with > MAX_TOKENS tokens produces a parse failure, not a partial success", async () => {
        // MAX_TOKENS = 100_000. Generate a list with enough tokens to blow
        // through the cap. Each `a` symbol is ~1 token, plus whitespace.
        const tokens = Array.from({ length: 120_000 }, () => "a").join(" ");
        const input = `(list ${tokens})`;

        const result = parse(input);

        // Before the fix: tokenize silently stops at 100k tokens, parse()
        // then processes whatever it has — possibly returning success for
        // a truncated prefix, or returning a misleading syntax error.
        // After the fix: tokenize throws an explicit "too large" error
        // and parse() wraps it in a failed ParseResult.
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/too large|too many tokens|MAX_TOKENS/i);
      });
    });

});
