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

export interface RLMOptions {
  llmClient: LLMQueryFn;
  maxTurns?: number;
  turnTimeoutMs?: number;
  maxSubCalls?: number;
  verbose?: boolean;
}

export interface FinalVarMarker {
  type: "var";
  name: string;
}

/**
 * Build the system prompt for the RLM
 */
export function buildSystemPrompt(
  contextLength: number,
  toolInterfaces: string
): string {
  const formattedLength = contextLength.toLocaleString();

  return `You are a Recursive Language Model (RLM). You have access to a document stored in the \`context\` variable (${formattedLength} characters).

Your task is to analyze the document by writing JavaScript code that will be executed in a sandbox. You can make multiple turns, each time seeing the results of your code execution.

## CRITICAL RULE

**YOU MUST WRITE AND EXECUTE CODE BEFORE ANSWERING.** You cannot see the document contents directly - you can only access it through code execution. Do NOT guess, hallucinate, or make up data. Every fact in your answer MUST come from code execution results.

If you provide a final answer without first running code to verify the data, your answer will be wrong.

## Sandbox Environment

**IMPORTANT**: Your code runs in an isolated sandbox with these constraints:
- NO \`import\` or \`require\` statements - they will fail
- NO external libraries or npm packages
- ONLY built-in JavaScript (JSON, Math, Array, String, Object, RegExp, etc.)
- ONLY the tools and variables listed below are available

## Available Tools and Variables

${toolInterfaces}

## Guidelines

1. **Start with exploration**: Use \`text_stats()\` to understand document structure without reading all tokens.

2. **Use fuzzy search**: Use \`fuzzy_search(query)\` to find relevant sections efficiently.

3. **Accumulate findings**: Store results in the \`memory\` array to avoid repeating work.
   \`\`\`typescript
   memory.push({ finding: "important detail", location: 42 });
   \`\`\`

4. **Log progress**: Use \`console.log()\` to show what you're discovering. Note: Output is truncated to ~4000 chars, so peek at data with slices like \`context.slice(0, 500)\` rather than printing large blocks.

5. **Avoid iterating full context**: Do NOT loop from 0 to ${formattedLength}. Sample first, then target specific sections.

6. **Sub-queries are expensive**: Use \`llm_query()\` sparingly. Batch related information when possible.

## Code Format

Write your code in a JavaScript code block:
\`\`\`javascript
// Your code here - plain JS only, no imports
\`\`\`

Note: Minor syntax errors (missing semicolons, trailing commas) will be auto-fixed.

## Terminating

**ONLY provide a final answer AFTER you have executed code and verified the data.**

When you have gathered enough information through code execution, use one of these formats:

**For text answers:**
<<<FINAL>>>
Your answer here (can be multiple lines, include quotes, JSON, etc.)
<<<END>>>

**For returning accumulated data:**
FINAL_VAR(memory)

This will return the contents of the memory array as your answer.

## Example Turn

Turn 1:
\`\`\`javascript
const stats = text_stats();
console.log("Document has " + stats.lineCount + " lines");
const matches = fuzzy_search("important keyword");
memory.push(...matches.slice(0, 5));
\`\`\`

Turn 2:
\`\`\`javascript
// Found relevant sections, now analyze
const section = context.slice(1000, 2000);
console.log("Analyzing section:", section.slice(0, 100));
\`\`\`

Turn 3:
<<<FINAL>>>
The document contains information about X. Key findings: ...
<<<END>>>`;
}

/**
 * Extract code from LLM response
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

  // Check for JSON code block with summary (model trying to provide final answer)
  const jsonMatch = response.match(/```json\n([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      // If it has a summary field, treat as final answer
      if (parsed.summary) {
        return parsed.summary;
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
  const { llmClient, maxTurns = 10, turnTimeoutMs = 30000, maxSubCalls = 10, verbose = false } = options;

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

  // Build system prompt
  const registry = createToolRegistry();
  const toolInterfaces = getToolInterfaces(registry);
  const systemPrompt = buildSystemPrompt(documentContent.length, toolInterfaces);

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

      // Check for final answer
      const finalAnswer = extractFinalAnswer(response);
      if (finalAnswer !== null) {
        log(`[Turn ${turn}] Final answer received`);

        // Warn if answering without code execution (high hallucination risk)
        if (!codeExecuted) {
          console.warn(`\n⚠️  WARNING: Model provided answer without executing any code.`);
          console.warn(`   This may indicate hallucinated data. Consider:`);
          console.warn(`   - Using a more capable model`);
          console.warn(`   - Making your query more specific (e.g., "Search for X and sum Y")`);
          console.warn(`   - See README.md Troubleshooting section for details.\n`);
        }

        // Handle FINAL_VAR
        if (typeof finalAnswer === "object" && finalAnswer.type === "var") {
          log(`[Turn ${turn}] Returning variable: ${finalAnswer.name}`);
          if (finalAnswer.name === "memory") {
            return sandbox.getMemory();
          }
          // Could extend to support other variables
          return sandbox.getMemory();
        }
        return finalAnswer;
      }

      // Extract and execute code
      const code = extractCode(response);
      if (code) {
        codeExecuted = true;
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
        }

        if (result.error) {
          log(`[Turn ${turn}] Error: ${result.error}`);
          feedback += `Error: ${result.error}\n`;
        } else if (result.result !== undefined && result.result !== null) {
          const resultStr = JSON.stringify(result.result, null, 2);
          log(`[Turn ${turn}] Result: ${resultStr}`);
          feedback += `Result: ${truncate(resultStr)}\n`;
        }

        // Remind about final answer format
        feedback += `\nIf you have enough information, provide your final answer using this exact format:\n<<<FINAL>>>\n[Write your complete answer to the query here based on the data you found]\n<<<END>>>\n\nOtherwise, write more JavaScript code to continue exploring.`;

        history.push({ role: "user", content: feedback });
      } else {
        log(`[Turn ${turn}] No code block found in response`);
        log(`[Turn ${turn}] Raw response (first 500 chars):`);
        log(response.slice(0, 500));
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
