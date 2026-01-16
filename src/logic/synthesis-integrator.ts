/**
 * SynthesisIntegrator - Bridge between LC solver and synthesis engines
 *
 * This module provides automatic synthesis fallback when built-in operations fail.
 * It integrates with the SynthesisCoordinator to provide:
 * 1. Automatic synthesis on operation failure
 * 2. Function caching for reuse
 * 3. Type-aware synthesis based on expected output types
 *
 * The key insight from Barliman: the LLM provides CONSTRAINTS (examples),
 * and the synthesis engine finds programs that satisfy those constraints.
 */

import {
  SynthesisCoordinator,
} from "../synthesis/coordinator.js";
import { KnowledgeBase } from "../synthesis/knowledge-base.js";
import {
  synthesizeProgram,
  exprToCode,
  testProgram,
  type Example,
} from "../synthesis/relational/interpreter.js";

/**
 * Context for synthesis request
 */
export interface SynthesisContext {
  /** The operation that failed (parseCurrency, parseDate, predicate, etc.) */
  operation: string;

  /** The input that triggered the failure */
  input: unknown;

  /** Expected output type hint */
  expectedType?: string;

  /** Input/output examples for synthesis */
  examples?: Array<{ input: string; output: unknown }>;

  /** Current bindings from the solver (for context) */
  bindings?: Map<string, unknown>;
}

/**
 * Result of synthesis attempt
 */
export interface SynthesisOutcome {
  /** Whether synthesis succeeded */
  success: boolean;

  /** The synthesized function */
  fn?: (input: string) => unknown;

  /** The synthesized code as a string */
  code?: string;

  /** Cache key for this synthesis */
  cacheKey?: string;

  /** Error message if synthesis failed */
  error?: string;
}

/**
 * Month name mappings for date parsing
 */
const MONTH_NAMES: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/**
 * SynthesisIntegrator - Automatic synthesis on operation failure
 */
export class SynthesisIntegrator {
  private fnCache: Map<string, (input: string) => unknown>;
  private codeCache: Map<string, string>;
  private coordinator: SynthesisCoordinator;

  constructor(knowledgeBase?: KnowledgeBase) {
    this.fnCache = new Map();
    this.codeCache = new Map();
    this.coordinator = new SynthesisCoordinator(knowledgeBase);
  }

  /**
   * Attempt synthesis when an operation fails
   */
  synthesizeOnFailure(context: SynthesisContext): SynthesisOutcome {
    const { operation, input, examples, expectedType } = context;

    // Validate examples
    if (!examples || examples.length === 0) {
      return {
        success: false,
        error: "No examples provided for synthesis",
      };
    }

    // Check for conflicting examples
    const inputMap = new Map<string, unknown>();
    for (const ex of examples) {
      if (inputMap.has(ex.input) && inputMap.get(ex.input) !== ex.output) {
        return {
          success: false,
          error: "Conflicting examples: same input with different outputs",
        };
      }
      inputMap.set(ex.input, ex.output);
    }

    // Generate cache key
    const cacheKey = this.generateCacheKey(operation, examples);

    // Check cache first
    const cached = this.fnCache.get(cacheKey);
    if (cached) {
      return {
        success: true,
        fn: cached,
        code: this.codeCache.get(cacheKey),
        cacheKey,
      };
    }

    // Route to appropriate synthesis strategy
    let result: SynthesisOutcome;

    switch (operation) {
      case "parseCurrency":
        result = this.synthesizeCurrencyParser(examples);
        break;
      case "parseDate":
        result = this.synthesizeDateParser(examples);
        break;
      case "parseNumber":
        result = this.synthesizeNumberParser(examples);
        break;
      case "predicate":
        result = this.synthesizePredicate(examples);
        break;
      case "extract":
        result = this.synthesizeExtractor(examples, expectedType);
        break;
      case "classify":
        result = this.synthesizeClassifier(examples);
        break;
      default:
        // Try generic synthesis via coordinator
        result = this.synthesizeGeneric(examples, expectedType);
    }

    // Cache successful synthesis
    if (result.success && result.fn) {
      this.fnCache.set(cacheKey, result.fn);
      if (result.code) {
        this.codeCache.set(cacheKey, result.code);
      }
      result.cacheKey = cacheKey;
    }

    return result;
  }

