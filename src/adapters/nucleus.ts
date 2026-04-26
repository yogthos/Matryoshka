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

import type { ModelAdapter, RAGHints } from "./types.js";

/**
 * Build the system prompt for Nucleus LC output
 */
function buildSystemPrompt(
  contextLength: number,
  toolInterfaces: string,
  hints?: RAGHints
): string {
  // Determine document size category
  if (!Number.isFinite(contextLength) || contextLength < 0) contextLength = 0;
  const sizeCategory = contextLength < 2000 ? "SMALL" : "LARGE";

  return `One S-expression per turn. Compose multi-step strategies with (seq …) so a single turn can chain commands instead of taking a turn per step.

SEARCH:
(grep "pat")              → matched lines + lineNums
(lines START END)         → line range, 1-indexed

CHUNK (slice big doc for map):
(chunk_by_size N)         → N-char slices
(chunk_by_lines N)        → N-line slices
(chunk_by_regex "pat")    → split on regex
  use w/ (map … (lambda c (llm_query "..." (chunk c))))

TRANSFORM:
(filter RESULTS (lambda x (match x "pat" 0)))
(map RESULTS (lambda x (match x "pat" 1)))
(count RESULTS)   (sum RESULTS)

COMPOSE (multi-step in ONE turn):
(seq expr1 expr2 ... exprN)   → run in order, RESULTS threads through, value = last expr
  Use this aggressively. Prefer
    (seq (grep "X") (filter RESULTS (lambda x …)) (count RESULTS))
  over three separate turns. Each turn costs an LLM round-trip.

SUB-LLM (work grep can't do):
(llm_query "...{items}" (items RESULTS))   → one call over binding
(map RESULTS (lambda x (llm_query "..." (item x))))   → per-item
(filter RESULTS (lambda x (match (llm_query "..." (item x)) "keep" 0)))
Rules:
  prompt literal w/ {name} placeholders
  each (name TERM) fills one placeholder
  use for classify/summarize/paraphrase, not regex
  BATCH heavily — one llm_query over a whole chunk beats one-per-item.
  For per-item work use (rlm_batch …) so calls fire concurrently.

CODE:
(list_symbols)  (list_symbols "function")
(get_symbol_body "name")  (find_references "name")
(callers "name")  (callees "name")
(ancestors "Class")  (descendants "Class")
(implementations "IFace")  (dependents "name")
(symbol_graph "name" depth)
(communities)  (community_of "name")
(god_nodes)  (god_nodes 5)
(surprising_connections)  (bridge_nodes)
(suggest_questions)  (graph_report)

MULTI-LINE: grep keyword → lineNum → (lines N M)
QUERY: count→count, sum/total→sum, list→grep+FINAL
ANSWER: <<<FINAL>>>answer<<<END>>>
  big answer: FINAL_VAR(name) refs binding
    <<<FINAL>>>FINAL_VAR(_2)<<<END>>>
    <<<FINAL>>>matches: FINAL_VAR(RESULTS)<<<END>>>

${hints?.hintsText || ""}${hints?.selfCorrectionText || ""}`;
}

/**
 * Try to convert JSON to S-expression
 * Handles common cases when model outputs JSON instead of S-expressions
 */
/** Validate collection name is a safe S-expression identifier (RESULTS, _N, etc.) */
const DANGEROUS_COLLECTION_NAMES = new Set([
  "__proto__", "constructor", "prototype", "eval", "Function",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);

function validateCollectionName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  // Only allow known safe identifiers: RESULTS, _1, _2, ..., or simple alphanumeric names
  if (!/^(RESULTS|_\d+|[A-Za-z]\w*)$/.test(name)) return null;
  // Block dangerous JS property names
  if (DANGEROUS_COLLECTION_NAMES.has(name)) return null;
  return name;
}

/** Escape a string for embedding in an S-expression string literal */
const MAX_ESCAPE_INPUT_LENGTH = 100_000;

