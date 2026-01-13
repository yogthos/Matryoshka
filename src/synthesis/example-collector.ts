/**
 * Example Collector
 * Automatically extracts examples from sandbox execution results
 */

import { CollectedExample, SynthesisCoordinator } from "./coordinator.js";

/**
 * Result from sandbox execution
 */
export interface SandboxResult {
  result: unknown;
  logs: string[];
  error?: string;
}

/**
 * Grep result structure
 */
export interface GrepResult {
  match: string;
  line: string;
  lineNum: number;
}

/**
 * Number example structure
 */
export interface NumberExample {
  raw: string;
  parsed: number;
}

/**
 * Key-value example structure
 */
export interface KeyValueExample {
  key: string;
  value: string;
  raw: string;
}

/**
 * Parsed log line structure
 */
export interface ParsedLogLine {
  timestamp?: string;
  level?: string;
  message?: string;
}

/**
 * Extract grep results from JSON log format
 */
export function extractGrepResults(logs: string[]): GrepResult[] {
  const results: GrepResult[] = [];

  for (const log of logs) {
    try {
      // Try to parse as JSON array
      if (log.startsWith("[") && log.endsWith("]")) {
        const parsed = JSON.parse(log);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (
              typeof item === "object" &&
              item !== null &&
              "match" in item &&
              "line" in item
            ) {
              results.push({
                match: String(item.match),
                line: String(item.line),
                lineNum: typeof item.lineNum === "number" ? item.lineNum : 0,
              });
            }
          }
        }
      }
    } catch {
      // Not JSON, skip
    }
  }

  return results;
}

/**
 * Extract number conversion examples from logs
 * Looks for patterns like "$1,000 -> 1000" or "50% -> 0.5"
 */
export function extractNumberExamples(logs: string[]): NumberExample[] {
  const results: NumberExample[] = [];

  // Pattern: raw -> parsed
  const conversionPattern = /^(.+?)\s*->\s*(-?[\d.]+)$/;

  for (const log of logs) {
    const match = log.match(conversionPattern);
    if (match) {
      const raw = match[1].trim();
      const parsed = parseFloat(match[2]);
      if (!isNaN(parsed)) {
        results.push({ raw, parsed });
      }
    }
  }

  return results;
}

/**
 * Extract key-value examples from logs
 * Looks for patterns like "key: value" or "key=value"
 */
export function extractKeyValueExamples(logs: string[]): KeyValueExample[] {
  const results: KeyValueExample[] = [];

  // Pattern: key: value or key=value
  const kvPattern = /^(\w+)\s*[:=]\s*(.+)$/;

  for (const log of logs) {
    const match = log.match(kvPattern);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      results.push({
        key,
        value,
        raw: log,
      });
    }
  }

  return results;
}

/**
 * Parse a log line to extract timestamp, level, and message
 */
export function parseLogLine(line: string): ParsedLogLine {
  const result: ParsedLogLine = {};

  // Pattern: [timestamp] LEVEL: message
  const fullPattern = /^\[(.+?)\]\s*(ERROR|WARN|INFO|DEBUG):\s*(.+)$/;
  const simplePattern = /^(ERROR|WARN|INFO|DEBUG):\s*(.+)$/;

  let match = line.match(fullPattern);
  if (match) {
    result.timestamp = match[1];
    result.level = match[2];
    result.message = match[3];
    return result;
  }

  match = line.match(simplePattern);
  if (match) {
    result.level = match[1];
    result.message = match[2];
    return result;
  }

  return result;
}

/**
 * Collect examples from sandbox execution result
 */
export function collectExamplesFromResult(
  result: SandboxResult,
  code: string,
  coordinator: SynthesisCoordinator
): void {
  // If there's an error, we still try to collect what we can
  // but don't throw

  try {
    // Parse grep results if code contains grep
    if (code.includes("grep(") || code.includes("grep ")) {
      const grepResults = extractGrepResults(result.logs);
      for (const gr of grepResults) {
        coordinator.collectExample("grep_matches", {
          source: "grep",
          raw: gr.match,
          context: gr.line,
          lineNum: gr.lineNum,
        });
      }
    }

    // Parse number conversion examples
    const numberMatches = extractNumberExamples(result.logs);
    for (const nm of numberMatches) {
      coordinator.collectExample("numbers", {
        source: "match",
        raw: nm.raw,
        context: nm.parsed.toString(),
      });
    }

    // Parse key:value patterns
    const kvMatches = extractKeyValueExamples(result.logs);
    for (const kv of kvMatches) {
      coordinator.collectExample("key_values", {
        source: "line",
        raw: kv.raw,
        context: `${kv.key}=${kv.value}`,
      });
    }

    // Parse log levels
    const logLevelExamples: CollectedExample[] = [];
    for (const log of result.logs) {
      const parsed = parseLogLine(log);
      if (parsed.level) {
        logLevelExamples.push({
          source: "line",
          raw: parsed.level,
          context: log,
        });
      }
    }
    for (const ex of logLevelExamples) {
      coordinator.collectExample("log_levels", ex);
    }
  } catch {
    // Silently ignore collection errors
  }
}
