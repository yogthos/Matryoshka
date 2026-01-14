/**
 * Code Validator - Whitelist-based code restriction
 *
 * Instead of detecting manual parsing after the fact, we PREVENT
 * the model from using disallowed operations in the first place.
 *
 * Philosophy: The model should provide CONSTRAINTS to the synthesizer,
 * NOT write parsing/extraction code manually.
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
}

/**
 * Allowed function calls - the model can ONLY use these
 */
const ALLOWED_FUNCTIONS = new Set([
  // Search tools
  "grep",
  "fuzzy_search",
  "locate_line",

  // Synthesis tools - the model provides constraints, synthesizer generates code
  "synthesize_extractor",
  "synthesize_regex",

  // Output
  "console.log",
  "JSON.stringify",

  // Memory
  "memory.push",

  // Basic math
  "Math.floor",
  "Math.ceil",
  "Math.round",
  "Math.abs",
  "Math.min",
  "Math.max",
  "parseInt",
  "parseFloat",
  "Number",
  "String",
  "isNaN",
]);

/**
 * Disallowed patterns - these indicate the model is writing manual code
 * instead of using the synthesizer
 */
const DISALLOWED_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  suggestion: string;
}> = [
  // String methods that indicate manual parsing
  {
    pattern: /\.match\s*\(/,
    name: ".match()",
    suggestion: "Use synthesize_extractor() to build a function from examples",
  },
  {
    pattern: /\.replace\s*\(/,
    name: ".replace()",
    suggestion: "Use synthesize_extractor() to transform values",
  },
  {
    pattern: /\.split\s*\([^)]+\)\s*\[/,
    name: ".split()[index]",
    suggestion: "Use synthesize_extractor() to extract parts of a string",
  },
  {
    pattern: /\.search\s*\(/,
    name: ".search()",
    suggestion: "Use grep() to search, then synthesize_extractor() to extract",
  },
  {
    pattern: /\.indexOf\s*\([^)]*\)\s*(!==|===|>=|<=|>|<)/,
    name: ".indexOf() for searching",
    suggestion: "Use grep() to search the document",
  },

  // Array methods that indicate manual filtering/processing
  {
    pattern: /\.filter\s*\(/,
    name: ".filter()",
    suggestion:
      "Use grep() for searching, synthesize_extractor() for extraction",
  },
  {
    pattern: /\.map\s*\(/,
    name: ".map()",
    suggestion: "Use synthesize_extractor() to transform values",
  },
  {
    pattern: /\.reduce\s*\(/,
    name: ".reduce()",
    suggestion:
      "Use a simple for loop with the synthesized extractor to accumulate values",
  },
  {
    pattern: /\.find\s*\(/,
    name: ".find()",
    suggestion: "Use grep() to find matching lines",
  },
  {
    pattern: /\.some\s*\(/,
    name: ".some()",
    suggestion: "Use grep() to check if matches exist",
  },
  {
    pattern: /\.every\s*\(/,
    name: ".every()",
    suggestion: "Use grep() and check results",
  },

  // Regex literals - model should not write regex
  {
    pattern: /\/[^\/\n]+\/[gimsuvy]*/,
    name: "regex literal",
    suggestion:
      "DO NOT write regex. Use synthesize_regex() with example strings, or synthesize_extractor() with input/output pairs",
  },

  // RegExp constructor
  {
    pattern: /new\s+RegExp\s*\(/,
    name: "new RegExp()",
    suggestion:
      "DO NOT construct regex. Use synthesize_regex() with example strings",
  },
];

/**
 * Check if a specific match is an allowed property access, not a method call.
 * This is very strict - only allows exact patterns at the match location.
 */
function isAllowedPropertyAccess(
  code: string,
  matchIndex: number,
  patternName: string
): boolean {
  // Only apply exceptions for .match() pattern
  // We need to distinguish hit.match (property) from str.match() (method)
  if (patternName !== ".match()") {
    return false;
  }

  // Get the code right before the match (look for what precedes .match)
  const preceding = code.slice(Math.max(0, matchIndex - 15), matchIndex);

  // If preceded by "hit." then it's accessing the property, not calling method
  if (/\bhit$/.test(preceding)) {
    return true;
  }

  return false;
}

/**
 * Validate code against the whitelist
 * Returns validation result with helpful error message if invalid
 */
export function validateCode(code: string): ValidationResult {
  // Check for disallowed patterns
  for (const { pattern, name, suggestion } of DISALLOWED_PATTERNS) {
    const match = pattern.exec(code);
    if (match) {
      // Check if this is an allowed property access (not a method call)
      if (isAllowedPropertyAccess(code, match.index, name)) {
        continue;
      }

      return {
        valid: false,
        error: `DISALLOWED: ${name} is not permitted`,
        suggestion: `${suggestion}

Example using synthesizer:
\`\`\`javascript
// 1. Search for data
const hits = grep("keyword");
console.log(JSON.stringify(hits.slice(0, 3), null, 2));

// 2. Look at output, then provide examples to synthesizer
const extractor = synthesize_extractor([
  { input: "example_from_output_1", output: expected_value_1 },
  { input: "example_from_output_2", output: expected_value_2 }
]);

// 3. Use the synthesized function
if (extractor) {
  let total = 0;
  for (const hit of hits) {
    const value = extractor(hit.line);
    if (value !== null) total += value;
  }
  console.log("Total:", total);
}
\`\`\``,
      };
    }
  }

  return { valid: true };
}

/**
 * Format validation error as feedback for the model
 */
export function formatValidationFeedback(result: ValidationResult): string {
  if (result.valid) {
    return "";
  }

  return `## CODE REJECTED

${result.error}

${result.suggestion}

Remember: You are a CONSTRAINT PROVIDER. You provide INPUT/OUTPUT EXAMPLES.
The miniKanren synthesizer generates the actual parsing code.

DO NOT write parsing logic. Provide examples instead.`;
}
