#!/usr/bin/env node
/**
 * Nucleus REPL - Interactive command-line interface for document analysis
 *
 * Provides an interactive REPL for executing Nucleus commands against documents
 * without requiring an LLM in the loop.
 *
 * Usage:
 *   nucleus-repl [file]           Start REPL, optionally loading a file
 *   nucleus-repl --help           Show help
 */

import * as readline from "node:readline";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NucleusEngine } from "../engine/nucleus-engine.js";

const VERSION = "0.1.0";

/**
 * REPL options
 */
export interface REPLOptions {
  /** Initial file to load */
  filePath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Custom prompt string */
  prompt?: string;
  /** Output stream (default: process.stdout) */
  output?: NodeJS.WritableStream;
  /** Input stream (default: process.stdin) */
  input?: NodeJS.ReadableStream;
}

/**
 * Format a value for display
 */
function formatValue(value: unknown, maxLength: number = 2000): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === "number") {
    return value.toLocaleString();
  }

  if (typeof value === "string") {
    if (value.length > maxLength) {
      return value.slice(0, maxLength) + `... (${value.length} chars total)`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    // Show first few items
    const maxItems = 10;
    const items = value.slice(0, maxItems);
    const lines: string[] = [];

    for (const item of items) {
      if (typeof item === "object" && item !== null && "line" in item) {
        // Grep result format
        const gr = item as { line: string; lineNum: number; match?: string };
        lines.push(`  [${gr.lineNum}] ${gr.line.slice(0, 100)}${gr.line.length > 100 ? "..." : ""}`);
      } else {
        lines.push(`  ${JSON.stringify(item).slice(0, 100)}`);
      }
    }

    if (value.length > maxItems) {
      lines.push(`  ... and ${value.length - maxItems} more`);
    }

    return `Array[${value.length}]:\n${lines.join("\n")}`;
  }

  // Object
  const str = JSON.stringify(value, null, 2);
  if (str.length > maxLength) {
    return str.slice(0, maxLength) + `... (truncated)`;
  }
  return str;
}

/**
 * Show help text
 */
function showHelp(output: NodeJS.WritableStream): void {
  output.write(`
Nucleus REPL Commands
=====================

REPL COMMANDS (start with :)
  :load <file>      Load a document file
  :stats            Show document statistics
  :bindings         Show current variable bindings
  :get <var>        Show full value of a binding
  :reset            Clear all bindings
  :ref              Show Nucleus command reference
  :help             Show this help
  :quit, :q         Exit REPL

NUCLEUS COMMANDS (S-expressions)
  (grep "pattern")              Search for pattern
  (fuzzy_search "query" 10)     Fuzzy search
  (text_stats)                  Document stats
  (lines 1 100)                 Get line range

  (filter RESULTS pred)         Filter results
  (map RESULTS transform)       Transform results
  (count RESULTS)               Count items
  (sum RESULTS)                 Sum values

  (match str "pattern" 0)       Extract regex group
  (replace str "from" "to")     Replace in string
  (parseInt str)                Parse integer
  (parseFloat str)              Parse float

VARIABLES
  RESULTS           Last array result (auto-bound)
  _1, _2, ...       Results from each command
  context           Raw document content

EXAMPLES
  > (grep "ERROR")
  > (filter RESULTS (lambda (x) (match x "critical" 0)))
  > (count RESULTS)

`);
}

/**
 * Show command reference
 */
function showReference(output: NodeJS.WritableStream): void {
  output.write(NucleusEngine.getCommandReference() + "\n");
}

/**
 * Start the Nucleus REPL
 */
