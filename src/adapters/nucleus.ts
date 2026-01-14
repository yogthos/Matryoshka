/**
 * Nucleus Adapter
 *
 * Prompts the LLM to output Lambda Calculus terms instead of JavaScript.
 * This reduces token entropy and allows formal verification before execution.
 *
 * The LLM outputs S-expressions that map to the evalo DSL:
 * - (grep "pattern") - search document
 * - (classify "line1" true "line2" false) - build classifier
 * - (match input "pattern" 0) - regex match
 * - (parseInt (match input "\\d+" 0)) - parse number
 */

import type { ModelAdapter, FinalVarMarker, RAGHints } from "./types.js";

/**
 * Build the system prompt for Nucleus LC output
 */
function buildSystemPrompt(
  contextLength: number,
  toolInterfaces: string,
  hints?: RAGHints
): string {
  return `You analyze documents using S-expressions. Output ONLY S-expressions or FINAL answers.

## OUTPUT FORMAT

Output EXACTLY ONE of:
1. S-expression: (grep "keyword") or (filter RESULTS ...)
2. Final answer: <<<FINAL>>> ... <<<END>>>

## SEARCH STRATEGY

IMPORTANT: Search for KEYWORDS from the query, not special characters.
- For "total sales": (grep "SALES") or (grep "sales")
- For "payment errors": (grep "payment") or (grep "error")
- For "temperature readings": (grep "TEMP") or (grep "temperature")

DO NOT search for symbols like "$" or "%" - search for text labels instead.

## OPERATIONS

Search:       (grep "keyword")
Filter:       (filter RESULTS (lambda x (match x "pattern" 0)))
Extract:      (map RESULTS (lambda x (match x "regex" 1)))
Sum numbers:  (sum (map RESULTS (lambda x (parseFloat (match x "[0-9,]+" 0)))))
Count:        (count RESULTS)

## WORKFLOW

1. SEARCH: Find relevant lines with (grep "keyword")
2. FILTER (if needed): Narrow down with (filter RESULTS ...)
3. EXTRACT (if needed): Pull out values with (map RESULTS ...)
4. AGGREGATE (if needed): Sum or count with (sum ...) or (count ...)
5. REPORT: Output final answer with <<<FINAL>>> ... <<<END>>>

## EXAMPLE: Finding totals

Query: "what is the total of all sales values?"

Turn 1: (grep "SALES")
Turn 2: (map RESULTS (lambda x (match x "[0-9,]+" 0)))
Turn 3: (sum RESULTS)
Turn 4: <<<FINAL>>>
The total sales is: [value from RESULTS]
<<<END>>>

${hints?.hintsText || ""}${hints?.selfCorrectionText || ""}
## BEGIN:`;
}

/**
 * Try to convert JSON to S-expression
 * Handles common cases when model outputs JSON instead of S-expressions
 */
