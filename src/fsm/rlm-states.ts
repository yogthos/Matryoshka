/**
 * RLM FSM State Definitions
 *
 * Defines the context, states, handlers, and transition predicates
 * for the RLM execution loop as an explicit finite state machine.
 */

import type { ModelAdapter } from "../adapters/types.js";
import type { SynthesisConstraint } from "../constraints/types.js";
import type { RAGManager } from "../rag/manager.js";
import type { SolverTools, Bindings } from "../logic/lc-solver.js";
import type { FSMSpec, State } from "repl-sandbox";

import { parse as parseLC } from "../logic/lc-parser.js";
import { isClassifyTerm, validateClassifyExamples } from "../logic/lc-compiler.js";
import { inferType, typeToString } from "../logic/type-inference.js";
import { solve as solveTerm } from "../logic/lc-solver.js";
import { analyzeExecution, getEncouragement } from "../feedback/execution-feedback.js";
import { verifyResult } from "../constraints/verifier.js";
import { generateClassifierGuidance } from "../rlm.js";
import type { LLMQueryFn } from "../llm/types.js";

// ===== CONTEXT =====

/**
 * Payload reported by the optional onProgress callback. Fires after the
 * per-turn limit checks pass (so we don't ping for turns that abort
 * immediately) and on out-of-band heartbeats from the MCP layer when a
 * single LLM call is taking longer than the client cap. The MCP server
 * translates each fire into a `notifications/progress` ping that keeps
 * the client's request timer alive during long synthesis runs.
 *
 * `depth` reflects the sub-RLM nesting level (0 = top-level run); kept
 * here so the bridging layer can render it into the user-visible
 * message and so monotonicity can be enforced at a single seam (the
 * MCP server uses its own counter — turn numbers from nested children
 * would otherwise rewind relative to the parent).
 */
export interface ProgressInfo {
  turn: number;
  maxTurns: number;
  elapsedMs: number;
  depth: number;
  phase: "turn-start" | "heartbeat";
}

export interface RLMContext {
  // Immutable config
  query: string;
  adapter: ModelAdapter;
  llmClient: LLMQueryFn;
  solverTools: SolverTools;
  constraint?: SynthesisConstraint;
  ragManager?: RAGManager;
  sessionId: string;
  maxTurns: number;
  log: (msg: string) => void;
  /**
   * Optional callback fired after each turn's limit checks pass. Used
   * by the MCP server to emit `notifications/progress` so the client's
   * request timer resets while a long synthesis run is still making
   * progress. Errors thrown by the callback are swallowed — progress
   * reporting is best-effort and must not interfere with the FSM loop.
   */
  onProgress?: (info: ProgressInfo) => void;
  /**
   * Sub-RLM nesting depth, threaded through from `RLMOptions._subRLMDepth`.
   * 0 = top-level run; >0 = spawned by a parent's `(llm_query …)` or
   * `(rlm_query …)`. Reported via `ProgressInfo.depth` so the MCP layer
   * can label notifications and (with a separate monotonic counter)
   * keep the client's progress field strictly increasing across nested
   * runs.
   */
  subRLMDepth: number;

  // Mutable state
  turn: number;
  history: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  solverBindings: Bindings;
  /**
   * Per-binding provenance — the raw LC source of the term that produced
   * each binding. Populated in `handleExecute` from `ctx.extractedCode`
   * and surfaced to the LLM in the "Bindings available" section of the
   * analysis feedback. Without this, opaque names like `_3` carry no
   * semantic information across turns, which matters a lot once sub-LLM
   * calls chain together (a later `(llm_query …)` needs to know what
   * `_3` contains to reference it sensibly).
   */
  solverBindingProvenance: Map<string, string>;

  // Turn-specific (reset each turn)
  response: string;
  extractedCode: string | null;
  parsedTerm: import("../logic/types.js").LCTerm | null;
  parseError: string | null;
  typeValid: boolean;
  solverResult: { success: boolean; value: unknown; logs: string[]; error?: string } | null;

  // Cross-turn tracking
  codeExecuted: boolean;
  lastExecutionHadError: boolean;
  lastOutputWasUnhelpful: boolean;
  doneCount: number;
  noCodeCount: number;
  lastCode: string;
  lastMeaningfulOutput: string;
  lastResultCount: number;
  previousResultCount: number;

  // Phase 5 — resource limits + tracking. All optional; when unset
  // the corresponding check is skipped and behavior matches pre-
  // Phase-5. When set and exceeded, handleCheckLimits sets `result`
  // to a partial-answer abort string starting with "[aborted: ...]".
  maxTimeoutMs?: number;
  maxTokens?: number;
  maxErrors?: number;
  startTime: number;
  totalTokens: number;
  consecutiveErrors: number;
  /**
   * Counts consecutive LLM-client throws (auth failure, network error,
   * bad URL). Reset to 0 after a successful LLM call. When it reaches
   * `MAX_CONSECUTIVE_LLM_ERRORS`, the FSM aborts with the original
   * error message in the abort string. Without this, an unrecoverable
   * config error (e.g., invalid API key) would silently retry until
   * maxTurns and surface as "max turns reached" — masking the real
   * cause.
   */
  consecutiveLlmErrors: number;
  lastLlmError: string;
  compactionThresholdChars?: number;
  compactionCount: number;
  /**
   * Number of consecutive compaction failures (e.g., the summarize
   * llm call threw). Once this hits the cap, we stop attempting
   * compaction for the rest of the run — otherwise a failing
   * summarize call would loop on every turn since the threshold
   * check never advances. Per project rule (correctness >
   * performance): better to let the run hit its other limits
   * cleanly than to spin in the compaction loop forever.
   */
  compactionFailures: number;
  /**
   * Phase 5 — most recent meaningful solver result, formatted as a
   * string. Populated unconditionally after every successful solver
   * call (not gated by the same heuristics as
   * `lastMeaningfulOutput`, which is filtered for stuck-pattern
   * detection). Used by `formatAbort` so a limit-triggered exit
   * always surfaces the best work-in-progress instead of "(none)".
   */
  bestPartialAnswer: string;

