import { describe, it, expect, vi } from "vitest";
import { runRLM } from "../src/rlm.js";

// These tests can run with mock LLM by default
// Set RUN_E2E=1 to run with real LLM (requires Ollama)
const hasRealLLM = process.env.RUN_E2E === "1";

describe("E2E Integration (Mock)", () => {
  describe("document analysis", () => {
    it("should complete a multi-turn analysis", async () => {
      // Simulate an LLM that explores, then answers
      const mockLLM = vi
        .fn()
        .mockResolvedValueOnce(`Let me first check the document structure.
\`\`\`typescript
const stats = text_stats();
console.log("Document stats:", stats.lineCount, "lines");
\`\`\``)
        .mockResolvedValueOnce(`Now I'll search for relevant content.
\`\`\`typescript
const matches = fuzzy_search("sleep");
memory.push(...matches.slice(0, 3));
console.log("Found", matches.length, "matches");
\`\`\``)
        .mockResolvedValueOnce(`Based on my analysis:
<<<FINAL>>>
The document discusses the science of sleep, including sleep stages and tips for better sleep.
<<<END>>>`);

      const result = await runRLM(
        "What is this document about?",
        "./test-fixtures/short-article.txt",
        {
          llmClient: mockLLM,
          maxTurns: 10,
        }
      );

      expect(result).toContain("sleep");
      expect(mockLLM).toHaveBeenCalledTimes(3);
    });

    it("should handle errors and self-correct", async () => {
      const mockLLM = vi
        .fn()
        // First attempt has an error
        .mockResolvedValueOnce(`\`\`\`typescript
// Typo in function name
const stats = tex_stats();
\`\`\``)
        // LLM sees error and corrects
        .mockResolvedValueOnce(`I see the error. Let me fix that.
\`\`\`typescript
const stats = text_stats();
console.log(stats);
\`\`\``)
        // LLM provides answer
        .mockResolvedValueOnce(`<<<FINAL>>>
The document has been analyzed successfully.
<<<END>>>`);

      const result = await runRLM("Analyze this.", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      expect(result).toContain("analyzed");
      // The error should have been fed back for correction
      expect(mockLLM.mock.calls[1][0]).toMatch(/error|not defined|tex_stats/i);
    });

    // SKIP: Memory buffer is not supported in LC execution
    // LC terms are compiled to JS and don't have access to memory arrays
    it.skip("should use memory buffer for complex queries", async () => {
      const mockLLM = vi
        .fn()
        .mockResolvedValueOnce(`\`\`\`typescript
// Find color mentions
const colors = fuzzy_search("blue");
memory.push({ color: "blue", count: colors.length });
\`\`\``)
        .mockResolvedValueOnce(`\`\`\`typescript
const reds = fuzzy_search("red");
memory.push({ color: "red", count: reds.length });
\`\`\``)
        .mockResolvedValueOnce(`FINAL_VAR(memory)`);

      const result = await runRLM(
        "Count color mentions",
        "./test-fixtures/colors.txt",
        {
          llmClient: mockLLM,
          maxTurns: 10,
        }
      );

      expect(Array.isArray(result)).toBe(true);
      expect((result as unknown[]).length).toBe(2);
    });

    it("should respect maxTurns limit", async () => {
      const mockLLM = vi
        .fn()
        .mockResolvedValue(`\`\`\`typescript
console.log("Still working...");
\`\`\``);

      const result = await runRLM("Never finish", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 3,
      });

      expect(mockLLM).toHaveBeenCalledTimes(3);
      expect(result).toContain("Max turns");
    });
  });

  describe("code analysis", () => {
    it("should analyze TypeScript code", async () => {
      const mockLLM = vi
        .fn()
        .mockResolvedValueOnce(`Let me search for exported functions.
\`\`\`typescript
const exports = fuzzy_search("export function");
memory.push(...exports.map(e => e.line));
console.log("Found exports:", exports.length);
\`\`\``)
        .mockResolvedValueOnce(`<<<FINAL>>>
The file exports 10 functions including: sum, average, max, min, filterByDomain, getPostsByAuthor, getPublishedPosts, formatDisplayName, createUser, and isValidEmail.
<<<END>>>`);

      const result = await runRLM(
        "List the exported functions",
        "./test-fixtures/sample-code.ts",
        {
          llmClient: mockLLM,
          maxTurns: 5,
        }
      );

      expect(result).toContain("sum");
      expect(result).toContain("average");
    });
  });

  describe("fuzzy search usage", () => {
    it("should find approximate matches", async () => {
      const mockLLM = vi
        .fn()
        .mockResolvedValueOnce(`\`\`\`typescript
// Search with typo
const results = fuzzy_search("slep"); // misspelled "sleep"
console.log("Found:", results.length, "results");
memory.push(results[0]);
\`\`\``)
        .mockResolvedValueOnce(`<<<FINAL>>>
Even with the misspelling "slep", I found matches related to sleep.
<<<END>>>`);

      const result = await runRLM(
        "Test fuzzy search",
        "./test-fixtures/short-article.txt",
        {
          llmClient: mockLLM,
          maxTurns: 5,
        }
      );

      expect(result).toContain("sleep");
    });
  });
});

// Real E2E tests that require Ollama
describe.skipIf(!hasRealLLM)("E2E Integration (Real LLM)", () => {
  // Import the real LLM client only when needed
  const getRealLLMClient = async () => {
    const { loadConfig } = await import("../src/config.js");
    const { createLLMClient } = await import("../src/llm/index.js");

    const config = await loadConfig("./config.json");
    return createLLMClient(
      config.llm.provider,
      config.providers[config.llm.provider],
      config.llm
    );
  };

  it(
    "should summarize a document",
    async () => {
      const llmClient = await getRealLLMClient();

      const result = await runRLM(
        "Summarize this document in 2-3 sentences.",
        "./test-fixtures/short-article.txt",
        {
          llmClient,
          maxTurns: 10,
          turnTimeoutMs: 60000,
        }
      );

      expect(typeof result).toBe("string");
      expect((result as string).length).toBeGreaterThan(50);
    },
    120000
  );

  it(
    "should count specific items",
    async () => {
      const llmClient = await getRealLLMClient();

      const result = await runRLM(
        "How many times is the word 'blue' mentioned?",
        "./test-fixtures/colors.txt",
        {
          llmClient,
          maxTurns: 10,
          turnTimeoutMs: 60000,
        }
      );

      expect(result).toBeDefined();
    },
    120000
  );

  it(
    "should analyze code structure",
    async () => {
      const llmClient = await getRealLLMClient();

      const result = await runRLM(
        "What interfaces are defined in this TypeScript file?",
        "./test-fixtures/sample-code.ts",
        {
          llmClient,
          maxTurns: 10,
          turnTimeoutMs: 60000,
        }
      );

      expect((result as string).toLowerCase()).toMatch(/user|post/);
    },
    120000
  );
});
