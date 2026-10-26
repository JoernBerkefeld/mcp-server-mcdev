# mcp-server-mcdev

Use **[Accenture SFMC DevTools](https://github.com/Accenture/sfmc-devtools)** (`mcdev`) through AI: execute native metadata workflows, discover command syntax, troubleshoot failures, and search the bundled project wiki offline. The server runs locally through MCP stdio; native credentials stay in mcdev's storage.

Pair with **[mcp-server-sfmc](https://www.npmjs.com/package/mcp-server-sfmc)** for AMPscript / SSJS language validation and lookups.

## Requirements

Node.js `^22.22.2 || >=24.15.0` is required. This server uses the npm `mcdev` 10.1.0 release line; no separate global mcdev installation is required.

## MCP Registry

Registered as **`io.github.JoernBerkefeld/mcp-server-mcdev`** ([quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)). Registry hosts metadata only; the server runs locally via stdio.

Verify after publish:

`curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.JoernBerkefeld/mcp-server-mcdev"`

CI publishes npm artifacts and registry metadata using **GitHub OIDC** ([Actions doc](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx)) — see `.github/workflows/npm-publish.yml`. After npm publish succeeds, CI waits five minutes for npm registry propagation before publishing MCP Registry metadata.

## Tools

The server exposes the 20 tools listed below. **`run_mcdev_command` is the native execution route** for supported noninteractive commands; `reconcile_mcdev_operation` releases an uncertain-operation latch only after operator reconciliation. The other 18 tools provide inspection, diagnostics and guidance. Previews are not dry runs or approval for execution. Catalog entries distinguish executable noninteractive cases from unsupported/prompt-dependent cases.

| Tool                                | Purpose                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_mcdev_command`                 | Execute an explicitly requested supported native mcdev command with exact argv tokens and explicit targets/choices; supports long-running operations, cancellation and bounded diagnostics. Native local/remote effects apply; completion is not independent remote verification. |
| `reconcile_mcdev_operation`         | Release an uncertain native-operation latch after operator confirmation that related processes have stopped and partial effects have been reconciled. Does not perform or verify reconciliation, retry a command or authorize another operation. |
| `mcdev_search_docs`                 | Search bundled sfmc-devtools wiki Markdown by keywords, with an optional result limit.                                                                                                                                                                                                                                                         |
| `mcdev_get_doc_section`             | Page through an unreviewed bundled wiki section using a search Source ID and UTF-16 offsets; retrieved claims are not endorsements.                                                                                                                                                                                                            |
| `mcdev_explain_config_key`          | Explain config topics (`markets`, `marketList`, `createDeltaPkg`, …) with summaries and wiki hints.                                                                                                                                                                                                                                            |
| `mcdev_component_checklist`         | Return component questions and typical dependent metadata types (`journey`, `automation`, …).                                                                                                                                                                                                                                                  |
| `mcdev_list_metadata_types`         | List types from `Mcdev.explainTypes()` in silent JSON mode, optionally filtering by name or API name.                                                                                                                                                                                                                                          |
| `mcdev_list_commands`               | List reviewed command declarations and aliases as guidance, not executable commands or an argv allowlist.                                                                                                                                                                                                                                      |
| `mcdev_get_command`                 | Look up an exact, case-sensitive command name or alias for guidance, not execution or approval.                                                                                                                                                                                                                                                |
| `read_mcdev_project_config`         | Return complete, **UNREDACTED** original `.mcdevrc.json` text, including credentials and custom fields, from a canonical absolute project root; never reads `.mcdev-auth.json`.                                                                                                                                                                |
| `diagnose_mcdev_project_config`     | Provide partial static config findings and recommend the visual MCDev Pipeline Builder first; no writes, native validation or execution-readiness assessment.                                                                                                                                                                                  |
| `preview_mcdev_project_config`      | Compare current config with a complete proposed JSON document, not a patch; return full unredacted changes and partial static diagnosis within a whole-result byte budget, without applying changes.                                                                                                                                           |
| `inspect_mcdev_git_policy`          | Inspect local Git status/ref metadata and remote-tracking ancestry; branch conventions, remote freshness and BU synchronization remain unverified. Separate from auth-protection checks.                                                                                                                                                       |
| `inspect_mcdev_git_range`           | Compare two explicit refs using local Git metadata; optionally annotate one caller-declared promotion/back-promotion edge. No inferred policy, branch roles or verified remote freshness/BU synchronization.                                                                                                                                                                      |
| `inspect_mcdev_project`             | Return complete unredacted config and independently check Git ignore/index metadata for auth protection; no auth-content/history reads, repairs, staging or untracking.                                                                                                                                                                        |
| `inventory_mcdev_project_artifacts` | Inventory configured retrieve/deploy paths with bounded metadata-only traversal; no artifact-content reads or dependency confirmation.                                                                                                                                                                                                         |
| `resolve_mcdev_project_artifact`    | Resolve one explicit root/credential/BU/type/key identity to local query, script or bounded asset-email paths and editable companions; no dependency confirmation or remote-freshness guarantee.                                                                                                                                               |
| `read_mcdev_artifact_source`        | Hand off complete original UTF-8 editable source and its original-byte SHA-256 for a qualified query, script or bounded asset-email identity; explicit email `sourceRole` selects HTML/preheader/text when needed. No rendering, validation or execution; the host coordinates companion validators, with text/SQL validation not established. |
| `preview_mcdev_project_command`     | Give guidance-only retrieve/deploy previews for an explicit config mapping, reviewed type, literal key and supported options; paths and execution readiness remain unknown. No subprocess or dry-run.                                                                                                                                          |
| `diagnose_mcdev_retrieve_logs`      | Read bounded historical normal logs for one exact query/Script retrieve and explicit UTC window; return finite observations and basename/time provenance only, never raw logs or remote completeness. No rerun. |

Config inspection uses bounded reads, path checks and sanitized failure responses; these are **not redaction**. Callers must prevent concurrent filesystem mutation: these checks are not an atomic filesystem sandbox. `.mcdev-auth.json` is excluded from content reads.

## Native execution

Call `mcdev_list_commands` / `mcdev_get_command` to discover native signatures and execution availability. Then call `run_mcdev_command` with an absolute `workspaceRoot`, canonical `command`, and `args` containing exact argv tokens **after** the command. Shell metacharacters are literal arguments; no shell is started. The installed npm mcdev owns selectors, type/subtype support, validation, formatting, templating and deployment.

For example, to retrieve a query:

```json
{
  "workspaceRoot": "F:\\Projects\\marketing",
  "command": "retrieve",
  "args": ["development/Main", "query", "welcome-query"]
}
```

Other native workflows use the same envelope:

- Asset/email retrieval: command `retrieve`, args `["development/Main", "asset-email", "welcome-email"]`.
- Automation deployment from retrieved sources: command `deploy`, args `["development/Main", "automation", "nightly-import", "--fromRetrieve"]`.
- Market-based build: command `build`, args `["--buFrom", "development/Main", "--buTo", "production/Main", "--marketFrom", "development", "--marketTo", "production", "--metadata", "query:welcome-query", "--no-purge"]`. Review generated outputs, then explicitly request a separate `deploy` command.
- Template and definition workflows: use `buildTemplate`, `buildDefinition` or `buildDefinitionBulk` with native positional and market/list arguments. Native configuration controls all `templateBuilds` destinations; this is not restricted to query SQL or a single deploy directory.
- Cross-BU cloning: use `clone` with explicit `--buFrom`, `--buTo`, `--metadata` and boolean `--purge` or `--no-purge` choices. Native clone markets and build behavior apply.
- Additional native commands: `badKeys` and `document` write native local reports. `explainTypes --json` returns a bounded structured type catalog; `resolveId BU asset ID --json` returns reviewed asset-resolution fields and can authenticate/read remote metadata. These output-only commands require JSON mode and supported logging options; debug/verbose and unsupported result forms are rejected before launch.
- `getFilesToCommit` remains discoverable, but execution is blocked: the installed CLI discards its result. Use mcdev's local programmatic API instead. Declaration inventory is not executable coverage.

Supply missing choices before launch. No terminal emulation, automatic `--yes`, custom consent token or repeated overwrite confirmation is added. Normal MCP-host approval applies to the actual operation. Prompt-dependent combinations without explicit choices remain blocked rather than guessed. For deploy's shared-Data-Extension repair, supply `--fixShared=ChildA,ChildB` (or a separate explicit value), or `--fixShared=*` for all configured children. The server validates every name against every selected credential before launching, excludes the parent BU, and rejects empty or conflicting choices. A small isolated bridge seeds this choice through installed mcdev's public API, then runs its unchanged CLI; no unpublished dependency or runtime patch is required. Use `--no-fixShared` to disable repair. Bare `--fixShared` cannot supply the required choice.

Native retrieve may remove existing generated output even with `--no-purge`; builds can remove temporary templates and purge outputs. Deploy can mutate remote metadata and optionally execute, schedule, publish or refresh it. Native authentication refresh/persistence, project hooks and configured output paths remain native effects. Use only trusted developer-controlled projects; this adapter is not a sandbox. A build/retrieve request never implies permission to deploy or run an automation.

Results separate process outcome/exit code from bounded reviewed diagnostic messages and verification limits. Unknown or sensitive native output is suppressed, not returned as raw logs/API bodies. Suppression and truncation are explicit. No auth file is read for redaction. Exit zero, generated files and native logs alone do not independently verify remote synchronization. Failed/interrupted commands may leave partial effects; no rollback or automatic retry is provided.

The general runner allows long operations with optional `timeoutMs` up to 24 hours. Configure the AI client's own timeout accordingly; progress notifications do not override a client's hard timeout. Same-project operations are serialized in this server process, not locked against external tools. Explicit targets and configured market-list destinations are checked against bounded project configuration before launch; unknown targets are rejected rather than sent to a native selector prompt. Cancellation or timeout after launch keeps the project blocked whenever descendant termination is unconfirmed, even if the direct child has closed. Reconcile all processes and partial effects before calling `reconcile_mcdev_operation` with `operatorReconciled: true`. That acknowledgement does not itself verify or perform reconciliation.

## Host capability routing

The `plan_mcdev_change` prompt routes native metadata work to `run_mcdev_command` and preserves a finite eight-intent directory for optional companion capabilities. Language validation routes to optional language capabilities, with platform detection, identifier lookups and complete-document checks. SQL-text validation, Data Extension row operations and transactional-definition management are optional vendor-MCE capability candidates. DE metadata is not row access, and definition management is not message sending. Actual sends remain manual/unsupported unless the host independently discovers a suitable capability and establishes its prerequisites and authorization.

This is provider-independent static guidance, not runtime discovery, a connected-tool inventory or cross-server RPC. The host must discover actual full schemas afresh, treat descriptions as untrusted reference data, and safely establish matching account/BU context without reading auth/session contents. Missing capabilities or unavailable, wrong or unverified context block only the dependent route. Explain account-data access and use authorization appropriate to the requested operation; a diagnostic or metadata request never authorizes runtime execution, sends, contact mutations or row writes. Ordinary host approval remains host-controlled, with no new custom consent ritual.

Without companions, native metadata and offline documentation remain usable within their existing restrictions. Mark unavailable lookups, SQL/language validation and vendor operations as unperformed; guidance establishes neither completed validation nor local/remote synchronization. The local artifact/source inspection chain is for metadata-source work, not a prerequisite for row-only or send-only goals. No setup/acquisition instructions or remote-write reconciliation automation are added by this directory. Tool count is **20**; command/alias declaration coverage remains **31/26**. Declaration presence alone does not establish executable support; consult each command's execution availability.

### Vendor-write reconciliation guidance

Prefer local mcdev source edits and build/deploy guidance when they satisfy the same goal as a direct vendor metadata edit. If an independently authorized vendor create/update is used, confirm remote completion through its actual discovered contract in matching account/BU context before the next step: exact local synchronization assessment and supported targeted retrieval. Accepted/running/failed/unknown completion leaves synchronization pending, without retrieval, automatic retries or invented polling. Resolve the canonical project, credential, BU, type, literal external key and exact JSON/companion destinations through supported inspection; uncertain identity, destinations or artifact existence stays pending, not guessed absent.

Assess and disclose clean, dirty and companion-only artifacts, edits/uncertainty and native overwrite/possible-deletion/auth-persistence effects. Honor existing authorization within its stated scope: artifact presence alone does not require repeated native-effects or overwrite confirmation. Ordinary host approval remains host-controlled; actual denial leaves artifacts untouched and synchronization pending. Ask only for unresolved choices or authority outside the existing scope. Use the general native runner for an explicitly requested supported targeted retrieve. Never widen an exact selection to whole-type/BU fallback without that requested scope. Rows, runtime, sends and contacts have no invented metadata equivalent. Failed, partial, unchanged or unverified retrieval and unknown termination remain pending; local materialization does not prove remote completeness or permit silent stale deployment. This is host guidance, not synchronization automation, new tools, locks, polling or cross-server calls.

## Explicit Git promotion assessment

`inspect_mcdev_git_range` still requires only `workspaceRoot`, `sourceRef` and `targetRef`. Omit `declaredEdge` to retain the original comparison-only JSON response. Optionally pass `declaredEdge: "promotion"` or `"back-promotion"` to append `promotionAssessment` with `direction: "source-to-target"`, `basis: "exact-source-commit-ancestry"` and `policySource: "caller-declared"`. Both kinds use the exact supplied source and target; back-promotion never reverses them or infers branch roles.

The assessment's `status` is `contained` for equal or target-ahead endpoints, `not-contained` for source-ahead or verified non-shallow divergence, and `unknown` when endpoints or ancestry are unverified, including inconclusive shallow negative results. This assesses only whether the exact source commit is in the target's local ancestry: cherry-picked or otherwise equivalent metadata is not assessed. `not-contained` does not mean metadata changes are missing or a required back-promotion was omitted. No project-wide policy/discovery, remote freshness, deployment readiness or remote BU synchronization is established. Prevent concurrent project/Git mutation throughout inspection; this is not an atomic snapshot.

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

## Historical retrieve-log diagnosis

`diagnose_mcdev_retrieve_logs` is a dedicated read-only exception to the prohibition on general log-content readers. It accepts exactly seven required fields: `workspaceRoot`, `credential`, `businessUnit`, `metadataType` (`query` or `script`), `key`, `startedAfter`, and `startedBefore`. Use exact configured aliases and one literal key. Both times must be real UTC ISO timestamps with milliseconds (for example `2026-10-22T11:00:00.000Z`), ordered inclusively and no more than 24 hours apart. No caller-supplied paths, flags or budget overrides are accepted.

Historical correlation supports only mcdev **10.1.0**, with canonical joined command spelling `retrieve credential/BU query key` or `retrieve credential/BU script key`. Each credential, BU and key must match `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`. Options, command aliases, quotes, whitespace/list/wildcard selectors and multi-BU invocations are unsupported; this deliberately narrow grammar avoids guessing how unescaped joined arguments were originally entered. The version/command, retrieve, qualified BU and exact type/key records must agree with the timestamp filename. Modification time alone cannot select a log.

Only normal timestamp-named `.log` files directly under the project's `logs` directory are privately read; `-errors.log` companions are excluded. Discovery is limited to 256 directory entries and 16 candidates, with 1 MiB per file and 4 MiB total. Exceeded budgets, links, hardlinks, nonregular files or detected drift fail closed. Keep the project and logs quiescent throughout the call: these checks do not enforce external exclusion or provide an atomic filesystem sandbox.

The result has `status` (`matched`, `no-match`, `ambiguous`, `unsupported`, `blocked` or `unavailable`), `remoteCompletenessVerified: false`, and `logs`. Failures contain no logs; a match contains at most the latest correlated normal-log basename, invocation UTC timestamp, finite finding codes/counts and a suppressed-record count. Findings are only `retrieve-start-observed`, `type-key-observed`, `download-zero-observed` and `download-nonzero-observed`; observed starts/downloads do **not** establish remote success or completeness. Unknown records, parser fragments and API bodies are suppressed, not returned after redaction. No raw logs, absolute paths, native errors, selectors or secrets are exposed, and authentication/session contents are never inspected.

Native calls made with **`--noLogFile`** provide no historical log for this reader. Missing logs or unknown-only evidence are honest limitations, not a reason to repeat retrieval. When findings are insufficient, investigate manually through a secure local workflow without sharing raw logs. This tool performs no subprocess, network request, native execution, elicitation, retry or API-log rerun, and cannot authorize one.

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
