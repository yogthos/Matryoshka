/**
 * Lambda Calculus Parser for Nucleus
 *
 * Parses S-expression syntax into LCTerm AST.
 * The grammar is designed to map directly to the evalo DSL.
 *
 * Grammar:
 *   Term ::= Atom | List | Constrained
 *   Atom ::= Symbol | Number | String | Boolean
 *   List ::= ( Term* )
 *   Constrained ::= [ Constraint ] ⊗ Term
 */

import type {
  LCTerm,
  LCInput,
  LCLit,
  LCGrep,
  LCFuzzySearch,
  LCTextStats,
  LCFilter,
  LCMap,
  LCReduce,
  LCSum,
  LCCount,
  LCMatch,
  LCReplace,
  LCSplit,
  LCParseInt,
  LCParseFloat,
  LCAdd,
  LCIf,
  LCClassify,
  LCConstrained,
  LCVar,
  ParseResult,
  ConstraintOp,
} from "./types.js";

/**
 * Token types for lexing
 */
type Token =
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "lbracket" }
  | { type: "rbracket" }
  | { type: "lbrace" }  // {
  | { type: "rbrace" }  // }
  | { type: "tensor" } // ⊗
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "symbol"; value: string }
  | { type: "keyword"; value: string }  // :examples, :type, etc.
  | { type: "boolean"; value: boolean };

/**
 * Lexer: convert input string to tokens
 */
function tokenize(input: string): Token[] {
  const MAX_TOKENS = 100_000;
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length && tokens.length < MAX_TOKENS) {
    const ch = input[i];

    // Skip whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Parentheses
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }

    // Brackets for constraints and example lists
    if (ch === "[") {
      tokens.push({ type: "lbracket" });
      i++;
      continue;
    }
    if (ch === "]") {
      tokens.push({ type: "rbracket" });
      i++;
      continue;
    }

    // Braces for constraint objects
    if (ch === "{") {
      tokens.push({ type: "lbrace" });
      i++;
      continue;
    }
    if (ch === "}") {
      tokens.push({ type: "rbrace" });
      i++;
      continue;
    }

    // Keyword (starts with :)
    if (ch === ":") {
      i++;
      const MAX_KW_LENGTH = 200;
      let kw = "";
      while (i < input.length && /[a-zA-Z_0-9]/.test(input[i]) && kw.length < MAX_KW_LENGTH) {
        kw += input[i];
        i++;
      }
      if (kw.length > 0) {
        tokens.push({ type: "keyword", value: kw });
      }
      // Skip lone ':' — no token produced
      continue;
    }

    // Tensor product operator
    if (ch === "⊗") {
      tokens.push({ type: "tensor" });
      i++;
      continue;
    }

    // String literal
    if (ch === '"') {
      i++;
      const MAX_STRING_LENGTH = 100_000;
      let str = "";
      while (i < input.length && input[i] !== '"' && str.length < MAX_STRING_LENGTH) {
        if (input[i] === "\\") {
          i++;
          if (i < input.length) {
            const escaped = input[i];
            switch (escaped) {
              case "n":
                str += "\n";
                break;
              case "t":
                str += "\t";
                break;
              case "r":
                str += "\r";
                break;
              case "\\":
                str += "\\";
                break;
              case '"':
                str += '"';
                break;
              default:
                // Preserve backslash for regex escape sequences like \$, \d, \w, etc.
                str += "\\" + escaped;
            }
            i++;
          }
        } else {
          str += input[i];
          i++;
        }
      }
      if (i >= input.length) {
        // Unterminated string - throw to produce a clear error message
        throw new Error("Unterminated string literal");
      }
      i++; // skip closing quote
      tokens.push({ type: "string", value: str });
      continue;
    }

    // Number (including negative)
    if (/[\d\-]/.test(ch) && (ch !== "-" || /\d/.test(input[i + 1] || ""))) {
      let num = "";
      if (ch === "-") {
        num = "-";
        i++;
      }
      let hasDecimal = false;
      const MAX_NUM_LENGTH = 50;
      while (i < input.length && /[\d.]/.test(input[i]) && num.length < MAX_NUM_LENGTH) {
        if (input[i] === ".") {
          if (hasDecimal) break; // Stop at second decimal point
          hasDecimal = true;
        }
        num += input[i];
        i++;
      }
      const parsed = parseFloat(num);
      if (isNaN(parsed) || !isFinite(parsed)) {
        // Malformed number (e.g. bare "-") or Infinity, skip
        continue;
      }
      tokens.push({ type: "number", value: parsed });
      continue;
    }

    // Symbol (including special characters for constraints and hyphen for compound names)
    if (/[a-zA-Z_Σμε⚡φ∞\/]/.test(ch)) {
      let sym = "";
      const MAX_SYM_LENGTH = 200;
      while (i < input.length && /[a-zA-Z_0-9Σμε⚡φ∞\/\-]/.test(input[i]) && sym.length < MAX_SYM_LENGTH) {
        sym += input[i];
        i++;
      }
      // Check for boolean
      if (sym === "true") {
        tokens.push({ type: "boolean", value: true });
      } else if (sym === "false") {
        tokens.push({ type: "boolean", value: false });
      } else {
        tokens.push({ type: "symbol", value: sym });
      }
      continue;
    }

    // Skip unknown characters
    i++;
  }

  return tokens;
}

