import vm from "node:vm";
import { FUZZY_SEARCH_IMPL } from "./fuzzy-search.js";

/**
 * Wrap code to capture the last expression as __result__
 * This handles the common case of code that ends with an expression
 */
function wrapCodeForReturn(code: string): string {
  const trimmed = code.trim();

  // If the code is empty, return as-is
  if (!trimmed) {
    return code;
  }

  // Split into lines and find the last non-empty line
  const lines = trimmed.split("\n");
  let lastIndex = lines.length - 1;
  while (lastIndex >= 0 && !lines[lastIndex].trim()) {
    lastIndex--;
  }

  if (lastIndex < 0) {
    return code;
  }

  const lastLine = lines[lastIndex].trim();

  // Check if last line is a statement that shouldn't be captured
  // (declarations, control flow, blocks ending with }, etc.)
  const lineWithoutSemi = lastLine.endsWith(";") ? lastLine.slice(0, -1) : lastLine;
  const isStatement =
    lastLine.startsWith("const ") ||
    lastLine.startsWith("let ") ||
    lastLine.startsWith("var ") ||
    lastLine.startsWith("function ") ||
    lastLine.startsWith("class ") ||
    lastLine.startsWith("if ") ||
    lastLine.startsWith("if(") ||
    lastLine.startsWith("for ") ||
    lastLine.startsWith("for(") ||
    lastLine.startsWith("while ") ||
    lastLine.startsWith("while(") ||
    lastLine.startsWith("switch ") ||
    lastLine.startsWith("switch(") ||
    lastLine.startsWith("try ") ||
    lastLine.startsWith("try{") ||
    lastLine.startsWith("return ") ||
    lastLine.startsWith("throw ") ||
    lastLine === "}" ||
    lastLine.endsWith("{") ||
    lastLine.endsWith("}") ||
    lineWithoutSemi.endsWith("}") ||  // Handle });
    lineWithoutSemi === ")" ||  // Just a closing paren on its own
    /^\s*\}\s*\)/.test(lineWithoutSemi);  // }), }) patterns

  if (isStatement) {
    return code;
  }

  // Check if last line ends with semicolon - it's an expression statement
  // Capture it as the result
  const beforeLast = lines.slice(0, lastIndex).join("\n");
  let expression = lastLine;

  // Remove trailing semicolon if present
  if (expression.endsWith(";")) {
    expression = expression.slice(0, -1);
  }

  return `${beforeLast}\n__result__ = ${expression};`;
}

export interface SandboxResult {
  result: unknown;
  logs: string[];
  error?: string;
}

export interface SandboxOptions {
  maxSubCalls?: number;
  timeoutMs?: number;
}

export interface Sandbox {
  execute(code: string, timeoutMs?: number): Promise<SandboxResult>;
  getMemory(): unknown[];
  dispose(): void;
}

type LLMQueryFn = (prompt: string) => Promise<string>;

/**
 * Create a sandboxed execution environment for RLM code
 *
 * NOTE: Node's vm module provides contextual isolation but NOT security isolation.
 * For production use with untrusted code, consider:
 * - Running in a Docker container
 * - Using a Deno subprocess (like codecall)
 * - Using isolated-vm with compatible Node.js version
 */
