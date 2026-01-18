/**
 * Grammar configuration loader
 *
 * Loads grammar configurations from ~/.matryoshka/config.json
 * and merges with built-in grammars.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SymbolKind } from "../treesitter/types.js";

/**
 * Grammar configuration for a language
 */
export interface GrammarConfig {
  /** npm package name (e.g., "tree-sitter-rust") */
  package: string;
  /** File extensions (e.g., [".rs"]) */
  extensions: string[];
  /** Map of AST node types to symbol kinds */
  symbols: Record<string, SymbolKind>;
  /** Optional: how to extract the grammar from the module */
  moduleExport?: string;
}

/**
 * Full configuration file structure
 */
export interface MatryoshkaConfig {
  /** Custom grammar configurations */
  grammars?: Record<string, GrammarConfig>;
  /** Other config options can be added here */
}

/**
 * Default config directory and file paths
 */
export const CONFIG_DIR = join(homedir(), ".matryoshka");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/**
 * Load configuration from ~/.matryoshka/config.json
 * Returns empty config if file doesn't exist
 */
export function loadConfig(): MatryoshkaConfig {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(content) as MatryoshkaConfig;
  } catch (error) {
    console.warn(`Warning: Failed to parse ${CONFIG_FILE}: ${error}`);
    return {};
  }
}

/**
 * Ensure config directory exists
 */
export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Save configuration to ~/.matryoshka/config.json
 */
export function saveConfig(config: MatryoshkaConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Get custom grammars from config
 */
export function getCustomGrammars(): Record<string, GrammarConfig> {
  const config = loadConfig();
  return config.grammars ?? {};
}

/**
 * Add a custom grammar to config
 */
export function addCustomGrammar(language: string, grammar: GrammarConfig): void {
  const config = loadConfig();
  config.grammars = config.grammars ?? {};
  config.grammars[language] = grammar;
  saveConfig(config);
}

/**
 * Remove a custom grammar from config
 */
export function removeCustomGrammar(language: string): boolean {
  const config = loadConfig();
  if (!config.grammars || !config.grammars[language]) {
    return false;
  }
  delete config.grammars[language];
  saveConfig(config);
  return true;
}

/**
 * Example config for reference
 */
export const EXAMPLE_CONFIG: MatryoshkaConfig = {
  grammars: {
    rust: {
      package: "tree-sitter-rust",
      extensions: [".rs"],
      symbols: {
        function_item: "function",
        impl_item: "method",
        struct_item: "struct",
        enum_item: "enum",
        trait_item: "interface",
        type_item: "type",
        const_item: "constant",
        static_item: "variable",
        mod_item: "module",
      },
    },
  },
};
