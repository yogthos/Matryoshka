/**
 * RLM Library Entry Point
 *
 * This module exports the public API for programmatic use.
 */

// RLM Core
export { runRLM, type RLMOptions } from "./rlm.js";

// Nucleus Engine - standalone document analysis
export {
  NucleusEngine,
  createEngine,
  createEngineFromContent,
  type ExecutionResult,
  type NucleusEngineOptions,
} from "./engine/index.js";

// REPL
export { startREPL, type REPLOptions } from "./repl/index.js";

// Tool adapters
export {
  NucleusTool,
  parseCommand,
  formatResponse,
  ClaudeCodeAdapter,
  createClaudeCodeAdapter,
  generateMCPConfig,
  PipeAdapter,
  startPipeAdapter,
  HttpAdapter,
  startHttpAdapter,
  type NucleusCommand,
  type NucleusResponse,
  type ClaudeCodeToolDefinition,
  type PipeAdapterOptions,
  type HttpAdapterOptions,
} from "./tool/index.js";

// MCP Server
export { createMCPServer, type MCPServerOptions, type MCPServerInstance, type MCPTool } from "./mcp-server.js";

// Adapters
export { resolveAdapter, getAvailableAdapters } from "./adapters/index.js";
export type { ModelAdapter } from "./adapters/types.js";

// Constraints
export {
  parseSimpleType,
  parseConstraintJSON,
  verifyResult,
  type SynthesisConstraint,
  type OutputConstraint,
  type VerificationResult,
} from "./constraints/index.js";

// Config
export { loadConfig, type Config, type ProviderConfig } from "./config.js";

// LLM Client
export { createLLMClient } from "./llm/index.js";
export type { LLMQueryFn } from "./llm/types.js";
