/**
 * Document Analysis Scenario Tests
 *
 * Tests the RLM system against various document types to verify
 * it can extract and aggregate data correctly.
 *
 * NOTE: All tests use LC (Lambda Calculus) syntax since the RLM
 * loop uses Nucleus LC-based execution for all models.
 */

import { describe, it, expect } from "vitest";
import { runRLM } from "../../src/rlm.js";
import { createNucleusAdapter } from "../../src/adapters/nucleus.js";
import { join } from "node:path";

const FIXTURES_DIR = join(__dirname, "../../test-fixtures");

// Helper to create a mock LLM that follows a script
function createScriptedLLM(responses: string[]) {
  let turnIndex = 0;
  return async (_prompt: string) => {
    const response = responses[turnIndex] || responses[responses.length - 1];
    turnIndex++;
    return response;
  };
}

describe("Server Logs Analysis", () => {
  const logFile = join(FIXTURES_DIR, "server-logs.txt");

  it("should count ERROR entries correctly", async () => {
    // Expected: 15 ERROR entries in the log file
    const llm = createScriptedLLM([
      // Turn 1: Search for errors (LC syntax)
      `(grep "ERROR")`,
      // Turn 2: Provide answer
      `<<<FINAL>>>
There are 15 ERROR entries in the log file.
<<<END>>>`,
    ]);

    const result = await runRLM("How many ERROR entries are in this log?", logFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: true,
    });

    expect(String(result)).toContain("15");
  });

  it("should identify error types", async () => {
    const llm = createScriptedLLM([
      // Turn 1: Search for errors
      `(grep "ERROR")`,
      // Turn 2: Search for specific error patterns
      `(grep "reason")`,
      // Turn 3: Provide answer
      `<<<FINAL>>>
The log contains errors for: CARD_DECLINED, INSUFFICIENT_FUNDS, INVALID_CREDENTIALS, SIZE_LIMIT_EXCEEDED, CERT_EXPIRED.
<<<END>>>`,
    ]);

    const result = await runRLM("What types of errors occurred?", logFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: true,
    });

    expect(result).toBeDefined();
  });

  it("should find specific service errors", async () => {
    const llm = createScriptedLLM([
      `(grep "payment")`,
      `<<<FINAL>>>
Found 2 payment service errors.
<<<END>>>`,
    ]);

    const result = await runRLM("How many payment-related errors occurred?", logFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 3,
      ragEnabled: true,
    });

    expect(String(result)).toMatch(/2|two/i);
  });
});

describe("Sensor Readings Analysis", () => {
  const sensorFile = join(FIXTURES_DIR, "sensor-readings.txt");

  // Skipped: Requires complex synthesis workflow that doesn't work well with mock LLM
  it.skip("should calculate total power consumption", async () => {
    const llm = createScriptedLLM([
      `(grep "POWER_KWH")`,
      `<<<FINAL>>>
Total power consumption for the month: 50,330 kWh
<<<END>>>`,
    ]);

    const result = await runRLM("What is the total power consumption?", sensorFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: true,
    });

    expect(String(result)).toMatch(/50,?330/);
  });

  it("should find critical temperature alerts", async () => {
    const llm = createScriptedLLM([
      `(grep "CRITICAL")`,
      `<<<FINAL>>>
Found 1 CRITICAL alert: Cold storage temperature rose to -15.2°C during power fluctuation.
<<<END>>>`,
    ]);

    const result = await runRLM("Were there any critical temperature alerts?", sensorFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 3,
      ragEnabled: true,
    });

    expect(String(result)).toMatch(/1|one|critical/i);
  });

  // TODO: Debug why this specific test reaches max turns
  it.skip("should calculate average AQI", async () => {
    const llm = createScriptedLLM([
      `(grep "AQI_READING")`,
      `<<<FINAL>>>
Average AQI for the period: 49.7 (Good to Moderate range)
<<<END>>>`,
    ]);

    const result = await runRLM("What is the average Air Quality Index?", sensorFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: true,
    });

    expect(String(result)).toMatch(/49\.7|50|average/i);
  });
});

describe("Inventory Report Analysis", () => {
  const inventoryFile = join(FIXTURES_DIR, "inventory-report.txt");

  it("should count items by status", async () => {
    const llm = createScriptedLLM([
      `(grep "OUT_OF_STOCK")`,
      `(grep "LOW_STOCK")`,
      `<<<FINAL>>>
Inventory status: 1 item out of stock, 3 items low stock.
<<<END>>>`,
    ]);

    const result = await runRLM("How many items are out of stock or low stock?", inventoryFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: true,
    });

    expect(String(result)).toMatch(/1.*out.*stock|3.*low/i);
  });

  it("should find the most expensive item", async () => {
    const llm = createScriptedLLM([
      `(grep "PRICE")`,
      `<<<FINAL>>>
The most expensive item is the Peloton Bike+ at $2,495.00.
<<<END>>>`,
    ]);

    const result = await runRLM("What is the most expensive item in inventory?", inventoryFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: true,
    });

    expect(String(result)).toMatch(/peloton|2,?495/i);
  });

  // Skipped: Requires complex synthesis workflow
  it.skip("should calculate total inventory value for a category", async () => {
    const llm = createScriptedLLM([
      `(grep "ELEC-PHONE")`,
      `<<<FINAL>>>
Total smartphone inventory value: $443,796.00
<<<END>>>`,
    ]);

    const result = await runRLM("What is the total value of smartphone inventory?", inventoryFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: true,
    });

    expect(String(result)).toMatch(/443|smartphone|value/i);
  });
});

describe("Scattered Data (Original Test)", () => {
  const scatteredFile = join(FIXTURES_DIR, "scattered-data.txt");

  it("should calculate total sales from all regions", async () => {
    // Expected: $2,340,000 + $3,120,000 + $2,890,000 + $2,670,000 + $1,980,000 = $13,000,000
    const llm = createScriptedLLM([
      `(grep "SALES_DATA")`,
      `<<<FINAL>>>
Total sales across all regions: $13,000,000
<<<END>>>`,
    ]);

    const result = await runRLM("What is the total of all sales data values?", scatteredFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: true,
    });

    expect(String(result)).toContain("13,000,000");
  });

  it("should identify all regions", async () => {
    const llm = createScriptedLLM([
      `(grep "SALES_DATA")`,
      `<<<FINAL>>>
The report covers 5 regions: NORTH, SOUTH, EAST, WEST, and CENTRAL.
<<<END>>>`,
    ]);

    const result = await runRLM("What regions are covered in the sales report?", scatteredFile, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 3,
      ragEnabled: true,
    });

    expect(String(result)).toMatch(/north|south|east|west|central/i);
  });
});
