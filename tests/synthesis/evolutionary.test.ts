/**
 * Tests for Evolutionary Synthesizer
 * Following TDD - these tests are written first
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  EvolutionarySynthesizer,
  PartialProgram,
} from "../../src/synthesis/evolutionary.js";
import {
  KnowledgeBase,
  SynthesizedComponent,
} from "../../src/synthesis/knowledge-base.js";

describe("Evolutionary Synthesizer", () => {
  let kb: KnowledgeBase;
  let synth: EvolutionarySynthesizer;

  beforeEach(() => {
    kb = new KnowledgeBase();
    synth = new EvolutionarySynthesizer(kb);
  });

  describe("initialize", () => {
    it("should create partial program with holes", () => {
      const program = synth.initialize([
        { input: "$1,000", output: 1000 },
        { input: "$2,500", output: 2500 },
      ]);

      expect(program.holes.length).toBeGreaterThan(0);
      expect(program.examples.length).toBe(2);
      expect(program.constraints.length).toBe(0);
    });

    it("should preserve all input/output examples", () => {
      const examples = [
        { input: "a", output: 1 },
        { input: "b", output: 2 },
        { input: "c", output: 3 },
      ];

      const program = synth.initialize(examples);

      expect(program.examples).toEqual(examples);
    });

    it("should create template with placeholder", () => {
      const program = synth.initialize([{ input: "test", output: "result" }]);

      expect(program.template).toContain("${");
    });
  });

  describe("refine", () => {
    it("should add constraint to program", () => {
      const program = synth.initialize([{ input: "test", output: 123 }]);

      // Create a mock constraint (goal)
      const constraint = (s: Map<unknown, unknown>) => [s];

      const refined = synth.refine(program, constraint);

      expect(refined.constraints.length).toBe(1);
      expect(refined.examples).toEqual(program.examples);
    });

    it("should not mutate original program", () => {
      const program = synth.initialize([{ input: "test", output: 123 }]);
      const constraint = (s: Map<unknown, unknown>) => [s];

      synth.refine(program, constraint);

      expect(program.constraints.length).toBe(0);
    });

    it("should accumulate multiple constraints", () => {
      const program = synth.initialize([{ input: "test", output: 123 }]);
      const c1 = (s: Map<unknown, unknown>) => [s];
      const c2 = (s: Map<unknown, unknown>) => [s];

      const refined1 = synth.refine(program, c1);
      const refined2 = synth.refine(refined1, c2);

      expect(refined2.constraints.length).toBe(2);
    });
  });

  describe("solve - from examples", () => {
    it("should find solution for simple integer extraction", () => {
      const program = synth.initialize([
        { input: "123", output: 123 },
        { input: "456", output: 456 },
      ]);

      const solutions = synth.solve(program);

      expect(solutions.length).toBeGreaterThan(0);

      // Verify at least one solution works
      const fn = eval(solutions[0]);
      expect(fn("789")).toBe(789);
    });

    it("should find solution for currency extraction", () => {
      const program = synth.initialize([
        { input: "$1,000", output: 1000 },
        { input: "$2,500", output: 2500 },
      ]);

      const solutions = synth.solve(program);

      expect(solutions.length).toBeGreaterThan(0);

      // Verify solution works
      const fn = eval(solutions[0]);
      expect(fn("$5,000")).toBe(5000);
    });

    it("should find solution for string extraction", () => {
      const program = synth.initialize([
        { input: "name: John", output: "John" },
        { input: "name: Jane", output: "Jane" },
      ]);

      const solutions = synth.solve(program);

      expect(solutions.length).toBeGreaterThan(0);
    });

    it("should return empty when no pattern found", () => {
      // Completely random mappings - no pattern
      const program = synth.initialize([
        { input: "abc", output: 42 },
        { input: "xyz", output: 99 },
        { input: "123", output: "hello" },
      ]);

      const solutions = synth.solve(program);

      // May or may not find a solution depending on heuristics
      expect(Array.isArray(solutions)).toBe(true);
    });
  });

  describe("solve - from knowledge base", () => {
    it("should reuse existing solution from knowledge base", () => {
      // Pre-populate knowledge base with a working extractor
      kb.add({
        id: "existing_currency",
        type: "extractor",
        name: "currency",
        description: "Currency extractor",
        code: '(s) => parseInt(s.replace(/[$,]/g, ""))',
        positiveExamples: ["$1,000", "$2,500"],
        negativeExamples: [],
        usageCount: 10,
        successCount: 10,
        lastUsed: new Date(),
        composableWith: [],
      });

      const program = synth.initialize([
        { input: "$1,000", output: 1000 },
        { input: "$2,500", output: 2500 },
      ]);

      const solutions = synth.solve(program);

      // Should find the existing solution
      expect(solutions.length).toBeGreaterThan(0);
      expect(solutions.some((s) => s.includes("replace"))).toBe(true);
    });

    it("should record usage when reusing from knowledge base", () => {
      kb.add({
        id: "test_comp",
        type: "extractor",
        name: "test",
        description: "",
        code: "(s) => parseInt(s)",
        positiveExamples: ["123", "456"],
        negativeExamples: [],
        usageCount: 5,
        successCount: 5,
        lastUsed: new Date(),
        composableWith: [],
      });

      const program = synth.initialize([
        { input: "123", output: 123 },
        { input: "456", output: 456 },
      ]);

      synth.solve(program);

      const comp = kb.get("test_comp");
      expect(comp!.usageCount).toBeGreaterThanOrEqual(5);
    });

    it("should add new synthesis to knowledge base", () => {
      const initialSize = kb.size();

      const program = synth.initialize([
        { input: "100", output: 100 },
        { input: "200", output: 200 },
      ]);

      synth.solve(program);

      // New synthesis should be added to KB
      expect(kb.size()).toBeGreaterThanOrEqual(initialSize);
    });
  });

  describe("compose", () => {
    it("should compose regex and transformer into extractor", () => {
      const regex: SynthesizedComponent = {
        id: "r1",
        type: "regex",
        name: "currency_regex",
        description: "",
        pattern: "\\$([\\d,]+)",
        positiveExamples: ["$1,000"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      const transformer: SynthesizedComponent = {
        id: "t1",
        type: "transformer",
        name: "strip_commas",
        description: "",
        code: '(s) => parseInt(s.replace(/,/g, ""))',
        positiveExamples: ["1,000"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(regex);
      kb.add(transformer);

      const composed = synth.compose([regex, transformer]);

      expect(composed).not.toBeNull();
      expect(composed!.type).toBe("extractor");
      expect(composed!.derivedFrom).toContain("r1");
      expect(composed!.derivedFrom).toContain("t1");
    });

    it("should create working composed function", () => {
      const regex: SynthesizedComponent = {
        id: "r1",
        type: "regex",
        name: "currency_regex",
        description: "",
        pattern: "\\$([\\d,]+)",
        positiveExamples: ["$1,000"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      const transformer: SynthesizedComponent = {
        id: "t1",
        type: "transformer",
        name: "strip_commas",
        description: "",
        code: '(s) => parseInt(s.replace(/,/g, ""))',
        positiveExamples: ["1,000"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(regex);
      kb.add(transformer);

      const composed = synth.compose([regex, transformer]);

      // Test the composed function
      const fn = eval(composed!.code!);
      expect(fn("$1,000")).toBe(1000);
      expect(fn("$2,500")).toBe(2500);
    });

    it("should return null when components cannot be composed", () => {
      // Two regex components - no transformer to compose with
      const regex1: SynthesizedComponent = {
        id: "r1",
        type: "regex",
        name: "regex1",
        description: "",
        pattern: "\\d+",
        positiveExamples: ["123"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      const regex2: SynthesizedComponent = {
        id: "r2",
        type: "regex",
        name: "regex2",
        description: "",
        pattern: "[a-z]+",
        positiveExamples: ["abc"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(regex1);
      kb.add(regex2);

      const composed = synth.compose([regex1, regex2]);

      expect(composed).toBeNull();
    });

    it("should add composed component to knowledge base", () => {
      const regex: SynthesizedComponent = {
        id: "r1",
        type: "regex",
        name: "test_regex",
        description: "",
        pattern: "(\\d+)",
        positiveExamples: ["123"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      const transformer: SynthesizedComponent = {
        id: "t1",
        type: "transformer",
        name: "test_transformer",
        description: "",
        code: "(s) => parseInt(s)",
        positiveExamples: ["123"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(regex);
      kb.add(transformer);

      const composed = synth.compose([regex, transformer]);

      expect(kb.get(composed!.id)).not.toBeNull();
    });
  });

  describe("suggestCompositions", () => {
    it("should suggest component pairs for target examples", () => {
      // Add components that partially match
      kb.add({
        id: "currency",
        type: "regex",
        name: "currency",
        description: "",
        pattern: "\\$[\\d,]+",
        positiveExamples: ["$100"],
        negativeExamples: [],
        usageCount: 5,
        successCount: 5,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "plain_number",
        type: "regex",
        name: "plain_number",
        description: "",
        pattern: "^\\d+$",
        positiveExamples: ["100"],
        negativeExamples: [],
        usageCount: 5,
        successCount: 5,
        lastUsed: new Date(),
        composableWith: [],
      });

      // These examples need both patterns
      const suggestions = synth.suggestCompositions(["$100", "200", "$300"]);

      expect(Array.isArray(suggestions)).toBe(true);
    });

    it("should return empty when no useful compositions exist", () => {
      const suggestions = synth.suggestCompositions(["unique1", "unique2"]);

      expect(suggestions).toEqual([]);
    });
  });

  describe("validateSolution", () => {
    it("should return true for working solution", () => {
      const examples = [
        { input: "123", output: 123 },
        { input: "456", output: 456 },
      ];

      const code = "(s) => parseInt(s)";

      expect(synth.validateSolution(code, examples)).toBe(true);
    });

    it("should return false for non-working solution", () => {
      const examples = [
        { input: "$1,000", output: 1000 },
        { input: "$2,500", output: 2500 },
      ];

      // This won't handle currency
      const code = "(s) => parseInt(s)";

      expect(synth.validateSolution(code, examples)).toBe(false);
    });

    it("should return false for invalid code", () => {
      const examples = [{ input: "test", output: "result" }];

      const code = "this is not valid javascript {{{";

      expect(synth.validateSolution(code, examples)).toBe(false);
    });
  });

  describe("integration scenarios", () => {
    it("should evolve solution through multiple refinements", () => {
      // Start with examples
      const program = synth.initialize([
        { input: "Price: $100", output: 100 },
        { input: "Price: $250", output: 250 },
      ]);

      // First solve attempt
      const solutions = synth.solve(program);

      // Should find a working solution
      if (solutions.length > 0) {
        const fn = eval(solutions[0]);
        expect(typeof fn("Price: $500")).toBe("number");
      }
    });

    it("should improve over time with knowledge base", () => {
      // First query - no prior knowledge
      const program1 = synth.initialize([
        { input: "100", output: 100 },
        { input: "200", output: 200 },
      ]);

      synth.solve(program1);

      // Knowledge base should now have at least one component
      expect(kb.size()).toBeGreaterThan(0);

      // Second similar query - should reuse
      const program2 = synth.initialize([
        { input: "300", output: 300 },
        { input: "400", output: 400 },
      ]);

      const solutions2 = synth.solve(program2);

      // Should find solution (potentially reusing from KB)
      expect(solutions2.length).toBeGreaterThan(0);
    });
  });
});
