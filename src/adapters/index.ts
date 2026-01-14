/**
 * Model Adapter Registry
 *
 * Central registry for model adapters. Supports:
 * - Explicit adapter selection via config/CLI
 * - Auto-detection based on model name patterns
 */

import type { ModelAdapter, AdapterFactory } from "./types.js";
import { createBaseAdapter } from "./base.js";
import { createQwenAdapter } from "./qwen.js";
import { createDeepSeekAdapter } from "./deepseek.js";
import { createQwenSynthesisAdapter } from "./qwen-synthesis.js";
import { createQwenBarlimanAdapter } from "./qwen-barliman.js";
import { createNucleusAdapter } from "./nucleus.js";

// Re-export types
export type { ModelAdapter, FinalVarMarker, AdapterFactory } from "./types.js";

/**
 * Registry of adapter factories keyed by adapter name
 */
const adapterFactories: Record<string, AdapterFactory> = {
  base: createBaseAdapter,
  qwen: createQwenAdapter,
  deepseek: createDeepSeekAdapter,
  "qwen-synthesis": createQwenSynthesisAdapter,
  "qwen-barliman": createQwenBarlimanAdapter,
  nucleus: createNucleusAdapter,
};

/**
 * Model name patterns for auto-detection
 * Order matters - first match wins
 *
 * IMPORTANT: All models now use the Nucleus adapter by default.
 * Nucleus uses Lambda Calculus terms instead of JavaScript,
 * which reduces token entropy and allows formal verification.
 */
const modelPatterns: Array<{ pattern: RegExp; adapter: string }> = [
  // All models default to nucleus - LC-based synthesis
  { pattern: /.*/, adapter: "nucleus" },
];

/**
 * Register a new adapter factory
 * @param name - Adapter name (e.g., "qwen", "llama")
 * @param factory - Factory function that creates the adapter
 */
export function registerAdapter(name: string, factory: AdapterFactory): void {
  adapterFactories[name] = factory;
}

/**
 * Get an adapter by name
 * @param name - Adapter name
 * @returns The adapter instance or undefined if not found
 */
export function getAdapter(name: string): ModelAdapter | undefined {
  const factory = adapterFactories[name];
  return factory ? factory() : undefined;
}

/**
 * Get list of available adapter names
 */
export function getAvailableAdapters(): string[] {
  return Object.keys(adapterFactories);
}

/**
 * Detect adapter from model name
 * @param modelName - Model name (e.g., "qwen2.5-coder:7b")
 * @returns Detected adapter name or "base" as fallback
 */
export function detectAdapter(modelName: string): string {
  for (const { pattern, adapter } of modelPatterns) {
    if (pattern.test(modelName)) {
      return adapter;
    }
  }
  return "base";
}

/**
 * Resolve and create an adapter
 * @param modelName - Model name for auto-detection
 * @param explicitAdapter - Explicit adapter name (overrides auto-detection)
 * @returns The resolved adapter instance
 */
export function resolveAdapter(
  modelName: string,
  explicitAdapter?: string
): ModelAdapter {
  // Use explicit adapter if provided
  const adapterName = explicitAdapter || detectAdapter(modelName);

  // Get the factory
  const factory = adapterFactories[adapterName];
  if (!factory) {
    console.warn(
      `Unknown adapter "${adapterName}", falling back to "base" adapter`
    );
    return createBaseAdapter();
  }

  return factory();
}
