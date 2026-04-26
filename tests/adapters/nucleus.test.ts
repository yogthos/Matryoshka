/**
 * Tests for the Nucleus adapter
 */

import { describe, it, expect } from "vitest";
import { createNucleusAdapter } from "../../src/adapters/nucleus.js";
import { getAdapter, resolveAdapter } from "../../src/adapters/index.js";
import { readFileSync } from "fs";

describe("Nucleus Adapter", () => {
  const adapter = createNucleusAdapter();

  describe("adapter properties", () => {
    it("should have name 'nucleus'", () => {
      expect(adapter.name).toBe("nucleus");
    });

    it("should be registered in the adapter registry", () => {
      const registered = getAdapter("nucleus");
      expect(registered).toBeDefined();
      expect(registered?.name).toBe("nucleus");
    });
  });

  describe("buildSystemPrompt", () => {
    const prompt = adapter.buildSystemPrompt(10000, "");

    it("should explain core operations", () => {
      expect(prompt).toContain("grep");
      expect(prompt).toContain("sum");
      expect(prompt).toContain("count");
    });

    it("should explain available commands", () => {
      expect(prompt).toContain("SEARCH");
      expect(prompt).toContain("grep");
      expect(prompt).toContain("sum");
    });

    it("should be reasonably sized", () => {
      // Prompt should be under 2500 chars for efficiency (includes graph commands)
      expect(prompt.length).toBeLessThan(2500);
    });

    it("should show final answer format", () => {
      expect(prompt).toContain("<<<FINAL>>>");
      expect(prompt).toContain("<<<END>>>");
    });

    // Paper-conformance fixes (T2.x): the prompt must teach (seq …)
    // composition (so the model can run multi-step strategies in one
    // turn) and encourage batching for sub-LLM calls. The "ONE command
    // per turn" framing — which forced 3-step strategies into 3 turns
    // and was the dominant timeout contributor — is gone.
    it("should teach (seq …) for multi-step composition", () => {
      expect(prompt).toContain("(seq");
      expect(prompt).toContain("RESULTS threads through");
    });

    it("should not enforce ONE-command-per-turn", () => {
      // Old framing was literally "ONE command per turn." which
      // discouraged composition. Replaced with guidance that
      // composes via (seq …).
      expect(prompt).not.toMatch(/^ONE command per turn\./m);
    });

    it("should encourage batching of sub-LLM calls", () => {
      // The Qwen variant of the paper prompt explicitly tells the model
      // to batch llm_query rather than fire one per item — we should do
      // the same.
      expect(prompt).toMatch(/BATCH/i);
      expect(prompt).toMatch(/rlm_batch/);
    });
  });

  describe("extractCode", () => {
    it("should extract S-expression from response", () => {
      const response = 'Here is my search:\n(grep "webhook")';
      expect(adapter.extractCode(response)).toBe('(grep "webhook")');
    });

    it("should extract multi-line S-expression", () => {
      const response = `(classify
  "line1" true
  "line2" false)`;
      const extracted = adapter.extractCode(response);
      expect(extracted).toContain("classify");
    });

    it("should extract constrained term", () => {
      const response = '[Σ⚡μ] ⊗ (grep "test")';
      expect(adapter.extractCode(response)).toBe('[Σ⚡μ] ⊗ (grep "test")');
    });

    it("should extract from code block", () => {
      const response = "```lisp\n(grep \"test\")\n```";
      expect(adapter.extractCode(response)).toBe('(grep "test")');
    });

    it("should return null for no S-expression", () => {
      expect(adapter.extractCode("Just text")).toBeNull();
    });

    // JSON-to-S-expression fallback tests
    it("should convert JSON grep to S-expression", () => {
      const response = '```json\n{"action": "grep", "pattern": "webhook"}\n```';
      expect(adapter.extractCode(response)).toBe('(grep "webhook")');
    });

    it("should convert JSON filter to S-expression", () => {
      const response = '{"action": "filter", "collection": "RESULTS", "pattern": "failed"}';
      expect(adapter.extractCode(response)).toBe('(filter RESULTS (lambda x (match x "failed" 0)))');
    });

    it("should convert JSON search to S-expression", () => {
      const response = '{"operation": "search", "query": "error"}';
      expect(adapter.extractCode(response)).toBe('(grep "error")');
    });

    it("should prefer S-expression over JSON when both present", () => {
      const response = '(grep "direct") and also {"action": "grep", "pattern": "json"}';
      expect(adapter.extractCode(response)).toBe('(grep "direct")');
    });
  });

  describe("extractFinalAnswer", () => {
    it("should extract FINAL delimited answer", () => {
      const response = "<<<FINAL>>>\nFound 5 items\n<<<END>>>";
      expect(adapter.extractFinalAnswer(response)).toBe("Found 5 items");
    });

    it("should extract FINAL from inside code block", () => {
      const response = "```plaintext\n<<<FINAL>>>\nThe answer is 42\n```";
      expect(adapter.extractFinalAnswer(response)).toBe("The answer is 42");
    });

    it("should extract FINAL without END marker", () => {
      const response = "Here is my answer:\n<<<FINAL>>>\nFound 3 items\n```";
      expect(adapter.extractFinalAnswer(response)).toBe("Found 3 items");
    });

    // FINAL_VAR marker test removed: legacy marker deleted with the JS-sandbox retirement.

    it("should return null for no final answer", () => {
      expect(adapter.extractFinalAnswer("No answer here")).toBeNull();
    });
  });

  describe("getNoCodeFeedback", () => {
    const feedback = adapter.getNoCodeFeedback();

    it("should show example S-expression", () => {
      expect(feedback).toContain("grep");
      expect(feedback).toContain("(");
      expect(feedback).toContain("Next:");
    });
  });

  describe("getErrorFeedback", () => {
    it("should detect Python-style lambda", () => {
      const feedback = adapter.getErrorFeedback("parse error", '(lambda x: "test" in x)');
      expect(feedback).toContain("syntax");
    });

    it("should show valid commands", () => {
      const feedback = adapter.getErrorFeedback("any error");
      expect(feedback).toContain("grep");
      expect(feedback).toContain("filter");
    });
  });

  describe("getSuccessFeedback", () => {
    it("should show count and next prompt when results exist", () => {
      const feedback = adapter.getSuccessFeedback(5, undefined, "test query");
      expect(feedback).toContain("5");
      expect(feedback).toContain("Next:");
    });

    it("should suggest different terms when results empty", () => {
      const feedback = adapter.getSuccessFeedback(0);
      expect(feedback).toContain("different");
      expect(feedback).toContain("Next:");
    });

    it("should warn when filter matched nothing", () => {
      const feedback = adapter.getSuccessFeedback(0, 10);
      expect(feedback).toContain("Filter");
      expect(feedback).toContain("different");
    });
  });

  describe("getRepeatedCodeFeedback", () => {
    it("should encourage using RESULTS when results exist", () => {
      const feedback = adapter.getRepeatedCodeFeedback(5);
      expect(feedback).toContain("RESULTS");
      expect(feedback).toContain("FINAL");
    });

    it("should suggest different keyword when results empty", () => {
      const feedback = adapter.getRepeatedCodeFeedback(0);
      expect(feedback).toContain("different");
    });

    it("should default to RESULTS guidance with no count", () => {
      const feedback = adapter.getRepeatedCodeFeedback();
      expect(feedback).toContain("RESULTS");
    });
  });
});