  // Termination
  result: string | null;
}

// ===== HELPERS =====

const MAX_HISTORY_ENTRIES = 40;

/**
 * Hard cap on consecutive LLM-client throws. Independent of the
 * user-configurable `maxErrors` (which counts solver/parse errors).
 * 3 is tight on purpose: auth failures and bad URLs are deterministic,
 * not transient, so retrying past a small handful is just delaying the
 * inevitable. A real network blip recovers within 1-2 retries.
 */
const MAX_CONSECUTIVE_LLM_ERRORS = 3;

function pruneHistory(history: RLMContext["history"]): void {
  while (history.length > MAX_HISTORY_ENTRIES) {
    if (history.length > 3 && history[2]?.role === "assistant" && history[3]?.role === "user") {
      history.splice(2, 2);
    } else if (history.length > 3 && history[2]?.role === "user" && history[3]?.role === "assistant") {
      history.splice(2, 2);
    } else {
      if (history.length <= 2) break;
      history.splice(2, Math.min(2, history.length - 2));
      if (history.length > MAX_HISTORY_ENTRIES) break;
    }
  }
}

function truncate(s: string, max: number = 4000): string {
  if (s.length <= max) return s;
  const half = Math.max(0, Math.floor(max / 2) - 20);
  if (half === 0) return s.slice(0, max);
  return s.slice(0, half) + `\n... [${s.length - max} chars truncated] ...\n` + s.slice(-half);
}

/**
 * Expand `FINAL_VAR(name)` markers in a final-answer string by looking up
 * `name` in the solver bindings and substituting in the serialized value.
 *
 * This lets the LLM close the loop without inlining a large binding into
 * its <<<FINAL>>> payload:
 *
 *   <<<FINAL>>>FINAL_VAR(_2)<<<END>>>
 *   <<<FINAL>>>Here are the results: FINAL_VAR(RESULTS) — done<<<END>>>
 *
 * Design choices:
 *   - Unknown bindings are left in place. Silent stripping would hide a
 *     real mistake (references to a binding that never existed); leaving
 *     the marker makes the error obvious to the user without crashing.
 *   - Arrays / objects are JSON.stringified; strings pass through
 *     unchanged; numbers and booleans are coerced via String().
 *   - Each expansion is capped at MAX_FINAL_VAR_EXPANSION bytes to
 *     protect downstream consumers from pathological payloads. A cap
 *     here is safer than removing it — the whole point of the feature
 *     is to let the LLM reference large data, but "large" should not
 *     mean unbounded.
 *   - The regex only accepts identifier-shaped names, rejecting weird
 *     cases like `FINAL_VAR(../../etc/passwd)` before they hit the
 *     binding lookup.
 */
const FINAL_VAR_REGEX = /FINAL_VAR\(([A-Za-z_]\w*)\)/g;
const MAX_FINAL_VAR_EXPANSION = 500_000;

function expandFinalVar(answer: string, bindings: Bindings): string {
  // Fast-path: no marker → return original string untouched, avoiding
  // a regex allocation on the hot path where every final answer flows
  // through this helper.
  if (!answer.includes("FINAL_VAR(")) return answer;

  return answer.replace(FINAL_VAR_REGEX, (_match, name: string) => {
    if (!bindings.has(name)) {
      // Unknown binding: surface a clear error string instead of
      // the literal `FINAL_VAR(name)` so callers (and the user)
      // can DETECT the failure. Silent pass-through let an
      // unresolved marker flow through as if it were an answer
      // — a real correctness bug for child→parent FINAL_VAR
      // round-trips. Per project rule: correctness > performance.
      const available = [...bindings.keys()].slice(0, 8).join(", ");
      const more = bindings.size > 8 ? `, ...+${bindings.size - 8} more` : "";
      return (
        `[FINAL_VAR error: unknown binding "${name}". ` +
        `Available: ${available || "(none)"}${more}]`
      );
    }
    const value = bindings.get(name);
    let serialized: string;
    if (typeof value === "string") {
      serialized = value;
    } else if (value === null || value === undefined) {
      serialized = String(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      serialized = String(value);
    } else {
      try {
        serialized = JSON.stringify(value, null, 2);
      } catch {
        serialized = String(value);
      }
    }
    if (serialized.length > MAX_FINAL_VAR_EXPANSION) {
      serialized =
        serialized.slice(0, MAX_FINAL_VAR_EXPANSION) +
        `\n…[truncated ${serialized.length - MAX_FINAL_VAR_EXPANSION} chars]`;
    }
    return serialized;
  });
}

interface VerificationResult {
  valid: boolean;
  result: string;
  feedback: string;
}

function verifyAndReturnResult(
  result: unknown,
  constraint: SynthesisConstraint | undefined,
  log: (msg: string) => void
): VerificationResult {
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);
  if (!constraint) {
    return { valid: true, result: resultStr, feedback: "" };
  }
  const verification = verifyResult(resultStr, constraint);
  if (verification.valid) {
    log(`[RLM] Result passed constraint verification`);
    return { valid: true, result: resultStr, feedback: "" };
  }
  log(`[RLM] Result FAILED constraint verification`);
  return {
    valid: false,
    result: resultStr,
    feedback: `Result "${resultStr}" violates output constraints. Re-examine the data and try again.`,
  };
}

/**
 * Phase 5 — render a partial-answer abort string. The format is
 * "[aborted: REASON DETAIL]\n\nBest partial answer:\n<content>" so
 * a parent rlm_query receives a single string it can either inline
 * or detect via the "[aborted:" prefix. Per project rule
 * (correctness > performance): never silently swallow completed
 * work — the partial answer is always surfaced when present.
 */
