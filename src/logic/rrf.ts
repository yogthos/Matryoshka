/**
 * Reciprocal Rank Fusion for Nucleus
 *
 * Ported from Ori-Mnemos (src/core/fusion.ts) and adapted for
 * line-based document search. Fuses result arrays keyed by lineNum.
 *
 * Formula (score-weighted RRF):
 *   score = Σ_s( weight_s × raw_score_s / (k + rank_s + 1) )
 *
 * Where:
 *   k = smoothing parameter (default 60)
 *   rank_s = 0-based position in signal's ranked list
 *   raw_score_s = original score from that signal
 */

// ── Types ────────────────────────────────────────────────────────────

/** A single search result with line content and score */
export interface LineResult {
  line: string;
  lineNum: number;
  score: number;
  [key: string]: unknown; // allow extra fields (match, index, groups from grep)
}

/** RRF configuration */
export interface RRFConfig {
  k: number;
  weights: number[];  // one weight per input signal
}

/** Fused result with per-signal score breakdown */
export interface FusedResult {
  line: string;
  lineNum: number;
  score: number;
  signals: number[];  // raw score from each input signal (0 if absent)
}

// ── Default config ──────────────────────────────────────────────────

const DEFAULT_K = 60;

// ── Helpers (from Ori-Mnemos) ───────────────────────────────────────

interface RankEntry {
  rank: number;
  score: number;
  line: string;
}

/** Build a lineNum → { rank, score, line } lookup for a single signal. */
function buildIndex(results: LineResult[]): Map<number, RankEntry> {
  const map = new Map<number, RankEntry>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // Keep first occurrence (highest rank) if duplicates exist
    if (!map.has(r.lineNum)) {
      map.set(r.lineNum, { rank: i, score: r.score, line: r.line });
    }
  }
  return map;
}

/** Normalize weights to sum to 1.0. Clamp negatives to 0. */
export function normalizeWeights(weights: number[]): number[] {
  const clamped = weights.map(w => Math.max(0, w));
  const total = clamped.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // Equal weights fallback
    const eq = 1 / weights.length;
    return weights.map(() => eq);
  }
  return clamped.map(w => w / total);
}

// ── Score-weighted RRF (from Ori-Mnemos fuseScoreWeightedRRF) ───────

/**
 * Fuse multiple result arrays using score-weighted RRF.
 *
 * @param signals - Array of result arrays from different search operations
 * @param config - Optional RRF configuration (k parameter, weights)
 * @returns Fused results sorted by combined score descending
 */
export function fuseRRF(
  signals: LineResult[][],
  config?: Partial<RRFConfig>,
): FusedResult[] {
  if (signals.length === 0) return [];
  if (signals.length === 1) {
    // Single signal — just pass through with score normalization
    return signals[0].map(r => ({
      line: r.line,
      lineNum: r.lineNum,
      score: r.score,
      signals: [r.score],
    }));
  }

  const k = config?.k ?? DEFAULT_K;
  const rawWeights = config?.weights ?? signals.map(() => 1);

  // Pad or trim weights to match signal count
  const paddedWeights = signals.map((_, i) => rawWeights[i] ?? 1);
  const weights = normalizeWeights(paddedWeights);

  // Build per-signal indexes
  const indexes = signals.map(s => buildIndex(s));

  // Collect unique lineNums across all signals
  const lineNums = new Set<number>();
  for (const signal of signals) {
    for (const r of signal) {
      lineNums.add(r.lineNum);
    }
  }

  // Fuse
  const results: FusedResult[] = [];

  for (const lineNum of lineNums) {
    let fusedScore = 0;
    const signalScores: number[] = [];
    let line = "";

    for (let s = 0; s < signals.length; s++) {
      const entry = indexes[s].get(lineNum);
      if (entry) {
        const contribution = (weights[s] * entry.score) / (k + entry.rank + 1);
        fusedScore += contribution;
        signalScores.push(entry.score);
        if (!line) line = entry.line;
      } else {
        signalScores.push(0);
      }
    }

    results.push({ line, lineNum, score: fusedScore, signals: signalScores });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