function escapeForSexp(s: string): string {
  if (s.length > MAX_ESCAPE_INPUT_LENGTH) {
    s = s.slice(0, MAX_ESCAPE_INPUT_LENGTH);
  }
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

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
        return `(grep "${escapeForSexp(pattern)}")`;
      }
      break;
    }

    case "filter": {
      const rawCollection = obj.collection || obj.input || "RESULTS";
      const collection = validateCollectionName(rawCollection);
      const pattern = obj.pattern || obj.predicate || obj.match;
      if (collection && typeof pattern === "string") {
        return `(filter ${collection} (lambda x (match x "${escapeForSexp(pattern)}" 0)))`;
      }
      break;
    }

    case "map":
    case "extract": {
      const rawCollection = obj.collection || obj.input || "RESULTS";
      const collection = validateCollectionName(rawCollection);
      const pattern = obj.pattern || obj.regex;
      const group = typeof obj.group === "number" && Number.isInteger(obj.group) && obj.group >= 0 ? Math.min(obj.group, 99) : 0;
      if (collection && typeof pattern === "string") {
        return `(map ${collection} (lambda x (match x "${escapeForSexp(pattern)}" ${group})))`;
      }
      break;
    }

    case "fuzzy":
    case "fuzzy_search": {
      const query = obj.query || obj.term;
      const rawLimit = typeof obj.limit === "number" ? obj.limit : 10;
      const limit = Math.max(1, Math.min(Math.floor(rawLimit), 1000));
      if (typeof query === "string") {
        return `(fuzzy_search "${escapeForSexp(query)}" ${limit})`;
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
const MAX_RESPONSE_PARSE_LENGTH = 1_000_000;

function extractCode(response: string): string | null {
  if (response.length > MAX_RESPONSE_PARSE_LENGTH) {
    response = response.slice(0, MAX_RESPONSE_PARSE_LENGTH);
  }
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
        const MAX_DEPTH = 100;
        let depth = 0;
        let end = -1;
        for (let i = parenAfterTensor; i < response.length; i++) {
          if (response[i] === "(") depth++;
          if (response[i] === ")") depth--;
          if (depth > MAX_DEPTH) break;
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
  const KNOWN_COMMANDS = [
    // Search / retrieval
    "grep", "fuzzy_search", "bm25", "semantic", "fuse", "dampen", "rerank",
    "text_stats", "lines",
    // Collection ops
    "filter", "map", "reduce", "count", "sum",
    // String / numeric ops
    "match", "replace", "split", "parseInt", "parseFloat", "parseDate",
    "parseCurrency", "parseNumber", "coerce",
    // Synthesis / lambda
    "extract", "synthesize", "lambda", "if", "classify", "predicate",
    "define-fn", "apply-fn",
    // Symbol / graph ops
    "list_symbols", "get_symbol_body", "find_references", "callers", "callees",
    "ancestors", "descendants", "implementations", "dependents",
    "symbol_graph", "communities", "community_of", "god_nodes",
    "surprising_connections", "bridge_nodes", "suggest_questions",
    "graph_report",
    // Sub-LLM / recursive
    "llm_query", "llm_batch", "rlm_query", "rlm_batch",
    // Context + introspection
    "context", "show_vars",
    // Chunking
    "chunk_by_size", "chunk_by_lines", "chunk_by_regex",
  ];

  const MAX_SEXP_ITERATIONS = 200;
  let sexpIterations = 0;
  let searchFrom = firstParen;
  while (searchFrom >= 0 && searchFrom < response.length && sexpIterations < MAX_SEXP_ITERATIONS) {
    sexpIterations++;
    const parenIdx = response.indexOf("(", searchFrom);
    if (parenIdx < 0) break;

    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;
    for (let i = parenIdx; i < response.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (response[i] === "\\" && inString) { escaped = true; continue; }
      if (response[i] === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (response[i] === "(") depth++;
      if (response[i] === ")") depth--;
      const MAX_DEPTH = 100;
      if (depth > MAX_DEPTH) break;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end > parenIdx) {
      const expr = response.slice(parenIdx, end);
      // Check the expression starts with a known command
      const exprContent = expr.slice(1).trim(); // remove leading (
      // Match identifier characters only — terms like `(show_vars)`
      // (no args) leave a `)` immediately after the head word, so a
      // greedy `\S+` would capture "show_vars)" and miss the
      // KNOWN_COMMANDS lookup. Constraining to identifier chars
      // stops at the closing paren, the leading whitespace, or any
      // non-identifier character.
      const firstWord = exprContent.match(/^([A-Za-z_][A-Za-z0-9_-]*)/)?.[1];
      if (firstWord && KNOWN_COMMANDS.includes(firstWord)) {
        return expr;
      }
      // Not a valid S-expression command, skip and look for next one
      searchFrom = end;
    } else {
      break;
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

  // Try to find inline JSON object using balanced brace extraction
  const MAX_JSON_EXTRACTION_CHARS = 100_000;
  const extractJson = (text: string): string | null => {
    const start = text.indexOf("{");
    if (start === -1) return null;
    // Limit processing to prevent CPU exhaustion on huge LLM responses
    const maxEnd = Math.min(text.length, start + MAX_JSON_EXTRACTION_CHARS);
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < maxEnd; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      const MAX_DEPTH = 100;
      if (ch === "{") {
        depth++;
        if (depth > MAX_DEPTH) return null;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  };
  const inlineJson = extractJson(response);
  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson);
      const converted = jsonToSexp(parsed);
      if (converted) {
        return converted;
      }
    } catch {
      // Not valid JSON
    }
  }

  // FALLBACK: Auto-wrap common commands without parentheses
  // E.g., "sum RESULTS" -> "(sum RESULTS)"
  const noParenCommand = response.match(/\b(sum|count|grep|filter|map)\s+(RESULTS|_\d+|"[^"]+")/i);
  if (noParenCommand) {
    const cmd = noParenCommand[1].toLowerCase();
    const arg = noParenCommand[2];
    return `(${cmd} ${arg})`;
  }

  return null;
}

/**
 * Extract final answer from response
 */
function extractFinalAnswer(
  response: string | undefined | null
): string | null {
  if (!response) return null;

  // Look for FINAL markers with various bracket styles (<<<, >>>, or mixed)
  // Models often get the brackets wrong
  const finalMatch = response.match(/(?:<<<|>>>)FINAL(?:<<<|>>>)([\s\S]*?)(?:<<<|>>>)END(?:<<<|>>>)/);
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

  return null;
}

/**
 * Feedback when no LC term found
 */
function getNoCodeFeedback(): string {
  return `No command. Extract keyword from query:

(grep "KEYWORD")   ← e.g., "ERROR", "SALES", "stage"

Then by query type:
list/show/what → <<<FINAL>>>item1, item2<<<END>>>
count → (count RESULTS)
total/sum → (sum RESULTS)

Next:`;
}

/**
 * Feedback when LC parsing fails
 */
function getErrorFeedback(error: string, code?: string): string {
  // Check for Python-style lambda (common mistake)
  if (code && code.includes("lambda") && code.includes(":")) {
    return `Wrong syntax. Use: (filter RESULTS (lambda x (match x "word" 0)))`;
  }

  return `Syntax error. Use:
(grep "word")
(filter RESULTS (lambda x (match x "word" 0)))
(sum RESULTS)`;
}

/**
 * Feedback after successful execution
 * @param resultCount - Number of results from execution
 * @param previousCount - Number of results before this operation
 * @param query - The original query for context
 */
function getSuccessFeedback(resultCount?: number, previousCount?: number, query?: string): string {
  const safeQuery = (query || "the query").slice(0, 200);
  if (resultCount === 0 && previousCount && previousCount > 0) {
    return `Filter matched 0. Try different pattern.

Next:`;
  }

  if (resultCount === 0) {
    return `No matches. Try different terms.

Next:`;
  }

  if (resultCount && resultCount > 0) {
    return `Found ${resultCount} matches. Answer "${safeQuery}"?
list/show/what → <<<FINAL>>>item1, item2<<<END>>>
count → (count RESULTS)
total/sum → (sum RESULTS)
too broad → (filter RESULTS (lambda x (match x "term" 0)))

Next:`;
  }

  return `Done. Output answer.

Next:`;
}

/**
 * Feedback when model repeats the same term
 */
function getRepeatedCodeFeedback(resultCount?: number): string {
  if (resultCount === 0) {
    return `Already tried. Try different keyword.

Next:`;
  }

  return `Already done. RESULTS has ${resultCount ?? "your"} data.
Output: (sum RESULTS) or <<<FINAL>>>answer<<<END>>>

Next:`;
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
