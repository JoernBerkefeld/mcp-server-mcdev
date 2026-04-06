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
import { getChunks, searchDocs } from './doc-search.js';
import { ensureMcdevSilentJson, getBundledMcdevVersion } from './mcdev-safe.js';

function projectPackageRoot(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const pkg = JSON.parse(fs.readFileSync(path.join(projectPackageRoot(), 'package.json'), 'utf8')) as {
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
                content: [{
                    type: 'text',
                    text:
                        'No matches in bundled wiki. Ensure `npm run bundle-wiki` ran with sfmc-devtools.wiki present, ' +
                        'or set SFMC_DEVTOOLS_WIKI to the wiki checkout path.',
                }],
            };
        }
        const lines = hits.map((h, i) => {
            const excerpt = h.chunk.body.replace(/\s+/g, ' ').slice(0, 420);
            return `### ${i + 1}. ${h.chunk.file} — ${h.chunk.heading}\n` +
                `**Score:** ${h.score}\n\n${excerpt}${h.chunk.body.length > 420 ? '…' : ''}\n`;
        });
        return {
            content: [{ type: 'text', text: lines.join('\n---\n\n') }],
        };
    },
);

// ---------------------------------------------------------------------------
// Tool: mcdev_explain_config_key
// ---------------------------------------------------------------------------

server.tool(
    'mcdev_explain_config_key',
    'Explain a `.mcdevrc.json` concept (markets, marketList, createDeltaPkg, deployment, validations, etc.) with a short summary and wiki file hints.',
    {
        topic: z.string().describe(
            `Topic key or phrase. Known keys: ${listConfigTopicKeys().join(', ')}`,
        ),
    },
    ({ topic }) => {
        const key = resolveTopicKey(topic) ?? resolveTopicKey(topic.replace(/\s+/g, ''));
        if (!key || !CONFIG_TOPICS[key]) {
            return {
                content: [{
                    type: 'text',
                    text:
                        `Unknown topic "${topic}". Try one of: ${listConfigTopicKeys().join(', ')}. ` +
                        'Use mcdev_search_docs for broader questions.',
                }],
            };
        }
        const t = CONFIG_TOPICS[key];
        const wikiHint = t.relatedWikiFiles.map((f) => `- ${f}`).join('\n');
        const text =
            `## ${t.title}\n\n${t.summary}\n\n### Related bundled wiki files\n${wikiHint}\n\n` +
            'Use **mcdev_search_docs** with specific keywords to pull exact sections.';
        return { content: [{ type: 'text', text }] };
    },
);

// ---------------------------------------------------------------------------
// Tool: mcdev_component_checklist
// ---------------------------------------------------------------------------

server.tool(
    'mcdev_component_checklist',
    'Return a structured checklist of questions and dependent metadata types for authoring or migrating SFMC components with mcdev (e.g. journey, automation).',
    {
        component: z
            .string()
            .describe('Component key, e.g. "journey", "automation".'),
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
                content: [{
                    type: 'text',
                    text: `No checklist for "${component}". Available: ${available}.`,
                }],
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
    },
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
    },
);

// ---------------------------------------------------------------------------
// Tool: read_mcdev_project_config
// ---------------------------------------------------------------------------

server.tool(
    'read_mcdev_project_config',
    'Read `.mcdevrc.json` from a workspace path (never reads `.mcdev-auth.json`). Use to inspect markets and marketList with the assistant.',
    {
        workspaceRoot: z.string().describe('Absolute path to the mcdev project root containing `.mcdevrc.json`.'),
    },
    ({ workspaceRoot }) => {
        const p = path.join(workspaceRoot, '.mcdevrc.json');
        if (!fs.existsSync(p)) {
            return {
                content: [{ type: 'text', text: `File not found: ${p}` }],
            };
        }
        const raw = fs.readFileSync(p, 'utf8');
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            delete parsed.credentials;
            const redacted = JSON.stringify(parsed, null, 2);
            return {
                content: [{
                    type: 'text',
                    text:
                        '`.mcdevrc.json` (credentials object removed if present — use mcdev auth file for secrets; not shown):\n\n' +
                        '```json\n' +
                        redacted +
                        '\n```\n',
                }],
            };
        } catch {
            return { content: [{ type: 'text', text: `Invalid JSON: ${p}` }] };
        }
    },
);

// ---------------------------------------------------------------------------
// Resource: wiki file list
// ---------------------------------------------------------------------------

server.resource(
    'mcdev-wiki-index',
    'mcdev://wiki/index',
    async () => {
        const chunks = getChunks();
        const files = [...new Set(chunks.map((c) => c.file))].sort();
        const text =
            `# Bundled wiki files (${files.length})\n\n` +
            files.map((f) => `- ${f}`).join('\n') +
            `\n\nTotal sections: ${chunks.length}.`;
        return {
            contents: [{ uri: 'mcdev://wiki/index', mimeType: 'text/markdown', text }],
        };
    },
);

// ---------------------------------------------------------------------------
// Prompt: plan_mcdev_change
// ---------------------------------------------------------------------------

server.prompt(
    'plan_mcdev_change',
    'Plan an mcdev retrieve/build/deploy change using wiki-backed checks and dependency awareness.',
    {
        goal: z.string().describe('What you want to do in SFMC via mcdev.'),
        workspaceRoot: z.string().optional().describe('Path to mcdev project for optional config inspection.'),
    },
    ({ goal, workspaceRoot }) => ({
        messages: [{
            role: 'user',
            content: {
                type: 'text',
                text: [
                    'You are helping with Accenture SFMC DevTools (mcdev).',
                    '',
                    '## Instructions',
                    '1. Call **mcdev_search_docs** with keywords from the goal (markets, createDeltaPkg, build, journey, etc.).',
                    '2. If configuration matters, call **mcdev_explain_config_key** for relevant keys.',
                    '3. For journeys/automations, call **mcdev_component_checklist** with the component name.',
                    '4. Call **mcdev_list_metadata_types** if you need apiName lists.',
                    workspaceRoot
                        ? `5. Optionally call **read_mcdev_project_config** with workspaceRoot \`${workspaceRoot}\`.`
                        : '',
                    '',
                    '## Goal',
                    goal,
                ].filter(Boolean).join('\n'),
            },
        }],
    }),
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

main().catch((error: unknown) => {
    process.stderr.write(`Fatal: ${String(error)}\n`);
    process.exit(1);
});
