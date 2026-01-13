/**
 * RLM Execution Loop
 *
 * Implements the Recursive Language Model pattern from the paper.
 * The LLM iteratively writes TypeScript code to explore documents,
 * feeding results back until it reaches a final answer.
 */

import { readFile } from "node:fs/promises";
import { createSandbox, Sandbox } from "./sandbox.js";
import { createToolRegistry, getToolInterfaces } from "./tools.js";
import { tryFixCode } from "./code-fixer.js";
import type { LLMQueryFn } from "./llm/types.js";
import type { ModelAdapter } from "./adapters/types.js";
import { createBaseAdapter } from "./adapters/base.js";

// Re-export types for backwards compatibility
export type { FinalVarMarker } from "./adapters/types.js";

export interface RLMOptions {
  llmClient: LLMQueryFn;
  /** Model adapter for prompt/response handling. Uses base adapter if not specified. */
  adapter?: ModelAdapter;
  maxTurns?: number;
  turnTimeoutMs?: number;
  maxSubCalls?: number;
  verbose?: boolean;
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
 * Run the RLM execution loop
 */
export async function runRLM(
  query: string,
  filePath: string,
  options: RLMOptions
): Promise<unknown> {
  const {
    llmClient,
    adapter = createBaseAdapter(),
    maxTurns = 10,
    turnTimeoutMs = 30000,
    maxSubCalls = 10,
    verbose = false,
  } = options;

  const log = (msg: string) => {
    if (verbose) console.log(msg);
  };

  // Load document
  let documentContent: string;
  try {
    documentContent = await readFile(filePath, "utf-8");
  } catch (err) {
    const error = err as Error;
    return `Error loading file: ${error.message}`;
  }

  log(`\n[RLM] Loaded document: ${documentContent.length.toLocaleString()} characters`);

  // Build system prompt using the adapter
  const registry = createToolRegistry();
  const toolInterfaces = getToolInterfaces(registry);
  const systemPrompt = adapter.buildSystemPrompt(documentContent.length, toolInterfaces);

  log(`[RLM] Using adapter: ${adapter.name}`);

  // Create sandbox with LLM query function
  const sandbox: Sandbox = await createSandbox(documentContent, llmClient, {
    maxSubCalls,
    timeoutMs: turnTimeoutMs,
  });

  log(`[RLM] Sandbox created (maxSubCalls: ${maxSubCalls}, timeout: ${turnTimeoutMs}ms)`);

  // Build conversation history
  const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Query: ${query}` },
  ];

  // Track whether code has been executed (to detect hallucination risk)
  let codeExecuted = false;
  // Track if the last execution had an error (don't accept answers after errors)
  let lastExecutionHadError = false;
  // Track repeated "done" patterns to detect stuck model
  let doneCount = 0;
  let lastMeaningfulOutput = "";
  // Track consecutive no-code responses to detect stuck model
  let noCodeCount = 0;
  // Track last executed code to detect repetition
  let lastCode = "";

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
          return finalInCode[1].trim();
        }

        codeExecuted = true;
        noCodeCount = 0; // Reset no-code counter on successful code extraction

        // Check if code is being repeated
        const isRepeatedCode = code.trim() === lastCode.trim();
        if (isRepeatedCode) {
          log(`[Turn ${turn}] WARNING: Repeated code detected`);
          const feedback = `ERROR: You are repeating the same code. This will give the same output.

Try a DIFFERENT approach:
- Use grep("sales") to search for sales-related data
- Use grep("SALES_DATA") to find specific data entries
- After finding data, extract numbers and compute the answer

Write NEW code now:`;
          history.push({ role: "user", content: feedback });
          continue;
        }
        lastCode = code;

        log(`[Turn ${turn}] Executing code:`);
        log("```javascript");
        log(code);
        log("```");

        // Try to fix common syntax errors before execution
        const fixResult = tryFixCode(code);
        const codeToRun = fixResult.fixed ? fixResult.code : code;

        if (fixResult.fixed) {
          log(`[Turn ${turn}] Applied auto-fixes: ${fixResult.fixes.join(", ")}`);
        }

        const result = await sandbox.execute(codeToRun, turnTimeoutMs);

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

          // Track meaningful output vs "done" / repeated patterns
          const isDoneOnly = result.logs.length === 1 && result.logs[0].toLowerCase().trim() === "done";
          const isRepeatedOutput = logsText === lastMeaningfulOutput;

          if (isDoneOnly || isRepeatedOutput) {
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
          } else {
            // Save meaningful output - prefer computed results over raw data dumps
            // Look for patterns like "Total: X", "Result: X", "Answer: X", or assignments
            const hasComputedResult = logsText.match(/(?:total|sum|result|answer|count|average|mean)[^:]*:\s*[\d,.]+/i);
            // Look for any substantial numeric data (4+ digits) or structured output
            const hasRawData = logsText.match(/[\d,]{4,}|"[^"]+"\s*:/);

            if (hasComputedResult) {
              // Prefer computed results
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
        } else {
          lastExecutionHadError = false;
        }

        if (result.result !== undefined && result.result !== null) {
          const resultStr = JSON.stringify(result.result, null, 2);
          log(`[Turn ${turn}] Result: ${resultStr}`);
          feedback += `Result: ${truncate(resultStr)}\n`;
        }

        // Remind about final answer format (variables DO persist now)
        feedback += `\nVariables persist between turns. Continue exploring, OR output final answer using <<<FINAL>>> and <<<END>>> tags.`;

        history.push({ role: "user", content: feedback });

        // Check for final answer AFTER code execution (same response may have both)
        // But only if there was no error - let model retry on errors
        if (!result.error) {
          const finalAnswer = adapter.extractFinalAnswer(response);
          if (finalAnswer !== null) {
            log(`[Turn ${turn}] Final answer found after code execution`);
            if (typeof finalAnswer === "object" && finalAnswer.type === "var") {
              log(`[Turn ${turn}] Returning variable: ${finalAnswer.name}`);
              const mem = sandbox.getMemory();
              // If memory is empty but we have meaningful output, return that instead
              if (mem.length === 0 && lastMeaningfulOutput) {
                log(`[Turn ${turn}] Memory empty, returning last meaningful output instead`);
                return lastMeaningfulOutput;
              }
              return mem;
            }
            return finalAnswer;
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
          if (typeof finalAnswer === "object" && finalAnswer.type === "var") {
            log(`[Turn ${turn}] Returning variable: ${finalAnswer.name}`);
            if (finalAnswer.name === "memory") {
              return sandbox.getMemory();
            }
            return sandbox.getMemory();
          }
          return finalAnswer;
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
  }
}
