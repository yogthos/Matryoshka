/**
 * Evolutionary Synthesizer
 * Refines partial programs through constraints and reuses knowledge base
 */

import { KnowledgeBase, SynthesizedComponent } from "./knowledge-base.js";
import { synthesizeRegex } from "./regex/synthesis.js";

/**
 * Partial program with holes
 */
export interface PartialProgram {
  template: string; // Template with placeholders like ${0}, ${1}
  holes: string[]; // Hole names
  examples: Array<{ input: string; output: unknown }>;
}

/**
 * Evolutionary Synthesizer - refines partial programs through constraints
 */
export class EvolutionarySynthesizer {
  private idCounter = 0;

  constructor(private knowledgeBase: KnowledgeBase) {}

  /**
   * Start synthesis with initial examples
   * Returns a partial program that can be refined
   */
  initialize(
    examples: Array<{ input: string; output: unknown }>
  ): PartialProgram {
    return {
      template: "(input) => ${0}",
      holes: ["extraction"],
      examples,
    };
  }

  /**
   * Try to solve - find concrete values for all holes
   */
  solve(program: PartialProgram, maxSolutions: number = 5): string[] {
    // First, try to find solution from knowledge base
    const kbSolutions = this.solveFromKnowledgeBase(program);
    if (kbSolutions.length > 0) {
      return kbSolutions.slice(0, maxSolutions);
    }

    // Try to synthesize from examples
    const synthesized = this.synthesizeNew(program);
    if (synthesized) {
      return [synthesized];
    }

    return [];
  }

  /**
   * Use knowledge base to find solutions
   */
  private solveFromKnowledgeBase(program: PartialProgram): string[] {
    const inputs = program.examples.map((e) => e.input);

    // Find similar components
    const similar = this.knowledgeBase.findSimilar(inputs);

    const solutions: string[] = [];
    for (const component of similar.slice(0, 5)) {
      if (component.code) {
        // Test if this component works for our examples
        if (this.validateSolution(component.code, program.examples)) {
          solutions.push(component.code);
          this.knowledgeBase.recordUsage(component.id, true);
        }
      }
    }

    return solutions;
  }

  /**
   * Synthesize new solution and add to knowledge base
   */
  private synthesizeNew(program: PartialProgram): string | null {
    const inputs = program.examples.map((e) => e.input);
    const outputs = program.examples.map((e) => e.output);

    // Try regex-based extraction
    const regexResult = synthesizeRegex({
      positives: inputs,
      negatives: [],
    });

    if (regexResult.success && regexResult.pattern) {
      const code = this.buildExtractorCode(
        regexResult.pattern,
        outputs[0],
        program.examples
      );

      // Validate
      if (code && this.validateSolution(code, program.examples)) {
        // Add to knowledge base for future reuse
        this.knowledgeBase.add({
          id: `synth_${Date.now()}_${this.idCounter++}`,
          type: "extractor",
          name: "auto_synthesized",
          description: `Synthesized from ${inputs.length} examples`,
          code,
          pattern: regexResult.pattern,
          ast: regexResult.ast,
          positiveExamples: inputs,
          negativeExamples: [],
          usageCount: 1,
          successCount: 1,
          lastUsed: new Date(),
          composableWith: [],
        });

        return code;
      }
    }

    // Try template-based approaches for common patterns
    const templateCode = this.tryTemplateApproaches(program.examples);
    if (templateCode && this.validateSolution(templateCode, program.examples)) {
      this.knowledgeBase.add({
        id: `synth_${Date.now()}_${this.idCounter++}`,
        type: "extractor",
        name: "template_synthesized",
        description: `Template synthesized from ${inputs.length} examples`,
        code: templateCode,
        positiveExamples: inputs,
        negativeExamples: [],
        usageCount: 1,
        successCount: 1,
        lastUsed: new Date(),
        composableWith: [],
      });

      return templateCode;
    }

    return null;
  }

