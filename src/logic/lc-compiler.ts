/**
 * LC to JavaScript Compiler
 *
 * Compiles Nucleus Lambda Calculus terms to executable JavaScript
 * that works with the existing sandbox tools (grep, synthesize_extractor, etc.)
 */

import type { LCTerm } from "./types.js";
import { resolveConstraints } from "./constraint-resolver.js";

/**
 * Compile an LC term to JavaScript code for sandbox execution
 */
export function compileToJS(term: LCTerm): string {
  // First resolve any constraints
  const resolved = resolveConstraints(term);
  const t = resolved.term;

  return compile(t);
}

/**
 * Internal compilation
 */
function compile(term: LCTerm): string {
  switch (term.tag) {
    case "input":
      return "input";

    case "lit":
      return JSON.stringify(term.value);

    case "grep":
      // grep returns array of {match, line, lineNum}
      return `(() => {
  const hits = grep("${escapeString(term.pattern)}");
  console.log("Found:", hits.length);
  console.log(JSON.stringify(hits.slice(0, 5), null, 2));
  return hits;
})()`;

    case "match": {
      const str = compile(term.str);
      const pattern = escapeRegex(term.pattern);
      return `(${str}).match(/${pattern}/)?.[${term.group}] ?? null`;
    }

    case "replace": {
      const str = compile(term.str);
      const from = escapeRegex(term.from);
      const to = escapeString(term.to);
      return `(${str}).replace(/${from}/g, "${to}")`;
    }

    case "split": {
      const str = compile(term.str);
      const delim = escapeString(term.delim);
      return `(${str}).split("${delim}")?.[${term.index}] ?? null`;
    }

    case "parseInt": {
      const str = compile(term.str);
      return `parseInt(${str}, 10)`;
    }

    case "parseFloat": {
      const str = compile(term.str);
      return `parseFloat(${str})`;
    }

    case "if": {
      const cond = compile(term.cond);
      const thenBranch = compile(term.then);
      const elseBranch = compile(term.else);
      return `(${cond}) ? (${thenBranch}) : (${elseBranch})`;
    }

    case "classify": {
      // Build synthesize_extractor call from examples
      const examples = term.examples
        .map((e) => `{ input: ${JSON.stringify(e.input)}, output: ${JSON.stringify(e.output)} }`)
        .join(",\n    ");

      return `(() => {
  // Build classifier from examples
  const classifier = synthesize_extractor([
    ${examples}
  ]);

  if (!classifier) {
    console.log("ERROR: Synthesis failed - need better examples");
    return null;
  }

  console.log("Classifier built successfully");

  // Apply classifier to grep results if available
  if (typeof hits !== 'undefined' && Array.isArray(hits)) {
    const results = [];
    for (const hit of hits) {
      const result = classifier(hit.line);
      if (result === true) {
        results.push(hit.line);
      }
    }
    console.log("Matching results:", results.length);
    console.log(JSON.stringify(results, null, 2));
    return results;
  }

  return classifier;
})()`;
    }

    case "constrained":
      // Constraints are resolved before compilation
      return compile(term.term);

    case "var":
      return term.name;

    case "app": {
      const fn = compile(term.fn);
      const arg = compile(term.arg);
      return `(${fn})(${arg})`;
    }

    case "lambda":
      return `((${term.param}) => ${compile(term.body)})`;
  }
}

/**
 * Escape string for JS string literal
 */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Escape regex pattern for JS regex literal
 */
function escapeRegex(pattern: string): string {
  // Don't escape the pattern itself - it's already a regex pattern
  // Just escape forward slashes for the literal syntax
  return pattern.replace(/\//g, "\\/");
}

/**
 * Check if an LC term is a search operation (grep)
 * Used to determine workflow state
 */
export function isSearchTerm(term: LCTerm): boolean {
  if (term.tag === "grep") return true;
  if (term.tag === "constrained") return isSearchTerm(term.term);
  return false;
}

/**
 * Check if an LC term is a classify operation
 */
export function isClassifyTerm(term: LCTerm): boolean {
  if (term.tag === "classify") return true;
  if (term.tag === "constrained") return isClassifyTerm(term.term);
  return false;
}

/**
 * Validate that a classify term uses real data (not placeholder examples)
 */
export function validateClassifyExamples(term: LCTerm, previousOutput: string[]): string | null {
  if (term.tag !== "classify") {
    if (term.tag === "constrained") {
      return validateClassifyExamples(term.term, previousOutput);
    }
    return null;
  }

  // Check each example input against previous output
  for (const example of term.examples) {
    const inputFound = previousOutput.some((line) =>
      line.includes(example.input) || example.input.includes(line.trim())
    );
    if (!inputFound) {
      return `Example "${example.input.slice(0, 50)}..." was not found in grep output. Copy EXACT lines from the output.`;
    }
  }

  return null;
}
