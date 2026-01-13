/**
 * Synthesis Coordinator
 * Bridges LLM exploration and miniKanren-based synthesis
 */

import { synthesizeRegex } from "./regex/synthesis.js";
import { synthesizeExtractor, Extractor } from "./extractor/synthesis.js";
import { KnowledgeBase, SynthesizedComponent } from "./knowledge-base.js";
import { EvolutionarySynthesizer } from "./evolutionary.js";

/**
 * Example collected from sandbox execution
 */
export interface CollectedExample {
  source: "grep" | "line" | "match";
  raw: string;
  context?: string;
  lineNum?: number;
}

/**
 * Synthesis request from LLM layer
 */
export interface SynthesisRequest {
  type: "regex" | "extractor" | "format";
  description: string;
  positiveExamples: string[];
  negativeExamples?: string[];
  expectedOutputs?: unknown[];
}

/**
 * Result of synthesis
 */
export interface SynthesisResult {
  success: boolean;
  synthesisTimeMs: number;
  // For regex synthesis
  regex?: string;
  // For extractor synthesis
  extractor?: Extractor;
  extractorCode?: string;
  // For format synthesis
  format?: string;
  // Error info
  error?: string;
}

/**
 * Synthesis Coordinator - manages example collection and synthesis requests
 */
export class SynthesisCoordinator {
  private exampleStore: Map<string, CollectedExample[]> = new Map();
  private knowledgeBase: KnowledgeBase;
  private evolutionarySynthesizer: EvolutionarySynthesizer;
  private synthesisCount: number = 0;

  constructor(knowledgeBase?: KnowledgeBase) {
    this.knowledgeBase = knowledgeBase || new KnowledgeBase();
    this.evolutionarySynthesizer = new EvolutionarySynthesizer(
      this.knowledgeBase
    );
  }

  /**
   * Collect an example from execution
   */
  collectExample(category: string, example: CollectedExample): void {
    const existing = this.exampleStore.get(category) || [];
    existing.push(example);
    this.exampleStore.set(category, existing);
  }

  /**
   * Get collected examples for a category
   */
  getExamples(category: string): CollectedExample[] {
    return this.exampleStore.get(category) || [];
  }

  /**
   * Clear examples for a category
   */
  clearExamples(category: string): void {
    this.exampleStore.delete(category);
  }

  /**
   * Clear all collected examples
   */
  clearAllExamples(): void {
    this.exampleStore.clear();
  }

  /**
   * Get all category names
   */
  getCategories(): string[] {
    return Array.from(this.exampleStore.keys());
  }

  /**
   * Get knowledge base for inspection
   */
  getKnowledgeBase(): KnowledgeBase {
    return this.knowledgeBase;
  }

  /**
   * Get synthesis count
   */
  getSynthesisCount(): number {
    return this.synthesisCount;
  }

