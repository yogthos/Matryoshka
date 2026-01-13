/**
 * Tests for Example Collector
 * Automatically extracts examples from sandbox execution results
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  collectExamplesFromResult,
  extractGrepResults,
  extractNumberExamples,
  extractKeyValueExamples,
  parseLogLine,
} from "../../src/synthesis/example-collector.js";
import { SynthesisCoordinator } from "../../src/synthesis/coordinator.js";

describe("Example Collector", () => {
  describe("extractGrepResults", () => {
    it("should extract grep results from JSON log format", () => {
      const logs = ['[{"match":"$1,000","line":"Total: $1,000","lineNum":5}]'];

      const results = extractGrepResults(logs);

      expect(results).toHaveLength(1);
      expect(results[0].match).toBe("$1,000");
      expect(results[0].line).toBe("Total: $1,000");
      expect(results[0].lineNum).toBe(5);
    });

    it("should extract multiple grep results", () => {
      const logs = [
        '[{"match":"$1,000","line":"Total: $1,000","lineNum":5},{"match":"$2,000","line":"Total: $2,000","lineNum":10}]',
      ];

      const results = extractGrepResults(logs);

      expect(results).toHaveLength(2);
      expect(results[0].match).toBe("$1,000");
      expect(results[1].match).toBe("$2,000");
    });

    it("should handle non-JSON logs gracefully", () => {
      const logs = ["not json", "also not json"];

      const results = extractGrepResults(logs);

      expect(results).toEqual([]);
    });

    it("should handle empty logs", () => {
      const results = extractGrepResults([]);

      expect(results).toEqual([]);
    });

    it("should extract from mixed log lines", () => {
      const logs = [
        "Starting grep...",
        '[{"match":"test","line":"test line","lineNum":1}]',
        "Done.",
      ];

      const results = extractGrepResults(logs);

      expect(results).toHaveLength(1);
      expect(results[0].match).toBe("test");
    });
  });

  describe("extractNumberExamples", () => {
    it("should extract number conversion examples", () => {
      const logs = ["$2,340,000 -> 2340000", "$1,500,000 -> 1500000"];

      const results = extractNumberExamples(logs);

      expect(results).toHaveLength(2);
      expect(results[0].raw).toBe("$2,340,000");
      expect(results[0].parsed).toBe(2340000);
    });

    it("should extract decimal number conversions", () => {
      const logs = ["$99.99 -> 99.99", "$1,234.56 -> 1234.56"];

      const results = extractNumberExamples(logs);

      expect(results).toHaveLength(2);
      expect(results[0].raw).toBe("$99.99");
      expect(results[0].parsed).toBeCloseTo(99.99);
    });

    it("should ignore non-conversion logs", () => {
      const logs = ["Starting...", "Processing file", "Done."];

      const results = extractNumberExamples(logs);

      expect(results).toEqual([]);
    });

    it("should handle percentage conversions", () => {
      const logs = ["50% -> 0.5", "100% -> 1"];

      const results = extractNumberExamples(logs);

      expect(results).toHaveLength(2);
      expect(results[0].raw).toBe("50%");
      expect(results[0].parsed).toBeCloseTo(0.5);
    });
  });

  describe("extractKeyValueExamples", () => {
    it("should extract key:value pairs", () => {
      const logs = ["name: John", "city: NYC", "age: 30"];

      const results = extractKeyValueExamples(logs);

      expect(results).toHaveLength(3);
      expect(results[0].key).toBe("name");
      expect(results[0].value).toBe("John");
    });

    it("should handle key=value format", () => {
      const logs = ["name=John", "city=NYC"];

      const results = extractKeyValueExamples(logs);

      expect(results).toHaveLength(2);
      expect(results[0].key).toBe("name");
      expect(results[0].value).toBe("John");
    });

    it("should trim whitespace from values", () => {
      const logs = ["name:   John   ", "city:NYC"];

      const results = extractKeyValueExamples(logs);

      expect(results[0].value).toBe("John");
      expect(results[1].value).toBe("NYC");
    });

    it("should ignore lines without key-value pattern", () => {
      const logs = ["Just some text", "No equals or colon here"];

      const results = extractKeyValueExamples(logs);

      expect(results).toEqual([]);
    });
  });

  describe("parseLogLine", () => {
    it("should parse log lines with timestamps", () => {
      const line = "[2024-01-15 10:30:45] ERROR: Connection failed";

      const parsed = parseLogLine(line);

      expect(parsed.timestamp).toBe("2024-01-15 10:30:45");
      expect(parsed.level).toBe("ERROR");
      expect(parsed.message).toBe("Connection failed");
    });

    it("should parse log lines without timestamps", () => {
      const line = "ERROR: Connection failed";

      const parsed = parseLogLine(line);

      expect(parsed.timestamp).toBeUndefined();
      expect(parsed.level).toBe("ERROR");
      expect(parsed.message).toBe("Connection failed");
    });

    it("should parse INFO level logs", () => {
      const line = "[2024-01-15] INFO: Server started";

      const parsed = parseLogLine(line);

      expect(parsed.level).toBe("INFO");
      expect(parsed.message).toBe("Server started");
    });

    it("should parse WARN level logs", () => {
      const line = "WARN: Low memory";

      const parsed = parseLogLine(line);

      expect(parsed.level).toBe("WARN");
      expect(parsed.message).toBe("Low memory");
    });

    it("should return undefined for unrecognized format", () => {
      const line = "Just some text without a log format";

      const parsed = parseLogLine(line);

      expect(parsed.level).toBeUndefined();
    });
  });

  describe("collectExamplesFromResult", () => {
    let coordinator: SynthesisCoordinator;

    beforeEach(() => {
      coordinator = new SynthesisCoordinator();
    });

    it("should collect grep results when code contains grep", () => {
      const result = {
        result: null,
        logs: ['[{"match":"$1,000","line":"Total: $1,000","lineNum":5}]'],
      };

      collectExamplesFromResult(result, 'grep("\\$")', coordinator);

      const examples = coordinator.getExamples("grep_matches");
      expect(examples).toHaveLength(1);
      expect(examples[0].raw).toBe("$1,000");
      expect(examples[0].source).toBe("grep");
    });

    it("should collect number conversion examples", () => {
      const result = {
        result: null,
        logs: ["$2,340,000 -> 2340000", "$1,500,000 -> 1500000"],
      };

      collectExamplesFromResult(result, "parseFloat(...)", coordinator);

      const examples = coordinator.getExamples("numbers");
      expect(examples).toHaveLength(2);
    });

    it("should collect key-value examples", () => {
      const result = {
        result: null,
        logs: ["name: John", "city: NYC"],
      };

      collectExamplesFromResult(result, "readLine()", coordinator);

      const examples = coordinator.getExamples("key_values");
      expect(examples).toHaveLength(2);
    });

    it("should handle empty logs", () => {
      const result = {
        result: null,
        logs: [],
      };

      collectExamplesFromResult(result, "someCode()", coordinator);

      expect(coordinator.getExamples("grep_matches")).toEqual([]);
      expect(coordinator.getExamples("numbers")).toEqual([]);
    });

    it("should handle result with error", () => {
      const result = {
        result: null,
        logs: ["Error: something went wrong"],
        error: "Runtime error",
      };

      // Should not throw
      expect(() =>
        collectExamplesFromResult(result, "someCode()", coordinator)
      ).not.toThrow();
    });

    it("should collect log level examples", () => {
      const result = {
        result: null,
        logs: [
          "[2024-01-15] ERROR: Connection failed",
          "[2024-01-15] INFO: Retrying...",
          "[2024-01-15] WARN: High latency",
        ],
      };

      collectExamplesFromResult(result, 'grep("ERROR|INFO|WARN")', coordinator);

      const examples = coordinator.getExamples("log_levels");
      expect(examples).toHaveLength(3);
    });
  });
});
