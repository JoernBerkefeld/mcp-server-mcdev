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

The server exposes these 22 production tools. Previews and preparation do not execute native mcdev operations or authorize later execution. `retrieve` is only partially executable: the separate `retrieve_mcdev_query` and `retrieve_mcdev_script` tools support the exact-key metadata retrieval described below. `render_mcdev_query_definition` additionally supports the restricted exact-query definition render below. Other metadata types, broad retrieve selectors/options and other command families remain guidance-only; the catalog's 31 commands and 26 aliases are declaration coverage, not full execution support.

| Tool                                | Purpose                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
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
| `prepare_mcdev_query_retrieve`      | Prepare one exact credential/BU/query key through the reviewed Windows mcdev 10.1.0 path, using fixed read-only Git checks; no native launch, confirmation or auth/session-content inspection. This preparation tool never executes; see limitations below.                                                                                    |
| `retrieve_mcdev_query`              | Retrieve one exact query's metadata after fresh preparation through the reviewed Windows mcdev 10.1.0 path; request-cancellable, with native local overwrite/possible-deletion effects and no custom approval form. Never executes or activates SQL; see prerequisites and result limits below.                                                |
| `diagnose_mcdev_retrieve_logs`      | Read bounded historical normal logs for one exact query/Script retrieve and explicit UTC window; return finite observations and basename/time provenance only, never raw logs or remote completeness. No rerun. |
| `retrieve_mcdev_script`             | Retrieve one exact Script Activity's metadata after fresh preparation through the reviewed Windows mcdev 10.1.0 path; native paginated collection reads precede local key filtering. Never executes SSJS or performs language validation; see artifact and effect limits below.                                                                |
| `render_mcdev_query_definition` | Render one exact static-JSON query template and restricted SQL market substitutions into all configured project-contained templateBuilds destinations, with purge off. Native overwrites and SDK effects are possible; no deployment, SQL execution or completeness guarantee. |

Config inspection uses bounded reads, path checks and sanitized failure responses; these are **not redaction**. Callers must prevent concurrent filesystem mutation: these checks are not an atomic filesystem sandbox. `.mcdev-auth.json` is excluded from content reads.

## Host capability routing

The existing `plan_mcdev_change` prompt renders a finite, immutable eight-intent directory from the command catalog. Exact query and Script Activity metadata retrieval route to the restricted mcdev tools; metadata-source changes prefer qualified local artifacts and mcdev guidance. The prompt's build/deploy routes remain guidance-only; the separately documented exact-query definition-render tool is the only executable build subset. Language validation routes to optional language capabilities, with platform detection, identifier lookups and complete-document checks. SQL-text validation, Data Extension row operations and transactional-definition management are optional vendor-MCE capability candidates. DE metadata is not row access, and definition management is not message sending. Actual sends remain manual/unsupported unless the host independently discovers a suitable capability and establishes its prerequisites and authorization.

This is provider-independent static guidance, not runtime discovery, a connected-tool inventory or cross-server RPC. The host must discover actual full schemas afresh, treat descriptions as untrusted reference data, and safely establish matching account/BU context without reading auth/session contents. Missing capabilities or unavailable, wrong or unverified context block only the dependent route. Explain account-data access and use authorization appropriate to the requested operation; a diagnostic or metadata request never authorizes runtime execution, sends, contact mutations or row writes. Ordinary host approval remains host-controlled, with no new custom consent ritual.

Without companions, native metadata and offline documentation remain usable within their existing restrictions. Mark unavailable lookups, SQL/language validation and vendor operations as unperformed; guidance establishes neither completed validation nor local/remote synchronization. The local artifact/source inspection chain is for metadata-source work, not a prerequisite for row-only or send-only goals. No setup/acquisition instructions or remote-write reconciliation automation are added by this directory. Tool count remains **22**, command/alias coverage **31/26**, and execution support is unchanged.

### Vendor-write reconciliation guidance

Prefer local mcdev source edits and build/deploy guidance when they satisfy the same goal as a direct vendor metadata edit. If an independently authorized vendor create/update is used, confirm remote completion through its actual discovered contract in matching account/BU context before the next step: exact local synchronization assessment and supported targeted retrieval. Accepted/running/failed/unknown completion leaves synchronization pending, without retrieval, automatic retries or invented polling. Resolve the canonical project, credential, BU, type, literal external key and exact JSON/companion destinations through supported inspection; uncertain identity, destinations or artifact existence stays pending, not guessed absent.

