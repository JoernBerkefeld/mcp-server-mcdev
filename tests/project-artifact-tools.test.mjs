import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

validateTempEnvironment();
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
                    assert.match(
                        resolver.description,
                        /asset-email.*htmlemail\/templatebasedemail/u
                    );
                    assert.match(resolver.description, /customerKey.*HTML\/preheader\/text/u);
                    assert.match(resolver.description, /does not confirm dependencies/u);
                    assert.deepEqual(
                        Object.keys(resolver.inputSchema.properties).toSorted(),
                        [
                            'workspaceRoot',
                            'rootKind',
                            'credential',
                            'businessUnit',
                            'metadataType',
                            'externalKey',
                            'maxEntries',
                            'maxDepth',
                        ].toSorted()
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
            await t.test('email identities resolve only exact qualified extracts', async () => {
                const emailRoot = fixture();
                for (const [rootKind, subtype] of [
                    ['retrieve', 'htmlemail'],
                    ['deploy', 'templatebasedemail'],
                ]) {
                    const directory = path.join(
                        emailRoot,
                        rootKind,
                        'example',
                        'sample',
                        'asset',
                        'email'
                    );
                    const sources = path.join(directory, 'email-key');
                    fs.mkdirSync(sources, { recursive: true });
                    const metadataPath = path.join(directory, 'email-key.asset-email-meta.json');
                    fs.writeFileSync(
                        metadataPath,
                        JSON.stringify({
                            key: 'not-the-customer-key',
                            customerKey: 'email-key',
                            assetType: { name: subtype },
                            views: { html: {}, preheader: {}, text: {} },
                        })
                    );
                    const expected = [
                        ['html', 'html', 'html'],
                        ['preheader', 'amp', 'ampscript'],
                        ['text', 'amp', 'ampscript'],
                    ].map(([view, extension, language]) => {
                        const absolutePath = path.join(
                            sources,
                            `views.${view}.content.asset-email-meta.${extension}`
                        );
                        fs.writeFileSync(absolutePath, sentinel);
                        return { absolutePath, language, role: 'source' };
                    });
                    const identity = {
                        workspaceRoot: emailRoot,
                        rootKind,
                        metadataType: 'asset-email',
                        externalKey: 'email-key',
                    };
                    const result = await resolve(identity);
                    assert.equal(result.status, 'resolved');
                    assert.deepEqual(result.metadataPaths, [metadataPath]);
                    assert.deepEqual(result.editableCompanions, expected);
                    assert.equal(result.dependencyResolution, 'not-evaluated');
                    assert.deepEqual(result.locallyConfirmedDependencies, []);
                    assert.deepEqual(result.declaredDependencies, [
                        'folder-asset',
                        'folder-asset-shared',
                        'folder-cloudpages',
                    ]);
                    assert.equal(
                        (await resolve({ ...identity, businessUnit: 'other' })).status,
                        'missing'
                    );
                    assert.equal(
                        (await resolve({ ...identity, externalKey: 'not-the-customer-key' }))
                            .status,
                        'missing'
                    );
                    for (const metadata of [
                        {
                            customerKey: 'email-key',
                            assetType: { name: 'webpage' },
                            views: { html: {} },
                        },
                        {
                            customerKey: 'email-key',
                            assetType: { name: subtype },
                            views: { html: { slots: {} } },
                        },
                        {
                            customerKey: 'email-key',
                            assetType: { name: subtype },
                            views: { html: { content: sentinel }, preheader: {}, text: {} },
                        },
                    ]) {
                        fs.writeFileSync(metadataPath, JSON.stringify(metadata));
                        const unsupported = await resolve(identity);
                        assert.equal(unsupported.status, 'ambiguous');
                        assert.deepEqual(unsupported.editableCompanions, []);
                        assert.ok(unsupported.findings.length > 0);
                    }
                }
            });
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
