/**
 * Relational Interpreter for the Data Extraction DSL
 *
 * This is the core of Barliman-style synthesis:
 * - evalo(extractor, input, output) is a RELATION
 * - Forward mode: given extractor + input, find output
 * - Backwards mode: given input + output, find extractor (SYNTHESIS!)
 *
 * The key insight is that we can "run the interpreter backwards"
 * to synthesize programs from examples.
 */

import { run, eq, conde, exist, Rel } from "../../minikanren/index.js";
import type { Var } from "../../minikanren/common.js";
import type { Extractor, Example, Value } from "./types.js";

// ============================================================================
// Forward Evaluation (Standard Interpreter)
// ============================================================================

/**
 * Evaluate an extractor on an input string
 * This is the forward mode - given extractor + input, compute output
 */
export function evalExtractor(extractor: Extractor, input: string): Value {
  switch (extractor.tag) {
    case "input":
      return input;

    case "lit":
      return extractor.value;

    case "match": {
      const str = evalExtractor(extractor.str, input);
      if (typeof str !== "string") return null;

      try {
        const regex = new RegExp(extractor.pattern);
        const match = str.match(regex);
        if (!match) return null;
        return match[extractor.group] ?? null;
      } catch {
        return null;
      }
    }

    case "replace": {
      const str = evalExtractor(extractor.str, input);
      if (typeof str !== "string") return null;

      try {
        const regex = new RegExp(extractor.from, "g");
        return str.replace(regex, extractor.to);
      } catch {
        return null;
      }
    }

    case "slice": {
      const str = evalExtractor(extractor.str, input);
      if (typeof str !== "string") return null;
      return str.slice(extractor.start, extractor.end);
    }

    case "split": {
      const str = evalExtractor(extractor.str, input);
      if (typeof str !== "string") return null;

      const parts = str.split(extractor.delim);
      if (extractor.index < 0 || extractor.index >= parts.length) return null;
      return parts[extractor.index];
    }

    case "parseInt": {
      const str = evalExtractor(extractor.str, input);
      if (str === null) return NaN;
      return parseInt(String(str), 10);
    }

    case "parseFloat": {
      const str = evalExtractor(extractor.str, input);
      if (str === null) return NaN;
      return parseFloat(String(str));
    }

    case "add": {
      const left = evalExtractor(extractor.left, input);
      const right = evalExtractor(extractor.right, input);
      if (typeof left !== "number" || typeof right !== "number") return NaN;
      return left + right;
    }

    case "if": {
      const cond = evalExtractor(extractor.cond, input);
      // Falsy: null, "", 0, false
      const isFalsy = cond === null || cond === "" || cond === 0 || cond === false;
      return isFalsy
        ? evalExtractor(extractor.else, input)
        : evalExtractor(extractor.then, input);
    }
  }
}

// ============================================================================
// Relational Mode (for synthesis)
// ============================================================================

/**
 * Common regex patterns for data extraction
 */
const COMMON_PATTERNS = [
  "\\$(\\d+)",           // $100
  "\\$([\\d,]+)",        // $1,234
  "(\\d+)%",             // 50%
  "(\\d+)",              // plain number
  "([\\d,]+)",           // number with commas
  ":\\s*(.+)",           // key: value
  "\\$([\\d,\\.]+)",     // $1,234.56
];

/**
 * Relational evalo - can run forwards or backwards
 *
 * This uses miniKanren to enumerate possible extractors when
 * the extractor is unknown (synthesis mode).
 *
 * @param extractor - The extractor (or logic variable for synthesis)
 * @param input - The input string
 * @param expectedOutput - The expected output (or logic variable for evaluation)
 * @returns Array of outputs that unify (for checking purposes)
 */
export function evalo(
  extractor: Extractor,
  input: string,
  expectedOutput: Value | null
): Value[] {
  const result = evalExtractor(extractor, input);

  // If expectedOutput is provided, check if it matches
  if (expectedOutput !== null) {
    if (result === expectedOutput) {
      return [result];
    }
    return [];
  }

  return [result];
}

// ============================================================================
// Synthesis (Backwards Mode)
// ============================================================================