  /**
   * Build extractor code from regex pattern
   */
  private buildExtractorCode(
    pattern: string,
    sampleOutput: unknown,
    examples: Array<{ input: string; output: unknown }>
  ): string | null {
    // Try different extraction strategies
    const strategies: string[] = [];

    if (typeof sampleOutput === "number") {
      // For numbers, try various parsing approaches
      strategies.push(
        `(s) => {
        const m = s.match(/${this.escapeRegexInString(pattern)}/);
        if (!m) return null;
        return parseFloat((m[1] || m[0]).replace(/[,$]/g, ''));
      }`
      );

      strategies.push(
        `(s) => {
        const m = s.match(/${this.escapeRegexInString(pattern)}/);
        if (!m) return null;
        return parseInt((m[1] || m[0]).replace(/[,$]/g, ''), 10);
      }`
      );

      // Direct parseInt for simple numbers
      strategies.push(`(s) => parseInt(s.replace(/[^\\d.-]/g, ''), 10)`);

      strategies.push(`(s) => parseFloat(s.replace(/[^\\d.-]/g, ''))`);
    } else if (typeof sampleOutput === "string") {
      strategies.push(
        `(s) => {
        const m = s.match(/${this.escapeRegexInString(pattern)}/);
        return m ? (m[1] || m[0]) : null;
      }`
      );

      // Key-value extraction
      if (examples.some((e) => e.input.includes(":"))) {
        strategies.push(`(s) => {
          const m = s.match(/:\\s*(.+)$/);
          return m ? m[1].trim() : null;
        }`);
      }
    }

    // Try each strategy
    for (const code of strategies) {
      if (this.validateSolution(code, examples)) {
        return code;
      }
    }

    return null;
  }

  /**
   * Try template-based approaches for common patterns
   */
  private tryTemplateApproaches(
    examples: Array<{ input: string; output: unknown }>
  ): string | null {
    const inputs = examples.map((e) => e.input);
    const outputs = examples.map((e) => e.output);

    // Check if all outputs are numbers and inputs are numeric strings
    if (
      outputs.every((o) => typeof o === "number") &&
      inputs.every((i) => /^\d+$/.test(i))
    ) {
      return "(s) => parseInt(s, 10)";
    }

    // Check for currency pattern
    if (
      outputs.every((o) => typeof o === "number") &&
      inputs.every((i) => /^\$[\d,]+$/.test(i))
    ) {
      return '(s) => parseInt(s.replace(/[$,]/g, ""), 10)';
    }

    // Check for key:value pattern
    if (
      outputs.every((o) => typeof o === "string") &&
      inputs.every((i) => i.includes(":"))
    ) {
      return "(s) => { const m = s.match(/:\\s*(.+)$/); return m ? m[1].trim() : null; }";
    }

    return null;
  }

  /**
   * Escape special characters for use inside a regex string in code
   */
  private escapeRegexInString(pattern: string): string {
    return pattern.replace(/\\/g, "\\\\");
  }

  /**
   * Validate a solution against examples
   */
  validateSolution(
    code: string,
    examples: Array<{ input: string; output: unknown }>
  ): boolean {
    try {
      const fn = eval(code);
      return examples.every((e) => {
        const result = fn(e.input);
        return this.deepEqual(result, e.output);
      });
    } catch {
      return false;
    }
  }

  /**
   * Deep equality check
   */
  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a === "number" && typeof b === "number") {
      return Math.abs(a - b) < 0.0001; // Float tolerance
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => this.deepEqual(v, b[i]));
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
        this.deepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k]
        )
      );
    }
    return false;
  }

  /**
   * Compose existing components to create new solution
   * Key Barliman insight: map can help build filter
   */
  compose(components: SynthesizedComponent[]): SynthesizedComponent | null {
    // Look for regex + transformer combination
    const regexComp = components.find((c) => c.type === "regex");
    const transformComp = components.find((c) => c.type === "transformer");

    if (regexComp && transformComp && regexComp.pattern && transformComp.code) {
      // The pattern is stored ready for use with new RegExp(), so we use that approach
      // rather than a regex literal to avoid escaping issues
      const composedCode = `(s) => {
        const m = s.match(new RegExp(${JSON.stringify(regexComp.pattern)}));
        if (!m) return null;
        const extracted = m[1] || m[0];
        const transform = ${transformComp.code};
        return transform(extracted);
      }`;

      return this.knowledgeBase.derive([regexComp, transformComp], {
        id: `composed_${Date.now()}_${this.idCounter++}`,
        type: "extractor",
        name: `${regexComp.name}_${transformComp.name}`,
        description: `Composed from ${regexComp.name} and ${transformComp.name}`,
        code: composedCode,
        positiveExamples: [
          ...regexComp.positiveExamples,
          ...transformComp.positiveExamples,
        ],
        negativeExamples: [],
        usageCount: 0,
        successCount: 0,
        lastUsed: new Date(),
      });
    }

    return null;
  }

  /**
   * Suggest possible compositions for target examples
   */
  suggestCompositions(targetExamples: string[]): SynthesizedComponent[][] {
    return this.knowledgeBase.findComposable(targetExamples);
  }
}