function formatAbort(
  reason: "timeout" | "tokens" | "errors" | "llm",
  detail: string,
  ctx: RLMContext
): string {
  const partial =
    ctx.bestPartialAnswer || ctx.lastMeaningfulOutput || "(none)";
  return `[aborted: ${reason} ${detail}]\n\nBest partial answer:\n${partial}`;
}

/**
 * Phase 6 — render the prompt the FSM would send to the LLM right
 * now. Used to measure prompt size for compaction decisions before
 * the actual handleQueryLLM build step. Kept in sync with that
 * builder by literally being the same join.
 */
function renderPrompt(history: RLMContext["history"]): string {
  return history.map((h) => `${h.role.toUpperCase()}: ${h.content}`).join("\n\n");
}

/**
 * Phase 6 — summarize turns 2..N into a single assistant message
 * and trim the history to [system, first user, summary, latest
 * user-feedback turn]. Stashes the full pre-compaction history as
 * the `_compaction_trace` solver binding so a follow-up
 * `FINAL_VAR(_compaction_trace)` can retrieve it.
 *
 * Re-entrant via `compactionCount`: the binding name carries the
 * count when there are multiple events
 * (`_compaction_trace_2`, etc.) so a third compaction doesn't
 * destroy the previously stashed trace.
 *
 * Heuristic: keep the most recent ASSISTANT response and any user
 * feedback that came AFTER it untouched, so the LLM still sees the
 * latest action and result on the next turn. Earlier turns are
 * folded into the summary.
 */
async function compactHistory(ctx: RLMContext): Promise<void> {
  if (ctx.history.length < 4) return; // nothing useful to compact

  // Stash the full pre-compaction history first so it can be
  // recovered later. Render as a string for FINAL_VAR consumption.
  const traceText = ctx.history
    .map((h) => `[${h.role}] ${h.content}`)
    .join("\n---\n");
  const stashName =
    ctx.compactionCount === 0
      ? "_compaction_trace"
      : `_compaction_trace_${ctx.compactionCount + 1}`;
  ctx.solverBindings.set(stashName, traceText);

  // Prepare the summarization prompt. We send the FULL prior
  // history wrapped in an instruction asking for a tight summary
  // that preserves intermediate values + binding names, so the
  // post-compaction LLM can reference earlier work.
  const historyText = ctx.history
    .slice(2) // skip system + initial user (kept verbatim)
    .map((h) => `[${h.role}] ${h.content}`)
    .join("\n");
  const summarizePrompt =
    "Summarize your progress so far. Include: " +
    "(1) which steps/sub-tasks you completed; " +
    "(2) any concrete intermediate results (counts, matches, " +
    "binding names like RESULTS or _N) — preserve these exactly; " +
    "(3) what your next action should be. " +
    "Be concise (1-3 paragraphs). Conversation:\n" +
    historyText;

  ctx.log(
    `[Compaction #${ctx.compactionCount + 1}] firing — history is ${
      historyText.length
    } chars`
  );
  let summary: string;
  try {
    summary = await ctx.llmClient(summarizePrompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[Compaction] summarization failed: ${msg} — skipping compaction`);
    // Roll back the stash; if we couldn't summarize, leaving the
    // binding around could mislead.
    ctx.solverBindings.delete(stashName);
    ctx.compactionFailures++;
    return;
  }

  // Replace history[2..N] with the summary. Keep system + initial
  // user verbatim. Future turns build on this trimmed shape.
  const system = ctx.history[0];
  const initialUser = ctx.history[1];
  ctx.history = [
    system,
    initialUser,
    {
      role: "assistant",
      content: `Summary (after compaction #${ctx.compactionCount + 1}):\n${summary}`,
    },
    {
      role: "user",
      content:
        "The conversation above has been compacted. " +
        "Continue from the summary. Do NOT repeat completed work; " +
        "the binding names and intermediate values mentioned in the " +
        "summary are still available via the solver bindings. " +
        "Your next action:",
    },
  ];
  ctx.compactionCount++;
}

// ===== STATE HANDLERS =====

async function handleQueryLLM(ctx: RLMContext): Promise<RLMContext> {
  ctx.turn++;
  ctx.log(`\n${"─".repeat(50)}`);
  ctx.log(`[Turn ${ctx.turn}/${ctx.maxTurns}] Querying LLM...`);

  // Phase 5 — pre-call limit checks. Hitting any limit terminates
  // the loop with a partial-answer abort string. The check runs
  // BEFORE the LLM call so we don't waste a round-trip after the
  // ceiling is crossed. Limits skipped when not configured (back-
  // compat).
  if (ctx.maxTimeoutMs !== undefined) {
    const elapsed = Date.now() - ctx.startTime;
    if (elapsed > ctx.maxTimeoutMs) {
      ctx.result = formatAbort("timeout", `${elapsed}ms of ${ctx.maxTimeoutMs}ms`, ctx);
      ctx.log(`[Turn ${ctx.turn}] Aborting — timeout (${elapsed}ms)`);
      return ctx;
    }
  }
  if (ctx.maxTokens !== undefined && ctx.totalTokens > ctx.maxTokens) {
    ctx.result = formatAbort(
      "tokens",
      `${ctx.totalTokens} of ${ctx.maxTokens} chars`,
      ctx
    );
    ctx.log(`[Turn ${ctx.turn}] Aborting — token cap (${ctx.totalTokens})`);
    return ctx;
  }
  if (
    ctx.maxErrors !== undefined &&
    ctx.consecutiveErrors >= ctx.maxErrors
  ) {
    ctx.result = formatAbort(
      "errors",
      `${ctx.consecutiveErrors} consecutive`,
      ctx
    );
    ctx.log(
      `[Turn ${ctx.turn}] Aborting — error cap (${ctx.consecutiveErrors} consecutive)`
    );
    return ctx;
  }

  // Limit checks have passed — fire a progress ping before the LLM
  // round-trip (which is the longest-blocking step in a turn). This
  // resets the MCP client's request timer; without it, long synthesis
  // runs hit the client cap mid-turn and the result is discarded.
  if (ctx.onProgress) {
    try {
      ctx.onProgress({
        turn: ctx.turn,
        maxTurns: ctx.maxTurns,
        elapsedMs: Date.now() - ctx.startTime,
        depth: ctx.subRLMDepth,
        phase: "turn-start",
      });
    } catch {
      // Best-effort — never let a misbehaving progress sink break the FSM.
    }
  }

  // Phase 6 — check whether the next prompt would exceed the
  // compaction threshold. When it would, summarize prior turns
  // first so the actual LLM call sees a smaller history. Skipped
  // when the threshold is unset (back-compat) OR when prior
  // compaction attempts have failed too many times — letting the
  // run hit other limits cleanly is better than spinning forever
  // in a failing compaction loop (a failing summarize call
  // doesn't shrink history, so the threshold check would re-fire
  // on every turn).
  const COMPACTION_FAILURE_CAP = 2;
  if (
    ctx.compactionThresholdChars !== undefined &&
    ctx.compactionFailures < COMPACTION_FAILURE_CAP
  ) {
    const projected = renderPrompt(ctx.history);
    if (projected.length > ctx.compactionThresholdChars) {
      await compactHistory(ctx);
    }
  }

  const prompt = renderPrompt(ctx.history);
  ctx.totalTokens += prompt.length;
  let response: string;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    // Phase 5 — race the LLM call against the remaining timeout
    // budget. Without this, a hung call stays hung past the cap;
    // the pre-call check at the top of the NEXT turn never runs
    // because the FSM is blocked on this await. Only triggers when
    // maxTimeoutMs is configured.
    if (ctx.maxTimeoutMs !== undefined) {
      const remaining = ctx.maxTimeoutMs - (Date.now() - ctx.startTime);
      if (remaining <= 0) {
        ctx.result = formatAbort("timeout", `${ctx.maxTimeoutMs}ms`, ctx);
        return ctx;
      }
      response = await Promise.race([
        ctx.llmClient(prompt),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("__RLM_TIMEOUT__")),
            remaining
          );
        }),
      ]);
    } else {
      response = await ctx.llmClient(prompt);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg === "__RLM_TIMEOUT__") {
      const elapsed = Date.now() - ctx.startTime;
      ctx.result = formatAbort(
        "timeout",
        `${elapsed}ms of ${ctx.maxTimeoutMs}ms`,
        ctx
      );
      ctx.log(`[Turn ${ctx.turn}] Aborting — timeout hit during LLM call`);
      return ctx;
    }
    ctx.consecutiveLlmErrors++;
    ctx.lastLlmError = errMsg;
    ctx.log(`[Turn ${ctx.turn}] LLM error: ${errMsg}`);
    if (ctx.consecutiveLlmErrors >= MAX_CONSECUTIVE_LLM_ERRORS) {
      ctx.result = formatAbort(
        "llm",
        `${ctx.consecutiveLlmErrors} consecutive LLM call failures: ${errMsg}`,
        ctx
      );
      ctx.log(
        `[Turn ${ctx.turn}] Aborting — ${ctx.consecutiveLlmErrors} consecutive LLM call failures`
      );
      return ctx;
    }
    ctx.history.push({
      role: "user",
      content: `LLM call failed: ${errMsg}. Please try again.`,
    });
    ctx.noCodeCount++;
    return ctx;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  ctx.consecutiveLlmErrors = 0;
  ctx.totalTokens += response.length;

  if (!response) {
    ctx.result = `Error: LLM returned empty response at turn ${ctx.turn}`;
    return ctx;
  }

  ctx.response = response;
  ctx.history.push({ role: "assistant", content: response });
  pruneHistory(ctx.history);

  // Reset turn-specific state
  ctx.extractedCode = ctx.adapter.extractCode(response);
  ctx.parsedTerm = null;
  ctx.parseError = null;
  ctx.typeValid = false;
  ctx.solverResult = null;

  ctx.log(`[Turn ${ctx.turn}] LLM response:`);
  ctx.log(response.slice(0, 500));
  if (ctx.extractedCode) {
    ctx.log(`[Turn ${ctx.turn}] Extracted Nucleus: ${ctx.extractedCode}`);
  }

  return ctx;
}

