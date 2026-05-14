# Matryoshka

[![Tests](https://github.com/yogthos/Matryoshka/actions/workflows/test.yml/badge.svg)](https://github.com/yogthos/Matryoshka/actions/workflows/test.yml)
[![SafeSkill 88/100](https://img.shields.io/badge/SafeSkill-88%2F100_Passes%20with%20Notes-yellow)](https://safeskill.dev/scan/yogthos-matryoshka)

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
(grep "ERROR")

; Filter results
(filter RESULTS (lambda x (match x "timeout" 0)))

; Aggregate
(sum RESULTS)    ; Auto-extracts numbers from lines
(count RESULTS)  ; Count matching items

; Final answer
<<<FINAL>>>13000000<<<END>>>
```

#### Feature availability by execution path

Matryoshka has two execution paths and not every primitive works in both:

| Feature | `runRLM` (CLI / programmatic) | `lattice-mcp` (MCP server) |
|---|---|---|
| `(grep …)`, `(filter …)`, `(map …)`, etc. | ✅ | ✅ |
| `(llm_query …)`, `(llm_batch …)` | ✅ | ✅ via MCP sampling protocol |
| `(rlm_query …)`, `(rlm_batch …)` | ✅ (concurrent rlm_batch) | ✅ — child Nucleus session spawns via the same MCP sampling bridge; M suspensions per `rlm_query` call. `rlm_batch` runs **sequentially** (children one at a time) because the multi-turn suspension protocol only carries one pending request at a time — concurrent children would lose suspensions. Round-trip count is the same; wall-clock is N×slower for non-sampling clients. |
| `(context N)` selector | ✅ (multi-doc via `runRLMFromContent(query, string[])`) | partial — `(context 0)` works; multi-doc loading not exposed via `lattice_load` |
| `(grep "X" haystack)` | ✅ | ✅ |
| `(show_vars)` | ✅ | ✅ (internal `_<name>` bindings filtered out) |
| `FINAL_VAR(name)` resolution | ✅ | N/A — MCP returns query results directly |
| `maxTimeoutMs` / `maxTokens` / `maxErrors` | ✅ | ❌ — MCP has its own session timeout |
| `compactionThresholdChars` | ✅ | ❌ — MCP doesn't have a multi-turn FSM history |

The resource-limit features remain `runRLM`-only. The recursive primitives (`rlm_query`/`rlm_batch`) work in both paths — the MCP path spawns a child `runRLMFromContent` whose `llmClient` is the same sampling bridge as the parent, so each child turn flows through the existing MCP suspension/sampling protocol.

#### Recursive Primitives

`rlm_query` spawns a child Nucleus session with its own FSM loop. The child runs to FINAL and returns a string — useful when a sub-task needs multi-turn reasoning over a structured handle:

```scheme
; Child sees the resolved handle as its working document, NOT a
; JSON-stringified prompt blob. Lets the child use grep/lines/
; chunk_by_lines over arrays without JSON-syntax noise.
(rlm_query "extract dates" (context RESULTS))

; No (context …) → child's document is the prompt itself.
(rlm_query "summarize each error type")
```

`rlm_batch` runs the same per-item recursion across a collection. Each item produces one entry in the returned array, in input order. Per-item failures surface as `"Error: rlm_batch item N failed — …"` strings without aborting the rest of the batch:

```scheme
(rlm_batch (chunk_by_lines 100)
  (lambda c (rlm_query "extract metrics" (context c))))
```

- **`runRLM`**: children fan out concurrently via a worker pool capped at `maxConcurrentSubcalls` (default 4).
- **`lattice-mcp`**: children run **sequentially** because the multi-turn suspension protocol can carry only one pending request at a time. Round-trip count is identical to the concurrent path (N children × M turns each); only wall-clock differs.

#### Multi-Context Loading

Pass `string[]` to `runRLMFromContent` to load multiple documents. Address them via `(context N)`; index 0 is the default for primitives that don't specify a haystack:

```scheme
(grep "DEPLOY" (context 0))   ; deploy.log
(grep "OUTAGE" (context 2))   ; comms.log

; (context N) is just a term — pipe it anywhere a string is expected
(rlm_query "scan" (context (context 1)))   ; child sees doc 1
```

Per-doc line numbers come back, so the LLM can cite "doc 0 line 4, doc 2 line 2" with confidence rather than inventing absolute offsets across a concatenation.

#### Introspection

```scheme
(show_vars)   ; Returns a string summary of every binding currently
              ; in scope. Useful before a (filter RESULTS …) or a
              ; FINAL_VAR(name) reference when the LLM lost track of
              ; what's bound. Same surface as the `lattice_bindings`
              ; MCP tool but reachable from inside a query.
```

Unknown FINAL_VAR markers surface a clear error rather than passing the literal text through:

```
<<<FINAL>>>FINAL_VAR(_99)<<<END>>>
→ "[FINAL_VAR error: unknown binding "_99". Available: _1, RESULTS]"
```

#### Resource Limits

All optional. With none set, behavior is unchanged:

```typescript
runRLM(query, file, {
  maxTimeoutMs: 30_000,    // wall-clock cap, propagates to children
  maxTokens: 100_000,      // cumulative chars sent + received
  maxErrors: 5,            // consecutive parse/execution errors
  compactionThresholdChars: 50_000,  // summarize history when prompt grows past this
})
```

When a limit hits, the run terminates cleanly with a string of the form:

```
[aborted: timeout 32100ms of 30000ms]

Best partial answer:
<the most recent meaningful solver result>
```

The partial answer is always preserved when present — completed work is never silently lost on abort.

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
Handle-based: LLM sees stub          [50 tokens: "$grep_error: Array(1000) [preview...]"]
```

**How it works:**
1. Results are stored in SQLite with FTS5 full-text indexing
2. LLM receives descriptive handle references derived from the command (e.g., `$grep_error`, `$bm25_timeout`, `$filter_status`)
3. Operations execute server-side, returning new handles
4. Full data is only materialized when needed

Handle names are auto-generated from the Nucleus command: `(grep "ERROR")` produces `$grep_error`, `(list_symbols "function")` produces `$list_symbols_function`. Repeated commands get a numeric suffix (`$grep_error_2`, `$grep_error_3`).

### Memory Pad

The Lattice engine doubles as a **context memory** for LLM agents. Instead of roundtripping large text blobs in every message, agents stash context server-side and carry only compact handle stubs:

```
Agent reads file, summarizes → lattice_memo "auth architecture"
                              → $memo_auth_architecture: "auth architecture" (2.1KB, 50 lines)

20 messages later, needs it  → lattice_expand $memo_auth_architecture
                              → Full 50-line summary
```

**Token math** (30-message session, 3 source files stashed):
- Traditional roundtripping: **836K tokens**
- Memo-based (stubs + 6 expands): **57K tokens** — **93% savings**

Memos persist across document loads (`lattice_load` clears query handles but keeps memos), support LRU eviction (100 memo cap, 10MB budget), and can be explicitly deleted when stale. No document needs to be loaded to use memos.

### The Role of the LLM

The LLM does **reasoning**, not code generation:

1. **Understands intent** - Interprets "total of north sales" as needing grep + filter + sum
2. **Chooses operations** - Decides which Nucleus commands achieve the goal
3. **Verifies results** - Checks if the current results answer the query
4. **Iterates** - Refines search if results are too broad or narrow

The LLM never writes JavaScript. It outputs Nucleus commands that Lattice executes safely.

## Installation

Install from npm:

```bash
pnpm add -g matryoshka-rlm
```

Or run without installing:

```bash
npx matryoshka-rlm "How many ERROR entries are there?" ./server.log
```

### Included Tools

The package provides several CLI tools:

| Command | Description |
|---------|-------------|
| `rlm` | Main CLI for document analysis with LLM reasoning |
| `rlm-mcp` | MCP server with full RLM + LLM orchestration (`analyze_document` tool) |
| `lattice-mcp` | MCP server exposing direct Nucleus commands (no LLM required) |
| `lattice-repl` | Interactive REPL for Nucleus commands |
| `lattice-http` | HTTP server for Nucleus queries |
| `lattice-pipe` | Pipe adapter for programmatic access |
| `lattice-setup` | Setup script for Claude Code integration |

### From Source

```bash
git clone https://github.com/yogthos/Matryoshka.git
cd Matryoshka
pnpm install
pnpm run build
```

## Configuration

Copy `config.example.json` to `~/.config/matryoshka/config.json`:

```json
{
  "llm": {
    "provider": "ollama"
  },
  "providers": {
    "ollama": {
      "url": "http://localhost:11434/api/generate",
      "model": "qwen3-coder:30b",
      "options": { "temperature": 0.2, "num_ctx": 8192 }
    },
    "deepseek": {
      "url": "https://api.deepseek.com/chat/completions",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "model": "deepseek-chat",
      "options": { "temperature": 0.2 }
    },
    "glm": {
      "url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      "apiKey": "${ZHIPU_API_KEY}",
      "model": "glm-4-plus",
      "options": { "temperature": 0.2 }
    }
  },
  "rlm": {
    "maxTurns": 10
  },
  "grammars": {
    "ocaml": {
      "package": "tree-sitter-ocaml",
      "extensions": [".ml", ".mli"],
      "moduleExport": "ocaml",
      "symbols": {
        "value_definition": "function",
        "type_definition": "type",
        "module_definition": "module"
      }
    }
  }
}
```

- **`llm` / `providers` / `rlm`** — LLM provider selection and RLM tuning (shown above with example providers). Each provider takes a full `url` (the complete API endpoint), an optional `apiKey` (supports `${ENV_VAR}` interpolation), a `model` name, and `options`.
- **`grammars`** — custom tree-sitter language mappings for symbol extraction (see [Adding Language Support](#adding-language-support) for the full list of built-in languages). Use the [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/playground) to explore node types for your language.

## Usage

### CLI

```bash
# Basic usage
rlm "How many ERROR entries are there?" ./server.log

# With options
rlm "Count all ERROR entries" ./server.log --max-turns 15 --verbose

# See all options
rlm --help
```

### MCP Integration

RLM includes `lattice-mcp`, an MCP (Model Context Protocol) server for direct access to the Nucleus engine. This allows coding agents to analyze documents with **80%+ token savings** compared to reading files directly.

The key advantage is **handle-based results**: query results are stored server-side in SQLite, and the agent receives compact stubs like `$grep_error: Array(1000) [preview...]` instead of full data. Handle names are derived from the command for easy identification. Operations chain server-side without roundtripping data.

#### Available Tools

| Tool | Description |
|------|-------------|
| `lattice_load` | Load a document for analysis |
| `lattice_query` | Execute Nucleus commands on the loaded document |
| `lattice_expand` | Expand a handle to see full data (with optional limit/offset) |
| `lattice_memo` | Store arbitrary context as a memo handle (no document required) |
| `lattice_memo_delete` | Delete a stale memo to free memory |
| `lattice_close` | Close the session and free memory |
| `lattice_status` | Get session status, document info, and memo usage |
| `lattice_bindings` | Show current variable bindings and memo labels |
| `lattice_reset` | Reset all bindings and memos but keep document loaded |
| `lattice_llm_respond` | Respond to a pending `(llm_query ...)` suspension |
| `lattice_llm_batch_respond` | Respond to a pending `(llm_batch ...)` suspension with all N responses |
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
2. lattice_query('(grep "ERROR")')           # Search → $grep_error: Array(500) [preview]
3. lattice_query('(filter RESULTS ...)')     # Narrow → $filter_timeout: Array(50) [preview]
4. lattice_query('(count RESULTS)')          # Count without seeing data → 50
5. lattice_expand("$filter_timeout", limit=10) # Expand only what you need to see
6. lattice_close()                           # Free memory when done
```

**Token efficiency tips:**
- Query results return descriptive handle stubs, not full data
- Use `lattice_expand` with `limit` to see only what you need
- Chain `grep → filter → count/sum` to refine progressively
- Use `RESULTS` in queries (always points to last result)
- Use descriptive handle names (e.g., `$grep_error`) with `lattice_expand` to inspect specific results

#### Chunking and Sub-LLM Recursion

Two primitive families power the paper's `Ω(|P|²)` semantic-horizon pattern:

**Chunking** — pre-slice a document that's too big to map over directly:

```scheme
(chunk_by_size 2000)                ; 2000-character slices
(chunk_by_lines 100)                ; 100-line slices
(chunk_by_regex "\\n\\n")           ; Split on blank lines; capture groups ignored
```

**Sub-LLM calls** — `(llm_query ...)` invokes a sub-LLM with an
interpolated prompt. Works at the top level and nested inside
`map` / `filter` / `reduce` lambdas:

```scheme
(llm_query "Summarize this")                                         ; bare
(llm_query "Classify: {items}" (items RESULTS))                      ; with binding
(map (chunk_by_lines 100)
     (lambda c (llm_query "summarize: {chunk}" (chunk c))))           ; OOLONG
(filter RESULTS (lambda x (match (llm_query "keep?: {item}" (item x)) "keep" 0)))
```

The last two patterns fire **one sub-LLM call per item** — classification
or summarization over an entire document, one chunk at a time, without
pulling any of it into the root model's context.

**Batched sub-LLM** — when per-item calls are independent, `llm_batch`
collapses N serial suspensions into one:

```scheme
(llm_batch RESULTS (lambda x (llm_query "tag: {item}" (item x))))
```

Same surface syntax as `map` + `llm_query`, but fires a single
`[LLM_BATCH_REQUEST id=... count=N]` suspension. The client replies once
with a JSON array of N responses via `lattice_llm_batch_respond`.
~92% round-trip reduction on N=12, ~99% on N=100.

**Constrain responses with `(one_of ...)`** for classification tasks:

```scheme
(llm_batch RESULTS
  (lambda x (llm_query "Rate: {item}" (item x)
                       (one_of "low" "medium" "high"))))
```

Validates responses case-insensitively against the allowed values,
making downstream `(filter ...)` / `(count ...)` reliable without
re-normalizing free-text output.

**Add `(calibrate)` for subjective-judgment tasks:**

```scheme
(llm_batch RESULTS
  (lambda x (llm_query "Rate: {item}" (item x)
                       (one_of "low" "medium" "high")
                       (calibrate))))
```

Asks the model to scan all N prompts and establish a consistent relative
scale before answering any. Useful when ratings depend on the distribution
of the corpus rather than being absolute.

**Multi-turn suspension protocol (works with any MCP client):**

When `(llm_query ...)` is evaluated, execution suspends and returns a
`[LLM_QUERY_REQUEST id=...]` message. The MCP client responds via
`lattice_llm_respond` to resume execution. For queries with multiple
`llm_query` calls (e.g., inside `map`), each item triggers one
suspension — respond to each in turn until the final handle stub or
scalar is returned. No special client capabilities (like `sampling`)
are required.

For the native recursive sub-RLM implementation,
use `runRLMFromContent(query, content, { subRLMMaxDepth: 1 })` directly
from the programmatic API — see the Programmatic section below.

#### Memory Pad Usage

```
1. lattice_memo(content="<file summary>", label="auth module")  → $memo_auth_module stub
2. lattice_memo(content="<analysis>", label="perf bottlenecks") → $memo_perf_bottlenecks stub
3. # ... many turns later, need the auth context ...
4. lattice_expand("$memo_auth_module")                          → Full summary
5. lattice_memo_delete("$memo_auth_module")                     → Drop when stale
```

Memos don't require a loaded document — they create a session automatically.
Limits: 100 memos, 10MB total. Oldest evicted when exceeded.

### Programmatic

```typescript
import { runRLM } from "matryoshka-rlm/rlm";
import { createLLMClient } from "matryoshka-rlm";

const llmClient = createLLMClient("ollama", {
  url: "http://localhost:11434/api/generate",
  model: "qwen3-coder:30b",
  options: { temperature: 0.2 }
});

const result = await runRLM("How many ERROR entries are there?", "./server.log", {
  llmClient,
  maxTurns: 10,
  turnTimeoutMs: 30000,
});
```

## Nucleus DSL Reference

### Search Commands

```scheme
(grep "pattern")              ; Regex search, returns matches with line numbers
(fuzzy_search "query" 10)     ; Fuzzy search, returns top N matches with scores
(bm25 "query terms" 10)      ; BM25 ranked keyword search (TF-IDF scoring)
(semantic "query terms" 10)   ; TF-IDF cosine similarity search
(text_stats)                  ; Document metadata (length, line count, samples)
(lines 10 20)                 ; Get specific line range (1-indexed)
```

### Multi-Signal Fusion & Ranking

Combine results from multiple search operations for better relevance:

```scheme
;; Reciprocal Rank Fusion — merge results from different search signals
(fuse (grep "ERROR") (bm25 "error handling") (semantic "failure"))

;; Gravity dampening — halve scores for false positives lacking query term overlap
(dampen (bm25 "database error") "database error")

;; Q-value reranking — learns which lines are useful across turns
(rerank (fuse (grep "ERROR") (bm25 "error")))

;; Full pipeline: fuse → dampen → rerank
(rerank (dampen (fuse (grep "ERROR") (bm25 "error") (semantic "failure")) "error"))
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

Symbols include metadata like name, kind, start/end lines, and parent relationships (e.g., methods within classes).

### Knowledge Graph (Code Structure)

When a code file is loaded, Lattice automatically builds an in-memory knowledge graph that tracks call relationships, inheritance, and interface implementations. This enables structural queries beyond simple text search.

```scheme
(callers "funcName")            ; Who calls this function?
(callees "funcName")            ; What does this function call?
(ancestors "ClassName")         ; Inheritance chain (extends)
(descendants "ClassName")       ; All subclasses (transitive)
(implementations "IFace")       ; Classes implementing this interface
(dependents "name")             ; All transitive dependents
(dependents "name" 2)           ; Dependents within depth limit
(symbol_graph "name" 1)         ; Neighborhood subgraph around symbol
```

The graph is built using line-based heuristics (word-boundary matching for calls, syntax pattern matching for extends/implements), so it produces approximate but useful results without requiring a full language server.

#### Graph Analysis

Community detection and structural insights help you understand codebase architecture:

```scheme
(communities)                   ; Detect communities with cohesion scores
(community_of "name")           ; Which community does this symbol belong to?
(god_nodes)                     ; Top 10 most-connected nodes (hubs)
(god_nodes 5)                   ; Top N most-connected nodes
(surprising_connections)         ; Cross-community or low-confidence edges
(bridge_nodes)                  ; Nodes bridging different communities
(suggest_questions)             ; Questions the graph can answer
(graph_report)                  ; Full analysis (all of the above)
```

#### Adding Language Support

Matryoshka includes built-in symbol mappings for 20+ languages. To enable a language, install its tree-sitter grammar package:

```bash
# Enable Rust support
pnpm add tree-sitter-rust

# Enable Java support
pnpm add tree-sitter-java

# Enable Ruby support
pnpm add tree-sitter-ruby
```

**Languages with built-in mappings:**
- TypeScript, JavaScript, Python, Go, Rust, C, C++, Java
- Ruby, PHP, C#, Kotlin, Swift, Scala, Lua, Haskell, Elixir
- HTML, CSS, JSON, YAML, TOML, Markdown, SQL, Bash

Once a package is installed, the language is automatically available for symbol extraction.

#### Custom Language Configuration

For languages without built-in mappings, add a `grammars` entry to your config — see the [Configuration](#configuration) section for the full example and details.

### Control Flow

```scheme
(if (count RESULTS) (sum RESULTS) 0)  ; Conditional: if/then/else
(add 10 20)                           ; Arithmetic addition
```

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

```scheme
(parseDate "Jan 15, 2024")           ; -> "2024-01-15"
(parseDate "01/15/2024" "US")        ; -> "2024-01-15" (MM/DD/YYYY)
(parseCurrency "$1,234.56")          ; -> 1234.56
(parseNumber "1,234,567")            ; -> 1234567
(coerce value "date")                ; General coercion (date/currency/number/boolean/string)
(extract str "\\$[\\d,]+" 0 "currency")  ; Extract and coerce in one step
```

### Program Synthesis

The model provides constraints (input/output examples), not code — the synthesizer builds programs automatically using Barliman-style relational synthesis with miniKanren.

```scheme
; Synthesize from input/output pairs
(synthesize
  ("$100" 100)
  ("$1,234" 1234)
  ("$50,000" 50000))

; Named functions — synthesize once, apply many times
(define-fn "parse_price" (("$100" 100) ("$1,234" 1234)))
(apply-fn "parse_price" "$50,000")    ; -> 50000

; Boolean classifiers from examples
(predicate "is_error" (("ERROR: timeout" true) ("INFO: ok" false)))
```

### Cross-Turn State

Results from previous turns are available:
- `RESULTS` - Latest array result (updated by grep, filter)
- `_1`, `_2`, `_3`, ... - Results from specific turns (1-indexed)

### Final Answer

```scheme
<<<FINAL>>>your answer here<<<END>>>
```

## Development

```bash
pnpm test                              # Run tests
pnpm test -- --coverage                # With coverage
RUN_E2E=1 pnpm test -- tests/e2e.test.ts  # E2E tests (requires Ollama)
pnpm run build                         # Build
pnpm run typecheck                     # Type check
```

## Acknowledgements

This project incorporates ideas and code from:

- **[Ori-Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos)** - A persistent memory infrastructure for AI agents implementing the Recursive Memory Harness framework. BM25 search, Reciprocal Rank Fusion, gravity dampening, and Q-value learning reranking were ported from Ori-Mnemos and adapted for line-based document analysis.
- **[Nucleus](https://github.com/michaelwhitford/nucleus)** - A symbolic S-expression language by Michael Whitford. RLM uses Nucleus syntax for the constrained DSL that the LLM outputs, providing a rigid grammar that reduces model errors.
- **[ramo](https://github.com/wjlewis/ramo)** - A miniKanren implementation in TypeScript by Will Lewis. Used for constraint-based program synthesis.
- **[Barliman](https://github.com/webyrd/Barliman)** - A prototype smart editor by William Byrd and Greg Rosenblatt that uses program synthesis to assist programmers. The Barliman-style approach of providing input/output constraints instead of code inspired the synthesis workflow.
- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** - A parser generator tool and incremental parsing library. Used for extracting structural symbols (functions, classes, methods) from code files to enable code-aware queries.

## License

Apache-2.0

## References

- [RLM Paper](https://arxiv.org/abs/2512.24601)
- [Original Implementation](https://github.com/alexzhang13/rlm)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [miniKanren](http://minikanren.org/)
