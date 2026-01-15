/**
 * Nucleus Tool Adapters
 *
 * Three ways to use Nucleus interactively:
 * - Claude Code: Register as MCP tools
 * - Pipe: JSON or text-based subprocess control
 * - HTTP: REST API server
 */

export {
  ClaudeCodeAdapter,
  createClaudeCodeAdapter,
  generateMCPConfig,
  type ClaudeCodeToolDefinition,
} from "./claude-code.js";

export {
  PipeAdapter,
  startPipeAdapter,
  type PipeAdapterOptions,
} from "./pipe.js";

export {
  HttpAdapter,
  startHttpAdapter,
  type HttpAdapterOptions,
} from "./http.js";
