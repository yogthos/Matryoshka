/**
 * NucleusEngine - Standalone logic engine for document analysis
 *
 * This module provides a standalone interface to the Nucleus command execution
 * engine without requiring an LLM in the loop. It can be used:
 * - As a library API for programmatic document analysis
 * - As the backend for a REPL
 * - As an MCP tool for direct command execution
 */

import { readFile } from "node:fs/promises";
import { parse as parseLC } from "../logic/lc-parser.js";
import { inferType, typeToString } from "../logic/type-inference.js";
import { solve as solveTerm, validateRegex, type SolverTools, type Bindings } from "../logic/lc-solver.js";
import { buildBM25Index, searchBM25, type BM25Index } from "../logic/bm25.js";

/**
 * Result of executing a Nucleus command
 */
export interface ExecutionResult {
  success: boolean;
  value: unknown;
  logs: string[];
  error?: string;
  type?: string;
}

/**
 * Options for creating a NucleusEngine
 */
export interface NucleusEngineOptions {
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Create SolverTools from document content
 */
function createSolverTools(context: string): SolverTools {
  const lines = context.split("\n");

  const textStats = {
    length: context.length,
    lineCount: lines.length,
    sample: {
      start: lines.slice(0, 5).join("\n"),
      middle: lines
        .slice(
          Math.max(0, Math.floor(lines.length / 2) - 2),
          Math.floor(lines.length / 2) + 3
        )
        .join("\n"),
      end: lines.slice(-5).join("\n"),
    },
  };

  function fuzzyMatch(str: string, query: string): number {
    if (!query || query.length === 0) return 0;
    const strLower = str.toLowerCase();
    const queryLower = query.toLowerCase();

    if (strLower.includes(queryLower)) {
      return 100 + queryLower.length;
    }

    let score = 0;
    let queryIndex = 0;
    let prevMatchIndex = -1;

    for (let i = 0; i < strLower.length && queryIndex < queryLower.length; i++) {
      if (strLower[i] === queryLower[queryIndex]) {
        score += 10;
        if (prevMatchIndex === i - 1) {
          score += 5;
        }
        prevMatchIndex = i;
        queryIndex++;
      }
    }

    return queryIndex === queryLower.length ? score : 0;
  }

  return {
    context,

    grep: (pattern: string) => {
      const MAX_GREP_MATCHES = 10000;
      const MAX_PATTERN_LENGTH = 1000;
      const MAX_CAPTURE_GROUPS = 50;
      if (pattern.length > MAX_PATTERN_LENGTH) return [];
      const validation = validateRegex(pattern);
      if (!validation.valid) return [];
      // Cap capture groups to prevent huge result objects
      // Replace escaped backslashes first, then escaped chars, to correctly handle \\(
      const unescapedParens = pattern.replace(/\\\\/g, "").replace(/\\./g, "").match(/\(/g);
      if (unescapedParens && unescapedParens.length > MAX_CAPTURE_GROUPS) return [];
      const flags = "gmi";
      const regex = new RegExp(pattern, flags);
      const results: Array<{ match: string; line: string; lineNum: number; index: number; groups: string[] }> = [];
      let match;

      while ((match = regex.exec(context)) !== null) {
        const beforeMatch = context.slice(0, match.index);
        const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;
        const line = lines[lineNum - 1] || "";

        results.push({
          match: match[0],
          line: line,
          lineNum: lineNum,
          index: match.index,
          groups: match.slice(1).filter((g): g is string => g !== undefined),
        });

        if (match[0].length === 0) {
          regex.lastIndex++;
        }

        if (results.length >= MAX_GREP_MATCHES) break;
      }

      return results;
    },

    fuzzy_search: (query: string, limit: number = 10) => {
      const MAX_QUERY_LENGTH = 500;
      const MAX_FUZZY_LINES = 50_000;
      if (query.length > MAX_QUERY_LENGTH) return [];
      if (!Number.isFinite(limit)) limit = 10;
      const clampedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
      const results: Array<{ line: string; lineNum: number; score: number }> = [];
      const lineCount = Math.min(lines.length, MAX_FUZZY_LINES);

      for (let i = 0; i < lineCount; i++) {
        const score = fuzzyMatch(lines[i], query);
        if (score > 0) {
          results.push({
            line: lines[i],
            lineNum: i + 1,
            score,
          });
        }
      }

      results.sort((a, b) => {
        if (b.score > a.score) return 1;
        if (b.score < a.score) return -1;
        return 0;
      });
      return results.slice(0, clampedLimit);
    },

    bm25: (() => {
      let index: BM25Index | null = null;
      return (query: string, limit: number = 10) => {
        if (!index) {
          index = buildBM25Index(lines);
        }
        return searchBM25(query, lines, index, undefined, limit);
      };
    })(),

    text_stats: () => ({ ...textStats }),
  };
}

/**
 * NucleusEngine - Execute Nucleus commands against documents
 *
 * @example
 * ```typescript
 * const engine = new NucleusEngine();
 * await engine.loadDocument("./logs.txt");
 *
 * const hits = engine.execute("(grep \"ERROR\")");
 * const filtered = engine.execute("(filter RESULTS (lambda (x) (match x \"500\" 0)))");
 * const count = engine.execute("(count RESULTS)");
 *
 * console.log(`Found ${count.value} errors`);
 * ```
 */
export class NucleusEngine {
  private static readonly MAX_TURN_BINDINGS = 100;
  private context: string = "";
  private bindings: Bindings = new Map();
  private solverTools: SolverTools | null = null;
  private verbose: boolean;
  private turnCounter: number = 0;

  constructor(options: NucleusEngineOptions = {}) {
    this.verbose = options.verbose ?? false;
  }

  /**
   * Load a document from a file path
   */
  async loadFile(filePath: string): Promise<void> {
    const content = await readFile(filePath, "utf-8");
    this.loadContent(content);
  }

  /**
   * Load a document from a string
   */
  loadContent(content: string): void {
    const trimmed = content.trim();
    this.context = trimmed.length > 0 ? content : "";
    this.solverTools = trimmed.length > 0 ? createSolverTools(content) : null;
    this.bindings.clear();
    this.turnCounter = 0;

    if (this.verbose) {
      const lines = content.split("\n").length;
      console.log(`[Engine] Loaded document: ${content.length.toLocaleString()} chars, ${lines.toLocaleString()} lines`);
    }
  }

  /**
   * Check if a document is loaded
   */
  isLoaded(): boolean {
    return this.context.length > 0 && this.solverTools !== null;
  }

  /**
   * Get document statistics
   */
  getStats(): { length: number; lineCount: number } | null {
    if (!this.solverTools) return null;
    const stats = this.solverTools.text_stats();
    return { length: stats.length, lineCount: stats.lineCount };
  }

  /**
   * Execute a Nucleus command
   *
   * @param command - Nucleus S-expression (e.g., "(grep \"pattern\")")
   * @returns Execution result with value, logs, and any errors
   */
  execute(command: string): ExecutionResult {
    if (!this.solverTools) {
      return {
        success: false,
        value: null,
        logs: [],
        error: "No document loaded. Call loadFile() or loadContent() first.",
      };
    }

    // Parse the LC term
    const parseResult = parseLC(command);
    if (!parseResult.success || !parseResult.term) {
      return {
        success: false,
        value: null,
        logs: [],
        error: `Parse error: ${parseResult.error}`,
      };
    }

    // Type inference
    const typeResult = inferType(parseResult.term);
    if (!typeResult.valid) {
      return {
        success: false,
        value: null,
        logs: [],
        error: `Type error: ${typeResult.error}`,
      };
    }

    // Execute the term
    const solverResult = solveTerm(parseResult.term, this.solverTools, this.bindings);

    // Update bindings for cross-query state
    this.turnCounter++;
    if (solverResult.success && solverResult.value !== null && solverResult.value !== undefined) {
      this.bindings.set(`_${this.turnCounter}`, solverResult.value);

      // Handle synthesized functions - store with _fn_ prefix for apply-fn
      if (
        typeof solverResult.value === "object" &&
        solverResult.value !== null &&
        "_type" in solverResult.value &&
        (solverResult.value as { _type: string })._type === "synthesized-fn"
      ) {
        const fnObj = solverResult.value as { _type: string; name: string; fn: unknown; code: string };
        if (typeof fnObj.name === "string" && fnObj.name.length <= 256 && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(fnObj.name)) {
          this.bindings.set(`_fn_${fnObj.name}`, fnObj);
        }
        if (this.verbose) {
          console.log(`[Engine] Registered function "${fnObj.name}" as _fn_${fnObj.name}`);
        }
      } else if (Array.isArray(solverResult.value)) {
        this.bindings.set("RESULTS", solverResult.value);
        if (this.verbose) {
          console.log(`[Engine] Bound ${solverResult.value.length} items to RESULTS and _${this.turnCounter}`);
        }
      } else {
        if (this.verbose) {
          console.log(`[Engine] Bound scalar result to _${this.turnCounter}`);
        }
      }
    }

    // Evict old turn bindings to prevent unbounded growth
    this.evictOldTurnBindings();

    return {
      success: solverResult.success,
      value: solverResult.value,
      logs: solverResult.logs,
      error: solverResult.error,
      type: typeResult.type ? typeToString(typeResult.type) : undefined,
    };
  }

  /**
   * Evict oldest turn bindings (_N) when exceeding the cap
   */
  private evictOldTurnBindings(): void {
    const turnKeys = [...this.bindings.keys()]
      .filter(k => /^_\d+$/.test(k))
      .sort((a, b) => {
        const aNum = parseInt(a.slice(1), 10);
        const bNum = parseInt(b.slice(1), 10);
        if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) return 0;
        if (aNum < bNum) return -1;
        if (aNum > bNum) return 1;
        return 0;
      });
    while (turnKeys.length > NucleusEngine.MAX_TURN_BINDINGS) {
      const oldest = turnKeys.shift()!;
      this.bindings.delete(oldest);
    }
  }

  /**
   * Execute multiple commands in sequence
   *
   * @param commands - Array of Nucleus commands
   * @returns Array of execution results
   */
  executeAll(commands: string[]): ExecutionResult[] {
    return commands.map(cmd => this.execute(cmd));
  }

  /**
   * Get current variable bindings
   */
  getBindings(): Record<string, unknown> {
    const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of this.bindings) {
      if (DANGEROUS_KEYS.has(key)) continue;
      // Summarize arrays to avoid huge output
      if (Array.isArray(value)) {
        result[key] = `Array[${value.length}]`;
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Get a specific binding value
   */
  getBinding(name: string): unknown {
    return this.bindings.get(name);
  }

  /**
   * Set a binding manually
   */
  setBinding(name: string, value: unknown): void {
    if (!name || name.length > 256 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error("Invalid binding name");
    }
    this.bindings.set(name, value);
  }

  /**
   * Reset all bindings (clear state)
   */
  reset(): void {
    this.bindings.clear();
    this.turnCounter = 0;
    if (this.verbose) {
      console.log("[Engine] State reset");
    }
  }

  dispose(): void {
    this.bindings.clear();
    this.turnCounter = 0;
    this.context = "";
    this.solverTools = null;
  }

  /**
   * Get the raw document content
   */
  getContent(): string {
    return this.context;
  }

  /**
   * Get available commands reference
   */
  static getCommandReference(): string {
    return `
Nucleus Command Reference
=========================

SEARCH OPERATIONS (impure - access document):
  (grep "pattern")              Search for regex pattern, returns matches
  (fuzzy_search "query" limit)  Fuzzy search, returns top matches by relevance
  (bm25 "query" limit)          BM25 ranked keyword search, returns by relevance
  (text_stats)                  Get document statistics
  (lines start end)             Get lines in range (1-indexed)

SYMBOL OPERATIONS (requires tree-sitter - .ts, .js, .py, .go, .md, etc.):
  (list_symbols)                List all symbols (functions, classes, methods, headings, etc.)
  (list_symbols "kind")         Filter by kind: "function", "class", "method", "interface", "type", "struct"
  (get_symbol_body "name")      Get source code body for a symbol by name
  (get_symbol_body RESULTS)     Get source code body for symbol from previous query
  (find_references "name")      Find all references to an identifier

FUSION:
  (fuse expr1 expr2 ...)        Fuse results from multiple searches using RRF
                                Example: (fuse (grep "ERROR") (bm25 "error handling"))

COLLECTION OPERATIONS (pure - work on RESULTS):
  (filter RESULTS pred)         Keep items matching predicate
  (map RESULTS transform)       Transform each item
  (count RESULTS)               Count items
  (sum RESULTS)                 Sum numeric values
  (reduce RESULTS init fn)      Generic reduce

PREDICATES (for filter):
  (lambda (x) (match x "pattern" group))   Regex match predicate
  (classify "line1" true "line2" false)    Build classifier from examples

STRING OPERATIONS:
  (match str "pattern" group)   Extract regex group from string
  (replace str "from" "to")     Replace pattern in string
  (split str "delim" index)     Split and get part at index
  (parseInt str)                Parse string to integer
  (parseFloat str)              Parse string to float

TYPE COERCION:
  (parseDate str)               Parse date string to ISO format
  (parseCurrency str)           Parse currency string to number
  (parseNumber str)             Parse numeric string with separators
  (coerce term "type")          Coerce value to type (date/currency/number/boolean/string)

SYNTHESIS:
  (synthesize (example "in1" out1) (example "in2" out2) ...)
                                Synthesize function from examples

VARIABLES (for use in queries):
  RESULTS                       Last array result (auto-bound)
  _1, _2, _3, ...              Results from turn N (auto-bound)
  context                       Raw document content

NOTE: $res1, $res2, etc. are handle stubs for lattice_expand only.
      Use RESULTS or _1, _2, _3 to reference previous results in queries.

SUPPORTED LANGUAGES FOR SYMBOLS:
  TypeScript (.ts, .tsx), JavaScript (.js, .jsx), Python (.py), Go (.go)
`;
  }
}

/**
 * Create a NucleusEngine instance with a document already loaded
 */
export async function createEngine(filePath: string, options?: NucleusEngineOptions): Promise<NucleusEngine> {
  const engine = new NucleusEngine(options);
  await engine.loadFile(filePath);
  return engine;
}

/**
 * Create a NucleusEngine instance from string content
 */
export function createEngineFromContent(content: string, options?: NucleusEngineOptions): NucleusEngine {
  const engine = new NucleusEngine(options);
  engine.loadContent(content);
  return engine;
}
