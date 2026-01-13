import { readFile } from "fs/promises";
import { resolve } from "path";

/**
 * Configuration file types
 *
 * Note: These types mirror some types in llm/types.ts but serve different purposes:
 * - These types represent the JSON config file structure (fields may be optional)
 * - llm/types.ts types represent runtime API contracts (required fields for operation)
 */

export interface LLMOptions {
  temperature?: number;
  num_ctx?: number;
  max_tokens?: number;
}

export interface LLMConfig {
  provider: string;
  /** For tiered mode: name of the large/orchestrator provider */
  large?: string;
  /** For tiered mode: name of the small/worker provider */
  small?: string;
  model?: string;
  options?: LLMOptions;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** Adapter name for model-specific prompting (e.g., "qwen", "deepseek"). Auto-detected from model name if not specified. */
  adapter?: string;
  options?: LLMOptions;
}

export interface SandboxConfig {
  maxSubCalls: number;
  turnTimeoutMs: number;
  memoryLimitMb: number;
}

export interface RLMConfig {
  maxTurns: number;
}

export interface Config {
  llm: LLMConfig;
  providers: Record<string, ProviderConfig>;
  sandbox: SandboxConfig;
  rlm: RLMConfig;
}

const DEFAULT_CONFIG: Config = {
  llm: {
    provider: "ollama",
  },
  providers: {
    ollama: {
      baseUrl: "http://localhost:11434",
      model: "qwen3-coder:30b",
      options: {
        temperature: 0.2,
        num_ctx: 8192,
      },
    },
  },
  sandbox: {
    maxSubCalls: 10,
    turnTimeoutMs: 30000,
    memoryLimitMb: 128,
  },
  rlm: {
    maxTurns: 10,
  },
};

export async function loadConfig(configPath?: string): Promise<Config> {
  const path = configPath || resolve(process.cwd(), "config.json");

  try {
    const content = await readFile(path, "utf-8");
    const userConfig = JSON.parse(content) as Partial<Config>;

    // Deep merge with defaults
    return {
      llm: { ...DEFAULT_CONFIG.llm, ...userConfig.llm },
      providers: { ...DEFAULT_CONFIG.providers, ...userConfig.providers },
      sandbox: { ...DEFAULT_CONFIG.sandbox, ...userConfig.sandbox },
      rlm: { ...DEFAULT_CONFIG.rlm, ...userConfig.rlm },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Config file not found, use defaults
      return DEFAULT_CONFIG;
    }
    throw error;
  }
}

