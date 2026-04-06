/**
 * Tests for RRF (Reciprocal Rank Fusion)
 * Ported from Ori-Mnemos and adapted for line-based search
 */

import { describe, it, expect } from "vitest";
import { fuseRRF, normalizeWeights, type LineResult } from "../../src/logic/rrf.js";

describe("normalizeWeights", () => {
  it("should normalize weights to sum to 1", () => {
    const result = normalizeWeights([2, 3, 5]);
    const sum = result.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0);
    expect(result[0]).toBeCloseTo(0.2);
    expect(result[1]).toBeCloseTo(0.3);
    expect(result[2]).toBeCloseTo(0.5);
  });

  it("should clamp negative weights to 0", () => {
    const result = normalizeWeights([-1, 2, 3]);
    expect(result[0]).toBe(0);
    expect(result[1]).toBeCloseTo(0.4);
    expect(result[2]).toBeCloseTo(0.6);
  });

  it("should fall back to equal weights when all zero", () => {
    const result = normalizeWeights([0, 0, 0]);
    expect(result[0]).toBeCloseTo(1 / 3);
    expect(result[1]).toBeCloseTo(1 / 3);
    expect(result[2]).toBeCloseTo(1 / 3);
  });
});

describe("fuseRRF", () => {
  const signal1: LineResult[] = [
    { line: "ERROR: db failed", lineNum: 1, score: 0.95 },
    { line: "ERROR: timeout", lineNum: 3, score: 0.80 },
    { line: "INFO: retry", lineNum: 2, score: 0.50 },
  ];

  const signal2: LineResult[] = [
    { line: "INFO: retry", lineNum: 2, score: 0.90 },
    { line: "ERROR: db failed", lineNum: 1, score: 0.70 },
    { line: "DEBUG: trace", lineNum: 5, score: 0.30 },
  ];

  it("should return all unique lines from all signals", () => {
    const results = fuseRRF([signal1, signal2]);
    const lineNums = results.map(r => r.lineNum);
    expect(lineNums).toContain(1); // in both
    expect(lineNums).toContain(2); // in both
    expect(lineNums).toContain(3); // only signal1
    expect(lineNums).toContain(5); // only signal2
    expect(results.length).toBe(4);
  });

  it("should rank multi-signal lines higher than single-signal", () => {
    const results = fuseRRF([signal1, signal2]);
    // Lines 1 and 2 appear in both signals, should rank higher
    const multiSignalLines = results.filter(r => r.signals.every(s => s > 0));
    const singleSignalLines = results.filter(r => r.signals.some(s => s === 0));

    const maxMulti = Math.max(...multiSignalLines.map(r => r.score));
    const maxSingle = Math.max(...singleSignalLines.map(r => r.score));
    expect(maxMulti).toBeGreaterThan(maxSingle);
  });

  it("should preserve per-signal scores", () => {
    const results = fuseRRF([signal1, signal2]);
    const line1 = results.find(r => r.lineNum === 1)!;
    expect(line1.signals[0]).toBe(0.95); // signal1 score
    expect(line1.signals[1]).toBe(0.70); // signal2 score

    const line5 = results.find(r => r.lineNum === 5)!;
    expect(line5.signals[0]).toBe(0);    // not in signal1
    expect(line5.signals[1]).toBe(0.30); // signal2 score
  });

  it("should sort by fused score descending", () => {
    const results = fuseRRF([signal1, signal2]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("should handle empty signals", () => {
    expect(fuseRRF([])).toEqual([]);
    expect(fuseRRF([[], []])).toEqual([]);
  });

  it("should pass through single signal", () => {
    const results = fuseRRF([signal1]);
    expect(results.length).toBe(3);
    expect(results[0].lineNum).toBe(1); // highest score
    expect(results[0].signals).toEqual([0.95]);
  });

  it("should apply custom weights", () => {
    // Heavily weight signal2
    const weighted = fuseRRF([signal1, signal2], { weights: [0.1, 0.9] });
    // Line 2 is rank 0 in signal2 (score 0.90) — should benefit from high weight
    const line2 = weighted.find(r => r.lineNum === 2)!;
    const line1 = weighted.find(r => r.lineNum === 1)!;
    // With 90% weight on signal2, line 2 (rank 0 in signal2) should score well
    expect(line2.score).toBeGreaterThan(0);
    expect(line1.score).toBeGreaterThan(0);
  });

  it("should apply custom k parameter", () => {
    const lowK = fuseRRF([signal1, signal2], { k: 1 });
    const highK = fuseRRF([signal1, signal2], { k: 1000 });
    // Lower k = higher scores (less smoothing)
    expect(lowK[0].score).toBeGreaterThan(highK[0].score);
  });

  it("should handle duplicate lineNums within a signal", () => {
    const dupSignal: LineResult[] = [
      { line: "first", lineNum: 1, score: 0.9 },
      { line: "first again", lineNum: 1, score: 0.5 }, // duplicate
    ];
    const results = fuseRRF([dupSignal]);
    // Should keep first occurrence (higher rank)
    const line1 = results.find(r => r.lineNum === 1)!;
    expect(line1.score).toBe(0.9);
  });

  it("should verify RRF formula manually", () => {
    const s1: LineResult[] = [{ line: "A", lineNum: 1, score: 1.0 }];
    const s2: LineResult[] = [{ line: "A", lineNum: 1, score: 0.5 }];

    const k = 60;
    const results = fuseRRF([s1, s2], { k });
    const line1 = results.find(r => r.lineNum === 1)!;

    // With equal weights (0.5 each):
    // signal1: 0.5 * 1.0 / (60 + 0 + 1) = 0.5 / 61
    // signal2: 0.5 * 0.5 / (60 + 0 + 1) = 0.25 / 61
    const expected = (0.5 * 1.0) / (k + 0 + 1) + (0.5 * 0.5) / (k + 0 + 1);
    expect(line1.score).toBeCloseTo(expected);
  });
});