function handleParseResponse(ctx: RLMContext): RLMContext {
  if (!ctx.extractedCode) {
    ctx.log(`[Turn ${ctx.turn}] No Nucleus command extracted`);
    ctx.noCodeCount++;
    // Phase 5 — a response with no extractable code counts toward
    // the consecutive-error budget. Without this, an LLM stuck
    // emitting prose instead of S-expressions would never trip
    // maxErrors and would just run to maxTurns. Reset is wherever
    // a successful execution clears consecutiveErrors.
    ctx.consecutiveErrors++;
    return ctx;
  }

  // Check for <<<FINAL>>> inside code block
  const finalInCode = ctx.extractedCode.match(/<<<FINAL>>>([\s\S]*?)<<<END>>>/);
  if (finalInCode) {
    ctx.log(`[Turn ${ctx.turn}] Found final answer inside code block`);
    if (!ctx.codeExecuted) {
      ctx.log(`[Turn ${ctx.turn}] Rejecting - no code executed yet`);
      ctx.history.push({
        role: "user",
        content: `You put <<<FINAL>>> inside the code block. First run code to get the answer, then put <<<FINAL>>> OUTSIDE the code block.`,
      });
      ctx.extractedCode = null; // Skip further processing
      return ctx;
    }
    const extractedAnswer = finalInCode[1].trim();
    const looksLikeCode = /console\.log|function\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|\);|\(\s*["']/.test(extractedAnswer);
    if (looksLikeCode) {
      ctx.log(`[Turn ${ctx.turn}] Rejecting - extracted content looks like code, not an answer`);
      ctx.history.push({
        role: "user",
        content: `ERROR: You put <<<FINAL>>> markers inside your code/strings, not after the code block.\n\nThe FINAL markers must be OUTSIDE and AFTER your code block:\n\`\`\`javascript\nconsole.log("done");\n\`\`\`\n<<<FINAL>>>\nYour actual answer here (plain text, not code)\n<<<END>>>\n\nTry again with proper formatting.`,
      });
      ctx.extractedCode = null;
      return ctx;
    }
    const verification = verifyAndReturnResult(extractedAnswer, ctx.constraint, ctx.log);
    ctx.result = verification.valid ? verification.result : extractedAnswer;
    return ctx;
  }

  ctx.codeExecuted = true;
  ctx.noCodeCount = 0;

  // Check for repeated code
  const trimmedCode = ctx.extractedCode.trim();
  if (trimmedCode.length > 0 && trimmedCode === ctx.lastCode.trim()) {
    ctx.log(`[Turn ${ctx.turn}] WARNING: Repeated code detected`);
    ctx.history.push({ role: "user", content: ctx.adapter.getRepeatedCodeFeedback(ctx.lastResultCount) });
    ctx.extractedCode = null;
    return ctx;
  }
  ctx.lastCode = ctx.extractedCode;

  return ctx;
}

function handleValidate(ctx: RLMContext): RLMContext {
  if (!ctx.extractedCode) return ctx;

  ctx.log(`[Turn ${ctx.turn}] Parsing LC term...`);
  const lcResult = parseLC(ctx.extractedCode);

  if (!lcResult.success || !lcResult.term) {
    ctx.log(`[Turn ${ctx.turn}] LC parse error: ${lcResult.error}`);
    ctx.parseError = lcResult.error || "Parse error";
    // Phase 5 — parse errors count toward the consecutive-error
    // budget. Without this, an LLM stuck in a syntax-error loop
    // would never trip maxErrors.
    ctx.consecutiveErrors++;
    ctx.history.push({
      role: "user",
      content: ctx.adapter.getErrorFeedback(ctx.parseError, ctx.extractedCode),
    });
    return ctx;
  }

  ctx.parsedTerm = lcResult.term;
  ctx.log(`[Turn ${ctx.turn}] LC term parsed successfully`);

  const typeResult = inferType(lcResult.term);
  if (!typeResult.valid) {
    ctx.log(`[Turn ${ctx.turn}] Type inference failed: ${typeResult.error}`);
    ctx.history.push({
      role: "user",
      content: `Type error: ${typeResult.error}\n\nCheck your LC term structure.`,
    });
    ctx.parsedTerm = null;
    return ctx;
  }

  ctx.typeValid = true;
  if (typeResult.type) {
    ctx.log(`[Turn ${ctx.turn}] Inferred type: ${typeToString(typeResult.type)}`);
  }

  // Validate classify examples
  if (isClassifyTerm(lcResult.term)) {
    const prevLogs = ctx.history
      .filter((h) => h.role === "user" && h.content.includes("Logs:"))
      .flatMap((h) => h.content.split("\n"));
    const validationError = validateClassifyExamples(lcResult.term, prevLogs);
    if (validationError) {
      ctx.log(`[Turn ${ctx.turn}] Classify validation error: ${validationError}`);
      ctx.history.push({
        role: "user",
        content: `ERROR: ${validationError}\n\nCopy the EXACT lines from the grep output above.`,
      });
      ctx.parsedTerm = null;
      return ctx;
    }
  }

  return ctx;
}

async function handleExecute(ctx: RLMContext): Promise<RLMContext> {
  if (!ctx.parsedTerm || !ctx.extractedCode) return ctx;

  ctx.log(`[Turn ${ctx.turn}] Executing LC term with solver...`);
  ctx.log(`[Turn ${ctx.turn}] Term: ${ctx.extractedCode}`);
  if (ctx.solverBindings.size > 0) {
    ctx.log(`[Turn ${ctx.turn}] Available bindings: ${[...ctx.solverBindings.keys()].join(", ")}`);
  }

  // solve() is fully async — it handles `(llm_query …)` both at the
  // top level and inside nested map/filter/reduce lambdas, dispatching
  // via `tools.llmQuery` when available.
  const solverResult = await solveTerm(ctx.parsedTerm, ctx.solverTools, ctx.solverBindings);
  ctx.solverResult = {
    success: solverResult.success,
    value: solverResult.value,
    logs: solverResult.logs,
    error: solverResult.success ? undefined : solverResult.error,
  };

  // Bind result for next turn
  if (solverResult.success && solverResult.value !== null && solverResult.value !== undefined) {
    ctx.solverBindings.set(`_${ctx.turn}`, solverResult.value);

    // Record provenance — the raw LC source the LLM emitted this turn.
    // This is what makes `_N` descriptive across turns: the next
    // "Bindings available" section shows each name next to the code
    // that produced it, so the LLM doesn't have to remember what `_3`
    // was for.
    const MAX_PROVENANCE_LEN = 160;
    const provenance = (ctx.extractedCode || "").length > MAX_PROVENANCE_LEN
      ? (ctx.extractedCode || "").slice(0, MAX_PROVENANCE_LEN) + "…"
      : (ctx.extractedCode || "");
    ctx.solverBindingProvenance.set(`_${ctx.turn}`, provenance);

    if (Array.isArray(solverResult.value)) {
      const MAX_RESULTS_SIZE = 100000;
      const cappedValue = solverResult.value.length > MAX_RESULTS_SIZE
        ? solverResult.value.slice(0, MAX_RESULTS_SIZE)
        : solverResult.value;
      ctx.solverBindings.set("RESULTS", cappedValue);
      // RESULTS always reflects the most recent array binding — its
      // provenance is whatever produced this turn's result.
      ctx.solverBindingProvenance.set("RESULTS", provenance);
      ctx.previousResultCount = ctx.lastResultCount;
      ctx.lastResultCount = cappedValue.length;
      ctx.log(`[Turn ${ctx.turn}] Bound result to RESULTS and _${ctx.turn}`);
    } else {
      ctx.log(`[Turn ${ctx.turn}] Bound scalar result to _${ctx.turn} (RESULTS preserved)`);
    }

    // Evict old bindings
    const MAX_SOLVER_BINDINGS = 200;
    if (ctx.solverBindings.size > MAX_SOLVER_BINDINGS) {
      const keys = [...ctx.solverBindings.keys()];
      const turnKeys = keys.filter(k => /^_\d+$/.test(k))
        .sort((a, b) => {
          const aNum = parseInt(a.slice(1), 10);
          const bNum = parseInt(b.slice(1), 10);
          if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) return 0;
          return aNum - bNum;
        });
      const nonTurnCount = keys.length - turnKeys.length;
      const maxTurnKeys = Math.max(1, MAX_SOLVER_BINDINGS - nonTurnCount);
      const toRemove = turnKeys.slice(0, Math.max(0, turnKeys.length - maxTurnKeys));
      for (const key of toRemove) {
        ctx.solverBindings.delete(key);
        // Keep provenance in lockstep so we never surface a stub for a
        // binding that has already been evicted from the values map.
        ctx.solverBindingProvenance.delete(key);
      }
    }
  } else {
    ctx.previousResultCount = ctx.lastResultCount;
    ctx.lastResultCount = 0;
  }

  return ctx;
}

