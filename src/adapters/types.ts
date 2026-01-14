/**
 * Model Adapter Types
 *
 * Adapters encapsulate model-specific prompting and response parsing logic.
 * Each model family may have different preferences for prompt format,
 * code block syntax, and answer markers.
 */

/**
 * Marker for returning a variable by name (e.g., FINAL_VAR(memory))
 */
export interface FinalVarMarker {
  type: "var";
  name: string;
}

/**
 * RAG hints to inject into prompts for few-shot learning
 */
export interface RAGHints {
  /** Formatted hints string to inject into system prompt */
  hintsText: string;
  /** Self-correction feedback from recent failures */
  selfCorrectionText?: string;
}

/**
 * Model adapter interface - defines how to interact with a specific model
 */
export interface ModelAdapter {
  /** Adapter name (e.g., "qwen", "deepseek", "base") */
  name: string;

  /**
   * Build the system prompt for this model
   * @param contextLength - Length of the document in characters
   * @param toolInterfaces - TypeScript interface definitions for available tools
   * @param hints - Optional RAG hints for few-shot learning
   */
  buildSystemPrompt(contextLength: number, toolInterfaces: string, hints?: RAGHints): string;

  /**
   * Extract code from model response
   * @param response - Raw model response
   * @returns Extracted code or null if no code found
   */
  extractCode(response: string): string | null;

  /**
   * Extract final answer from model response
   * @param response - Raw model response
   * @returns Final answer string, FinalVarMarker, or null if no answer found
   */
  extractFinalAnswer(response: string | undefined | null): string | FinalVarMarker | null;

  /**
   * Get feedback message when model provides no code block
   */
  getNoCodeFeedback(): string;

  /**
   * Get feedback message when code execution fails
   * @param error - Error message from execution
   */
  getErrorFeedback(error: string): string;

  /**
   * Get feedback message after successful code execution
   * Used to remind model about language requirements between turns
   * @param resultCount - Optional count of results from execution (helps tailor feedback)
   * @param previousCount - Optional count of results before this operation
   */
  getSuccessFeedback(resultCount?: number, previousCount?: number): string;

  /**
   * Get feedback message when model repeats the same code
   * Encourages trying a different approach
   * @param resultCount - Optional count of results from last execution (helps tailor feedback)
   */
  getRepeatedCodeFeedback(resultCount?: number): string;
}

/**
 * Factory function type for creating adapters
 */
export type AdapterFactory = () => ModelAdapter;
