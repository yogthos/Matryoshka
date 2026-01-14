/**
 * Integration tests for diverse document analysis scenarios
 *
 * These tests verify the RLM can adapt to different data formats
 * and problem domains at runtime.
 */

import { describe, it, expect, vi } from "vitest";
import { parse } from "../../src/logic/lc-parser.js";
import { solve, type SolverTools, type Bindings } from "../../src/logic/lc-solver.js";

// Helper to create mock tools from document content
function createMockTools(context: string): SolverTools {
  const lines = context.split("\n");
  return {
    context,
    grep: (pattern: string) => {
      // Handle special regex chars that should be escaped
      const specialChars = /^[\$\.\^\*\+\?\[\]\(\)\{\}\|\\]$/;
      if (specialChars.test(pattern)) {
        pattern = "\\" + pattern;
      }
      const flags = "gmi";
      const regex = new RegExp(pattern, flags);
      const results: Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }> = [];
      let match;
      while ((match = regex.exec(context)) !== null) {
        const beforeMatch = context.slice(0, match.index);
        const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;
        results.push({
          match: match[0],
          line: lines[lineNum - 1] || "",
          lineNum,
          index: match.index,
          groups: match.slice(1),
        });
        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }
      return results;
    },
    fuzzy_search: (query: string, limit = 10) => {
      return lines
        .map((line, idx) => ({
          line,
          lineNum: idx + 1,
          score: line.toLowerCase().includes(query.toLowerCase()) ? 100 : 0,
        }))
        .filter(r => r.score > 0)
        .slice(0, limit);
    },
    text_stats: () => ({
      length: context.length,
      lineCount: lines.length,
      sample: { start: "", middle: "", end: "" },
    }),
  };
}