function handleAnalyze(ctx: RLMContext): RLMContext {
  if (!ctx.solverResult) return ctx;

  const result = ctx.solverResult;
  let feedback = `Turn ${ctx.turn} Sandbox execution:\n`;

  if (result.logs.length > 0) {
    ctx.log(`[Turn ${ctx.turn}] Console output:`);
    result.logs.forEach(l => ctx.log(`  ${l}`));
    const logsText = result.logs.join("\n");
    feedback += `Logs:\n${truncate(logsText)}\n`;

    const executionFeedback = analyzeExecution({
      code: ctx.extractedCode || "",
      logs: result.logs,
      error: result.error,
      turn: ctx.turn,
    });

    if (executionFeedback) {
      ctx.log(`[Turn ${ctx.turn}] Detected issue: ${executionFeedback.type}`);
      feedback += `\n${executionFeedback.message}\n`;
      feedback += `\n${getEncouragement(ctx.turn, ctx.maxTurns)}\n`;
    }

    // Track meaningful output vs stuck patterns
    const isDoneOnly = result.logs.length === 1 && result.logs[0].toLowerCase().trim() === "done";
    const isRepeatedOutput = logsText === ctx.lastMeaningfulOutput;
    const hasObjectObject = logsText.includes("[object Object]");
    const isUnhelpfulOutput = hasObjectObject || isDoneOnly || (executionFeedback?.shouldReject ?? false);

    if (isUnhelpfulOutput || isRepeatedOutput) {
      ctx.lastOutputWasUnhelpful = true;
      ctx.doneCount++;
      if (ctx.doneCount >= 3 && ctx.lastMeaningfulOutput) {
        ctx.log(`[Turn ${ctx.turn}] Detected stuck pattern. Auto-terminating.`);
        const verification = verifyAndReturnResult(ctx.lastMeaningfulOutput, ctx.constraint, ctx.log);
        if (verification.valid) {
          ctx.result = verification.result;
          return ctx;
        }
        ctx.log(`[Turn ${ctx.turn}] Stale output failed verification — forcing another attempt`);
        ctx.doneCount = 0;
        feedback += `\nWARNING: Stuck pattern detected. Try a completely different approach.\n`;
      }
      if (isRepeatedOutput) {
        feedback += `\nWARNING: Output is the same as before. Try a DIFFERENT approach:\n`;
        feedback += `- Use grep("keyword") to search for specific data\n`;
        feedback += `- Try different search terms related to the query\n`;
        feedback += `- Do NOT repeat the same code\n`;
      }
    } else if (!hasObjectObject) {
      ctx.lastOutputWasUnhelpful = false;
      const computedMatch = logsText.match(/^(?:total|sum|result|answer|count|average|mean)[^:]*:\s*([\d,.]+)\s*$/im);
      const hasRawData = logsText.match(/[\d,]{4,}|"[^"]+"\s*:/);

      if (computedMatch && ctx.turn > 2) {
        const answerLine = result.logs.find(line => {
          const trimmed = line.trim();
          return /^(?:total|sum|result|answer|count|average|mean)[^:]*:\s*[\d,.]+\s*$/i.test(trimmed);
        });

        if (answerLine) {
          ctx.log(`[Turn ${ctx.turn}] Computed answer found: ${answerLine}`);
          const verification = verifyAndReturnResult(answerLine, ctx.constraint, ctx.log);
          if (verification.valid) {
            ctx.log(`[Turn ${ctx.turn}] Auto-terminating with computed result`);
            ctx.result = verification.result;
            return ctx;
          } else {
            ctx.log(`[Turn ${ctx.turn}] Constraint violation - continuing`);
            feedback += `\n${verification.feedback}`;
          }
        }

        ctx.lastMeaningfulOutput = logsText;
        ctx.doneCount = 0;
      } else if (hasRawData && !ctx.lastMeaningfulOutput) {
        ctx.lastMeaningfulOutput = logsText;
        ctx.doneCount = 0;
      }
    }
  }

  if (result.error) {
    ctx.log(`[Turn ${ctx.turn}] Error: ${result.error}`);
    feedback += `Error: ${result.error}\n`;
    ctx.lastExecutionHadError = true;
    ctx.consecutiveErrors++;

    if (ctx.ragManager) {
      ctx.ragManager.recordFailure({
        query: ctx.query,
        code: (ctx.extractedCode || "").slice(0, 500),
        error: result.error,
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
      });
      ctx.log(`[RAG] Recorded failure for self-correction`);
    }
  } else {
    ctx.lastExecutionHadError = false;
    ctx.consecutiveErrors = 0;
  }

  if (result.value !== undefined && result.value !== null) {
    let resultStr: string;
    try {
      const MAX_RESULT_JSON = 50_000;
      resultStr = JSON.stringify(result.value, null, 2).slice(0, MAX_RESULT_JSON);
    } catch {
      resultStr = String(result.value);
    }
    ctx.log(`[Turn ${ctx.turn}] Result: ${resultStr}`);
    feedback += `Result: ${truncate(resultStr)}\n`;
    // Phase 5 — record this as the best-known partial answer.
    // Updated on every meaningful solver call so a limit-hit abort
    // always has work to surface. Selectivity rules:
    //   - Empty arrays: skip (not meaningful as a fallback).
    //   - Strings: only adopt if we have nothing yet OR the new
    //     string is substantially longer. Avoids overwriting a
    //     useful array with a sub-RLM's "Max turns reached" /
    //     "[aborted: …]" failure message that would otherwise
    //     replace it as the most-recent result.
    //   - Anything else (arrays w/ content, numbers, structured
    //     objects): adopt unconditionally.
    const MAX_PARTIAL = 10_000;
    const truncated =
      resultStr.length > MAX_PARTIAL
        ? resultStr.slice(0, MAX_PARTIAL) + "\n…[truncated]"
        : resultStr;
    const isEmptyArray = Array.isArray(result.value) && result.value.length === 0;
    // Strings starting with "[aborted:" came back from a child
    // session whose own resource limits tripped. Treating that as
    // a "best partial" pollutes the parent's surface — the child's
    // failure narrative replaces useful parent-side work like a
    // grep result. Skip those strings entirely so the parent keeps
    // whatever genuine progress it had.
    const isAbortString =
      typeof result.value === "string" && result.value.startsWith("[aborted:");
    if (!isEmptyArray && !isAbortString) {
      if (typeof result.value === "string") {
        if (
          ctx.bestPartialAnswer.length === 0 ||
          truncated.length > ctx.bestPartialAnswer.length * 1.5
        ) {
          ctx.bestPartialAnswer = truncated;
        }
      } else {
        ctx.bestPartialAnswer = truncated;
      }
    }
  }

  const classifierGuidance = generateClassifierGuidance(result.logs, ctx.query);
  if (classifierGuidance) {
    feedback += `\n${classifierGuidance}`;
  }

  if (typeof result.value === "number") {
    feedback += `\n\nResult: ${result.value}. If this answers the query, output: <<<FINAL>>>${result.value}<<<END>>>`;
  }

  feedback += `\n\n${ctx.adapter.getSuccessFeedback(ctx.lastResultCount, ctx.previousResultCount, ctx.query)}`;

  // Bindings summary with provenance — lets the LLM see what each `_N`
  // contains without having to remember or re-derive it from history.
  // Essential for chaining `(llm_query …)` calls, where a later call
  // needs to know which prior binding to reference.
  if (ctx.solverBindings.size > 0) {
    const MAX_BINDINGS_SHOWN = 16;
    const keys = [...ctx.solverBindings.keys()];
    const shown = keys.slice(-MAX_BINDINGS_SHOWN);
    const skipped = keys.length - shown.length;

    const summarizeValue = (val: unknown): string => {
      if (val === null || val === undefined) return "null";
      if (Array.isArray(val)) return `Array(${val.length})`;
      if (typeof val === "string") return `String(${val.length})`;
      if (typeof val === "number") return `Number(${val})`;
      if (typeof val === "boolean") return `Bool(${val})`;
      return typeof val;
    };

    const lines = shown.map((name) => {
      const val = ctx.solverBindings.get(name);
      const provenance = ctx.solverBindingProvenance.get(name);
      const shape = summarizeValue(val);
      return provenance
        ? `  ${name} : ${shape}   ← ${provenance}`
        : `  ${name} : ${shape}`;
    });
    const bindingsBlock = lines.join("\n");
    const prefix = skipped > 0
      ? `\n\nBindings (${skipped} older omitted):\n`
      : `\n\nBindings:\n`;
    feedback += `${prefix}${bindingsBlock}`;
  }

  ctx.history.push({ role: "user", content: feedback });

  return ctx;
}

