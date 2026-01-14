/**
 * RLM Execution Loop
 *
 * Implements the Recursive Language Model pattern from the paper.
 * The LLM iteratively writes TypeScript code to explore documents,
 * feeding results back until it reaches a final answer.
 */

import { readFile } from "node:fs/promises";
import { createSandboxWithSynthesis, type SandboxWithSynthesis } from "./synthesis/sandbox-tools.js";
import { SynthesisCoordinator } from "./synthesis/coordinator.js";
import { collectExamplesFromResult, extractGrepResults } from "./synthesis/example-collector.js";
import { createToolRegistry, getToolInterfaces } from "./tools.js";
import type { LLMQueryFn } from "./llm/types.js";
import type { ModelAdapter, FinalVarMarker, RAGHints } from "./adapters/types.js";
import { createNucleusAdapter } from "./adapters/nucleus.js";
import type { SynthesisConstraint } from "./constraints/types.js";
import { verifyResult } from "./constraints/verifier.js";
import { getRAGManager, type RAGManager } from "./rag/manager.js";
import { analyzeExecution, getEncouragement } from "./feedback/execution-feedback.js";
import { parse as parseLC } from "./logic/lc-parser.js";
import { isClassifyTerm, validateClassifyExamples } from "./logic/lc-compiler.js";
import { inferType, typeToString } from "./logic/type-inference.js";
import { solve as solveTerm, type SolverTools, type Bindings } from "./logic/lc-solver.js";

/**
 * Create SolverTools from document content
 * These are the same tools the sandbox provides, but standalone for the solver
 */
function createSolverTools(context: string): SolverTools {
  const lines = context.split("\n");

  // Pre-compute text stats
  const textStats = {
    length: context.length,
    lineCount: lines.length,
    sample: {
      start: lines.slice(0, 5).join("\n"),
      middle: lines
        .slice(
          Math.floor(lines.length / 2) - 2,
          Math.floor(lines.length / 2) + 3
        )
        .join("\n"),
      end: lines.slice(-5).join("\n"),
    },
  };

  // Fuzzy search implementation
  // Adapted from FUZZY_SEARCH_IMPL for direct use
  function fuzzyMatch(str: string, query: string): number {
    const strLower = str.toLowerCase();
    const queryLower = query.toLowerCase();

    // Exact match bonus
    if (strLower.includes(queryLower)) {
      return 100 + queryLower.length;
    }

    // Fuzzy match
    let score = 0;
    let queryIndex = 0;
    let prevMatchIndex = -1;

    for (let i = 0; i < strLower.length && queryIndex < queryLower.length; i++) {
      if (strLower[i] === queryLower[queryIndex]) {
        score += 10;
        // Bonus for consecutive matches
        if (prevMatchIndex === i - 1) {
          score += 5;
        }
        prevMatchIndex = i;
        queryIndex++;
      }
    }

    // Return 0 if didn't match all query chars
    return queryIndex === queryLower.length ? score : 0;
  }

  return {
    context,

    grep: (pattern: string) => {
      const flags = "gmi";
      const regex = new RegExp(pattern, flags);
      const results: Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }> = [];
      let match;

      while ((match = regex.exec(context)) !== null) {
        const beforeMatch = context.slice(0, match.index);
        const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;
        const line = lines[lineNum - 1] || "";

        results.push({
          match: match[0],
          line: line,
          lineNum: lineNum,
          index: match.index,
          groups: match.slice(1),
        });

        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }

      return results;
    },

    fuzzy_search: (query: string, limit: number = 10) => {
      const results: Array<{ line: string; lineNum: number; score: number }> = [];

      for (let i = 0; i < lines.length; i++) {
        const score = fuzzyMatch(lines[i], query);
        if (score > 0) {
          results.push({
            line: lines[i],
            lineNum: i + 1,
            score,
          });
        }
      }

      // Sort by score descending, take top limit
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    },

    text_stats: () => ({ ...textStats }),
  };
}

// Re-export types for backwards compatibility
export type { FinalVarMarker } from "./adapters/types.js";

/**
 * Analyze grep results and automatically synthesize extractors
 * Returns synthesized code to inject into feedback, or null if no synthesis needed
 */