function jsonToSexp(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;

  const obj = json as Record<string, unknown>;

  // Handle {"action": "grep", "pattern": "..."} or {"operation": "grep", ...}
  const action = obj.action || obj.operation || obj.type;
  if (typeof action !== "string") return null;

  switch (action.toLowerCase()) {
    case "grep":
    case "search": {
      const pattern = obj.pattern || obj.query || obj.term;
      if (typeof pattern === "string") {
        return `(grep "${pattern.replace(/"/g, '\\"')}")`;
      }
      break;
    }

    case "filter": {
      const collection = obj.collection || obj.input || "RESULTS";
      const pattern = obj.pattern || obj.predicate || obj.match;
      if (typeof pattern === "string") {
        const escaped = pattern.replace(/"/g, '\\"');
        return `(filter ${collection} (lambda x (match x "${escaped}" 0)))`;
      }
      break;
    }

    case "map":
    case "extract": {
      const collection = obj.collection || obj.input || "RESULTS";
      const pattern = obj.pattern || obj.regex;
      const group = typeof obj.group === "number" ? obj.group : 0;
      if (typeof pattern === "string") {
        const escaped = pattern.replace(/"/g, '\\"');
        return `(map ${collection} (lambda x (match x "${escaped}" ${group})))`;
      }
      break;
    }

    case "fuzzy":
    case "fuzzy_search": {
      const query = obj.query || obj.term;
      const limit = typeof obj.limit === "number" ? obj.limit : 10;
      if (typeof query === "string") {
        return `(fuzzy_search "${query.replace(/"/g, '\\"')}" ${limit})`;
      }
      break;
    }
  }

  return null;
}

/**
 * Extract LC term from model response
 * Looks for S-expressions starting with ( or constrained terms starting with [
 * Falls back to JSON conversion if no S-expression found
 */
function extractCode(response: string): string | null {
  // Also check for code blocks first (multi-line S-expressions)
  const codeBlockMatch = response.match(/```(?:lisp|scheme|sexp)?\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const code = codeBlockMatch[1].trim();
    if (code.startsWith("(") || code.startsWith("[")) {
      return code;
    }
  }

  // Check for constrained term [Constraint] ⊗ (...) BEFORE checking plain parens
  // This ensures we get the full constrained expression
  const firstBracket = response.indexOf("[");
  const firstParen = response.indexOf("(");

  // If bracket comes before paren (or no paren), check for constrained term
  if (firstBracket >= 0 && (firstParen < 0 || firstBracket < firstParen)) {
    // Look for the pattern [Constraint] ⊗ followed by S-expression
    const tensorIdx = response.indexOf("⊗", firstBracket);
    if (tensorIdx > firstBracket) {
      // Find the S-expression after the tensor
      const parenAfterTensor = response.indexOf("(", tensorIdx);
      if (parenAfterTensor > tensorIdx) {
        // Balance parens to find the end
        let depth = 0;
        let end = -1;
        for (let i = parenAfterTensor; i < response.length; i++) {
          if (response[i] === "(") depth++;
          if (response[i] === ")") depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
        if (end > parenAfterTensor) {
          return response.slice(firstBracket, end);
        }
      }
    }
  }

  // Check for plain S-expression in raw text
  // Find opening paren and balance to closing
  if (firstParen >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = firstParen; i < response.length; i++) {
      if (response[i] === "(") depth++;
      if (response[i] === ")") depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end > firstParen) {
      return response.slice(firstParen, end);
    }
  }

  // FALLBACK: Try to extract and convert JSON to S-expression
  // This handles when model outputs JSON despite being told not to
  const jsonCodeBlock = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonCodeBlock) {
    try {
      const parsed = JSON.parse(jsonCodeBlock[1].trim());
      const converted = jsonToSexp(parsed);
      if (converted) {
        return converted;
      }
    } catch {
      // Not valid JSON
    }
  }

  // Try to find inline JSON object
  const inlineJson = response.match(/\{[^}]+\}/);
  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson[0]);
      const converted = jsonToSexp(parsed);
      if (converted) {
        return converted;
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

/**
 * Extract final answer from response
 */
function extractFinalAnswer(
  response: string | undefined | null
): string | FinalVarMarker | null {
  if (!response) return null;

  // Look for <<<FINAL>>> ... <<<END>>> markers (standard format)
  const finalMatch = response.match(/<<<FINAL>>>([\s\S]*?)<<<END>>>/);
  if (finalMatch) {
    return finalMatch[1].trim();
  }

  // Look for <<<FINAL>>> inside code block without <<<END>>> (common model error)
  // Match: ```anything\n<<<FINAL>>>\ncontent\n```
  const codeBlockFinal = response.match(/```[^\n]*\n<<<FINAL>>>\n([\s\S]*?)```/);
  if (codeBlockFinal) {
    return codeBlockFinal[1].trim();
  }

  // Look for <<<FINAL>>> at end of response without <<<END>>> (model forgot to close)
  const openFinal = response.match(/<<<FINAL>>>\n([\s\S]+?)(?:$|```)/);
  if (openFinal) {
    const content = openFinal[1].trim();
    // Make sure it's not just code
    if (!content.match(/^\s*\(/)) {
      return content;
    }
  }

  // Also check for FINAL_VAR pattern
  const varMatch = response.match(/FINAL_VAR\((\w+)\)/);
  if (varMatch) {
    return { type: "var", name: varMatch[1] };
  }

  return null;
}

/**
 * Feedback when no LC term found
 */
function getNoCodeFeedback(): string {
  return `ERROR: Invalid output. You MUST output exactly one of:

OPTION 1 - Search:
(grep "keyword")

OPTION 2 - Filter previous results:
(filter RESULTS (lambda x (match x "pattern" 0)))

OPTION 3 - Report final answer:
<<<FINAL>>>
The answer based on my analysis: [your answer]
<<<END>>>

Output ONLY the option text. No explanations. No JSON.`;
}

/**
 * Feedback when LC parsing fails
 */
function getErrorFeedback(error: string, code?: string): string {
  // Check for common error patterns
  if (code && !code.match(/^\s*\(/)) {
    return `ERROR: "${code}" is not a valid S-expression.

Valid S-expressions start with ( and a command:
- (grep "pattern")
- (filter RESULTS (lambda x (match x "pattern" 0)))
- (map RESULTS (lambda x (match x "regex" 1)))

Or report your answer:
<<<FINAL>>>
Your answer here
<<<END>>>`;
  }

  return `ERROR: Parse failed: ${error}

Valid commands:
- (grep "pattern")
- (filter RESULTS (lambda x (match x "pattern" 0)))
- (map RESULTS (lambda x (match x "regex" 1)))

Or:
<<<FINAL>>>
Your answer here
<<<END>>>`;
}

/**
 * Feedback after successful execution
 * @param resultCount - Number of results from execution
 * @param previousCount - Number of results before this operation
 */
function getSuccessFeedback(resultCount?: number, previousCount?: number): string {
  // If filtering reduced to 0, the filter was probably wrong
  if (resultCount === 0 && previousCount && previousCount > 0) {
    return `WARNING: Filter removed all results!

Your filter pattern didn't match any items. RESULTS is now empty.
Go back to _1 (original search) and try:
- Different filter pattern that matches the query
- Or (map _1 (lambda x ...)) to extract values
- Or report what you found in _1

Example: (filter _1 (lambda x (match x "SALES_DATA" 0)))`;
  }

  // If empty results, encourage trying different search terms
  if (resultCount === 0) {
    return `RESULTS is empty. Try a DIFFERENT search:

- Use keyword from the query: (grep "sales") or (grep "SALES_DATA")
- Use simpler patterns
- Check spelling

DO NOT give up or search for unrelated terms.`;
  }

  // Good results - guide next steps
  if (resultCount && resultCount > 0) {
    return `Good. ${resultCount} items in RESULTS.

Next step options:
1. If RESULTS answers the query -> report with <<<FINAL>>> ... <<<END>>>
2. If need to extract values -> (map RESULTS (lambda x (match x "pattern" 1)))
3. If need to sum numbers -> (sum (map RESULTS ...))
4. If too many irrelevant -> (filter RESULTS (lambda x (match x "keyword" 0)))

Focus on the original query. Don't search for unrelated terms.`;
  }

  return `Result bound to RESULTS. Analyze and report your answer.`;
}

/**
 * Feedback when model repeats the same term
 */
function getRepeatedCodeFeedback(resultCount?: number): string {
  if (resultCount === 0) {
    return `ERROR: Repeated term and RESULTS is empty.

Try a DIFFERENT search pattern:
- Use single keywords: (grep "payment") or (grep "error")
- Use shorter patterns: "fail" instead of "failure message"
- Try related terms: "timeout", "refused", "exception"

DO NOT repeat the same search. Try something new.`;
  }

  return `ERROR: Repeated term. You already have RESULTS from the previous turn.

If RESULTS contains what you need, REPORT YOUR ANSWER NOW:
<<<FINAL>>>
Based on my analysis, the answer is: [your answer based on RESULTS]
<<<END>>>

Only run more code if you need to further refine RESULTS.`;
}

/**
 * Create the Nucleus adapter
 */
export function createNucleusAdapter(): ModelAdapter {
  return {
    name: "nucleus",
    buildSystemPrompt,
    extractCode,
    extractFinalAnswer,
    getNoCodeFeedback,
    getErrorFeedback,
    getSuccessFeedback,
    getRepeatedCodeFeedback,
  };
}