function handleCheckFinalAnswer(ctx: RLMContext): RLMContext {
  // After code execution: check for final answer in the same response
  if (ctx.solverResult && !ctx.solverResult.error && !ctx.lastOutputWasUnhelpful && !Array.isArray(ctx.solverResult.value)) {
    const rawAnswer = ctx.adapter.extractFinalAnswer(ctx.response);
    if (rawAnswer !== null) {
      // Expand any FINAL_VAR(name) markers against the live solver bindings.
      // Lets the LLM close the loop by pointing at a handle rather than
      // inlining a potentially huge value into the final answer string.
      const finalAnswer = expandFinalVar(rawAnswer, ctx.solverBindings);
      ctx.log(`[Turn ${ctx.turn}] Final answer found after code execution`);
      const verification = verifyAndReturnResult(finalAnswer, ctx.constraint, ctx.log);
      if (verification.valid) {
        ctx.result = verification.result;
      } else {
        ctx.log(`[Turn ${ctx.turn}] Constraint violation - continuing`);
        ctx.history.push({ role: "user", content: verification.feedback });
      }
    }
    return ctx;
  }

  // No code path: check for final answer
  if (!ctx.extractedCode) {
    // Stuck detection (3+ consecutive no-code responses)
    if (ctx.noCodeCount >= 3 && ctx.lastMeaningfulOutput) {
      ctx.log(`[Turn ${ctx.turn}] Model stuck (${ctx.noCodeCount} no-code responses). Returning last output.`);
      const verification = verifyAndReturnResult(ctx.lastMeaningfulOutput, ctx.constraint, ctx.log);
      if (verification.valid) {
        ctx.result = verification.result;
        return ctx;
      }
      ctx.log(`[Turn ${ctx.turn}] Stale output failed verification — prompting for code`);
      ctx.history.push({
        role: "user",
        content: `You have not produced working code for several turns. Write and execute Nucleus code to answer the query.`,
      });
      ctx.noCodeCount = 0;
      return ctx;
    }

    const rawAnswer = ctx.adapter.extractFinalAnswer(ctx.response);
    if (rawAnswer !== null) {
      if (!ctx.codeExecuted) {
        ctx.log(`[Turn ${ctx.turn}] Rejecting final answer - no code executed yet`);
        ctx.history.push({
          role: "user",
          content: `ERROR: You tried to answer without reading the document.\n\n${ctx.adapter.getNoCodeFeedback()}`,
        });
        return ctx;
      }
      if (ctx.lastExecutionHadError) {
        ctx.log(`[Turn ${ctx.turn}] Rejecting final answer - last execution had error`);
        ctx.history.push({ role: "user", content: ctx.adapter.getErrorFeedback("Previous execution failed") });
        return ctx;
      }

      // Expand FINAL_VAR(name) markers — see rationale in the first branch.
      const finalAnswer = expandFinalVar(rawAnswer, ctx.solverBindings);
      ctx.log(`[Turn ${ctx.turn}] Final answer received`);
      const verification = verifyAndReturnResult(finalAnswer, ctx.constraint, ctx.log);
      if (verification.valid) {
        ctx.result = verification.result;
      } else {
        ctx.history.push({ role: "user", content: verification.feedback });
      }
      return ctx;
    }

    // No final answer, no code — prompt model
    ctx.history.push({ role: "user", content: ctx.adapter.getNoCodeFeedback() });
  }

  return ctx;
}

