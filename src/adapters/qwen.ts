/**
 * Qwen Model Adapter
 *
 * Tuned for Qwen and CodeQwen models. These models:
 * - Are strong at code generation but sometimes slip into chat mode
 * - May output JSON responses when they think they have an answer
 * - Benefit from explicit structure in prompts
 */

import type { ModelAdapter, FinalVarMarker } from "./types.js";
import {
  baseExtractCode,
  baseExtractFinalAnswer,
  baseGetNoCodeFeedback,
  baseGetErrorFeedback,
} from "./base.js";

/**
 * Build system prompt tuned for Qwen models
 * Emphasizes code-only responses and stricter format compliance
 */
function buildSystemPrompt(
  contextLength: number,
  toolInterfaces: string
): string {
  const formattedLength = contextLength.toLocaleString();

  return `You are a JavaScript code executor. You ONLY output code. NO CHAT.

A document is loaded in \`context\` (${formattedLength} chars). You cannot read it directly.

## TOOLS (pre-loaded, no imports)
${toolInterfaces}

## PROBLEM-SOLVING APPROACH
ALWAYS start by searching for relevant data:

Step 1 - SEARCH first using grep():
\`\`\`javascript
// Search for keywords related to what you need
const hits = grep("sales|revenue|total");
console.log(JSON.stringify(hits, null, 2));
\`\`\`

Step 2 - EXTRACT data from search results:
\`\`\`javascript
// IMPORTANT: grep returns array of objects: { match, line, lineNum }
// You must use hit.line to get the text content!
let total = 0;
for (const hit of hits) {
  // hit.line is the string - call .match() on hit.line, NOT on hit
  const numMatch = hit.line.match(/\\$([\\d,]+)/);
  if (numMatch) {
    const value = parseFloat(numMatch[1].replace(/,/g, ""));
    total += value;
    console.log(hit.line, "->", value);
  }
}
console.log("Total:", total);
\`\`\`

Step 3 - RETURN answer when done:
\`\`\`javascript
console.log("done");
\`\`\`
<<<FINAL>>>
The total is $X based on the values found.
<<<END>>>

## CRITICAL RULES
- Output ONLY JavaScript code blocks (not Python, not JSON).
- ALWAYS use grep() first to find relevant data.
- grep() returns objects: use hit.line to get the text string.
- Use JSON.stringify() when logging objects/arrays.
- Each turn: run NEW code based on previous output. NEVER repeat the same code.
- Parse numbers: remove $ and commas before parseFloat().

## BEGIN
Search for data related to the query. Use grep() first.
`;
}

/**
 * Extract code from Qwen response
 * Qwen generally follows standard markdown, but may occasionally use variations
 */
function extractCode(response: string): string | null {
  // First try standard extraction
  const standard = baseExtractCode(response);
  if (standard) return standard;

  // Qwen sometimes omits language specifier or uses 'js' shorthand
  const looseMatch = response.match(/```(?:js|javascript|typescript|ts)?\s*\n([\s\S]*?)```/);
  if (looseMatch && looseMatch[1]) {
    const code = looseMatch[1].trim();
    // Validate it looks like code (has semicolons, parens, or common keywords)
    if (/[;(){}]|const |let |var |function |=>|console\.log/.test(code)) {
      return code;
    }
  }

  return null;
}

/**
 * Extract final answer from Qwen response
 * Qwen may output JSON blocks when it thinks it has the answer
 */
function extractFinalAnswer(
  response: string | undefined | null
): string | FinalVarMarker | null {
  if (!response) return null;

  // First try base extraction
  const base = baseExtractFinalAnswer(response);
  if (base) return base;

  // Qwen sometimes outputs bare JSON (not in code block) when it has an answer
  // Only accept this if the JSON has answer-like fields
  const bareJsonMatch = response.match(/^\s*\{[\s\S]*\}\s*$/);
  if (bareJsonMatch) {
    try {
      const parsed = JSON.parse(response.trim());
      const answerFields = ['answer', 'result', 'total', 'totalSales', 'total_sales', 'sum', 'count', 'value', 'response', 'summary'];
      const hasAnswerField = answerFields.some(f =>
        Object.keys(parsed).some(k => k.toLowerCase() === f.toLowerCase())
      );
      if (hasAnswerField) {
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

/**
 * Stronger feedback for Qwen when it doesn't provide code
 */
function getNoCodeFeedback(): string {
  return `ERROR: No code block found or wrong language.

You MUST output JAVASCRIPT code (not Python):
\`\`\`javascript
// Use the data from previous output
let total = 0;
for (const hit of hits) {
  const numMatch = hit.line.match(/\\$([\\d,]+)/);
  if (numMatch) {
    total += parseFloat(numMatch[1].replace(/,/g, ""));
  }
}
console.log("Total:", total);
\`\`\`

NOT Python. NOT JSON. Only JavaScript.`;
}

/**
 * Error feedback for Qwen
 */
function getErrorFeedback(error: string): string {
  // Detect common issues and provide specific guidance
  if (error.includes("is not a function") && (error.includes("split") || error.includes("match") || error.includes("replace"))) {
    return `Code error: ${error}

IMPORTANT: grep() returns objects, not strings!
Each item has: { match, line, lineNum }
Use item.line to get the text:

\`\`\`javascript
for (const item of hits) {
  // item.line is the string - use .match() on item.line
  const numMatch = item.line.match(/\\$([\\d,]+)/);
  if (numMatch) {
    const value = parseFloat(numMatch[1].replace(/,/g, ""));
    console.log(value);
  }
}
\`\`\``;
  }

  return `Code error: ${error}

Fix the bug and output ONLY a JavaScript code block:
\`\`\`javascript
// your fixed code here
\`\`\``;
}

/**
 * Create the Qwen adapter instance
 */
export function createQwenAdapter(): ModelAdapter {
  return {
    name: "qwen",
    buildSystemPrompt,
    extractCode,
    extractFinalAnswer,
    getNoCodeFeedback,
    getErrorFeedback,
  };
}
