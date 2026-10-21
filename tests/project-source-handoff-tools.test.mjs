import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-handoff-')));
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain owned synthetic fixtures; no recursive cleanup.
const privateMarker = 'synthetic-private-content-never-return';
const name = 'read_mcdev_artifact_source';
const selector = {
    rootKind: 'retrieve',
    credential: 'example',
    businessUnit: 'sample',
    metadataType: 'script',
    externalKey: 'same-key',
};

function fixture(config) {
    const root = fs.mkdtempSync(path.join(runRoot, 'project-'));
    fs.writeFileSync(
        path.join(root, '.mcdevrc.json'),
        config ??
            JSON.stringify({
                credentials: { example: { businessUnits: { sample: '123', other: '456' } } },
            })
    );
    return root;
}

function artifact(root, identity, extension, text) {
    const directory = path.join(
        root,
        identity.rootKind,
        identity.credential,
        identity.businessUnit,
        identity.metadataType
    );
    fs.mkdirSync(directory, { recursive: true });
    const stem = path.join(directory, `${identity.externalKey}.${identity.metadataType}-meta`);
    fs.writeFileSync(`${stem}.json`, JSON.stringify({ key: identity.externalKey }));
    fs.writeFileSync(`${stem}.${extension}`, text);
    return stem;
}

