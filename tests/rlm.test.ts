import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runRLM,
  buildSystemPrompt,
  extractCode,
  extractFinalAnswer,
} from "../src/rlm.js";

// Mock the LLM for controlled testing
const mockLLM = vi.fn();

describe("RLM Executor", () => {
  beforeEach(() => {
    mockLLM.mockReset();
  });

  describe("buildSystemPrompt", () => {
    it("should include context length", () => {
      const prompt = buildSystemPrompt(50000, "");
      expect(prompt).toContain("50,000");
    });

    it("should include tool interfaces", () => {
      const interfaces = "function text_stats(): Stats";
      const prompt = buildSystemPrompt(1000, interfaces);
      expect(prompt).toContain("text_stats");
    });

    it("should include memory usage instructions", () => {
      const prompt = buildSystemPrompt(1000, "");
      expect(prompt).toContain("memory");
      expect(prompt).toContain("console.log");
    });

    it("should include FINAL termination instructions", () => {
      const prompt = buildSystemPrompt(1000, "");
      expect(prompt).toContain("<<<FINAL>>>");
      expect(prompt).toContain("<<<END>>>");
      expect(prompt).toContain("FINAL_VAR");
    });

    it("should guide model to use tools for exploration", () => {
      const prompt = buildSystemPrompt(1000000, "");
      // Prompt should guide model to use tools like grep, text_stats rather than raw iteration
      expect(prompt.toLowerCase()).toMatch(/grep|text_stats|fuzzy_search/i);
      expect(prompt.toLowerCase()).toContain("blind");
    });

  });

  describe("extractCode", () => {
    it("should extract TypeScript code blocks", () => {
      const response = "Some text\n```typescript\nconst x = 1;\n```\nMore text";
      const code = extractCode(response);
      expect(code).toBe("const x = 1;");
    });

    it("should return null if no code block", () => {
      const response = "Just plain text";
      const code = extractCode(response);
      expect(code).toBeNull();
    });

    it("should handle multiple code blocks (take first)", () => {
      const response = "```typescript\nfirst\n```\n```typescript\nsecond\n```";
      const code = extractCode(response);
      expect(code).toBe("first");
    });

    it("should handle js/javascript blocks too", () => {
      const response = "```javascript\nconst y = 2;\n```";
      const code = extractCode(response);
      expect(code).toBe("const y = 2;");
    });

    it("should handle ts blocks", () => {
      const response = "```ts\nconst z = 3;\n```";
      const code = extractCode(response);
      expect(code).toBe("const z = 3;");
    });

    it("should handle js blocks", () => {
      const response = "```js\nconst w = 4;\n```";
      const code = extractCode(response);
      expect(code).toBe("const w = 4;");
    });
  });

  describe("extractFinalAnswer", () => {
    it("should extract <<<FINAL>>> delimited answer", () => {
      const response =
        "Some reasoning here\n<<<FINAL>>>\nThe answer is 42\n<<<END>>>";
      const answer = extractFinalAnswer(response);
      expect(answer).toBe("The answer is 42");
    });

    it("should extract FINAL_VAR(variableName)", () => {
      const response = "FINAL_VAR(memory)";
      const answer = extractFinalAnswer(response);
      expect(answer).toEqual({ type: "var", name: "memory" });
    });

    it("should return null if no final marker", () => {
      const response = "Still working...";
      const answer = extractFinalAnswer(response);
      expect(answer).toBeNull();
    });

    it("should handle multiline answers", () => {
      const response = "<<<FINAL>>>\nLine 1\nLine 2\nLine 3\n<<<END>>>";
      const answer = extractFinalAnswer(response);
      expect(answer).toContain("Line 1");
      expect(answer).toContain("Line 2");
    });

    it("should handle quotes in answer without breaking", () => {
      const response =
        '<<<FINAL>>>\nHe said "hello" and she said "goodbye".\n<<<END>>>';
      const answer = extractFinalAnswer(response);
      expect(answer).toContain('"hello"');
      expect(answer).toContain('"goodbye"');
    });

    it("should handle JSON in answer", () => {
      const response =
        '<<<FINAL>>>\n{"key": "value", "nested": {"a": 1}}\n<<<END>>>';
      const answer = extractFinalAnswer(response);
      const parsed = JSON.parse(answer as string);
      expect(parsed.key).toBe("value");
    });

    it("should trim whitespace from answer", () => {
      const response = "<<<FINAL>>>\n   \n  The answer  \n   \n<<<END>>>";
      const answer = extractFinalAnswer(response);
      expect(answer).toBe("The answer");
    });
  });

  describe("runRLM", () => {
    it("should load document and process final answer", async () => {
      // First turn: execute code (required before final answer is accepted)
      mockLLM
        .mockResolvedValueOnce("```javascript\nconsole.log('exploring');\n```")
        .mockResolvedValueOnce("<<<FINAL>>>\ndone\n<<<END>>>");

      const result = await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      expect(result).toBe("done");
    });

    it("should execute code and feed results back", async () => {
      mockLLM
        .mockResolvedValueOnce(
          "```typescript\nconsole.log(context.length);\n```"
        )
        .mockResolvedValueOnce("<<<FINAL>>>\nprocessed\n<<<END>>>");

      const result = await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      expect(mockLLM).toHaveBeenCalledTimes(2);
      expect(result).toBe("processed");
    });

    it("should include sandbox output in history", async () => {
      mockLLM
        .mockResolvedValueOnce(
          "```typescript\nconsole.log(context.length);\n```"
        )
        .mockResolvedValueOnce("<<<FINAL>>>\nprocessed\n<<<END>>>");

      await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      // Second call should include sandbox output
      const secondCall = mockLLM.mock.calls[1][0];
      expect(secondCall).toContain("Sandbox");
    });

    it("should stop at maxTurns", async () => {
      mockLLM.mockResolvedValue('```typescript\nconsole.log("loop");\n```');

      const result = await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 3,
      });

      expect(mockLLM).toHaveBeenCalledTimes(3);
      expect(result).toContain("Max turns");
    });

    it("should handle sandbox errors gracefully", async () => {
      mockLLM
        // Turn 1: Error
        .mockResolvedValueOnce(
          '```typescript\nthrow new Error("test error");\n```'
        )
        // Turn 2: Successful code (clears error state)
        .mockResolvedValueOnce(
          "```javascript\nconsole.log('fixed');\n```"
        )
        // Turn 3: Final answer (accepted after successful code)
        .mockResolvedValueOnce("<<<FINAL>>>\nrecovered\n<<<END>>>");

      const result = await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      expect(result).toBe("recovered");
    });

    it("should feed errors back for self-correction", async () => {
      mockLLM
        // Turn 1: Syntax error
        .mockResolvedValueOnce("```typescript\nconst x = {\n```")
        // Turn 2: Model sees error and fixes
        .mockResolvedValueOnce(
          "```typescript\nconst x = { valid: true };\nconsole.log(x);\n```"
        )
        // Turn 3: Success
        .mockResolvedValueOnce("<<<FINAL>>>\nFixed and completed\n<<<END>>>");

      const result = await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      // Second call should include the syntax error message
      const secondCall = mockLLM.mock.calls[1][0];
      expect(secondCall).toMatch(/error|syntax|unexpected/i);

      // Model should recover
      expect(result).toBe("Fixed and completed");
    });

    it("should include helpful error context for model recovery", async () => {
      mockLLM
        .mockResolvedValueOnce("```typescript\nundefinedVariable.foo()\n```")
        .mockResolvedValueOnce("<<<FINAL>>>\nrecovered\n<<<END>>>");

      await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      const secondCall = mockLLM.mock.calls[1][0];
      // Error message should help model understand what went wrong
      expect(secondCall).toContain("undefinedVariable");
    });

    it("should respect turnTimeoutMs", async () => {
      mockLLM.mockResolvedValueOnce("```typescript\nwhile(true){}\n```");

      const start = Date.now();
      await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 1,
        turnTimeoutMs: 200,
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
    });

    it("should resolve FINAL_VAR from sandbox", async () => {
      mockLLM
        .mockResolvedValueOnce(
          '```typescript\nmemory.push({key: "value"});\n```'
        )
        .mockResolvedValueOnce("FINAL_VAR(memory)");

      const result = await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      expect(result).toEqual([{ key: "value" }]);
    });

    it("should accumulate history across turns", async () => {
      mockLLM
        .mockResolvedValueOnce(
          "```typescript\nconst stats = text_stats();\nconsole.log(stats.lineCount);\n```"
        )
        .mockResolvedValueOnce('```typescript\nmemory.push("found");\n```')
        .mockResolvedValueOnce("<<<FINAL>>>\ndone\n<<<END>>>");

      await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: mockLLM,
        maxTurns: 5,
      });

      // Third call should have full history
      const thirdCall = mockLLM.mock.calls[2][0];
      expect(thirdCall).toContain("Turn"); // Should reference earlier turns
    });

    it("should enforce maxSubCalls per turn", async () => {
      // Create a separate mock for sub-LLM calls
      let subCallCount = 0;
      const trackingLLM = vi.fn().mockImplementation((prompt: string) => {
        // First call is the main RLM turn
        if (prompt.includes("SYSTEM:")) {
          subCallCount = 0;
          return Promise.resolve(`\`\`\`typescript
          // Try to make 100 sub-calls
          for (let i = 0; i < 100; i++) {
            await llm_query("call " + i);
          }
        \`\`\``);
        }
        // Second main call (after error)
        if (prompt.includes("Turn 1 Sandbox")) {
          return Promise.resolve("<<<FINAL>>>\nlimited\n<<<END>>>");
        }
        // Sub-LLM calls
        subCallCount++;
        return Promise.resolve(`sub-response ${subCallCount}`);
      });

      await runRLM("test query", "./test-fixtures/small.txt", {
        llmClient: trackingLLM,
        maxTurns: 5,
        maxSubCalls: 5,
      });

      // Find the call that contains the error message
      const callWithError = trackingLLM.mock.calls.find(
        (call) =>
          call[0] &&
          (call[0].includes("limit") ||
            call[0].includes("exceeded") ||
            call[0].includes("Max"))
      );
      expect(callWithError).toBeDefined();
    });

    it("should handle file read errors", async () => {
      const result = await runRLM("test query", "./nonexistent-file.txt", {
        llmClient: mockLLM,
        maxTurns: 1,
      });

      expect(result).toMatch(/error|not found|ENOENT/i);
      expect(mockLLM).not.toHaveBeenCalled();
    });
  });
});
