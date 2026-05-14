# Lattice MCP with OpenCode

This project uses Lattice as a local MCP server so OpenCode can inspect large files with handle-based queries instead of dumping full file contents into the model context.

## Install

Install the package that provides the `lattice-mcp` binary:

```bash
pnpm add -g matryoshka-rlm
```

Sanity check:

```bash
lattice-mcp --help
```

If it is installed correctly, the command starts the server and prints startup info such as `MCP server started (handle-based mode)`.

## Configure OpenCode

Add Lattice to your OpenCode config in `~/.config/opencode/config.json` or a project-level `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "lattice": {
      "type": "local",
      "command": ["lattice-mcp"],
      "enabled": true
    }
  }
}
```

You can also add it interactively:

```bash
opencode mcp add
```

Then verify OpenCode sees it:

```bash
opencode mcp list
```

## How it appears in OpenCode

Once enabled, the Lattice tools are exposed with the `lattice_` prefix, for example:

- `lattice_lattice_load`
- `lattice_lattice_query`
- `lattice_lattice_expand`
- `lattice_lattice_bindings`
- `lattice_lattice_close`
