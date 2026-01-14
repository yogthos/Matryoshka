# Recursive Language Model (RLM)

Process documents 100x larger than your LLM's context window—without vector databases or chunking heuristics.

## The Problem

LLMs have fixed context windows. Traditional solutions (RAG, chunking) lose information or miss connections across chunks. RLM takes a different approach: the model reasons about your query and outputs symbolic commands that a logic engine executes against the document.

Based on the [Recursive Language Models paper](https://arxiv.org/abs/2512.24601).

## How It Works

Unlike traditional approaches where an LLM writes arbitrary code, RLM uses a **constrained symbolic language** called Nucleus. The LLM outputs S-expressions (like Lisp), which are parsed, type-checked, and executed by a logic engine.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   User Query    │────▶│   LLM Reasons   │────▶│  S-Expression   │
│ "total sales?"  │     │  about intent   │     │  (sum RESULTS)  │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
┌─────────────────┐     ┌─────────────────┐     ┌────────▼────────┐
│  Final Answer   │◀────│  Logic Engine   │◀────│   LC Parser     │
│   13,000,000    │     │   Executes      │     │   Validates     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Why this works better than code generation:**

1. **Reduced entropy** - S-expressions have a rigid grammar with fewer valid outputs than JavaScript
2. **Fail-fast validation** - Parser rejects malformed commands before execution
3. **Safe execution** - The logic engine only executes known operations, no arbitrary code
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

### The Logic Engine

The logic engine (`src/logic/`) processes Nucleus commands:

1. **LC Parser** (`lc-parser.ts`) - Parses S-expressions into an AST
2. **Type Inference** (`type-inference.ts`) - Validates types before execution
3. **Constraint Resolver** (`constraint-resolver.ts`) - Handles symbolic constraints like `[Σ⚡μ]`
4. **LC Solver** (`lc-solver.ts`) - Executes commands against the document

The solver uses **miniKanren** (a relational programming engine) for pattern classification and filtering operations.

### Pre-Search Optimization

Before calling the LLM, the system extracts keywords from your query and pre-runs grep:

```
Query: "What is the total of all north sales data values?"
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│ Pre-search extracts: "north", "sales", "data"       │
│ Tries compound patterns: SALES.*NORTH, NORTH.*SALES │
│ Pre-populates RESULTS before LLM is called          │
└─────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│ LLM receives: "RESULTS has 1 match"                 │
│ LLM outputs: (sum RESULTS)  ← skips search step!   │
└─────────────────────────────────────────────────────┘
```

This saves turns by pre-populating `RESULTS` so the model can immediately aggregate.

### The Role of the LLM

The LLM does **reasoning**, not code generation:

1. **Understands intent** - Interprets "total of north sales" as needing grep + filter + sum
2. **Chooses operations** - Decides which Nucleus commands achieve the goal
3. **Verifies results** - Checks if the current results answer the query
4. **Iterates** - Refines search if results are too broad or narrow

The LLM never writes JavaScript. It outputs symbolic commands that the logic engine executes safely.

### Components Summary

| Component | Purpose |
|-----------|---------|
| **Nucleus Adapter** | Prompts LLM to output S-expressions |
| **LC Parser** | Parses S-expressions to AST |
| **LC Solver** | Executes commands against document |
| **miniKanren** | Relational engine for classification |
| **Pre-Search** | Extracts keywords and pre-runs grep |
| **RAG Hints** | Few-shot examples from past successes |

## Installation

### npm (recommended)

```bash
npm install -g matryoshka-rlm
```

### npx (no install)

```bash
npx matryoshka-rlm "Summarize this document" ./document.txt
```

### From source

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
rlm "Summarize this document" ./path/to/document.txt

# With options
rlm "Find all error codes" ./logs.txt --max-turns 15 --verbose

# See all options
rlm --help
```

### MCP Integration

RLM includes an MCP (Model Context Protocol) server that exposes the `analyze_document` tool. This allows coding agents to analyze documents that exceed their context window.

#### MCP Tool: `analyze_document`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | The question or task to perform on the document |
| `filePath` | string | Yes | Absolute path to the document file |
| `maxTurns` | number | No | Maximum exploration turns (default: 10) |
| `timeoutMs` | number | No | Timeout per turn in milliseconds (default: 30000) |

#### Example MCP config

```json
{
  "mcp": {
    "rlm": {
      "type": "stdio",
      "command": "rlm-mcp"
    }
  }
}
```

#### Testing the MCP Server

```bash
rlm-mcp --test
# Output: MCP server ready
# Output: Available tools: analyze_document
```

### Programmatic

```typescript
import { runRLM } from "matryoshka-rlm/rlm";
import { createLLMClient } from "matryoshka-rlm";

const llmClient = createLLMClient("ollama", {
  baseUrl: "http://localhost:11434",
  model: "qwen2.5-coder:7b",
  options: { temperature: 0.2 }
});

const result = await runRLM("What are the main themes?", "./book.txt", {
  llmClient,
  maxTurns: 10,
  turnTimeoutMs: 30000,
});
```

## Example Session

```
$ rlm "What is the total of all north sales data values?" ./report.txt --verbose

[Pre-search] Found 1 data matches for "SALES.*NORTH"
[Pre-search] RESULTS pre-populated with 1 matches

──────────────────────────────────────────────────
[Turn 1/10] Querying LLM...
[Turn 1] Term: (sum RESULTS)
[Turn 1] Console output:
  [Solver] Summing 1 values
  [Solver] Sum = 2340000
[Turn 1] Result: 2340000

──────────────────────────────────────────────────
[Turn 2/10] Querying LLM...
[Turn 2] Final answer received

2340000
```

The model:
1. Received pre-populated RESULTS (pre-search found the data)
2. Immediately summed the results (no grep needed)
3. Output the final answer

## Nucleus DSL Reference

### Search Commands

```scheme
(grep "pattern")              ; Regex search, returns matches with line numbers
(fuzzy_search "query" 10)     ; Fuzzy search, returns top N matches with scores
(text_stats)                  ; Document metadata (length, line count, samples)
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
│   ├── nucleus.ts      # S-expression DSL adapter
│   └── types.ts        # Adapter interface
├── logic/              # Logic engine
│   ├── lc-parser.ts    # S-expression parser
│   ├── lc-solver.ts    # Command executor (uses miniKanren)
│   ├── type-inference.ts
│   └── constraint-resolver.ts
├── minikanren/         # Relational programming engine
├── synthesis/          # Program synthesis (Barliman-style)
│   └── evalo/          # Extractor DSL
├── rag/                # Few-shot hint retrieval
└── rlm.ts              # Main execution loop
```

## Acknowledgements

This project incorporates ideas and code from:

- **[ramo](https://github.com/wjlewis/ramo)** - A miniKanren implementation in TypeScript by Will Lewis. Used for constraint-based program synthesis.
- **[Barliman](https://github.com/webyrd/Barliman)** - A prototype smart editor by William Byrd that uses program synthesis to assist programmers. The Barliman-style approach of providing input/output constraints instead of code inspired the synthesis workflow.

## License

MIT

## References

- [RLM Paper](https://arxiv.org/abs/2512.24601)
- [Original Implementation](https://github.com/alexzhang13/rlm)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [miniKanren](http://minikanren.org/)
