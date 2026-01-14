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
  | { type: "tensor" } // ⊗
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "symbol"; value: string }
  | { type: "boolean"; value: boolean };

/**
 * Lexer: convert input string to tokens
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
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

    // Brackets for constraints
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

    // Tensor product operator
    if (ch === "⊗") {
      tokens.push({ type: "tensor" });
      i++;
      continue;
    }

    // String literal
    if (ch === '"') {
      i++;
      let str = "";
      while (i < input.length && input[i] !== '"') {
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
                str += escaped;
            }
            i++;
          }
        } else {
          str += input[i];
          i++;
        }
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
      while (i < input.length && /[\d.]/.test(input[i])) {
        num += input[i];
        i++;
      }
      tokens.push({ type: "number", value: parseFloat(num) });
      continue;
    }

    // Symbol (including special characters for constraints)
    if (/[a-zA-Z_Σμε⚡φ∞\/]/.test(ch)) {
      let sym = "";
      while (i < input.length && /[a-zA-Z_0-9Σμε⚡φ∞\/]/.test(input[i])) {
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
 * Parse a single term
 */
function parseTerm(state: ParserState): LCTerm | null {
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

    case "text_stats": {
      return { tag: "text_stats" };
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
      if (!index || index.tag !== "lit" || typeof index.value !== "number")
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
      // Parse pairs of (input output)
      const examples: Array<{ input: string; output: boolean | string | number }> = [];
      while (peek(state) && peek(state)?.type !== "rparen") {
        const input = parseTerm(state);
        if (!input || input.tag !== "lit" || typeof input.value !== "string")
          break;
        const output = parseTerm(state);
        if (!output || output.tag !== "lit") break;
        examples.push({ input: input.value, output: output.value });
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
  const lines = input.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    results.push(parse(line.trim()));
  }

  return results;
}

/**
 * Pretty-print an LC term back to S-expression syntax
 */
export function prettyPrint(term: LCTerm): string {
  switch (term.tag) {
    case "input":
      return "(input)";
    case "lit":
      return typeof term.value === "string"
        ? `"${term.value}"`
        : String(term.value);
    case "grep":
      return `(grep "${term.pattern}")`;
    case "fuzzy_search":
      return term.limit
        ? `(fuzzy_search "${term.query}" ${term.limit})`
        : `(fuzzy_search "${term.query}")`;
    case "text_stats":
      return "(text_stats)";
    case "filter":
      return `(filter ${prettyPrint(term.collection)} ${prettyPrint(term.predicate)})`;
    case "map":
      return `(map ${prettyPrint(term.collection)} ${prettyPrint(term.transform)})`;
    case "add":
      return `(add ${prettyPrint(term.left)} ${prettyPrint(term.right)})`;
    case "match":
      return `(match ${prettyPrint(term.str)} "${term.pattern}" ${term.group})`;
    case "replace":
      return `(replace ${prettyPrint(term.str)} "${term.from}" "${term.to}")`;
    case "split":
      return `(split ${prettyPrint(term.str)} "${term.delim}" ${term.index})`;
    case "parseInt":
      return `(parseInt ${prettyPrint(term.str)})`;
    case "parseFloat":
      return `(parseFloat ${prettyPrint(term.str)})`;
    case "if":
      return `(if ${prettyPrint(term.cond)} ${prettyPrint(term.then)} ${prettyPrint(term.else)})`;
    case "classify": {
      const examples = term.examples
        .map((e) => `"${e.input}" ${e.output}`)
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
  }
}
