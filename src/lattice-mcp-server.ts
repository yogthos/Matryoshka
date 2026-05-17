#!/usr/bin/env node
/**
 * Lattice MCP Server - Handle-Based Document Analysis
 *
 * A stateful document analysis tool that achieves 97%+ token savings by
 * storing results in SQLite and returning only handle references to the LLM.
 *
 * KEY CONCEPT:
 * - Query results are stored server-side, LLM sees only compact stubs
 * - Use lattice_expand when you need to see actual data for decision-making
 * - Chain operations via RESULTS without transferring full datasets
 *
 * SESSION LIFECYCLE:
 * - Sessions auto-expire after inactivity (default: 10 minutes)
 * - Loading a new document closes the previous session
 * - Explicit lattice_close tool for cleanup
 *
 * Usage:
 *   1. lattice_load - Load a document (starts session)
 *   2. lattice_query - Run queries (returns handle stubs, not full data)
 *   3. lattice_expand - Get full data when you need to inspect results
 *   4. lattice_close - End session
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HandleSession, type HandleResult } from "./engine/handle-session.js";
import { runRLMFromContent } from "./rlm.js";
import { createNucleusAdapter } from "./adapters/nucleus.js";
import { getVersion } from "./version.js";
import { hasTraversalSegment } from "./utils/path-safety.js";
import {
  formatSuspensionRequest,
  formatBatchSuspensionRequest,
} from "./lattice-mcp-format.js";

// Sub-LLM bridge — installed in main() before `server.connect()` so that the
// first HandleSession (which may be created before the MCP initialize
// handshake completes) still gets it. The bridge itself is lazy: every call
// re-reads `server.getClientCapabilities()` at invocation time. If the
// client didn't advertise `sampling`, the bridge throws a clear error that
// propagates up through the solver's llm_query path. If it did, the call
// is forwarded to `server.createMessage(...)` and the sub-LLM response is
// returned as a plain string.
let samplingBridge: ((prompt: string) => Promise<string>) | null = null;
let samplingBatchBridge: ((prompts: string[]) => Promise<string[]>) | null = null;
// Phase 1/2 — recursive Nucleus session bridges. Spawn a child
// runRLMFromContent inside the solver; the child's LLM calls flow
// through samplingBridge so each child turn fires through the same
// MCP suspension/sampling protocol the parent uses. The MCP user
// experiences M suspensions per (rlm_query …) call, where M is
// the child's turn count to FINAL.
let samplingRlmBridge:
  | ((prompt: string, contextDoc: string | null) => Promise<string>)
  | null = null;
let samplingRlmBatchBridge:
  | ((
      items: Array<{ prompt: string; contextDoc: string | null }>
    ) => Promise<string[]>)
  | null = null;

// Default cap for sub-LLM responses. The MCP sampling protocol requires a
// maxTokens value; we keep it modest so sub-LLM calls stay cheap and the
// paper's OOLONG pattern remains affordable at scale.
const SAMPLING_MAX_TOKENS = 1024;

// Configuration — timeout is configurable via env var for long sessions
const SESSION_TIMEOUT_MS = parseInt(process.env.LATTICE_TIMEOUT_MS || "") || 10 * 60 * 1000;
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB limit

// Session state
let session: HandleSession | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

// Multi-turn LLM query protocol — Promise-based suspension for clients
// without MCP sampling support. When the solver hits (llm_query ...) and
// the client doesn't advertise sampling, the bridge creates a pending
// Promise and signals the tool handler to return a suspension request.
// The LLM client then calls lattice_llm_respond to provide the response,
// which resolves the Promise and lets the solver continue. This works with
// any MCP client (Claude Code, opencode, custom clients) — no special
// capabilities required. Session timeout rejects all pending queries, so
// there's no memory leak beyond the session lifetime.
interface PendingQuery {
  id: string;
  prompt: string;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  createdAt: number;
}

// Parallel registry for (llm_batch …) dispatches. The wire protocol
// differs from pendingQueries (array of prompts → array of responses),
// so a single pending entry represents ALL N items of a batch. This is
// the optimization: one round-trip carrying every item, instead of N
// serial (llm_query …) suspensions like map+llm_query would.
interface PendingBatch {
  id: string;
  prompts: string[];
  resolve: (responses: string[]) => void;
  reject: (error: Error) => void;
  createdAt: number;
  /**
   * Calibration flag lifted from a `(llm_batch … (calibrate))` marker.
   * When true, `formatBatchSuspensionRequest` prepends a directive
   * telling the sub-LLM to scan the distribution and establish a
   * consistent scale before answering any individual prompt.
   */
  calibrate?: boolean;
}

const pendingQueries = new Map<string, PendingQuery>();
const pendingBatches = new Map<string, PendingBatch>();
let suspensionCallback:
  | ((
      info:
        | { type: "query"; id: string; prompt: string }
        | { type: "batch"; id: string; prompts: string[]; calibrate?: boolean }
    ) => void)
  | null = null;
let activeExecution: Promise<HandleResult> | null = null;
// For top-level llm_query / llm_batch: the bridge fires synchronously
// inside session.execute() before raceExecution() installs the callback.
// The bridge stores the suspension here so raceExecution() can pick it up.
let earlySuspension:
  | { type: "query"; id: string; prompt: string }
  | { type: "batch"; id: string; prompts: string[]; calibrate?: boolean }
  | null = null;

/**
 * Generate a pending-request ID. Uses crypto.randomUUID for the random
 * portion so concurrent suspensions in the same millisecond can't collide
 * — the previous `Date.now() + 6 base36 chars` form had ~36 bits of
 * entropy and was a real collision risk under load.
 */
export function makePendingId(prefix: "q" | "b"): string {
  return `${prefix}_${Date.now()}_${randomUUID()}`;
}

function resetInactivityTimer(): void {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  timeoutHandle = setTimeout(() => {
    if (session) {
      console.error(`[Lattice] Session expired after ${SESSION_TIMEOUT_MS / 1000}s inactivity`);
      try {
        closeSession("timeout");
      } catch (err) {
        console.error("[Lattice] Error closing expired session:", err instanceof Error ? err.message : String(err));
        session = null;
      }
    }
  }, SESSION_TIMEOUT_MS);
}

function closeSession(reason: string): void {
  rejectAllPendingQueries(reason);

  if (session) {
    const info = session.getSessionInfo();
    const duration = info.loadedAt ? Date.now() - info.loadedAt.getTime() : 0;
    console.error(
      `[Lattice] Session closed: ${reason} | ` +
      `Document: ${info.documentPath} | ` +
      `Duration: ${Math.round(duration / 1000)}s | ` +
      `Queries: ${info.queryCount} | ` +
      `Handles: ${info.handleCount}`
    );
    session.close();
    session = null;
  }

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
}

