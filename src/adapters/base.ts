/**
 * Base Model Adapter
 *
 * Default adapter implementation that works with most models.
 * Other adapters can spread this and override specific methods.
 */

import type { ModelAdapter, FinalVarMarker } from "./types.js";

/**
 * Build the default system prompt for the RLM
 */
function buildSystemPrompt(
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
 */
function extractCode(response: string): string | null {
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
function extractFinalAnswer(
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
 * Get feedback message when model provides no code block
 */
function getNoCodeFeedback(): string {
  return `No code block found. You MUST write JavaScript code:
\`\`\`javascript
const hits = grep("keyword");
console.log(JSON.stringify(hits, null, 2));
\`\`\``;
}

/**
 * Get feedback message when code execution fails
 */
function getErrorFeedback(error: string): string {
  return `The previous code had an error: ${error}\nFix the code and try again.`;
}

/**
 * Create the base adapter instance
 */
export function createBaseAdapter(): ModelAdapter {
  return {
    name: "base",
    buildSystemPrompt,
    extractCode,
    extractFinalAnswer,
    getNoCodeFeedback,
    getErrorFeedback,
  };
}

// Export individual functions for use by other adapters that want to extend
export {
  buildSystemPrompt as baseBuildSystemPrompt,
  extractCode as baseExtractCode,
  extractFinalAnswer as baseExtractFinalAnswer,
  getNoCodeFeedback as baseGetNoCodeFeedback,
  getErrorFeedback as baseGetErrorFeedback,
};
