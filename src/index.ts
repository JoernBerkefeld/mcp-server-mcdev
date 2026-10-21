#!/usr/bin/env node
/**
 * mcp-server-mcdev — MCP tools for Accenture SFMC DevTools (mcdev) project workflows,
 * grounded in the sfmc-devtools wiki bundle and the mcdev metadata catalog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Mcdev from 'mcdev';
import { CONFIG_TOPICS, listConfigTopicKeys, resolveTopicKey } from './config-topics.js';
import {
    getChunks,
    getDocExcerpt,
    getDocSection,
    MAX_SECTION_PAGE_LENGTH,
    searchDocs,
} from './doc-search.js';
import { listCommands, lookupCommand } from './command-catalog.js';
import { ProjectInspectionError, readProjectConfig } from './project-inspection.js';
import { inspectProjectGitSecurity } from './project-git-security.js';
import { inspectProjectGitPolicy } from './project-git-policy.js';
import { diagnoseProjectConfig } from './project-config-diagnostics.js';
import { inventoryProjectArtifacts } from './project-artifacts.js';
import { readProjectArtifactSource, resolveProjectArtifact } from './project-artifact-resolver.js';
import { previewProjectCommand } from './project-command-preview.js';
import { ensureMcdevSilentJson, getBundledMcdevVersion } from './mcdev-safe.js';

function projectPackageRoot(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const pkg = JSON.parse(
    fs.readFileSync(path.join(projectPackageRoot(), 'package.json'), 'utf8')
) as {
    version: string;
};

function loadChecklists(): Record<string, unknown> {
    const p = path.join(projectPackageRoot(), 'data', 'metadata-checklists.json');
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
}

const server = new McpServer({
    name: 'mcp-server-mcdev',
    version: pkg.version,
});

// ---------------------------------------------------------------------------
// Tool: mcdev_search_docs
// ---------------------------------------------------------------------------

server.tool(
    'mcdev_search_docs',
    'Search bundled sfmc-devtools wiki Markdown (from GitHub wiki) for mcdev configuration, commands, markets, createDeltaPkg, build, validations.',
    {
        query: z.string().describe('Search query (keywords).'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8).'),
    },
    ({ query, limit = 8 }) => {
        const hits = searchDocs(query, limit);
        if (hits.length === 0) {
            return {
                content: [
                    {
                        type: 'text',
                        text:
                            'No matches in bundled wiki. Ensure `npm run bundle-wiki` ran with sfmc-devtools.wiki present, ' +
                            'or set SFMC_DEVTOOLS_WIKI to the wiki checkout path.',
                    },
                ],
            };
        }
        const lines = hits.map((h, i) => {
            const excerpt = getDocExcerpt(h.chunk, query);
            return (
                `### ${i + 1}. ${h.chunk.file} — ${h.chunk.heading}\n` +
                `**Score:** ${h.score}\n` +
                `**Source ID:** ${h.chunk.id}\n` +
                `**Offsets (UTF-16, end exclusive):** ${excerpt.start}-${excerpt.end}/${excerpt.totalLength}\n\n` +
                `${excerpt.text}\n`
            );
        });
        return {
            content: [{ type: 'text', text: lines.join('\n---\n\n') }],
        };
    }
);

// ---------------------------------------------------------------------------
// Tool: mcdev_get_doc_section
// ---------------------------------------------------------------------------

server.tool(
    'mcdev_get_doc_section',
    'Retrieve an unreviewed bundled wiki section by its search Source ID. Returns a JSON page with UTF-16 offsets and nextOffset (null at end); retrieved claims are not semantic endorsements.',
    {
        id: z.string().describe('Opaque Source ID returned by mcdev_search_docs.'),
        offset: z.number().int().min(0).optional().describe('UTF-16 offset (default 0).'),
        limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_SECTION_PAGE_LENGTH)
            .optional()
            .describe(`Page length (default 4000, maximum ${MAX_SECTION_PAGE_LENGTH}).`),
    },
    ({ id, offset = 0, limit = 4000 }) => {
        try {
            const page = getDocSection(id, offset, limit);
            if (!page) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Documentation section unavailable.' }],
                };
            }
            return { content: [{ type: 'text', text: JSON.stringify(page) }] };
        } catch {
            return {
                isError: true,
                content: [{ type: 'text', text: 'Documentation section unavailable.' }],
            };
        }
    }
);

// ---------------------------------------------------------------------------
// Tool: mcdev_explain_config_key
// ---------------------------------------------------------------------------

server.tool(
    'mcdev_explain_config_key',
    'Explain a `.mcdevrc.json` concept (markets, marketList, createDeltaPkg, deployment, validations, etc.) with a short summary and wiki file hints.',
    {
        topic: z
            .string()
            .describe(`Topic key or phrase. Known keys: ${listConfigTopicKeys().join(', ')}`),
    },
    ({ topic }) => {
        const key = resolveTopicKey(topic) ?? resolveTopicKey(topic.replaceAll(/\s+/g, ''));
        if (!key || !CONFIG_TOPICS[key]) {
            return {
                content: [
                    {
                        type: 'text',
                        text:
                            `Unknown topic "${topic}". Try one of: ${listConfigTopicKeys().join(', ')}. ` +
                            'Use mcdev_search_docs for broader questions.',
                    },
                ],
            };
        }
        const t = CONFIG_TOPICS[key];
        const wikiHint = t.relatedWikiFiles.map((f) => `- ${f}`).join('\n');
        const text =
            `## ${t.title}\n\n${t.summary}\n\n### Related bundled wiki files\n${wikiHint}\n\n` +
            'Use **mcdev_search_docs** with specific keywords to pull exact sections.';
        return { content: [{ type: 'text', text }] };
    }
);

// ---------------------------------------------------------------------------
// Tool: mcdev_component_checklist
// ---------------------------------------------------------------------------

server.tool(
    'mcdev_component_checklist',
    'Return a structured checklist of questions and dependent metadata types for authoring or migrating SFMC components with mcdev (e.g. journey, automation).',
    {
        component: z.string().describe('Component key, e.g. "journey", "automation".'),
    },
    ({ component }) => {
        const data = loadChecklists();
        const key = component.trim().toLowerCase();
        const entry = data[key] as
            | {
                  label?: string;
                  description?: string;
                  questions?: { id: string; prompt: string }[];
                  dependentMetadataTypes?: string[];
                  notes?: string[];
              }
            | undefined;

        if (!entry) {
            const available = Object.keys(data).join(', ');
            return {
                content: [
                    {
                        type: 'text',
                        text: `No checklist for "${component}". Available: ${available}.`,
                    },
                ],
            };
        }

        const qs = (entry.questions ?? [])
            .map((q, i) => `${i + 1}. **${q.id}** — ${q.prompt}`)
            .join('\n');
        const deps = (entry.dependentMetadataTypes ?? []).map((d) => `- \`${d}\``).join('\n');
        const notes = (entry.notes ?? []).map((n) => `- ${n}`).join('\n');

        const text = [
            `# ${entry.label ?? key}`,
            '',
            entry.description ?? '',
            '',
            '## Questions',
            qs || '(none)',
            '',
            '## Dependent metadata types (typical)',
            deps || '(none)',
            '',
            '## Notes',
            notes || '(none)',
        ].join('\n');

        return { content: [{ type: 'text', text }] };
    }
);

// ---------------------------------------------------------------------------
// Tool: mcdev_list_metadata_types
// ---------------------------------------------------------------------------

server.tool(
    'mcdev_list_metadata_types',
    'List metadata types supported by the installed mcdev package (from Mcdev.explainTypes). Optional filter substring.',
    {
        filter: z.string().optional().describe('Case-insensitive filter on name or apiName.'),
    },
    ({ filter }) => {
        ensureMcdevSilentJson();
        const types = Mcdev.explainTypes();
        const f = filter?.trim().toLowerCase();
        const rows = types
            .filter((t) => {
                if (!f) return true;
                return t.name.toLowerCase().includes(f) || t.apiName.toLowerCase().includes(f);
            })
            .map((t) => {
                const s = t.supports;
                const flags = [
                    s?.retrieve ? 'R' : '-',
                    s?.create ? 'C' : '-',
                    s?.update ? 'U' : '-',
                    s?.delete ? 'D' : '-',
                    s?.buildTemplate ? 'T' : '-',
                ].join('');
                return `- **${t.apiName}** (${t.name}) [${flags}] — ${t.description}`;
            });

        const text =
            `mcdev ${getBundledMcdevVersion()} — ${rows.length} type(s)\n\n` +
            (rows.length ? rows.join('\n') : 'No types match the filter.');

        return { content: [{ type: 'text', text }] };
    }
);

server.tool(
    'mcdev_list_commands',
    'Read-only reviewed mcdev command declarations and aliases. Guidance-only, not executable commands or an argv allowlist. No subprocess or dry run; native mcdev has no dry-run mode. Effects and execution readiness are not verified.',
    {},
    () => ({ content: [{ type: 'text', text: JSON.stringify(listCommands()) }] })
);

server.tool(
    'mcdev_get_command',
    'Read-only exact, case-sensitive canonical command name or alias lookup. Guidance-only, not an executable command or approval. No subprocess or dry run; native mcdev has no dry-run mode. Effects and execution readiness are not verified.',
    { nameOrAlias: z.string().describe('Exact canonical command name or alias, never argv.') },
    ({ nameOrAlias }) => {
        const command = lookupCommand(nameOrAlias);
        if (!command) {
            return {
                isError: true,
                content: [{ type: 'text', text: 'Unknown reviewed command name or alias.' }],
            };
        }
        return { content: [{ type: 'text', text: JSON.stringify(command) }] };
    }
);

// ---------------------------------------------------------------------------
// Tool: read_mcdev_project_config
// ---------------------------------------------------------------------------

server.tool(
    'read_mcdev_project_config',
    'Read the complete, UNREDACTED `.mcdevrc.json`, including credentials and custom fields, from a canonical absolute project root. Returns original raw text; never reads `.mcdev-auth.json`.',
    {
        workspaceRoot: z
            .string()
            .describe('Absolute path to the mcdev project root containing `.mcdevrc.json`.'),
    },
    ({ workspaceRoot }) => {
        try {
            const result = readProjectConfig(workspaceRoot);
            return { content: [{ type: 'text', text: result.rawText }] };
        } catch (ex) {
            const code = ex instanceof ProjectInspectionError ? ex.code : 'unavailable';
            return {
                isError: true,
                content: [{ type: 'text', text: `Project configuration unavailable: ${code}.` }],
            };
        }
    }
);

// ---------------------------------------------------------------------------
// Tool: diagnose_mcdev_project_config
// ---------------------------------------------------------------------------

server.tool(
    'diagnose_mcdev_project_config',
    'Read-only partial static diagnosis of `.mcdevrc.json`, not native mcdev validation or execution readiness. FIRST use the visual MCDev Pipeline Builder before editing configuration. Returns builder guidance, findings and explicit limitations; never writes files, loads hooks, reads auth or executes native CLI/live checks. Prevent concurrent filesystem mutation.',
    {
        workspaceRoot: z.string().describe('Canonical absolute mcdev project root.'),
    },
    ({ workspaceRoot }) => {
        try {
            const diagnosis = diagnoseProjectConfig(readProjectConfig(workspaceRoot));
            const { recommendation } = diagnosis;
            return {
                content: [
                    {
                        type: 'text',
                        text: `${recommendation.firstStep}\n${recommendation.url}\n${recommendation.guidance}\n\nPartial static diagnosis only; not native mcdev validation or execution readiness.`,
                    },
                    { type: 'text', text: JSON.stringify(diagnosis) },
                ],
            };
        } catch {
            return {
                isError: true,
                content: [{ type: 'text', text: 'Project configuration diagnosis unavailable.' }],
            };
        }
    }
);

// ---------------------------------------------------------------------------
// Tool: inspect_mcdev_git_policy
// ---------------------------------------------------------------------------

server.tool(
    'inspect_mcdev_git_policy',
    'Read-only Git metadata inspection, not verified policy or execution readiness. Ancestry uses a local remote-tracking snapshot, not fresh remote state. Branch roles, ticket and commit-prefix conventions remain unresolved; remote BU synchronization is unknown. Top-level verified covers status metadata only; refs.verified is independent. Separate from inspect_mcdev_project auth protection checks. No policy persistence, branch changes, commit-message/history/auth/artifact-content reads or native mcdev/live execution. Prevent concurrent project/Git mutation; not an atomic snapshot.',
    {
        workspaceRoot: z.string().describe('Canonical absolute mcdev project root.'),
    },
    ({ workspaceRoot }) => {
        try {
            const result = inspectProjectGitPolicy(workspaceRoot);
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Read-only Git metadata only. Ancestry is a local remote-tracking snapshot, not fresh remote state. Policy conventions remain unresolved; remote BU synchronization is unknown. Top-level verified covers status metadata only; refs.verified is independent. This does not replace inspect_mcdev_project auth protection checks. Prevent concurrent project/Git mutation; not an atomic snapshot.',
                    },
                    { type: 'text', text: JSON.stringify(result) },
                ],
            };
        } catch {
            return {
                isError: true,
                content: [{ type: 'text', text: 'Project Git policy inspection unavailable.' }],
            };
        }
    }
);

// ---------------------------------------------------------------------------
// Tool: inspect_mcdev_project
// ---------------------------------------------------------------------------

server.tool(
    'inspect_mcdev_project',
    'Read the complete UNREDACTED project config, including credentials, and independently inspect Git ignore/index metadata for auth protection. Read-only: never reads auth contents or history and never repairs, stages or untracks files.',
    {
        workspaceRoot: z.string().describe('Canonical absolute mcdev project root.'),
    },
    ({ workspaceRoot }) => {
        try {
            const project = readProjectConfig(workspaceRoot);
            const gitSecurity = inspectProjectGitSecurity(workspaceRoot);
            const warnings = gitSecurity.findings.map((finding) => finding.message);
            if (gitSecurity.tracking.tracked === true) {
                warnings.push(
                    'CRITICAL: Treat indexed credentials as potentially exposed. Investigate exposure securely without sharing auth contents; rotate or revoke affected credentials through the appropriate secure process. An ignore rule does not remove indexed files or past exposure.'
                );
            }
            if (gitSecurity.findings.length > 0) {
                warnings.push(
                    'Request explicit user approval before any proposed .gitignore repair. No repair, staging, untracking, history inspection or auth inspection was performed.'
                );
            }
            return {
                content: [
                    {
                        type: 'text',
                        text:
                            warnings.join('\n\n') ||
                            'Project ignore and tracking checks verified; this is not a comprehensive security audit.',
                    },
                    {
                        type: 'text',
                        text: JSON.stringify({ ...project, gitSecurity }),
                    },
                ],
            };
        } catch (ex) {
            const code = ex instanceof ProjectInspectionError ? ex.code : 'unavailable';
            return {
                isError: true,
                content: [{ type: 'text', text: `Project inspection unavailable: ${code}.` }],
            };
        }
    }
);

const artifactToolSchema = {
    workspaceRoot: z.string().describe('Canonical absolute mcdev project root.'),
    maxEntries: z.number().int().min(1).max(10000).optional(),
    maxDepth: z.number().int().min(1).max(12).optional(),
};

server.tool(
    'inventory_mcdev_project_artifacts',
    'Read-only, metadata-only inventory of configured retrieve/deploy paths; does not open artifact contents or confirm dependencies. Never reads auth contents or logs. No guarantee of remote freshness or an atomic filesystem sandbox; prevent concurrent filesystem mutation.',
    artifactToolSchema,
    ({ workspaceRoot, maxEntries, maxDepth }) => {
        try {
            const project = readProjectConfig(workspaceRoot);
            const result = inventoryProjectArtifacts(project, {
                ...(maxEntries === undefined ? {} : { maxEntries }),
                ...(maxDepth === undefined ? {} : { maxDepth }),
            });
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch {
            return {
                isError: true,
                content: [{ type: 'text', text: 'Project artifact inventory unavailable.' }],
            };
        }
    }
);

server.tool(
    'resolve_mcdev_project_artifact',
    'Read-only qualified local resolution for query, script and bounded asset-email layouts (htmlemail/templatebasedemail matched by customerKey, with exact HTML/preheader/text extract companions); other types and layouts are unsupported. Returns paths, not arbitrary file contents, and does not confirm dependencies. Blocked/ambiguous results offer no editable companions. Never reads auth contents or logs. No guarantee of remote freshness or an atomic filesystem sandbox; prevent concurrent filesystem mutation.',
    {
        ...artifactToolSchema,
        rootKind: z.enum(['retrieve', 'deploy']),
        credential: z.string(),
        businessUnit: z.string(),
        metadataType: z
            .string()
            .describe(
                'query, script or asset-email (bounded htmlemail/templatebasedemail layouts only).'
            ),
        externalKey: z.string(),
    },
    ({ workspaceRoot, maxEntries, maxDepth, ...selector }) => {
        try {
            const project = readProjectConfig(workspaceRoot);
            const result = resolveProjectArtifact(project, selector, {
                ...(maxEntries === undefined ? {} : { maxEntries }),
                ...(maxDepth === undefined ? {} : { maxDepth }),
            });
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch {
            return {
                isError: true,
                content: [{ type: 'text', text: 'Project artifact resolution unavailable.' }],
            };
        }
    }
);

server.tool(
    'read_mcdev_artifact_source',
    'Read-only full-text editable-source handoff for one qualified query, script or bounded asset-email identity (htmlemail/templatebasedemail matched by customerKey with exact HTML/preheader/text extracts), never a caller-supplied file path. Requires exactly one editable companion unless an explicit sourceRole selects html, preheader or text from resolved email companions; multiple companions need an explicit role or are blocked with no source and no guessed choice. sourceRole accepts no arbitrary filenames or paths and applies only to resolved email companions. Dependencies are not confirmed. Returns complete original UTF-8 text (including BOM) and SHA-256 of original file bytes without truncation; unresolved or blocked results never contain source. No rendering, validation, mutation, native modules or live execution is performed; execution readiness is unknown. The host must discover companion capabilities and coordinate platform detection, identifier lookup and full-document validate_ssjs, validate_sfmc_html or validate_ampscript as appropriate. Email html requires validate_sfmc_html; preheader/text have language text and text-validator-not-established, not an inferred AMPscript validator. SQL validation is not established. Do not claim companion tools were performed. Prevent concurrent filesystem mutation: bounded checks are not atomic or a concurrent-mutation sandbox. Never reads auth contents or logs.',
    {
        ...artifactToolSchema,
        rootKind: z.enum(['retrieve', 'deploy']),
        credential: z.string(),
        businessUnit: z.string(),
        metadataType: z
            .string()
            .describe(
                'query, script or asset-email (bounded htmlemail/templatebasedemail layouts only).'
            ),
        externalKey: z.string(),
        sourceRole: z.enum(['html', 'preheader', 'text']).optional(),
    },
    ({ workspaceRoot, maxEntries, maxDepth, sourceRole, ...selector }) => {
        try {
            const project = readProjectConfig(workspaceRoot);
            const result = readProjectArtifactSource(
                project,
                selector,
                {
                    ...(maxEntries === undefined ? {} : { maxEntries }),
                    ...(maxDepth === undefined ? {} : { maxDepth }),
                },
                sourceRole
            );
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch {
            return {
                isError: true,
                content: [{ type: 'text', text: 'Project artifact source unavailable.' }],
            };
        }
    }
);

server.tool(
    'preview_mcdev_project_command',
    'Read-only, guidance-only project-qualified retrieve/deploy preview. Verifies only the explicit credential/businessUnit config mapping; execution readiness and configured paths remain unknown. Generic native effects are not proven project-local effects. No subprocess, hooks, auth/log reads or live checks. Not a dry run: native mcdev has no dry-run mode. Execution remains disabled; this cannot authorize an operation. Prevent concurrent filesystem mutation.',
    {
        workspaceRoot: z.string().describe('Canonical absolute mcdev project root.'),
        command: z.enum(['retrieve', 'deploy']),
        credential: z.string().describe('Exact project credential mapping name.'),
        businessUnit: z.string().describe('Exact businessUnit alias within this credential.'),
        type: z
            .string()
            .describe('Reviewed type: automation, asset-email, dataExtension, query or script.'),
        key: z.string().describe('One explicit literal external key; no CSV or wildcards.'),
        options: z
            .strictObject({
                skipValidation: z.boolean().optional(),
                fix: z.boolean().optional(),
                format: z.boolean().optional(),
                skipInteraction: z.boolean().optional(),
                purge: z.boolean().optional(),
                onlyPublished: z.boolean().optional(),
                fromRetrieve: z.boolean().optional(),
                refresh: z.boolean().optional(),
                execute: z.boolean().optional(),
                schedule: z.boolean().optional(),
                fixShared: z.boolean().optional(),
                noUpdate: z.boolean().optional(),
                api: z.literal('log').optional(),
            })
            .optional()
            .describe(
                'Canonical reviewed options only; command/type compatibility is checked by the adapter. These describe native guidance, never execution.'
            ),
    },
    ({ workspaceRoot, ...request }) => {
        try {
            const project = readProjectConfig(workspaceRoot);
            const result = previewProjectCommand(project, request);
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (ex) {
            const text =
                ex instanceof ProjectInspectionError
                    ? 'Project command preview blocked: configuration unavailable.'
                    : 'Project command preview blocked: unsupported selectors, options or configured directories.';
            return { isError: true, content: [{ type: 'text', text }] };
        }
    }
);

// ---------------------------------------------------------------------------
// Resource: wiki file list
// ---------------------------------------------------------------------------

server.resource('mcdev-wiki-index', 'mcdev://wiki/index', async () => {
    const chunks = getChunks();
    const files = [...new Set(chunks.map((c) => c.file))].toSorted();
    const text =
        `# Bundled wiki files (${files.length})\n\n` +
        files.map((f) => `- ${f}`).join('\n') +
        `\n\nTotal sections: ${chunks.length}.`;
    return {
        contents: [{ uri: 'mcdev://wiki/index', mimeType: 'text/markdown', text }],
    };
});

// ---------------------------------------------------------------------------
// Prompt: plan_mcdev_change
// ---------------------------------------------------------------------------

server.prompt(
    'plan_mcdev_change',
    'Plan an mcdev retrieve/build/deploy change using wiki-backed checks and dependency awareness.',
    {
        goal: z.string().describe('What you want to do in SFMC via mcdev.'),
        workspaceRoot: z
            .string()
            .optional()
            .describe('Path to mcdev project for optional config inspection.'),
    },
    ({ goal, workspaceRoot }) => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: [
                        'You are helping plan an Accenture SFMC DevTools (mcdev) change. These tools do not execute a complete retrieve/build/deploy workflow; do not claim those operations were performed.',
                        '',
                        '## Instructions',
                        '1. Call **mcdev_search_docs** with keywords from the goal (markets, createDeltaPkg, build, journey, etc.).',
                        '2. If configuration matters, call **mcdev_explain_config_key** for relevant keys.',
                        '3. For journeys/automations, call **mcdev_component_checklist** with the component name.',
                        '4. Call **mcdev_list_metadata_types** if you need apiName lists.',
                        workspaceRoot
                            ? `5. Call **inspect_mcdev_project** with workspaceRoot \`${workspaceRoot}\`; surface critical Git auth ignore/tracked warnings first. Never read, search, hash, copy or expose auth/log contents. Request approval before ignore repairs; tracked auth can remain exposed despite ignore rules. Call **inspect_mcdev_git_policy** for Git metadata only, not verified conventions or fresh remote state.`
                            : '5. Ask for the canonical absolute workspaceRoot before project-qualified inspection or source handoff.',
                        '6. Call **inventory_mcdev_project_artifacts**, then **resolve_mcdev_project_artifact** with explicit workspaceRoot, rootKind (retrieve/deploy), credential, businessUnit, metadataType and externalKey. Do not guess across roots, BUs or keys; stop on blocked, ambiguous or unsupported resolution. Dependencies and remote freshness remain unconfirmed.',
                        '7. Call **read_mcdev_artifact_source** with that qualified identity, never an arbitrary path. For multiple email extracts, ask which sourceRole (html, preheader or text) to select; do not guess. Use the selected editable role and complete original text plus SHA-256 of original bytes, not JSON metadata or a truncated snippet; re-read after edits to bind validation to the current full document and hash.',
                        '8. The host must discover available companion tool schemas before use; sibling tools are optional and cannot be assumed available. Discover **detect_sfmc_platform**, then detect the project platform before language lookups or validation. An mcdev project targets Marketing Cloud Engagement: use target engagement only after confirmation; stop and clarify unknown or conflicting detection. Discover **lookup_ssjs_function** / **lookup_ampscript_function** for relevant identifiers before authoring; honor supported status, caveats and required polyfills. Route selected SSJS to **validate_ssjs** and selected email HTML (including mixed content) to **validate_sfmc_html**, passing the complete current document and target engagement. Use **validate_ampscript** only for established AMPscript source, not every .amp file. Preheader/text are text-validator-not-established; SQL validation is not established. Do not infer validators from extensions alone.',
                        '9. The host coordinates these calls; this server performs no server-to-server RPC and embeds no duplicated language data. If a companion capability is missing, explicitly report unperformed lookups/validation and limitations; stop only when that capability is essential to the requested work. Never claim native rendering was performed: no Builder calls, rendering or native dry-run. These tools do not execute retrieve/build/deploy.',
                        '10. For retrieve/deploy guidance only, call **preview_mcdev_project_command** with the explicit project credential/businessUnit, reviewed type and one literal key. Execution readiness remains unknown; a preview is not a dry-run or authorization and performs no execution. Before any later vendor-write targeted retrieve, require explicit overwrite approval for existing local artifacts, including clean or companion-only files. No broad fallback retrieve, sends, publish or runtime operations.',
                        '',
                        '## Goal',
                        goal,
                    ]
                        .filter(Boolean)
                        .join('\n'),
                },
            },
        ],
    })
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    ensureMcdevSilentJson();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('mcp-server-mcdev running on stdio\n');
}

try {
    await main();
} catch (ex: unknown) {
    process.stderr.write(`Fatal: ${String(ex)}\n`);
    process.exit(1);
}
