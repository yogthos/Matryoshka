/**
 * Tests for code validator - whitelist-based code restriction
 */

import { describe, it, expect } from "vitest";
import { validateCode, formatValidationFeedback } from "../../src/sandbox/code-validator.js";

describe("Code Validator", () => {
  describe("allowed operations", () => {
    it("should allow grep() calls", () => {
      const result = validateCode(`const hits = grep("ERROR");`);
      expect(result.valid).toBe(true);
    });

    it("should allow synthesize_extractor() calls", () => {
      const result = validateCode(`
const extractor = synthesize_extractor([
  { input: "$100", output: 100 },
  { input: "$200", output: 200 }
]);
      `);
      expect(result.valid).toBe(true);
    });

    it("should allow synthesize_regex() calls", () => {
      const result = validateCode(`const pattern = synthesize_regex(["ERROR", "error"]);`);
      expect(result.valid).toBe(true);
    });

    it("should allow console.log()", () => {
      const result = validateCode(`console.log("Found:", hits.length);`);
      expect(result.valid).toBe(true);
    });

    it("should allow JSON.stringify()", () => {
      const result = validateCode(`console.log(JSON.stringify(hits, null, 2));`);
      expect(result.valid).toBe(true);
    });

    it("should allow accessing hit.line property", () => {
      const result = validateCode(`
for (const hit of hits) {
  console.log(hit.line);
}
      `);
      expect(result.valid).toBe(true);
    });

    it("should allow accessing hit.match property", () => {
      const result = validateCode(`
for (const hit of hits) {
  console.log(hit.match);
}
      `);
      expect(result.valid).toBe(true);
    });

    it("should allow basic for loops", () => {
      const result = validateCode(`
let total = 0;
for (const hit of hits) {
  const value = extractor(hit.line);
  if (value !== null) total += value;
}
console.log("Total:", total);
      `);
      expect(result.valid).toBe(true);
    });

    it("should allow memory.push()", () => {
      const result = validateCode(`memory.push({ key: "total", value: 100 });`);
      expect(result.valid).toBe(true);
    });

    it("should allow Math functions", () => {
      const result = validateCode(`const rounded = Math.round(total);`);
      expect(result.valid).toBe(true);
    });

    it("should allow parseInt and parseFloat", () => {
      const result = validateCode(`const num = parseInt("123");`);
      expect(result.valid).toBe(true);
    });
  });

  describe("disallowed operations - string methods", () => {
    it("should reject .match() method calls", () => {
      const result = validateCode(`const m = line.match(/\\d+/);`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".match()");
      expect(result.suggestion).toContain("synthesize_extractor");
    });

    it("should reject .replace() method calls", () => {
      const result = validateCode(`const clean = text.replace(/\\$/g, "");`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".replace()");
    });

    it("should reject .split()[index] pattern", () => {
      const result = validateCode(`const value = line.split(":")[1];`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".split()");
    });

    it("should reject .search() method calls", () => {
      const result = validateCode(`if (line.search(/error/) >= 0) {}`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".search()");
    });

    it("should reject .indexOf() for searching", () => {
      const result = validateCode(`if (line.indexOf("error") !== -1) {}`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".indexOf()");
    });
  });

  describe("disallowed operations - array methods", () => {
    it("should reject .filter() method calls", () => {
      const result = validateCode(`const errors = hits.filter(h => h.line.includes("ERROR"));`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".filter()");
    });

    it("should reject .map() method calls", () => {
      const result = validateCode(`const lines = hits.map(h => h.line);`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".map()");
    });

    it("should reject .reduce() method calls", () => {
      const result = validateCode(`const sum = values.reduce((a, b) => a + b, 0);`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".reduce()");
    });

    it("should reject .find() method calls", () => {
      const result = validateCode(`const first = hits.find(h => h.line.includes("error"));`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".find()");
    });

    it("should reject .some() method calls", () => {
      const result = validateCode(`const hasError = hits.some(h => h.line.includes("error"));`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".some()");
    });

    it("should reject .every() method calls", () => {
      const result = validateCode(`const allMatch = hits.every(h => h.line.includes("ok"));`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".every()");
    });
  });

  describe("disallowed operations - regex", () => {
    it("should reject regex literals", () => {
      const result = validateCode(`const pattern = /\\d+/;`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("regex literal");
      expect(result.suggestion).toContain("synthesize_regex");
    });

    it("should reject regex literals with flags", () => {
      const result = validateCode(`const pattern = /error/gi;`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("regex literal");
    });

    it("should reject new RegExp()", () => {
      const result = validateCode(`const pattern = new RegExp("\\\\d+");`);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("new RegExp()");
    });
  });

  describe("allowed exceptions", () => {
    it("should allow hit.line property access (not method call)", () => {
      const result = validateCode(`console.log(hit.line);`);
      expect(result.valid).toBe(true);
    });

    it("should allow hit.match property access (not method call)", () => {
      const result = validateCode(`console.log(hit.match);`);
      expect(result.valid).toBe(true);
    });

    it("should allow array slicing for preview", () => {
      const result = validateCode(`console.log(JSON.stringify(hits.slice(0, 3), null, 2));`);
      expect(result.valid).toBe(true);
    });
  });

  describe("formatValidationFeedback", () => {
    it("should return empty string for valid code", () => {
      const result = validateCode(`grep("test");`);
      const feedback = formatValidationFeedback(result);
      expect(feedback).toBe("");
    });

    it("should include error and suggestion for invalid code", () => {
      const result = validateCode(`hits.filter(h => h.line.includes("x"));`);
      const feedback = formatValidationFeedback(result);
      expect(feedback).toContain("CODE REJECTED");
      expect(feedback).toContain(".filter()");
      expect(feedback).toContain("CONSTRAINT PROVIDER");
    });
  });

  describe("real-world examples", () => {
    it("should reject the webhook filter example from the bug report", () => {
      const code = `const webhooks = hits.filter(h => h.line.includes("Webhook"));`;
      const result = validateCode(code);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(".filter()");
    });

    it("should allow proper synthesizer usage", () => {
      const code = `
const hits = grep("webhook");
console.log(JSON.stringify(hits.slice(0, 3), null, 2));

const extractor = synthesize_extractor([
  { input: "[13:15:00] ERROR: Webhook delivery failed", output: "failed" },
  { input: "[13:16:00] OK: Webhook delivery succeeded", output: "succeeded" }
]);

if (extractor) {
  let failed = 0;
  for (const hit of hits) {
    const status = extractor(hit.line);
    if (status === "failed") failed++;
  }
  console.log("Failed webhooks:", failed);
}
      `;
      const result = validateCode(code);
      expect(result.valid).toBe(true);
    });
  });
});