// ===== TRANSITION PREDICATES =====

const hasResult = (ctx: RLMContext) => ctx.result !== null;
const hasCode = (ctx: RLMContext) => ctx.extractedCode !== null;
const hasParsedTerm = (ctx: RLMContext) => ctx.parsedTerm !== null;
const maxTurnsReached = (ctx: RLMContext) => ctx.turn >= ctx.maxTurns;
const always = () => true;

// ===== FSM SPEC =====

export function buildRLMSpec(): FSMSpec<RLMContext> {
  return {
    initial: "query_llm",
    terminal: new Set(["done"]),
    states: new Map<string, State<RLMContext>>([
      ["query_llm", {
        handler: handleQueryLLM,
        transitions: [
          ["done", hasResult],       // empty response error
          ["parse_response", always],
        ],
      }],
      ["parse_response", {
        handler: handleParseResponse,
        transitions: [
          ["done", hasResult],               // final-in-code found
          ["validate", hasCode],             // code extracted, proceed to validation
          ["check_final_answer", always],    // no code, check for final answer
        ],
      }],
      ["validate", {
        handler: handleValidate,
        transitions: [
          ["execute", hasParsedTerm],        // parsed & type-checked OK
          ["check_final_answer", always],    // parse/type error, feedback pushed, loop back
        ],
      }],
      ["execute", {
        handler: handleExecute,
        transitions: [
          ["analyze", always],
        ],
      }],
      ["analyze", {
        handler: handleAnalyze,
        transitions: [
          ["done", hasResult],               // auto-terminated (stuck or computed answer)
          ["check_final_answer", always],    // continue to check for final answer in response
        ],
      }],
      ["check_final_answer", {
        handler: handleCheckFinalAnswer,
        transitions: [
          ["done", hasResult],               // final answer accepted
          ["done", maxTurnsReached],         // out of turns
          ["query_llm", always],             // loop back
        ],
      }],
      ["done", {
        handler: (ctx) => ctx,
        transitions: [],
      }],
    ]),
  };
}

