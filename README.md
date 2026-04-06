# mcp-server-mcdev

MCP (Model Context Protocol) server for **[Accenture SFMC DevTools](https://github.com/Accenture/sfmc-devtools)** (`mcdev`): search the project wiki offline, learn `.mcdevrc.json` concepts (markets, `marketList`, `createDeltaPkg`, validations), walk component checklists (e.g. journeys), and list metadata types via the installed `mcdev` package.

Pair with **[mcp-server-sfmc](https://www.npmjs.com/package/mcp-server-sfmc)** for AMPscript / SSJS language validation and lookups.

## MCP Registry

Registered as **`io.github.JoernBerkefeld/mcp-server-mcdev`** ([quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)). Registry hosts metadata only; the server runs locally via stdio.

Verify after publish:

`curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.JoernBerkefeld/mcp-server-mcdev"`

CI publishes npm artifacts and registry metadata using **GitHub OIDC** ([Actions doc](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx)) — see `.github/workflows/npm-publish.yml`.

## Tools

| Tool | Purpose |
|------|---------|
| `mcdev_search_docs` | Search bundled sfmc-devtools wiki Markdown |
| `mcdev_explain_config_key` | Short explanations for config topics (`markets`, `marketList`, `createDeltaPkg`, …) |
| `mcdev_component_checklist` | Questions + dependent metadata types (`journey`, `automation`, …) |
| `mcdev_list_metadata_types` | Types from `Mcdev.explainTypes()` (silent JSON mode — safe for MCP stdio) |
| `read_mcdev_project_config` | Read `.mcdevrc.json` with `credentials` stripped (never reads `.mcdev-auth.json`) |

## Cursor / VS Code `mcp.json`

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

## SFMC DevTools VS Code extension

The **[SFMC DevTools](https://marketplace.visualstudio.com/items?itemName=Accenture-oss.sfmc-devtools-vscode)** extension documents optional MCP setup for AI-assisted mcdev workflows (see that repo’s README).

## Refresh bundled wiki

From this package directory, with the wiki checkout next to the repo (or set `SFMC_DEVTOOLS_WIKI`):

```bash
npm run bundle-wiki
npm run build
```

## License

MIT © Jörn Berkefeld
