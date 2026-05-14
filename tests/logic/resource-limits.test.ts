/**
 * Phase 5 — resource limits.
 *
 * Adds maxTimeoutMs, maxChars, and maxErrors to RLMOptions. When a
 * limit is hit, the run terminates cleanly and returns a STRING that
 * embeds the best partial answer found so far rather than letting the
 * loop spiral. Backwards-compatible: with no limit set, behavior is
 * exactly as before.
 *
 * Coverage:
 *   1. maxTimeoutMs: a slow scripted LLM is interrupted near the cap;
 *      result includes "[aborted: timeout" and the best partial.
 *   2. maxChars: cumulative chars (proxy for tokens) crossing the
 *      ceiling triggers a clean abort with the same shape.
 *   3. maxErrors: N consecutive parse errors → abort with the same
 *      shape.
 *   4. Backwards-compat: no limits → completes normally.
 *   5. Best partial answer: when the LLM produced meaningful prior
 *      content (e.g. a grep result with N matches), the abort string
 *      mentions or includes that content rather than being empty.
 */

import { describe, it, expect } from "vitest";
import { runRLMFromContent } from "../../src/rlm.js";
import { createNucleusAdapter } from "../../src/adapters/nucleus.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("Phase 5 — maxTimeoutMs", () => {
  it("aborts cleanly with a partial answer when wall-clock exceeds the cap", async () => {
    // Scripted LLM that's slow on every call. With maxTimeoutMs=200,
    // the run should abort somewhere between turn 1 and turn 2 and
    // return a partial-answer marker rather than running forever.
    const llm = async (_p: string): Promise<string> => {
      await sleep(150);
      return `(grep "X")`;
    };
    const start = Date.now();
    const result = (await runRLMFromContent("find X", "X\nY\nX\n", {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 10,
      ragEnabled: false,
      maxTimeoutMs: 200,
    })) as string;
    const elapsed = Date.now() - start;

    expect(typeof result).toBe("string");
    // Must abort cleanly (no thrown exception bubbling past
    // runRLMFromContent) and signal the timeout.
    expect(result).toMatch(/aborted.*timeout|timeout.*reached/i);
    // Within 1.5x the cap (slack for the in-flight LLM call to
    // complete its current turn).
    expect(elapsed).toBeLessThan(300);
  });
});

describe("Phase 5 — maxChars", () => {
  it("aborts when cumulative input+output chars cross the cap", async () => {
    // Each parent prompt is several KB. Cap at 500 chars total
    // means we abort after the first turn's prompt is sent.
    let calls = 0;
    const llm = async (p: string): Promise<string> => {
      calls++;
      // Return a long string so output chars count too.
      return "x".repeat(200) + ` (grep "X")`;
    };
    const result = (await runRLMFromContent("find X", "X\nY", {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 10,
      ragEnabled: false,
      maxChars: 500,
    })) as string;

    expect(typeof result).toBe("string");
    expect(result).toMatch(/aborted.*chars|char.*limit/i);
    // We don't assert call count exactly — could be 1 or 2 depending
    // on when the check fires — but the cap MUST stop the loop
    // before maxTurns (10) iterations.
    expect(calls).toBeLessThan(10);
  });
});

describe("Phase 5 — maxErrors", () => {
  it("aborts after N consecutive code-execution errors", async () => {
    // Always emit invalid syntax. With maxErrors=2, we abort after
    // the 2nd consecutive error.
    let calls = 0;
    const llm = async (_p: string): Promise<string> => {
      calls++;
      return `(grep`; // unbalanced parens — parse error
    };
    const result = (await runRLMFromContent("ask", "doc", {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 10,
      ragEnabled: false,
      maxErrors: 2,
    })) as string;

    expect(typeof result).toBe("string");
    expect(result).toMatch(/aborted.*errors|too many errors|error.*limit/i);
    // Should have called the LLM about 2 times (one per error
    // before tripping the cap), well below maxTurns=10.
    expect(calls).toBeLessThanOrEqual(3);
  });
});