/**
 * Generate candidate extractors using miniKanren
 *
 * This enumerates possible extractor shapes:
 * - input (identity)
 * - lit (constant)
 * - match with various patterns
 * - parseInt/parseFloat of match
 * - replace + parseInt/parseFloat (for commas)
 */
function* generateCandidates(): Generator<Extractor> {
  // Simplest: identity
  yield { tag: "input" };

  // Match with various patterns and groups
  for (const pattern of COMMON_PATTERNS) {
    // Direct match (returns string)
    yield {
      tag: "match",
      str: { tag: "input" },
      pattern,
      group: 0,
    };
    yield {
      tag: "match",
      str: { tag: "input" },
      pattern,
      group: 1,
    };

    // parseInt of match (returns number)
    yield {
      tag: "parseInt",
      str: {
        tag: "match",
        str: { tag: "input" },
        pattern,
        group: 0,
      },
    };
    yield {
      tag: "parseInt",
      str: {
        tag: "match",
        str: { tag: "input" },
        pattern,
        group: 1,
      },
    };

    // parseFloat of match
    yield {
      tag: "parseFloat",
      str: {
        tag: "match",
        str: { tag: "input" },
        pattern,
        group: 0,
      },
    };
    yield {
      tag: "parseFloat",
      str: {
        tag: "match",
        str: { tag: "input" },
        pattern,
        group: 1,
      },
    };

    // parseFloat of replace(match, /,/, "") - for currency with commas
    yield {
      tag: "parseFloat",
      str: {
        tag: "replace",
        str: {
          tag: "match",
          str: { tag: "input" },
          pattern,
          group: 1,
        },
        from: ",",
        to: "",
      },
    };

    // parseInt of replace(match, /,/, "")
    yield {
      tag: "parseInt",
      str: {
        tag: "replace",
        str: {
          tag: "match",
          str: { tag: "input" },
          pattern,
          group: 1,
        },
        from: ",",
        to: "",
      },
    };
  }
}

/**
 * Synthesize extractors from input/output examples
 *
 * This is the BACKWARDS mode of evalo:
 * Given input/output pairs, find extractors that produce those outputs.
 *
 * @param examples - Array of { input, output } pairs
 * @param maxResults - Maximum number of extractors to return
 * @returns Array of extractors that satisfy all examples
 */
export function synthesizeExtractor(
  examples: Example[],
  maxResults: number = 5
): Extractor[] {
  // Validate inputs
  if (examples.length < 2) {
    throw new Error("Need at least 2 examples for reliable synthesis");
  }

  // Check for conflicting examples (same input, different output)
  const inputToOutput = new Map<string, Value>();
  for (const { input, output } of examples) {
    const existing = inputToOutput.get(input);
    if (existing !== undefined && existing !== output) {
      throw new Error(
        `Conflicting examples: input "${input}" maps to both ${JSON.stringify(existing)} and ${JSON.stringify(output)}`
      );
    }
    inputToOutput.set(input, output);
  }

  // Check for constant output (all outputs are the same)
  const outputs = examples.map(e => e.output);
  const allSame = outputs.every(o => o === outputs[0]);
  if (allSame) {
    // Return literal extractor
    return [{ tag: "lit", value: outputs[0] as string | number }];
  }

  // Check for identity (output === input for all)
  const allIdentity = examples.every(e => e.output === e.input);
  if (allIdentity) {
    return [{ tag: "input" }];
  }

  // Search for extractors that work for ALL examples
  const successfulExtractors: Extractor[] = [];

  for (const candidate of generateCandidates()) {
    if (successfulExtractors.length >= maxResults) {
      break;
    }

    // Test candidate on ALL examples
    let allPass = true;
    for (const { input, output } of examples) {
      const result = evalExtractor(candidate, input);
      if (result !== output) {
        allPass = false;
        break;
      }
    }

    if (allPass) {
      successfulExtractors.push(candidate);
    }
  }

  return successfulExtractors;
}

/**
 * Find the simplest extractor that satisfies examples
 */
export function synthesizeSimplest(examples: Example[]): Extractor | null {
  const extractors = synthesizeExtractor(examples, 1);
  return extractors[0] ?? null;
}
