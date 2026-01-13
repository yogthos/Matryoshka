/**
 * E2E Tests for Synthesis Integration
 * Demonstrates the full synthesis pipeline working together
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSandboxWithSynthesis } from "../src/synthesis/sandbox-tools.js";
import { SynthesisCoordinator } from "../src/synthesis/coordinator.js";
import { collectExamplesFromResult } from "../src/synthesis/example-collector.js";
import { createQwenSynthesisAdapter } from "../src/adapters/qwen-synthesis.js";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("E2E Synthesis Integration", () => {
  // Load test fixture
  const testFixturePath = resolve(
    process.cwd(),
    "test-fixtures/scattered-data.txt"
  );
  let testContent: string;

  try {
    testContent = readFileSync(testFixturePath, "utf-8");
  } catch {
    // Fall back to inline test data if fixture doesn't exist
    testContent = `
SALES_DATA Q1: $1,000,000
Random noise line
SALES_DATA Q2: $2,500,000
More text here
SALES_DATA Q3: $3,000,000
Header line without data
SALES_DATA Q4: $6,500,000
Final text
`;
  }

  describe("Sandbox with synthesis tools", () => {
    let coordinator: SynthesisCoordinator;
    let sandbox: Awaited<ReturnType<typeof createSandboxWithSynthesis>>;

    beforeEach(async () => {
      coordinator = new SynthesisCoordinator();
      sandbox = await createSandboxWithSynthesis(
        testContent,
        async () => "mock",
        coordinator,
        {}
      );
    });

    afterEach(() => {
      sandbox.dispose();
    });

    it("should complete full workflow: search -> synthesize -> extract", async () => {
      // Complete workflow in a single execution (as LLM would do in one turn)
      const result = await sandbox.execute(`
        // Step 1: Search for data
        const hits = grep("SALES_DATA");
        console.log("Found " + hits.length + " matches");

        // Step 2: Collect examples and synthesize
        const examples = [];
        for (const hit of hits) {
          const m = hit.line.match(/\\$[\\d,]+/);
          if (m) examples.push(m[0]);
        }
        console.log("Examples:", examples.join(", "));

        // Synthesize a regex from examples
        const regex = synthesize_regex(examples, ["SALES_DATA", ":"]);
        console.log("Synthesized regex:", regex);

        // Step 3: Extract all values
        let total = 0;
        for (const hit of hits) {
          const value = extract_with_regex("\\\\$([\\\\d,]+)", hit.line);
          if (value) {
            const num = parseFloat(value.replace(/,/g, ''));
            total += num;
          }
        }
        console.log("Total:", total);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toContain("Found");
      expect(result.logs.some(l => l.includes("$"))).toBe(true);
      expect(result.logs).toContain("Total: 13000000");
    });

    it("should use synthesize_extractor for direct conversion", async () => {
      const result = await sandbox.execute(`
        // Find some example input/output pairs
        const examples = [
          { input: "$1,000,000", output: 1000000 },
          { input: "$2,500,000", output: 2500000 }
        ];

        // Synthesize an extractor
        const extractor = synthesize_extractor(examples);
        console.log("Got extractor:", extractor !== null);

        // Test it
        if (extractor) {
          const val = extractor("$3,000,000");
          console.log("Extracted:", val);
        }
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("Got extractor: true");
      expect(result.logs[1]).toBe("Extracted: 3000000");
    });
  });

  describe("Example collection from execution", () => {
    it("should collect examples from grep results", async () => {
      const coordinator = new SynthesisCoordinator();
      const sandbox = await createSandboxWithSynthesis(
        testContent,
        async () => "mock",
        coordinator,
        {}
      );

      try {
        // Execute code that produces grep-like output
        const result = await sandbox.execute(`
          const hits = grep("SALES_DATA");
          // Simulate JSON log output
          console.log(JSON.stringify(hits));
        `);

        // Collect examples from result
        collectExamplesFromResult(
          { result: null, logs: result.logs },
          'grep("SALES_DATA")',
          coordinator
        );

        // Coordinator should have collected examples
        const grepExamples = coordinator.getExamples("grep_matches");
        expect(grepExamples.length).toBeGreaterThan(0);
      } finally {
        sandbox.dispose();
      }
    });

    it("should collect number conversion examples", async () => {
      const coordinator = new SynthesisCoordinator();

      // Simulate number conversion output
      const logs = [
        "$1,000,000 -> 1000000",
        "$2,500,000 -> 2500000",
        "$3,000,000 -> 3000000",
      ];

      collectExamplesFromResult(
        { result: null, logs },
        "parseFloat(...)",
        coordinator
      );

      const numberExamples = coordinator.getExamples("numbers");
      expect(numberExamples.length).toBe(3);
      expect(numberExamples[0].raw).toBe("$1,000,000");
      expect(numberExamples[0].context).toBe("1000000");
    });
  });

  describe("Adapter with synthesis guidance", () => {
    const adapter = createQwenSynthesisAdapter();

    it("should generate prompt with synthesis tools", () => {
      const prompt = adapter.buildSystemPrompt(testContent.length, "");

      expect(prompt).toContain("synthesize_regex");
      expect(prompt).toContain("synthesize_extractor");
      expect(prompt).toContain("extract_with_regex");
    });

    it("should provide helpful error feedback for regex errors", () => {
      const feedback = adapter.getErrorFeedback(
        "Invalid regular expression: /[/"
      );

      expect(feedback).toContain("synthesize_regex");
      expect(feedback).toContain("REGEX ERROR");
    });

    it("should extract code from response", () => {
      const response = `Let me search for the data:

\`\`\`javascript
const hits = grep("SALES_DATA");
console.log(hits.length);
\`\`\``;

      const code = adapter.extractCode(response);
      expect(code).toContain("grep");
    });

    it("should extract final answer", () => {
      const response = `\`\`\`javascript
console.log("done");
\`\`\`
<<<FINAL>>>
The total sales is $13,000,000.
<<<END>>>`;

      const answer = adapter.extractFinalAnswer(response);
      expect(answer).toContain("$13,000,000");
    });
  });

  describe("Full pipeline simulation", () => {
    it("should simulate multi-turn query resolution", async () => {
      const coordinator = new SynthesisCoordinator();
      const adapter = createQwenSynthesisAdapter();

      const sandbox = await createSandboxWithSynthesis(
        testContent,
        async () => "mock",
        coordinator,
        {}
      );

      try {
        // Simulate Turn 1: LLM searches for data and stores in memory
        const turn1Code = `
          const hits = grep("SALES_DATA");
          memory.push({ hits: hits });  // Store for next turn
          console.log("Found " + hits.length + " hits");
          console.log(JSON.stringify(hits.slice(0, 2), null, 2));
        `;

        const turn1Result = await sandbox.execute(turn1Code);
        expect(turn1Result.error).toBeUndefined();

        // Collect examples
        collectExamplesFromResult(turn1Result, turn1Code, coordinator);

        // Simulate Turn 2: LLM synthesizes and extracts using memory
        const turn2Code = `
          const { hits } = memory[0];  // Retrieve from memory

          const extractor = synthesize_extractor([
            { input: "$1,000,000", output: 1000000 },
            { input: "$2,500,000", output: 2500000 }
          ]);

          let total = 0;
          for (const hit of hits) {
            const val = extractor(hit.line);
            if (typeof val === 'number') {
              total += val;
            }
          }
          console.log("Total:", total);
        `;

        const turn2Result = await sandbox.execute(turn2Code);
        expect(turn2Result.error).toBeUndefined();

        // Verify we got a total
        const totalLog = turn2Result.logs.find((l) => l.startsWith("Total:"));
        expect(totalLog).toBeDefined();

        // Parse the total
        const totalMatch = totalLog?.match(/Total:\s*(\d+)/);
        expect(totalMatch).not.toBeNull();
        const total = parseInt(totalMatch![1], 10);
        expect(total).toBeGreaterThan(0);
      } finally {
        sandbox.dispose();
      }
    });
  });

  describe("Knowledge base reuse", () => {
    it("should reuse patterns across multiple syntheses", () => {
      const coordinator = new SynthesisCoordinator();

      // First synthesis
      const result1 = coordinator.synthesize({
        type: "regex",
        description: "currency",
        positiveExamples: ["$1,000", "$2,500"],
      });

      expect(result1.success).toBe(true);
      const kb = coordinator.getKnowledgeBase();
      const initialSize = kb.size();
      expect(initialSize).toBeGreaterThan(0);

      // Second synthesis with similar examples
      const result2 = coordinator.synthesize({
        type: "regex",
        description: "similar currency",
        positiveExamples: ["$3,000", "$4,500"],
      });

      expect(result2.success).toBe(true);
      // Should reuse or add to knowledge base
      expect(kb.size()).toBeGreaterThanOrEqual(initialSize);
    });
  });

  describe("Evolutionary synthesis", () => {
    it("should compose regex and transformer", async () => {
      const coordinator = new SynthesisCoordinator();
      const sandbox = await createSandboxWithSynthesis(
        testContent,
        async () => "mock",
        coordinator,
        {}
      );

      try {
        // First, synthesize a regex
        const regexResult = await sandbox.execute(`
          const regex = synthesize_regex(["$1,000", "$2,500", "$10,000"]);
          console.log("Regex:", regex);
        `);
        expect(regexResult.error).toBeUndefined();

        // Then, use it to extract and transform
        const extractResult = await sandbox.execute(`
          const hits = grep("SALES_DATA");
          let sum = 0;
          for (const hit of hits) {
            const value = extract_with_regex("\\\\$([\\\\d,]+)", hit.line);
            if (value) {
              sum += parseFloat(value.replace(/,/g, ''));
            }
          }
          console.log("Sum:", sum);
        `);
        expect(extractResult.error).toBeUndefined();
        expect(extractResult.logs[0]).toContain("Sum:");
      } finally {
        sandbox.dispose();
      }
    });
  });
});