type RaceResult =
  | { type: "completed"; result: HandleResult }
  | { type: "suspended"; id: string; prompt: string }
  | {
      type: "suspended-batch";
      id: string;
      prompts: string[];
      calibrate?: boolean;
    };

async function raceExecution(): Promise<RaceResult> {
  if (!activeExecution) {
    throw new Error("No active execution");
  }

  // Check for early suspension: when (llm_query …) or (llm_batch …) is
  // at the top level, the bridge fires synchronously inside
  // session.execute() — before this function was called. The bridge
  // stores the info in earlySuspension.
  if (earlySuspension) {
    const info = earlySuspension;
    earlySuspension = null;
    return info.type === "batch"
      ? {
          type: "suspended-batch",
          id: info.id,
          prompts: info.prompts,
          calibrate: info.calibrate,
        }
      : { type: "suspended", id: info.id, prompt: info.prompt };
  }

  let resolveSuspension: (
    info:
      | { type: "query"; id: string; prompt: string }
      | { type: "batch"; id: string; prompts: string[]; calibrate?: boolean }
  ) => void;
  const suspensionPromise = new Promise<RaceResult>((resolve) => {
    resolveSuspension = (info) => {
      if (info.type === "batch") {
        resolve({
          type: "suspended-batch",
          id: info.id,
          prompts: info.prompts,
          calibrate: info.calibrate,
        });
      } else {
        resolve({ type: "suspended", id: info.id, prompt: info.prompt });
      }
    };
  });

  // Install callback for nested llm_query / llm_batch calls. These fire
  // on a microtask after the collection evaluation yields, so the
  // callback is installed before they run.
  suspensionCallback = resolveSuspension!;

  return Promise.race([
    activeExecution.then((result): RaceResult => {
      suspensionCallback = null;
      activeExecution = null;
      return { type: "completed", result };
    }),
    suspensionPromise,
  ]);
}

// Render a race result as the MCP tool reply text. Completed → the
// normal handle-stub summary; suspended (query or batch) → the
// respective protocol request text. Shared by lattice_query,
// lattice_llm_respond, and lattice_llm_batch_respond so that continuing
// a multi-turn execution always returns the right shape regardless of
// which suspension was just resolved.
function formatRaceResponse(raceResult: RaceResult): string {
  if (raceResult.type === "completed") {
    return formatHandleResult(raceResult.result);
  }
  if (raceResult.type === "suspended-batch") {
    return formatBatchSuspensionRequest(
      raceResult.id,
      raceResult.prompts,
      raceResult.calibrate
    );
  }
  return formatSuspensionRequest(raceResult.id, raceResult.prompt);
}


function rejectAllPendingQueries(reason: string): void {
  for (const [id, entry] of pendingQueries) {
    try {
      entry.reject(new Error(`Session closed: ${reason}`));
    } catch { /* ignore double-reject */ }
    pendingQueries.delete(id);
  }
  for (const [id, entry] of pendingBatches) {
    try {
      entry.reject(new Error(`Session closed: ${reason}`));
    } catch { /* ignore double-reject */ }
    pendingBatches.delete(id);
  }
  activeExecution = null;
  suspensionCallback = null;
  earlySuspension = null;
}

/**
 * Reject any pending query or batch whose createdAt timestamp is older
 * than `maxAgeMs`. Returns the number of entries cleaned up. Called at
 * the start of every tool handler as a safety net for the rare case
 * where the session-timeout-driven `rejectAllPendingQueries` path fails
 * or the `activeExecution` / `suspensionCallback` lifecycle gets
 * confused. Also exported for regression testing.
 */