/**
 * Parser state
 */
interface ParserState {
  tokens: Token[];
  pos: number;
}

/**
 * Get current token
 */
function peek(state: ParserState): Token | undefined {
  return state.tokens[state.pos];
}

/**
 * Consume current token and advance
 */
function consume(state: ParserState): Token | undefined {
  return state.tokens[state.pos++];
}

/**
 * Parse examples list: [("input" output) ...] or (("input" output) ...)
 */
function parseExamples(state: ParserState): Array<{ input: string; output: unknown }> | null {
  const start = peek(state);
  if (!start || (start.type !== "lbracket" && start.type !== "lparen")) {
    return null;
  }

  const isParenList = start.type === "lparen";
  consume(state); // [ or (

  const MAX_EXAMPLES = 1000;
  const examples: Array<{ input: string; output: unknown }> = [];

  while (peek(state) && examples.length < MAX_EXAMPLES) {
    const next = peek(state);

    // End of list
    if (next?.type === "rbracket" || next?.type === "rparen") {
      consume(state);
      break;
    }

    // Expect (input output) pair
    if (next?.type === "lparen") {
      consume(state); // (
      const input = parseTerm(state);
      if (!input || input.tag !== "lit" || typeof input.value !== "string") {
        return null;
      }
      const output = parseTerm(state);
      if (!output || output.tag !== "lit") {
        return null;
      }
      const closeParen = consume(state);
      if (!closeParen || closeParen.type !== "rparen") {
        return null;
      }
      examples.push({ input: input.value, output: output.value });
    } else {
      break;
    }
  }

  return examples.length > 0 ? examples : null;
}

/**
 * Parse constraint object: {:min 0 :max 100}
 */
function parseConstraintObject(state: ParserState): Record<string, unknown> | null {
  const start = peek(state);
  if (!start || start.type !== "lbrace") {
    return null;
  }

  consume(state); // {

  const constraints: Record<string, unknown> = Object.create(null);
  const MAX_CONSTRAINT_ENTRIES = 100;

  while (peek(state)) {
    const next = peek(state);

    // End of object
    if (next?.type === "rbrace") {
      consume(state);
      break;
    }

    if (Object.keys(constraints).length >= MAX_CONSTRAINT_ENTRIES) break;

    // Expect :key value pairs
    const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);
    if (next?.type === "keyword") {
      consume(state);
      const key = next.value;
      if (DANGEROUS_KEYS.has(key)) continue;
      const value = parseTerm(state);
      if (value && value.tag === "lit") {
        constraints[key] = value.value;
      }
    } else {
      break;
    }
  }

  return Object.keys(constraints).length > 0 ? constraints : null;
}

