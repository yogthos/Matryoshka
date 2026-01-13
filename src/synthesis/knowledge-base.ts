/**
 * Knowledge Base for synthesized components
 * Stores and retrieves components for compositional reuse
 */

import { RegexNode } from "./regex/synthesis.js";

/**
 * A synthesized component that can be reused
 */
export interface SynthesizedComponent {
  id: string;
  type: "regex" | "extractor" | "transformer";
  name: string;
  description: string;

  // The synthesized artifact
  pattern?: string; // For regex
  code?: string; // For extractors/transformers
  ast?: RegexNode; // AST representation

  // Provenance - what examples it was synthesized from
  positiveExamples: string[];
  negativeExamples: string[];

  // Usage statistics for prioritization
  usageCount: number;
  successCount: number;
  lastUsed: Date;

  // Composability - what this component can be composed with
  composableWith: string[]; // IDs of compatible components
  derivedFrom?: string[]; // IDs of parent components
}

/**
 * Knowledge Base - stores and retrieves synthesized components
 */
export class KnowledgeBase {
  private components: Map<string, SynthesizedComponent> = new Map();
  private typeIndex: Map<string, Set<string>> = new Map();
  private patternIndex: Map<string, Set<string>> = new Map();

  /**
   * Add a synthesized component to the knowledge base
   */
  add(component: SynthesizedComponent): void {
    this.components.set(component.id, component);

    // Index by type
    if (!this.typeIndex.has(component.type)) {
      this.typeIndex.set(component.type, new Set());
    }
    this.typeIndex.get(component.type)!.add(component.id);

    // Index by pattern signature (for similarity matching)
    const signature = this.computeSignature(component);
    if (!this.patternIndex.has(signature)) {
      this.patternIndex.set(signature, new Set());
    }
    this.patternIndex.get(signature)!.add(component.id);
  }

  /**
   * Get a component by id
   */
  get(id: string): SynthesizedComponent | null {
    return this.components.get(id) || null;
  }

