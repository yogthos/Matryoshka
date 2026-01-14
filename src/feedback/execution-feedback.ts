/**
 * Execution Feedback System
 *
 * Detects failure patterns in code execution and provides
 * clear, actionable feedback to guide the model toward
 * using the synthesis tools correctly.
 *
 * Key principle: Guide model to provide CONSTRAINTS to the synthesizer,
 * NOT to write manual parsing code.
 */

export interface ExecutionContext {
  code: string;
  logs: string[];
  error?: string;
  turn: number;
}

export interface FeedbackResult {
  type: FailureType;
  message: string;
  shouldReject: boolean;  // Reject final answer after this failure
}

export type FailureType =
  | "empty_search"
  | "object_object"
  | "execution_error"
  | "synthesis_failed"
  | "gave_up_early"
  | "none";

/**
 * Analyze execution results and generate appropriate feedback
 */
export function analyzeExecution(ctx: ExecutionContext): FeedbackResult | null {
  const { code, logs, error } = ctx;
  const logsText = logs.join("\n");

  // Check for execution error
  if (error) {
    return handleExecutionError(error, code);
  }

  // Check for [object Object] - forgot JSON.stringify
  if (logsText.includes("[object Object]")) {
    return {
      type: "object_object",
      message: `⚠️ OUTPUT SHOWS [object Object]

You logged an object without JSON.stringify(). Fix:
\`\`\`javascript
console.log(JSON.stringify(hits, null, 2));
\`\`\``,
      shouldReject: true,
    };
  }

  // Check for empty search results
  if (/Found:\s*0|\.length.*?0|No.*?found/i.test(logsText) && code.includes("grep(")) {
    return {
      type: "empty_search",
      message: `⚠️ SEARCH RETURNED 0 RESULTS

Try different approaches:
1. Use shorter/simpler search terms
2. Try case-insensitive: grep("term", "i")
3. Search broad first, then filter results
4. Use locate_line(1, 50) to see document structure`,
      shouldReject: true,
    };
  }

  // Check for synthesis failure
  if (logsText.includes("null") && code.includes("synthesize_")) {
    return {
      type: "synthesis_failed",
      message: `⚠️ SYNTHESIS RETURNED NULL

The synthesizer couldn't build a function from your examples. Try:
1. Provide MORE examples (at least 2-3)
2. Make sure inputs are STRINGS from the document
3. Make sure outputs are the CONVERTED values you want
4. Check that input/output pairs are consistent

Example:
\`\`\`javascript
const extractor = synthesize_extractor([
  { input: "value_from_doc_1", output: converted_1 },
  { input: "value_from_doc_2", output: converted_2 },
  { input: "value_from_doc_3", output: converted_3 }
]);
\`\`\``,
      shouldReject: true,
    };
  }

  // Check for giving up too early (just printing "done" or similar)
  if (logs.length === 1 && /^(done|finished|complete|no results)$/i.test(logs[0].trim())) {
    return {
      type: "gave_up_early",
      message: `⚠️ DON'T GIVE UP - TRY DIFFERENT APPROACHES

You haven't computed a result yet. Keep exploring:
1. Try different search terms with grep()
2. Use locate_line() to see document structure
3. Search for single keywords, then filter results`,
      shouldReject: true,
    };
  }

  return null;
}

/**
 * Handle execution errors with synthesis-focused guidance
 */
function handleExecutionError(error: string, code: string): FeedbackResult {
  // TypeError: X is not a function - likely synthesis returned null
  if (error.includes("is not a function") && code.includes("extractor")) {
    return {
      type: "synthesis_failed",
      message: `⚠️ EXTRACTOR IS NULL - SYNTHESIS FAILED

The synthesize_extractor() returned null. Your examples may be:
1. Inconsistent (same input, different outputs)
2. Too few (need at least 2)
3. Wrong format (inputs must be strings)

Check your examples and try again with clearer constraints.`,
      shouldReject: true,
    };
  }

  // TypeError: Cannot read property X of undefined/null
  if (error.includes("Cannot read") || error.includes("of undefined") || error.includes("of null")) {
    return {
      type: "execution_error",
      message: `⚠️ UNDEFINED/NULL ERROR

A variable is undefined or null. Common causes:
1. grep() returned empty array - check hits.length first
2. synthesize_extractor() returned null - check before using
3. Array index out of bounds - check array length

Always check results before using:
\`\`\`javascript
if (hits && hits.length > 0) {
  // safe to use hits[0], etc.
}
\`\`\``,
      shouldReject: true,
    };
  }

  // String method on object
  if (error.includes("match is not a function") || error.includes("split is not a function")) {
    return {
      type: "execution_error",
      message: `⚠️ STRING METHOD ON OBJECT

grep() returns objects with {match, line, lineNum}.
Use hit.line to get the string:
\`\`\`javascript
for (const hit of hits) {
  // hit.line is the string
  console.log(hit.line);
}
\`\`\``,
      shouldReject: true,
    };
  }

  // Generic error
  return {
    type: "execution_error",
    message: `⚠️ EXECUTION ERROR: ${error}

Fix the error and try again. Remember:
- Use synthesize_extractor() to build functions from examples
- Use JSON.stringify() when logging objects
- Check array lengths before accessing elements`,
    shouldReject: true,
  };
}

/**
 * Generate encouragement to keep trying
 */
export function getEncouragement(turn: number, maxTurns: number): string {
  const remaining = maxTurns - turn;
  if (remaining > 5) {
    return `You have ${remaining} turns remaining. Keep exploring the document.`;
  } else if (remaining > 2) {
    return `${remaining} turns left. Focus on getting the answer.`;
  } else {
    return `Only ${remaining} turn(s) left! Provide your best answer.`;
  }
}