/**
 * Check for and parse :examples keyword
 */
function parseExamplesKeyword(state: ParserState): Array<{ input: string; output: unknown }> | undefined {
  const next = peek(state);
  if (next?.type === "keyword" && next.value === "examples") {
    consume(state); // :examples
    const examples = parseExamples(state);
    return examples ?? undefined;
  }
  return undefined;
}

/**
 * Parse a single term
 */
const MAX_PARSE_DEPTH = 200;

function parseTerm(state: ParserState, depth: number = 0): LCTerm | null {
  if (depth > MAX_PARSE_DEPTH) return null;
  const token = peek(state);
  if (!token) return null;

  // Constrained term: [Constraint] ⊗ Term
  if (token.type === "lbracket") {
    consume(state); // [
    const constraintToken = consume(state);
    if (!constraintToken || constraintToken.type !== "symbol") {
      return null;
    }
    const constraint = constraintToken.value as ConstraintOp;
    const rbracket = consume(state);
    if (!rbracket || rbracket.type !== "rbracket") {
      return null;
    }
    const tensor = consume(state);
    if (!tensor || tensor.type !== "tensor") {
      return null;
    }
    const term = parseTerm(state);
    if (!term) return null;
    return { tag: "constrained", constraint, term };
  }

  // List: (op args...)
  if (token.type === "lparen") {
    consume(state); // (
    const list = parseList(state);
    const rparen = consume(state);
    if (!rparen || rparen.type !== "rparen") {
      return null;
    }
    return list;
  }

  // Atom
  if (token.type === "string") {
    consume(state);
    return { tag: "lit", value: token.value };
  }
  if (token.type === "number") {
    consume(state);
    return { tag: "lit", value: token.value };
  }
  if (token.type === "boolean") {
    consume(state);
    return { tag: "lit", value: token.value };
  }
  if (token.type === "symbol") {
    consume(state);
    // Special symbols
    if (token.value === "input") {
      return { tag: "input" };
    }
    return { tag: "var", name: token.value };
  }

  return null;
}

/**
 * Parse list contents after opening paren
 */
