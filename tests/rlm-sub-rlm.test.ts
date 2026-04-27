/**
 * Tests for P3 — Sub-RLM recursion (the paper's true "symbolic recursion").
 *
 * Before P3, `(llm_query …)` dispatched to a flat sub-LLM call — one
 * prompt in, one string out, no Nucleus code execution inside the sub
 * call. That was a useful POC but missed the paper's Ω(|P|) / Ω(|P|²)
 * claim, which depends on each sub-call being able to itself run Nucleus
 * code, access handles, and (transitively) invoke further sub-RLMs.
 *
 * This file locks down the recursive variant:
 *
 *   - A helper `runRLMFromContent(query, content, options)` that runs
 *     the same FSM loop as runRLM but skips the file-read step.
 *   - `RLMOptions.subRLMMaxDepth` — when >0, `(llm_query …)` spawns a
 *     sub-RLM with the interpolated prompt as its document+query pair.
 *     The sub-RLM can itself run Nucleus code, use chunking, invoke
 *     `(llm_query …)` again, etc., up to the depth limit.
 *   - Depth enforcement: past `subRLMMaxDepth`, falls back to flat
 *     sub-LLM call so recursion can't run away.
 *   - Existing `subRLMMaxDepth=0` (default) keeps the current flat
 *     behavior so pre-P3 tests don't regress.
 */

import { describe, it, expect } from "vitest";
import { runRLM, runRLMFromContent } from "../src/rlm.js";
import { createNucleusAdapter } from "../src/adapters/nucleus.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Helper that builds a scripted LLM from a list of responses, recording
 * every prompt for later inspection. Re-entrant: if the script runs out,
 * returns the last response (prevents test deadlocks when the sub-RLM
 * spins a few extra turns).
 */
function scripted(responses: string[], seen: string[]): (p: string) => Promise<string> {
  let idx = 0;
  return async (prompt: string) => {
    seen.push(prompt);
    const r = responses[idx] ?? responses.at(-1) ?? "";
    idx++;
    return r;
  };
}

async function makeFixture(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "matryoshka-subrlm-"));
  const path = join(dir, "doc.txt");
  await writeFile(path, content, "utf-8");
  return path;
}