describe("Phase 5 — best partial answer", () => {
  it("includes meaningful prior content in the abort message when available", async () => {
    // First turn produces grep matches; second turn would otherwise
    // hang. With maxTimeoutMs=200, we abort during turn 2 — the
    // result should reference the grep matches found in turn 1.
    let turn = 0;
    const llm = async (_p: string): Promise<string> => {
      turn++;
      if (turn === 1) return `(grep "TOKEN")`;
      // Simulate a slow follow-up that pushes us past the cap.
      await sleep(500);
      return `<<<FINAL>>>n/a<<<END>>>`;
    };
    const result = (await runRLMFromContent("find tokens", "TOKEN-A\nTOKEN-B\nTOKEN-C", {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 6,
      ragEnabled: false,
      maxTimeoutMs: 250,
    })) as string;

    expect(typeof result).toBe("string");
    expect(result).toMatch(/aborted/i);
    // The partial-answer surface MUST mention the grep matches —
    // the alternative is silently losing all completed work,
    // which is the failure mode this phase fixes.
    expect(result).toMatch(/TOKEN-A|TOKEN-B|TOKEN-C|3 match/i);
  });
});

describe("Phase 5 — child abort doesn't pollute parent's partial", () => {
  it("when a child rlm_query hits its own timeout, parent keeps its earlier grep result", async () => {
    // Parent: turn 1 grep (good result), turn 2 rlm_query (child
    // times out and returns "[aborted: ...]"), turn 3 parent abort
    // due to its own timeout. The parent's `bestPartialAnswer`
    // must still be the grep result, not the child's failure
    // string.
    const sleepMs = 200;
    let parentTurn = 0;
    let childTurn = 0;
    const llm = async (prompt: string): Promise<string> => {
      const isChild =
        prompt.startsWith("You are a sub-LLM invoked") ||
        /Query:\s*sub task/.test(prompt);
      if (isChild) {
        childTurn++;
        // Child sleeps long on every turn so its own timeout
        // (inherited via remaining-budget propagation) trips.
        await sleep(sleepMs);
        return `(grep "X")`;
      }
      parentTurn++;
      if (parentTurn === 1) return `(grep "TOKEN-")`;
      // Turn 2: hand off to a recursive child that will time out.
      // Long sleep then fire rlm_query — pushes parent past its cap.
      await sleep(sleepMs);
      return `(rlm_query "sub task" (context (context 0)))`;
    };

    const result = (await runRLMFromContent(
      "find tokens",
      "TOKEN-A\nTOKEN-B\nTOKEN-C",
      {
        llmClient: llm,
        adapter: createNucleusAdapter(),
        maxTurns: 6,
        ragEnabled: false,
        subRLMMaxDepth: 1,
        maxTimeoutMs: 400,
      }
    )) as string;

    expect(result).toMatch(/aborted/i);
    // The partial MUST be the parent's grep result (TOKEN-*),
    // NOT the child's "[aborted: ...]" string.
    expect(result).toMatch(/TOKEN-/);
    // Defensive: the parent's surface should not contain a NESTED
    // "[aborted:" line (which would be the child's failure
    // pollution showing through).
    const abortMarkers = result.match(/\[aborted:/g);
    expect(abortMarkers ? abortMarkers.length : 0).toBe(1);
  });
});

describe("Phase 5 — backwards compat", () => {
  it("with no limits set, behavior is unchanged from a normal run", async () => {
    let turn = 0;
    const llm = async (_p: string): Promise<string> => {
      turn++;
      if (turn === 1) return `(grep "X")`;
      return `<<<FINAL>>>found<<<END>>>`;
    };
    const result = (await runRLMFromContent("find X", "X\nY\nX", {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: false,
    })) as string;
    expect(typeof result).toBe("string");
    expect(result).toContain("found");
    expect(result).not.toMatch(/aborted/i);
  });
});