function parseList(state: ParserState): LCTerm | null {
  const first = peek(state);
  if (!first) return null;

  // Get the operator
  if (first.type !== "symbol") {
    return null;
  }
  consume(state);
  const op = first.value;

  switch (op) {
    case "input":
      return { tag: "input" };

    case "lit": {
      const val = parseTerm(state);
      if (!val || val.tag !== "lit") return null;
      return val;
    }

    case "grep": {
      const pattern = parseTerm(state);
      if (!pattern || pattern.tag !== "lit" || typeof pattern.value !== "string")
        return null;
      return { tag: "grep", pattern: pattern.value };
    }

    case "fuzzy_search": {
      const query = parseTerm(state);
      if (!query || query.tag !== "lit" || typeof query.value !== "string")
        return null;
      // Optional limit
      const limitTerm = peek(state);
      let limit: number | undefined;
      if (limitTerm && limitTerm.type === "number") {
        consume(state);
        limit = limitTerm.value;
      }
      return { tag: "fuzzy_search", query: query.value, limit };
    }

    case "bm25": {
      const query = parseTerm(state);
      if (!query || query.tag !== "lit" || typeof query.value !== "string")
        return null;
      // Optional limit
      const limitTerm = peek(state);
      let limit: number | undefined;
      if (limitTerm && limitTerm.type === "number") {
        consume(state);
        limit = limitTerm.value;
      }
      return { tag: "bm25", query: query.value, limit };
    }

    case "fuse": {
      // (fuse <coll1> <coll2> [<coll3> ...]) — requires at least 2
      const MAX_FUSE_ARGS = 10;
      const collections: LCTerm[] = [];
      while (peek(state) && peek(state)?.type !== "rparen" && collections.length < MAX_FUSE_ARGS) {
        const coll = parseTerm(state);
        if (!coll) break;
        collections.push(coll);
      }
      if (collections.length < 2) return null;
      return { tag: "fuse", collections };
    }

    case "text_stats": {
      return { tag: "text_stats" };
    }

    case "lines": {
      const startTerm = parseTerm(state);
      if (!startTerm || startTerm.tag !== "lit" || typeof startTerm.value !== "number") {
        return null;
      }
      const endTerm = parseTerm(state);
      if (!endTerm || endTerm.tag !== "lit" || typeof endTerm.value !== "number") {
        return null;
      }
      return { tag: "lines", start: startTerm.value, end: endTerm.value };
    }

    case "filter": {
      const collection = parseTerm(state);
      if (!collection) return null;
      const predicate = parseTerm(state);
      if (!predicate) return null;
      return { tag: "filter", collection, predicate };
    }

    case "map": {
      const collection = parseTerm(state);
      if (!collection) return null;
      const transform = parseTerm(state);
      if (!transform) return null;
      return { tag: "map", collection, transform };
    }

    case "reduce": {
      const collection = parseTerm(state);
      if (!collection) return null;
      const init = parseTerm(state);
      if (!init) return null;
      const fn = parseTerm(state);
      if (!fn) return null;
      return { tag: "reduce", collection, init, fn };
    }

    case "sum": {
      const collection = parseTerm(state);
      if (!collection) return null;
      return { tag: "sum", collection };
    }

    case "count": {
      const collection = parseTerm(state);
      if (!collection) return null;
      return { tag: "count", collection };
    }

    case "add": {
      const left = parseTerm(state);
      if (!left) return null;
      const right = parseTerm(state);
      if (!right) return null;
      return { tag: "add", left, right };
    }

    case "match": {
      const str = parseTerm(state);
      if (!str) return null;
      const pattern = parseTerm(state);
      if (!pattern || pattern.tag !== "lit" || typeof pattern.value !== "string")
        return null;
      const group = parseTerm(state);
      if (!group || group.tag !== "lit" || typeof group.value !== "number")
        return null;
      if (!Number.isSafeInteger(group.value) || group.value < 0 || group.value > 99) return null;
      return { tag: "match", str, pattern: pattern.value, group: group.value };
    }

    case "replace": {
      const str = parseTerm(state);
      if (!str) return null;
      const from = parseTerm(state);
      if (!from || from.tag !== "lit" || typeof from.value !== "string")
        return null;
      const to = parseTerm(state);
      if (!to || to.tag !== "lit" || typeof to.value !== "string") return null;
      return { tag: "replace", str, from: from.value, to: to.value };
    }

    case "split": {
      const str = parseTerm(state);
      if (!str) return null;
      const delim = parseTerm(state);
      if (!delim || delim.tag !== "lit" || typeof delim.value !== "string")
        return null;
      const index = parseTerm(state);
      if (!index || index.tag !== "lit" || typeof index.value !== "number" || !Number.isSafeInteger(index.value))
        return null;
      return { tag: "split", str, delim: delim.value, index: index.value };
    }

    case "parseInt": {
      const str = parseTerm(state);
      if (!str) return null;
      return { tag: "parseInt", str };
    }

    case "parseFloat": {
      const str = parseTerm(state);
      if (!str) return null;
      return { tag: "parseFloat", str };
    }

    case "parseDate": {
      const str = parseTerm(state);
      if (!str) return null;
      // Optional format hint
      const formatTerm = peek(state);
      let format: string | undefined;
      if (formatTerm && formatTerm.type === "string") {
        consume(state);
        format = formatTerm.value;
      }
      const examples = parseExamplesKeyword(state);
      return { tag: "parseDate", str, format, examples };
    }

    case "parseCurrency": {
      const str = parseTerm(state);
      if (!str) return null;
      const examples = parseExamplesKeyword(state);
      return { tag: "parseCurrency", str, examples };
    }

    case "parseNumber": {
      const str = parseTerm(state);
      if (!str) return null;
      const examples = parseExamplesKeyword(state);
      return { tag: "parseNumber", str, examples };
    }

    case "coerce":
    case "as": {
      const term = parseTerm(state);
      if (!term) return null;
      const typeTerm = parseTerm(state);
      if (!typeTerm || typeTerm.tag !== "lit" || typeof typeTerm.value !== "string")
        return null;
      const targetType = typeTerm.value as import("./types.js").CoercionType;
      return { tag: "coerce", term, targetType };
    }

    case "extract": {
      const str = parseTerm(state);
      if (!str) return null;
      const pattern = parseTerm(state);
      if (!pattern || pattern.tag !== "lit" || typeof pattern.value !== "string")
        return null;
      const group = parseTerm(state);
      if (!group || group.tag !== "lit" || typeof group.value !== "number")
        return null;
      // Optional type hint (string or :type keyword)
      let targetType: import("./types.js").CoercionType | undefined;
      const nextToken = peek(state);
      if (nextToken && nextToken.type === "string") {
        consume(state);
        targetType = nextToken.value as import("./types.js").CoercionType;
      } else if (nextToken?.type === "keyword" && nextToken.value === "type") {
        consume(state); // :type
        const typeVal = parseTerm(state);
        if (typeVal?.tag === "lit" && typeof typeVal.value === "string") {
          targetType = typeVal.value as import("./types.js").CoercionType;
        }
      }
      // Optional :examples
      const examples = parseExamplesKeyword(state);
      // Optional :constraints
      let constraints: Record<string, unknown> | undefined;
      const constraintKw = peek(state);
      if (constraintKw?.type === "keyword" && constraintKw.value === "constraints") {
        consume(state); // :constraints
        constraints = parseConstraintObject(state) ?? undefined;
      }
      return { tag: "extract", str, pattern: pattern.value, group: group.value, targetType, examples, constraints };
    }

    case "synthesize": {
      // Parse list of [input output] pairs
      // Supports: (synthesize ("in" out) ...) or (synthesize (example "in" out) ...)
      const MAX_SYNTH_EXAMPLES = 1000;
      const examples: Array<{ input: string; output: string | number | boolean | null }> = [];
      while (peek(state) && peek(state)?.type !== "rparen" && examples.length < MAX_SYNTH_EXAMPLES) {
        // Expect (input output) pair or [input output] or (example input output)
        const pairStart = peek(state);
        if (pairStart?.type === "lparen" || pairStart?.type === "lbracket") {
          consume(state); // ( or [

          // Check for optional "example" keyword
          const maybeExample = peek(state);
          if (maybeExample?.type === "symbol" && maybeExample.value === "example") {
            consume(state); // skip "example" keyword
          }

          const input = parseTerm(state);
          if (!input || input.tag !== "lit" || typeof input.value !== "string") break;
          const output = parseTerm(state);
          if (!output || output.tag !== "lit") break;
          const pairEnd = consume(state); // ) or ]
          if (!pairEnd || (pairEnd.type !== "rparen" && pairEnd.type !== "rbracket")) break;
          examples.push({ input: input.value, output: output.value as string | number | boolean | null });
        } else {
          // Also support flat pairs: "input1" output1 "input2" output2
          const input = parseTerm(state);
          if (!input || input.tag !== "lit" || typeof input.value !== "string") break;
          const output = parseTerm(state);
          if (!output || output.tag !== "lit") break;
          examples.push({ input: input.value, output: output.value as string | number | boolean | null });
        }
      }
      if (examples.length < 2) return null;
      return { tag: "synthesize", examples };
    }

    case "if": {
      const cond = parseTerm(state);
      if (!cond) return null;
      const thenBranch = parseTerm(state);
      if (!thenBranch) return null;
      const elseBranch = parseTerm(state);
      if (!elseBranch) return null;
      return { tag: "if", cond, then: thenBranch, else: elseBranch };
    }

    case "classify": {
      // Parse :examples keyword or pairs of (input output)
      const examples: Array<{ input: string; output: boolean | string | number }> = [];

      // Check for :examples keyword
      const maybeKeywordExamples = parseExamplesKeyword(state);
      if (maybeKeywordExamples) {
        for (const ex of maybeKeywordExamples) {
          examples.push({ input: ex.input, output: ex.output as boolean | string | number });
        }
      } else {
        // Fallback to inline pairs
        const MAX_CLASSIFY_EXAMPLES = 1000;
        while (peek(state) && peek(state)?.type !== "rparen" && examples.length < MAX_CLASSIFY_EXAMPLES) {
          const input = parseTerm(state);
          if (!input || input.tag !== "lit" || typeof input.value !== "string")
            break;
          const output = parseTerm(state);
          if (!output || output.tag !== "lit" || output.value === null) break;
          examples.push({ input: input.value, output: output.value });
        }
      }
      if (examples.length < 2) return null;
      return { tag: "classify", examples };
    }

    case "lambda":
    case "λ": {
      const param = peek(state);
      if (!param || param.type !== "symbol") return null;
      consume(state);
      const body = parseTerm(state);
      if (!body) return null;
      return { tag: "lambda", param: param.value, body };
    }

    case "define-fn": {
      // (define-fn "name" :examples [...])
      const nameTerm = parseTerm(state);
      if (!nameTerm || nameTerm.tag !== "lit" || typeof nameTerm.value !== "string")
        return null;
      const examples = parseExamplesKeyword(state);
      if (!examples || examples.length === 0) return null;
      return { tag: "define-fn", name: nameTerm.value, examples };
    }

    case "apply-fn": {
      // (apply-fn "name" arg)
      const nameTerm = parseTerm(state);
      if (!nameTerm || nameTerm.tag !== "lit" || typeof nameTerm.value !== "string")
        return null;
      const arg = parseTerm(state);
      if (!arg) return null;
      return { tag: "apply-fn", name: nameTerm.value, arg };
    }

    case "predicate": {
      // (predicate term :examples [...])
      const str = parseTerm(state);
      if (!str) return null;
      const examples = parseExamplesKeyword(state);
      return { tag: "predicate", str, examples };
    }

    case "list_symbols": {
      // (list_symbols) or (list_symbols "kind")
      const kindTerm = peek(state);
      if (kindTerm && kindTerm.type === "string") {
        consume(state);
        return { tag: "list_symbols", kind: kindTerm.value };
      }
      return { tag: "list_symbols" };
    }

    case "get_symbol_body": {
      // (get_symbol_body <symbol>)
      const symbol = parseTerm(state);
      if (!symbol) return null;
      return { tag: "get_symbol_body", symbol };
    }

    case "find_references": {
      // (find_references "name")
      const nameTerm = parseTerm(state);
      if (!nameTerm || nameTerm.tag !== "lit" || typeof nameTerm.value !== "string") {
        return null;
      }
      return { tag: "find_references", name: nameTerm.value };
    }

    default:
      // Function application or variable
      const fn: LCTerm = { tag: "var", name: op };
      const arg = parseTerm(state);
      if (arg) {
        return { tag: "app", fn, arg };
      }
      return fn;
  }
}