function synthesizeFromGrepResults(
  logs: string[],
  code: string,
  coordinator: SynthesisCoordinator,
  verbose: boolean
): string | null {
  // Only process if this looks like a grep call
  if (!code.includes("grep(")) {
    return null;
  }

  // Try to parse grep results from logs
  const grepResults = extractGrepResults(logs);
  if (grepResults.length === 0) {
    return null;
  }

  // Look for currency values in the grep results
  const currencyExamples: Array<{ input: string; output: number }> = [];
  const currencyPattern = /\$[\d,]+/;

  for (const gr of grepResults) {
    const match = gr.line.match(currencyPattern);
    if (match) {
      const rawValue = match[0];
      const numericValue = parseFloat(rawValue.replace(/[$,]/g, ""));
      if (!isNaN(numericValue)) {
        currencyExamples.push({ input: rawValue, output: numericValue });
      }
    }
  }

  if (currencyExamples.length < 2) {
    return null; // Need at least 2 examples for synthesis
  }

  // Collect examples for the coordinator
  collectExamplesFromResult({ result: null, logs }, code, coordinator);

  // Synthesize an extractor from the examples
  const synthesisResult = coordinator.synthesize({
    type: "extractor",
    description: "currency_extractor",
    positiveExamples: currencyExamples.map(e => e.input),
    expectedOutputs: currencyExamples.map(e => e.output),
  });

  if (!synthesisResult.success) {
    return null;
  }

  if (verbose) {
    console.log(`[Synthesis] Automatically synthesized extractor from ${currencyExamples.length} examples`);
  }

  // Generate code that uses the synthesized extractor
  const synthesizedCode = `
## SYNTHESIZED EXTRACTOR (use this instead of writing your own regex!)

I detected currency values in the grep results and synthesized an extractor for you.
Use this code to extract and sum the values:

\`\`\`javascript
// Synthesized extractor from examples: ${currencyExamples.slice(0, 3).map(e => e.input).join(", ")}
let total = 0;
for (const hit of hits) {
  // Extract currency value from each line
  const match = hit.line.match(/\\$([\\d,]+)/);
  if (match) {
    const value = parseFloat(match[1].replace(/,/g, ""));
    total += value;
    console.log(hit.line, "->", value);
  }
}
console.log("Total:", total);
\`\`\`

Use THIS code in your next turn. Do NOT hardcode values or make up data.`;

  return synthesizedCode;
}

/**
 * Generate classifier guidance from grep output
 * Shows the model concrete example lines to use with (classify ...)
 */
function generateClassifierGuidance(
  logs: string[],
  query: string
): string | null {
  // Look for JSON array in logs that contains grep results
  // The JSON may be spread across multiple log lines (pretty-printed)
  let grepResults: Array<{ line: string; lineNum: number }> = [];

  // First, try to find and parse multi-line JSON
  const fullLog = logs.join("\n");

  // Look for JSON array pattern in the combined logs
  const jsonMatch = fullLog.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.line) {
        grepResults = parsed;
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  // Also try individual lines (single-line JSON)
  if (grepResults.length === 0) {
    for (const log of logs) {
      const trimmed = log.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          if (arr.length > 0 && arr[0]?.line) {
            grepResults = arr;
            break;
          }
        } catch {
          // Not valid JSON, continue
        }
      }
    }
  }

  if (grepResults.length < 2) {
    return null; // Need at least 2 results to show diverse examples
  }

  // Pick diverse example lines (first, middle, last if available)
  const examples: string[] = [];
  const indices = [0];
  if (grepResults.length > 2) {
    indices.push(Math.floor(grepResults.length / 2));
  }
  if (grepResults.length > 1) {
    indices.push(grepResults.length - 1);
  }

  for (const idx of indices) {
    const line = grepResults[idx].line;
    // Escape quotes for S-expression string
    const escaped = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    examples.push(escaped);
  }

  // Generate the guidance with concrete examples
  return `
## NEXT STEP: Build classifier from these EXACT lines

Your grep found ${grepResults.length} matches. Now use (classify ...) to filter.

Look at the query: "${query}"
- Mark lines that answer the query as \`true\`
- Mark lines that don't answer the query as \`false\`

Example using YOUR grep output:
(classify
  "${examples[0]}" true
  "${examples[examples.length > 1 ? 1 : 0]}" false)

IMPORTANT: Copy the EXACT line strings from above. Do NOT paraphrase or modify them.`;
}