export function createInitialContext(opts: {
  query: string;
  adapter: ModelAdapter;
  llmClient: LLMQueryFn;
  solverTools: SolverTools;
  systemPrompt: string;
  userMessage: string;
  constraint?: SynthesisConstraint;
  ragManager?: RAGManager;
  sessionId: string;
  maxTurns: number;
  log: (msg: string) => void;
  maxTimeoutMs?: number;
  maxTokens?: number;
  maxErrors?: number;
  compactionThresholdChars?: number;
  onProgress?: (info: ProgressInfo) => void;
  subRLMDepth?: number;
}): RLMContext {
  return {
    query: opts.query,
    adapter: opts.adapter,
    llmClient: opts.llmClient,
    solverTools: opts.solverTools,
    constraint: opts.constraint,
    ragManager: opts.ragManager,
    sessionId: opts.sessionId,
    maxTurns: opts.maxTurns,
    log: opts.log,
    onProgress: opts.onProgress,
    subRLMDepth: opts.subRLMDepth ?? 0,

    turn: 0,
    history: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userMessage },
    ],
    solverBindings: new Map(),
    solverBindingProvenance: new Map(),

    response: "",
    extractedCode: null,
    parsedTerm: null,
    parseError: null,
    typeValid: false,
    solverResult: null,

    codeExecuted: false,
    lastExecutionHadError: false,
    lastOutputWasUnhelpful: false,
    doneCount: 0,
    noCodeCount: 0,
    lastCode: "",
    lastMeaningfulOutput: "",
    lastResultCount: 0,
    previousResultCount: 0,

    maxTimeoutMs: opts.maxTimeoutMs,
    maxTokens: opts.maxTokens,
    maxErrors: opts.maxErrors,
    startTime: Date.now(),
    totalTokens: 0,
    consecutiveErrors: 0,
    consecutiveLlmErrors: 0,
    lastLlmError: "",
    bestPartialAnswer: "",
    compactionThresholdChars: opts.compactionThresholdChars,
    compactionCount: 0,
    compactionFailures: 0,

    result: null,
  };
}
