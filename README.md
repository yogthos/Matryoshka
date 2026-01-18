# Matryoshka

[![Tests](https://github.com/yogthos/Matryoshka/actions/workflows/test.yml/badge.svg)](https://github.com/yogthos/Matryoshka/actions/workflows/test.yml)

Process documents 100x larger than your LLM's context window—without vector databases or chunking heuristics.

## The Problem

LLMs have fixed context windows. Traditional solutions (RAG, chunking) lose information or miss connections across chunks. RLM takes a different approach: the model reasons about your query and outputs symbolic commands that a logic engine executes against the document.

Based on the [Recursive Language Models paper](https://arxiv.org/abs/2512.24601).

## How It Works

Unlike traditional approaches where an LLM writes arbitrary code, RLM uses **[Nucleus](https://github.com/michaelwhitford/nucleus)**—a constrained symbolic language based on S-expressions. The LLM outputs Nucleus commands, which are parsed, type-checked, and executed by **Lattice**, our logic engine.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   User Query    │────▶│   LLM Reasons   │────▶│ Nucleus Command │
│ "total sales?"  │     │  about intent   │     │  (sum RESULTS)  │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
┌─────────────────┐     ┌─────────────────┐     ┌────────▼────────┐
│  Final Answer   │◀────│ Lattice Engine  │◀────│     Parser      │
│   13,000,000    │     │    Executes     │     │    Validates    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Why this works better than code generation:**

1. **Reduced entropy** - Nucleus has a rigid grammar with fewer valid outputs than JavaScript
2. **Fail-fast validation** - Parser rejects malformed commands before execution
3. **Safe execution** - Lattice only executes known operations, no arbitrary code
4. **Small model friendly** - 7B models handle symbolic grammars better than freeform code

## Architecture

### The Nucleus DSL

The LLM outputs commands in the Nucleus DSL—an S-expression language designed for document analysis:

```scheme
; Search for patterns
(grep "SALES_DATA")

; Filter results
(filter RESULTS (lambda x (match x "NORTH" 0)))

; Aggregate
(sum RESULTS)    ; Auto-extracts numbers like "$2,340,000" from lines
(count RESULTS)  ; Count matching items

; Final answer
<<<FINAL>>>13000000<<<END>>>
```

### The Lattice Engine

The Lattice engine (`src/logic/`) processes Nucleus commands:

1. **Parser** (`lc-parser.ts`) - Parses S-expressions into an AST
2. **Type Inference** (`type-inference.ts`) - Validates types before execution
3. **Constraint Resolver** (`constraint-resolver.ts`) - Handles symbolic constraints like `[Σ⚡μ]`
4. **Solver** (`lc-solver.ts`) - Executes commands against the document

Lattice uses **miniKanren** (a relational programming engine) for pattern classification and filtering operations.

### In-Memory Handle Storage

For large result sets, RLM uses a handle-based architecture with in-memory SQLite (`src/persistence/`) that achieves **97%+ token savings**:

```
Traditional:  LLM sees full array    [15,000 tokens for 1000 results]
Handle-based: LLM sees stub          [50 tokens: "$res1: Array(1000) [preview...]"]
```

**How it works:**
1. Results are stored in SQLite with FTS5 full-text indexing
2. LLM receives only handle references (`$res1`, `$res2`, etc.)
3. Operations execute server-side, returning new handles
4. Full data is only materialized when needed

**Components:**
- `SessionDB` - In-memory SQLite with FTS5 for fast full-text search
- `HandleRegistry` - Stores arrays, returns compact handle references
- `HandleOps` - Server-side filter/map/count/sum on handles
- `FTS5Search` - Phrase queries, boolean operators, relevance ranking
- `CheckpointManager` - Save/restore session state

### The Role of the LLM

The LLM does **reasoning**, not code generation:

1. **Understands intent** - Interprets "total of north sales" as needing grep + filter + sum
2. **Chooses operations** - Decides which Nucleus commands achieve the goal
3. **Verifies results** - Checks if the current results answer the query
4. **Iterates** - Refines search if results are too broad or narrow

The LLM never writes JavaScript. It outputs Nucleus commands that Lattice executes safely.

### Components Summary

| Component | Purpose |
|-----------|---------|
| **Nucleus Adapter** | Prompts LLM to output Nucleus commands |
| **Lattice Parser** | Parses S-expressions to AST |
| **Lattice Solver** | Executes commands against document |
| **In-Memory Handles** | Handle-based storage with FTS5 (97% token savings) |
| **miniKanren** | Relational engine for classification |
| **RAG Hints** | Few-shot examples from past successes |

## Installation

Install from npm:

```bash
npm install -g matryoshka-rlm
```

Or run without installing:

```bash
npx matryoshka-rlm "What is the total of all sales values?" ./report.txt
```

### Included Tools

The package provides several CLI tools:

| Command | Description |
|---------|-------------|
| `rlm` | Main CLI for document analysis with LLM reasoning |
| `lattice-mcp` | MCP server exposing direct Nucleus commands (no LLM required) |
| `lattice-repl` | Interactive REPL for Nucleus commands |
| `lattice-http` | HTTP server for Nucleus queries |
| `lattice-pipe` | Pipe adapter for programmatic access |
| `lattice-setup` | Setup script for Claude Code integration |

### From Source

```bash
git clone https://github.com/yogthos/Matryoshka.git
cd Matryoshka
npm install
npm run build
```

## Configuration

Copy `config.example.json` to `config.json` and configure your LLM provider:

```json
{
  "llm": {
    "provider": "ollama"
  },
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "model": "qwen2.5-coder:7b",
      "options": { "temperature": 0.2, "num_ctx": 8192 }
    },
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "model": "deepseek-chat",
      "options": { "temperature": 0.2 }
    }
  }
}
```

## Usage

### CLI

```bash
# Basic usage
rlm "What is the total of all sales values?" ./report.txt

# With options
rlm "Count all ERROR entries" ./logs.txt --max-turns 15 --verbose

# See all options
rlm --help
```

### MCP Integration

RLM includes `lattice-mcp`, an MCP (Model Context Protocol) server for direct access to the Nucleus engine. This allows coding agents to analyze documents with **80%+ token savings** compared to reading files directly.

The key advantage is **handle-based results**: query results are stored server-side in SQLite, and the agent receives compact stubs like `$res1: Array(1000) [preview...]` instead of full data. Operations chain server-side without roundtripping data.

#### Available Tools

| Tool | Description |
|------|-------------|
| `lattice_load` | Load a document for analysis |
| `lattice_query` | Execute Nucleus commands on the loaded document |
| `lattice_expand` | Expand a handle to see full data (with optional limit/offset) |
| `lattice_close` | Close the session and free memory |
| `lattice_status` | Get session status and document info |
| `lattice_bindings` | Show current variable bindings |
| `lattice_reset` | Reset bindings but keep document loaded |
| `lattice_help` | Get Nucleus command reference |

#### Example MCP config

```json
{
  "mcp": {
    "lattice": {
      "type": "stdio",
      "command": "lattice-mcp"
    }
  }
}
```

#### Efficient Usage Pattern

```
1. lattice_load("/path/to/large-file.txt")   # Load document (use for >500 lines)
2. lattice_query('(grep "ERROR")')           # Search - returns handle stub $res1
3. lattice_query('(filter RESULTS ...)')     # Narrow down - returns handle stub $res2
4. lattice_query('(count RESULTS)')          # Get count without seeing data
5. lattice_expand("$res2", limit=10)         # Expand only what you need to see
6. lattice_close()                           # Free memory when done
```

**Token efficiency tips:**
- Query results return handle stubs, not full data
- Use `lattice_expand` with `limit` to see only what you need
- Chain `grep → filter → count/sum` to refine progressively
- Use `RESULTS` in queries (always points to last result)
- Use `$res1`, `$res2` etc. with `lattice_expand` to inspect specific results

### Programmatic

```typescript
import { runRLM } from "matryoshka-rlm/rlm";
import { createLLMClient } from "matryoshka-rlm";

const llmClient = createLLMClient("ollama", {
  baseUrl: "http://localhost:11434",
  model: "qwen2.5-coder:7b",
  options: { temperature: 0.2 }
});

const result = await runRLM("What is the total of all sales values?", "./report.txt", {
  llmClient,
  maxTurns: 10,
  turnTimeoutMs: 30000,
});
```

## Example Session

```
$ rlm "What is the total of all north sales data values?" ./report.txt --verbose

──────────────────────────────────────────────────
[Turn 1/10] Querying LLM...
[Turn 1] Term: (grep "SALES.*NORTH")
[Turn 1] Result: 1 matches

──────────────────────────────────────────────────
[Turn 2/10] Querying LLM...
[Turn 2] Term: (sum RESULTS)
[Turn 2] Console output:
  [Lattice] Summing 1 values
  [Lattice] Sum = 2340000
[Turn 2] Result: 2340000

──────────────────────────────────────────────────
[Turn 3/10] Querying LLM...
[Turn 3] Final answer received

2340000
```

The model:
1. Searched for relevant data with grep
2. Summed the matching results
3. Output the final answer

## Nucleus DSL Reference

### Search Commands

```scheme
(grep "pattern")              ; Regex search, returns matches with line numbers
(fuzzy_search "query" 10)     ; Fuzzy search, returns top N matches with scores
(text_stats)                  ; Document metadata (length, line count, samples)
```

### Symbol Operations (Code Files)

For code files, Lattice uses tree-sitter to extract structural symbols. This enables code-aware queries that understand functions, classes, methods, and other language constructs.

**Built-in languages (packages included):**
- TypeScript (.ts, .tsx), JavaScript (.js, .jsx), Python (.py), Go (.go)
- HTML (.html), CSS (.css), JSON (.json)

**Additional languages (install package to enable):**
- Rust, C, C++, Java, Ruby, PHP, C#, Kotlin, Swift, Scala, Lua, Haskell, Bash, SQL, and more

```scheme
(list_symbols)                ; List all symbols (functions, classes, methods, etc.)
(list_symbols "function")     ; Filter by kind: "function", "class", "method", "interface", "type", "struct"
(get_symbol_body "myFunc")    ; Get source code body for a symbol by name
(get_symbol_body RESULTS)     ; Get body for symbol from previous query result
(find_references "myFunc")    ; Find all references to an identifier
```

**Example workflow for code analysis:**

```
1. lattice_load("./src/app.ts")           # Load a code file
2. lattice_query('(list_symbols)')        # Get all symbols → $res1
3. lattice_query('(list_symbols "function")')  # Just functions → $res2
4. lattice_expand("$res2", limit=5)       # See function names and line numbers
5. lattice_query('(get_symbol_body "handleRequest")')  # Get function body
6. lattice_query('(find_references "handleRequest")')  # Find all usages
```

Symbols include metadata like name, kind, start/end lines, and parent relationships (e.g., methods within classes).

#### Adding Language Support

Matryoshka includes built-in symbol mappings for 20+ languages. To enable a language, install its tree-sitter grammar package:

```bash
# Enable Rust support
npm install tree-sitter-rust

# Enable Java support
npm install tree-sitter-java

# Enable Ruby support
npm install tree-sitter-ruby
```

**Languages with built-in mappings:**
- TypeScript, JavaScript, Python, Go, Rust, C, C++, Java
- Ruby, PHP, C#, Kotlin, Swift, Scala, Lua, Haskell, Elixir
- HTML, CSS, JSON, YAML, TOML, Markdown, SQL, Bash

Once a package is installed, the language is automatically available for symbol extraction.

#### Custom Language Configuration

For languages without built-in mappings, or to override existing mappings, create a config file at `~/.matryoshka/config.json`:

```json
{
  "grammars": {
    "mylang": {
      "package": "tree-sitter-mylang",
      "extensions": [".ml", ".mli"],
      "moduleExport": "mylang",
      "symbols": {
        "function_definition": "function",
        "method_definition": "method",
        "class_definition": "class",
        "module_definition": "module"
      }
    }
  }
}
```

**Configuration fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `package` | Yes | npm package name for the tree-sitter grammar |
| `extensions` | Yes | File extensions to associate with this language |
| `symbols` | Yes | Maps tree-sitter node types to symbol kinds |
| `moduleExport` | No | Submodule export name (e.g., `"typescript"` for tree-sitter-typescript) |

**Symbol kinds:** `function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `module`, `variable`, `constant`, `property`

#### Finding Tree-sitter Node Types

To configure symbol mappings for a new language, you need to know the tree-sitter node types. You can explore them using the tree-sitter CLI:

```bash
# Install tree-sitter CLI
npm install -g tree-sitter-cli

# Parse a sample file and see the AST
tree-sitter parse sample.mylang
```

Or use the [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/playground) to explore node types interactively.

**Example: Adding OCaml support**

1. Find the grammar package: `tree-sitter-ocaml`
2. Install it: `npm install tree-sitter-ocaml`
3. Explore the AST to find node types for functions, modules, etc.
4. Add to `~/.matryoshka/config.json`:

```json
{
  "grammars": {
    "ocaml": {
      "package": "tree-sitter-ocaml",
      "extensions": [".ml", ".mli"],
      "moduleExport": "ocaml",
      "symbols": {
        "value_definition": "function",
        "let_binding": "variable",
        "type_definition": "type",
        "module_definition": "module",
        "module_type_definition": "interface"
      }
    }
  }
}
```

**Note:** Some tree-sitter packages use native Node.js bindings that may not compile on all systems. If installation fails, check if the package supports your Node.js version or look for WASM alternatives.

### Collection Operations

```scheme
(filter RESULTS (lambda x (match x "pattern" 0)))  ; Filter by regex
(map RESULTS (lambda x (match x "(\\d+)" 1)))      ; Extract from each
(sum RESULTS)                                       ; Sum numbers in results
(count RESULTS)                                     ; Count items
```

### String Operations

```scheme
(match str "pattern" 0)       ; Regex match, return group N
(replace str "from" "to")     ; String replacement
(split str "," 0)             ; Split and get index
(parseInt str)                ; Parse integer
(parseFloat str)              ; Parse float
```

### Type Coercion

When the model sees data that needs parsing, it can use declarative type coercion:

```scheme
; Date parsing (returns ISO format YYYY-MM-DD)
(parseDate "Jan 15, 2024")           ; -> "2024-01-15"
(parseDate "01/15/2024" "US")        ; -> "2024-01-15" (MM/DD/YYYY)
(parseDate "15/01/2024" "EU")        ; -> "2024-01-15" (DD/MM/YYYY)

; Currency parsing (handles $, €, commas, etc.)
(parseCurrency "$1,234.56")          ; -> 1234.56
(parseCurrency "€1.234,56")          ; -> 1234.56 (EU format)

; Number parsing
(parseNumber "1,234,567")            ; -> 1234567
(parseNumber "50%")                  ; -> 0.5

; General coercion
(coerce value "date")                ; Coerce to date
(coerce value "currency")            ; Coerce to currency
(coerce value "number")              ; Coerce to number

; Extract and coerce in one step
(extract str "\\$[\\d,]+" 0 "currency")  ; Extract and parse as currency
```

Use in map for batch transformations:

```scheme
; Parse all dates in results
(map RESULTS (lambda x (parseDate (match x "[A-Za-z]+ \\d+, \\d+" 0))))

; Extract and sum currencies
(map RESULTS (lambda x (parseCurrency (match x "\\$[\\d,]+" 0))))
```

### Program Synthesis

For complex transformations, the model can synthesize functions from examples:

```scheme
; Synthesize from input/output pairs
(synthesize
  ("$100" 100)
  ("$1,234" 1234)
  ("$50,000" 50000))
; -> Returns a function that extracts numbers from currency strings
```

This uses Barliman-style relational synthesis with miniKanren to automatically build extraction functions.

### Cross-Turn State

Results from previous turns are available:
- `RESULTS` - Latest array result (updated by grep, filter)
- `_0`, `_1`, `_2`, ... - Results from specific turns

### Final Answer

```scheme
<<<FINAL>>>your answer here<<<END>>>
```

## Troubleshooting

### Model Answers Without Exploring

**Symptom**: The model provides an answer immediately with hallucinated data.

**Solutions**:
1. Use a more capable model (7B+ recommended)
2. Be specific in your query: "Find lines containing SALES_DATA and sum the dollar amounts"

### Max Turns Reached

**Symptom**: "Max turns (N) reached without final answer"

**Solutions**:
1. Increase `--max-turns` for complex documents
2. Check `--verbose` output for repeated patterns (model stuck in loop)
3. Simplify the query

### Parse Errors

**Symptom**: "Parse error: no valid command"

**Cause**: Model output malformed S-expression.

**Solutions**:
1. The system auto-converts JSON to S-expressions as fallback
2. Use `--verbose` to see what the model is generating
3. Try a different model tuned for code/symbolic output

## Development

```bash
npm test                              # Run tests
npm test -- --coverage                # With coverage
RUN_E2E=1 npm test -- tests/e2e.test.ts  # E2E tests (requires Ollama)
npm run build                         # Build
npm run typecheck                     # Type check
```

## Project Structure

```
src/
├── adapters/           # Model-specific prompting
│   ├── nucleus.ts      # Nucleus DSL adapter
│   └── types.ts        # Adapter interface
├── logic/              # Lattice engine
│   ├── lc-parser.ts    # Nucleus parser
│   ├── lc-solver.ts    # Command executor (uses miniKanren)
│   ├── type-inference.ts
│   └── constraint-resolver.ts
├── persistence/        # In-memory handle storage (97% token savings)
│   ├── session-db.ts   # In-memory SQLite with FTS5
│   ├── handle-registry.ts  # Handle creation and stubs
│   ├── handle-ops.ts   # Server-side operations
│   ├── fts5-search.ts  # Full-text search
│   └── checkpoint.ts   # Session persistence
├── treesitter/         # Code-aware symbol extraction
│   ├── parser-registry.ts  # Tree-sitter parser management
│   ├── symbol-extractor.ts # AST → symbol extraction
│   ├── language-map.ts # Extension → language mapping
│   └── types.ts        # Symbol interfaces
├── engine/             # Nucleus execution engine
│   ├── nucleus-engine.ts
│   └── handle-session.ts   # Session with symbol support
├── minikanren/         # Relational programming engine
├── synthesis/          # Program synthesis (Barliman-style)
│   └── evalo/          # Extractor DSL
├── rag/                # Few-shot hint retrieval
└── rlm.ts              # Main execution loop
```

## Acknowledgements

This project incorporates ideas and code from:

- **[Nucleus](https://github.com/michaelwhitford/nucleus)** - A symbolic S-expression language by Michael Whitford. RLM uses Nucleus syntax for the constrained DSL that the LLM outputs, providing a rigid grammar that reduces model errors.
- **[ramo](https://github.com/wjlewis/ramo)** - A miniKanren implementation in TypeScript by Will Lewis. Used for constraint-based program synthesis.
- **[Barliman](https://github.com/webyrd/Barliman)** - A prototype smart editor by William Byrd and Greg Rosenblatt that uses program synthesis to assist programmers. The Barliman-style approach of providing input/output constraints instead of code inspired the synthesis workflow.
- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** - A parser generator tool and incremental parsing library. Used for extracting structural symbols (functions, classes, methods) from code files to enable code-aware queries.

## License

MIT

## References

- [RLM Paper](https://arxiv.org/abs/2512.24601)
- [Original Implementation](https://github.com/alexzhang13/rlm)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [miniKanren](http://minikanren.org/)
