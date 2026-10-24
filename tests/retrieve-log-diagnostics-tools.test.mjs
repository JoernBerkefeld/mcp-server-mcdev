import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

assert.ok(process.env.TEMP);
for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) continue;
    assert.ok(path.isAbsolute(value));
    assert.equal(
        path
            .resolve(value)
            .replaceAll(/[\\/]+$/gu, '')
            .toLowerCase(),
        String.raw`f:\temp`
    );
}
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-log-tool-')));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
// Retain run-owned synthetic fixtures; no recursive cleanup, real logs or native execution.
const secret = 'PRIVATE_LOG_PROTOCOL_SENTINEL';
fs.writeFileSync(
    path.join(root, '.mcdevrc.json'),
    JSON.stringify({
        credentials: { sample: { businessUnits: { Training: '1001' } } },
        privateCustomProperty: secret,
    })
);
const input = {
    workspaceRoot: root,
    credential: 'sample',
    businessUnit: 'Training',
    metadataType: 'query',
    key: 'example.key-1',
    startedAfter: '2026-10-22T11:00:00.000Z',
    startedBefore: '2026-10-22T13:00:00.000Z',
};
const file = '2026-10-22T12.00.00.000Z.log';
const fixture = (type) =>
    [
        `14:00:00.000 debug: :: mcdev 10.1.0 :: ⚡ mcdev retrieve sample/Training ${type} example.key-1`,
        '14:00:00.001 info: mcdev:: Retrieve',
        '14:00:00.002 info: :: Retrieving sample/Training',
        `14:00:00.003 info: Retrieving: ${type} - Key: example.key-1`,
        `14:00:00.004 info: Downloaded: ${type} (0) - Key: example.key-1`,
        `14:00:00.005 error: ${secret} parser/API/authorization payload`,
    ].join('\n');

function safe(result) {
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LOG|ENOENT|ZodError|parser\/API/u);
    assert.ok(!JSON.stringify(result).includes(root));
}

test(
    'dedicated historical-log stdio registration is strict, read-only and sanitized',
    { timeout: 30_000 },
    async () => {
        const client = new Client({ name: 'log-protocol-test', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: root,
            stderr: 'pipe',
        });
        try {
            await client.connect(transport);
            const { tools } = await client.listTools();
            assert.equal(tools.length, 22);
            assert.deepEqual(
                tools.map((entry) => entry.name).toSorted(),
                [
                    'diagnose_mcdev_retrieve_logs',
                    'prepare_mcdev_query_retrieve',
                    'retrieve_mcdev_query',
                    'retrieve_mcdev_script',
                    'mcdev_search_docs',
                    'mcdev_get_doc_section',
                    'mcdev_explain_config_key',
                    'mcdev_component_checklist',
                    'mcdev_list_metadata_types',
                    'mcdev_list_commands',
                    'mcdev_get_command',
                    'read_mcdev_project_config',
                    'diagnose_mcdev_project_config',
                    'preview_mcdev_project_config',
                    'inspect_mcdev_git_policy',
                    'inspect_mcdev_git_range',
                    'inspect_mcdev_project',
                    'inventory_mcdev_project_artifacts',
                    'resolve_mcdev_project_artifact',
                    'read_mcdev_artifact_source',
                    'preview_mcdev_project_command',
                    'render_mcdev_query_definition',
                ].toSorted()
            );
            const tool = tools.find((entry) => entry.name === 'diagnose_mcdev_retrieve_logs');
            assert.ok(tool);
            assert.deepEqual(tool.inputSchema.required, Object.keys(input));
            assert.deepEqual(Object.keys(tool.inputSchema.properties), Object.keys(input));
            assert.equal(tool.inputSchema.additionalProperties, false);
            assert.deepEqual(tool.inputSchema.properties.metadataType.enum, ['query', 'script']);
            assert.deepEqual(tool.annotations, {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
            });
            for (const phrase of [
                'historical',
                'quiescence',
                '--noLogFile',
                'No subprocess',
                'never raw logs',
                'manual',
            ])
                assert.ok(tool.description.includes(phrase), phrase);
            const call = (args) => client.callTool({ name: tool.name, arguments: args });
            for (const args of [
                {},
                { ...input, [secret]: secret },
                { ...input, metadataType: secret },
                { ...input, key: { [secret]: secret } },
                { ...input, credential: [secret] },
                { ...input, businessUnit: null },
                { ...input, workspaceRoot: 5 },
                { ...input, startedAfter: false },
                { ...input, startedBefore: {} },
            ]) {
                const result = await call(args);
                safe(result);
                assert.equal(result.isError, true);
                assert.match(result.content[0].text, /Retrieve log diagnosis unavailable\./u);
            }
            for (const changes of [
                { key: '*' },
                { key: 'one two' },
                { key: 'one,two' },
                { startedAfter: '2026-10-22T11:00:00Z' },
                { startedBefore: '2026-10-24T13:00:00.000Z' },
            ]) {
                const result = await call({ ...input, ...changes });
                safe(result);
                assert.deepEqual(JSON.parse(result.content[0].text), {
                    status: 'unsupported',
                    remoteCompletenessVerified: false,
                    logs: [],
                });
            }
            for (const [changes, status] of [
                [{}, 'no-match'],
                [{ credential: secret }, 'blocked'],
                [{ workspaceRoot: 'relative' }, 'unavailable'],
            ]) {
                const result = await call({ ...input, ...changes });
                safe(result);
                assert.deepEqual(JSON.parse(result.content[0].text), {
                    status,
                    remoteCompletenessVerified: false,
                    logs: [],
                });
            }
            fs.mkdirSync(path.join(root, 'logs'));
            fs.writeFileSync(path.join(root, 'logs', file.replace('.log', '-errors.log')), secret);
            for (const metadataType of ['query', 'script']) {
                fs.writeFileSync(path.join(root, 'logs', file), fixture(metadataType));
                const result = await call({ ...input, metadataType });
                safe(result);
                assert.deepEqual(JSON.parse(result.content[0].text), {
                    status: 'matched',
                    remoteCompletenessVerified: false,
                    logs: [
                        {
                            file,
                            invocationStartedAt: '2026-10-22T12:00:00.000Z',
                            findings: [
                                { code: 'retrieve-start-observed', occurrences: 1 },
                                { code: 'type-key-observed', occurrences: 1 },
                                { code: 'download-zero-observed', occurrences: 1 },
                            ],
                            suppressedRecordCount: 1,
                        },
                    ],
                });
            }
            fs.writeFileSync(path.join(root, 'logs', file), `14:00:00.000 error: ${secret}`);
            const unknown = await call(input);
            safe(unknown);
            assert.deepEqual(JSON.parse(unknown.content[0].text), {
                status: 'no-match',
                remoteCompletenessVerified: false,
                logs: [],
            });
            assert.deepEqual(fs.readdirSync(root).toSorted(), ['.mcdevrc.json', '.owner', 'logs']);
        } finally {
            await client.close();
        }
    }
);