describe("Diverse Scenarios Integration", () => {
  describe("Sales Data (scattered-data.txt pattern)", () => {
    const salesData = `# Company Sales Report
SALES_DATA_NORTH: $2,340,000
Some other text here
SALES_DATA_SOUTH: $3,120,000
More irrelevant content
SALES_DATA_EAST: $2,890,000
SALES_DATA_WEST: $2,670,000
SALES_DATA_CENTRAL: $1,980,000`;

    it("should find sales data lines", () => {
      const tools = createMockTools(salesData);
      const bindings: Bindings = new Map();

      const result = solve(parse('(grep "SALES_DATA")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(5);
    });

    it("should filter to specific regions", () => {
      const tools = createMockTools(salesData);
      const bindings: Bindings = new Map();

      // First grep
      const grepResult = solve(parse('(grep "SALES_DATA")').term!, tools, bindings);
      bindings.set("RESULTS", grepResult.value);

      // Then filter
      const filterResult = solve(
        parse('(filter RESULTS (lambda x (match x "NORTH" 0)))').term!,
        tools,
        bindings
      );
      expect(filterResult.success).toBe(true);
      expect((filterResult.value as unknown[]).length).toBe(1);
    });

    it("should extract and sum numeric values", () => {
      const tools = createMockTools(salesData);
      const bindings: Bindings = new Map();

      // Grep for sales data
      const grepResult = solve(parse('(grep "SALES_DATA")').term!, tools, bindings);
      bindings.set("RESULTS", grepResult.value);

      // Map to extract amounts
      const mapResult = solve(
        parse('(map RESULTS (lambda x (match x "[0-9,]+" 0)))').term!,
        tools,
        bindings
      );
      bindings.set("RESULTS", mapResult.value);

      // Sum the values
      const sumResult = solve(parse('(sum RESULTS)').term!, tools, bindings);
      expect(sumResult.success).toBe(true);
      // 2340000 + 3120000 + 2890000 + 2670000 + 1980000 = 13000000
      expect(sumResult.value).toBe(13000000);
    });
  });

  describe("Server Logs (server-logs.txt pattern)", () => {
    const serverLogs = `[06:16:01] ERROR: Payment processing failed - transaction_id=TXN-001
[06:16:02] INFO: User logged in - user_id=USR-123
[06:16:03] ERROR: Authentication failed - reason=INVALID_CREDENTIALS
[06:16:04] ERROR: Webhook delivery failed - webhook_id=WH-001
[06:16:05] INFO: Request completed successfully`;

    it("should find error lines", () => {
      const tools = createMockTools(serverLogs);
      const bindings: Bindings = new Map();

      const result = solve(parse('(grep "ERROR")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(3);
    });

    it("should filter for specific error types", () => {
      const tools = createMockTools(serverLogs);
      const bindings: Bindings = new Map();

      // Grep for errors
      const grepResult = solve(parse('(grep "ERROR")').term!, tools, bindings);
      bindings.set("RESULTS", grepResult.value);

      // Filter for payment errors
      const filterResult = solve(
        parse('(filter RESULTS (lambda x (match x "Payment" 0)))').term!,
        tools,
        bindings
      );
      expect(filterResult.success).toBe(true);
      expect((filterResult.value as unknown[]).length).toBe(1);
    });

    it("should count errors", () => {
      const tools = createMockTools(serverLogs);
      const bindings: Bindings = new Map();

      const grepResult = solve(parse('(grep "ERROR")').term!, tools, bindings);
      bindings.set("RESULTS", grepResult.value);

      const countResult = solve(parse('(count RESULTS)').term!, tools, bindings);
      expect(countResult.success).toBe(true);
      expect(countResult.value).toBe(3);
    });
  });

  describe("Sensor Readings (sensor-readings.txt pattern)", () => {
    const sensorData = `TEMP_READING_LAB_001: 21.2°C | Status: NORMAL
TEMP_READING_LAB_002: 22.8°C | Status: HIGH_WARNING
TEMP_READING_LAB_003: 21.5°C | Status: NORMAL
TEMP_READING_COLD_001: -15.2°C | Status: CRITICAL_HIGH
TEMP_READING_COLD_002: -18.4°C | Status: NORMAL`;

    it("should find critical readings", () => {
      const tools = createMockTools(sensorData);
      const bindings: Bindings = new Map();

      const result = solve(parse('(grep "CRITICAL")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(1);
    });

    it("should find warning readings", () => {
      const tools = createMockTools(sensorData);
      const bindings: Bindings = new Map();

      const result = solve(parse('(grep "WARNING")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(1);
    });

    it("should filter lab vs cold readings", () => {
      const tools = createMockTools(sensorData);
      const bindings: Bindings = new Map();

      // Grep all temp readings
      const grepResult = solve(parse('(grep "TEMP_READING")').term!, tools, bindings);
      bindings.set("RESULTS", grepResult.value);

      // Filter for LAB readings
      const filterResult = solve(
        parse('(filter RESULTS (lambda x (match x "LAB" 0)))').term!,
        tools,
        bindings
      );
      expect(filterResult.success).toBe(true);
      expect((filterResult.value as unknown[]).length).toBe(3);
    });
  });

  describe("Inventory Data (inventory-report.txt pattern)", () => {
    const inventoryData = `SKU: ELEC-PHONE-001 | iPhone 15 | PRICE: $999.00 | QTY: 145 | STATUS: IN_STOCK
SKU: ELEC-PHONE-002 | Galaxy S24 | PRICE: $849.00 | QTY: 12 | STATUS: LOW_STOCK
SKU: ELEC-LAPTOP-001 | MacBook Air | PRICE: $1099.00 | QTY: 78 | STATUS: IN_STOCK
SKU: ELEC-TABLET-001 | iPad Pro | PRICE: $799.00 | QTY: 0 | STATUS: OUT_OF_STOCK`;

    it("should find low stock items", () => {
      const tools = createMockTools(inventoryData);
      const bindings: Bindings = new Map();

      const result = solve(parse('(grep "LOW_STOCK")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(1);
    });

    it("should find out of stock items", () => {
      const tools = createMockTools(inventoryData);
      const bindings: Bindings = new Map();

      const result = solve(parse('(grep "OUT_OF_STOCK")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect((result.value as unknown[]).length).toBe(1);
    });

    it("should filter by product category", () => {
      const tools = createMockTools(inventoryData);
      const bindings: Bindings = new Map();

      // Grep all items
      const grepResult = solve(parse('(grep "SKU:")').term!, tools, bindings);
      bindings.set("RESULTS", grepResult.value);

      // Filter for phones
      const filterResult = solve(
        parse('(filter RESULTS (lambda x (match x "PHONE" 0)))').term!,
        tools,
        bindings
      );
      expect(filterResult.success).toBe(true);
      expect((filterResult.value as unknown[]).length).toBe(2);
    });
  });

  describe("Multi-turn Workflows", () => {
    const mixedData = `REPORT: Q1 2024
ERROR: System failure at 10:00
SALES_TOTAL: $500,000
ERROR: Database timeout at 10:15
SALES_TOTAL: $750,000
INFO: System recovered at 10:30
SALES_TOTAL: $250,000`;

    it("should complete grep -> filter -> count workflow", () => {
      const tools = createMockTools(mixedData);
      const bindings: Bindings = new Map();

      // Turn 1: Grep
      const t1 = solve(parse('(grep "ERROR")').term!, tools, bindings);
      bindings.set("RESULTS", t1.value);
      bindings.set("_1", t1.value);
      expect((t1.value as unknown[]).length).toBe(2);

      // Turn 2: Count
      const t2 = solve(parse('(count RESULTS)').term!, tools, bindings);
      expect(t2.value).toBe(2);
    });

    it("should complete grep -> map -> sum workflow", () => {
      const tools = createMockTools(mixedData);
      const bindings: Bindings = new Map();

      // Turn 1: Grep sales
      const t1 = solve(parse('(grep "SALES_TOTAL")').term!, tools, bindings);
      bindings.set("RESULTS", t1.value);
      bindings.set("_1", t1.value);
      expect((t1.value as unknown[]).length).toBe(3);

      // Turn 2: Map to extract amounts
      const t2 = solve(
        parse('(map RESULTS (lambda x (match x "[0-9,]+" 0)))').term!,
        tools,
        bindings
      );
      bindings.set("RESULTS", t2.value);
      bindings.set("_2", t2.value);

      // Turn 3: Sum
      const t3 = solve(parse('(sum RESULTS)').term!, tools, bindings);
      expect(t3.value).toBe(1500000); // 500000 + 750000 + 250000
    });

    it("should allow referencing previous turn results", () => {
      const tools = createMockTools(mixedData);
      const bindings: Bindings = new Map();

      // Turn 1: Grep errors
      const t1 = solve(parse('(grep "ERROR")').term!, tools, bindings);
      bindings.set("RESULTS", t1.value);
      bindings.set("_1", t1.value);

      // Turn 2: Grep sales (overwrites RESULTS)
      const t2 = solve(parse('(grep "SALES")').term!, tools, bindings);
      bindings.set("RESULTS", t2.value);
      bindings.set("_2", t2.value);

      // Turn 3: Reference _1 (original error results)
      const t3 = solve(parse('(count _1)').term!, tools, bindings);
      expect(t3.value).toBe(2);

      // Turn 4: Reference _2 (sales results)
      const t4 = solve(parse('(count _2)').term!, tools, bindings);
      expect(t4.value).toBe(3);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty search results", () => {
      const tools = createMockTools("No matching data here");
      const bindings: Bindings = new Map();

      const result = solve(parse('(grep "NONEXISTENT")').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toEqual([]);
    });

    it("should handle filter on empty results", () => {
      const tools = createMockTools("Some data");
      const bindings: Bindings = new Map();
      bindings.set("RESULTS", []);

      const result = solve(
        parse('(filter RESULTS (lambda x (match x "test" 0)))').term!,
        tools,
        bindings
      );
      expect(result.success).toBe(true);
      expect(result.value).toEqual([]);
    });

    it("should handle sum of empty array", () => {
      const tools = createMockTools("Some data");
      const bindings: Bindings = new Map();
      bindings.set("RESULTS", []);

      const result = solve(parse('(sum RESULTS)').term!, tools, bindings);
      expect(result.success).toBe(true);
      expect(result.value).toBe(0);
    });

    it("should handle mixed valid/null values from map", () => {
      const tools = createMockTools("Data: 100\nText only\nData: 200");
      const bindings: Bindings = new Map();

      // Grep all lines (use pattern that matches all lines)
      const grepResult = solve(parse('(grep "Data|Text")').term!, tools, bindings);
      bindings.set("RESULTS", grepResult.value);

      // Map to extract numbers (some will be null)
      const mapResult = solve(
        parse('(map RESULTS (lambda x (match x "[0-9]+" 0)))').term!,
        tools,
        bindings
      );
      bindings.set("RESULTS", mapResult.value);

      // Sum should handle nulls gracefully
      const sumResult = solve(parse('(sum RESULTS)').term!, tools, bindings);
      expect(sumResult.success).toBe(true);
      expect(sumResult.value).toBe(300);
    });
  });
});