/**
 * Parse an LC expression from a string
 */
export function parse(input: string): ParseResult {
  try {
    const tokens = tokenize(input);
    if (tokens.length === 0) {
      return { success: false, error: "Empty input" };
    }

    // Check for unbalanced parentheses/brackets before parsing
    let parenDepth = 0;
    let bracketDepth = 0;
    for (const tok of tokens) {
      if (tok.type === "lparen") parenDepth++;
      else if (tok.type === "rparen") {
        parenDepth--;
        if (parenDepth < 0) {
          return { success: false, error: "Unbalanced parentheses: unexpected ')'" };
        }
      }
      else if (tok.type === "lbracket") bracketDepth++;
      else if (tok.type === "rbracket") {
        bracketDepth--;
        if (bracketDepth < 0) {
          return { success: false, error: "Unbalanced brackets: unexpected ']'" };
        }
      }
    }
    if (parenDepth > 0) {
      return { success: false, error: "Unbalanced parentheses: unclosed '('" };
    }
    if (bracketDepth > 0) {
      return { success: false, error: "Unbalanced brackets: unclosed '['" };
    }

    const state: ParserState = { tokens, pos: 0 };
    const term = parseTerm(state);

    if (!term) {
      return { success: false, error: "Failed to parse term" };
    }

    return {
      success: true,
      term,
      remaining: state.pos < tokens.length ? "unparsed tokens remain" : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Parse multiple terms (for multi-line input)
 */
export function parseAll(input: string): ParseResult[] {
  const results: ParseResult[] = [];
  // Join lines and parse complete S-expressions instead of splitting on newlines
  const trimmed = input.trim();
  if (!trimmed) return results;

  // Find top-level S-expressions by tracking parenthesis depth
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        const expr = trimmed.slice(start, i + 1);
        results.push(parse(expr));
        start = -1;
      }
    }
  }

  // If no parenthesized expressions found, try parsing as a single term
  if (results.length === 0) {
    results.push(parse(trimmed));
  }

  return results;
}

