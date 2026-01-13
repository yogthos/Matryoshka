/**
 * DeepSeek Model Adapter
 *
 * Tuned for DeepSeek models (deepseek-chat, deepseek-coder, etc.). These models:
 * - Have strong instruction-following capabilities
 * - Work well with structured prompts
 * - May benefit from explicit role definition
 */

import type { ModelAdapter, FinalVarMarker } from "./types.js";
import {
  baseExtractCode,
  baseExtractFinalAnswer,
} from "./base.js";

/**
 * Build system prompt tuned for DeepSeek models
 * Uses clear structure and explicit role definition
 */
function buildSystemPrompt(
  contextLength: number,
  toolInterfaces: string
): string {
  const formattedLength = contextLength.toLocaleString();

  return `# Role
You are a JavaScript runtime that executes code to analyze documents. You cannot read documents directly - you must write code.

# Context
- Document loaded in global variable \`context\` (${formattedLength} characters)
- You receive execution results after each code block you write
- Memory persists between turns via the \`memory\` array

# Available Tools
All tools are pre-loaded globals. Do NOT use import/require.

${toolInterfaces}

# Rules
1. Output ONLY JavaScript code blocks - no explanations or chat
2. Use console.log() to see results (stringify objects: JSON.stringify(obj, null, 2))
3. Never guess or make up data - all answers must come from code execution
4. Store findings in memory: memory.push({ key: "label", value: data })

# Code Block Format
\`\`\`javascript
// Your JavaScript code here
const results = grep("pattern");
console.log(JSON.stringify(results, null, 2));
\`\`\`

# Completion Format
When you have proven your answer through code execution:

\`\`\`javascript
console.log("done");
\`\`\`
<<<FINAL>>>
Your answer with specific values from your code output
<<<END>>>

Or to return structured data:
FINAL_VAR(memory)

# Task
Analyze the document in \`context\` to answer the user's query.
Write code to explore. No chat allowed.
`;
}

/**
 * Extract code from DeepSeek response
 * DeepSeek follows standard markdown well
 */
function extractCode(response: string): string | null {
  // DeepSeek is well-behaved with code blocks, use base extraction
  return baseExtractCode(response);
}

/**
 * Extract final answer from DeepSeek response
 */
function extractFinalAnswer(
  response: string | undefined | null
): string | FinalVarMarker | null {
  if (!response) return null;

  // DeepSeek follows instructions well, base extraction should work
  return baseExtractFinalAnswer(response);
}

/**
 * Feedback for DeepSeek when no code provided
 */
function getNoCodeFeedback(): string {
  return `No code block detected.

Required format:
\`\`\`javascript
const data = grep("keyword");
console.log(JSON.stringify(data, null, 2));
\`\`\`

Provide JavaScript code to continue analysis.`;
}

/**
 * Error feedback for DeepSeek
 */
function getErrorFeedback(error: string): string {
  return `Execution error: ${error}

Please fix the code and provide a corrected version:
\`\`\`javascript
// corrected code
\`\`\``;
}

/**
 * Create the DeepSeek adapter instance
 */
export function createDeepSeekAdapter(): ModelAdapter {
  return {
    name: "deepseek",
    buildSystemPrompt,
    extractCode,
    extractFinalAnswer,
    getNoCodeFeedback,
    getErrorFeedback,
  };
}