  /**
   * Get cached function by key
   */
  getCached(key: string): ((input: string) => unknown) | null {
    // Try exact match first
    if (this.fnCache.has(key)) {
      return this.fnCache.get(key)!;
    }

    // Try partial match
    for (const [cacheKey, fn] of this.fnCache.entries()) {
      if (cacheKey.startsWith(key) || key.startsWith(cacheKey.split(":")[0])) {
        return fn;
      }
    }

    return null;
  }

  /**
   * Store function in cache
   */
  cacheFunction(key: string, fn: (input: string) => unknown): void {
    this.fnCache.set(key, fn);
  }

  /**
   * Generate cache key from operation and examples
   */
  private generateCacheKey(
    operation: string,
    examples: Array<{ input: string; output: unknown }>
  ): string {
    // For predicates, always use hash since the pattern depends on both
    // inputs AND outputs (true vs false examples)
    if (operation === "predicate") {
      const hash = this.hashExamples(examples);
      return `${operation}:${hash}`;
    }

    // Extract common pattern from inputs
    const inputs = examples.map((e) => e.input);
    const commonPrefix = this.findCommonPrefix(inputs);
    const currencySymbol = this.detectCurrencySymbol(inputs);

    if (currencySymbol) {
      return `${operation}:${currencySymbol}`;
    }

    if (commonPrefix) {
      return `${operation}:${commonPrefix}`;
    }

    // Fallback to hash of examples
    const hash = this.hashExamples(examples);
    return `${operation}:${hash}`;
  }

  /**
   * Synthesize currency parser from examples
   */
  private synthesizeCurrencyParser(
    examples: Array<{ input: string; output: unknown }>
  ): SynthesisOutcome {
    // Analyze examples to determine format
    const inputs = examples.map((e) => e.input);
    const outputs = examples.map((e) => e.output as number);

    // Detect currency format
    const hasEuroSymbol = inputs.some((i) => i.includes("€"));
    const hasYenSymbol = inputs.some((i) => i.includes("¥"));
    const hasDollarSymbol = inputs.some((i) => i.includes("$"));
    const hasEuFormat = inputs.some((i) => /\d\.\d{3},\d{2}/.test(i)); // 1.234,56

    let code: string;
    let fn: (input: string) => number;

    // Detect apostrophe format (Swiss: 1'234.50)
    const hasApostrophe = inputs.some((i) => i.includes("'"));

    if (hasApostrophe) {
      // Swiss format: 1'234.50
      code = `(s) => {
        const cleaned = s.replace(/[^0-9.]/g, '');
        return parseFloat(cleaned);
      }`;
      fn = (s: string) => {
        const cleaned = s.replace(/[^0-9.]/g, "");
        return parseFloat(cleaned);
      };
    } else if (hasEuFormat || (hasEuroSymbol && inputs.some((i) => i.includes(",")))) {
      // EU format: 1.234,56€
      code = `(s) => {
        const cleaned = s.replace(/[€$¥£\\s]/g, '').replace(/\\./g, '').replace(',', '.');
        return parseFloat(cleaned);
      }`;
      fn = (s: string) => {
        const cleaned = s
          .replace(/[€$¥£\s]/g, "")
          .replace(/\./g, "")
          .replace(",", ".");
        return parseFloat(cleaned);
      };
    } else if (hasYenSymbol) {
      // Yen format: ¥123,456 (no decimals typically)
      code = `(s) => {
        const cleaned = s.replace(/[¥,\\s]/g, '');
        return parseInt(cleaned, 10);
      }`;
      fn = (s: string) => {
        const cleaned = s.replace(/[¥,\s]/g, "");
        return parseInt(cleaned, 10);
      };
    } else {
      // US/Default format: $1,234.56
      code = `(s) => {
        const cleaned = s.replace(/[$€¥£,\\s]/g, '');
        return parseFloat(cleaned);
      }`;
      fn = (s: string) => {
        const cleaned = s.replace(/[$€¥£,\s]/g, "");
        return parseFloat(cleaned);
      };
    }

    // Verify against examples
    const allMatch = examples.every((e) => {
      const result = fn(e.input);
      const expected = e.output as number;
      return Math.abs(result - expected) < 0.01;
    });

    if (!allMatch) {
      // Try miniKanren synthesis
      return this.synthesizeViaRelational(examples);
    }

    return {
      success: true,
      fn,
      code,
    };
  }

