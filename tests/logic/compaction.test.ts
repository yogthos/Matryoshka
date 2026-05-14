/**
 * Phase 6 — history compaction.
 *
 * When the FSM's message history grows past `compactionThresholdChars`,
 * the loop emits a one-shot summarization llm_query that condenses
 * turns 2..N into a single assistant message. The history is then
 * replaced with [system, first user, summary, latest turn] so the
 * next LLM call sees a much smaller prompt without losing the gist
 * of prior progress. The full pre-compaction history is stashed as
 * a binding (`_compaction_trace`) for later retrieval if needed.
 *
 * Coverage:
 *   1. Threshold-trigger: with a low threshold, compaction fires on
 *      a multi-turn run; subsequent prompts are smaller.
 *   2. Preservation: solver bindings (RESULTS, _N) survive
 *      compaction — they're separate from the message history.
 *   3. Stash: the pre-compaction trace is retrievable via the
 *      `_compaction_trace` binding.
 *   4. Backwards-compat: with no threshold, behavior is unchanged.
 *   5. Single-shot: a turn that crosses the threshold once doesn't
 *      keep firing summarization indefinitely.
 */

import { describe, it, expect } from "vitest";
import { runRLMFromContent } from "../../src/rlm.js";
import { createNucleusAdapter } from "../../src/adapters/nucleus.js";

describe("Phase 6 — compaction trigger", () => {
  it("compacts when history exceeds threshold and shrinks subsequent prompts", async () => {
    // Track every prompt size. With compaction at 1500 chars, the
    // sequence should show: turn 1 (small), turn 2 (bigger), turn 3
    // (likely triggers compaction → smaller again), ...
    const promptSizes: number[] = [];
    let summaryCalls = 0;
    const llm = async (prompt: string): Promise<string> => {
      promptSizes.push(prompt.length);
      // Compaction fires its summarization with a "Summarize your
      // progress so far" prefix so we can detect and tag the call.
      if (/summarize.*progress|summarize.*conversation/i.test(prompt)) {
        summaryCalls++;
        return "Summary: turn 1 grepped X (3 matches), turn 2 grepped Y (2 matches).";
      }
      // Each non-summary turn returns a grep so the FSM accumulates
      // history chunks.
      return `(grep "X")`;
    };
    // Doc with enough lines that grep accumulates per-turn output.
    const doc = Array.from({ length: 60 }, (_, i) => `X-line-${i}: some content`).join("\n");

    const result = (await runRLMFromContent("scan X", doc, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 6,
      ragEnabled: false,
      compactionThresholdChars: 2500,
    })) as string;

    expect(typeof result).toBe("string");
    // Must have triggered AT LEAST one summarization.
    expect(summaryCalls).toBeGreaterThanOrEqual(1);
    // After compaction, a subsequent prompt MUST be smaller than
    // the prompt that triggered it. Find the largest prompt and
    // check that a SMALLER prompt comes after it (proving the
    // history surgery actually shrank things).
    const largestIdx = promptSizes.indexOf(Math.max(...promptSizes));
    const after = promptSizes.slice(largestIdx + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(Math.min(...after)).toBeLessThan(promptSizes[largestIdx]);
  });
});

describe("Phase 6 — bindings survive compaction", () => {
  it("RESULTS / _N bindings remain available after a compaction event", async () => {
    // Turn 1: grep (large result → triggers compaction afterward).
    // Turn 2: AFTER compaction, FINAL inlining FINAL_VAR(_1). _1
    //   must still resolve to the grep array even though the
    //   message history was rewritten.
    let turn = 0;
    const llm = async (prompt: string): Promise<string> => {
      if (/Summarize your progress so far/.test(prompt)) return "Summary: turn 1 grepped Xs.";
      turn++;
      if (turn === 1) return `(grep "X")`;
      // Turn 2: FINAL referencing _1 (the grep result from turn 1).
      // If bindings were lost during compaction, FINAL_VAR(_1)
      // would surface an "[FINAL_VAR error: ...]" string.
      return `<<<FINAL>>>FINAL_VAR(_1)<<<END>>>`;
    };
    const doc = Array.from(
      { length: 80 },
      (_, i) => `X-${i} ${"filler".repeat(20)}`
    ).join("\n");
    const result = (await runRLMFromContent("scan Xs", doc, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 6,
      ragEnabled: false,
      compactionThresholdChars: 1500,
    })) as string;

    expect(typeof result).toBe("string");
    // _1 resolved → result contains the grep matches (X-0, X-1, ...).
    // If the binding was lost, we'd see FINAL_VAR error markers.
    expect(result).not.toMatch(/FINAL_VAR error/i);
    expect(result).toMatch(/X-0|X-1|X-/);
  });
});

