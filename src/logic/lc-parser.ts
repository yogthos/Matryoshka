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

  while (i < input.length) {
    if (tokens.length >= MAX_TOKENS) {
      // Never silently drop the tail of the input — a truncated token
      // stream would otherwise produce a "successful" parse of a prefix
      // or a misleading syntax error that gives no hint about the real
      // cause. Throw so parse() surfaces an explicit size-limit error.
      throw new Error(`Input too large: exceeded ${MAX_TOKENS} tokens`);
    }
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
      // Distinguish overflow from EOF: if the loop exited because we hit
      // the size cap (not the closing quote), bail with an explicit
      // length-related error instead of advancing `i` past whatever
      // character happens to be next — that would silently mis-pair
      // quotes and corrupt the rest of the parse.
      if (str.length >= MAX_STRING_LENGTH && input[i] !== '"') {
        throw new Error(
          `String literal too long: exceeds ${MAX_STRING_LENGTH} characters`
        );
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
    const term = parseTerm(state, depth + 1);
    if (!term) return null;
    return { tag: "constrained", constraint, term };
  }

  // List: (op args...)
  if (token.type === "lparen") {
    consume(state); // (
    const list = parseList(state, depth + 1);
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
function parseList(state: ParserState, depth: number = 0): LCTerm | null {
  if (depth > MAX_PARSE_DEPTH) return null;
  const first = peek(state);
  if (!first) return null;

  // Get the operator
  if (first.type !== "symbol") {
    return null;
  }
  consume(state);
  const op = first.value;
  const d = depth + 1;

  switch (op) {
    case "input":
      return { tag: "input" };

    case "lit": {
      const val = parseTerm(state, d);
      if (!val || val.tag !== "lit") return null;
      return val;
    }

    case "grep": {
      const pattern = parseTerm(state, d);
      if (!pattern || pattern.tag !== "lit" || typeof pattern.value !== "string")
        return null;
      // Optional second arg — any term that evaluates to a string.
      // Phase 3 introduces this for multi-context grep, but the
      // haystack can be any string-valued term (a binding, a literal,
      // or `(context N)`).
      let haystack: LCTerm | undefined;
      const next = peek(state);
      if (next && next.type !== "rparen") {
        const expr = parseTerm(state, d);
        if (!expr) return null;
        haystack = expr;
      }
      return { tag: "grep", pattern: pattern.value, haystack };
    }

    case "fuzzy_search": {
      const query = parseTerm(state, d);
      if (!query || query.tag !== "lit" || typeof query.value !== "string")
        return null;
      const limitTerm = peek(state);
      let limit: number | undefined;
      if (limitTerm && limitTerm.type === "number") {
        consume(state);
        limit = limitTerm.value;
      }
      return { tag: "fuzzy_search", query: query.value, limit };
    }

    case "bm25": {
      const query = parseTerm(state, d);
      if (!query || query.tag !== "lit" || typeof query.value !== "string")
        return null;
      const limitTerm = peek(state);
      let limit: number | undefined;
      if (limitTerm && limitTerm.type === "number") {
        consume(state);
        limit = limitTerm.value;
      }
      return { tag: "bm25", query: query.value, limit };
    }

    case "fuse": {
      const MAX_FUSE_ARGS = 10;
      const collections: LCTerm[] = [];
      while (peek(state) && peek(state)?.type !== "rparen" && collections.length < MAX_FUSE_ARGS) {
        const coll = parseTerm(state, d);
        if (!coll) break;
        collections.push(coll);
      }
      if (collections.length < 2) return null;
      return { tag: "fuse", collections };
    }

    case "dampen": {
      const collection = parseTerm(state, d);
      if (!collection) return null;
      const query = parseTerm(state, d);
      if (!query || query.tag !== "lit" || typeof query.value !== "string")
        return null;
      return { tag: "dampen", collection, query: query.value };
    }

    case "rerank": {
      const collection = parseTerm(state, d);
      if (!collection) return null;
      return { tag: "rerank", collection };
    }

    case "semantic": {
      const query = parseTerm(state, d);
      if (!query || query.tag !== "lit" || typeof query.value !== "string")
        return null;
      const limitTerm = peek(state);
      let limit: number | undefined;
      if (limitTerm && limitTerm.type === "number") {
        consume(state);
        limit = limitTerm.value;
      }
      return { tag: "semantic", query: query.value, limit };
    }

    case "text_stats": {
      return { tag: "text_stats" };
    }

    case "lines": {
      const startTerm = parseTerm(state, d);
      if (!startTerm || startTerm.tag !== "lit" || typeof startTerm.value !== "number") {
        return null;
      }
      const endTerm = parseTerm(state, d);
      if (!endTerm || endTerm.tag !== "lit" || typeof endTerm.value !== "number") {
        return null;
      }
      return { tag: "lines", start: startTerm.value, end: endTerm.value };
    }

    case "chunk_by_size": {
      const sizeTerm = parseTerm(state, d);
      if (!sizeTerm || sizeTerm.tag !== "lit" || typeof sizeTerm.value !== "number") {
        return null;
      }
      return { tag: "chunk_by_size", size: sizeTerm.value };
    }

    case "chunk_by_lines": {
      const nTerm = parseTerm(state, d);
      if (!nTerm || nTerm.tag !== "lit" || typeof nTerm.value !== "number") {
        return null;
      }
      return { tag: "chunk_by_lines", lineCount: nTerm.value };
    }

    case "chunk_by_regex": {
      const patTerm = parseTerm(state, d);
      if (!patTerm || patTerm.tag !== "lit" || typeof patTerm.value !== "string") {
        return null;
      }
      return { tag: "chunk_by_regex", pattern: patTerm.value };
    }

    case "seq": {
      // Parse a variadic list of subexprs. Empty seq is meaningless,
      // single-expr seq is silly but accepted (degrades to that expr's
      // value). Cap at 64 to bound damage from a runaway emit.
      const MAX_SEQ_EXPRS = 64;
      const exprs: LCTerm[] = [];
      while (true) {
        const next = peek(state);
        if (!next || next.type === "rparen") break;
        const sub = parseTerm(state, d);
        if (!sub) return null;
        exprs.push(sub);
        if (exprs.length > MAX_SEQ_EXPRS) return null;
      }
      if (exprs.length === 0) return null; // empty seq is meaningless
      return { tag: "seq", exprs };
    }

    case "filter": {
      const collection = parseTerm(state, d);
      if (!collection) return null;
      const predicate = parseTerm(state, d);
      if (!predicate) return null;
      return { tag: "filter", collection, predicate };
    }

    case "map": {
      const collection = parseTerm(state, d);
      if (!collection) return null;
      const transform = parseTerm(state, d);
      if (!transform) return null;
      return { tag: "map", collection, transform };
    }

    case "reduce": {
      const collection = parseTerm(state, d);
      if (!collection) return null;
      const init = parseTerm(state, d);
      if (!init) return null;
      const fn = parseTerm(state, d);
      if (!fn) return null;
      return { tag: "reduce", collection, init, fn };
    }

    case "sum": {
      const collection = parseTerm(state, d);
      if (!collection) return null;
      return { tag: "sum", collection };
    }

    case "count": {
      const collection = parseTerm(state, d);
      if (!collection) return null;
      return { tag: "count", collection };
    }

    case "add": {
      const left = parseTerm(state, d);
      if (!left) return null;
      const right = parseTerm(state, d);
      if (!right) return null;
      return { tag: "add", left, right };
    }

    case "match": {
      const str = parseTerm(state, d);
      if (!str) return null;
      const pattern = parseTerm(state, d);
      if (!pattern || pattern.tag !== "lit" || typeof pattern.value !== "string")
        return null;
      const group = parseTerm(state, d);
      if (!group || group.tag !== "lit" || typeof group.value !== "number")
        return null;
      if (!Number.isSafeInteger(group.value) || group.value < 0 || group.value > 99) return null;
      return { tag: "match", str, pattern: pattern.value, group: group.value };
    }

    case "replace": {
      const str = parseTerm(state, d);
      if (!str) return null;
      const from = parseTerm(state, d);
      if (!from || from.tag !== "lit" || typeof from.value !== "string")
        return null;
      const to = parseTerm(state, d);
      if (!to || to.tag !== "lit" || typeof to.value !== "string") return null;
      return { tag: "replace", str, from: from.value, to: to.value };
    }

    case "split": {
      const str = parseTerm(state, d);
      if (!str) return null;
      const delim = parseTerm(state, d);
      if (!delim || delim.tag !== "lit" || typeof delim.value !== "string")
        return null;
      const index = parseTerm(state, d);
      if (!index || index.tag !== "lit" || typeof index.value !== "number" || !Number.isSafeInteger(index.value))
        return null;
      return { tag: "split", str, delim: delim.value, index: index.value };
    }

    case "parseInt": {
      const str = parseTerm(state, d);
      if (!str) return null;
      return { tag: "parseInt", str };
    }

    case "parseFloat": {
      const str = parseTerm(state, d);
      if (!str) return null;
      return { tag: "parseFloat", str };
    }

    case "parseDate": {
      const str = parseTerm(state, d);
      if (!str) return null;
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
      const str = parseTerm(state, d);
      if (!str) return null;
      const examples = parseExamplesKeyword(state);
      return { tag: "parseCurrency", str, examples };
    }

    case "parseNumber": {
      const str = parseTerm(state, d);
      if (!str) return null;
      const examples = parseExamplesKeyword(state);
      return { tag: "parseNumber", str, examples };
    }

    case "coerce":
    case "as": {
      const term = parseTerm(state, d);
      if (!term) return null;
      const typeTerm = parseTerm(state, d);
      if (!typeTerm || typeTerm.tag !== "lit" || typeof typeTerm.value !== "string")
        return null;
      const targetType = typeTerm.value as import("./types.js").CoercionType;
      return { tag: "coerce", term, targetType };
    }

    case "extract": {
      const str = parseTerm(state, d);
      if (!str) return null;
      const pattern = parseTerm(state, d);
      if (!pattern || pattern.tag !== "lit" || typeof pattern.value !== "string")
        return null;
      const group = parseTerm(state, d);
      if (!group || group.tag !== "lit" || typeof group.value !== "number")
        return null;
      let targetType: import("./types.js").CoercionType | undefined;
      const nextToken = peek(state);
      if (nextToken && nextToken.type === "string") {
        consume(state);
        targetType = nextToken.value as import("./types.js").CoercionType;
      } else if (nextToken?.type === "keyword" && nextToken.value === "type") {
        consume(state);
        const typeVal = parseTerm(state, d);
        if (typeVal?.tag === "lit" && typeof typeVal.value === "string") {
          targetType = typeVal.value as import("./types.js").CoercionType;
        }
      }
      const examples = parseExamplesKeyword(state);
      let constraints: Record<string, unknown> | undefined;
      const constraintKw = peek(state);
      if (constraintKw?.type === "keyword" && constraintKw.value === "constraints") {
        consume(state);
        constraints = parseConstraintObject(state) ?? undefined;
      }
      return { tag: "extract", str, pattern: pattern.value, group: group.value, targetType, examples, constraints };
    }

    case "synthesize": {
      const MAX_SYNTH_EXAMPLES = 1000;
      const examples: Array<{ input: string; output: string | number | boolean | null }> = [];
      while (peek(state) && peek(state)?.type !== "rparen" && examples.length < MAX_SYNTH_EXAMPLES) {
        const pairStart = peek(state);
        if (pairStart?.type === "lparen" || pairStart?.type === "lbracket") {
          consume(state);
          const maybeExample = peek(state);
          if (maybeExample?.type === "symbol" && maybeExample.value === "example") {
            consume(state);
          }
          const input = parseTerm(state, d);
          if (!input || input.tag !== "lit" || typeof input.value !== "string") break;
          const output = parseTerm(state, d);
          if (!output || output.tag !== "lit") break;
          const pairEnd = consume(state);
          if (!pairEnd || (pairEnd.type !== "rparen" && pairEnd.type !== "rbracket")) break;
          examples.push({ input: input.value, output: output.value as string | number | boolean | null });
        } else {
          const input = parseTerm(state, d);
          if (!input || input.tag !== "lit" || typeof input.value !== "string") break;
          const output = parseTerm(state, d);
          if (!output || output.tag !== "lit") break;
          examples.push({ input: input.value, output: output.value as string | number | boolean | null });
        }
      }
      if (examples.length < 2) return null;
      return { tag: "synthesize", examples };
    }

    case "if": {
      const cond = parseTerm(state, d);
      if (!cond) return null;
      const thenBranch = parseTerm(state, d);
      if (!thenBranch) return null;
      const elseBranch = parseTerm(state, d);
      if (!elseBranch) return null;
      return { tag: "if", cond, then: thenBranch, else: elseBranch };
    }

    case "classify": {
      const examples: Array<{ input: string; output: boolean | string | number }> = [];
      const maybeKeywordExamples = parseExamplesKeyword(state);
      if (maybeKeywordExamples) {
        for (const ex of maybeKeywordExamples) {
          examples.push({ input: ex.input, output: ex.output as boolean | string | number });
        }
      } else {
        const MAX_CLASSIFY_EXAMPLES = 1000;
        while (peek(state) && peek(state)?.type !== "rparen" && examples.length < MAX_CLASSIFY_EXAMPLES) {
          const input = parseTerm(state, d);
          if (!input || input.tag !== "lit" || typeof input.value !== "string")
            break;
          const output = parseTerm(state, d);
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
      const body = parseTerm(state, d);
      if (!body) return null;
      return { tag: "lambda", param: param.value, body };
    }

    case "define-fn": {
      const nameTerm = parseTerm(state, d);
      if (!nameTerm || nameTerm.tag !== "lit" || typeof nameTerm.value !== "string")
        return null;
      const examples = parseExamplesKeyword(state);
      if (!examples || examples.length === 0) return null;
      return { tag: "define-fn", name: nameTerm.value, examples };
    }

    case "apply-fn": {
      const nameTerm = parseTerm(state, d);
      if (!nameTerm || nameTerm.tag !== "lit" || typeof nameTerm.value !== "string")
        return null;
      const arg = parseTerm(state, d);
      if (!arg) return null;
      return { tag: "apply-fn", name: nameTerm.value, arg };
    }

    case "predicate": {
      const str = parseTerm(state, d);
      if (!str) return null;
      const examples = parseExamplesKeyword(state);
      return { tag: "predicate", str, examples };
    }

    case "list_symbols": {
      const kindTerm = peek(state);
      if (kindTerm && kindTerm.type === "string") {
        consume(state);
        return { tag: "list_symbols", kind: kindTerm.value };
      }
      return { tag: "list_symbols" };
    }

    case "get_symbol_body": {
      const symbol = parseTerm(state, d);
      if (!symbol) return null;
      return { tag: "get_symbol_body", symbol };
    }

    case "find_references": {
      const nameTerm = parseTerm(state, d);
      if (!nameTerm || nameTerm.tag !== "lit" || typeof nameTerm.value !== "string") {
        return null;
      }
      return { tag: "find_references", name: nameTerm.value };
    }

    case "callers":
    case "callees":
    case "ancestors":
    case "descendants":
    case "implementations": {
      const graphNameTerm = parseTerm(state, d);
      if (!graphNameTerm || graphNameTerm.tag !== "lit" || typeof graphNameTerm.value !== "string") {
        return null;
      }
      return { tag: op as "callers" | "callees" | "ancestors" | "descendants" | "implementations", name: graphNameTerm.value };
    }

    case "dependents": {
      const depNameTerm = parseTerm(state, d);
      if (!depNameTerm || depNameTerm.tag !== "lit" || typeof depNameTerm.value !== "string") {
        return null;
      }
      const depthTerm = peek(state);
      if (depthTerm && depthTerm.type === "number") {
        consume(state);
        return { tag: "dependents", name: depNameTerm.value, depth: depthTerm.value as number };
      }
      return { tag: "dependents", name: depNameTerm.value };
    }

    case "symbol_graph": {
      const sgNameTerm = parseTerm(state, d);
      if (!sgNameTerm || sgNameTerm.tag !== "lit" || typeof sgNameTerm.value !== "string") {
        return null;
      }
      const sgDepthTerm = peek(state);
      if (sgDepthTerm && sgDepthTerm.type === "number") {
        consume(state);
        return { tag: "symbol_graph", name: sgNameTerm.value, depth: sgDepthTerm.value as number };
      }
      return { tag: "symbol_graph", name: sgNameTerm.value };
    }


    case "communities":
      return { tag: "communities" };

    case "community_of": {
      const coNameTerm = parseTerm(state, d);
      if (!coNameTerm || coNameTerm.tag !== "lit" || typeof coNameTerm.value !== "string") {
        return null;
      }
      return { tag: "community_of", name: coNameTerm.value };
    }

    case "god_nodes": {
      const topNTerm = peek(state);
      if (topNTerm && topNTerm.type === "number") {
        consume(state);
        return { tag: "god_nodes", topN: topNTerm.value as number };
      }
      return { tag: "god_nodes" };
    }

    case "surprising_connections": {
      const scTopN = peek(state);
      if (scTopN && scTopN.type === "number") {
        consume(state);
        return { tag: "surprising_connections", topN: scTopN.value as number };
      }
      return { tag: "surprising_connections" };
    }

    case "bridge_nodes": {
      const bnTopN = peek(state);
      if (bnTopN && bnTopN.type === "number") {
        consume(state);
        return { tag: "bridge_nodes", topN: bnTopN.value as number };
      }
      return { tag: "bridge_nodes" };
    }

    case "suggest_questions":
      return { tag: "suggest_questions" };

    case "graph_report":
      return { tag: "graph_report" };

    case "llm_query": {
      // (llm_query "prompt" [(name binding) ...])
      //
      // Required first argument: string literal prompt.
      // Optional trailing arguments: (name binding) pairs that fill `{name}`
      // placeholders in the prompt with the named binding's value.
      const promptTerm = parseTerm(state, d);
      if (!promptTerm || promptTerm.tag !== "lit" || typeof promptTerm.value !== "string") {
        return null;
      }
      const promptStr = promptTerm.value;

      // A safety cap matching `escapeForSexp` in the adapter to keep an
      // accidentally-huge literal from blowing the parser's working set.
      const MAX_PROMPT_LENGTH = 500_000;
      if (promptStr.length > MAX_PROMPT_LENGTH) {
        return null;
      }

      const bindings: Array<{ name: string; value: LCTerm }> = [];
      const MAX_BINDINGS = 16;
      // Optional `(one_of "v1" "v2" …)` enum constraint. Only one
      // allowed per llm_query. Distinguished from a regular binding by
      // the reserved head symbol `one_of`.
      let oneOf: string[] | undefined;
      const MAX_ONE_OF = 32;
      // Optional `(calibrate)` bare marker. Meaningful only when the
      // llm_query is wrapped in an llm_batch, but parses here so the
      // same inner shape works in either context.
      let calibrate: boolean | undefined;

      while (true) {
        const next = peek(state);
        if (!next || next.type === "rparen") break;
        if (bindings.length >= MAX_BINDINGS) return null;

        // Each trailing form must be a paren group: either (name term)
        // for a placeholder binding, or (one_of "v1" "v2" …) for the
        // enum constraint.
        if (next.type !== "lparen") return null;
        consume(state);

        const headTok = peek(state);
        if (!headTok || headTok.type !== "symbol") return null;

        if (headTok.value === "one_of") {
          // Enum constraint — collect string literals until rparen.
          if (oneOf !== undefined) return null; // duplicate
          consume(state);
          const values: string[] = [];
          while (true) {
            const nv = peek(state);
            if (!nv || nv.type === "rparen") break;
            if (values.length >= MAX_ONE_OF) return null;
            const valTerm = parseTerm(state, d);
            if (
              !valTerm ||
              valTerm.tag !== "lit" ||
              typeof valTerm.value !== "string"
            ) {
              return null;
            }
            values.push(valTerm.value);
          }
          if (values.length === 0) return null; // empty enum is pointless
          const closing = peek(state);
          if (!closing || closing.type !== "rparen") return null;
          consume(state);
          oneOf = values;
          continue;
        }

        if (headTok.value === "calibrate") {
          // Bare marker — accepts no arguments. The only supported
          // shape is `(calibrate)`; any trailing tokens before the
          // rparen are a parse error so users don't accidentally
          // pass flags we don't interpret.
          if (calibrate !== undefined) return null; // duplicate
          consume(state);
          const closing = peek(state);
          if (!closing || closing.type !== "rparen") return null;
          consume(state);
          calibrate = true;
          continue;
        }

        // Regular (name term) binding.
        const bindingName = headTok.value;
        // Only allow conservative identifiers for the placeholder name so
        // that string interpolation can't inject odd characters.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingName)) return null;
        if (bindingName.length > 64) return null;
        consume(state);

        const valueTerm = parseTerm(state, d);
        if (!valueTerm) return null;

        const closing = peek(state);
        if (!closing || closing.type !== "rparen") return null;
        consume(state);

        bindings.push({ name: bindingName, value: valueTerm });
      }

      return { tag: "llm_query", prompt: promptStr, bindings, oneOf, calibrate };
    }

    case "show_vars": {
      // (show_vars) — no args. Reject any trailing tokens so a typo
      // like (show_vars 1) surfaces as a parse error rather than
      // being silently absorbed.
      const next = peek(state);
      if (next && next.type !== "rparen") return null;
      return { tag: "show_vars" };
    }

    case "context": {
      // (context N) — Phase 3 multi-context selector.
      //
      // Required: a non-negative integer literal index. The solver
      // resolves to the Nth entry of `tools.contexts`, falling back
      // to `tools.context` when index is 0 and `contexts` is unset.
      // We validate at parse time so a typo like `(context "alpha")`
      // surfaces as a clear parse error rather than a runtime
      // mystery.
      const idxTerm = parseTerm(state, d);
      if (!idxTerm || idxTerm.tag !== "lit" || typeof idxTerm.value !== "number") {
        return null;
      }
      const n = idxTerm.value;
      if (!Number.isInteger(n) || n < 0) return null;
      return { tag: "context", index: n };
    }

    case "rlm_query": {
      // (rlm_query "prompt" [(context EXPR)])
      //
      // Required first argument: string literal prompt.
      // Optional trailing form: (context EXPR) — the child's working
      // document. EXPR may be any LC term; the solver resolves it
      // before spawning the child. Only one (context …) form is
      // allowed. Unknown trailing forms are a parse error so a typo
      // doesn't silently degrade to the no-context shape.
      const promptTerm = parseTerm(state, d);
      if (!promptTerm || promptTerm.tag !== "lit" || typeof promptTerm.value !== "string") {
        return null;
      }
      const promptStr = promptTerm.value;

      // Mirror the safety cap on llm_query — keep an accidentally-
      // huge literal from blowing the parser's working set.
      const MAX_PROMPT_LENGTH = 500_000;
      if (promptStr.length > MAX_PROMPT_LENGTH) {
        return null;
      }

      let context: LCTerm | undefined;

      while (true) {
        const next = peek(state);
        if (!next || next.type === "rparen") break;
        if (next.type !== "lparen") return null;
        consume(state);

        const headTok = peek(state);
        if (!headTok || headTok.type !== "symbol") return null;

        if (headTok.value === "context") {
          if (context !== undefined) return null; // duplicate
          consume(state);
          const expr = parseTerm(state, d);
          if (!expr) return null; // (context) with no arg
          const closing = peek(state);
          if (!closing || closing.type !== "rparen") return null;
          consume(state);
          context = expr;
          continue;
        }

        // Unknown trailing form — reject so typos surface as parse
        // errors instead of silently being absorbed.
        return null;
      }

      return { tag: "rlm_query", prompt: promptStr, context };
    }

    case "rlm_batch": {
      // (rlm_batch COLLECTION (lambda X (rlm_query "prompt" [(context EXPR)])))
      //
      // Concurrent variant of `(map COLL (lambda x (rlm_query …)))`.
      // Same surface as llm_batch, but the lambda body is an
      // rlm_query (recursive child Nucleus session) instead of an
      // llm_query (flat sub-LLM call). Solver collects the per-item
      // (prompt, context) pairs and dispatches them through a single
      // tools.rlmBatch call so the implementation can fan them out
      // in parallel.
      //
      // Restriction: lambda body MUST be a direct rlm_query. Any
      // wrapping (e.g. (if … (rlm_query …) "default")) breaks the
      // static prompt/context extraction the batch path relies on.
      const collection = parseTerm(state, d);
      if (!collection) return null;

      const lambdaTerm = parseTerm(state, d);
      if (!lambdaTerm || lambdaTerm.tag !== "lambda") return null;
      if (lambdaTerm.body.tag !== "rlm_query") return null;

      return {
        tag: "rlm_batch",
        collection,
        param: lambdaTerm.param,
        prompt: lambdaTerm.body.prompt,
        context: lambdaTerm.body.context,
      };
    }

    case "llm_batch": {
      // (llm_batch COLLECTION (lambda X (llm_query "prompt" [(name bind) ...])))
      //
      // Drop-in replacement for `(map COLL (lambda x (llm_query …)))` —
      // same surface syntax, but the solver collects every interpolated
      // prompt into one array and dispatches them through a single
      // `tools.llmBatch` call instead of N serial suspensions.
      //
      // Only the "lambda of direct llm_query" shape parses. Wrapping the
      // llm_query in another form (e.g. `(match (llm_query …) …)`) is not
      // supported because the solver cannot statically collect the prompt
      // template in that case — batching requires N-times template
      // instantiation, not N-times free-form evaluation.
      const collection = parseTerm(state, d);
      if (!collection) return null;

      const lambdaTerm = parseTerm(state, d);
      if (!lambdaTerm || lambdaTerm.tag !== "lambda") return null;
      if (lambdaTerm.body.tag !== "llm_query") return null;

      return {
        tag: "llm_batch",
        collection,
        param: lambdaTerm.param,
        prompt: lambdaTerm.body.prompt,
        bindings: lambdaTerm.body.bindings,
        // Lift any enum constraint from the inner llm_query so the
        // solver can validate per-item without re-parsing the body.
        oneOf: lambdaTerm.body.oneOf,
        // Same for the calibration marker — the solver forwards it
        // to tools.llmBatch as an options flag.
        calibrate: lambdaTerm.body.calibrate,
      };
    }

    default: {
      const fn: LCTerm = { tag: "var", name: op };
      const arg = parseTerm(state, d);
      if (arg) {
        return { tag: "app", fn, arg };
      }
      return fn;
    }
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

  // Track `()`, `[]`, `{}` as independent depth stacks so that a stray
  // close bracket of one kind doesn't accidentally land at "depth 0"
  // mid-expression and emit a truncated slice. Stray closes without a
  // matching open are ignored (clamped at zero) — the inner parse() call
  // will report the malformed input via its own error path.
  let start = -1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;
  let escaped = false;

  const allZero = () => parenDepth === 0 && bracketDepth === 0 && braceDepth === 0;

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

    if (ch === "(" || ch === "[" || ch === "{") {
      if (allZero()) start = i;
      if (ch === "(") parenDepth++;
      else if (ch === "[") bracketDepth++;
      else braceDepth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (ch === ")" && parenDepth > 0) parenDepth--;
      else if (ch === "]" && bracketDepth > 0) bracketDepth--;
      else if (ch === "}" && braceDepth > 0) braceDepth--;
      else continue; // stray close — ignore

      if (allZero() && start >= 0) {
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
    case "dampen":
      return `(dampen ${prettyPrint(term.collection)} "${escapeForPrint(term.query)}")`;
    case "rerank":
      return `(rerank ${prettyPrint(term.collection)})`;
    case "semantic":
      return term.limit
        ? `(semantic "${escapeForPrint(term.query)}" ${term.limit})`
        : `(semantic "${escapeForPrint(term.query)}")`;
    case "text_stats":
      return "(text_stats)";
    case "lines":
      return `(lines ${term.start} ${term.end})`;
    case "chunk_by_size":
      return `(chunk_by_size ${term.size})`;
    case "chunk_by_lines":
      return `(chunk_by_lines ${term.lineCount})`;
    case "chunk_by_regex":
      return `(chunk_by_regex "${escapeForPrint(term.pattern)}")`;
    case "seq":
      return `(seq ${term.exprs.map(e => prettyPrint(e)).join(" ")})`;
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
