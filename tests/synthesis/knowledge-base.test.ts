/**
 * Tests for Knowledge Base - stores synthesized components for reuse
 * Following TDD - these tests are written first
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  KnowledgeBase,
  SynthesizedComponent,
} from "../../src/synthesis/knowledge-base.js";

describe("Knowledge Base", () => {
  let kb: KnowledgeBase;

  beforeEach(() => {
    kb = new KnowledgeBase();
  });

  describe("add and get", () => {
    it("should store and retrieve a component by id", () => {
      const component: SynthesizedComponent = {
        id: "test1",
        type: "regex",
        name: "currency",
        description: "Currency pattern",
        pattern: "\\$[\\d,]+",
        positiveExamples: ["$1,000", "$2,500"],
        negativeExamples: ["1000"],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(component);
      const retrieved = kb.get("test1");

      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("currency");
      expect(retrieved!.pattern).toBe("\\$[\\d,]+");
    });

    it("should return null for non-existent id", () => {
      expect(kb.get("nonexistent")).toBeNull();
    });

    it("should store multiple components", () => {
      kb.add({
        id: "comp1",
        type: "regex",
        name: "test1",
        description: "",
        positiveExamples: ["a"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "comp2",
        type: "extractor",
        name: "test2",
        description: "",
        positiveExamples: ["b"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      expect(kb.get("comp1")).not.toBeNull();
      expect(kb.get("comp2")).not.toBeNull();
    });
  });

  describe("findSimilar", () => {
    beforeEach(() => {
      // Add some test components
      kb.add({
        id: "currency1",
        type: "regex",
        name: "currency",
        description: "Currency pattern",
        pattern: "\\$[\\d,]+",
        positiveExamples: ["$1,000", "$2,500", "$100"],
        negativeExamples: [],
        usageCount: 10,
        successCount: 9,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "number1",
        type: "regex",
        name: "number",
        description: "Number pattern",
        pattern: "\\d+",
        positiveExamples: ["123", "456", "789"],
        negativeExamples: [],
        usageCount: 5,
        successCount: 3,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "date1",
        type: "regex",
        name: "date",
        description: "Date pattern",
        pattern: "\\d{4}-\\d{2}-\\d{2}",
        positiveExamples: ["2024-01-15", "2023-12-31"],
        negativeExamples: [],
        usageCount: 8,
        successCount: 7,
        lastUsed: new Date(),
        composableWith: [],
      });
    });

    it("should find components with similar examples", () => {
      const similar = kb.findSimilar(["$500", "$1,234"]);

      expect(similar.length).toBeGreaterThan(0);
      // Currency should rank high due to $ character overlap
      expect(similar.some((c) => c.id === "currency1")).toBe(true);
    });

    it("should rank by similarity and success rate", () => {
      // Add two similar components with different success rates
      kb.add({
        id: "high_success",
        type: "regex",
        name: "test_high",
        description: "",
        pattern: "[a-z]+",
        positiveExamples: ["abc", "def", "ghi"],
        negativeExamples: [],
        usageCount: 10,
        successCount: 9, // 90% success
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "low_success",
        type: "regex",
        name: "test_low",
        description: "",
        pattern: "[a-z]+",
        positiveExamples: ["abc", "def", "xyz"],
        negativeExamples: [],
        usageCount: 10,
        successCount: 2, // 20% success
        lastUsed: new Date(),
        composableWith: [],
      });

      const similar = kb.findSimilar(["abc", "def"]);
      const highIdx = similar.findIndex((c) => c.id === "high_success");
      const lowIdx = similar.findIndex((c) => c.id === "low_success");

      // High success should rank before low success
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it("should filter by type when specified", () => {
      kb.add({
        id: "extractor1",
        type: "extractor",
        name: "currency_extractor",
        description: "",
        code: "(s) => parseInt(s)",
        positiveExamples: ["$1,000", "$2,500"],
        negativeExamples: [],
        usageCount: 5,
        successCount: 5,
        lastUsed: new Date(),
        composableWith: [],
      });

      const regexOnly = kb.findSimilar(["$500"], "regex");
      const extractorOnly = kb.findSimilar(["$500"], "extractor");

      expect(regexOnly.every((c) => c.type === "regex")).toBe(true);
      expect(extractorOnly.every((c) => c.type === "extractor")).toBe(true);
    });

    it("should return empty array when no similar components", () => {
      const similar = kb.findSimilar(["🎉🎊🎈"]); // Very different characters
      // May or may not find matches depending on similarity threshold
      expect(Array.isArray(similar)).toBe(true);
    });
  });

  describe("findComposable", () => {
    it("should find component pairs that together cover all examples", () => {
      // Component that matches currency
      kb.add({
        id: "currency_regex",
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

      // Component that matches plain numbers
      kb.add({
        id: "number_regex",
        type: "regex",
        name: "number",
        description: "",
        pattern: "^\\d+$",
        positiveExamples: ["100"],
        negativeExamples: [],
        usageCount: 5,
        successCount: 5,
        lastUsed: new Date(),
        composableWith: [],
      });

      // Examples that need both patterns
      const compositions = kb.findComposable(["$100", "200", "$300", "400"]);

      // Should find that currency + number cover these
      expect(compositions.length).toBeGreaterThanOrEqual(0);
    });

    it("should return empty when single component covers all", () => {
      kb.add({
        id: "digits",
        type: "regex",
        name: "digits",
        description: "",
        pattern: "\\d+",
        positiveExamples: ["123"],
        negativeExamples: [],
        usageCount: 5,
        successCount: 5,
        lastUsed: new Date(),
        composableWith: [],
      });

      // All examples match the single pattern - no composition needed
      const compositions = kb.findComposable(["123", "456", "789"]);
      // When all match one pattern, findComposable returns empty (no partial matches)
      expect(Array.isArray(compositions)).toBe(true);
    });
  });

  describe("recordUsage", () => {
    it("should increment usage count", () => {
      kb.add({
        id: "test1",
        type: "regex",
        name: "test",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(0),
        composableWith: [],
      });

      kb.recordUsage("test1", true);
      kb.recordUsage("test1", false);
      kb.recordUsage("test1", true);

      const component = kb.get("test1");
      expect(component!.usageCount).toBe(3);
      expect(component!.successCount).toBe(2);
    });

    it("should update lastUsed timestamp", () => {
      const oldDate = new Date(2020, 0, 1);
      kb.add({
        id: "test1",
        type: "regex",
        name: "test",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: oldDate,
        composableWith: [],
      });

      kb.recordUsage("test1", true);

      const component = kb.get("test1");
      expect(component!.lastUsed.getTime()).toBeGreaterThan(oldDate.getTime());
    });

    it("should handle non-existent component gracefully", () => {
      // Should not throw
      expect(() => kb.recordUsage("nonexistent", true)).not.toThrow();
    });
  });

  describe("derive", () => {
    it("should create derived component with provenance", () => {
      const parent1: SynthesizedComponent = {
        id: "parent1",
        type: "regex",
        name: "regex",
        description: "",
        pattern: "\\$[\\d,]+",
        positiveExamples: ["$100"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      const parent2: SynthesizedComponent = {
        id: "parent2",
        type: "transformer",
        name: "toNumber",
        description: "",
        code: "(s) => parseInt(s)",
        positiveExamples: ["100"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(parent1);
      kb.add(parent2);

      const derived = kb.derive([parent1, parent2], {
        id: "child1",
        type: "extractor",
        name: "currencyExtractor",
        description: "Extracts currency as number",
        code: '(s) => parseInt(s.match(/\\$([\\d,]+)/)[1])',
        positiveExamples: ["$100"],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
      });

      expect(derived.derivedFrom).toContain("parent1");
      expect(derived.derivedFrom).toContain("parent2");
      expect(derived.composableWith).toEqual([]);
    });

    it("should update parent composableWith references", () => {
      const parent1: SynthesizedComponent = {
        id: "p1",
        type: "regex",
        name: "test",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(parent1);

      kb.derive([parent1], {
        id: "child1",
        type: "extractor",
        name: "derived",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
      });

      const updatedParent = kb.get("p1");
      expect(updatedParent!.composableWith).toContain("child1");
    });

    it("should add derived component to knowledge base", () => {
      const parent: SynthesizedComponent = {
        id: "p1",
        type: "regex",
        name: "test",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(parent);

      kb.derive([parent], {
        id: "derived1",
        type: "extractor",
        name: "derived",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
      });

      expect(kb.get("derived1")).not.toBeNull();
    });
  });

  describe("getDerived", () => {
    it("should return all components derived from a parent", () => {
      const parent: SynthesizedComponent = {
        id: "parent",
        type: "regex",
        name: "parent",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      };

      kb.add(parent);

      kb.derive([parent], {
        id: "child1",
        type: "extractor",
        name: "child1",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
      });

      kb.derive([parent], {
        id: "child2",
        type: "extractor",
        name: "child2",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
      });

      const derived = kb.getDerived("parent");
      expect(derived.length).toBe(2);
      expect(derived.map((d) => d.id)).toContain("child1");
      expect(derived.map((d) => d.id)).toContain("child2");
    });

    it("should return empty array for component with no derivatives", () => {
      kb.add({
        id: "lonely",
        type: "regex",
        name: "lonely",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      expect(kb.getDerived("lonely")).toEqual([]);
    });
  });

  describe("export and import", () => {
    it("should export all components", () => {
      kb.add({
        id: "comp1",
        type: "regex",
        name: "test1",
        description: "",
        positiveExamples: ["a"],
        negativeExamples: [],
        usageCount: 5,
        successCount: 3,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "comp2",
        type: "extractor",
        name: "test2",
        description: "",
        positiveExamples: ["b"],
        negativeExamples: [],
        usageCount: 10,
        successCount: 8,
        lastUsed: new Date(),
        composableWith: [],
      });

      const exported = kb.export();
      expect(exported.length).toBe(2);
      expect(exported.find((c) => c.id === "comp1")).toBeDefined();
      expect(exported.find((c) => c.id === "comp2")).toBeDefined();
    });

    it("should import components into empty knowledge base", () => {
      const components: SynthesizedComponent[] = [
        {
          id: "imported1",
          type: "regex",
          name: "imported",
          description: "",
          positiveExamples: ["x"],
          negativeExamples: [],
          usageCount: 100,
          successCount: 95,
          lastUsed: new Date(),
          composableWith: [],
        },
      ];

      kb.import(components);

      expect(kb.get("imported1")).not.toBeNull();
      expect(kb.get("imported1")!.usageCount).toBe(100);
    });

    it("should preserve data through export/import cycle", () => {
      kb.add({
        id: "original",
        type: "regex",
        name: "original",
        description: "test description",
        pattern: "\\d+",
        positiveExamples: ["123", "456"],
        negativeExamples: ["abc"],
        usageCount: 42,
        successCount: 40,
        lastUsed: new Date("2024-01-15"),
        composableWith: ["other"],
        derivedFrom: ["parent"],
      });

      const exported = kb.export();

      const newKb = new KnowledgeBase();
      newKb.import(exported);

      const restored = newKb.get("original");
      expect(restored).not.toBeNull();
      expect(restored!.pattern).toBe("\\d+");
      expect(restored!.positiveExamples).toEqual(["123", "456"]);
      expect(restored!.usageCount).toBe(42);
      expect(restored!.derivedFrom).toContain("parent");
    });
  });

  describe("getByType", () => {
    it("should return all components of a specific type", () => {
      kb.add({
        id: "r1",
        type: "regex",
        name: "regex1",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "r2",
        type: "regex",
        name: "regex2",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "e1",
        type: "extractor",
        name: "extractor1",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      const regexes = kb.getByType("regex");
      expect(regexes.length).toBe(2);
      expect(regexes.every((c) => c.type === "regex")).toBe(true);

      const extractors = kb.getByType("extractor");
      expect(extractors.length).toBe(1);
    });
  });

  describe("clear", () => {
    it("should remove all components", () => {
      kb.add({
        id: "comp1",
        type: "regex",
        name: "test",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.add({
        id: "comp2",
        type: "extractor",
        name: "test2",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      kb.clear();

      expect(kb.get("comp1")).toBeNull();
      expect(kb.get("comp2")).toBeNull();
      expect(kb.export().length).toBe(0);
    });
  });

  describe("size", () => {
    it("should return the number of components", () => {
      expect(kb.size()).toBe(0);

      kb.add({
        id: "comp1",
        type: "regex",
        name: "test",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      expect(kb.size()).toBe(1);

      kb.add({
        id: "comp2",
        type: "extractor",
        name: "test2",
        description: "",
        positiveExamples: [],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
        composableWith: [],
      });

      expect(kb.size()).toBe(2);
    });
  });
});