/**
 * Pretty-print an LC term back to S-expression syntax
 */
/** Escape a string for embedding in double-quoted S-expression output */
function escapeForPrint(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

export function prettyPrint(term: LCTerm): string {
  switch (term.tag) {
    case "input":
      return "(input)";
    case "lit":
      return typeof term.value === "string"
        ? `"${escapeForPrint(term.value)}"`
        : String(term.value);
    case "grep":
      return `(grep "${escapeForPrint(term.pattern)}")`;
    case "fuzzy_search":
      return term.limit
        ? `(fuzzy_search "${escapeForPrint(term.query)}" ${term.limit})`
        : `(fuzzy_search "${escapeForPrint(term.query)}")`;
    case "bm25":
      return term.limit
        ? `(bm25 "${escapeForPrint(term.query)}" ${term.limit})`
        : `(bm25 "${escapeForPrint(term.query)}")`;
    case "fuse":
      return `(fuse ${term.collections.map(c => prettyPrint(c)).join(" ")})`;
    case "text_stats":
      return "(text_stats)";
    case "lines":
      return `(lines ${term.start} ${term.end})`;
    case "filter":
      return `(filter ${prettyPrint(term.collection)} ${prettyPrint(term.predicate)})`;
    case "map":
      return `(map ${prettyPrint(term.collection)} ${prettyPrint(term.transform)})`;
    case "add":
      return `(add ${prettyPrint(term.left)} ${prettyPrint(term.right)})`;
    case "match":
      return `(match ${prettyPrint(term.str)} "${escapeForPrint(term.pattern)}" ${term.group})`;
    case "replace":
      return `(replace ${prettyPrint(term.str)} "${escapeForPrint(term.from)}" "${escapeForPrint(term.to)}")`;
    case "split":
      return `(split ${prettyPrint(term.str)} "${escapeForPrint(term.delim)}" ${term.index})`;
    case "parseInt":
      return `(parseInt ${prettyPrint(term.str)})`;
    case "parseFloat":
      return `(parseFloat ${prettyPrint(term.str)})`;
    case "if":
      return `(if ${prettyPrint(term.cond)} ${prettyPrint(term.then)} ${prettyPrint(term.else)})`;
    case "classify": {
      const examples = term.examples
        .map((e) => `"${escapeForPrint(e.input)}" ${e.output}`)
        .join(" ");
      return `(classify ${examples})`;
    }
    case "constrained":
      return `[${term.constraint}] ⊗ ${prettyPrint(term.term)}`;
    case "var":
      return term.name;
    case "app":
      return `(${prettyPrint(term.fn)} ${prettyPrint(term.arg)})`;
    case "lambda":
      return `(λ ${term.param} ${prettyPrint(term.body)})`;

    default:
      return `<unknown:${(term as LCTerm).tag}>`;
  }
}