  /**
   * Get all components of a specific type
   */
  getByType(type: SynthesizedComponent["type"]): SynthesizedComponent[] {
    const ids = this.typeIndex.get(type);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.components.get(id)!)
      .filter(Boolean);
  }

  /**
   * Find components similar to given examples
   * Returns components ordered by similarity and success rate
   */
  findSimilar(
    examples: string[],
    type?: SynthesizedComponent["type"]
  ): SynthesizedComponent[] {
    const candidates: Array<{
      component: SynthesizedComponent;
      score: number;
    }> = [];

    for (const [, component] of this.components) {
      if (type && component.type !== type) continue;

      const score = this.computeSimilarity(examples, component);
      if (score > 0) {
        candidates.push({ component, score });
      }
    }

    // Sort by: similarity * success_rate
    return candidates
      .sort((a, b) => {
        const aSuccessRate =
          a.component.successCount / Math.max(1, a.component.usageCount);
        const bSuccessRate =
          b.component.successCount / Math.max(1, b.component.usageCount);
        const aWeight = a.score * aSuccessRate;
        const bWeight = b.score * bSuccessRate;
        return bWeight - aWeight;
      })
      .map((c) => c.component);
  }

  /**
   * Find components that can be composed to solve a new problem
   * Key Barliman insight: existing solutions inform new ones
   */
  findComposable(targetExamples: string[]): SynthesizedComponent[][] {
    // Find components whose patterns partially match
    const partialMatches: SynthesizedComponent[] = [];

    for (const [, component] of this.components) {
      if (component.pattern) {
        try {
          const regex = new RegExp(component.pattern);
          const matchCount = targetExamples.filter((e) => regex.test(e)).length;
          // Partial match: matches some but not all
          if (matchCount > 0 && matchCount < targetExamples.length) {
            partialMatches.push(component);
          }
        } catch {
          // Invalid regex, skip
        }
      }
    }

    // Try to find compositions that cover all examples
    return this.findCoveringCompositions(partialMatches, targetExamples);
  }

  /**
   * Record usage of a component (for prioritization)
   */
  recordUsage(id: string, success: boolean): void {
    const component = this.components.get(id);
    if (component) {
      component.usageCount++;
      if (success) component.successCount++;
      component.lastUsed = new Date();
    }
  }

  /**
   * Get components derived from a parent (for composition chains)
   */
  getDerived(parentId: string): SynthesizedComponent[] {
    return Array.from(this.components.values()).filter((c) =>
      c.derivedFrom?.includes(parentId)
    );
  }

  /**
   * Create a derived component (composition)
   */
  derive(
    parents: SynthesizedComponent[],
    newComponent: Omit<SynthesizedComponent, "derivedFrom" | "composableWith">
  ): SynthesizedComponent {
    const derived: SynthesizedComponent = {
      ...newComponent,
      derivedFrom: parents.map((p) => p.id),
      composableWith: [],
    };

    // Mark parents as composable with the derived component
    for (const parent of parents) {
      const stored = this.components.get(parent.id);
      if (stored) {
        stored.composableWith.push(derived.id);
      }
    }

    this.add(derived);
    return derived;
  }

  /**
   * Export knowledge base for persistence
   */
  export(): SynthesizedComponent[] {
    return Array.from(this.components.values());
  }

  /**
   * Import knowledge base from persistence
   */
  import(components: SynthesizedComponent[]): void {
    for (const component of components) {
      this.add(component);
    }
  }

  /**
   * Clear all components
   */
  clear(): void {
    this.components.clear();
    this.typeIndex.clear();
    this.patternIndex.clear();
  }

  /**
   * Get the number of components
   */
  size(): number {
    return this.components.size;
  }

  /**
   * Compute a signature for a component based on example structure
   */
  private computeSignature(component: SynthesizedComponent): string {
    const examples = component.positiveExamples;
    if (examples.length === 0) return "empty";

    // Signature includes: has digits, has alpha, has currency, has date-like, length range
    const hasDigit = examples.some((e) => /\d/.test(e));
    const hasAlpha = examples.some((e) => /[a-zA-Z]/.test(e));
    const hasCurrency = examples.some((e) => /[$€£¥]/.test(e));
    const hasDateLike = examples.some((e) =>
      /\d{2,4}[-/]\d{2}[-/]\d{2,4}/.test(e)
    );
    const lengths = examples.map((e) => e.length);
    const lengthBucket = Math.floor(Math.max(...lengths) / 10);

    return `${hasDigit ? "d" : ""}${hasAlpha ? "a" : ""}${hasCurrency ? "$" : ""}${hasDateLike ? "D" : ""}_${lengthBucket}`;
  }

  /**
   * Compute similarity between examples and a component
   */
  private computeSimilarity(
    examples: string[],
    component: SynthesizedComponent
  ): number {
    if (component.positiveExamples.length === 0 || examples.length === 0) {
      return 0;
    }

    // Jaccard-like similarity based on character patterns
    const exampleChars = new Set(examples.join("").split(""));
    const componentChars = new Set(
      component.positiveExamples.join("").split("")
    );

    const intersection = new Set(
      [...exampleChars].filter((c) => componentChars.has(c))
    );
    const union = new Set([...exampleChars, ...componentChars]);

    return intersection.size / union.size;
  }

  /**
   * Find component combinations that cover all examples
   */
  private findCoveringCompositions(
    components: SynthesizedComponent[],
    examples: string[]
  ): SynthesizedComponent[][] {
    const compositions: SynthesizedComponent[][] = [];

    // Try pairs
    for (let i = 0; i < components.length; i++) {
      for (let j = i + 1; j < components.length; j++) {
        const combined = [components[i], components[j]];
        if (this.coversAll(combined, examples)) {
          compositions.push(combined);
        }
      }
    }

    return compositions;
  }

  /**
   * Check if components together cover all examples
   */
  private coversAll(
    components: SynthesizedComponent[],
    examples: string[]
  ): boolean {
    for (const example of examples) {
      const covered = components.some((c) => {
        if (c.pattern) {
          try {
            return new RegExp(c.pattern).test(example);
          } catch {
            return false;
          }
        }
        return false;
      });
      if (!covered) return false;
    }
    return true;
  }
}
