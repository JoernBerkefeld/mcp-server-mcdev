import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { previewProjectConfig } from '../dist/project-config-preview.js';

for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) continue;
    assert.ok(path.isAbsolute(value));
    assert.equal(
        path
            .resolve(value)
            .replaceAll(/[\\/]+$/gu, '')
            .toLowerCase(),
        path.normalize('F:/Temp').toLowerCase()
    );
}
assert.ok(process.env.TEMP);
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-config-preview-tools-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Keep owned synthetic fixtures; no recursive cleanup.
const sentinel = 'synthetic-config-private-fragment';
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
function fixture(raw) {
    const root = fs.mkdtempSync(path.join(runRoot, 'project-'));
    if (raw !== undefined) fs.writeFileSync(path.join(root, '.mcdevrc.json'), raw);
    return root;
}

test(
    'config preview protocol preserves complete bounded comparison without mutation',
    { timeout: 30_000 },
    async (t) => {
        const config = {
            credentials: {
                first: { businessUnits: { source: '123', removed: '456' } },
                second: { businessUnits: { target: '789' } },
            },
            markets: { old: { custom: sentinel } },
            marketList: { deploy: { 'first/source': 'old' } },
            directories: { retrieve: 'retrieve' },
            custom: { nested: [true, null, sentinel], 'a/b~': 'é😀' },
            removeMe: { retainBefore: sentinel },
        };
        const rawText = `  ${JSON.stringify(config, null, 2)}\r\n`;
        const root = fixture(rawText);
        const project = {
            projectRoot: root,
            configPath: path.join(root, '.mcdevrc.json'),
            rawText,
            config,
        };
        const client = new Client({ name: 'config-preview-protocol', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: runRoot,
            stderr: 'pipe',
        });
        const invoke = (proposedConfig, extra = {}) =>
            client.callTool({
                name: 'preview_mcdev_project_config',
                arguments: { workspaceRoot: root, proposedConfig, ...extra },
            });
        const unchanged = () => {
            assert.equal(fs.readFileSync(project.configPath, 'utf8'), rawText);
            assert.deepEqual(fs.readdirSync(root), ['.mcdevrc.json']);
        };
        try {
            await client.connect(transport);
            await t.test(
                'exact schema bounds and explicit complete-document limitations',
                async () => {
                    const { tools } = await client.listTools();
                    const tool = tools.find(
                        (entry) => entry.name === 'preview_mcdev_project_config'
                    );
                    assert.ok(tool);
                    assert.equal(tools.length, 17);
                    assert.deepEqual(Object.keys(tool.inputSchema.properties), [
                        'workspaceRoot',
                        'proposedConfig',
                        'maxOutputBytes',
                    ]);
                    assert.deepEqual(tool.inputSchema.required, [
                        'workspaceRoot',
                        'proposedConfig',
                    ]);
                    assert.equal(tool.inputSchema.type, 'object');
                    assert.equal(tool.inputSchema.properties.workspaceRoot.type, 'string');
                    assert.equal(tool.inputSchema.properties.proposedConfig.type, 'string');
                    assert.equal(tool.inputSchema.properties.maxOutputBytes.type, 'integer');
                    assert.equal(tool.inputSchema.properties.maxOutputBytes.minimum, 1);
                    assert.equal(tool.inputSchema.properties.maxOutputBytes.maximum, 1048576);
                    for (const phrase of [
                        'complete proposed JSON document, not a patch',
                        'FIRST',
                        'unredacted',
                        '1 MiB',
                        'without normalization',
                        'No writes',
                        'apply authorization',
                        'native validation',
                        'execution readiness',
                        'atomic filesystem binding',
                        'Never reads auth or logs',
                    ])
                        assert.ok(tool.description.includes(phrase), phrase);
                    assert.ok(tools.some((entry) => entry.name === 'read_mcdev_project_config'));
                }
            );
            await t.test('unchanged semantics retain rawText UTF-8 hash fidelity', async () => {
                const proposed = JSON.stringify(config);
                const response = await invoke(proposed);
                assert.notEqual(response.isError, true);
                assert.equal(response.content.length, 2);
                assert.match(response.content[0].text, /^FIRST.*Pipeline Builder/u);
                assert.match(
                    response.content[0].text,
                    /https:\/\/sfmc.guide\/tools\/mcdev-pipeline-builder\//u
                );
                assert.ok(!response.content[0].text.includes(sentinel));
                const result = JSON.parse(response.content[1].text);
                assert.deepEqual(result, previewProjectConfig(project, proposed));
                assert.deepEqual(result.changes, []);
                assert.equal(result.current.sha256, hash(rawText));
                assert.equal(result.proposed.sha256, hash(proposed));
                assert.notEqual(result.current.sha256, result.proposed.sha256);
                assert.equal(result.current.bytes, Buffer.byteLength(rawText, 'utf8'));
                assert.equal(
                    result.current.basis,
                    'rawText encoded as UTF-8, without normalization'
                );
                unchanged();
            });
            await t.test(
                'full topology and custom before/after values plus proposed diagnosis survive',
                async () => {
                    const proposed = structuredClone(config);
                    delete proposed.credentials.first.businessUnits.removed;
                    proposed.credentials.second.businessUnits.added = '101';
                    proposed.markets = { next: { arbitrary: [sentinel] } };
                    proposed.directories.retrieve = 7;
                    proposed.custom.nested = [sentinel, false];
                    proposed.custom['a/b~'] = 'changed';
                    delete proposed.removeMe;
                    const text = `${JSON.stringify(proposed, null, 4)}\n`;
                    const response = await invoke(text);
                    const result = JSON.parse(response.content[1].text);
                    assert.deepEqual(result, previewProjectConfig(project, text));
                    assert.ok(
                        result.changes.some(
                            (entry) =>
                                entry.path === '/credentials/first/businessUnits/removed' &&
                                entry.op === 'remove' &&
                                entry.before === '456'
                        )
                    );
                    assert.ok(
                        result.changes.some(
                            (entry) =>
                                entry.path === '/credentials/second/businessUnits/added' &&
                                entry.after === '101'
                        )
                    );
                    assert.ok(
                        result.changes.some(
                            (entry) => entry.path === '/custom/a~1b~0' && entry.before === 'é😀'
                        )
                    );
                    assert.deepEqual(
                        result.changes.find((entry) => entry.path === '/custom/nested').after,
                        [sentinel, false]
                    );
                    assert.deepEqual(
                        result.changes.find((entry) => entry.path === '/removeMe').before,
                        config.removeMe
                    );
                    assert.ok(
                        result.diagnosis.findings.some(
                            (entry) => entry.code === 'invalid-directory'
                        )
                    );
                    assert.ok(
                        result.diagnosis.findings.some(
                            (entry) => entry.code === 'unresolved-market'
                        )
                    );
                    for (const value of Object.values(result.diagnosis.recommendation))
                        assert.equal(typeof value, 'string');
                    assert.match(result.diagnosis.recommendation.firstStep, /Pipeline Builder/u);
                    assert.ok(Buffer.byteLength(response.content[1].text) <= 65536);
                    const read = await client.callTool({
                        name: 'read_mcdev_project_config',
                        arguments: { workspaceRoot: root },
                    });
                    assert.equal(read.content[0].text, rawText);
                    unchanged();
                }
            );
            await t.test(
                'classified limits fail closed with no fragments or partial changes',
                async () => {
                    const deep = '{"x":'.repeat(66) + '0' + '}'.repeat(66);
                    for (const [proposed, code, extra] of [
                        [`{"${sentinel}":`, 'invalid-json'],
                        ['[]', 'non-object'],
                        ['null', 'non-object'],
                        ['7', 'non-object'],
                        [JSON.stringify({ [sentinel]: 'é'.repeat(524288) }), 'input-too-large'],
                        [deep, 'complexity-limit'],
                        [
                            JSON.stringify({ [sentinel]: [1] }),
                            'output-budget',
                            { maxOutputBytes: 1 },
                        ],
                        [rawText, 'output-budget', { maxOutputBytes: 100 }],
                    ]) {
                        const response = await invoke(proposed, extra);
                        assert.equal(response.isError, true);
                        assert.deepEqual(response.content, [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    complete: false,
                                    code,
                                    message: 'Project configuration preview incomplete.',
                                }),
                            },
                        ]);
                        assert.ok(!JSON.stringify(response).includes(sentinel));
                        unchanged();
                    }
                }
            );
            await t.test(
                'current failures are fixed unavailable and schema rejects wrong types and budgets',
                async () => {
                    for (const workspaceRoot of [
                        'relative-private',
                        fixture(),
                        fixture(`{"${sentinel}":`),
                        fixture('[]'),
                        fixture(JSON.stringify({ [sentinel]: 'x'.repeat(1048576) })),
                        fixture('{"x":'.repeat(66) + '0' + '}'.repeat(66)),
                    ]) {
                        const response = await invoke('{}', { workspaceRoot });
                        assert.equal(response.isError, true);
                        const failure = JSON.parse(response.content[0].text);
                        assert.equal(failure.complete, false);
                        assert.ok(['unavailable', 'complexity-limit'].includes(failure.code));
                        assert.equal(
                            failure.message,
                            failure.code === 'unavailable'
                                ? 'Project configuration preview unavailable.'
                                : 'Project configuration preview incomplete.'
                        );
                        assert.doesNotMatch(
                            JSON.stringify(response),
                            /synthetic-config-private|ENOENT|SyntaxError|node:fs|stack/u
                        );
                    }
                    for (const args of [
                        {},
                        { workspaceRoot: root, proposedConfig: {} },
                        ...[0, -1, 1.5, 1048577, '10'].map((maxOutputBytes) => ({
                            workspaceRoot: root,
                            proposedConfig: '{}',
                            maxOutputBytes,
                        })),
                    ]) {
                        const response = await client.callTool({
                            name: 'preview_mcdev_project_config',
                            arguments: args,
                        });
                        assert.equal(response.isError, true);
                    }
                    unchanged();
                }
            );
        } finally {
            await client.close();
        }
    }
);
