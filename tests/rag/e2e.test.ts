/**
 * End-to-end tests for RAG integration with RLM
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runRLM } from "../../src/rlm.js";
import { getRAGManager } from "../../src/rag/manager.js";
import { createQwenAdapter } from "../../src/adapters/qwen.js";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("RAG E2E Tests", () => {
  let testFile: string;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `rag-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    testFile = join(testDir, "test-data.txt");

    // Create test file with sales data
    await writeFile(testFile, `
# Test Sales Report

Region A Sales:
SALES_DATA_A: $1,000,000
Notes: Good quarter

Region B Sales:
SALES_DATA_B: $2,500,000
Notes: Record sales

Region C Sales:
SALES_DATA_C: $1,500,000
Notes: Steady growth

Total regions: 3
    `.trim());
  });

  afterEach(async () => {
    try {
      await unlink(testFile);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Hint injection", () => {
    it("should inject hints for currency-related queries", async () => {
      const promptsSeen: string[] = [];

      const mockLLM = async (prompt: string) => {
        promptsSeen.push(prompt);

        // First turn: search
        if (promptsSeen.length === 1) {
          return `\`\`\`javascript
const hits = grep("SALES_DATA");
console.log(JSON.stringify(hits, null, 2));
\`\`\``;
        }

        // Second turn: compute
        if (promptsSeen.length === 2) {
          return `\`\`\`javascript
let total = 0;
for (const hit of hits) {
  const match = hit.line.match(/\\$([\\d,]+)/);
  if (match) {
    total += parseFloat(match[1].replace(/,/g, ""));
  }
}
console.log("Total:", total);
\`\`\`
<<<FINAL>>>
Total: $5,000,000
<<<END>>>`;
        }

        return `<<<FINAL>>>Done<<<END>>>`;
      };

      await runRLM("What is the total sales?", testFile, {
        llmClient: mockLLM,
        adapter: createQwenAdapter(),
        ragEnabled: true,
        maxTurns: 5,
      });

      // Verify RAG hints were injected into the system prompt
      expect(promptsSeen[0]).toContain("RELEVANT PATTERNS");
    });

    it("should include pitfall warnings for sum queries", async () => {
      const promptsSeen: string[] = [];

      const mockLLM = async (prompt: string) => {
        promptsSeen.push(prompt);
        return `\`\`\`javascript
console.log("done");
\`\`\`
<<<FINAL>>>Test<<<END>>>`;
      };

      await runRLM("sum up all the dollar values", testFile, {
        llmClient: mockLLM,
        ragEnabled: true,
        maxTurns: 2,
      });

      // Should have hints about currency parsing
      const systemPrompt = promptsSeen[0];
      expect(
        systemPrompt.includes("RELEVANT PATTERNS") ||
        systemPrompt.includes("Suggested Pattern")
      ).toBe(true);
    });
  });

  describe("[object Object] detection", () => {
    // SKIP: [object Object] detection is specific to JavaScript execution
    // LC execution compiles to JS with proper JSON output formatting
    it.skip("should provide feedback when output shows [object Object]", async () => {
      const feedbackSeen: string[] = [];

      let turnCount = 0;
      const mockLLM = async (prompt: string) => {
        turnCount++;

        // Check for feedback about [object Object]
        if (prompt.includes("[object Object]")) {
          feedbackSeen.push(prompt);
        }

        if (turnCount === 1) {
          // First turn: log objects without stringify (common mistake)
          return `\`\`\`javascript
const hits = grep("SALES");
console.log(hits);
\`\`\``;
        }

        if (turnCount === 2) {
          // Should have received feedback about [object Object]
          // Now use JSON.stringify correctly
          return `\`\`\`javascript
console.log(JSON.stringify(hits, null, 2));
\`\`\``;
        }

        return `\`\`\`javascript
console.log("Total: 5000000");
\`\`\`
<<<FINAL>>>
Total: $5,000,000
<<<END>>>`;
      };

      await runRLM("sum sales", testFile, {
        llmClient: mockLLM,
        maxTurns: 5,
        ragEnabled: false,  // Disable to isolate this test
      });

      // Verify feedback was given about [object Object]
      expect(feedbackSeen.length).toBeGreaterThan(0);
      expect(feedbackSeen[0]).toContain("JSON.stringify");
    });

    it("should not accept final answer immediately after [object Object] output", async () => {
      let turnCount = 0;
      let lastResponse = "";

      const mockLLM = async (prompt: string) => {
        turnCount++;

        if (turnCount === 1) {
          // Bad first turn: log objects without stringify AND try to answer
          return `\`\`\`javascript
const hits = grep("SALES");
console.log(hits);
\`\`\`
<<<FINAL>>>
The total is $5,000,000
<<<END>>>`;
        }

        if (turnCount === 2) {
          // Should be asked to continue since previous output was unhelpful
          // Now do it correctly
          return `\`\`\`javascript
let total = 0;
for (const hit of hits) {
  const m = hit.line.match(/\\$([\\d,]+)/);
  if (m) total += parseFloat(m[1].replace(/,/g, ""));
}
console.log("Total:", total);
\`\`\`
<<<FINAL>>>
The total sales are $5,000,000
<<<END>>>`;
        }

        lastResponse = prompt;
        return `<<<FINAL>>>Done<<<END>>>`;
      };

      const result = await runRLM("sum sales", testFile, {
        llmClient: mockLLM,
        maxTurns: 5,
        ragEnabled: false,
      });

      // Should have required at least 2 turns due to [object Object]
      expect(turnCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Self-correction feedback", () => {
    // SKIP: Self-correction is based on JavaScript runtime errors
    // LC execution uses parse-time validation, not runtime error feedback
    it.skip("should record failures and provide self-correction hints", async () => {
      const manager = getRAGManager();
      const sessionId = `test-session-${Date.now()}`;

      // Clear any existing failures for this session
      manager.clearFailureMemory(sessionId);

      let turnCount = 0;
      const promptsSeen: string[] = [];

      const mockLLM = async (prompt: string) => {
        promptsSeen.push(prompt);
        turnCount++;

        if (turnCount === 1) {
          // First turn: code with error
          return `\`\`\`javascript
const x = undefined.length;
\`\`\``;
        }

        if (turnCount === 2) {
          // Second turn: Should have error feedback
          return `\`\`\`javascript
const hits = grep("SALES");
console.log(JSON.stringify(hits, null, 2));
\`\`\``;
        }

        return `\`\`\`javascript
console.log("Total: 5000000");
\`\`\`
<<<FINAL>>>
$5,000,000
<<<END>>>`;
      };

      await runRLM("sum sales", testFile, {
        llmClient: mockLLM,
        maxTurns: 5,
        ragEnabled: true,
        sessionId,
      });

      // Check that an error was encountered
      expect(turnCount).toBeGreaterThanOrEqual(2);

      // The error from turn 1 should have been recorded
      // (Note: session is cleared at the end, so we check the prompts)
      expect(promptsSeen[1]).toContain("Error");
    });
  });

  describe("Hint relevance", () => {
    it("should retrieve aggregation hints for sum queries", async () => {
      const manager = getRAGManager();
      const hints = manager.getHints("sum up the total values", 3);

      expect(hints.length).toBeGreaterThan(0);
      expect(hints.some(h =>
        h.content.toLowerCase().includes("total") ||
        h.content.toLowerCase().includes("sum")
      )).toBe(true);
    });

    it("should retrieve search hints for find queries", async () => {
      const manager = getRAGManager();
      const hints = manager.getHints("find all error messages", 3);

      expect(hints.length).toBeGreaterThan(0);
      expect(hints.some(h => h.content.includes("grep"))).toBe(true);
    });

    it("should retrieve extraction hints for parse queries", async () => {
      const manager = getRAGManager();
      const hints = manager.getHints("extract the date values", 3);

      expect(hints.length).toBeGreaterThan(0);
      expect(hints.some(h =>
        h.content.includes("match") ||
        h.content.includes("extract")
      )).toBe(true);
    });
  });
});

describe("RAG hint formatting", () => {
  it("should format hints with code blocks", () => {
    const manager = getRAGManager();
    const hints = manager.getHints("count items", 2);
    const formatted = manager.formatHintsForPrompt(hints);

    if (hints.length > 0) {
      expect(formatted).toContain("```javascript");
      expect(formatted).toContain("```");
    }
  });

  it("should include rationale in hints", () => {
    const manager = getRAGManager();
    const hints = manager.getHints("sum currency values", 2);
    const formatted = manager.formatHintsForPrompt(hints);

    if (hints.length > 0) {
      expect(formatted).toContain("Why this works");
    }
  });
});
