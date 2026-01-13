/**
 * Sandbox Tools for Synthesis
 * Exposes synthesis capabilities to the LLM in the sandbox
 */

import vm from "node:vm";
import { FUZZY_SEARCH_IMPL } from "../fuzzy-search.js";
import { SynthesisCoordinator } from "./coordinator.js";
import type { SandboxResult, SandboxOptions } from "../sandbox.js";

interface LLMQueryOptions {
  format?: "json" | "text";
}

type LLMQueryFn = (prompt: string, options?: LLMQueryOptions) => Promise<string>;

export interface SandboxWithSynthesis {
  execute(code: string, timeoutMs?: number): Promise<SandboxResult>;
  getMemory(): unknown[];
  dispose(): void;
  getCoordinator(): SynthesisCoordinator;
}

/**
 * Create a sandboxed execution environment with synthesis capabilities
 */
export async function createSandboxWithSynthesis(
  context: string,
  llmQueryFn: LLMQueryFn,
  coordinator: SynthesisCoordinator,
  options: SandboxOptions = {}
): Promise<SandboxWithSynthesis> {
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

  // Create synthesis bridge functions
  const synthesisBridge = {
    synthesize_regex: (
      positive: string[],
      negative: string[] = []
    ): string | null => {
      if (!positive || positive.length === 0) {
        return null;
      }

      const result = coordinator.synthesize({
        type: "regex",
        description: "sandbox_synthesis",
        positiveExamples: positive,
        negativeExamples: negative,
      });

      return result.success ? result.regex ?? null : null;
    },

    synthesize_extractor: (
      examples: Array<{ input: string; output: unknown }>
    ): ((s: string) => unknown) | null => {
      if (!examples || examples.length === 0) {
        return null;
      }

      const result = coordinator.synthesize({
        type: "extractor",
        description: "sandbox_synthesis",
        positiveExamples: examples.map((e) => e.input),
        expectedOutputs: examples.map((e) => e.output),
      });

      if (result.success && result.extractor) {
        return result.extractor.test;
      }

      return null;
    },

    get_extractor_code: (
      examples: Array<{ input: string; output: unknown }>
    ): string | null => {
      if (!examples || examples.length === 0) {
        return null;
      }

      // Check for conflicting examples
      const inputMap = new Map<string, unknown>();
      for (const ex of examples) {
        if (inputMap.has(ex.input)) {
          const existing = inputMap.get(ex.input);
          if (existing !== ex.output) {
            return null; // Conflicting outputs for same input
          }
        }
        inputMap.set(ex.input, ex.output);
      }

      const result = coordinator.synthesize({
        type: "extractor",
        description: "sandbox_synthesis",
        positiveExamples: examples.map((e) => e.input),
        expectedOutputs: examples.map((e) => e.output),
      });

      if (result.success && result.extractorCode) {
        return result.extractorCode;
      }

      return null;
    },

    test_regex: (pattern: string, str: string): boolean => {
      return coordinator.testRegex(pattern, str);
    },

    extract_with_regex: (pattern: string, str: string): string | null => {
      try {
        const regex = new RegExp(pattern);
        const match = str.match(regex);
        if (!match) return null;
        // Return first capture group if available, otherwise full match
        return match[1] ?? match[0];
      } catch {
        return null;
      }
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

    // Synthesis bridge functions
    __synthesisBridge: synthesisBridge,

    // LLM query bridge (async)
    __llmQueryBridge: async (
      prompt: string,
      queryOptions?: LLMQueryOptions
    ): Promise<string> => {
      if (disposed) {
        throw new Error("Sandbox has been disposed");
      }

      subCallCount++;
      if (subCallCount > maxSubCalls) {
        throw new Error(
          `Max sub-calls limit exceeded (${maxSubCalls}). Use text_stats() and fuzzy_search() to narrow your search first.`
        );
      }

      return llmQueryFn(prompt, queryOptions);
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
    eval, // Needed for get_extractor_code tests

    // Async iteration support
    Symbol,
  };

  // Create VM context
  const vmContext = vm.createContext(sandboxGlobals);

  // Initialize the sandbox with fuzzy search, native tools, synthesis tools, and llm_query wrapper
  const initCode = `
    ${FUZZY_SEARCH_IMPL}

    // Wrap llm_query to be async-friendly
    async function llm_query(prompt, options) {
      return await __llmQueryBridge(prompt, options);
    }

    /**
     * batch_llm_query - Execute multiple LLM queries in parallel
     */
    async function batch_llm_query(prompts, options) {
      if (!prompts || prompts.length === 0) {
        return [];
      }
      const promises = prompts.map(prompt => __llmQueryBridge(prompt, options));
      return await Promise.all(promises);
    }

    /**
     * grep - Fast regex search returning matches with line numbers
     */
    function grep(pattern, flags) {
      let f = flags || '';
      if (!f.includes('g')) f += 'g';
      if (!f.includes('m')) f += 'm';
      if (!f.includes('i')) f += 'i';
      const regex = new RegExp(pattern, f);
      const results = [];
      let match;

      while ((match = regex.exec(context)) !== null) {
        const beforeMatch = context.slice(0, match.index);
        const lineNum = (beforeMatch.match(/\\n/g) || []).length + 1;
        const line = __linesArray[lineNum - 1] || '';

        results.push({
          match: match[0],
          line: line,
          lineNum: lineNum,
          index: match.index,
          groups: match.slice(1)
        });

        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }

      return results;
    }

    /**
     * count_tokens - Estimate token count for text
     */
    function count_tokens(text) {
      const str = text === undefined ? context : text;
      if (!str || str.length === 0) return 0;

      const words = str.split(/\\s+/).filter(w => w.length > 0);
      let tokenCount = 0;

      for (const word of words) {
        const punctuation = (word.match(/[^a-zA-Z0-9]/g) || []).length;
        const cleanWord = word.replace(/[^a-zA-Z0-9]/g, '');

        if (cleanWord.length === 0) {
          tokenCount += punctuation;
        } else if (cleanWord.length <= 12) {
          tokenCount += 1 + Math.floor(punctuation / 2);
        } else {
          tokenCount += Math.ceil(cleanWord.length / 6) + Math.floor(punctuation / 2);
        }
      }

      return tokenCount;
    }

    /**
     * locate_line - Extract lines by line number (1-based)
     */
    function locate_line(start, end) {
      const totalLines = __linesArray.length;
      let startIdx = start < 0 ? totalLines + start : start - 1;
      let endIdx = end === undefined ? startIdx : (end < 0 ? totalLines + end : end - 1);

      if (startIdx < 0 || startIdx >= totalLines) return '';
      if (endIdx < 0) endIdx = 0;
      if (endIdx >= totalLines) endIdx = totalLines - 1;

      if (startIdx > endIdx) {
        const tmp = startIdx;
        startIdx = endIdx;
        endIdx = tmp;
      }

      return __linesArray.slice(startIdx, endIdx + 1).join('\\n');
    }

    // ===== SYNTHESIS TOOLS =====

    /**
     * synthesize_regex - Request regex synthesis from examples
     * @param {string[]} positive - Strings that should match
     * @param {string[]} [negative] - Strings that should NOT match
     * @returns {string|null} Synthesized regex pattern string or null
     */
    function synthesize_regex(positive, negative) {
      return __synthesisBridge.synthesize_regex(positive, negative || []);
    }

    /**
     * synthesize_extractor - Request extractor synthesis from input/output examples
     * @param {Array<{input: string, output: unknown}>} examples - Input/output pairs
     * @returns {Function|null} Extractor function or null
     */
    function synthesize_extractor(examples) {
      return __synthesisBridge.synthesize_extractor(examples);
    }

    /**
     * get_extractor_code - Get the code string for a synthesized extractor
     * @param {Array<{input: string, output: unknown}>} examples - Input/output pairs
     * @returns {string|null} Extractor code string or null
     */
    function get_extractor_code(examples) {
      return __synthesisBridge.get_extractor_code(examples);
    }

    /**
     * test_regex - Test a regex pattern against a string
     * @param {string} pattern - The regex pattern string
     * @param {string} str - String to test
     * @returns {boolean} True if matches
     */
    function test_regex(pattern, str) {
      return __synthesisBridge.test_regex(pattern, str);
    }

    /**
     * extract_with_regex - Extract using a regex pattern
     * @param {string} pattern - The regex pattern string (with optional capture group)
     * @param {string} str - String to extract from
     * @returns {string|null} Captured group (or full match) or null
     */
    function extract_with_regex(pattern, str) {
      return __synthesisBridge.extract_with_regex(pattern, str);
    }
  `;

  vm.runInContext(initCode, vmContext);

  // Helper function to extract declarations
  function extractDeclarations(code: string): {
    declarations: string[];
    mainCode: string;
  } {
    const codeLines = code.split("\n");
    const declarations: string[] = [];
    const mainLines: string[] = [];

    for (const line of codeLines) {
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;

      if (
        indent <= 2 &&
        (trimmed.startsWith("const ") ||
          trimmed.startsWith("let ") ||
          trimmed.startsWith("var "))
      ) {
        const match = trimmed.match(
          /^(?:const|let|var)\s+(\w+|\{[^}]+\}|\[[^\]]+\])/
        );
        if (match) {
          const varName = match[1];
          if (varName.startsWith("{") || varName.startsWith("[")) {
            declarations.push(line.replace(/^(\s*)(?:const|let)/, "$1var"));
          } else {
            declarations.push(`var ${varName};`);
            mainLines.push(line.replace(/^(\s*)(?:const|let|var)\s+/, "$1"));
          }
        } else {
          mainLines.push(line);
        }
      } else {
        mainLines.push(line);
      }
    }

    return { declarations, mainCode: mainLines.join("\n") };
  }

  // Helper function to wrap code for return
  function wrapCodeForReturn(code: string): string {
    const trimmed = code.trim();
    if (!trimmed) return code;

    const codeLines = trimmed.split("\n");
    let lastIndex = codeLines.length - 1;
    while (lastIndex >= 0 && !codeLines[lastIndex].trim()) {
      lastIndex--;
    }

    if (lastIndex < 0) return code;

    const lastLine = codeLines[lastIndex].trim();
    const lineWithoutSemi = lastLine.endsWith(";")
      ? lastLine.slice(0, -1)
      : lastLine;

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
      lineWithoutSemi.endsWith("}") ||
      lineWithoutSemi === ")" ||
      /^\s*\}\s*\)/.test(lineWithoutSemi);

    if (isStatement) return code;

    const beforeLast = codeLines.slice(0, lastIndex).join("\n");
    let expression = lastLine;
    if (expression.endsWith(";")) {
      expression = expression.slice(0, -1);
    }

    return `${beforeLast}\n__result__ = ${expression};`;
  }

  return {
    async execute(code: string, timeoutMs = 30000): Promise<SandboxResult> {
      if (disposed) {
        return {
          result: null,
          logs: [...logs],
          error: "Sandbox has been disposed",
        };
      }

      const executionLogs: string[] = [];

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
        const { declarations, mainCode } = extractDeclarations(code);

        if (declarations.length > 0) {
          const declScript = new vm.Script(declarations.join("\n"));
          declScript.runInContext(vmContext);
        }

        const wrappedCode = `
          (async () => {
            var __result__;
            ${wrapCodeForReturn(mainCode)}
            return __result__;
          })()
        `;

        const script = new vm.Script(wrappedCode);

        const resultPromise = script.runInContext(vmContext, {
          timeout: timeoutMs,
          displayErrors: true,
        }) as Promise<unknown>;

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
      logs.length = 0;
      memory.length = 0;
    },

    getCoordinator(): SynthesisCoordinator {
      return coordinator;
    },
  };
}
