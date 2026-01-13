/**
 * Extractor Synthesis Engine
 * Synthesizes data extraction functions from input→output examples
 */

/**
 * Extractor - a function that extracts data from strings
 */
export interface Extractor {
  name: string;
  description: string;
  code: string; // JavaScript function body
  test: (input: string) => unknown; // Compiled function
}

/**
 * Extractor synthesis request
 */
export interface ExtractorRequest {
  examples: Array<{ input: string; output: unknown }>;
  hints?: {
    outputType?: "number" | "string" | "array" | "object";
    pattern?: string; // Known regex pattern
  };
}

/**
 * Extractor template - predefined extraction patterns
 */
export interface ExtractorTemplate {
  name: string;
  description: string;
  inputPattern: RegExp;
  outputType: "number" | "string" | "array";
  code: string;
  testFn: (input: string) => unknown;
}

/**
 * Predefined extractor templates
 */
export const EXTRACTOR_TEMPLATES: ExtractorTemplate[] = [
  // Currency: $1,234,567 -> number
  {
    name: "currency_integer",
    description: "Extract integer from dollar currency",
    inputPattern: /^\$[\d,]+$/,
    outputType: "number",
    code: '(s) => parseInt(s.replace(/[$,]/g, ""), 10)',
    testFn: (s) => parseInt(s.replace(/[$,]/g, ""), 10),
  },

  // Currency with decimals: $1,234.56 -> number
  {
    name: "currency_decimal",
    description: "Extract decimal from dollar currency",
    inputPattern: /^\$[\d,]+\.\d+$/,
    outputType: "number",
    code: '(s) => parseFloat(s.replace(/[$,]/g, ""))',
    testFn: (s) => parseFloat(s.replace(/[$,]/g, "")),
  },

  // Plain integer: 123 -> number
  {
    name: "integer_plain",
    description: "Parse plain integer",
    inputPattern: /^\d+$/,
    outputType: "number",
    code: "(s) => parseInt(s, 10)",
    testFn: (s) => parseInt(s, 10),
  },

  // Integer with commas: 1,234,567 -> number
  {
    name: "integer_commas",
    description: "Parse integer with comma separators",
    inputPattern: /^[\d,]+$/,
    outputType: "number",
    code: '(s) => parseInt(s.replace(/,/g, ""), 10)',
    testFn: (s) => parseInt(s.replace(/,/g, ""), 10),
  },

  // Percentage: 50% -> 0.5
  {
    name: "percentage_to_decimal",
    description: "Convert percentage to decimal",
    inputPattern: /^\d+(\.\d+)?%$/,
    outputType: "number",
    code: '(s) => parseFloat(s.replace("%", "")) / 100',
    testFn: (s) => parseFloat(s.replace("%", "")) / 100,
  },

  // Key: Value -> Value (string)
  {
    name: "key_value_extract_value",
    description: "Extract value from key: value pattern",
    inputPattern: /^[^:]+:\s*.+$/,
    outputType: "string",
    code: '(s) => { const m = s.match(/^[^:]+:\\s*(.+)$/); return m ? m[1].trim() : null; }',
    testFn: (s) => {
      const m = s.match(/^[^:]+:\s*(.+)$/);
      return m ? m[1].trim() : null;
    },
  },

  // Key: Value -> Key (string)
  {
    name: "key_value_extract_key",
    description: "Extract key from key: value pattern",
    inputPattern: /^[^:]+:\s*.+$/,
    outputType: "string",
    code: '(s) => { const m = s.match(/^([^:]+):/); return m ? m[1].trim() : null; }',
    testFn: (s) => {
      const m = s.match(/^([^:]+):/);
      return m ? m[1].trim() : null;
    },
  },

  // Key=Value -> Value (string)
  {
    name: "key_equals_value_extract",
    description: "Extract value from key=value pattern",
    inputPattern: /^[^=]+=.+$/,
    outputType: "string",
    code: '(s) => { const m = s.match(/^[^=]+=(.+)$/); return m ? m[1] : null; }',
    testFn: (s) => {
      const m = s.match(/^[^=]+=(.+)$/);
      return m ? m[1] : null;
    },
  },

  // Comma-separated -> array
  {
    name: "split_comma",
    description: "Split by comma",
    inputPattern: /^[^,]+,[^,]+(,[^,]+)*$/,
    outputType: "array",
    code: "(s) => s.split(',').map(x => x.trim())",
    testFn: (s) => s.split(",").map((x) => x.trim()),
  },

  // Pipe-separated -> array
  {
    name: "split_pipe",
    description: "Split by pipe",
    inputPattern: /^[^|]+\|[^|]+(\|[^|]+)*$/,
    outputType: "array",
    code: "(s) => s.split('|').map(x => x.trim())",
    testFn: (s) => s.split("|").map((x) => x.trim()),
  },

  // [bracketed] -> content
  {
    name: "bracket_extract",
    description: "Extract content from square brackets",
    inputPattern: /^\[.+\]$/,
    outputType: "string",
    code: "(s) => s.slice(1, -1)",
    testFn: (s) => s.slice(1, -1),
  },

  // Log level extraction: [timestamp] LEVEL: message -> LEVEL
  {
    name: "log_level_extract",
    description: "Extract log level from log line",
    inputPattern: /^\[.+\]\s*(ERROR|WARN|INFO|DEBUG|TRACE):/i,
    outputType: "string",
    code: '(s) => { const m = s.match(/\\]\\s*(ERROR|WARN|INFO|DEBUG|TRACE):/i); return m ? m[1] : null; }',
    testFn: (s) => {
      const m = s.match(/\]\s*(ERROR|WARN|INFO|DEBUG|TRACE):/i);
      return m ? m[1] : null;
    },
  },
];