export async function startREPL(options: REPLOptions = {}): Promise<void> {
  const {
    filePath,
    verbose = false,
    prompt = "> ",
    output = process.stdout,
    input = process.stdin,
  } = options;

  const engine = new NucleusEngine({ verbose });

  // Print banner
  output.write(`Nucleus REPL v${VERSION}\n`);
  output.write(`Type :help for commands, :quit to exit\n\n`);

  // Load initial file if provided
  if (filePath) {
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) {
      output.write(`Error: File not found: ${resolved}\n`);
    } else {
      try {
        await engine.loadFile(resolved);
        const stats = engine.getStats();
        if (stats) {
          output.write(`Loaded: ${resolved}\n`);
          output.write(`  ${stats.length.toLocaleString()} chars, ${stats.lineCount.toLocaleString()} lines\n\n`);
        }
      } catch (err) {
        output.write(`Error loading file: ${err instanceof Error ? err.message : err}\n`);
      }
    }
  }

  // Create readline interface
  const rl = readline.createInterface({
    input: input as NodeJS.ReadableStream,
    output: output as NodeJS.WritableStream,
    prompt,
    terminal: input === process.stdin,
  });

  // Handle commands
  const handleCommand = async (line: string): Promise<boolean> => {
    const trimmed = line.trim();

    if (!trimmed) {
      return true; // Continue
    }

    // REPL commands (start with :)
    if (trimmed.startsWith(":")) {
      const parts = trimmed.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(" ");

      switch (cmd) {
        case "quit":
        case "q":
        case "exit":
          output.write("Goodbye!\n");
          return false; // Exit

        case "help":
        case "h":
        case "?":
          showHelp(output);
          break;

        case "ref":
        case "reference":
          showReference(output);
          break;

        case "load":
          if (!arg) {
            output.write("Usage: :load <file>\n");
          } else {
            const resolved = resolve(arg);
            if (!existsSync(resolved)) {
              output.write(`Error: File not found: ${resolved}\n`);
            } else {
              try {
                await engine.loadFile(resolved);
                const stats = engine.getStats();
                if (stats) {
                  output.write(`Loaded: ${resolved}\n`);
                  output.write(`  ${stats.length.toLocaleString()} chars, ${stats.lineCount.toLocaleString()} lines\n`);
                }
              } catch (err) {
                output.write(`Error: ${err instanceof Error ? err.message : err}\n`);
              }
            }
          }
          break;

        case "stats":
          if (!engine.isLoaded()) {
            output.write("No document loaded. Use :load <file>\n");
          } else {
            const stats = engine.getStats();
            if (stats) {
              output.write(`Document statistics:\n`);
              output.write(`  Length: ${stats.length.toLocaleString()} chars\n`);
              output.write(`  Lines: ${stats.lineCount.toLocaleString()}\n`);
            }
          }
          break;

        case "bindings":
        case "vars":
          const bindings = engine.getBindings();
          const keys = Object.keys(bindings);
          if (keys.length === 0) {
            output.write("No bindings\n");
          } else {
            output.write("Current bindings:\n");
            for (const key of keys) {
              output.write(`  ${key}: ${bindings[key]}\n`);
            }
          }
          break;

        case "get":
          if (!arg) {
            output.write("Usage: :get <varname>\n");
          } else {
            const value = engine.getBinding(arg);
            if (value === undefined) {
              output.write(`Binding not found: ${arg}\n`);
            } else {
              output.write(`${arg} = ${formatValue(value, 5000)}\n`);
            }
          }
          break;

        case "reset":
          engine.reset();
          output.write("State reset\n");
          break;

        default:
          output.write(`Unknown command: :${cmd}\n`);
          output.write(`Type :help for available commands\n`);
      }

      return true;
    }

    // Nucleus command (S-expression)
    if (!engine.isLoaded()) {
      output.write("No document loaded. Use :load <file>\n");
      return true;
    }

    const result = engine.execute(trimmed);

    if (!result.success) {
      output.write(`Error: ${result.error}\n`);
    } else {
      // Show logs if any
      if (result.logs.length > 0 && verbose) {
        for (const log of result.logs) {
          output.write(`  ${log}\n`);
        }
      }

      // Show result
      output.write(`${formatValue(result.value)}\n`);

      // Show type if inferred
      if (result.type && verbose) {
        output.write(`  Type: ${result.type}\n`);
      }
    }

    return true;
  };

  // Main REPL loop
  rl.prompt();

  rl.on("line", async (line) => {
    const shouldContinue = await handleCommand(line);
    if (shouldContinue) {
      rl.prompt();
    } else {
      rl.close();
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });

  // Handle Ctrl+C gracefully
  rl.on("SIGINT", () => {
    output.write("\nUse :quit to exit\n");
    rl.prompt();
  });
}

/**
 * Parse CLI arguments and start REPL
 */
function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Nucleus REPL - Interactive document analysis

Usage:
  nucleus-repl [file] [options]

Arguments:
  file              Document file to load (optional)

Options:
  --verbose, -v     Enable verbose output
  --help, -h        Show this help

Examples:
  nucleus-repl                     Start empty REPL
  nucleus-repl ./logs.txt          Start with document loaded
  nucleus-repl ./data.txt -v       Start with verbose mode
`);
    process.exit(0);
  }

  const verbose = args.includes("--verbose") || args.includes("-v");
  const filePath = args.find(arg => !arg.startsWith("-"));

  startREPL({ filePath, verbose }).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

// Run if executed directly
if (process.argv[1]?.endsWith("nucleus-repl.ts") || process.argv[1]?.endsWith("nucleus-repl.js") || process.argv[1]?.endsWith("nucleus-repl")) {
  main();
}
