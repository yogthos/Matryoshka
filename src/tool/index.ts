/**
 * Nucleus Tool - Stateful Document Analysis Tool
 *
 * Provides a unified interface for interactive document analysis with
 * multiple adapter options for different integration scenarios.
 *
 * Adapters:
 * - ClaudeCodeAdapter: Register as Claude Code tools
 * - PipeAdapter: Subprocess control via stdin/stdout
 * - HttpAdapter: REST API server
 */

// Core tool
export {
  NucleusTool,
  parseCommand,
  formatResponse,
  type NucleusCommand,
  type NucleusResponse,
} from "./nucleus-tool.js";

// Adapters
export {
  ClaudeCodeAdapter,
  createClaudeCodeAdapter,
  generateMCPConfig,
  type ClaudeCodeToolDefinition,
} from "./adapters/claude-code.js";

export {
  PipeAdapter,
  startPipeAdapter,
  type PipeAdapterOptions,
} from "./adapters/pipe.js";

export {
  HttpAdapter,
  startHttpAdapter,
  type HttpAdapterOptions,
} from "./adapters/http.js";