Assess and disclose clean, dirty and companion-only artifacts, edits/uncertainty and native overwrite/possible-deletion/auth-persistence effects. Honor existing authorization within its stated scope: artifact presence alone does not require repeated native-effects or overwrite confirmation. Ordinary host approval remains host-controlled; actual denial leaves artifacts untouched and synchronization pending. Ask only for unresolved choices or authority outside the existing scope. Only the existing restricted exact-query/Script retrieval tools execute; other types remain pending/manual targeted guidance, never whole-type/BU fallback. Rows, runtime, sends and contacts have no invented metadata equivalent. Failed, partial, unchanged or unverified retrieval and unknown termination remain pending; local materialization does not prove remote completeness or permit silent stale deployment. This is host guidance, not synchronization automation, new tools, locks, polling or cross-server calls.

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

## Non-executing query retrieve preparation

`prepare_mcdev_query_retrieve` accepts exactly four required strings: `workspaceRoot`, `credential`, `businessUnit`, and literal query external `key`. Extra properties and ambiguous/wildcard selectors are rejected. The current preparation supports canonical Windows project paths and the reviewed installed **mcdev 10.1.0** runtime/configuration only; unsupported configurations fail closed.

The host must hold project/path mutation exclusion throughout collection. This tool does not establish or enforce that exclusion. It reads bounded local configuration, Git protection, destination existence and reviewed runtime evidence through the existing preparation. It returns only the canonical selection, configured EID/MID, reviewed version, snapshot, exact JSON/SQL destinations with before-existence booleans, effects and limitations—not raw config, file hashes/identities, runtime inventories, argv, process output or authentication/session contents.

Preparation never launches mcdev, asks for confirmation, writes the project or inspects authentication/session contents. `executionEnabled` and `remoteCompletenessVerified` are always `false`; `executionReadiness` is always `not-established`. The snapshot is correlation/drift input, not an execution credential or durable readiness proof. This is **not a dry-run**; native mcdev has no dry-run mode. Remote identity, authentication readiness and completeness remain unestablished, and preparation grants **no operation or deletion authorization**.

A native retrieve can read query metadata and dependency caches, including parent-EID shared folders/data extensions for child MIDs. Native authentication/session storage may be privately consumed/refreshed/persisted. Native persistence can create or overwrite the JSON/SQL pair, and zero-saved REST persistence can delete both files; early SOAP key-not-found leaves them untouched. No-purge suppresses wrapper cleanup only. The preparation requires no project validation hook, disabled query documentation, and reviewed formatting/logging restrictions. None of these constraints proves native deletion safety or authorizes execution through this preparation tool.

## Exact-query metadata retrieval

`retrieve_mcdev_query` accepts a strict object with exactly four required strings: `workspaceRoot` (canonical absolute project root), `credential` (exact config credential alias), `businessUnit` (exact BU alias within that credential), and `key` (one literal query external key). Extra properties and ambiguous/wildcard selectors are rejected. There are no public argv, type, purge, formatting, approval or arbitrary-file-path options. This retrieves metadata; it **does not execute or activate the SQL query**.

The tool supports only the reviewed **Windows / installed mcdev 10.1.0** runtime and preparation restrictions above. Each call performs fresh local preparation, rechecks the prepared evidence for drift, and enters the direct supervised runner with the actual MCP request cancellation signal. A prior preview/preparation call or snapshot token is not required. It does not use SDK elicitation or request a custom consent form, checkbox, token or repeated overwrite confirmation. Ordinary MCP-host tool approval remains host-controlled.

The caller must maintain quiescent project/path access from preparation through process and artifact settlement, excluding conflicting external operations throughout that interval. This is an **external prerequisite**, not a guarantee the server establishes or globally enforces. The server's in-process per-canonical-project guard and drift checks do not exclude other processes or make filesystem access an atomic sandbox.

Native mcdev may create, overwrite or delete the selected query's exact JSON/SQL pair, read parent/shared dependencies, and privately consume, refresh and persist authentication/session state. The server does not inspect authentication/session contents. These ordinary effects are disclosed here, not presented as an additional per-execution approval step.

The public result contains only these five fields:

