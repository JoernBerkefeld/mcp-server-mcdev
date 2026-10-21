# mcp-server-mcdev

MCP (Model Context Protocol) server for **[Accenture SFMC DevTools](https://github.com/Accenture/sfmc-devtools)** (`mcdev`): search the project wiki offline, learn `.mcdevrc.json` concepts (markets, `marketList`, `createDeltaPkg`, validations), walk component checklists (e.g. journeys), and list metadata types via the installed `mcdev` package.

Pair with **[mcp-server-sfmc](https://www.npmjs.com/package/mcp-server-sfmc)** for AMPscript / SSJS language validation and lookups.

## Requirements

Node.js `^22.22.2 || >=24.15.0` is required. This server uses the npm `mcdev` 10.1.0 release line; no separate global mcdev installation is required.

## MCP Registry

Registered as **`io.github.JoernBerkefeld/mcp-server-mcdev`** ([quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)). Registry hosts metadata only; the server runs locally via stdio.

Verify after publish:

`curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.JoernBerkefeld/mcp-server-mcdev"`

CI publishes npm artifacts and registry metadata using **GitHub OIDC** ([Actions doc](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx)) — see `.github/workflows/npm-publish.yml`. After npm publish succeeds, CI waits five minutes for npm registry propagation before publishing MCP Registry metadata.

## Tools

| Tool                        | Purpose                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `mcdev_search_docs`         | Search bundled sfmc-devtools wiki Markdown                                          |
| `mcdev_explain_config_key`  | Short explanations for config topics (`markets`, `marketList`, `createDeltaPkg`, …) |
| `mcdev_component_checklist` | Questions + dependent metadata types (`journey`, `automation`, …)                   |
| `mcdev_list_metadata_types` | Types from `Mcdev.explainTypes()` (silent JSON mode — safe for MCP stdio)           |
| `read_mcdev_project_config` | Read `.mcdevrc.json` with `credentials` stripped (never reads `.mcdev-auth.json`)   |

## Connecting AI clients

Register **`mcp-server-mcdev`** with the same patterns as other stdio MCP servers (package name in `args`).

### VS Code (1.99+) — `.vscode/mcp.json`

```json
{
  "servers": {
    "mcdev": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-mcdev@latest"]
    }
  }
}
```

### Cursor — `~/.cursor/mcp.json` or project `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "mcdev": {
      "command": "npx",
      "args": ["-y", "mcp-server-mcdev@latest"]
    }
  }
}
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) — use the same `mcpServers` object shape as Cursor.

### Windsurf

`~/.codeium/windsurf/mcp_config.json` — same `mcpServers` shape as Cursor.

### Global install (faster startup)

```bash
npm install -g mcp-server-mcdev
```

Then use `"command": "mcp-server-mcdev", "args": []` (or the binary name from this package’s `bin` field).

## SFMC DevTools VS Code extension

The **[SFMC DevTools](https://marketplace.visualstudio.com/items?itemName=Accenture-oss.sfmc-devtools-vscode)** extension documents optional MCP setup for AI-assisted mcdev workflows (see that repo’s README).

## Refresh bundled wiki

Ordinary `npm run bundle-wiki`, builds, hooks and prepublish reuse the committed `bundled/wiki` without reading a sibling checkout. To deliberately refresh from the sibling `../sfmc-devtools.wiki` checkout:

```bash
npm run bundle-wiki -- --refresh
```

For a reviewed or frozen source directory, set `SFMC_DEVTOOLS_WIKI` instead. Keep it set for subsequent builds, hooks and prepublish so every bundler invocation uses that same source:

```bash
export SFMC_DEVTOOLS_WIKI=/absolute/path/to/reviewed-wiki
npm run bundle-wiki
npm run build
```

In PowerShell, use `$env:SFMC_DEVTOOLS_WIKI = 'F:\path\to\reviewed-wiki'`. A missing or empty explicitly selected source fails rather than silently falling back to another checkout.

The bundled baseline is the mcdev 10.1.0 wiki commit `d0f315d6a826fe7068494e2e46e8021e26ce0915` (a commit, not a wiki tag). Four pages retain explicitly pending/unreleased extension-bundled CLI and optional-Git annotations: Getting Started, Updating mcdev, Admin Commands, and Git-based deployments and CI/CD. These annotations are not claims that those features shipped with mcdev 10.1.0. Preserve or reconcile them explicitly when refreshing; copying the released wiki alone would discard them.

## License

MIT © Jörn Berkefeld
