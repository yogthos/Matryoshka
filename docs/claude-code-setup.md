# Setting Up Lattice for Claude Code

Lattice is a stateful document analysis tool that saves 80%+ tokens compared to reading files directly. It uses Nucleus S-expression syntax for queries. This guide explains how to make it available to Claude Code.

## Option 1: MCP Server (Recommended)

MCP servers run as persistent subprocesses, so they **do maintain state** between calls.

### Installation

```bash
# Install globally
pnpm add -g matryoshka-rlm

# Or use npx (no install needed)
npx matryoshka-rlm
```

### Configure Claude Code

Add to your Claude Code settings (per-project or global):

**Per-project** (`.claude/settings.json` in your project):
```json
{
  "mcpServers": {
    "lattice": {
      "command": "npx",
      "args": ["matryoshka-rlm", "lattice-mcp"]
    }
  }
}
```

**Global** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "lattice": {
      "command": "lattice-mcp",
      "args": []
    }
  }
}
```

### Available Tools

Once configured, Claude Code will see these tools:

| Tool | Purpose |
|------|---------|
| `lattice_load` | Load a document for analysis |
| `lattice_query` | Execute Nucleus S-expression queries |
| `lattice_bindings` | Show current variable state |
| `lattice_reset` | Clear bindings |
| `lattice_stats` | Get document statistics |
| `lattice_help` | Nucleus command reference |

## Option 2: HTTP Server

Run Lattice as a REST API server that Claude can call via curl/fetch.

```bash
# Start the server
npx matryoshka-rlm lattice-http --port 3456

# Or with global install
lattice-http --port 3456
```

Then add to your project's CLAUDE.md:

```markdown
## Document Analysis Tool

For large files (>500 lines), use the Lattice HTTP server instead of reading directly:

```bash
# Load document
curl -X POST http://localhost:3456/load \
  -H "Content-Type: application/json" \
  -d '{"filePath": "./path/to/file.txt"}'

# Query
curl -X POST http://localhost:3456/query \
  -H "Content-Type: application/json" \
  -d '{"command": "(grep \"pattern\")"}'
```
```

## Option 3: Project Instructions (CLAUDE.md)

Add instructions to your project's CLAUDE.md to tell Claude when to use the tool:

```markdown
## Large File Analysis

When analyzing files larger than 500 lines, use the Lattice tool instead of reading the file directly. This saves ~80% of tokens.

### Quick Start
```typescript
import { PipeAdapter } from "matryoshka-rlm/tool";

const lattice = new PipeAdapter();
await lattice.executeCommand({ type: "load", filePath: "./large-file.txt" });

// Search
const result = await lattice.executeCommand({
  type: "query",
  command: '(grep "pattern")'
});

// Results persist - chain operations
await lattice.executeCommand({ type: "query", command: "(count RESULTS)" });
```

### When to Use
- Files >500 lines
- Multiple searches on same file
- Extracting/aggregating structured data
- Exploratory analysis

### When NOT to Use
- Small files (<100 lines)
- Single search
- Need full document context
```

## Why Lattice Saves Tokens

| Operation | Traditional | Lattice | Savings |
|-----------|-------------|---------|---------|
| Read 1000-line file | ~10,000 tokens | 0 | - |
| Search for pattern | 0 | ~50 tokens | - |
| View 10 results | 0 | ~200 tokens | - |
| **Total** | ~10,000 | ~250 | **97%** |

The document is loaded into Lattice's memory (not the LLM context), so you only pay for the query and results, not the entire file.

## Nucleus Query Language Quick Reference

```scheme
; Search
(grep "pattern")              ; Regex search
(lines 10 20)                 ; Get line range
(fuzzy_search "query" 10)     ; Fuzzy match

; Aggregate
(count RESULTS)               ; Count matches
(sum RESULTS)                 ; Sum numeric values

; Transform
(map RESULTS (lambda x (match x "regex" 1)))
(filter RESULTS (lambda x (match x "pattern" 0)))

; Parse
(parseInt str)                ; Parse integer
(parseCurrency "$1,234")      ; Parse money → 1234
```

## Troubleshooting

### "No document loaded"
Call `lattice_load` before `lattice_query`.

### State lost between calls
MCP servers maintain state. If using HTTP, ensure you're hitting the same server instance.

### Tool not appearing in Claude Code
1. Check MCP server config syntax
2. Restart Claude Code
3. Verify the command works: `npx matryoshka-rlm lattice-mcp`