  /**
   * Synthesize date parser from examples
   */
  private synthesizeDateParser(
    examples: Array<{ input: string; output: unknown }>
  ): SynthesisOutcome {
    const inputs = examples.map((e) => e.input);
    const outputs = examples.map((e) => e.output as string);

    // Detect format patterns
    const hasMonthName = inputs.some((i) =>
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(i)
    );
    const hasSlash = inputs.some((i) => i.includes("/"));
    const hasDash = inputs.some((i) => i.includes("-"));

    let code: string;
    let fn: (input: string) => string;

    if (hasMonthName) {
      // DD-Mon-YYYY format
      code = `(s) => {
        const monthMap = ${JSON.stringify(MONTH_NAMES)};
        const match = s.match(/(\\d{1,2})[-\\s]?(\\w{3,})[-\\s]?(\\d{4})/i);
        if (!match) return null;
        const [_, day, month, year] = match;
        const monthNum = monthMap[month.toLowerCase()] || '01';
        return \`\${year}-\${monthNum}-\${day.padStart(2, '0')}\`;
      }`;
      fn = (s: string) => {
        const match = s.match(/(\d{1,2})[-\s]?(\w{3,})[-\s]?(\d{4})/i);
        if (!match) return "";
        const [_, day, month, year] = match;
        const monthNum = MONTH_NAMES[month.toLowerCase()] || "01";
        return `${year}-${monthNum}-${day.padStart(2, "0")}`;
      };
    } else if (hasSlash) {
      // DD/MM/YYYY or DD/MM/YY format
      const hasShortYear = inputs.some((i) => /\d{1,2}\/\d{1,2}\/\d{2}(?!\d)/.test(i));
      if (hasShortYear) {
        // Short year format: DD/MM/YY
        code = `(s) => {
          const match = s.match(/(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2})(?!\\d)/);
          if (!match) return null;
          const [_, day, month, shortYear] = match;
          const year = parseInt(shortYear, 10) > 50 ? '19' + shortYear : '20' + shortYear;
          return \`\${year}-\${month.padStart(2, '0')}-\${day.padStart(2, '0')}\`;
        }`;
        fn = (s: string) => {
          const match = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})(?!\d)/);
          if (!match) return "";
          const [_, day, month, shortYear] = match;
          const year = parseInt(shortYear, 10) > 50 ? "19" + shortYear : "20" + shortYear;
          return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
        };
      } else {
        // Full year format: DD/MM/YYYY
        code = `(s) => {
          const match = s.match(/(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
          if (!match) return null;
          const [_, day, month, year] = match;
          return \`\${year}-\${month.padStart(2, '0')}-\${day.padStart(2, '0')}\`;
        }`;
        fn = (s: string) => {
          const match = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (!match) return "";
          const [_, day, month, year] = match;
          return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
        };
      }
    } else {
      // Generic - try to parse
      code = `(s) => {
        const d = new Date(s);
        if (isNaN(d.getTime())) return null;
        return d.toISOString().split('T')[0];
      }`;
      fn = (s: string) => {
        const d = new Date(s);
        if (isNaN(d.getTime())) return "";
        return d.toISOString().split("T")[0];
      };
    }

    // Verify against examples
    const allMatch = examples.every((e) => fn(e.input) === e.output);

    if (!allMatch) {
      return this.synthesizeViaRelational(examples);
    }

    return {
      success: true,
      fn,
      code,
    };
  }

  /**
   * Synthesize number parser from examples
   */
  private synthesizeNumberParser(
    examples: Array<{ input: string; output: unknown }>
  ): SynthesisOutcome {
    const inputs = examples.map((e) => e.input);

    // Detect if percentage
    const hasPercent = inputs.some((i) => i.includes("%"));
    // Detect thousands separator
    const hasCommas = inputs.some((i) => /\d,\d{3}/.test(i));

    let code: string;
    let fn: (input: string) => number;

    if (hasPercent) {
      code = `(s) => {
        const match = s.match(/([\\d.]+)%/);
        return match ? parseFloat(match[1]) : null;
      }`;
      fn = (s: string) => {
        const match = s.match(/([\d.]+)%/);
        return match ? parseFloat(match[1]) : NaN;
      };
    } else if (hasCommas) {
      code = `(s) => {
        const match = s.match(/([\\d,]+)/);
        return match ? parseInt(match[1].replace(/,/g, ''), 10) : null;
      }`;
      fn = (s: string) => {
        const match = s.match(/([\d,]+)/);
        return match ? parseInt(match[1].replace(/,/g, ""), 10) : NaN;
      };
    } else {
      code = `(s) => {
        const match = s.match(/([\\d.]+)/);
        return match ? parseFloat(match[1]) : null;
      }`;
      fn = (s: string) => {
        const match = s.match(/([\d.]+)/);
        return match ? parseFloat(match[1]) : NaN;
      };
    }

    // Verify against examples
    const allMatch = examples.every((e) => {
      const result = fn(e.input);
      const expected = e.output as number;
      return Math.abs(result - expected) < 0.01;
    });

    if (!allMatch) {
      return this.synthesizeViaRelational(examples);
    }

    return {
      success: true,
      fn,
      code,
    };
  }

  /**
   * Synthesize predicate (boolean function) from examples
   */
  private synthesizePredicate(
    examples: Array<{ input: string; output: unknown }>
  ): SynthesisOutcome {
    const trueExamples = examples
      .filter((e) => e.output === true)
      .map((e) => e.input);
    const falseExamples = examples
      .filter((e) => e.output === false)
      .map((e) => e.input);

    if (trueExamples.length === 0 || falseExamples.length === 0) {
      return {
        success: false,
        error: "Need both true and false examples for predicate synthesis",
      };
    }

    // Find distinguishing pattern
    const pattern = this.findDistinguishingPattern(trueExamples, falseExamples);

    if (!pattern) {
      return {
        success: false,
        error: "Could not find distinguishing pattern",
      };
    }

    // Validate the pattern is a valid regex
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      // Pattern is not valid regex, try sophisticated synthesis
      return this.synthesizePredicateViaRegex(trueExamples, falseExamples);
    }

    const code = `(s) => /${pattern}/.test(s)`;
    const fn = (s: string) => regex.test(s);

    // Verify
    const allMatch = examples.every(
      (e) => fn(e.input) === e.output
    );

    if (!allMatch) {
      // Try more sophisticated synthesis
      return this.synthesizePredicateViaRegex(trueExamples, falseExamples);
    }

    return {
      success: true,
      fn,
      code,
    };
  }

  /**
   * Synthesize string extractor from examples
   */
  private synthesizeExtractor(
    examples: Array<{ input: string; output: unknown }>,
    expectedType?: string
  ): SynthesisOutcome {
    // Try coordinator-based synthesis first
    const coordResult = this.coordinator.synthesize({
      type: "extractor",
      description: "synthesized extractor",
      positiveExamples: examples.map((e) => e.input),
      expectedOutputs: examples.map((e) => e.output),
    });

    if (coordResult.success && coordResult.extractor) {
      return {
        success: true,
        fn: coordResult.extractor.test,
        code: coordResult.extractorCode,
      };
    }

    // Fallback to miniKanren
    return this.synthesizeViaRelational(examples);
  }

  /**
   * Synthesize classifier from examples
   */
  private synthesizeClassifier(
    examples: Array<{ input: string; output: unknown }>
  ): SynthesisOutcome {
    // Group examples by output
    const outputGroups = new Map<unknown, string[]>();
    for (const ex of examples) {
      const group = outputGroups.get(ex.output) || [];
      group.push(ex.input);
      outputGroups.set(ex.output, group);
    }

    // Build classifier rules
    const rules: Array<{ pattern: string; output: unknown }> = [];

    for (const [output, inputs] of outputGroups.entries()) {
      const pattern = this.findCommonPattern(inputs);
      if (pattern) {
        rules.push({ pattern, output });
      }
    }

    if (rules.length === 0) {
      return {
        success: false,
        error: "Could not synthesize classifier rules",
      };
    }

    const code = `(s) => {
      const rules = ${JSON.stringify(rules)};
      for (const rule of rules) {
        try {
          if (new RegExp(rule.pattern).test(s)) {
            return rule.output;
          }
        } catch { /* skip invalid pattern */ }
      }
      return null;
    }`;

    const fn = (s: string) => {
      for (const rule of rules) {
        try {
          if (new RegExp(rule.pattern).test(s)) {
            return rule.output;
          }
        } catch { /* skip invalid pattern */ }
      }
      return null;
    };

    return {
      success: true,
      fn,
      code,
    };
  }

  /**
   * Generic synthesis via coordinator
   */
  private synthesizeGeneric(
    examples: Array<{ input: string; output: unknown }>,
    expectedType?: string
  ): SynthesisOutcome {
    // Determine output type
    const outputs = examples.map((e) => e.output);
    const outputType =
      expectedType || (typeof outputs[0] === "number" ? "number" : "string");

    if (outputType === "number") {
      const coordResult = this.coordinator.synthesize({
        type: "extractor",
        description: "generic number extractor",
        positiveExamples: examples.map((e) => e.input),
        expectedOutputs: outputs,
      });

      if (coordResult.success && coordResult.extractor) {
        return {
          success: true,
          fn: coordResult.extractor.test,
          code: coordResult.extractorCode,
        };
      }
    }

    // Try miniKanren as last resort
    return this.synthesizeViaRelational(examples);
  }

  /**
   * Use miniKanren relational synthesis
   */
  private synthesizeViaRelational(
    examples: Array<{ input: string; output: unknown }>
  ): SynthesisOutcome {
    try {
      const relationalExamples: Example[] = examples.map((e) => ({
        input: e.input,
        output: e.output,
      }));

      const programs = synthesizeProgram(relationalExamples, 3);

      for (const program of programs) {
        if (testProgram(program, relationalExamples)) {
          const code = `(input) => ${exprToCode(program)}`;
          try {
            const fn = new Function("input", `return ${exprToCode(program)}`) as (
              input: string
            ) => unknown;

            return {
              success: true,
              fn,
              code,
            };
          } catch {
            continue;
          }
        }
      }
    } catch {
      // Relational synthesis failed
    }

    return {
      success: false,
      error: "Could not synthesize via miniKanren",
    };
  }

  /**
   * Find distinguishing pattern between true and false examples
   * Supports OR patterns for cases where true examples have different markers
   */
  private findDistinguishingPattern(
    trueExamples: string[],
    falseExamples: string[]
  ): string | null {
    // Strategy 0: Check for exact string matches (e.g., "valid" vs "invalid")
    // Use word boundary or exact match patterns
    // Only use exact match for simple strings without structure
    const isSimpleString = (s: string) =>
      !/[\[\]:{}]/.test(s) && s.split(/\s+/).length <= 2;

    for (const trueEx of trueExamples) {
      const exactPattern = `^${this.escapeRegex(trueEx)}$`;
      const exactRegex = new RegExp(exactPattern);
      if (
        trueExamples.every((t) => exactRegex.test(t) || t === trueEx) &&
        !falseExamples.some((f) => exactRegex.test(f))
      ) {
        // For simple cases like "valid" vs "invalid", use exact match
        // Skip structured strings (with brackets, colons, etc.) - let other strategies find better patterns
        if (trueExamples.length === 1 && isSimpleString(trueEx)) {
          return exactPattern;
        }
      }
    }

    // Strategy 1: Find a single pattern common to ALL true examples
    // Try bracket patterns FIRST (prefer structural markers over content words)
    const firstBrackets = trueExamples[0]?.match(/\[\w+\]/g) || [];
    for (const bracket of firstBrackets) {
      if (
        trueExamples.every((t) => t.includes(bracket)) &&
        !falseExamples.some((f) => f.includes(bracket))
      ) {
        // Found a distinguishing bracket pattern - use it immediately
        return bracket.replace(/[[\]]/g, "\\$&");
      }
    }

    // Then try keyword patterns common to ALL true examples
    const commonCandidates: string[] = [];
    const firstTrueWords = trueExamples[0]?.match(/\b\w+\b/g) || [];
    for (const word of firstTrueWords) {
      if (
        trueExamples.every((t) => t.includes(word)) &&
        !falseExamples.some((f) => f.includes(word))
      ) {
        commonCandidates.push(word);
      }
    }

    if (commonCandidates.length > 0) {
      // Sort by length (prefer longer, more specific patterns)
      return commonCandidates.sort((a, b) => b.length - a.length)[0];
    }

    // Strategy 2: Find OR pattern - individual patterns for each true example
    // that don't match any false examples
    const individualPatterns: string[] = [];

    for (const trueEx of trueExamples) {
      // Try bracket patterns [WORD]
      const brackets = trueEx.match(/\[\w+\]/g) || [];
      for (const bracket of brackets) {
        if (!falseExamples.some((f) => f.includes(bracket))) {
          const escaped = bracket.replace(/[[\]]/g, "\\$&");
          if (!individualPatterns.includes(escaped)) {
            individualPatterns.push(escaped);
          }
        }
      }

      // Try prefix patterns like "ERROR:" or "WARN:"
      const prefixMatch = trueEx.match(/^(\w+):/);
      if (prefixMatch) {
        const prefix = prefixMatch[1];
        if (!falseExamples.some((f) => f.startsWith(prefix + ":"))) {
          if (!individualPatterns.includes(prefix)) {
            individualPatterns.push(prefix);
          }
        }
      }

      // Try keywords that are unique to this true example
      const words = trueEx.match(/\b[A-Z]+\b/g) || [];
      for (const word of words) {
        if (!falseExamples.some((f) => f.includes(word))) {
          if (!individualPatterns.includes(word)) {
            individualPatterns.push(word);
          }
        }
      }
    }

    // Verify that the OR pattern covers all true examples
    if (individualPatterns.length > 0) {
      const orPattern = individualPatterns.join("|");
      try {
        const regex = new RegExp(orPattern);
        const allTrueMatch = trueExamples.every((t) => regex.test(t));
        const noFalseMatch = !falseExamples.some((f) => regex.test(f));

        if (allTrueMatch && noFalseMatch) {
          return orPattern;
        }
      } catch {
        // Invalid regex pattern, continue to next strategy
      }
    }

    // Strategy 3: Try finding common prefix pattern in true examples
    const truePattern = this.findCommonPattern(trueExamples);
    if (truePattern) {
      try {
        const trueRegex = new RegExp(truePattern);
        if (!falseExamples.some((f) => trueRegex.test(f))) {
          return truePattern;
        }
      } catch {
        // Invalid regex pattern, fall through to return null
      }
    }

    return null;
  }

  /**
   * Synthesize predicate using regex synthesis
   */
  private synthesizePredicateViaRegex(
    trueExamples: string[],
    falseExamples: string[]
  ): SynthesisOutcome {
    const coordResult = this.coordinator.synthesize({
      type: "regex",
      description: "predicate pattern",
      positiveExamples: trueExamples,
      negativeExamples: falseExamples,
    });

    if (coordResult.success && coordResult.regex) {
      const pattern = coordResult.regex;
      try {
        const regex = new RegExp(pattern);
        const code = `(s) => /${pattern}/.test(s)`;
        const fn = (s: string) => regex.test(s);

        return {
          success: true,
          fn,
          code,
        };
      } catch {
        // Invalid regex from coordinator
      }
    }

    return {
      success: false,
      error: "Could not synthesize predicate pattern",
    };
  }

  /**
   * Find common pattern in strings
   */
  private findCommonPattern(strings: string[]): string | null {
    if (strings.length === 0) return null;
    if (strings.length === 1) return this.escapeRegex(strings[0]);

    // Try to find common structure
    const commonPrefix = this.findCommonPrefix(strings);
    if (commonPrefix && commonPrefix.length > 2) {
      return this.escapeRegex(commonPrefix);
    }

    // Look for common substrings
    const first = strings[0];
    for (let len = Math.min(10, first.length); len >= 3; len--) {
      for (let i = 0; i <= first.length - len; i++) {
        const substr = first.substring(i, i + len);
        if (strings.every((s) => s.includes(substr))) {
          return this.escapeRegex(substr);
        }
      }
    }

    return null;
  }

  /**
   * Find common prefix of strings
   */
  private findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return "";
    if (strings.length === 1) return strings[0];

    let prefix = "";
    const first = strings[0];

    for (let i = 0; i < first.length; i++) {
      const char = first[i];
      if (strings.every((s) => s[i] === char)) {
        prefix += char;
      } else {
        break;
      }
    }

    return prefix;
  }

  /**
   * Detect currency symbol from inputs
   */
  private detectCurrencySymbol(inputs: string[]): string | null {
    const symbols = ["$", "€", "¥", "£"];
    for (const symbol of symbols) {
      if (inputs.every((i) => i.includes(symbol))) {
        return symbol;
      }
    }
    return null;
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Simple hash of examples for cache key
   */
  private hashExamples(
    examples: Array<{ input: string; output: unknown }>
  ): string {
    const str = examples.map((e) => `${e.input}:${e.output}`).join("|");
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).substring(0, 8);
  }
}
