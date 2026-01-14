/**
 * Tests for execution feedback system
 *
 * Note: Manual parsing detection has been moved to the code validator
 * which rejects disallowed operations BEFORE execution.
 * See: tests/sandbox/code-validator.test.ts
 */

import { describe, it, expect } from "vitest";
import { analyzeExecution, getEncouragement } from "../../src/feedback/execution-feedback.js";

describe("Execution Feedback", () => {
  describe("analyzeExecution", () => {
    describe("allowed code patterns", () => {
      it("should NOT flag simple grep usage", () => {
        const result = analyzeExecution({
          code: `const hits = grep("ERROR");
console.log(JSON.stringify(hits, null, 2));`,
          logs: ["Found: 10"],
          turn: 1,
        });
        expect(result).toBeNull();
      });

      it("should NOT flag synthesizer usage", () => {
        const result = analyzeExecution({
          code: `const extractor = synthesize_extractor([{input: "a", output: 1}]);`,
          logs: ["Extractor: SUCCESS"],
          turn: 1,
        });
        expect(result).toBeNull();
      });
    });

    describe("[object Object] detection", () => {
      it("should detect [object Object] in logs", () => {
        const result = analyzeExecution({
          code: `console.log(hits);`,
          logs: ["[object Object]"],
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("object_object");
        expect(result?.message).toContain("JSON.stringify");
      });

      it("should detect [object Object] among other logs", () => {
        const result = analyzeExecution({
          code: `console.log("Found:", hits);`,
          logs: ["Found:", "[object Object],[object Object]"],
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("object_object");
      });
    });

    describe("empty search detection", () => {
      it("should detect zero results from grep", () => {
        const result = analyzeExecution({
          code: `const hits = grep("nonexistent");
console.log("Found:", hits.length);`,
          logs: ["Found: 0"],
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("empty_search");
        expect(result?.message).toContain("different approaches");
      });

      it("should detect 'No matches found'", () => {
        const result = analyzeExecution({
          code: `const hits = grep("test");`,
          logs: ["No matches found"],
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("empty_search");
      });
    });

    describe("synthesis failure detection", () => {
      it("should detect synthesis returning null", () => {
        const result = analyzeExecution({
          code: `const extractor = synthesize_extractor([{input: "a", output: 1}]);
console.log(extractor);`,
          logs: ["null"],
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("synthesis_failed");
        expect(result?.message).toContain("MORE examples");
      });
    });

    describe("gave up early detection", () => {
      it("should detect giving up with just 'done'", () => {
        const result = analyzeExecution({
          code: `console.log("done");`,
          logs: ["done"],
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("gave_up_early");
      });

      it("should detect giving up with 'no results'", () => {
        const result = analyzeExecution({
          code: `console.log("no results");`,
          logs: ["no results"],
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("gave_up_early");
      });

      it("should NOT flag done with multiple logs", () => {
        const result = analyzeExecution({
          code: `console.log("Total: 100");
console.log("done");`,
          logs: ["Total: 100", "done"],
          turn: 1,
        });
        expect(result?.type).not.toBe("gave_up_early");
      });
    });

    describe("execution error handling", () => {
      it("should handle 'is not a function' with extractor", () => {
        const result = analyzeExecution({
          code: `const extractor = synthesize_extractor([]);
const val = extractor("test");`,
          logs: [],
          error: "TypeError: extractor is not a function",
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("synthesis_failed");
      });

      it("should handle undefined property access", () => {
        const result = analyzeExecution({
          code: `console.log(hits[0].line);`,
          logs: [],
          error: "TypeError: Cannot read property 'line' of undefined",
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("execution_error");
        expect(result?.message).toContain("undefined");
      });

      it("should handle string method on object", () => {
        const result = analyzeExecution({
          code: `const m = hit.match(/test/);`,
          logs: [],
          error: "TypeError: hit.match is not a function",
          turn: 1,
        });
        expect(result).not.toBeNull();
        expect(result?.type).toBe("execution_error");
        expect(result?.message).toContain(".line");
      });
    });
  });

  describe("getEncouragement", () => {
    it("should return normal message with many turns left", () => {
      const msg = getEncouragement(1, 10);
      expect(msg).toContain("9 turns remaining");
    });

    it("should return focused message with few turns left", () => {
      const msg = getEncouragement(7, 10);
      expect(msg).toContain("3 turns left");
      expect(msg).toContain("Focus");
    });

    it("should return urgent message with very few turns left", () => {
      const msg = getEncouragement(9, 10);
      expect(msg).toContain("1 turn");
      expect(msg).toContain("best answer");
    });
  });
});