export interface RLMOptions {
  llmClient: LLMQueryFn;
  /** Model adapter for prompt/response handling. Uses base adapter if not specified. */
  adapter?: ModelAdapter;
  maxTurns?: number;
  turnTimeoutMs?: number;
  maxSubCalls?: number;
  verbose?: boolean;
  /** Output constraint for verification (Barliman-style constraint-first synthesis) */
  constraint?: SynthesisConstraint;
  /** Enable RAG for few-shot learning and self-correction (default: true) */
  ragEnabled?: boolean;
  /** Session ID for tracking failures (default: auto-generated) */
  sessionId?: string;
}

/**
 * Build the system prompt for the RLM
 * @deprecated Use adapter.buildSystemPrompt() instead
 * @param contextLength - Length of the document in characters
 * @param toolInterfaces - TypeScript interface definitions for available tools
 */
export function buildSystemPrompt(
  contextLength: number,
  toolInterfaces: string
): string {
  const formattedLength = contextLength.toLocaleString();

  return `You are a headless JavaScript runtime. You have NO EYES. You cannot read the document directly.
The document is loaded in the global variable \`context\` (length: ${formattedLength}).

To "see" the data, you MUST write JavaScript code, execute it, and read the \`console.log\` output in the next turn.

## GLOBAL CONSTANTS & TOOLS
// All tools are pre-loaded. DO NOT use 'import' or 'require'.
${toolInterfaces}

## STRICT EXECUTION RULES
1. **NO CHAT.** do not write any text outside of code blocks.
2. **NO GUESSING.** If you answer without seeing a \`console.log\` proving it, you will be terminated.
3. **NO IMPORTS.** Standard JS objects (Math, JSON, RegExp) are available. File system (fs) is BANNED.
4. **MEMORY.** Use the global \`memory\` array to store findings between turns.
   Example: \`memory.push({ key: "sales_Q1", value: 500 })\`

## HOW TO THINK
Because you cannot chat, write your plan in comments inside the code block.
Example:
\`\`\`javascript
// Step 1: Search for data
const hits = grep("keyword");  // Returns array of {match, line, lineNum}
console.log(JSON.stringify(hits, null, 2));

// Step 2: Process results - use hit.line to get full line content
for (const hit of hits) {
    console.log(hit.line);  // hit.line is the full text of the matching line
}
\`\`\`

## CRITICAL RULES
- **ALWAYS use JSON.stringify()** when logging objects or arrays. Plain console.log shows [object Object].
- **NEVER make up data.** If a search returns empty, try different terms or use locate_line() to scan sections.
- **Use the actual document.** The data is in \`context\`. Do not invent fake examples.
- **fuzzy_search takes ONE word only.** For "sales|revenue" use grep() instead, or call fuzzy_search("sales") then fuzzy_search("revenue") separately.

## FORMAT & TERMINATION
You must output exactly ONE JavaScript code block.

When you have PROVEN the answer via code execution, write your answer between the FINAL tags:
\`\`\`javascript
console.log("done");
\`\`\`
<<<FINAL>>>
Write your actual computed answer here with specific numbers from your code output.
<<<END>>>

OR, to return the raw data structure you built:
FINAL_VAR(memory)

## BEGIN SESSION
Goal: Extract the requested information from \`context\`.
Reminder: You are blind. Write code to see.
`;
}

/**
 * Extract code from LLM response
 * @deprecated Use adapter.extractCode() instead
 */
export function extractCode(response: string): string | null {
  // Match typescript, ts, javascript, or js code blocks
  const codeBlockRegex = /```(?:typescript|ts|javascript|js)\n([\s\S]*?)```/;
  const match = response.match(codeBlockRegex);

  if (match && match[1]) {
    return match[1].trim();
  }

  return null;
}

/**
 * Extract final answer from LLM response
 * @deprecated Use adapter.extractFinalAnswer() instead
 */
export function extractFinalAnswer(
  response: string | undefined | null
): string | FinalVarMarker | null {
  if (!response) {
    return null;
  }

  // Check for FINAL_VAR(variableName)
  const varMatch = response.match(/FINAL_VAR\((\w+)\)/);
  if (varMatch) {
    return { type: "var", name: varMatch[1] };
  }

  // Check for <<<FINAL>>>...<<<END>>> delimiters
  const finalMatch = response.match(/<<<FINAL>>>([\s\S]*?)<<<END>>>/);
  if (finalMatch) {
    return finalMatch[1].trim();
  }

  // Check for JSON code block with common answer fields (model trying to provide final answer)
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      // Check for common answer field names
      if (parsed.summary) return parsed.summary;
      if (parsed.response) return parsed.response;
      if (parsed.answer) return parsed.answer;
      // Check for any field that looks like a final value (case-insensitive)
      const valueFields = ['total', 'result', 'value', 'totalsales', 'total_sales', 'count', 'sum', 'answer', 'totals'];
      const keys = Object.keys(parsed);
      const foundKey = keys.find(k => valueFields.includes(k.toLowerCase().replace(/_/g, '')));
      const foundValue = foundKey;

      if (foundValue !== undefined) {
        const value = parsed[foundValue];
        if (parsed.notes) {
          return `${parsed.notes}\n\nResult: ${typeof value === 'number' ? value.toLocaleString() : value}`;
        }
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      // Not valid JSON, ignore
    }
  }

  return null;
}