describe("runRLMFromContent — content-based entry point", () => {
  it("is exported and runs the same FSM loop as runRLM", async () => {
    const seen: string[] = [];
    const llm = scripted(
      [`(grep "ERROR")`, `<<<FINAL>>>found errors<<<END>>>`],
      seen
    );
    const result = await runRLMFromContent(
      "Find errors",
      "INFO: ok\nERROR: boom\nERROR: crash",
      {
        llmClient: llm,
        adapter: createNucleusAdapter(),
        maxTurns: 5,
        ragEnabled: false,
      }
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("found errors");
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});

describe("subRLMMaxDepth — recursive sub-RLM spawn", () => {
  it("default (depth=0) keeps flat sub-LLM behavior — llm_query fires 1 sub-call", async () => {
    // With flat behavior, llm_query delegates directly to the llmClient
    // with a single framed prompt. The sub-LLM sees exactly ONE call
    // per llm_query invocation.
    const seen: string[] = [];
    let subCallCount = 0;
    const llm = async (prompt: string): Promise<string> => {
      seen.push(prompt);
      // Sub-LLM calls are marked by the framing prefix
      if (prompt.startsWith("You are a sub-LLM invoked")) {
        subCallCount++;
        return "flat sub-LLM response";
      }
      // Parent calls
      const turn = seen.filter(p => !p.startsWith("You are a sub-LLM invoked")).length;
      if (turn === 1) return `(llm_query "what is 2+2")`;
      return `<<<FINAL>>>done<<<END>>>`;
    };
    const path = await makeFixture("doc content\nline 2\nline 3");
    const result = await runRLM("ask", path, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: false,
      // subRLMMaxDepth omitted → default 0 → flat behavior
    });
    expect(typeof result).toBe("string");
    expect(subCallCount).toBe(1);
  });

  it("subRLMMaxDepth=1 spawns a sub-RLM that executes its own Nucleus code", async () => {
    // The sub-RLM's document is the interpolated prompt. With
    // subRLMMaxDepth=1, we get one level of recursion: the parent runs
    // its FSM, issues llm_query, the sub-RLM runs ITS OWN FSM loop
    // (multiple calls to llmClient), and returns a string.
    //
    // The sub-RLM is detected via its distinctive user-message prefix
    // "Analyze and answer based on" — that string is injected by the
    // spawner (see rlm.ts subRLMSpawner) into the sub-RLM's user
    // message and persists through its history, but never appears in
    // the parent's history because the parent's query and Nucleus
    // code don't contain it.
    //
    // Parent flow: grep → llm_query → final.
    // Sub-RLM flow: (inside llm_query) grep → final.
    const allCalls: Array<{ role: "parent" | "child"; turn: number }> = [];
    let parentTurn = 0;
    let childTurn = 0;

    const llm = async (prompt: string): Promise<string> => {
      const isChild = prompt.includes("Analyze and answer based on");
      if (isChild) {
        childTurn++;
        allCalls.push({ role: "child", turn: childTurn });
        // Inside the sub-RLM, the document is the interpolated prompt.
        // The sub-RLM runs its own grep over it.
        if (childTurn === 1) return `(grep "ERROR")`;
        return `<<<FINAL>>>child found errors<<<END>>>`;
      }
      parentTurn++;
      allCalls.push({ role: "parent", turn: parentTurn });
      if (parentTurn === 1) return `(grep "ERROR")`;
      if (parentTurn === 2) {
        return `(llm_query "inspect these: {items}" (items RESULTS))`;
      }
      return `<<<FINAL>>>parent done<<<END>>>`;
    };

    const path = await makeFixture(
      "ERROR: one\nWARN: a\nERROR: two\nWARN: b\nINFO: ok"
    );
    const result = await runRLM("inspect logs", path, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: false,
      subRLMMaxDepth: 1,
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("parent done");
    // The sub-RLM must have run at least 2 turns (its own loop).
    const childCalls = allCalls.filter(c => c.role === "child");
    expect(childCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("propagates onProgress to spawned sub-RLMs with correct depth", async () => {
    // Sub-RLMs block the parent's FSM while they run. Without progress
    // propagation a 25-turn child × 30s/turn = 12.5 min of silence,
    // which trips the MCP client's 10min request cap mid-recursion.
    // Verify: (a) parent emits depth=0, (b) child emits depth=1.
    let parentTurn = 0;
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.includes("Analyze and answer based on")) {
        // Child runs a single turn then finalizes — minimal but enough
        // to confirm a depth=1 progress fires.
        return `<<<FINAL>>>child done<<<END>>>`;
      }
      parentTurn++;
      if (parentTurn === 1) {
        return `(llm_query "inspect: hello")`;
      }
      return `<<<FINAL>>>parent done<<<END>>>`;
    };

    const progressEvents: Array<{ depth: number; turn: number }> = [];
    const result = await runRLMFromContent(
      "spawn a sub-RLM and observe progress depth",
      "doc payload",
      {
        llmClient: llm,
        adapter: createNucleusAdapter(),
        maxTurns: 5,
        ragEnabled: false,
        subRLMMaxDepth: 1,
        onProgress: (info) => {
          progressEvents.push({ depth: info.depth, turn: info.turn });
        },
      }
    );

    expect(typeof result).toBe("string");
    // Parent must have fired at least once at depth 0.
    expect(progressEvents.some((e) => e.depth === 0)).toBe(true);
    // Sub-RLM must have fired at least once at depth 1.
    expect(progressEvents.some((e) => e.depth === 1)).toBe(true);
  });

  it("subRLMMaxDepth enforces a depth cap — falls back to flat at the boundary", async () => {
    // With subRLMMaxDepth=1, the FIRST sub-RLM runs a full FSM loop. Any
    // llm_query from inside that sub-RLM (depth=2) must fall back to
    // flat behavior — the flat llmQuery wraps the prompt with the
    // "You are a sub-LLM invoked" framing string, which we detect here
    // to distinguish it from the recursive sub-RLM user message prefix
    // "Analyze and answer based on".
    const callLog: Array<{ role: string; head: string }> = [];
    const llm = async (prompt: string): Promise<string> => {
      const role =
        prompt.startsWith("You are a sub-LLM invoked")
          ? "flat_leaf"  // depth 2 flat fallback
          : prompt.includes("Analyze and answer based on")
            ? "recursive_child"  // depth 1 sub-RLM
            : "root";
      callLog.push({ role, head: prompt.slice(0, 60) });

      if (role === "root") {
        const rootTurn = callLog.filter(c => c.role === "root").length;
        if (rootTurn === 1) return `(grep "foo")`;
        if (rootTurn === 2) return `(llm_query "level1-payload: {items}" (items RESULTS))`;
        return `<<<FINAL>>>root done<<<END>>>`;
      }
      if (role === "recursive_child") {
        const d1Turn = callLog.filter(c => c.role === "recursive_child").length;
        if (d1Turn === 1) return `(grep "foo")`;
        // Sub-RLM at depth 1 tries to spawn ANOTHER sub-RLM
        if (d1Turn === 2) return `(llm_query "level2-payload: {x}" (x RESULTS))`;
        return `<<<FINAL>>>depth1 done<<<END>>>`;
      }
      // flat_leaf — only fires once per llm_query invocation (no FSM loop).
      return "flat depth2 response";
    };

    const path = await makeFixture("foo\nfoo\nfoo");
    await runRLM("recursive depth test", path, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 10,
      ragEnabled: false,
      subRLMMaxDepth: 1,
    });

    const flatLeafCalls = callLog.filter(c => c.role === "flat_leaf");
    const recursiveChildCalls = callLog.filter(c => c.role === "recursive_child");
    // The sub-RLM should have run a full FSM loop (multiple turns).
    expect(recursiveChildCalls.length).toBeGreaterThanOrEqual(2);
    // And its attempt to spawn a second level should have fallen back
    // to a single flat sub-LLM call, not a new FSM loop.
    expect(flatLeafCalls.length).toBe(1);
  });

  it("the sub-RLM can use chunking primitives over the interpolated prompt", async () => {
    // The paper's killer demo: the sub-RLM chunks its input and runs
    // Nucleus code over the chunks. We test composability: chunking
    // primitives work inside a sub-RLM's own FSM loop.
    const parentCalls: string[] = [];
    const subCalls: string[] = [];
    const llm = async (prompt: string): Promise<string> => {
      const isChild = prompt.includes("Analyze and answer based on");
      if (isChild) {
        subCalls.push(prompt);
        if (subCalls.length === 1) return `(count (chunk_by_lines 2))`;
        return `<<<FINAL>>>sub counted chunks<<<END>>>`;
      }
      parentCalls.push(prompt);
      const p = parentCalls.length;
      if (p === 1) return `(grep "key")`;
      if (p === 2) return `(llm_query "inspect: {x}" (x RESULTS))`;
      return `<<<FINAL>>>parent received report<<<END>>>`;
    };

    const path = await makeFixture(
      "key: alpha\nkey: beta\nkey: gamma\nkey: delta"
    );
    const result = await runRLM("chunk test", path, {
      llmClient: llm,
      adapter: createNucleusAdapter(),
      maxTurns: 5,
      ragEnabled: false,
      subRLMMaxDepth: 1,
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("parent received report");
    // The sub-RLM must have run code on its own (at least 2 sub calls).
    expect(subCalls.length).toBeGreaterThanOrEqual(2);
  });
});
