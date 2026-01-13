/**
 * JavaScript Compilation for the Data Extraction DSL
 *
 * Converts Extractor DSL to executable JavaScript code.
 * This allows synthesized extractors to be used at runtime
 * without the overhead of the interpreter.
 */

import type { Extractor, Value } from "./types.js";

/**
 * Compile an extractor to JavaScript code
 *
 * The generated code expects 'input' to be in scope.
 */
export function compile(extractor: Extractor): string {
  switch (extractor.tag) {
    case "input":
      return "input";

    case "lit":
      if (typeof extractor.value === "string") {
        return JSON.stringify(extractor.value);
      }
      return String(extractor.value);

    case "match": {
      const strCode = compile(extractor.str);
      const pattern = escapeRegexForLiteral(extractor.pattern);
      return `(${strCode}).match(/${pattern}/)?.[${extractor.group}] ?? null`;
    }

    case "replace": {
      const strCode = compile(extractor.str);
      const from = escapeRegexForLiteral(extractor.from);
      const to = escapeStringForLiteral(extractor.to);
      return `(${strCode}).replace(/${from}/g, "${to}")`;
    }

    case "slice": {
      const strCode = compile(extractor.str);
      return `(${strCode}).slice(${extractor.start}, ${extractor.end})`;
    }

    case "split": {
      const strCode = compile(extractor.str);
      const delim = escapeStringForLiteral(extractor.delim);
      return `(${strCode}).split("${delim}")?.[${extractor.index}] ?? null`;
    }

    case "parseInt": {
      const strCode = compile(extractor.str);
      return `parseInt(${strCode}, 10)`;
    }

    case "parseFloat": {
      const strCode = compile(extractor.str);
      return `parseFloat(${strCode})`;
    }

    case "add": {
      const leftCode = compile(extractor.left);
      const rightCode = compile(extractor.right);
      return `(${leftCode}) + (${rightCode})`;
    }

    case "if": {
      const condCode = compile(extractor.cond);
      const thenCode = compile(extractor.then);
      const elseCode = compile(extractor.else);
      return `(${condCode}) ? (${thenCode}) : (${elseCode})`;
    }
  }
}

/**
 * Compile an extractor to a JavaScript function
 *
 * @returns A function that takes an input string and returns the extracted value
 */
export function compileToFunction(extractor: Extractor): (input: string) => Value {
  const code = compile(extractor);
  const fnCode = `(input) => ${code}`;

  try {
    // Use Function constructor to create the function
    // This is safe because we control the code generation
    return new Function("input", `return ${code}`) as (input: string) => Value;
  } catch (err) {
    throw new Error(`Failed to compile extractor: ${err}`);
  }
}

/**
 * Compile an extractor to a complete function expression string
 *
 * Useful for displaying the generated code to users.
 */
export function compileToFunctionString(extractor: Extractor): string {
  const code = compile(extractor);
  return `(input) => ${code}`;
}

/**
 * Escape special characters for use in a regex literal
 */
function escapeRegexForLiteral(pattern: string): string {
  // Don't escape the pattern itself - it's already a regex pattern
  // Just escape forward slashes for the literal syntax
  return pattern.replace(/\//g, "\\/");
}

/**
 * Escape special characters for use in a string literal
 */
function escapeStringForLiteral(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Pretty-print an extractor as a human-readable expression
 */
export function prettyPrint(extractor: Extractor): string {
  switch (extractor.tag) {
    case "input":
      return "input";

    case "lit":
      return JSON.stringify(extractor.value);

    case "match":
      return `match(${prettyPrint(extractor.str)}, /${extractor.pattern}/, ${extractor.group})`;

    case "replace":
      return `replace(${prettyPrint(extractor.str)}, "${extractor.from}", "${extractor.to}")`;

    case "slice":
      return `slice(${prettyPrint(extractor.str)}, ${extractor.start}, ${extractor.end})`;

    case "split":
      return `split(${prettyPrint(extractor.str)}, "${extractor.delim}", ${extractor.index})`;

    case "parseInt":
      return `parseInt(${prettyPrint(extractor.str)})`;

    case "parseFloat":
      return `parseFloat(${prettyPrint(extractor.str)})`;

    case "add":
      return `add(${prettyPrint(extractor.left)}, ${prettyPrint(extractor.right)})`;

    case "if":
      return `if(${prettyPrint(extractor.cond)}, ${prettyPrint(extractor.then)}, ${prettyPrint(extractor.else)})`;
  }
}