export function sweepStalePending(maxAgeMs: number): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, entry] of pendingQueries) {
    if (now - entry.createdAt > maxAgeMs) {
      try { entry.reject(new Error("Pending query expired")); } catch { /* ignore */ }
      pendingQueries.delete(id);
      cleaned++;
    }
  }
  for (const [id, entry] of pendingBatches) {
    if (now - entry.createdAt > maxAgeMs) {
      try { entry.reject(new Error("Pending batch expired")); } catch { /* ignore */ }
      pendingBatches.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}

function getSessionInfo(): string {
  if (!session) {
    return "No active session";
  }

  const info = session.getSessionInfo();
  const now = new Date();
  const age = info.loadedAt ? Math.round((now.getTime() - info.loadedAt.getTime()) / 1000) : 0;
  const idle = info.lastAccessedAt ? Math.round((now.getTime() - info.lastAccessedAt.getTime()) / 1000) : 0;
  const timeout = Math.round(SESSION_TIMEOUT_MS / 1000 - idle);

  const memo = session.getMemoStats();

  return `Session active:
  Document: ${info.documentPath || "(none)"}
  Size: ${(info.documentSize / 1024).toFixed(1)} KB
  Age: ${age}s
  Idle: ${idle}s
  Timeout in: ${Math.max(0, timeout)}s
  Queries: ${info.queryCount}
  Active handles: ${info.handleCount}
  Memos: ${memo.count}/${memo.maxCount} (${(memo.totalBytes / 1024).toFixed(1)}KB / ${(memo.maxBytes / 1024 / 1024).toFixed(0)}MB)`;
}

const TOOLS = [
  {
    name: "lattice_load",
    description: `Load a document for analysis. Starts a new session (closes any existing session).

RECOMMENDED WORKFLOW:
1. Use Glob first to discover relevant files
2. Read small files (<300 lines) directly
3. Use Lattice for large files (>500 lines) - saves 80%+ tokens
4. Chain queries: grep → filter → count/sum

HOW HANDLES WORK:
- Query results are stored server-side in SQLite
- You receive a compact stub like "$grep_error: Array(1000) [preview...]"
- Use lattice_expand to see full data when you need to make decisions
- This saves 97%+ tokens compared to returning full results

EFFICIENT QUERY PATTERNS:
- Start broad: (grep "ERROR") to find all errors
- Then narrow: (filter RESULTS (lambda x (match x "timeout" 0)))
- Finally aggregate: (count RESULTS) or (sum RESULTS)
- Inspect when needed: use lattice_expand with limit

SESSION: Document stays loaded for ${SESSION_TIMEOUT_MS / 60000} minutes.
Call lattice_close when done.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description: "Path to the document to analyze",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "lattice_query",
    description: `Execute a Nucleus query on the loaded document.

RETURNS HANDLE STUBS (not full data):
- Array results return a handle like "$grep_error: Array(500) [preview...]"
- Scalar results (count, sum) return the value directly
- Use lattice_expand when you need to see the actual data

SEARCH (returns handle to matches):
  (grep "pattern")              Regex search - returns handle to matching lines
  (fuzzy_search "query" 10)     Fuzzy search - top N matches by relevance
  (lines 10 20)                 Get specific line range

SYMBOL OPERATIONS (.ts, .js, .py, .go, .md, and more):
  (list_symbols)                List all symbols (functions, classes, methods, headings, etc.)
  (list_symbols "function")     Filter by kind: "function", "class", "method", "interface", "type"
  (get_symbol_body "funcName")  Get source code for a symbol
  (find_references "identifier") Find all references to an identifier

GRAPH OPERATIONS (knowledge graph for code structure):
  (callers "funcName")          Who calls this function?
  (callees "funcName")          What does this function call?
  (ancestors "ClassName")       Inheritance chain (extends)
  (descendants "ClassName")     All subclasses (transitive)
  (implementations "IFace")     Classes implementing this interface
  (dependents "name")           All transitive dependents
  (dependents "name" 2)         Dependents within depth limit
  (symbol_graph "name" 1)       Neighborhood subgraph around symbol

GRAPH ANALYSIS (community detection & structural insights):
  (communities)                 Detect communities with cohesion scores
  (community_of "name")         Which community does this symbol belong to?
  (god_nodes)                   Top 10 most-connected nodes (hubs)
  (god_nodes 5)                 Top N most-connected nodes
  (surprising_connections)       Cross-community or low-confidence edges
  (surprising_connections 5)     Top N surprising connections
  (bridge_nodes)                Nodes bridging different communities
  (bridge_nodes 5)              Top N bridge nodes
  (suggest_questions)           Questions the graph is uniquely positioned to answer
  (graph_report)                Full analysis (all of the above combined)

AGGREGATE (returns scalar directly):
  (count RESULTS)               Count items in current results
  (sum RESULTS)                 Sum numeric values (auto-extracts from $1,234 format)

TRANSFORM (returns new handle):
  (filter RESULTS (lambda x (match x "pattern" 0)))
  (map RESULTS (lambda x (match x "(\\d+)" 1)))

EXTRACT:
  (match str "pattern" 1)       Extract regex group from string

DATA MODEL IN MAP/FILTER LAMBDAS:
When iterating over results, each item is converted to a string:
- grep/bm25/fuzzy results → the matched line text
- symbol objects (from list_symbols) → the symbol name (e.g. "myFunction")
- chunks (from chunk_by_lines/size) → the chunk text
- plain strings → the string itself
Inside a lambda, the parameter (e.g. x) is this string value.
Operations available inside lambdas: match, replace, split, parseInt, parseFloat,
llm_query, get_symbol_body, find_references, and all other Nucleus commands.

LLM_QUERY (multi-turn — works with any MCP client, no sampling required):
  (llm_query "prompt")                                     Ask a question, get your response
  (llm_query "describe: {item}" (item x))                  With variable binding
  (map RESULTS (lambda x (llm_query "tag: {item}" (item x))))  Per-item via map (N suspensions)
  (filter RESULTS (lambda x (match (llm_query "keep?: {item}" (item x)) "keep" 0)))  Per-item filter

LLM_BATCH (ONE suspension for all N items — prefer over map+llm_query):
  (llm_batch RESULTS (lambda x (llm_query "tag: {item}" (item x))))
  (llm_batch (list_symbols "function")
             (lambda x (llm_query "Rate: {name}\\n{body}" (name x) (body (get_symbol_body x)))))
Drop-in replacement for (map COLL (lambda x (llm_query …))) when per-item
judgments are independent. Solver collects all N interpolated prompts and
dispatches them through ONE lattice_llm_batch_respond call instead of N
serial llm_query suspensions. 92% round-trip reduction on N=12, 99% on
N=100 — protocol overhead dominates map+llm_query cost, not per-item work.
Use map+llm_query only when per-item judgment references prior items or
the lambda body isn't a direct (llm_query …).

RLM_QUERY (recursive child Nucleus session — for sub-tasks needing multi-step reasoning):
  (rlm_query "prompt")                                     No context — child sees prompt as its document
  (rlm_query "extract" (context RESULTS))                  Pass a binding as the child's working document
  (rlm_query "scan" (context (chunk_by_lines 100)))        Pass a fresh result handle
Spawns a child Nucleus session that runs its OWN multi-turn loop —
greps, chunks, sub-LLM calls, etc. — until it produces a FINAL.
Differs from (llm_query …) which is a single LLM call: rlm_query
gives the child a structured working document and lets it iterate.
The child's LLM calls flow through the same MCP sampling bridge,
so you'll see M suspensions per (rlm_query …) call where M is the
child's turn count to FINAL.

RLM_BATCH (concurrent variant — N child sessions in parallel):
  (rlm_batch chunks (lambda c (rlm_query "extract" (context c))))
  (rlm_batch RESULTS (lambda x (rlm_query "deep dive" (context x))))
Drop-in replacement for (map COLL (lambda x (rlm_query …))) when
per-item recursion is independent. All N child sessions run
concurrently; per-item failures surface as
"Error: rlm_batch item N failed — …" without aborting the rest.

ONE_OF (enum validation — makes downstream filter/count reliable):
  (llm_query "Rate: {x}" (x y) (one_of "low" "medium" "high"))
  (llm_batch C (lambda x (llm_query "..." (x x) (one_of "low" "medium" "high"))))
Validates each response against the enum, canonicalizes case/whitespace,
fails the query (or the batch, with a specific index) on out-of-set.
Makes (filter RESULTS (lambda x (match x "low" 0))) exact-match-safe
without every downstream consumer re-implementing normalization.

CALIBRATE (scale-setting preamble — llm_batch only):
  (llm_batch C (lambda x (llm_query "..." (one_of ...) (calibrate))))
Prepends a directive to the batched suspension telling the model to scan
the whole distribution before answering any single prompt. Useful for
subjective ratings where the answer depends on the corpus, not absolutes.

When a query contains (llm_query ...), execution SUSPENDS and returns a request like:
  [LLM_QUERY_REQUEST id=q_abc] Please respond to: ...
You MUST respond using lattice_llm_respond before the query can continue:
  lattice_llm_respond id="q_abc" response="your answer"
After responding, you either get the final result or another suspension (if the
query has multiple llm_query calls, e.g. inside map over many items). Keep
responding until you get a handle stub or scalar result — that's the final output.

LLM_QUERY WORKFLOW:
1. lattice_query '(llm_query "classify this")'
   → [LLM_QUERY_REQUEST id=q_abc] Please respond to: classify this
2. lattice_llm_respond id="q_abc" response="It's a technical document"
   → "It's a technical document"  (final result)

LLM_QUERY MAP WORKFLOW (OOLONG pattern — one suspension per item):
1. lattice_query '(map RESULTS (lambda x (llm_query "tag: {item}" (item x))))'
   → [LLM_QUERY_REQUEST id=q_1] ... tag: item1 ...
2. lattice_llm_respond id="q_1" response="bug"
   → [LLM_QUERY_REQUEST id=q_2] ... tag: item2 ...  (next item)
3. lattice_llm_respond id="q_2" response="feature"
   → $llm_query_classify: Array(2) ["bug", "feature"]  (final result)

LLM_BATCH WORKFLOW (same result, ONE suspension instead of N):
1. lattice_query '(llm_batch RESULTS (lambda x (llm_query "tag: {item}" (item x))))'
   → [LLM_BATCH_REQUEST id=b_1 count=2] ... two prompts inlined ...
2. lattice_llm_batch_respond id="b_1" responses=["bug","feature"]
   → $llm_batch: Array(2) ["bug", "feature"]  (final result in ONE round-trip)

LLM_QUERY + SYMBOLS (rate function complexity — one suspension per function):
1. lattice_query '(list_symbols "function")'
   → $list_symbols_function: Array(10) [...]
2. lattice_query '(map RESULTS (lambda x (llm_query "Rate complexity of {name}: {body}" (name x) (body (get_symbol_body x)))))'
   → [LLM_QUERY_REQUEST id=q_1] ... Rate complexity of myFunction: function myFunction() { ... }
3. lattice_llm_respond id="q_1" response="medium — has branching logic and error handling"
   → [LLM_QUERY_REQUEST id=q_2] ... (next function)
   ... repeat until all functions are rated ...
   → $map: Array(10) ["medium — ...", "low — ...", ...]  (final result)

LLM_QUERY + CHUNKS (summarize document sections):
1. lattice_query '(map (chunk_by_lines 100) (lambda c (llm_query "Summarize: {chunk}" (chunk c))))'
   → [LLM_QUERY_REQUEST id=q_1] ... Summarize: <first 100 lines> ...
2. lattice_llm_respond id="q_1" response="Introduction and setup instructions"
   → [LLM_QUERY_REQUEST id=q_2] ... (next chunk)
   ... repeat until all chunks are summarized ...

EXAMPLE WORKFLOW:
1. (grep "ERROR")                    → Returns: $grep_error: Array(500) [preview]
2. (filter RESULTS (lambda x ...))   → Returns: $filter: Array(50) [preview]
3. (count RESULTS)                   → Returns: 50
4. lattice_expand $filter limit=10   → See 10 actual error messages

SYMBOL WORKFLOW:
1. (list_symbols "function")         → Returns: $list_symbols_function: Array(15) [preview]
2. (get_symbol_body "myFunction")    → Returns source code directly
3. (find_references "myFunction")    → Returns: $find_references_myfunction: Array(8) [references]

MARKDOWN WORKFLOW:
1. (list_symbols)                       → Returns: $list_symbols: Array(12) [# Intro, ## Setup, ...]
2. (grep "## Installation")             → Find specific section content

VARIABLE BINDING:
- RESULTS: Always points to the last array result (use in queries)
- _1, _2, _3, ...: Results from turn N (use in queries for older results)
- $grep_error, $filter, ...: Handle stubs (use ONLY with lattice_expand, NOT in queries)

EFFICIENCY: Minimize the number of separate tool calls by chaining queries.
Build a pipeline (grep → filter → count) rather than making independent calls.
Aim to answer your question in 3-5 queries, not 10+.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: 'Nucleus S-expression command, e.g., (grep "ERROR")',
        },
      },
      required: ["command"],
    },
  },
  {
    name: "lattice_expand",
    description: `Get full data from a handle when you need to inspect actual results.

USE THIS WHEN:
- You need to see actual content to make decisions
- You want to verify what's in a result set
- You need to extract specific data for your response

PARAMETERS:
- handle: The handle reference (e.g., "$grep_error")
- limit: Max items to return (default: all) - use for large result sets
- offset: Skip first N items (for pagination)
- format: "full" (default) or "lines" (just line content with numbers)

EXAMPLES:
  lattice_expand $grep_error                    → Full data from handle
  lattice_expand $grep_error limit=10           → First 10 items only
  lattice_expand $grep_error offset=10 limit=10 → Items 11-20 (pagination)
  lattice_expand $grep_error format=lines       → "[1] line content..." format

TIP: Start with a small limit to preview, then expand more if needed.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        handle: {
          type: "string",
          description: 'Handle reference to expand (e.g., "$grep_error")',
        },
        limit: {
          type: "number",
          description: "Maximum number of items to return (default: all)",
        },
        offset: {
          type: "number",
          description: "Number of items to skip (for pagination)",
        },
        format: {
          type: "string",
          enum: ["full", "lines"],
          description: '"full" for complete objects, "lines" for readable line format',
        },
      },
      required: ["handle"],
    },
  },
  {
    name: "lattice_close",
    description:
      "Close the current session and free memory. " +
      "Call this when done analyzing a document. " +
      "Sessions also auto-close after 10 minutes of inactivity.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_status",
    description: "Get current session status including document info, active handles, and timeout.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_bindings",
    description: `Show current handle bindings.

Returns all active handles with their stubs:
  $grep_error: Array(500) [preview of first item...]
  $filter: Array(50) [preview...]
  RESULTS: -> $filter

Use this to see what data you have available before deciding what to expand.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_reset",
    description: "Clear all handles and bindings but keep the document loaded. Use this to start fresh analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_memo",
    description: `Store arbitrary context as a memo handle for token-efficient roundtripping.

USE THIS TO:
- Stash file summaries, analysis results, plans, or any context
- Avoid roundtripping large text in every message
- Pull context back only when actually needed via lattice_expand

RETURNS a handle stub like: $memo_auth_architecture: "auth architecture" (2.1KB, 50 lines)
Handle names are derived from the label for easy identification.
The LLM carries this compact stub (~15 tokens) instead of the full content (~2000 tokens).

WORKFLOW:
1. lattice_memo content="<summary>" label="auth architecture"  → $memo_auth_architecture stub
2. Keep a brief index in your response text so you remember what's stashed:
   "Stashed: $memo_auth_architecture (middleware chain, session flow)"
3. Continue working, carrying just the index (~10 tokens per memo)
4. lattice_expand $memo_auth_architecture  → Full content when you actually need it

IMPORTANT: After stashing, always note the handle + label + a short description
of what's inside in your response. This avoids needing lattice_bindings later
to remember what you stored. Update the index when you add or delete memos.

Memos persist across document loads. No lattice_load required.
Session timeout: ${SESSION_TIMEOUT_MS / 60000} minutes (resets on any tool call).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The text content to store (file summary, analysis, plan, etc.)",
        },
        label: {
          type: "string",
          description: "Short label describing this memo (shown in handle stub)",
        },
      },
      required: ["content", "label"],
    },
  },
  {
    name: "lattice_memo_delete",
    description: `Delete a memo that is no longer needed to free memory.

Use this when context becomes stale or irrelevant (e.g., after finishing work on a module).
Check lattice_bindings to see current memos and their handles.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        handle: {
          type: "string",
          description: 'Memo handle to delete (e.g., "$memo_auth_architecture")',
        },
      },
      required: ["handle"],
    },
  },
  {
    name: "lattice_help",
    description: "Get complete Nucleus command reference documentation.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "lattice_llm_respond",
    description: `Resolve a pending (llm_query …) suspension with a single string response.

When lattice_query hits (llm_query …) and the client doesn't support sampling,
execution suspends and returns [LLM_QUERY_REQUEST id=q_abc]. Reply here with
the same id and your response string; execution resumes. Queries with multiple
llm_query calls (e.g. inside map) trigger one suspension per item — respond
to each until you get the final handle stub or scalar.

For the batched variant (llm_batch …), use lattice_llm_batch_respond instead
(ONE suspension carrying all N prompts, ONE reply carrying all N responses).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The query ID from the LLM_QUERY_REQUEST message",
        },
        response: {
          type: "string",
          description: "Your response to the prompt",
        },
      },
      required: ["id", "response"],
    },
  },
  {
    name: "lattice_llm_batch_respond",
    description: `Resolve a pending (llm_batch …) suspension with all N responses at once.

(llm_batch COLL (lambda x (llm_query …))) fires ONE suspension carrying all
N per-item prompts, instead of N serial llm_query suspensions. Reply with a
JSON array of exactly N strings — one response per prompt, in header order.

If the array length ≠ N, the batch stays pending and you can retry with the
correct count. Single (llm_query …) suspensions use lattice_llm_respond
instead.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The batch ID from the LLM_BATCH_REQUEST message",
        },
        responses: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of responses in prompt order — must have exactly count entries",
        },
      },
      required: ["id", "responses"],
    },
  },
];

