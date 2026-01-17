/**
 * Tests for handle-based Lattice MCP server
 *
 * These tests verify that the MCP server returns handle stubs
 * instead of full data, achieving 97%+ token savings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Import the handle-based session to test MCP behavior
import { HandleSession } from "../src/engine/handle-session.js";

describe("Lattice MCP Handle-Based Results", () => {
  let session: HandleSession;
  let tempDir: string;
  let testFile: string;

  const testContent = `2024-01-15 10:00:00 ERROR: Connection timeout
2024-01-15 10:01:00 INFO: Retry attempt 1
2024-01-15 10:02:00 ERROR: Connection failed
2024-01-15 10:03:00 INFO: Retry attempt 2
2024-01-15 10:04:00 WARN: High latency detected
2024-01-15 10:05:00 ERROR: Request timeout
2024-01-15 10:06:00 INFO: Connection restored
2024-01-15 10:07:00 DEBUG: Cache hit ratio: 95%`;

  beforeEach(() => {
    session = new HandleSession();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-test-"));
    testFile = path.join(tempDir, "test.log");
    fs.writeFileSync(testFile, testContent);
  });

  afterEach(() => {
    session.close();
    fs.rmSync(tempDir, { recursive: true });
  });

  describe("lattice_load behavior", () => {
    it("should load document and report stats", async () => {
      const stats = await session.loadFile(testFile);

      expect(stats.lineCount).toBe(8);
      expect(stats.size).toBeGreaterThan(0);
    });
  });

  describe("lattice_query returns handle stubs", () => {
    beforeEach(async () => {
      await session.loadFile(testFile);
    });

    it("should return handle stub for array results", () => {
      const result = session.execute('(grep "ERROR")');

      expect(result.success).toBe(true);
      expect(result.handle).toMatch(/^\$res\d+$/);
      expect(result.stub).toBeDefined();
      expect(result.stub).toContain("Array(3)");
      // Full data should NOT be in the result
      expect(result.value).toBeUndefined();
    });

    it("should include preview in stub for context", () => {
      const result = session.execute('(grep "ERROR")');

      // Stub should show preview of first item
      expect(result.stub).toContain("ERROR");
    });

    it("should return scalar values directly", () => {
      session.execute('(grep "ERROR")');
      const result = session.execute("(count RESULTS)");

      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
      expect(result.handle).toBeUndefined();
    });

    it("should track multiple handles", () => {
      session.execute('(grep "ERROR")');
      session.execute('(grep "INFO")');
      session.execute('(grep "WARN")');

      const bindings = session.getBindings();

      expect(bindings["$res1"]).toContain("Array(3)"); // ERRORs
      expect(bindings["$res2"]).toContain("Array(3)"); // INFOs
      expect(bindings["$res3"]).toContain("Array(1)"); // WARNs
    });
  });

  describe("lattice_expand for full data access", () => {
    beforeEach(async () => {
      await session.loadFile(testFile);
    });

    it("should expand handle to full data", () => {
      const query = session.execute('(grep "ERROR")');
      const expanded = session.expand(query.handle!);

      expect(expanded.success).toBe(true);
      expect(expanded.data).toHaveLength(3);
      expect(expanded.total).toBe(3);
    });

    it("should support limit for partial inspection", () => {
      const query = session.execute('(grep "ERROR")');
      const expanded = session.expand(query.handle!, { limit: 2 });

      expect(expanded.data).toHaveLength(2);
      expect(expanded.total).toBe(3);
    });

    it("should support pagination with offset", () => {
      const query = session.execute('(grep "ERROR")');

      const page1 = session.expand(query.handle!, { offset: 0, limit: 2 });
      const page2 = session.expand(query.handle!, { offset: 2, limit: 2 });

      expect(page1.data).toHaveLength(2);
      expect(page2.data).toHaveLength(1);
    });

    it("should format as lines for readable output", () => {
      const query = session.execute('(grep "ERROR")');
      const expanded = session.expand(query.handle!, { format: "lines" });

      expect(expanded.data![0]).toMatch(/^\[\d+\]/);
      expect(expanded.data![0]).toContain("ERROR");
    });
  });

  describe("REPL-style chaining with handles", () => {
    beforeEach(async () => {
      await session.loadFile(testFile);
    });

    it("should chain operations, getting handles at each step", () => {
      // Step 1: grep for errors
      const step1 = session.execute('(grep "ERROR")');
      expect(step1.handle).toBeDefined();
      expect(step1.stub).toContain("Array(3)");

      // Step 2: filter for timeouts
      const step2 = session.execute('(filter RESULTS (lambda x (match x "timeout" 0)))');
      expect(step2.handle).toBeDefined();
      expect(step2.stub).toContain("Array(2)"); // "Connection timeout" and "Request timeout"

      // Step 3: count results (scalar, no handle)
      const step3 = session.execute("(count RESULTS)");
      expect(step3.value).toBe(2);
      expect(step3.handle).toBeUndefined();

      // Can still access earlier handles
      const expanded1 = session.expand(step1.handle!);
      expect(expanded1.total).toBe(3);

      const expanded2 = session.expand(step2.handle!);
      expect(expanded2.total).toBe(2);
    });

    it("should allow inspecting intermediate results when needed", () => {
      // Initial grep
      session.execute('(grep "2024")');

      // Get bindings to see what we have
      const bindings = session.getBindings();
      expect(bindings["RESULTS"]).toContain("$res1");

      // Preview to see first few items
      const preview = session.preview("$res1", 3);
      expect(preview).toHaveLength(3);

      // Now filter based on what we saw
      const filtered = session.execute('(filter RESULTS (lambda x (match x "ERROR" 0)))');

      // Expand to see full filtered results
      const expanded = session.expand(filtered.handle!);
      expect(expanded.data).toHaveLength(3);
    });
  });

  describe("Token savings verification", () => {
    it("should achieve 95%+ token savings on large results", async () => {
      // Create a larger test file
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(`2024-01-15 ${String(i).padStart(6, "0")} LOG: Entry number ${i} with data value=${i * 100}`);
      }
      const largeFile = path.join(tempDir, "large.log");
      fs.writeFileSync(largeFile, lines.join("\n"));

      const largeSession = new HandleSession();
      await largeSession.loadFile(largeFile);

      // Query that returns many results
      const result = largeSession.execute('(grep "LOG")');

      // Handle stub should be compact
      const stubSize = result.stub!.length;
      expect(stubSize).toBeLessThan(100);

      // Full data is much larger
      const expanded = largeSession.expand(result.handle!);
      const fullDataSize = JSON.stringify(expanded.data).length;

      // Calculate token savings (approximate: 4 chars per token)
      const stubTokens = Math.ceil(stubSize / 4);
      const fullTokens = Math.ceil(fullDataSize / 4);
      const savings = ((fullTokens - stubTokens) / fullTokens) * 100;

      expect(savings).toBeGreaterThan(95);

      largeSession.close();
    });
  });

  describe("Error handling", () => {
    beforeEach(async () => {
      await session.loadFile(testFile);
    });

    it("should return error for invalid handle expand", () => {
      const result = session.expand("$invalid");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid handle");
    });

    it("should return error for query without document", () => {
      const emptySession = new HandleSession();
      const result = emptySession.execute('(grep "test")');

      expect(result.success).toBe(false);
      expect(result.error).toContain("No document loaded");

      emptySession.close();
    });
  });
});