test(
    'source handoff tool preserves qualified full text and fails closed',
    { timeout: 30_000 },
    async (t) => {
        const root = fixture();
        const text = '\uFEFF// café 漢字 😀\r\n' + '/* original spacing */\n'.repeat(800);
        const stem = artifact(root, selector, 'ssjs', text);
        artifact(root, { ...selector, businessUnit: 'other' }, 'ssjs', 'other BU');
        artifact(
            root,
            { ...selector, rootKind: 'deploy' },
            'html',
            '<script runat="server">/* deploy */</script>'
        );
        artifact(root, { ...selector, metadataType: 'query' }, 'sql', 'SELECT 1 AS sample');
        const client = new Client({ name: 'synthetic-source-handoff-test', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: runRoot,
            stderr: 'pipe',
        });
        try {
            await client.connect(transport);
            const invoke = async (overrides = {}) => {
                const response = await client.callTool({
                    name,
                    arguments: { workspaceRoot: root, ...selector, ...overrides },
                });
                assert.doesNotMatch(
                    JSON.stringify(response),
                    new RegExp(`${privateMarker}|SyntaxError|ENOENT|node:fs|"stack"`, 'u')
                );
                return response;
            };
            const read = async (overrides = {}) => {
                const response = await invoke(overrides);
                assert.ok(!response.isError);
                return JSON.parse(response.content[0].text);
            };
            await t.test('exact selector-only schema and bounded traversal limits', async () => {
                const { tools } = await client.listTools();
                const tool = tools.find((entry) => entry.name === name);
                assert.ok(tool);
                assert.deepEqual(
                    Object.keys(tool.inputSchema.properties).toSorted(),
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
                assert.deepEqual(
                    tool.inputSchema.required.toSorted(),
                    [
                        'workspaceRoot',
                        'rootKind',
                        'credential',
                        'businessUnit',
                        'metadataType',
                        'externalKey',
                    ].toSorted()
                );
                assert.deepEqual(tool.inputSchema.properties.rootKind.enum, ['retrieve', 'deploy']);
                for (const field of [
                    'workspaceRoot',
                    'credential',
                    'businessUnit',
                    'metadataType',
                    'externalKey',
                ])
                    assert.equal(tool.inputSchema.properties[field].type, 'string');
                for (const [field, maximum] of [
                    ['maxEntries', 10000],
                    ['maxDepth', 12],
                ]) {
                    assert.equal(tool.inputSchema.properties[field].type, 'integer');
                    assert.equal(tool.inputSchema.properties[field].minimum, 1);
                    assert.equal(tool.inputSchema.properties[field].maximum, maximum);
                }
                for (const phrase of [
                    'full-text',
                    'without truncation',
                    'platform detection',
                    'lookup',
                    'validate_ssjs',
                    'validate_sfmc_html',
                    'SQL validation is not established',
                    'concurrent filesystem mutation',
                    'Do not claim companion tools were performed',
                ])
                    assert.ok(tool.description.includes(phrase), phrase);
                for (const limits of [
                    { maxEntries: 0 },
                    { maxEntries: 10001 },
                    { maxDepth: 13 },
                    { maxDepth: 1.5 },
                    { rootKind: 'template' },
                ])
                    assert.equal((await invoke(limits)).isError, true);
            });
            await t.test(
                'Unicode BOM, long original text and original-byte hash survive SDK transport',
                async () => {
                    const result = await read();
                    assert.equal(result.status, 'resolved');
                    assert.deepEqual(result.source.identity, selector);
                    assert.equal(result.source.projectRoot, root);
                    assert.equal(result.source.sourcePath, `${stem}.ssjs`);
                    assert.equal(result.source.rootKind, 'retrieve');
                    assert.equal(result.source.role, 'editable-source');
                    assert.equal(result.source.language, 'ssjs');
                    assert.equal(result.source.text, text);
                    assert.equal(result.source.text.codePointAt(0), 65279);
                    assert.equal(
                        result.source.hash,
                        createHash('sha256').update(Buffer.from(text)).digest('hex')
                    );
                    assert.equal(result.source.hashAlgorithm, 'sha256');
                    assert.equal(result.source.hashBasis, 'original-file-bytes');
                    assert.equal(result.source.rendering, 'not-performed');
                    assert.deepEqual(result.source.validation, {
                        status: 'not-performed',
                        requiredCapability: 'validate_ssjs',
                    });
                    assert.equal(result.source.executionReadiness, 'unknown');
                    assert.match(result.source.limitations.join(' '), /not atomic|not an atomic/u);
                    assert.match(
                        result.source.limitations.join(' '),
                        /callers must prevent concurrent filesystem mutation/u
                    );
                }
            );
            await t.test(
                'qualified BU/root selection and HTML/SQL capabilities remain explicit',
                async () => {
                    assert.equal((await read({ businessUnit: 'other' })).source.text, 'other BU');
                    const html = await read({ rootKind: 'deploy' });
                    assert.equal(html.source.language, 'html');
                    assert.equal(html.source.identity.rootKind, 'deploy');
                    assert.equal(html.source.validation.requiredCapability, 'validate_sfmc_html');
                    const sql = await read({ metadataType: 'query' });
                    assert.equal(sql.source.language, 'sql');
                    assert.deepEqual(sql.source.validation, {
                        status: 'not-performed',
                        requiredCapability: 'sql-validator-not-established',
                    });
                    assert.equal(sql.source.executionReadiness, 'unknown');
                }
            );
            await t.test(
                'unresolved, unsupported and private selectors never return source',
                async () => {
                    for (const [overrides, status] of [
                        [{ externalKey: 'missing' }, 'missing'],
                        [{ metadataType: 'asset' }, 'unsupported'],
                        [{ externalKey: '../escape' }, 'unsupported'],
                        [{ externalKey: '.mcdev-auth.json' }, 'unsupported'],
                        [{ businessUnit: 'logs' }, 'unsupported'],
                        [{ maxEntries: 1 }, 'blocked'],
                        [{ maxDepth: 1 }, 'blocked'],
                    ]) {
                        const result = await read(overrides);
                        assert.equal(result.status, status);
                        assert.equal(Object.hasOwn(result, 'source'), false);
                    }
                }
            );
            await t.test('ambiguous and blocked content never leaks partial source', async () => {
                const ambiguous = fixture();
                const duplicate = artifact(ambiguous, selector, 'ssjs', privateMarker);
                fs.writeFileSync(`${duplicate}.html`, privateMarker);
                assert.equal((await read({ workspaceRoot: ambiguous })).status, 'ambiguous');
                assert.equal(
                    Object.hasOwn(await read({ workspaceRoot: ambiguous }), 'source'),
                    false
                );
                fs.writeFileSync(`${duplicate}.json`, `{"${privateMarker}":`);
                const malformed = await read({ workspaceRoot: ambiguous });
                assert.equal(malformed.status, 'blocked');
                assert.equal(Object.hasOwn(malformed, 'source'), false);
                const invalidUtf8 = fixture();
                artifact(invalidUtf8, selector, 'ssjs', Buffer.from([255, 254]));
                const invalid = await read({ workspaceRoot: invalidUtf8 });
                assert.equal(invalid.status, 'blocked');
                assert.equal(Object.hasOwn(invalid, 'source'), false);
            });
            await t.test(
                'private configured paths block and exceptional config failures stay fixed',
                async () => {
                    for (const directory of ['logs', '.git', '.mcdev-auth.json']) {
                        const configured = fixture(
                            JSON.stringify({
                                credentials: { example: { businessUnits: { sample: '123' } } },
                                directories: { retrieve: directory },
                            })
                        );
                        const result = await read({ workspaceRoot: configured });
                        assert.equal(result.status, 'blocked');
                        assert.equal(Object.hasOwn(result, 'source'), false);
                    }
                    for (const workspaceRoot of [
                        fixture(`{"${privateMarker}":`),
                        'private-relative-project',
                        path.join(root, '.mcdev-auth.json'),
                    ]) {
                        const response = await invoke({ workspaceRoot });
                        assert.equal(response.isError, true);
                        assert.equal(
                            response.content[0].text,
                            'Project artifact source unavailable.'
                        );
                        assert.equal(response.content.length, 1);
                    }
                }
            );
        } finally {
            await client.close();
        }
    }
);
