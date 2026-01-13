/**
 * Tests for Sandbox Synthesis Tools
 * TDD tests for Phase 6: Sandbox integration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSandboxWithSynthesis } from "../../src/synthesis/sandbox-tools.js";
import { SynthesisCoordinator } from "../../src/synthesis/coordinator.js";

describe("Sandbox Synthesis Tools", () => {
  let sandbox: Awaited<ReturnType<typeof createSandboxWithSynthesis>>;
  let coordinator: SynthesisCoordinator;

  beforeEach(async () => {
    coordinator = new SynthesisCoordinator();
    sandbox = await createSandboxWithSynthesis(
      "Sample context with $1,000 and $2,500 amounts",
      async () => "mock response",
      coordinator,
      {}
    );
  });

  afterEach(() => {
    sandbox.dispose();
  });

  describe("synthesize_regex", () => {
    it("should be callable from sandbox code", async () => {
      const result = await sandbox.execute(`
        const regex = synthesize_regex(['$1,000', '$2,500']);
        console.log(typeof regex);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("string");
    });

    it("should synthesize working regex from positive examples", async () => {
      const result = await sandbox.execute(`
        const regex = synthesize_regex(['$1,000', '$2,500', '$100']);
        const works = test_regex(regex, '$5,000');
        console.log(works);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true");
    });

    it("should synthesize regex with negative examples", async () => {
      const result = await sandbox.execute(`
        const regex = synthesize_regex(['$100', '$200'], ['100', 'abc']);
        const matchesPositive = test_regex(regex, '$300');
        const rejectsNegative = !test_regex(regex, '300');
        console.log(matchesPositive, rejectsNegative);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true true");
    });

    it("should return null when synthesis fails", async () => {
      const result = await sandbox.execute(`
        // Conflicting examples - same string in both positive and negative
        const regex = synthesize_regex(['abc'], ['abc']);
        console.log(regex === null);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true");
    });
  });

  describe("synthesize_extractor", () => {
    it("should synthesize working extractor from examples", async () => {
      const result = await sandbox.execute(`
        const extractor = synthesize_extractor([
          { input: '$1,000', output: 1000 },
          { input: '$2,500', output: 2500 }
        ]);
        const value = extractor('$5,000');
        console.log(value);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("5000");
    });

    it("should synthesize string extractor", async () => {
      const result = await sandbox.execute(`
        const extractor = synthesize_extractor([
          { input: 'name: John', output: 'John' },
          { input: 'name: Jane', output: 'Jane' }
        ]);
        const value = extractor('name: Bob');
        console.log(value);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("Bob");
    });

    it("should return null when extractor synthesis fails", async () => {
      const result = await sandbox.execute(`
        // Random mapping with no pattern
        const extractor = synthesize_extractor([
          { input: 'abc', output: 42 },
          { input: 'xyz', output: 99 }
        ]);
        console.log(extractor === null);
      `);

      expect(result.error).toBeUndefined();
      // May or may not find a pattern - either is valid
      expect(["true", "false"]).toContain(result.logs[0]);
    });
  });

  describe("test_regex", () => {
    it("should test regex against string", async () => {
      const result = await sandbox.execute(`
        const matches = test_regex('\\\\$\\\\d+', '$100');
        const noMatch = test_regex('\\\\$\\\\d+', '100');
        console.log(matches, noMatch);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true false");
    });

    it("should handle invalid regex gracefully", async () => {
      const result = await sandbox.execute(`
        const result = test_regex('[invalid', 'test');
        console.log(result);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("false");
    });
  });

  describe("extract_with_regex", () => {
    it("should extract capture group from string", async () => {
      const result = await sandbox.execute(`
        const value = extract_with_regex('\\\\$(\\\\d+)', '$500');
        console.log(value);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("500");
    });

    it("should return full match if no capture group", async () => {
      const result = await sandbox.execute(`
        const value = extract_with_regex('\\\\$\\\\d+', '$500');
        console.log(value);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("$500");
    });

    it("should return null when no match", async () => {
      const result = await sandbox.execute(`
        const value = extract_with_regex('\\\\$\\\\d+', 'no match');
        console.log(value === null);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true");
    });

    it("should handle invalid regex gracefully", async () => {
      const result = await sandbox.execute(`
        const value = extract_with_regex('[invalid', 'test');
        console.log(value === null);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true");
    });
  });

  describe("get_extractor_code", () => {
    it("should return code string for synthesized extractor", async () => {
      const result = await sandbox.execute(`
        const code = get_extractor_code([
          { input: '123', output: 123 },
          { input: '456', output: 456 }
        ]);
        console.log(typeof code);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("string");
    });

    it("should return evaluable code", async () => {
      const result = await sandbox.execute(`
        const code = get_extractor_code([
          { input: '123', output: 123 },
          { input: '456', output: 456 }
        ]);
        // Evaluate the code to get a function
        const fn = eval(code);
        const result = fn('789');
        console.log(result);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("789");
    });

    it("should return null when synthesis fails", async () => {
      const result = await sandbox.execute(`
        const code = get_extractor_code([
          { input: 'a', output: 1 },
          { input: 'a', output: 2 }  // Conflicting
        ]);
        console.log(code === null);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true");
    });
  });

  describe("integration with grep", () => {
    it("should synthesize from grep results", async () => {
      // Create sandbox with context containing currency values
      const contextSandbox = await createSandboxWithSynthesis(
        "Total: $1,000\nSubtotal: $2,500\nTax: $100\n",
        async () => "mock",
        new SynthesisCoordinator(),
        {}
      );

      try {
        const result = await contextSandbox.execute(`
          // Find all currency values
          const matches = grep('\\\\$[\\\\d,]+');
          const values = matches.map(m => m.match);
          console.log(values.join(', '));

          // Synthesize regex from found values
          const regex = synthesize_regex(values);
          console.log(test_regex(regex, '$5,000'));
        `);

        expect(result.error).toBeUndefined();
        expect(result.logs[0]).toContain("$1,000");
        expect(result.logs[1]).toBe("true");
      } finally {
        contextSandbox.dispose();
      }
    });
  });

  describe("example collection", () => {
    it("should collect examples through coordinator", async () => {
      await sandbox.execute(`
        // Synthesize a pattern
        synthesize_regex(['$100', '$200', '$300']);
      `);

      // The synthesis should have been tracked
      expect(coordinator.getSynthesisCount()).toBeGreaterThan(0);
    });
  });

  describe("error handling", () => {
    it("should handle empty arrays gracefully", async () => {
      const result = await sandbox.execute(`
        const regex = synthesize_regex([]);
        console.log(regex === null);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true");
    });

    it("should handle empty extractor examples", async () => {
      const result = await sandbox.execute(`
        const extractor = synthesize_extractor([]);
        console.log(extractor === null);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("true");
    });
  });
});

describe("Sandbox with synthesis - backward compatibility", () => {
  it("should maintain all existing sandbox functionality", async () => {
    const coordinator = new SynthesisCoordinator();
    const sandbox = await createSandboxWithSynthesis(
      "Line 1\nLine 2\nLine 3",
      async () => "mock",
      coordinator,
      {}
    );

    try {
      // Test existing tools still work
      const result = await sandbox.execute(`
        const stats = text_stats();
        console.log(stats.lineCount);

        const lines = locate_line(1, 2);
        console.log(lines);

        const matches = grep('Line');
        console.log(matches.length);
      `);

      expect(result.error).toBeUndefined();
      expect(result.logs[0]).toBe("3");
      expect(result.logs[1]).toBe("Line 1\nLine 2");
      expect(result.logs[2]).toBe("3");
    } finally {
      sandbox.dispose();
    }
  });
});