  /**
   * Validate a regex pattern
   */
  validateRegex(pattern: string): boolean {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Test a regex against a string (safe)
   */
  testRegex(pattern: string, str: string): boolean {
    try {
      return new RegExp(pattern).test(str);
    } catch {
      return false;
    }
  }

  /**
   * Request synthesis
   */
  synthesize(request: SynthesisRequest): SynthesisResult {
    const startTime = Date.now();
    this.synthesisCount++;

    try {
      switch (request.type) {
        case "regex":
          return this.synthesizeRegexResult(request, startTime);
        case "extractor":
          return this.synthesizeExtractorResult(request, startTime);
        case "format":
          return this.synthesizeFormatResult(request, startTime);
        default:
          return {
            success: false,
            synthesisTimeMs: Date.now() - startTime,
            error: `Unknown synthesis type: ${request.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        synthesisTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Synthesize from collected examples
   */
  synthesizeFromCollected(
    category: string,
    type: "regex" | "extractor"
  ): SynthesisResult {
    const examples = this.getExamples(category);

    if (examples.length === 0) {
      return {
        success: false,
        synthesisTimeMs: 0,
        error: "No examples collected for category",
      };
    }

    const positiveExamples = examples.map((e) => e.raw);

    if (type === "regex") {
      return this.synthesize({
        type: "regex",
        description: `Synthesized from ${category}`,
        positiveExamples,
      });
    } else {
      // For extractor, use context as expected output if available
      const expectedOutputs = examples
        .filter((e) => e.context !== undefined)
        .map((e) => {
          // Try to parse as number
          const num = parseFloat(e.context!);
          return isNaN(num) ? e.context! : num;
        });

      if (expectedOutputs.length === 0) {
        return {
          success: false,
          synthesisTimeMs: 0,
          error: "No expected outputs in collected examples",
        };
      }

      return this.synthesize({
        type: "extractor",
        description: `Synthesized from ${category}`,
        positiveExamples: examples
          .filter((e) => e.context !== undefined)
          .map((e) => e.raw),
        expectedOutputs,
      });
    }
  }

  /**
   * Batch synthesis
   */
  synthesizeBatch(requests: SynthesisRequest[]): SynthesisResult[] {
    return requests.map((r) => this.synthesize(r));
  }

  /**
   * Synthesize regex from request
   */
  private synthesizeRegexResult(
    request: SynthesisRequest,
    startTime: number
  ): SynthesisResult {
    // Check for conflicting examples
    if (request.negativeExamples) {
      const conflicting = request.positiveExamples.some((p) =>
        request.negativeExamples!.includes(p)
      );
      if (conflicting) {
        return {
          success: false,
          synthesisTimeMs: Date.now() - startTime,
          error: "Conflicting positive and negative examples",
        };
      }
    }

    // Try to find similar pattern in knowledge base first
    const similar = this.knowledgeBase.findSimilar(
      request.positiveExamples,
      "regex"
    );

    for (const component of similar.slice(0, 3)) {
      if (component.pattern) {
        try {
          const regex = new RegExp(component.pattern);
          const allMatch = request.positiveExamples.every((p) => regex.test(p));
          const noneMatchNeg = !request.negativeExamples?.some((n) =>
            regex.test(n)
          );

          if (allMatch && noneMatchNeg) {
            this.knowledgeBase.recordUsage(component.id, true);
            return {
              success: true,
              synthesisTimeMs: Date.now() - startTime,
              regex: component.pattern,
            };
          }
        } catch {
          // Invalid regex, skip
        }
      }
    }

    // Synthesize new pattern
    const result = synthesizeRegex({
      positives: request.positiveExamples,
      negatives: request.negativeExamples || [],
    });

    if (result.success && result.pattern) {
      // Add to knowledge base
      this.knowledgeBase.add({
        id: `regex_${Date.now()}_${this.synthesisCount}`,
        type: "regex",
        name: request.description || "synthesized_regex",
        description: request.description,
        pattern: result.pattern,
        ast: result.ast,
        positiveExamples: request.positiveExamples,
        negativeExamples: request.negativeExamples || [],
        usageCount: 1,
        successCount: 1,
        lastUsed: new Date(),
        composableWith: [],
      });

      return {
        success: true,
        synthesisTimeMs: Date.now() - startTime,
        regex: result.pattern,
      };
    }

    return {
      success: false,
      synthesisTimeMs: Date.now() - startTime,
      error: "Could not synthesize regex pattern",
    };
  }

  /**
   * Synthesize extractor from request
   */
  private synthesizeExtractorResult(
    request: SynthesisRequest,
    startTime: number
  ): SynthesisResult {
    if (!request.expectedOutputs || request.expectedOutputs.length === 0) {
      return {
        success: false,
        synthesisTimeMs: Date.now() - startTime,
        error: "Extractor synthesis requires expectedOutputs",
      };
    }

    if (request.positiveExamples.length !== request.expectedOutputs.length) {
      return {
        success: false,
        synthesisTimeMs: Date.now() - startTime,
        error:
          "Mismatched positiveExamples and expectedOutputs lengths",
      };
    }

    // Build examples for extractor synthesis
    const examples = request.positiveExamples.map((input, i) => ({
      input,
      output: request.expectedOutputs![i],
    }));

    // Use evolutionary synthesizer first
    const program = this.evolutionarySynthesizer.initialize(examples);
    const solutions = this.evolutionarySynthesizer.solve(program);

    if (solutions.length > 0) {
      const code = solutions[0];
      try {
        const fn = eval(code);
        return {
          success: true,
          synthesisTimeMs: Date.now() - startTime,
          extractor: {
            name: request.description || "synthesized_extractor",
            description: request.description,
            code,
            test: fn,
          },
          extractorCode: code,
        };
      } catch {
        // Fall through to template-based synthesis
      }
    }

    // Try template-based synthesis
    const extractor = synthesizeExtractor({ examples });

    if (extractor) {
      return {
        success: true,
        synthesisTimeMs: Date.now() - startTime,
        extractor,
        extractorCode: extractor.code,
      };
    }

    return {
      success: false,
      synthesisTimeMs: Date.now() - startTime,
      error: "Could not synthesize extractor",
    };
  }

  /**
   * Synthesize format description from request
   */
  private synthesizeFormatResult(
    request: SynthesisRequest,
    startTime: number
  ): SynthesisResult {
    const examples = request.positiveExamples;

    if (examples.length === 0) {
      return {
        success: false,
        synthesisTimeMs: Date.now() - startTime,
        error: "No examples provided for format synthesis",
      };
    }

    // Try to detect date formats
    const dateFormat = this.detectDateFormat(examples);
    if (dateFormat) {
      return {
        success: true,
        synthesisTimeMs: Date.now() - startTime,
        format: dateFormat,
      };
    }

    // Try to detect numeric formats
    const numericFormat = this.detectNumericFormat(examples);
    if (numericFormat) {
      return {
        success: true,
        synthesisTimeMs: Date.now() - startTime,
        format: numericFormat,
      };
    }

    // Try to detect general format
    const generalFormat = this.detectGeneralFormat(examples);
    if (generalFormat) {
      return {
        success: true,
        synthesisTimeMs: Date.now() - startTime,
        format: generalFormat,
      };
    }

    return {
      success: false,
      synthesisTimeMs: Date.now() - startTime,
      error: "Could not determine format",
    };
  }

  /**
   * Detect date format from examples
   */
  private detectDateFormat(examples: string[]): string | null {
    // ISO date format: YYYY-MM-DD
    if (examples.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e))) {
      return "YYYY-MM-DD (ISO date)";
    }

    // US date format: MM/DD/YYYY
    if (examples.every((e) => /^\d{2}\/\d{2}\/\d{4}$/.test(e))) {
      return "MM/DD/YYYY (US date)";
    }

    // EU date format: DD.MM.YYYY
    if (examples.every((e) => /^\d{2}\.\d{2}\.\d{4}$/.test(e))) {
      return "DD.MM.YYYY (EU date)";
    }

    // ISO datetime: YYYY-MM-DD HH:MM:SS
    if (examples.every((e) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(e))) {
      return "YYYY-MM-DD HH:MM:SS (ISO datetime)";
    }

    return null;
  }

  /**
   * Detect numeric format from examples
   */
  private detectNumericFormat(examples: string[]): string | null {
    // Currency format: $1,234.56
    if (examples.every((e) => /^\$[\d,]+(\.\d{2})?$/.test(e))) {
      return "$(USD) with optional decimals";
    }

    // Percentage: 50%
    if (examples.every((e) => /^\d+(\.\d+)?%$/.test(e))) {
      return "Percentage (N%)";
    }

    // Integer with commas: 1,234,567
    if (examples.every((e) => /^[\d,]+$/.test(e) && e.includes(","))) {
      return "Integer with comma separators";
    }

    return null;
  }

  /**
   * Detect general format from examples
   */
  private detectGeneralFormat(examples: string[]): string | null {
    // Find common structure
    const structures = examples.map((e) => this.getStructure(e));

    if (new Set(structures).size === 1) {
      return structures[0];
    }

    return null;
  }

  /**
   * Get structure pattern of a string
   */
  private getStructure(str: string): string {
    return str
      .replace(/[a-zA-Z]+/g, "TEXT")
      .replace(/\d+/g, "NUM")
      .replace(/\s+/g, " ");
  }
}