export async function createSandbox(
  context: string,
  llmQueryFn: LLMQueryFn,
  options: SandboxOptions = {}
): Promise<Sandbox> {
  const { maxSubCalls = 10 } = options;

  // Persistent state across executions
  const logs: string[] = [];
  const memory: unknown[] = [];
  let subCallCount = 0;
  let disposed = false;

  // Pre-compute text stats
  const lines = context.split("\n");
  const textStats = {
    length: context.length,
    lineCount: lines.length,
    sample: {
      start: lines.slice(0, 5).join("\n"),
      middle: lines
        .slice(
          Math.floor(lines.length / 2) - 2,
          Math.floor(lines.length / 2) + 3
        )
        .join("\n"),
      end: lines.slice(-5).join("\n"),
    },
  };

  // Create the sandbox context with restricted globals
  const sandboxGlobals = {
    // The document context (read-only via getter)
    context,

    // Memory buffer (persists across executions)
    memory,

    // Console with log capture
    console: {
      log: (...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(" "));
      },
      error: (...args: unknown[]) => {
        logs.push(`[ERROR] ${args.map((a) => String(a)).join(" ")}`);
      },
      warn: (...args: unknown[]) => {
        logs.push(`[WARN] ${args.map((a) => String(a)).join(" ")}`);
      },
    },

    // text_stats function
    text_stats: () => ({ ...textStats }),

    // Lines array for fuzzy search
    __linesArray: lines,

    // LLM query bridge (async)
    __llmQueryBridge: async (prompt: string): Promise<string> => {
      if (disposed) {
        throw new Error("Sandbox has been disposed");
      }

      subCallCount++;
      if (subCallCount > maxSubCalls) {
        throw new Error(
          `Max sub-calls limit exceeded (${maxSubCalls}). Use text_stats() and fuzzy_search() to narrow your search first.`
        );
      }

      // IMPORTANT: Only pass the prompt, never parent history
      return llmQueryFn(prompt);
    },

    // Safe built-ins
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,

    // Async iteration support
    Symbol,
  };

  // Create VM context
  const vmContext = vm.createContext(sandboxGlobals);

  // Initialize the sandbox with fuzzy search and llm_query wrapper
  const initCode = `
    ${FUZZY_SEARCH_IMPL}

    // Wrap llm_query to be async-friendly
    async function llm_query(prompt) {
      return await __llmQueryBridge(prompt);
    }
  `;

  vm.runInContext(initCode, vmContext);

  return {
    async execute(code: string, timeoutMs = 30000): Promise<SandboxResult> {
      if (disposed) {
        return {
          result: null,
          logs: [...logs],
          error: "Sandbox has been disposed",
        };
      }

      // Clear logs for this execution (but keep memory)
      const executionLogs: string[] = [];

      // Override console methods to capture to execution logs
      const originalLog = sandboxGlobals.console.log;
      const originalError = sandboxGlobals.console.error;
      const originalWarn = sandboxGlobals.console.warn;

      sandboxGlobals.console.log = (...args: unknown[]) => {
        const msg = args.map((a) => String(a)).join(" ");
        executionLogs.push(msg);
        logs.push(msg);
      };
      sandboxGlobals.console.error = (...args: unknown[]) => {
        const msg = `[ERROR] ${args.map((a) => String(a)).join(" ")}`;
        executionLogs.push(msg);
        logs.push(msg);
      };
      sandboxGlobals.console.warn = (...args: unknown[]) => {
        const msg = `[WARN] ${args.map((a) => String(a)).join(" ")}`;
        executionLogs.push(msg);
        logs.push(msg);
      };

      try {
        // Parse the code to extract the last expression for return value
        // Wrap code in async IIFE that returns the last expression
        const wrappedCode = `
          (async () => {
            let __result__;
            ${wrapCodeForReturn(code)}
            return __result__;
          })()
        `;

        // Execute with timeout
        const script = new vm.Script(wrappedCode);

        const resultPromise = script.runInContext(vmContext, {
          timeout: timeoutMs,
          displayErrors: true,
        }) as Promise<unknown>;

        // Handle the promise with timeout
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Execution timeout after ${timeoutMs}ms`)),
            timeoutMs
          );
        });

        try {
          const result = await Promise.race([resultPromise, timeoutPromise]);
          return {
            result,
            logs: executionLogs,
          };
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        return {
          result: null,
          logs: executionLogs,
          error: errorMessage,
        };
      } finally {
        // Restore original console functions
        sandboxGlobals.console.log = originalLog;
        sandboxGlobals.console.error = originalError;
        sandboxGlobals.console.warn = originalWarn;
      }
    },

    getMemory(): unknown[] {
      return [...memory];
    },

    dispose(): void {
      disposed = true;
      // Clear references
      logs.length = 0;
      memory.length = 0;
    },
  };
}

/**
 * Create text stats without full sandbox (for testing)
 */
export function createTextStats(context: string) {
  const lines = context.split("\n");
  return {
    length: context.length,
    lineCount: lines.length,
    sample: {
      start: lines.slice(0, 5).join("\n"),
      middle: lines
        .slice(
          Math.floor(lines.length / 2) - 2,
          Math.floor(lines.length / 2) + 3
        )
        .join("\n"),
      end: lines.slice(-5).join("\n"),
    },
  };
}