/**
 * Deep equality check for validation
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 0.0001; // Float tolerance
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      )
    );
  }
  return false;
}

/**
 * Check for conflicting examples (same input, different output)
 */
function hasConflicts(
  examples: Array<{ input: string; output: unknown }>
): boolean {
  const inputMap = new Map<string, unknown>();
  for (const ex of examples) {
    if (inputMap.has(ex.input)) {
      if (!deepEqual(inputMap.get(ex.input), ex.output)) {
        return true;
      }
    }
    inputMap.set(ex.input, ex.output);
  }
  return false;
}

/**
 * Find common prefix among strings
 */
function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix === "") return "";
    }
  }
  return prefix;
}

/**
 * Find common suffix among strings
 */
function findCommonSuffix(strings: string[]): string {
  if (strings.length === 0) return "";
  let suffix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.endsWith(suffix)) {
      suffix = suffix.slice(1);
      if (suffix === "") return "";
    }
  }
  return suffix;
}

/**
 * Synthesize an extractor from examples
 */
export function synthesizeExtractor(
  request: ExtractorRequest
): Extractor | null {
  const { examples, hints } = request;

  // Validation
  if (examples.length === 0) {
    return null;
  }

  // Check for conflicting examples
  if (hasConflicts(examples)) {
    return null;
  }

  const inputs = examples.map((e) => e.input);
  const outputs = examples.map((e) => e.output);
  const outputType = hints?.outputType || inferOutputType(outputs[0]);

  // Try each template
  for (const template of EXTRACTOR_TEMPLATES) {
    // Check if output type matches
    if (hints?.outputType && hints.outputType !== template.outputType) continue;

    // Check if template pattern matches all inputs
    const allMatch = inputs.every((input) => template.inputPattern.test(input));
    if (!allMatch) continue;

    // Verify against all examples
    const allCorrect = examples.every((e) => {
      try {
        const result = template.testFn(e.input);
        return deepEqual(result, e.output);
      } catch {
        return false;
      }
    });

    if (allCorrect) {
      return {
        name: template.name,
        description: template.description,
        code: template.code,
        test: template.testFn,
      };
    }
  }

  // Try prefix/suffix based extraction
  const prefixSuffixExtractor = tryPrefixSuffixExtraction(examples, outputType);
  if (prefixSuffixExtractor) return prefixSuffixExtractor;

  // Try delimiter-based field extraction
  const delimiterExtractor = tryDelimiterFieldExtraction(examples, outputType);
  if (delimiterExtractor) return delimiterExtractor;

  // Try structured text extraction (e.g., "Total: $1,234" -> 1234)
  const structuredExtractor = tryStructuredExtraction(examples, outputType);
  if (structuredExtractor) return structuredExtractor;

  // Try regex-based custom extraction
  const regexExtractor = tryRegexExtraction(examples, outputType);
  if (regexExtractor) return regexExtractor;

  return null;
}

/**
 * Infer output type from sample
 */
function inferOutputType(
  sample: unknown
): "number" | "string" | "array" | "object" {
  if (typeof sample === "number") return "number";
  if (Array.isArray(sample)) return "array";
  if (typeof sample === "object" && sample !== null) return "object";
  return "string";
}

/**
 * Try prefix/suffix based extraction
 */
function tryPrefixSuffixExtraction(
  examples: Array<{ input: string; output: unknown }>,
  outputType: string
): Extractor | null {
  if (outputType !== "string") return null;

  const inputs = examples.map((e) => e.input);
  const outputs = examples.map((e) => String(e.output));

  // Check if outputs are substrings of inputs with common prefix/suffix removed
  const inputPrefix = findCommonPrefix(inputs);
  const inputSuffix = findCommonSuffix(inputs);

  if (inputPrefix.length === 0 && inputSuffix.length === 0) return null;

  // Check if removing prefix/suffix gives us the outputs
  const allMatch = examples.every((e, i) => {
    const endIdx = inputSuffix.length > 0 ? -inputSuffix.length : undefined;
    const stripped = e.input.slice(inputPrefix.length, endIdx);
    return stripped === outputs[i];
  });

  if (allMatch) {
    const prefixLen = inputPrefix.length;
    const suffixLen = inputSuffix.length;

    const code =
      suffixLen > 0
        ? `(s) => s.slice(${prefixLen}, ${-suffixLen})`
        : `(s) => s.slice(${prefixLen})`;

    const testFn =
      suffixLen > 0
        ? (s: string) => s.slice(prefixLen, -suffixLen)
        : (s: string) => s.slice(prefixLen);

    return {
      name: "prefix_suffix_strip",
      description: `Remove prefix "${inputPrefix}" and suffix "${inputSuffix}"`,
      code,
      test: testFn,
    };
  }

  return null;
}