function formatHandleResult(result: {
  success: boolean;
  handle?: string;
  stub?: string;
  value?: unknown;
  logs: string[];
  error?: string;
  tokenMetadata?: { estimatedFullTokens: number; stubTokens: number; savingsPercent: number };
}): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  // If we have a handle (array result), return the stub
  if (result.handle && result.stub) {
    let text = result.stub;
    if (result.tokenMetadata) {
      text += `\n\nToken savings: ~${result.tokenMetadata.savingsPercent}% (${result.tokenMetadata.stubTokens} vs ~${result.tokenMetadata.estimatedFullTokens} tokens)`;
    }
    text += "\n\nChain with (count RESULTS), (filter RESULTS ...), (map RESULTS ...), etc.";
    text += "\nUse lattice_expand to see full data when needed.";
    return text;
  }

  // Scalar result
  if (typeof result.value === "number") {
    return `Result: ${result.value.toLocaleString()}`;
  }

  if (typeof result.value === "string") {
    return result.value;
  }

  return JSON.stringify(result.value, null, 2);
}

function formatExpandResult(result: {
  success: boolean;
  data?: unknown[];
  total?: number;
  offset?: number;
  limit?: number;
  error?: string;
}): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const data = result.data ?? [];
  let text = `Showing ${data.length} of ${result.total} items`;
  if (result.offset && result.offset > 0) {
    text += ` (offset: ${result.offset})`;
  }
  text += ":\n\n";

  for (const item of data) {
    if (typeof item === "string") {
      text += item + "\n";
    } else if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      // Format nicely for line-based results
      if ("lineNum" in obj && "line" in obj) {
        text += `[${obj.lineNum}] ${obj.line}\n`;
      } else if ("lineNum" in obj && "content" in obj) {
        text += `[${obj.lineNum}] ${obj.content}\n`;
      } else {
        text += JSON.stringify(item) + "\n";
      }
    } else {
      text += JSON.stringify(item) + "\n";
    }
  }

  return text;
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    // Sweep any pending queries/batches that outlived their session,
    // e.g. when closeSession threw silently or the client disconnected.
    sweepStalePending(SESSION_TIMEOUT_MS + 60_000);
    switch (name) {
      case "lattice_load": {
        const filePath = args.filePath as string;
        if (!filePath) {
          return { content: [{ type: "text", text: "Error: filePath is required" }] };
        }

        // Validate path - reject traversal and paths outside CWD
        if (!skipCwdChecking) {
          if (hasTraversalSegment(filePath)) {
            return { content: [{ type: "text", text: "Error: Path traversal (..) is not allowed" }] };
          }
          const resolvedPath = resolve(filePath);
          const cwd = process.cwd();
          if (!resolvedPath.startsWith(cwd + sep) && resolvedPath !== cwd) {
            return { content: [{ type: "text", text: "Error: Path outside working directory is not allowed" }] };
          }
        }

        // Check file size before loading to avoid wasting memory
        try {
          const fileStat = await stat(filePath);
          if (fileStat.size > MAX_DOCUMENT_SIZE) {
            return {
              content: [{
                type: "text",
                text: `Error: Document too large (${(fileStat.size / 1024 / 1024).toFixed(1)}MB). ` +
                  `Maximum size is ${MAX_DOCUMENT_SIZE / 1024 / 1024}MB.`,
              }],
            };
          }
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: `Error: Cannot access file: ${err instanceof Error ? err.message : String(err)}`,
            }],
          };
        }

        // Reuse existing session if it has memos, otherwise create new
        let stats: { lineCount: number; size: number };
        if (session) {
          // Clear query handles but preserve memos
          session.clearQueryHandles();
          try {
            stats = await session.loadFile(filePath);
          } catch (loadErr) {
            return {
              content: [{
                type: "text",
                text: `Error loading file: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`,
              }],
            };
          }
        } else {
          // Create new session — use temp variable so `session` isn't
          // left pointing at a half-initialised object if loadFile throws.
          // Thread the sampling bridges through so `(llm_query ...)` and
          // `(llm_batch ...)` inside lattice_query can delegate to the
          // MCP client's LLM (native sampling when available, multi-turn
          // suspension protocol otherwise).
          const newSession = new HandleSession({
            llmQuery: samplingBridge ?? undefined,
            llmBatch: samplingBatchBridge ?? undefined,
            rlmQuery: samplingRlmBridge ?? undefined,
            rlmBatch: samplingRlmBatchBridge ?? undefined,
          });
          try {
            stats = await newSession.loadFile(filePath);
          } catch (loadErr) {
            newSession.close();
            return {
              content: [{
                type: "text",
                text: `Error loading file: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`,
              }],
            };
          }
          session = newSession;
        }

        // Start inactivity timer
        resetInactivityTimer();

        console.error(`[Lattice] Session started: ${filePath} (${stats.lineCount} lines)`);

        return {
          content: [{
            type: "text",
            text: `Loaded ${filePath}:\n` +
              `  Lines: ${stats.lineCount.toLocaleString()}\n` +
              `  Size: ${(stats.size / 1024).toFixed(1)} KB\n` +
              `  Session timeout: ${SESSION_TIMEOUT_MS / 60000} minutes\n\n` +
              `Results will be returned as handle stubs (97%+ token savings).\n` +
              `Use lattice_expand to see full data when needed.\n\n` +
              `Ready for queries. Call lattice_close when done.`,
          }],
        };
      }

      case "lattice_query": {
        if (!session) {
          return {
            content: [{
              type: "text",
              text: "Error: No active session. Use lattice_load first.",
            }],
          };
        }

        const command = args.command as string;
        if (!command) {
          return { content: [{ type: "text", text: "Error: command is required" }] };
        }

        // Guard: if there's a pending LLM query or batch, the client
        // must respond to that first before kicking off another query.
        if (activeExecution && pendingQueries.size > 0) {
          const pending = pendingQueries.values().next().value as PendingQuery;
          resetInactivityTimer();
          return {
            content: [{
              type: "text",
              text: `There is a pending LLM query that must be answered first.\n\n` +
                formatSuspensionRequest(pending.id, pending.prompt),
            }],
          };
        }
        if (activeExecution && pendingBatches.size > 0) {
          const pending = pendingBatches.values().next().value as PendingBatch;
          resetInactivityTimer();
          return {
            content: [{
              type: "text",
              text: `There is a pending LLM batch that must be answered first.\n\n` +
                formatBatchSuspensionRequest(
                  pending.id,
                  pending.prompts,
                  pending.calibrate
                ),
            }],
          };
        }

        resetInactivityTimer();

        // Clear stale suspension state before starting a new execution
        earlySuspension = null;

        activeExecution = session.execute(command);

        const raceResult = await raceExecution();
        return { content: [{ type: "text", text: formatRaceResponse(raceResult) }] };
      }

      case "lattice_expand": {
        if (!session) {
          return {
            content: [{
              type: "text",
              text: "Error: No active session. Use lattice_load or lattice_memo first.",
            }],
          };
        }

        const handle = args.handle as string;
        if (!handle) {
          return { content: [{ type: "text", text: "Error: handle is required" }] };
        }

        resetInactivityTimer();

        const result = session.expand(handle, {
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
          format: args.format as "full" | "lines" | undefined,
        });

        return { content: [{ type: "text", text: formatExpandResult(result) }] };
      }

      case "lattice_close": {
        if (!session) {
          return { content: [{ type: "text", text: "No active session to close." }] };
        }

        const info = session.getSessionInfo();
        const summary = `Closed session for ${info.documentPath} (${info.queryCount} queries, ${info.handleCount} handles)`;
        closeSession("explicit close");
        return { content: [{ type: "text", text: summary }] };
      }

      case "lattice_status": {
        return { content: [{ type: "text", text: getSessionInfo() }] };
      }

      case "lattice_bindings": {
        if (!session) {
          return { content: [{ type: "text", text: "No active session." }] };
        }

        resetInactivityTimer();

        const bindings = session.getBindings();
        if (Object.keys(bindings).length === 0) {
          return { content: [{ type: "text", text: "No bindings yet. Run a query first." }] };
        }

        const lines = Object.entries(bindings).map(([k, v]) => `  ${k}: ${v}`);
        return {
          content: [{
            type: "text",
            text: `Current bindings:\n${lines.join("\n")}\n\nUse lattice_expand <handle> to see full data.`,
          }],
        };
      }

      case "lattice_reset": {
        if (!session) {
          return { content: [{ type: "text", text: "No active session." }] };
        }

        session.reset();
        resetInactivityTimer();

        return { content: [{ type: "text", text: "Bindings and handles cleared. Document still loaded." }] };
      }

      case "lattice_memo": {
        const content = args.content as string;
        const label = args.label as string;
        if (!content) {
          return { content: [{ type: "text", text: "Error: content is required" }] };
        }
        if (!label) {
          return { content: [{ type: "text", text: "Error: label is required" }] };
        }

        // Auto-create session if none exists (memos don't require a loaded document).
        // Thread sampling bridges so memos-first sessions still get
        // llm_query / llm_batch support.
        if (!session) {
          session = new HandleSession({
            llmQuery: samplingBridge ?? undefined,
            llmBatch: samplingBatchBridge ?? undefined,
          });
          console.error("[Lattice] Auto-created session for memo storage");
        }

        resetInactivityTimer();

        const result = session.memo(content, label);
        if (!result.success) {
          return { content: [{ type: "text", text: `Error: ${result.error}` }] };
        }

        let text = result.stub!;
        if (result.tokenMetadata) {
          text += `\n\nToken savings: ~${result.tokenMetadata.savingsPercent}% (${result.tokenMetadata.stubTokens} vs ~${result.tokenMetadata.estimatedFullTokens} tokens)`;
        }
        text += "\n\nUse lattice_expand to retrieve full content when needed.";
        text += "\nMemos persist across document loads.";
        return { content: [{ type: "text", text }] };
      }

      case "lattice_memo_delete": {
        if (!session) {
          return { content: [{ type: "text", text: "No active session." }] };
        }

        const handle = args.handle as string;
        if (!handle) {
          return { content: [{ type: "text", text: "Error: handle is required" }] };
        }

        resetInactivityTimer();

        const deleted = session.deleteMemo(handle);
        if (!deleted) {
          return { content: [{ type: "text", text: `Error: ${handle} is not a memo handle or does not exist.` }] };
        }

        const stats = session.getMemoStats();
        return {
          content: [{
            type: "text",
            text: `Deleted ${handle}. Memos: ${stats.count}/${stats.maxCount} (${(stats.totalBytes / 1024).toFixed(1)}KB used)`,
          }],
        };
      }

      case "lattice_help": {
        return {
          content: [{ type: "text", text: HandleSession.getCommandReference() }],
        };
      }

      case "lattice_llm_respond": {
        const id = args.id as string;
        const response = args.response as string;

        if (!id || response === undefined || response === null) {
          return { content: [{ type: "text", text: "Error: id and response are required" }] };
        }

        if (!activeExecution) {
          return {
            content: [{
              type: "text",
              text: "Error: No active execution to continue. Start with lattice_query.",
            }],
          };
        }

        const entry = pendingQueries.get(id);
        if (!entry) {
          return {
            content: [{
              type: "text",
              text: `Error: Unknown or expired query ID: ${id}. The session may have timed out.`,
            }],
          };
        }

        // Resolve the pending query — this unblocks the solver
        pendingQueries.delete(id);
        entry.resolve(response);

        resetInactivityTimer();

        // Race for completion or next suspension (e.g., next item in a map)
        const raceResult = await raceExecution();
        return { content: [{ type: "text", text: formatRaceResponse(raceResult) }] };
      }

      case "lattice_llm_batch_respond": {
        const id = args.id as string;
        const responses = args.responses as unknown;

        if (!id) {
          return { content: [{ type: "text", text: "Error: id is required" }] };
        }
        if (!Array.isArray(responses) || responses.some((r) => typeof r !== "string")) {
          return {
            content: [{
              type: "text",
              text: "Error: responses must be a JSON array of strings",
            }],
          };
        }

        if (!activeExecution) {
          return {
            content: [{
              type: "text",
              text: "Error: No active execution to continue. Start with lattice_query.",
            }],
          };
        }

        const entry = pendingBatches.get(id);
        if (!entry) {
          return {
            content: [{
              type: "text",
              text: `Error: Unknown or expired batch ID: ${id}. The session may have timed out.`,
            }],
          };
        }

        // Validate length BEFORE resolving so a shape mismatch doesn't
        // poison the solver's await — the pending entry stays in the
        // registry and the client can retry lattice_llm_batch_respond
        // with the correct count.
        if (responses.length !== entry.prompts.length) {
          return {
            content: [{
              type: "text",
              text:
                `Error: expected ${entry.prompts.length} responses, got ${responses.length}. ` +
                `The batch is still pending — retry lattice_llm_batch_respond with a JSON array ` +
                `of exactly ${entry.prompts.length} strings.`,
            }],
          };
        }

        // Resolve the pending batch — this unblocks the solver, which
        // receives the whole responses array from a single tools.llmBatch
        // call instead of N serial tools.llmQuery awaits.
        pendingBatches.delete(id);
        entry.resolve(responses as string[]);

        resetInactivityTimer();

        const raceResult = await raceExecution();
        return { content: [{ type: "text", text: formatRaceResponse(raceResult) }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
}

// Cleanup on exit. SIGINT / SIGTERM are the canonical termination paths.
// SIGHUP fires when the controlling terminal goes away (e.g. iTerm session
// closed without proper hangup propagation). Without it, the server would
// keep running after its launching terminal died — the original zombie
// process bug.
let shuttingDown = false;
function shutdown(reason: string, exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    closeSession(reason);
  } catch (err) {
    console.error(
      "[Lattice] Error during shutdown:",
      err instanceof Error ? err.message : String(err)
    );
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown("process interrupted"));
process.on("SIGTERM", () => shutdown("process terminated"));
process.on("SIGHUP", () => shutdown("SIGHUP (terminal closed)"));

// CLI flags
const skipCwdChecking = process.argv.includes("--dangerously-skip-cwd-checking");

async function main() {
  // Handle version flag
  if (process.argv.includes("-v") || process.argv.includes("--version")) {
    console.log(`lattice-mcp v${getVersion()}`);
    process.exit(0);
  }

  // Handle help flag. Without this, `lattice-mcp --help` falls through to
  // the stdio MCP transport and blocks waiting for client messages,
  // appearing to hang.
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(
      `lattice-mcp v${getVersion()} — handle-based document analysis MCP server\n` +
        `\n` +
        `Usage: lattice-mcp [options]\n` +
        `\n` +
        `Options:\n` +
        `  -v, --version                       Print version and exit\n` +
        `  -h, --help                          Show this help and exit\n` +
        `      --dangerously-skip-cwd-checking Disable CWD path safety check\n` +
        `\n` +
        `The server speaks the Model Context Protocol over stdio. It is meant\n` +
        `to be launched by an MCP client (Claude Code, Claude Desktop, etc.)\n` +
        `rather than invoked directly. The server exits automatically when\n` +
        `the client closes stdin (EOF) or sends SIGINT/SIGTERM/SIGHUP.\n` +
        `\n` +
        `Environment:\n` +
        `  LATTICE_TIMEOUT_MS   Session inactivity timeout in ms (default: 600000)`
    );
    process.exit(0);
  }

  const server = new Server(
    {
      name: "lattice",
      version: getVersion(),
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, (args as Record<string, unknown>) || {});
  });

  const transport = new StdioServerTransport();

  // Detect parent disconnect. The MCP SDK's StdioServerTransport only
  // listens for `data` / `error` on stdin, never `end` / `close`, so when
  // the client closes its end of the pipe (or the host process dies
  // without delivering SIGTERM/SIGHUP) nothing tells us to exit and the
  // process lingers forever. Attach our own EOF listeners and a transport
  // onclose so any of those paths shuts us down.
  //
  // Order matters: set `transport.onclose` BEFORE `server.connect(transport)`
  // because the SDK's Protocol.connect() WRAPS the existing onclose:
  //   const _onclose = this.transport?.onclose;
  //   this._transport.onclose = () => { _onclose?.(); this._onclose(); };
  // Setting it after connect() would overwrite the wrapper and skip the
  // protocol's own cleanup (clearing response handlers, aborting in-flight
  // requests, etc.). Setting it before lets our handler compose cleanly.
  transport.onclose = () => shutdown("transport closed");
  process.stdin.on("end", () => shutdown("stdin EOF (client disconnected)"));
  process.stdin.on("close", () => shutdown("stdin closed (client disconnected)"));

  // Install the sampling bridge BEFORE awaiting `server.connect()`.
  //
  // Subtle race: `server.connect(transport)` returns after the transport
  // handshake, but `_clientCapabilities` is populated only when the
  // server's `_oninitialize()` handler runs in response to the client's
  // first `initialize` request — which happens *after* connect() returns,
  // on a subsequent event-loop tick. So reading `getClientCapabilities()`
  // synchronously after `connect()` always returns undefined (the bridge
  // never gets installed under that design). The lazy-check pattern here
  // sidesteps that race entirely: we always install the bridge, and each
  // call re-reads capabilities at invocation time. By the time the first
  // tool call arrives the client has already initialized, so the lazy
  // check sees the right capabilities.
  samplingBridge = async (prompt: string): Promise<string> => {
    const caps = server.getClientCapabilities();
    if (caps?.sampling) {
      // Native MCP sampling path — client supports sampling/createMessage.
      const result = await server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens: SAMPLING_MAX_TOKENS,
        includeContext: "none",
      });
      if (result.content?.type === "text") {
        return result.content.text;
      }
      return `[sub-LLM returned non-text content: ${result.content?.type ?? "unknown"}]`;
    }

    // Fallback: multi-turn protocol for clients without sampling.
    // Create a pending Promise that the tool handler will return as a
    // suspension request. The LLM client calls lattice_llm_respond to
    // resolve it and continue execution. Works with any MCP client.
    const id = makePendingId("q");

    const promise = new Promise<string>((resolve, reject) => {
      pendingQueries.set(id, { id, prompt, resolve, reject, createdAt: Date.now() });
    });

    // Signal the tool handler that we've suspended.
    //
    // Two paths:
    // 1. Nested llm_query (inside map/filter): fires on a microtask AFTER
    //    raceExecution() installed suspensionCallback. Call it directly.
    // 2. Top-level llm_query: fires synchronously inside session.execute()
    //    BEFORE raceExecution() runs. Store in earlySuspension for pickup.
    if (suspensionCallback) {
      suspensionCallback({ type: "query", id, prompt });
    } else {
      earlySuspension = { type: "query", id, prompt };
    }

    return promise;
  };

  // Parallel batch bridge for (llm_batch …). When the client advertises
  // sampling, fall back to N parallel createMessage calls (still a win
  // over map+llm_query's serial dispatch). Otherwise, use the multi-turn
  // suspension protocol with a SINGLE pending entry carrying all N
  // prompts — one round-trip, regardless of collection size.
  samplingBatchBridge = async (
    prompts: string[],
    options?: { calibrate?: boolean }
  ): Promise<string[]> => {
    const caps = server.getClientCapabilities();
    if (caps?.sampling) {
      return Promise.all(
        prompts.map(async (p) => {
          const result = await server.createMessage({
            messages: [{ role: "user", content: { type: "text", text: p } }],
            maxTokens: SAMPLING_MAX_TOKENS,
            includeContext: "none",
          });
          if (result.content?.type === "text") {
            return result.content.text;
          }
          return `[sub-LLM returned non-text content: ${result.content?.type ?? "unknown"}]`;
        })
      );
    }

    const id = makePendingId("b");
    const calibrate = options?.calibrate;
    const promise = new Promise<string[]>((resolve, reject) => {
      pendingBatches.set(id, {
        id,
        prompts,
        resolve,
        reject,
        createdAt: Date.now(),
        calibrate,
      });
    });

    if (suspensionCallback) {
      suspensionCallback({ type: "batch", id, prompts, calibrate });
    } else {
      earlySuspension = { type: "batch", id, prompts, calibrate };
    }

    return promise;
  };

  // Phase 1 — recursive child Nucleus session for `(rlm_query …)`.
  // Spawns runRLMFromContent inside the solver. The child's
  // llmClient is `samplingBridge` (the same one the parent uses),
  // so each child turn fires through the same MCP suspension /
  // sampling protocol. The MCP user experiences M suspensions per
  // (rlm_query …) call where M is the child's turn count to FINAL.
  //
  // This is the bridge that closes the runRLM-vs-MCP feature gap
  // for recursive primitives.
  samplingRlmBridge = async (
    prompt: string,
    contextDoc: string | null
  ): Promise<string> => {
    if (!samplingBridge) {
      return "Error: rlm_query unavailable — samplingBridge not initialized";
    }
    // Child's working document. contextDoc === null means the user
    // OMITTED the (context …) form — fall back to the prompt so a
    // no-context rlm_query still has something to operate on. An
    // EMPTY string ("") means the user passed an explicit but
    // empty context (e.g., `(context [])` — empty handle); preserve
    // their intent and let the child see an empty document.
    // Conflating the two would silently mask "I expected results
    // but got none" bugs — same correctness fix applied in
    // rlm.ts's rlmQuerySpawner during the Phase 1 review.
    const childDoc = contextDoc !== null ? contextDoc : prompt;
    try {
      const result = await runRLMFromContent(prompt, childDoc, {
        llmClient: samplingBridge,
        adapter: createNucleusAdapter(),
        // Conservative cap — every child turn is an MCP round-trip
        // for the user. 4 turns lets the child grep + analyze +
        // FINAL with one slack turn. Configurable later if needed.
        maxTurns: 4,
        ragEnabled: false,
        verbose: false,
      });
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: rlm_query child failed — ${msg}`;
    }
  };

  // Phase 2 — sequential variant for `(rlm_batch …)` in the MCP
  // path. We run children ONE AT A TIME instead of via Promise.all
  // because the multi-turn suspension protocol can only carry ONE
  // pending llm_query suspension at a time: if 5 children all
  // suspend in parallel, only the first suspension reaches the
  // user via the lattice_query reply, and the other 4 hang
  // forever in pendingQueries with no way for the user to respond
  // to them. Sequential dispatch trades parallelism for protocol
  // correctness.
  //
  // For sampling-capable clients (samplingBridge uses
  // server.createMessage directly, no suspension), concurrent
  // dispatch would work — but rlm_batch already only matters when
  // each child runs multiple turns, and serializing N children
  // each running M turns = N*M round-trips either way. The
  // round-trip count is identical; only wall-clock differs.
  // Per project rule (correctness > performance): take the
  // correct sequential path uniformly.
  //
  // Per-item errors still surface as marker strings without
  // aborting the rest of the batch.
  samplingRlmBatchBridge = async (
    items: Array<{ prompt: string; contextDoc: string | null }>
  ): Promise<string[]> => {
    if (!samplingRlmBridge) {
      return items.map(
        (_, i) => `Error: rlm_batch item ${i} — samplingRlmBridge not initialized`
      );
    }
    const results: string[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      try {
        results.push(await samplingRlmBridge(items[idx].prompt, items[idx].contextDoc));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`Error: rlm_batch item ${idx} failed — ${msg}`);
      }
    }
    return results;
  };

  await server.connect(transport);

  console.error("[Lattice] LLM query bridge installed — (llm_query ...) uses MCP sampling when available, multi-turn protocol otherwise");
  console.error("[Lattice] RLM bridge installed — (rlm_query …) and (rlm_batch …) spawn child Nucleus sessions");

  console.error("[Lattice] MCP server started (handle-based mode)");
  console.error(`[Lattice] Session timeout: ${SESSION_TIMEOUT_MS / 1000}s`);
  console.error(`[Lattice] Max document size: ${MAX_DOCUMENT_SIZE / 1024 / 1024}MB`);
  if (skipCwdChecking) {
    console.error("[Lattice] WARNING: CWD path checking is DISABLED (--dangerously-skip-cwd-checking)");
  }
  console.error("[Lattice] Query results return handle stubs for 97%+ token savings");
}

// Only auto-start the MCP server when this file is invoked as the entry
// point (i.e. via the `lattice-mcp` bin). Tests import named helpers
// like `sweepStalePending` and `makePendingId` from this module — without
// this guard, every test worker would silently spin up a stdio server
// connected to its own stdin/stdout, which conflicts with vitest's I/O.
//
// Compare realpaths on both sides. A naive `import.meta.url === pathToFileURL(argv[1])`
// check breaks when the bin is reached through an `npm link` symlink:
// `argv[1]` keeps the symlinked path (e.g. /opt/homebrew/lib/.../dist/lattice-mcp-server.js)
// while `import.meta.url` resolves through it to the real source path.
// The mismatch made `main()` never run — so `--version` printed nothing
// and the server silently failed to start under symlinked installs.
function detectEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  try {
    const argv1Real = realpathSync(argv1);
    const moduleReal = realpathSync(fileURLToPath(import.meta.url));
    return argv1Real === moduleReal;
  } catch {
    return false;
  }
}
const isEntryPoint = detectEntryPoint();

if (isEntryPoint) {
  main().catch((err) => {
    console.error("[Lattice] Fatal error:", err);
    process.exit(1);
  });
}