// =====================================================================
// Source-pattern checks (from audits)
// =====================================================================
describe("Source-pattern checks (from audits)", () => {
  // from tests/audit21.test.ts Audit21 #1: nucleus jsonToSexp backslash escaping
  describe("Audit21 #1: nucleus jsonToSexp backslash escaping", () => {
    it("should escape backslashes in grep pattern", async () => {
      const { createNucleusAdapter } = await import("../../src/adapters/nucleus.js");
      const adapter = createNucleusAdapter();
      // Model outputs inline JSON with a backslash in the pattern
      // The JSON string "C:\\Users" means the actual pattern is C:\Users
      const response = `{"action": "grep", "pattern": "C:\\\\Users"}`;
      const result = adapter.extractCode(response);
      // The S-expression should properly escape the backslash
      // Expected: (grep "C:\\Users") with the backslash escaped
      expect(result).not.toBeNull();
      if (result) {
        // The embedded string should have the backslash escaped
        expect(result).toContain("\\\\");
      }
    });

    it("should escape backslashes in filter pattern", async () => {
      const { createNucleusAdapter } = await import("../../src/adapters/nucleus.js");
      const adapter = createNucleusAdapter();
      const response = `{"action": "filter", "pattern": "path\\\\file"}`;
      const result = adapter.extractCode(response);
      expect(result).not.toBeNull();
      if (result) {
        expect(result).toContain("\\\\");
      }
    });
  });

  // from tests/audit21.test.ts Audit21 #6: nucleus group index validation
  describe("Audit21 #6: nucleus group index validation", () => {
    it("should clamp negative group index to 0", async () => {
      const { createNucleusAdapter } = await import("../../src/adapters/nucleus.js");
      const adapter = createNucleusAdapter();
      const response = `{"action": "map", "pattern": "\\\\d+", "group": -5}`;
      const result = adapter.extractCode(response);
      if (result) {
        // Should not contain negative group index
        expect(result).not.toMatch(/-\d+\)/);
        expect(result).toContain(" 0)");
      }
    });
  });

  // from tests/audit29.test.ts #2 — nucleus S-expression injection
  describe("#2 — nucleus S-expression injection", () => {
      it("should validate collection name to prevent injection", () => {
        const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
        // The collection variable comes from untrusted LLM JSON
        // After fix, it should be validated against allowed patterns
        // Find the filter case collection assignment
        const filterSection = source.match(/case "filter":[\s\S]*?break;/);
        expect(filterSection).not.toBeNull();
        // Should validate collection is a safe identifier (RESULTS, _\d+, etc.)
        expect(filterSection![0]).toMatch(/test\(collection\)|validat|\/\^/);
      });

      it("should validate collection in map/extract case too", () => {
        const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
        const mapSection = source.match(/case "map":[\s\S]*?break;\s*\}/);
        expect(mapSection).not.toBeNull();
        expect(mapSection![0]).toMatch(/test\(collection\)|validat|\/\^/);
      });
    });

  // from tests/audit34.test.ts #29 — nucleus adapter should not match prose parentheses
  describe("#29 — nucleus adapter should not match prose parentheses", () => {
        it("should prefer S-expression-like patterns over prose", () => {
          const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
          const extractCode = source.match(/extractCode[\s\S]*?return null;\s*\}/);
          expect(extractCode).not.toBeNull();
          // Should check that the matched expression starts with a known command
          // or at least looks like an S-expression
          expect(extractCode![0]).toMatch(/validCommand|knownCommand|isCommand|commandList|COMMANDS|sexp/i);
        });
      });

  // from tests/audit35.test.ts #8 — nucleus adapter should handle nested JSON
  describe("#8 — nucleus adapter should handle nested JSON", () => {
        it("should handle at least 2 levels of JSON nesting", () => {
          const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
          // Should use a balanced brace approach, not a flat regex
          expect(source).toMatch(/extractJson|parseJsonFromResponse|balancedBrace|depth|nesting/i);
        });
      });

  // from tests/audit36.test.ts #4 — nucleus adapter should use centralized escape helper
  describe("#4 — nucleus adapter should use centralized escape helper", () => {
        it("should have escapeForSexp or equivalent centralized escape function", () => {
          const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
          // Should centralize the escape logic to avoid repetition and ensure consistency
          expect(source).toMatch(/escapeForSexp|function.*escape.*Sexp/i);
        });
      });

  // from tests/audit38.test.ts #8 — nucleus extractJson should have length limit
  describe("#8 — nucleus extractJson should have length limit", () => {
      it("should limit processing length", () => {
        const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
        const extractJson = source.match(/const extractJson[\s\S]*?return null;\s*};/);
        expect(extractJson).not.toBeNull();
        // Should have a maximum character limit
        expect(extractJson![0]).toMatch(/MAX_JSON|text\.length\s*>|i\s*-\s*start\s*>/);
      });
    });

  // from tests/audit43.test.ts #6 — nucleus adapter extractCode should be string-aware in paren-balancing
  describe("#6 — nucleus adapter extractCode should be string-aware in paren-balancing", () => {
      it("should track string context in paren-balancing loop", () => {
        const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
        // The KNOWN_COMMANDS paren-balancing loop should have inString tracking
        const parenSection = source.match(/KNOWN_COMMANDS[\s\S]*?while[\s\S]*?depth === 0[\s\S]*?break/);
        expect(parenSection).not.toBeNull();
        expect(parenSection![0]).toMatch(/inString/);
      });
    });

  // from tests/audit49.test.ts #5 — nucleus escapeForSexp should escape control characters
  describe("#5 — nucleus escapeForSexp should escape control characters", () => {
      it("should escape newlines and tabs in S-expression strings", () => {
        const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
        const escapeFn = source.match(/function escapeForSexp[\s\S]*?\n\}/);
        expect(escapeFn).not.toBeNull();
        expect(escapeFn![0]).toMatch(/\\n|\\r|\\t/);
      });
    });

  // from tests/audit50.test.ts #9 — nucleus jsonToSexp should clamp group index
  describe("#9 — nucleus jsonToSexp should clamp group index", () => {
      it("should clamp group to a reasonable maximum", () => {
        const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
        const groupLine = source.match(/obj\.group[\s\S]*?group >= 0[\s\S]*?escapeForSexp/);
        expect(groupLine).not.toBeNull();
        expect(groupLine![0]).toMatch(/Math\.min|group\s*>\s*\d|MAX_GROUP/);
      });
    });

  // from tests/audit51.test.ts #4 — nucleus jsonToSexp fuzzy_search should clamp limit
  describe("#4 — nucleus jsonToSexp fuzzy_search should clamp limit", () => {
      it("should clamp fuzzy_search limit to a safe range", () => {
        const source = readFileSync("src/adapters/nucleus.ts", "utf-8");
        const fuzzyCase = source.match(/case "fuzzy_search"[\s\S]*?break;\s*\}/);
        expect(fuzzyCase).not.toBeNull();
        expect(fuzzyCase![0]).toMatch(/Math\.min|Math\.max|limit\s*>\s*\d|MAX_LIMIT|clamp/);
      });
    });

});