/**
 * Try delimiter-based field extraction
 */
function tryDelimiterFieldExtraction(
  examples: Array<{ input: string; output: unknown }>,
  outputType: string
): Extractor | null {
  if (outputType !== "string") return null;

  const delimiters = [",", "|", "\t", ";", " "];

  for (const delim of delimiters) {
    // Check if all inputs have the delimiter
    const allHaveDelim = examples.every((e) => e.input.includes(delim));
    if (!allHaveDelim) continue;

    // Find which field index produces the output
    for (let fieldIdx = 0; fieldIdx < 10; fieldIdx++) {
      const allMatch = examples.every((e) => {
        const fields = e.input.split(delim).map((f) => f.trim());
        return fields[fieldIdx] === String(e.output);
      });

      if (allMatch) {
        const escapedDelim = delim === "|" ? "\\|" : delim;
        const code = `(s) => s.split('${escapedDelim}').map(x => x.trim())[${fieldIdx}]`;
        const testFn = (s: string) =>
          s.split(delim).map((x) => x.trim())[fieldIdx];

        return {
          name: `delimiter_field_${fieldIdx}`,
          description: `Extract field ${fieldIdx} from ${delim}-separated values`,
          code,
          test: testFn,
        };
      }
    }
  }

  return null;
}

/**
 * Try structured text extraction (e.g., "Total: $1,234" -> 1234)
 */
function tryStructuredExtraction(
  examples: Array<{ input: string; output: unknown }>,
  outputType: string
): Extractor | null {
  if (outputType !== "number") return null;

  // Try to find currency values in structured text
  const currencyPattern = /\$[\d,]+(\.\d+)?/;

  const allHaveCurrency = examples.every((e) => currencyPattern.test(e.input));
  if (allHaveCurrency) {
    const allMatch = examples.every((e) => {
      const match = e.input.match(currencyPattern);
      if (!match) return false;
      const value = parseFloat(match[0].replace(/[$,]/g, ""));
      return deepEqual(value, e.output);
    });

    if (allMatch) {
      const code =
        '(s) => { const m = s.match(/\\$[\\d,]+(\\.[\\d]+)?/); return m ? parseFloat(m[0].replace(/[$,]/g, "")) : null; }';
      const testFn = (s: string) => {
        const m = s.match(/\$[\d,]+(\.\d+)?/);
        return m ? parseFloat(m[0].replace(/[$,]/g, "")) : null;
      };

      return {
        name: "structured_currency_extract",
        description: "Extract currency value from structured text",
        code,
        test: testFn,
      };
    }
  }

  // Try to find plain numbers in structured text
  const numberPattern = /\d+(\.\d+)?/;

  const allMatch = examples.every((e) => {
    const match = e.input.match(numberPattern);
    if (!match) return false;
    const value = parseFloat(match[0]);
    return deepEqual(value, e.output);
  });

  if (allMatch) {
    const code =
      "(s) => { const m = s.match(/\\d+(\\.\\d+)?/); return m ? parseFloat(m[0]) : null; }";
    const testFn = (s: string) => {
      const m = s.match(/\d+(\.\d+)?/);
      return m ? parseFloat(m[0]) : null;
    };

    return {
      name: "structured_number_extract",
      description: "Extract number from structured text",
      code,
      test: testFn,
    };
  }

  return null;
}

/**
 * Try regex-based custom extraction
 */
function tryRegexExtraction(
  examples: Array<{ input: string; output: unknown }>,
  outputType: string
): Extractor | null {
  // Try common extraction patterns

  // Pattern: [content] -> content
  if (
    examples.every((e) => e.input.startsWith("[") && e.input.endsWith("]"))
  ) {
    const allMatch = examples.every((e) => {
      const extracted = e.input.slice(1, -1);
      return deepEqual(extracted, e.output);
    });

    if (allMatch) {
      return {
        name: "bracket_content",
        description: "Extract content from brackets",
        code: "(s) => s.slice(1, -1)",
        test: (s) => s.slice(1, -1),
      };
    }
  }

  // Pattern: (content) -> content
  if (
    examples.every((e) => e.input.startsWith("(") && e.input.endsWith(")"))
  ) {
    const allMatch = examples.every((e) => {
      const extracted = e.input.slice(1, -1);
      return deepEqual(extracted, e.output);
    });

    if (allMatch) {
      return {
        name: "paren_content",
        description: "Extract content from parentheses",
        code: "(s) => s.slice(1, -1)",
        test: (s) => s.slice(1, -1),
      };
    }
  }

  return null;
}
