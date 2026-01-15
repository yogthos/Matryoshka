#!/usr/bin/env node
/**
 * Pipe-based Nucleus Adapter
 *
 * Runs as a subprocess that reads JSON commands from stdin and writes
 * JSON responses to stdout. This allows any process to control Nucleus
 * programmatically.
 *
 * Protocol:
 *   - Input: JSON-encoded NucleusCommand per line
 *   - Output: JSON-encoded NucleusResponse per line
 *
 * Usage:
 *   echo '{"type":"loadContent","content":"test data"}' | nucleus-pipe
 *   echo '{"type":"query","command":"(grep \"test\")"}' | nucleus-pipe
 *
 * Or for interactive use:
 *   nucleus-pipe --interactive
 *   > :load ./file.txt
 *   > (grep "pattern")
 */

import * as readline from "node:readline";
import {
  NucleusTool,
  parseCommand,
  formatResponse,
  type NucleusCommand,
  type NucleusResponse,
} from "../nucleus-tool.js";

export interface PipeAdapterOptions {
  /** Use interactive text mode instead of JSON */
  interactive?: boolean;
  /** Input stream (default: process.stdin) */
  input?: NodeJS.ReadableStream;
  /** Output stream (default: process.stdout) */
  output?: NodeJS.WritableStream;
  /** Error stream (default: process.stderr) */
  error?: NodeJS.WritableStream;
}

/**
 * Pipe-based adapter for subprocess control
 */
export class PipeAdapter {
  private tool: NucleusTool;
  private interactive: boolean;
  private input: NodeJS.ReadableStream;
  private output: NodeJS.WritableStream;
  constructor(options: PipeAdapterOptions = {}) {
    this.tool = new NucleusTool();
    this.interactive = options.interactive ?? false;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  /**
   * Start the pipe adapter
   */
  async start(): Promise<void> {
    const rl = readline.createInterface({
      input: this.input,
      output: this.interactive ? this.output : undefined,
      prompt: this.interactive ? "nucleus> " : "",
      terminal: this.interactive,
    });

    if (this.interactive) {
      this.output.write("Nucleus Pipe Adapter (interactive mode)\n");
      this.output.write("Commands: :load <file>, :bindings, :reset, :stats, :help, :quit\n");
      this.output.write("Or enter Nucleus expressions: (grep \"pattern\")\n\n");
      rl.prompt();
    }

    rl.on("line", async (line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        if (this.interactive) rl.prompt();
        return;
      }

      // Handle quit
      if (this.interactive && (trimmed === ":quit" || trimmed === ":q" || trimmed === ":exit")) {
        this.output.write("Goodbye!\n");
        rl.close();
        return;
      }

      let response: NucleusResponse;

      if (this.interactive) {
        // Interactive text mode
        response = await this.handleInteractive(trimmed);
        this.output.write(formatResponse(response) + "\n");
        rl.prompt();
      } else {
        // JSON mode
        response = await this.handleJSON(trimmed);
        this.output.write(JSON.stringify(response) + "\n");
      }
    });

    rl.on("close", () => {
      process.exit(0);
    });
  }

  /**
   * Handle interactive text command
   */
  private async handleInteractive(input: string): Promise<NucleusResponse> {
    const command = parseCommand(input);

    if (!command) {
      return {
        success: false,
        error: `Unknown command: ${input}. Use :help for available commands.`,
      };
    }

    if (command.type === "load") {
      return this.tool.executeAsync(command);
    }

    return this.tool.execute(command);
  }

  /**
   * Handle JSON command
   */
  private async handleJSON(input: string): Promise<NucleusResponse> {
    let command: NucleusCommand;

    try {
      command = JSON.parse(input) as NucleusCommand;
    } catch {
      return {
        success: false,
        error: `Invalid JSON: ${input}`,
      };
    }

    if (!command.type) {
      return {
        success: false,
        error: "Missing 'type' field in command",
      };
    }

    if (command.type === "load") {
      return this.tool.executeAsync(command);
    }

    return this.tool.execute(command);
  }

  /**
   * Execute a single command (for programmatic use)
   */
  async executeCommand(command: NucleusCommand): Promise<NucleusResponse> {
    if (command.type === "load") {
      return this.tool.executeAsync(command);
    }
    return this.tool.execute(command);
  }

  /**
   * Get the underlying tool
   */
  getTool(): NucleusTool {
    return this.tool;
  }
}

/**
 * Create and start a pipe adapter
 */
export async function startPipeAdapter(options?: PipeAdapterOptions): Promise<PipeAdapter> {
  const adapter = new PipeAdapter(options);
  await adapter.start();
  return adapter;
}

/**
 * CLI entry point
 */
function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Nucleus Pipe Adapter

Usage:
  nucleus-pipe [options]

Options:
  --interactive, -i   Use interactive text mode instead of JSON
  --help, -h          Show this help

JSON Mode (default):
  Reads JSON commands from stdin, writes JSON responses to stdout.

  Commands:
    {"type": "load", "filePath": "./file.txt"}
    {"type": "loadContent", "content": "data here", "name": "optional-name"}
    {"type": "query", "command": "(grep \\"pattern\\")"}
    {"type": "bindings"}
    {"type": "reset"}
    {"type": "stats"}
    {"type": "help"}

Interactive Mode (-i):
  Uses text commands like the REPL.

  Commands:
    :load <file>     Load a document
    :bindings        Show current bindings
    :reset           Clear bindings
    :stats           Show document stats
    :help            Show Nucleus command reference
    :quit            Exit
    (grep "...")     Execute Nucleus command

Examples:
  # JSON mode
  echo '{"type":"loadContent","content":"line1\\nline2"}' | nucleus-pipe

  # Interactive mode
  nucleus-pipe -i
`);
    process.exit(0);
  }

  const interactive = args.includes("--interactive") || args.includes("-i");

  startPipeAdapter({ interactive }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

// Run if executed directly
if (process.argv[1]?.endsWith("pipe.ts") || process.argv[1]?.endsWith("pipe.js") || process.argv[1]?.endsWith("nucleus-pipe")) {
  main();
}
