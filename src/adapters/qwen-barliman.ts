/**
 * Qwen Barliman Adapter
 *
 * Implements Barliman-style constraint-based program synthesis.
 * The LLM provides CONSTRAINTS (input/output examples), NOT code.
 * A miniKanren-based synthesizer generates programs automatically.
 *
 * IMPORTANT: This adapter is GENERIC - not specific to any domain.
 * It can handle logs, financial data, scientific data, etc.
 */

import type { ModelAdapter, FinalVarMarker, RAGHints } from "./types.js";
import { createQwenAdapter } from "./qwen.js";
import { analyzeError, formatErrorFeedback } from "../feedback/error-analyzer.js";

/**
 * Build system prompt explaining Barliman-style synthesis
 */
function buildSystemPrompt(
  contextLength: number,
  toolInterfaces: string,
  hints?: RAGHints
): string {
  return `You analyze documents. Output ONLY javascript code blocks.

## TOOLS
- grep("term") → [{match, line, lineNum}]
- synthesize_extractor([{input, output}...]) → classifier function

## CRITICAL: TWO-STEP PROCESS

### TURN 1 - SEARCH ONLY (do NOT synthesize yet)
\`\`\`javascript
const hits = grep("keyword");
console.log("Found:", hits.length);
console.log(JSON.stringify(hits.slice(0, 5), null, 2));
\`\`\`
STOP. Wait for output. Do NOT call synthesize_extractor yet.

### TURN 2 - After you SEE the output, copy EXACT lines into classifier
\`\`\`javascript
// Copy the EXACT "line" values you saw in Turn 1 output
const classifier = synthesize_extractor([
  { input: "COPY EXACT LINE FROM TURN 1 OUTPUT HERE", output: true },
  { input: "COPY ANOTHER EXACT LINE HERE", output: false }
]);
const results = [];
for (const hit of hits) {
  if (classifier(hit.line) === true) results.push(hit.line);
}
console.log("Results:", results.length);
console.log(JSON.stringify(results, null, 2));
console.log("done");
\`\`\`
<<<FINAL>>>
Found N items: [list them]
<<<END>>>

## RULES
1. Turn 1: ONLY grep, do NOT synthesize
2. Turn 2: Copy EXACT line strings you saw in output
3. Use JSON.stringify() for objects
4. Search single words, not phrases
${hints?.hintsText || ""}${hints?.selfCorrectionText || ""}
## BEGIN`;
}

/**
 * Error feedback emphasizing constraint refinement
 */
function getErrorFeedback(error: string, code?: string): string {
  const analysis = analyzeError(error, code);
  const feedback = formatErrorFeedback(analysis);

  // Check for floating object literal error
  if (error.includes("Unexpected token ':'") && code) {
    const hasFloatingObjects = /^\s*\{\s*input:/m.test(code);
    if (hasFloatingObjects) {
      return `**SYNTAX ERROR: Floating object literals**

Put objects inside an array:
\`\`\`javascript
const extractor = synthesize_extractor([
  { input: "a", output: 1 },
  { input: "b", output: 2 }
]);
\`\`\``;
    }
  }

  let codeExample = "";

  switch (analysis.errorType) {
    case "invalid_regex_flags":
      codeExample = `
**FIX: grep() takes ONE argument**
\`\`\`javascript
const hits = grep("pattern1|pattern2");
\`\`\``;
      break;

    case "undefined_variable":
      codeExample = `
**FIX: Define variables in the same code block**
\`\`\`javascript
const hits = grep("pattern");
// Use hits in the SAME block
\`\`\``;
      break;

    case "string_method_on_object":
      codeExample = `
**FIX: grep() returns objects, use .line for string**
\`\`\`javascript
for (const hit of hits) {
  const text = hit.line;
}
\`\`\``;
      break;

    default:
      codeExample = `
**Try:**
\`\`\`javascript
const hits = grep("keyword");
console.log(JSON.stringify(hits.slice(0, 5), null, 2));
\`\`\``;
  }

  return `${feedback}
${codeExample}

Provide \`\`\`javascript with the fix:`;
}

/**
 * No code feedback
 */
function getNoCodeFeedback(): string {
  return `ERROR: No JavaScript code detected.

You MUST output \`\`\`javascript code blocks ONLY.

\`\`\`javascript
const hits = grep("keyword");
console.log(JSON.stringify(hits.slice(0, 5), null, 2));
\`\`\``;
}

/**
 * Success feedback
 */
function getSuccessFeedback(): string {
  return `Good. Now build classifier with synthesize_extractor() using EXACT lines you saw above, then report with <<<FINAL>>>answer<<<END>>>`;
}

/**
 * Repeated code feedback
 */
function getRepeatedCodeFeedback(): string {
  return `ERROR: Repeated code. Try different keyword.

\`\`\`javascript
const hits = grep("different_keyword");
console.log(JSON.stringify(hits.slice(0, 5), null, 2));
\`\`\``;
}

/**
 * Create the Qwen Barliman adapter
 */
export function createQwenBarlimanAdapter(): ModelAdapter {
  const base = createQwenAdapter();

  return {
    ...base,
    name: "qwen-barliman",
    buildSystemPrompt,
    getErrorFeedback,
    getNoCodeFeedback,
    getSuccessFeedback,
    getRepeatedCodeFeedback,
  };
}