describe("Phase 6 — pre-compaction trace stashed", () => {
  it("the full pre-compaction history is retrievable as the _compaction_trace binding", async () => {
    let turn = 0;
    const llm = async (prompt: string): Promise<string> => {
      if (/Summarize your progress so far/.test(prompt)) return "Summary: stuff happened.";
      turn++;
      if (turn === 1) return `(grep "TAG-")`;
      if (turn === 2) return `(grep "X")`;
      // After compaction (assumed to fire by turn 3), inspect the
      // stashed trace.
      return `<<<FINAL>>>FINAL_VAR(_compaction_trace)<<<END>>>`;
    };
    const doc = Array.from({ length: 80 }, (_, i) => `TAG-${i}: ${"x".repeat(30)}`).join(
      "\n"
    );
    const result = (await runRLMFromContent("scan", doc, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 6,
      ragEnabled: false,
      compactionThresholdChars: 1500,
    })) as string;

    expect(typeof result).toBe("string");
    // The stashed trace must contain content from PRE-compaction
    // turns. We expect to see at least one of the original
    // assistant responses or feedback strings.
    expect(result).toMatch(/grep|TAG-|Result:/i);
    // It must NOT be the unresolved FINAL_VAR marker — the binding
    // has to actually exist.
    expect(result).not.toMatch(/FINAL_VAR error/i);
  });
});

describe("Phase 6 — failing compaction does not loop forever", () => {
  it("after N consecutive compaction failures, compaction is disabled and the run continues", async () => {
    // Simulated failing summarize: every compaction call throws.
    // Without the failure cap, the FSM would keep retrying every
    // turn since the failed compaction doesn't shrink history.
    let summarizeCalls = 0;
    let turn = 0;
    const llm = async (prompt: string): Promise<string> => {
      if (/Summarize your progress so far/.test(prompt)) {
        summarizeCalls++;
        throw new Error("simulated summarize failure");
      }
      turn++;
      if (turn === 1) return `(grep "X")`;
      // After turn 1, history is huge; subsequent turns try to
      // compact, fail, then continue. We emit FINAL on turn 2.
      return `<<<FINAL>>>FINAL_VAR(_1)<<<END>>>`;
    };
    const doc = Array.from(
      { length: 80 },
      (_, i) => `X-${i} ${"filler".repeat(20)}`
    ).join("\n");
    const result = (await runRLMFromContent("scan", doc, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 6,
      ragEnabled: false,
      compactionThresholdChars: 1500,
    })) as string;

    expect(typeof result).toBe("string");
    // The cap is N=2 in production. Anything above ~3 means the
    // loop kept retrying — bug. The cap stops it.
    expect(summarizeCalls).toBeLessThanOrEqual(3);
    // The run should complete despite compaction being disabled.
    expect(result).not.toMatch(/Max turns/);
  });
});

describe("Phase 6 — compaction respects maxTimeoutMs", () => {
  it("aborts cleanly when summarization hangs past the timeout budget", async () => {
    // Simulated hanging summarize: the summarization prompt hangs
    // forever instead of throwing. Without a timeout race, the FSM
    // would block indefinitely inside compactHistory.
    let summarizeCalls = 0;
    let turn = 0;
    const doc = Array.from(
      { length: 80 },
      (_, i) => `X-${i} ${"filler".repeat(20)}`
    ).join("\n");

    const llm = async (prompt: string): Promise<string> => {
      if (/Summarize your progress so far/.test(prompt)) {
        summarizeCalls++;
        // Hang forever — never resolve.
        return new Promise<never>(() => {});
      }
      turn++;
      if (turn === 1) return `(grep "X")`;
      return `<<<FINAL>>>done<<<END>>>`;
    };

    const start = Date.now();
    const result = (await runRLMFromContent("scan", doc, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 6,
      ragEnabled: false,
      compactionThresholdChars: 1500,
      maxTimeoutMs: 500,
    })) as string;
    const elapsed = Date.now() - start;

    expect(typeof result).toBe("string");
    // Must not hang — timeout should abort.
    expect(result).toMatch(/aborted.*timeout/i);
    expect(elapsed).toBeLessThan(2000);
    // Exactly one summarization attempt (the hang fires once).
    expect(summarizeCalls).toBe(1);
  });
});

describe("Phase 6 — backwards compat", () => {
  it("with no threshold configured, no summarization fires", async () => {
    let summaryCalls = 0;
    let turn = 0;
    const llm = async (prompt: string): Promise<string> => {
      if (/summarize.*progress|summarize.*conversation/i.test(prompt)) {
        summaryCalls++;
      }
      turn++;
      if (turn === 1) return `(grep "X")`;
      return `<<<FINAL>>>done<<<END>>>`;
    };
    const doc = Array.from({ length: 50 }, () => "x".repeat(100)).join("\n");
    const result = (await runRLMFromContent("X", doc, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 3,
      ragEnabled: false,
    })) as string;
    expect(typeof result).toBe("string");
    expect(summaryCalls).toBe(0);
    expect(result).toContain("done");
  });
});
