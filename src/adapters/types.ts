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
 * Model adapter interface - defines how to interact with a specific model
 */
export interface ModelAdapter {
  /** Adapter name (e.g., "qwen", "deepseek", "base") */
  name: string;

  /**
   * Build the system prompt for this model
   * @param contextLength - Length of the document in characters
   * @param toolInterfaces - TypeScript interface definitions for available tools
   */
  buildSystemPrompt(contextLength: number, toolInterfaces: string): string;

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
}

/**
 * Factory function type for creating adapters
 */
export type AdapterFactory = () => ModelAdapter;
