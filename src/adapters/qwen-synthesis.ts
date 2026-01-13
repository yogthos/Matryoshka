/**
 * Qwen Synthesis Adapter
 *
 * Extends the Qwen adapter with synthesis tool guidance.
 * Encourages the model to use automatic synthesis instead of
 * writing regex patterns manually.
 */

import type { ModelAdapter, FinalVarMarker } from "./types.js";
import { createQwenAdapter } from "./qwen.js";

/**
 * Build system prompt with synthesis instructions
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

## SYNTHESIS TOOLS - USE THESE INSTEAD OF WRITING REGEX MANUALLY!

You have access to **automatic synthesis** tools. These generate CORRECT patterns from examples.
**DO NOT write regex patterns manually!** Use the synthesizer - it's more accurate and reliable.

### synthesize_regex(positive, negative?)
Generates a regex pattern from example strings.
- \`positive\`: Array of strings that SHOULD match
- \`negative\`: (optional) Array of strings that should NOT match
- Returns: regex pattern string or null

### synthesize_extractor(examples)
Generates an extractor function from input/output pairs.
- \`examples\`: Array of \`{ input: string, output: value }\` pairs
- Returns: extractor function or null

### test_regex(pattern, str)
Tests a regex pattern against a string.
- Returns: true if matches

### extract_with_regex(pattern, str)
Extracts value using regex pattern (first capture group or full match).
- Returns: extracted string or null

## PROBLEM-SOLVING APPROACH (Step-by-Step)

**Step 1 - SEARCH first using grep():**
\`\`\`javascript
// Search for keywords related to what you need
const hits = grep("sales|revenue|total");
console.log(JSON.stringify(hits.slice(0, 5), null, 2));
\`\`\`

**Step 2 - SYNTHESIZE patterns from examples (DO NOT write regex manually!):**
\`\`\`javascript
// Collect example values from the hits
const examples = hits.map(h => h.line).filter(l => l.includes("$")).slice(0, 5);
console.log("Examples:", examples);

// Ask the synthesizer to create a regex - much better than writing your own!
const regex = synthesize_regex(examples, ["Total:", "HEADER"]);
console.log("Synthesized regex:", regex);
\`\`\`

**Step 3 - USE synthesized patterns to extract data:**
\`\`\`javascript
let total = 0;
for (const hit of hits) {
  // Use extract_with_regex instead of manual .match()
  const value = extract_with_regex(regex, hit.line);
  if (value) {
    const num = parseFloat(value.replace(/[$,]/g, ''));
    total += num;
    console.log(hit.line, "->", num);
  }
}
console.log("Total:", total);
\`\`\`

### Alternative: synthesize_extractor for direct conversion
\`\`\`javascript
// If you know input->output pairs, synthesize an extractor directly
const extractor = synthesize_extractor([
  { input: "$1,000", output: 1000 },
  { input: "$2,500", output: 2500 }
]);

// Then use it
const value = extractor("$5,000");  // Returns 5000
console.log(value);
\`\`\`

## FINAL ANSWER
When you have the answer:
\`\`\`javascript
console.log("done");
\`\`\`
<<<FINAL>>>
Your answer here.
<<<END>>>

## CRITICAL RULES
- Output ONLY JavaScript code blocks (not Python, not JSON).
- **DO NOT write regex patterns manually!** Use synthesize_regex() or synthesize_extractor().
- ALWAYS use grep() first to find relevant data.
- grep() returns objects: use hit.line to get the text string.
- Use JSON.stringify() when logging objects/arrays.
- Each turn: run NEW code based on previous output. NEVER repeat the same code.
- Parse numbers: remove $ and commas before parseFloat().

## BEGIN
Search for data related to the query. Use grep() first, then synthesize patterns.
`;
}

/**
 * Error feedback with synthesis suggestions
 */
function getErrorFeedback(error: string): string {
  // Check for regex-related errors
  if (
    error.includes("Invalid regular expression") ||
    error.includes("SyntaxError") && error.toLowerCase().includes("regex")
  ) {
    return `Code error: ${error}

**REGEX ERROR!** Do not write regex manually. Use synthesize_regex() instead:

\`\`\`javascript
// Collect example strings that match what you need
const examples = hits.slice(0, 5).map(h => h.line);

// Let the synthesizer create a correct regex
const regex = synthesize_regex(examples);
console.log("Synthesized:", regex);

// Then use it with extract_with_regex
const value = extract_with_regex(regex, hit.line);
\`\`\``;
  }

  // Check for .match() on grep result errors
  if (
    error.includes("is not a function") &&
    (error.includes("match") || error.includes("split") || error.includes("replace"))
  ) {
    return `Code error: ${error}

**IMPORTANT:** grep() returns objects with { match, line, lineNum }.
Use hit.line to get the string, or better yet, use extract_with_regex():

\`\`\`javascript
for (const hit of hits) {
  // Option 1: Use hit.line with extract_with_regex
  const value = extract_with_regex(regex, hit.line);

  // Option 2: Use hit.line directly
  const numMatch = hit.line.match(/pattern/);

  if (value) {
    console.log(value);
  }
}
\`\`\``;
  }

  // Generic error
  return `Code error: ${error}

Fix the bug and output ONLY a JavaScript code block.
Consider using synthesize_regex() or synthesize_extractor() for pattern matching:

\`\`\`javascript
// your fixed code here
\`\`\``;
}

/**
 * No code feedback with synthesis reminder
 */
function getNoCodeFeedback(): string {
  return `ERROR: No code block found or wrong language.

You MUST output JAVASCRIPT code (not Python).
Remember: use synthesize_regex() for patterns, not manual regex!

\`\`\`javascript
// Step 1: Search for data
const hits = grep("keyword");
console.log(JSON.stringify(hits.slice(0, 3), null, 2));
\`\`\`

Or if you have examples:

\`\`\`javascript
// Synthesize a pattern from examples
const regex = synthesize_regex(["$100", "$200", "$300"]);
console.log(regex);
\`\`\``;
}

/**
 * Create the Qwen Synthesis adapter
 */
export function createQwenSynthesisAdapter(): ModelAdapter {
  const base = createQwenAdapter();

  return {
    ...base,
    name: "qwen-synthesis",
    buildSystemPrompt,
    getErrorFeedback,
    getNoCodeFeedback,
  };
}
