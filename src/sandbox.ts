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

interface LLMQueryOptions {
  format?: "json" | "text";
}

type LLMQueryFn = (prompt: string, options?: LLMQueryOptions) => Promise<string>;

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

    // LLM query bridge (async) - accepts optional format option
    __llmQueryBridge: async (prompt: string, options?: LLMQueryOptions): Promise<string> => {
      if (disposed) {
        throw new Error("Sandbox has been disposed");
      }

      subCallCount++;
      if (subCallCount > maxSubCalls) {
        throw new Error(
          `Max sub-calls limit exceeded (${maxSubCalls}). Use text_stats() and fuzzy_search() to narrow your search first.`
        );
      }

      // IMPORTANT: Only pass the prompt and options, never parent history
      return llmQueryFn(prompt, options);
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

  // Initialize the sandbox with fuzzy search, native tools, and llm_query wrapper
  const initCode = `
    ${FUZZY_SEARCH_IMPL}

    // Wrap llm_query to be async-friendly, supports format option
    // Usage: llm_query("prompt") or llm_query("prompt", { format: "json" })
    async function llm_query(prompt, options) {
      return await __llmQueryBridge(prompt, options);
    }

    /**
     * batch_llm_query - Execute multiple LLM queries in parallel
     * Much faster than sequential llm_query calls for processing multiple chunks
     * @param {string[]} prompts - Array of prompts to execute
     * @param {object} [options] - Optional settings: { format: 'json' | 'text' }
     * @returns {Promise<string[]>} Array of responses in the same order as prompts
     */
    async function batch_llm_query(prompts, options) {
      if (!prompts || prompts.length === 0) {
        return [];
      }

      // Execute all prompts in parallel using Promise.all
      const promises = prompts.map(prompt => __llmQueryBridge(prompt, options));
      return await Promise.all(promises);
    }

    /**
     * grep - Fast regex search returning matches with line numbers
     * @param {string} pattern - Regex pattern to match
     * @param {string} [flags='gm'] - Regex flags (g and m are included by default)
     * @returns {Array<{match: string, lineNum: number, index: number, groups: string[]}>}
     */
    function grep(pattern, flags) {
      // Default to global + multiline for line-based searching
      let f = flags || '';
      if (!f.includes('g')) f += 'g';
      if (!f.includes('m')) f += 'm';
      const regex = new RegExp(pattern, f);
      const results = [];
      let match;

      while ((match = regex.exec(context)) !== null) {
        // Calculate line number from character index
        const beforeMatch = context.slice(0, match.index);
        const lineNum = (beforeMatch.match(/\\n/g) || []).length + 1;

        results.push({
          match: match[0],
          lineNum: lineNum,
          index: match.index,
          groups: match.slice(1) // Capture groups
        });

        // Prevent infinite loop on zero-width matches
        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }

      return results;
    }

    /**
     * count_tokens - Estimate token count for text
     * Uses a simple heuristic based on word boundaries
     * @param {string} [text] - Text to count (defaults to context)
     * @returns {number} Estimated token count
     */
    function count_tokens(text) {
      const str = text === undefined ? context : text;
      if (!str || str.length === 0) return 0;

      // Simple word-based estimation:
      // - Most common words are 1 token
      // - Very long words (>12 chars) might be 2 tokens
      // - Punctuation and special chars add tokens
      const words = str.split(/\\s+/).filter(w => w.length > 0);
      let tokenCount = 0;

      for (const word of words) {
        // Count punctuation separately
        const punctuation = (word.match(/[^a-zA-Z0-9]/g) || []).length;
        const cleanWord = word.replace(/[^a-zA-Z0-9]/g, '');

        if (cleanWord.length === 0) {
          tokenCount += punctuation;
        } else if (cleanWord.length <= 12) {
          tokenCount += 1 + Math.floor(punctuation / 2);
        } else {
          // Long words get split into subwords
          tokenCount += Math.ceil(cleanWord.length / 6) + Math.floor(punctuation / 2);
        }
      }

      return tokenCount;
    }

    /**
     * locate_line - Extract lines by line number (1-based)
     * @param {number} start - Start line (1-based, negative counts from end)
     * @param {number} [end] - End line (inclusive, defaults to start for single line)
     * @returns {string} The extracted lines joined with newlines
     */
    function locate_line(start, end) {
      const totalLines = __linesArray.length;

      // Convert to 0-based index, handle negative
      let startIdx = start < 0 ? totalLines + start : start - 1;
      let endIdx = end === undefined ? startIdx : (end < 0 ? totalLines + end : end - 1);

      // Bounds check
      if (startIdx < 0 || startIdx >= totalLines) return '';
      if (endIdx < 0) endIdx = 0;
      if (endIdx >= totalLines) endIdx = totalLines - 1;

      // Ensure start <= end
      if (startIdx > endIdx) {
        const tmp = startIdx;
        startIdx = endIdx;
        endIdx = tmp;
      }

      return __linesArray.slice(startIdx, endIdx + 1).join('\\n');
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

/**
 * Document outline section
 */
export interface OutlineSection {
  title: string;
  level: number;
  lineNum: number;
}

/**
 * Pattern found in document
 */
export interface PatternMatch {
  pattern: string;
  count: number;
  sampleLines: number[];
}

/**
 * Document outline result
 */
export interface DocumentOutline {
  format: "json" | "csv" | "markdown" | "log" | "text";
  summary: {
    totalLines: number;
    totalChars: number;
    estimatedTokens: number;
  };
  sections: OutlineSection[];
  patterns: PatternMatch[];
}

/**
 * Generate a document outline for "semantic peeking"
 * This gives the LLM a map of the document before exploration
 */
export function generateDocumentOutline(context: string): DocumentOutline {
  const lines = context.split("\n");
  const sections: OutlineSection[] = [];
  const patternCounts: Record<string, { count: number; lines: number[] }> = {};

  // Detect format
  let format: DocumentOutline["format"] = "text";

  // Check for JSON
  const trimmed = context.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      format = "json";
    } catch {
      // Not valid JSON
    }
  }

  // Check for CSV (has commas and consistent column count)
  if (format === "text" && lines.length >= 2) {
    const firstLineCommas = (lines[0].match(/,/g) || []).length;
    if (firstLineCommas >= 1) {
      const secondLineCommas = (lines[1].match(/,/g) || []).length;
      if (firstLineCommas === secondLineCommas && firstLineCommas >= 1) {
        format = "csv";
      }
    }
  }

  // Scan for markdown headers and patterns
  const logPatterns = ["INFO:", "ERROR:", "WARN:", "DEBUG:", "WARNING:"];
  let hasLogPatterns = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect markdown headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      sections.push({
        title: headerMatch[2].trim(),
        level: headerMatch[1].length,
        lineNum,
      });
      if (format === "text") format = "markdown";
    }

    // Detect log patterns
    for (const pattern of logPatterns) {
      if (line.includes(pattern)) {
        hasLogPatterns = true;
        if (!patternCounts[pattern]) {
          patternCounts[pattern] = { count: 0, lines: [] };
        }
        patternCounts[pattern].count++;
        if (patternCounts[pattern].lines.length < 3) {
          patternCounts[pattern].lines.push(lineNum);
        }
      }
    }
  }

  if (hasLogPatterns && format === "text") {
    format = "log";
  }

  // Convert pattern counts to array
  const patterns: PatternMatch[] = Object.entries(patternCounts).map(
    ([pattern, data]) => ({
      pattern,
      count: data.count,
      sampleLines: data.lines,
    })
  );

  // Estimate tokens (rough: ~4 chars per token)
  const estimatedTokens = Math.ceil(context.length / 4);

  return {
    format,
    summary: {
      totalLines: lines.length,
      totalChars: context.length,
      estimatedTokens,
    },
    sections,
    patterns,
  };
}

/**
 * Format document outline as a string for injection into system prompt
 */
export function formatOutlineForPrompt(outline: DocumentOutline): string {
  const lines: string[] = [
    "## Document Overview (Pre-computed)",
    "",
    `- **Format**: ${outline.format}`,
    `- **Size**: ${outline.summary.totalLines.toLocaleString()} lines, ${outline.summary.totalChars.toLocaleString()} characters (~${outline.summary.estimatedTokens.toLocaleString()} tokens)`,
  ];

  if (outline.sections.length > 0) {
    lines.push("");
    lines.push("**Sections found** (use `context.slice()` or `locate_line()` to read actual content):");
    for (const section of outline.sections.slice(0, 10)) {
      // Limit to first 10, show only structural hint without full title to prevent hallucination
      const indent = "  ".repeat(section.level - 1);
      // Truncate title to first 3 words to give hint without revealing data
      const titleHint = section.title.split(/\s+/).slice(0, 3).join(" ");
      const truncated = titleHint.length < section.title.length ? `${titleHint}...` : titleHint;
      lines.push(`${indent}- Line ${section.lineNum}: "${truncated}"`);
    }
    if (outline.sections.length > 10) {
      lines.push(`  ... and ${outline.sections.length - 10} more sections`);
    }
  }

  if (outline.patterns.length > 0) {
    lines.push("");
    lines.push("**Patterns detected:**");
    for (const pattern of outline.patterns) {
      lines.push(
        `- "${pattern.pattern}": ${pattern.count} occurrences (e.g., lines ${pattern.sampleLines.join(", ")})`
      );
    }
  }

  return lines.join("\n");
}