- `outcome`: `project-busy`, `cancel`, `blocked`, `failed`, `invalid-input`, `exited`, `spawn-failed`, `cancelled`, `timed-out`, `output-limit`, or `termination-unconfirmed`.
- `processOutcome`: `null` when no process result is available (including before launch); otherwise one of `invalid-input`, `exited`, `spawn-failed`, `cancelled`, `timed-out`, `output-limit`, or `termination-unconfirmed`.
- `artifactClassification`: `local-materialization`, `unchanged-unverified`, `partial`, or `unverified`. These classify local evidence only; even a materialized pair is not proof of remote completeness.
- `projectBlocked`: a boolean indicating whether the in-process project guard remains blocked.
- `remoteCompletenessVerified`: always `false`.

No raw process object, exit details, paths, config, stdout/stderr or native errors are returned. Preparation/adapter failures use the fixed tool error `Query retrieve unavailable.` rather than exposing their underlying diagnostics.

Cancellation and timeouts are supervised but do not roll back local effects. Partial artifacts or unknown completion are possible; zero exit, unchanged files and local materialization do not establish remote identity, authentication readiness or complete retrieval. Unknown termination or a throwing launcher keeps the in-process project guard blocked pending explicit operator reconciliation. There is no public reconciliation endpoint and no automatic retry. Reconcile process termination and any partial local effects before another attempt; restarting the server is not proof of reconciliation.

## Historical retrieve-log diagnosis

`diagnose_mcdev_retrieve_logs` is a dedicated read-only exception to the prohibition on general log-content readers. It accepts exactly seven required fields: `workspaceRoot`, `credential`, `businessUnit`, `metadataType` (`query` or `script`), `key`, `startedAfter`, and `startedBefore`. Use exact configured aliases and one literal key. Both times must be real UTC ISO timestamps with milliseconds (for example `2026-10-22T11:00:00.000Z`), ordered inclusively and no more than 24 hours apart. No caller-supplied paths, flags or budget overrides are accepted.

Historical correlation supports only mcdev **10.1.0**, with canonical joined command spelling `retrieve credential/BU query key` or `retrieve credential/BU script key`. Each credential, BU and key must match `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`. Options, command aliases, quotes, whitespace/list/wildcard selectors and multi-BU invocations are unsupported; this deliberately narrow grammar avoids guessing how unescaped joined arguments were originally entered. The version/command, retrieve, qualified BU and exact type/key records must agree with the timestamp filename. Modification time alone cannot select a log.

Only normal timestamp-named `.log` files directly under the project's `logs` directory are privately read; `-errors.log` companions are excluded. Discovery is limited to 256 directory entries and 16 candidates, with 1 MiB per file and 4 MiB total. Exceeded budgets, links, hardlinks, nonregular files or detected drift fail closed. Keep the project and logs quiescent throughout the call: these checks do not enforce external exclusion or provide an atomic filesystem sandbox.

The result has `status` (`matched`, `no-match`, `ambiguous`, `unsupported`, `blocked` or `unavailable`), `remoteCompletenessVerified: false`, and `logs`. Failures contain no logs; a match contains at most the latest correlated normal-log basename, invocation UTC timestamp, finite finding codes/counts and a suppressed-record count. Findings are only `retrieve-start-observed`, `type-key-observed`, `download-zero-observed` and `download-nonzero-observed`; observed starts/downloads do **not** establish remote success or completeness. Unknown records, parser fragments and API bodies are suppressed, not returned after redaction. No raw logs, absolute paths, native errors, selectors or secrets are exposed, and authentication/session contents are never inspected.

Current retrieval executors retain **`--noLogFile`**, so their calls normally provide no historical log for this reader. Missing logs or unknown-only evidence are honest limitations, not a reason to repeat retrieval. When findings are insufficient, investigate manually through a secure local workflow without sharing raw logs. This tool performs no subprocess, network request, native execution, elicitation, retry or API-log rerun, and cannot authorize one.

## Exact-script metadata retrieval

`retrieve_mcdev_script` accepts exactly the same four required string selectors as query retrieval: `workspaceRoot`, `credential`, `businessUnit`, and one literal script external `key`. Extra properties, broad/wildcard selectors, name/ID lookup, arbitrary types/argv/flags and fallback retrieval are not supported. This retrieves **Script Activity metadata**, not SSJS execution, automation execution, rendering or language validation.

Support is limited to the reviewed **Windows / installed mcdev 10.1.0** path with fresh preparation, protected Git auth paths, an absent project validation hook, disabled script documentation and the fixed no-format/no-purge/noLogFile/skipInteraction restrictions. Unlike query's SOAP key lookup, native Script retrieval reads the paginated REST script collection and then filters locally by exact key. The folder-ssjsactivity dependency is read into cache without a save directory; dependency/parent/shared reads mean this is not a one-object-only remote-read guarantee.