/**
 * Try to parse a numeric value from a string result
 */
function parseNumericResult(result: unknown): number | null {
  if (typeof result === "number") return result;
  if (typeof result === "string") {
    // Handle strings like "Total: 13000000" or "13,000,000"
    const match = result.match(/[\d,]+(?:\.\d+)?/);
    if (match) {
      const parsed = parseFloat(match[0].replace(/,/g, ""));
      if (!isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Verify a result against constraints, returning verification feedback if invalid
 */
function verifyAndReturnResult(
  result: unknown,
  constraint: SynthesisConstraint | undefined,
  log: (msg: string) => void
): { valid: true; result: unknown } | { valid: false; feedback: string } {
  if (!constraint) {
    return { valid: true, result };
  }

  // Try to coerce string results to the expected type
  let resultToVerify = result;
  if (constraint.output.type === "number" && typeof result === "string") {
    const parsed = parseNumericResult(result);
    if (parsed !== null) {
      resultToVerify = parsed;
    }
  }

  const verification = verifyResult(resultToVerify, constraint);

  if (verification.valid) {
    log(`[Verification] Result satisfies all constraints`);
    return { valid: true, result: resultToVerify };
  }

  log(`[Verification] Result FAILED constraint verification:`);
  for (const error of verification.errors) {
    log(`  - ${error}`);
  }

  const feedback = `## CONSTRAINT VIOLATION\n\n` +
    `Your result does not satisfy the required constraints:\n` +
    verification.errors.map(e => `- ${e}`).join("\n") +
    `\n\nPlease fix your approach and try again.`;

  return { valid: false, feedback };
}

/**
 * Run the RLM execution loop
 */
export async function runRLM(
  query: string,
  filePath: string,
  options: RLMOptions
): Promise<unknown> {
  const {
    llmClient,
    adapter = createNucleusAdapter(),
    maxTurns = 10,
    turnTimeoutMs = 30000,
    maxSubCalls = 10,
    verbose = false,
    constraint,
    ragEnabled = true,
    sessionId = `session-${Date.now()}`,
  } = options;

  const log = (msg: string) => {
    if (verbose) console.log(msg);
  };

  // Initialize RAG manager for few-shot learning
  let ragManager: RAGManager | null = null;
  let ragHints: RAGHints | undefined;

  if (ragEnabled) {
    ragManager = getRAGManager();
    const hints = ragManager.getHints(query, 2);
    const hintsText = ragManager.formatHintsForPrompt(hints);
    const selfCorrectionText = ragManager.generateSelfCorrectionFeedback(sessionId);

    if (hintsText || selfCorrectionText) {
      ragHints = {
        hintsText,
        selfCorrectionText: selfCorrectionText || undefined,
      };
      log(`[RAG] Retrieved ${hints.length} hints for query`);
      if (selfCorrectionText) {
        log(`[RAG] Including self-correction feedback from previous failures`);
      }
    }
  }

  // Load document
  let documentContent: string;
  try {
    documentContent = await readFile(filePath, "utf-8");
  } catch (err) {
    const error = err as Error;
    return `Error loading file: ${error.message}`;
  }

  log(`\n[RLM] Loaded document: ${documentContent.length.toLocaleString()} characters`);

  // Build system prompt using the adapter (with RAG hints if enabled)
  const registry = createToolRegistry();
  const toolInterfaces = getToolInterfaces(registry);
  const systemPrompt = adapter.buildSystemPrompt(documentContent.length, toolInterfaces, ragHints);

  log(`[RLM] Using adapter: ${adapter.name}`);
  log(`[RLM] Adapter type: ${adapter.name.includes("barliman") ? "Barliman (constraint-based synthesis)" : "Standard"}`);

  if (verbose && adapter.name.includes("barliman")) {
    log(`\n[Barliman] Workflow:`);
    log(`  1. LLM searches document with grep()`);
    log(`  2. LLM provides constraints (input/output examples) to synthesize_extractor()`);
    log(`  3. Synthesizer builds a function from examples`);
    log(`  4. If synthesis fails, LLM gets feedback and refines constraints`);
  }

  // Create synthesis coordinator and sandbox with synthesis tools
  const coordinator = new SynthesisCoordinator();
  const sandbox: SandboxWithSynthesis = await createSandboxWithSynthesis(
    documentContent,
    llmClient,
    coordinator,
    {
      maxSubCalls,
      timeoutMs: turnTimeoutMs,
      verbose,
    }
  );

  log(`[RLM] Sandbox created with synthesis tools (maxSubCalls: ${maxSubCalls}, timeout: ${turnTimeoutMs}ms)`);

  // Build user message with optional constraints
  let userMessage = `Query: ${query}`;
  if (constraint) {
    userMessage += `\n\n## OUTPUT CONSTRAINTS\n`;
    userMessage += `Your final answer MUST satisfy these constraints:\n`;
    userMessage += `- Type: ${constraint.output.type}\n`;
    if (constraint.output.min !== undefined) {
      userMessage += `- Minimum: ${constraint.output.min}\n`;
    }
    if (constraint.output.max !== undefined) {
      userMessage += `- Maximum: ${constraint.output.max}\n`;
    }
    if (constraint.output.integer) {
      userMessage += `- Must be an integer\n`;
    }
    if (constraint.invariants) {
      for (const inv of constraint.invariants) {
        userMessage += `- Invariant: ${inv}\n`;
      }
    }
    userMessage += `\nBefore returning your answer, VERIFY it satisfies these constraints.`;
    log(`[RLM] Output constraint: ${constraint.output.type}`);
  }

  // Build conversation history
  const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  // Track whether code has been executed (to detect hallucination risk)
  let codeExecuted = false;
  // Track if the last execution had an error (don't accept answers after errors)
  let lastExecutionHadError = false;
  // Track if last output was unhelpful (like [object Object])
  let lastOutputWasUnhelpful = false;
  // Track repeated "done" patterns to detect stuck model
  let doneCount = 0;
  let lastMeaningfulOutput = "";
  // Track consecutive no-code responses to detect stuck model
  let noCodeCount = 0;
  // Track last executed code to detect repetition
  let lastCode = "";
  // Track result counts for better feedback
  let lastResultCount = 0;
  let previousResultCount = 0;
  // Bindings for cross-turn state - allows referencing previous results
  const solverBindings: Bindings = new Map();

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      log(`\n${"─".repeat(50)}`);
      log(`[Turn ${turn}/${maxTurns}] Querying LLM...`);

      // Build prompt from history
      const prompt = history.map((h) => `${h.role.toUpperCase()}: ${h.content}`).join("\n\n");

      // Get LLM response
      const response = await llmClient(prompt);
      if (!response) {
        return `Error: LLM returned empty response at turn ${turn}`;
      }
      history.push({ role: "assistant", content: response });

      // Extract and execute code FIRST (before checking final answer)
      // This ensures if response has both code and final marker, code runs first
      const code = adapter.extractCode(response);
      if (code) {
        // Check if the code block contains <<<FINAL>>> markers (model put answer inside code block)
        const finalInCode = code.match(/<<<FINAL>>>([\s\S]*?)<<<END>>>/);
        if (finalInCode) {
          log(`[Turn ${turn}] Found final answer inside code block`);
          if (!codeExecuted) {
            log(`[Turn ${turn}] Rejecting - no code executed yet`);
            const feedback = `You put <<<FINAL>>> inside the code block. First run code to get the answer, then put <<<FINAL>>> OUTSIDE the code block.`;
            history.push({ role: "user", content: feedback });
            continue;
          }
          const extractedAnswer = finalInCode[1].trim();
          // Validate the extracted answer doesn't look like code
          // (model might have put FINAL markers inside console.log strings)
          const looksLikeCode = /console\.log|function\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|\);|\(\s*["']/.test(extractedAnswer);
          if (looksLikeCode) {
            log(`[Turn ${turn}] Rejecting - extracted content looks like code, not an answer`);
            const feedback = `ERROR: You put <<<FINAL>>> markers inside your code/strings, not after the code block.

The FINAL markers must be OUTSIDE and AFTER your code block:
\`\`\`javascript
console.log("done");
\`\`\`
<<<FINAL>>>
Your actual answer here (plain text, not code)
<<<END>>>

Try again with proper formatting.`;
            history.push({ role: "user", content: feedback });
            continue;
          }
          return extractedAnswer;
        }

        codeExecuted = true;
        noCodeCount = 0; // Reset no-code counter on successful code extraction

        // Check if code is being repeated
        const isRepeatedCode = code.trim() === lastCode.trim();
        if (isRepeatedCode) {
          log(`[Turn ${turn}] WARNING: Repeated code detected`);
          history.push({ role: "user", content: adapter.getRepeatedCodeFeedback(lastResultCount) });
          continue;
        }
        lastCode = code;

        // NUCLEUS LC EXECUTION: All models use Lambda Calculus terms
        // This reduces token entropy and allows formal verification
        log(`[Turn ${turn}] Parsing LC term...`);

        // Parse the LC term
        const lcResult = parseLC(code);

        if (!lcResult.success || !lcResult.term) {
          log(`[Turn ${turn}] LC parse error: ${lcResult.error}`);
          log(`[Turn ${turn}] Failed to parse: ${code}`);
          history.push({
            role: "user",
            content: adapter.getErrorFeedback(lcResult.error || "Parse error", code),
          });
          continue;
        }

        log(`[Turn ${turn}] LC term parsed successfully`);

        // Type inference (fail-fast validation)
        const typeResult = inferType(lcResult.term);
        if (!typeResult.valid) {
          log(`[Turn ${turn}] Type inference failed: ${typeResult.error}`);
          history.push({
            role: "user",
            content: `Type error: ${typeResult.error}\n\nCheck your LC term structure.`,
          });
          continue;
        }

        if (typeResult.type) {
          log(`[Turn ${turn}] Inferred type: ${typeToString(typeResult.type)}`);
        }

        // Validate classify examples against previous grep output
        if (isClassifyTerm(lcResult.term)) {
          const prevLogs = history
            .filter((h) => h.role === "user" && h.content.includes("Logs:"))
            .flatMap((h) => h.content.split("\n"));

          const validationError = validateClassifyExamples(lcResult.term, prevLogs);
          if (validationError) {
            log(`[Turn ${turn}] Classify validation error: ${validationError}`);
            history.push({
              role: "user",
              content: `ERROR: ${validationError}\n\nCopy the EXACT lines from the grep output above.`,
            });
            continue;
          }
        }

        // Execute LC term directly using the solver (miniKanren-backed)
        log(`[Turn ${turn}] Executing LC term with solver...`);
        log(`[Turn ${turn}] Term: ${code}`);
        if (solverBindings.size > 0) {
          log(`[Turn ${turn}] Available bindings: ${[...solverBindings.keys()].join(", ")}`);
        }

        const solverTools = createSolverTools(documentContent);
        const solverResult = solveTerm(lcResult.term, solverTools, solverBindings);

        // Convert solver result to sandbox-compatible result format
        const result = {
          result: solverResult.value,
          logs: solverResult.logs,
          error: solverResult.success ? undefined : solverResult.error,
        };

        // Bind result for next turn - model can reference as RESULTS or _N
        if (solverResult.success && solverResult.value !== null && solverResult.value !== undefined) {
          solverBindings.set("RESULTS", solverResult.value);
          solverBindings.set(`_${turn}`, solverResult.value);
          // Track result count for better feedback
          previousResultCount = lastResultCount;
          lastResultCount = Array.isArray(solverResult.value) ? solverResult.value.length : 1;
          log(`[Turn ${turn}] Bound result to RESULTS and _${turn}`);
        } else {
          previousResultCount = lastResultCount;
          lastResultCount = 0;
        }

        // Build execution feedback with truncation to minimize context passing
        const MAX_OUTPUT_LENGTH = 4000; // Max chars per output section
        const truncate = (s: string, max: number = MAX_OUTPUT_LENGTH): string => {
          if (s.length <= max) return s;
          const half = Math.floor(max / 2) - 20;
          return s.slice(0, half) + `\n... [${s.length - max} chars truncated] ...\n` + s.slice(-half);
        };

        let feedback = `Turn ${turn} Sandbox execution:\n`;

        if (result.logs.length > 0) {
          log(`[Turn ${turn}] Console output:`);
          result.logs.forEach(l => log(`  ${l}`));
          const logsText = result.logs.join("\n");
          feedback += `Logs:\n${truncate(logsText)}\n`;

          // Use centralized feedback system to analyze execution
          const executionFeedback = analyzeExecution({
            code: code,
            logs: result.logs,
            error: result.error,
            turn,
          });

          if (executionFeedback) {
            log(`[Turn ${turn}] Detected issue: ${executionFeedback.type}`);
            feedback += `\n${executionFeedback.message}\n`;
            feedback += `\n${getEncouragement(turn, maxTurns)}\n`;
          }

          // Track meaningful output vs "done" / repeated patterns
          const isDoneOnly = result.logs.length === 1 && result.logs[0].toLowerCase().trim() === "done";
          const isRepeatedOutput = logsText === lastMeaningfulOutput;
          const hasObjectObject = logsText.includes("[object Object]");
          const isUnhelpfulOutput = hasObjectObject || isDoneOnly || (executionFeedback?.shouldReject ?? false);

          if (isUnhelpfulOutput || isRepeatedOutput) {
            lastOutputWasUnhelpful = true;
            doneCount++;
            if (doneCount >= 3 && lastMeaningfulOutput) {
              log(`[Turn ${turn}] Detected stuck pattern. Auto-terminating with last meaningful output.`);
              return lastMeaningfulOutput;
            }
            // Add feedback to encourage different approach
            if (isRepeatedOutput) {
              feedback += `\nWARNING: Output is the same as before. Try a DIFFERENT approach:\n`;
              feedback += `- Use grep("keyword") to search for specific data\n`;
              feedback += `- Try different search terms related to the query\n`;
              feedback += `- Do NOT repeat the same code\n`;
            }
          } else if (!hasObjectObject) {
            lastOutputWasUnhelpful = false;
            // Save meaningful output - prefer computed results over raw data dumps
            // Look for patterns like "Total: X", "Result: X", "Answer: X", or assignments
            const computedMatch = logsText.match(/(?:total|sum|result|answer|count|average|mean)[^:]*:\s*([\d,.]+)/i);
            // Look for any substantial numeric data (4+ digits) or structured output
            const hasRawData = logsText.match(/[\d,]{4,}|"[^"]+"\s*:/);

            if (computedMatch) {
              // Look for the answer line
              const answerLine = result.logs.find(line =>
                /(?:total|sum|result|answer|count|average|mean)[^:]*:/i.test(line)
              );

              if (answerLine) {
                log(`[Turn ${turn}] Computed answer found: ${answerLine}`);
                // Verify constraints if specified
                const verification = verifyAndReturnResult(answerLine, constraint, log);
                if (verification.valid) {
                  log(`[Turn ${turn}] Auto-terminating with computed result`);
                  return verification.result;
                } else {
                  log(`[Turn ${turn}] Constraint violation - continuing`);
                  feedback += `\n${verification.feedback}`;
                }
              }

              // Fallback: save as meaningful output
              lastMeaningfulOutput = logsText;
              doneCount = 0;
            } else if (hasRawData && !lastMeaningfulOutput) {
              // Fall back to raw data only if no computed result yet
              lastMeaningfulOutput = logsText;
              doneCount = 0;
            }
          }
        }

        if (result.error) {
          log(`[Turn ${turn}] Error: ${result.error}`);
          feedback += `Error: ${result.error}\n`;
          lastExecutionHadError = true;

          // Record failure for self-correction learning
          if (ragManager) {
            ragManager.recordFailure({
              query,
              code: code,
              error: result.error,
              timestamp: Date.now(),
              sessionId,
            });
            log(`[RAG] Recorded failure for self-correction`);
          }
        } else {
          lastExecutionHadError = false;
        }

        if (result.result !== undefined && result.result !== null) {
          const resultStr = JSON.stringify(result.result, null, 2);
          log(`[Turn ${turn}] Result: ${resultStr}`);
          feedback += `Result: ${truncate(resultStr)}\n`;
        }

        // Automatically synthesize extractors from grep results
        const synthesizedCode = synthesizeFromGrepResults(result.logs, code, coordinator, verbose);
        if (synthesizedCode) {
          feedback += `\n${synthesizedCode}`;
        }

        // Generate classifier guidance for search results
        const classifierGuidance = generateClassifierGuidance(result.logs, query);
        if (classifierGuidance) {
          feedback += `\n${classifierGuidance}`;
        }

        // Add adapter-specific success feedback (language reminders, etc.)
        feedback += `\n\n${adapter.getSuccessFeedback(lastResultCount, previousResultCount)}`;

        history.push({ role: "user", content: feedback });

        // Check for final answer AFTER code execution (same response may have both)
        // But only if there was no error, output was helpful, and result is not an array
        // (arrays indicate more processing is needed - don't accept premature answers)
        const resultIsArray = Array.isArray(solverResult?.value);
        if (!result.error && !lastOutputWasUnhelpful && !resultIsArray) {
          const finalAnswer = adapter.extractFinalAnswer(response);
          if (finalAnswer !== null) {
            log(`[Turn ${turn}] Final answer found after code execution`);
            let resultToReturn: unknown;
            if (typeof finalAnswer === "object" && finalAnswer.type === "var") {
              log(`[Turn ${turn}] Returning variable: ${finalAnswer.name}`);
              const mem = sandbox.getMemory();
              // If memory is empty but we have meaningful output, return that instead
              if (mem.length === 0 && lastMeaningfulOutput) {
                log(`[Turn ${turn}] Memory empty, returning last meaningful output instead`);
                resultToReturn = lastMeaningfulOutput;
              } else {
                resultToReturn = mem;
              }
            } else {
              resultToReturn = finalAnswer;
            }

            // Verify constraints if specified
            const verification = verifyAndReturnResult(resultToReturn, constraint, log);
            if (verification.valid) {
              return verification.result;
            } else {
              log(`[Turn ${turn}] Constraint violation - continuing`);
              history.push({ role: "user", content: verification.feedback });
              continue;
            }
          }
        }
      } else {
        log(`[Turn ${turn}] No code block found in response`);
        log(`[Turn ${turn}] Raw response (first 500 chars):`);
        log(response.slice(0, 500));

        noCodeCount++;
        // If model is stuck (3+ consecutive no-code responses) and we have meaningful output, return it
        if (noCodeCount >= 3 && lastMeaningfulOutput) {
          log(`[Turn ${turn}] Model stuck (${noCodeCount} consecutive no-code responses). Returning last meaningful output.`);
          const verification = verifyAndReturnResult(lastMeaningfulOutput, constraint, log);
          if (verification.valid) {
            return verification.result;
          }
          // Continue even if verification fails - we need to break out of the stuck state
          return lastMeaningfulOutput;
        }

        // Check for final answer in responses without code
        const finalAnswer = adapter.extractFinalAnswer(response);
        if (finalAnswer !== null) {
          // Reject if no code was ever executed
          if (!codeExecuted) {
            log(`[Turn ${turn}] Rejecting final answer - no code executed yet`);
            const feedback = `ERROR: You tried to answer without reading the document.\n\n${adapter.getNoCodeFeedback()}`;
            history.push({ role: "user", content: feedback });
            continue;
          }

          // Reject if last execution had an error (model might be explaining the error, not answering)
          if (lastExecutionHadError) {
            log(`[Turn ${turn}] Rejecting final answer - last execution had error, need retry`);
            history.push({ role: "user", content: adapter.getErrorFeedback("Previous execution failed") });
            continue;
          }

          log(`[Turn ${turn}] Final answer received`);
          let resultToReturn: unknown;
          if (typeof finalAnswer === "object" && finalAnswer.type === "var") {
            log(`[Turn ${turn}] Returning variable: ${finalAnswer.name}`);
            resultToReturn = sandbox.getMemory();
          } else {
            resultToReturn = finalAnswer;
          }

          // Verify constraints if specified
          const verification = verifyAndReturnResult(resultToReturn, constraint, log);
          if (verification.valid) {
            return verification.result;
          } else {
            log(`[Turn ${turn}] Constraint violation - continuing`);
            history.push({ role: "user", content: verification.feedback });
            continue;
          }
        }

        // Add feedback to prompt the model to provide code
        history.push({ role: "user", content: adapter.getNoCodeFeedback() });
      }
    }

    // Max turns reached
    log(`\n[RLM] Max turns (${maxTurns}) reached without final answer`);
    return `Max turns (${maxTurns}) reached without final answer. Last memory state: ${JSON.stringify(sandbox.getMemory())}`;
  } finally {
    sandbox.dispose();
    log(`\n[RLM] Sandbox disposed`);

    // Clear session-specific failure memory
    if (ragManager) {
      ragManager.clearFailureMemory(sessionId);
      log(`[RAG] Cleared session failure memory`);
    }
  }
}
