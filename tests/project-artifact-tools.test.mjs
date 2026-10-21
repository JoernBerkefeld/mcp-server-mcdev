import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) continue;
    assert.ok(path.isAbsolute(value), 'temporary paths must be absolute');
    assert.equal(
        path
            .resolve(value)
            .replaceAll(/[\\/]+$/gu, '')
            .toLowerCase(),
        path.normalize('F:/Temp').toLowerCase()
    );
}
assert.ok(process.env.TEMP, 'TEMP must be set');
const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-tools-')));
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain all synthetic fixtures; never recursively delete them.
const sentinel = 'synthetic-private-fragment-not-for-disclosure';

function fixture(raw) {
    const root = fs.mkdtempSync(path.join(runRoot, 'project-'));
    fs.writeFileSync(
        path.join(root, '.mcdevrc.json'),
        raw ?? JSON.stringify({ credentials: { example: { businessUnits: { sample: '123' } } } })
    );
    return root;
}

function artifact(root, type, key, extension) {
    const directory = path.join(root, 'retrieve', 'example', 'sample', type);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${key}.${type}-meta.json`), JSON.stringify({ key }));
    fs.writeFileSync(path.join(directory, `${key}.${type}-meta.${extension}`), sentinel);
    return directory;
}

test(
    'artifact tools expose bounded qualified read-only protocol operations',
    { timeout: 30_000 },
    async (t) => {
        const root = fixture();
        artifact(root, 'query', 'query-key', 'sql');
        artifact(root, 'script', 'script-key', 'ssjs');
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: runRoot,
            stderr: 'pipe',
        });
        const client = new Client({ name: 'synthetic-artifact-test', version: '1.0.0' });
        try {
            await client.connect(transport);
            const invoke = async (name, args) => {
                const response = await client.callTool({ name, arguments: args });
                assert.ok(!JSON.stringify(response).includes(sentinel));
                assert.ok(!JSON.stringify(response).includes('SyntaxError'));
                return response;
            };
            const resolve = async (overrides = {}) => {
                const response = await invoke('resolve_mcdev_project_artifact', {
                    workspaceRoot: root,
                    rootKind: 'retrieve',
                    credential: 'example',
                    businessUnit: 'sample',
                    metadataType: 'query',
                    externalKey: 'query-key',
                    ...overrides,
                });
                assert.ok(!response.isError);
                return JSON.parse(response.content[0].text);
            };
            await t.test(
                'lists tools with explicit selectors and module traversal ceilings',
                async () => {
                    const { tools } = await client.listTools();
                    for (const name of [
                        'inventory_mcdev_project_artifacts',
                        'resolve_mcdev_project_artifact',
                    ]) {
                        const tool = tools.find((entry) => entry.name === name);
                        assert.ok(tool, name);
                        assert.equal(tool.inputSchema.properties.maxEntries.maximum, 10000);
                        assert.equal(tool.inputSchema.properties.maxEntries.minimum, 1);
                        assert.equal(tool.inputSchema.properties.maxDepth.maximum, 12);
                        assert.equal(tool.inputSchema.properties.maxDepth.minimum, 1);
                        assert.match(
                            tool.description,
                            /No guarantee of remote freshness or an atomic filesystem sandbox/u
                        );
                    }
                    const resolver = tools.find(
                        (entry) => entry.name === 'resolve_mcdev_project_artifact'
                    );
                    assert.deepEqual(resolver.inputSchema.properties.rootKind.enum, [
                        'retrieve',
                        'deploy',
                    ]);
                    assert.deepEqual(
                        resolver.inputSchema.required.toSorted(),
                        [
                            'workspaceRoot',
                            'rootKind',
                            'credential',
                            'businessUnit',
                            'metadataType',
                            'externalKey',
                        ].toSorted()
                    );
                }
            );
            await t.test(
                'inventory returns metadata only and resolution returns qualified paths',
                async () => {
                    const response = await invoke('inventory_mcdev_project_artifacts', {
                        workspaceRoot: root,
                    });
                    assert.ok(!response.isError);
                    const inventory = JSON.parse(response.content[0].text);
                    assert.equal(inventory.complete, true);
                    assert.equal(inventory.artifacts.length, 4);
                    for (const [metadataType, externalKey, language] of [
                        ['query', 'query-key', 'sql'],
                        ['script', 'script-key', 'ssjs'],
                    ]) {
                        const result = await resolve({ metadataType, externalKey });
                        assert.equal(result.status, 'resolved');
                        assert.equal(result.metadataPaths.length, 1);
                        assert.equal(result.editableCompanions.length, 1);
                        assert.equal(result.editableCompanions[0].language, language);
                        assert.equal(result.dependencyResolution, 'not-evaluated');
                        assert.deepEqual(result.locallyConfirmedDependencies, []);
                    }
                }
            );
            await t.test(
                'missing, unsupported and incomplete results never offer editable paths',
                async () => {
                    for (const [overrides, status] of [
                        [{ externalKey: 'absent' }, 'missing'],
                        [{ rootKind: 'deploy' }, 'missing'],
                        [{ businessUnit: 'other' }, 'missing'],
                        [{ metadataType: 'asset' }, 'unsupported'],
                        [{ externalKey: '../escape' }, 'unsupported'],
                        [{ maxEntries: 1 }, 'blocked'],
                    ]) {
                        const result = await resolve(overrides);
                        assert.equal(result.status, status);
                        assert.deepEqual(result.editableCompanions, []);
                    }
                }
            );
            await t.test('ambiguous companions and malformed metadata fail closed', async () => {
                const ambiguous = fixture();
                const directory = artifact(ambiguous, 'script', 'duplicate', 'ssjs');
                fs.writeFileSync(path.join(directory, 'duplicate.script-meta.html'), sentinel);
                const result = await resolve({
                    workspaceRoot: ambiguous,
                    metadataType: 'script',
                    externalKey: 'duplicate',
                });
                assert.equal(result.status, 'ambiguous');
                assert.deepEqual(result.editableCompanions, []);
                fs.writeFileSync(
                    path.join(directory, 'duplicate.script-meta.json'),
                    `{"${sentinel}":`
                );
                const blocked = await resolve({
                    workspaceRoot: ambiguous,
                    metadataType: 'script',
                    externalKey: 'duplicate',
                });
                assert.equal(blocked.status, 'blocked');
                assert.deepEqual(blocked.editableCompanions, []);
            });
            await t.test(
                'configuration and schema failures expose no file contents or exceptions',
                async () => {
                    const malformed = fixture(`{"${sentinel}":`);
                    for (const name of [
                        'inventory_mcdev_project_artifacts',
                        'resolve_mcdev_project_artifact',
                    ]) {
                        const response = await invoke(name, {
                            workspaceRoot: malformed,
                            rootKind: 'retrieve',
                            credential: 'example',
                            businessUnit: 'sample',
                            metadataType: 'query',
                            externalKey: 'query-key',
                        });
                        assert.equal(response.isError, true);
                        assert.match(
                            response.content[0].text,
                            /^Project artifact (?:inventory|resolution) unavailable\.$/u
                        );
                        for (const limits of [
                            { maxEntries: 10001 },
                            { maxDepth: 13 },
                            { maxDepth: 0 },
                        ]) {
                            const invalid = await invoke(name, {
                                workspaceRoot: root,
                                rootKind: 'retrieve',
                                credential: 'example',
                                businessUnit: 'sample',
                                metadataType: 'query',
                                externalKey: 'query-key',
                                ...limits,
                            });
                            assert.equal(invalid.isError, true);
                        }
                    }
                }
            );
        } finally {
            await client.close();
        }
    }
);