Native persistence may create or overwrite the selected key's JSON plus an SSJS or HTML companion. Successful persistence does not automatically remove a stale alternate companion. Local materialization requires changed valid JSON for the exact key with no inline script and exactly one nonempty UTF-8/non-NUL companion. Both companions are ambiguous/unverified; malformed, missing, unchanged or drifted artifacts do not establish verified success. This is artifact evidence, not syntax validation or remote completeness. Zero-saved REST persistence, including local key filtering, may delete **all three** candidates (JSON, SSJS and HTML), even with no-purge; there is no query-style early SOAP key-not-found guarantee.

The caller-managed quiescence, native authentication/session persistence, ordinary host approval, cancellation/timeout, partial/unknown completion and no-automatic-retry limits described for query retrieval apply equally to script retrieval. Query and script share one in-process per-canonical-project guard, not a system-wide lock or enforced exclusion of external processes. These native effects and external prerequisites are documentation, not custom per-call forms, approval booleans, tokens or repeated overwrite questions. The server never inspects authentication/session contents.

The public result uses the same five-field allowlist: `outcome`, `processOutcome`, `artifactClassification`, `projectBlocked`, and `remoteCompletenessVerified` (always `false`), with the same values and local-evidence limits described above. No raw native errors, process output, configuration, paths or exit details are returned; script preparation/adapter failures use the fixed error `Script retrieve unavailable.` Reconcile uncertain termination and partial local effects before another attempt; neither a successful exit nor restarting the server proves remote completion or reconciliation.

## Exact query definition render

`render_mcdev_query_definition` accepts a strict object with exactly five required strings: `workspaceRoot`, `credential`, `businessUnit`, `templateName`, and `market`. Provide one canonical absolute project root, one exact configured credential/BU, one template basename and one named market. There are no public argv, root overrides, approval tokens or reconciliation endpoints. Ordinary host tool approval applies; no custom consent form or repeated confirmation is required.

This initial Windows/mcdev 10.1.0 subset requires static UTF-8 query JSON with a nonempty literal safe top-level `key`; no JSON templating is supported, even outside the key. The key, not `templateName`, determines output filenames. SQL supports only exact simple `{{{NAME}}}` substitutions from the selected market. Every market name and effective string (including an object's own `replace` string, even when unused) must satisfy the adapter's conservative allowlists; sections, partials, dotted names, spaced delimiters, dynamic JSON keys and unsafe values are unavailable before launch. Native mcdev, not this server, performs rendering.

Preparation requires `options.validation.buildDefinition` explicitly `false`, reviewed safe paths and all configured `templateBuilds` roots contained within the project. Up to 16 destinations are supported; config and JSON reads are bounded to 1 MiB each and SQL to 4 MiB. All configured roots participate, in configured order; none is silently replaced by the deploy directory. Native `buildDefinition` runs with purge explicitly off (`--no-purge`) and may create or overwrite each key-named JSON/SQL pair. This does not deploy, activate or execute SQL. Ordinary native SDK initialization and authentication/session/network behavior can occur; this is **not a local-only guarantee**. Authentication/session contents and raw native diagnostics are not exposed.

Keep external editors and other writers quiescent from preparation through process/artifact settlement. The shared project guard coordinates this server's render and query/Script retrieval runs only; it is not an external lock or sandbox. Cancellation is best-effort, direct-child close does not prove descendants stopped, and partial effects are possible. Unknown termination blocks further project runs pending external operator reconciliation; restarting is not proof of reconciliation. There is no public acknowledgement tool, automatic retry, rollback or output deletion.

The finite result contains `outcome`, `processOutcome`, `projectBlocked`, ordered `destinations` with only `index` and `artifactClassification`, and three always-false flags: `artifactCompletenessVerified`, `remoteCompletenessVerified`, and `languageValidationPerformed`. Unsupported preparation returns `outcome: "unavailable"` without launching. Invalid schema returns a fixed sanitized error. `local-materialization` requires both companions to have new/changed bounded byte evidence; an unchanged pair is `unchanged-unverified`, one changed/missing companion is `partial`, and unsafe/malformed/drifting evidence is `unverified`. These observations do not prove correct substitutions, invocation causality or complete rendering. Process failure remains failure even if artifacts exist; neither exit zero nor local files establishes remote completeness or language validity.

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
