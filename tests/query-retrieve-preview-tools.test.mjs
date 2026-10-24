import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareQueryRetrievePreview } from '../dist/query-retrieve-preview.js';
import { prepareQueryRetrieve } from '../dist/query-retrieve-integration.js';

validateTempEnvironment();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-public-query-')));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
// Retain owned synthetic fixture. No recursive cleanup, auth/session fixture or live execution.
const sentinel = 'SENSITIVE_SYNTHETIC_PREPARATION_SENTINEL';
const config = {
    version: '10.1.0',
    credentials: {
        first: { eid: '1000', businessUnits: { QA: '1001' } },
        second: { eid: '2000', businessUnits: { QA: '2001' } },
    },
    directories: { retrieve: 'custom/retrieved/' },
    metaDataTypes: { documentOnRetrieve: [] },
    custom: sentinel,
};
fs.writeFileSync(path.join(root, '.mcdevrc.json'), JSON.stringify(config));
fs.writeFileSync(path.join(root, '.gitignore'), '.mcdev-auth.json\n');
for (const args of [
    ['init', '--quiet'],
    ['config', '--local', 'user.name', 'Jörn Berkefeld'],
    ['config', '--local', 'user.email', 'joern.berkefeld@gmail.com'],
]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr);
}
const selection = {
    workspaceRoot: root,
    credential: 'first',
    businessUnit: 'QA',
    key: 'Example_1',
};
const failure = 'Query retrieve preparation unavailable.';

function checkPublic(result) {
    assert.equal(result.executionEnabled, false);
    assert.equal(result.remoteCompletenessVerified, false);
    assert.equal(result.executionReadiness, 'not-established');
    assert.deepEqual(Object.keys(result), [
        'projectRoot',
        'credential',
        'businessUnit',
        'eid',
        'mid',
        'key',
        'reviewedMcdevVersion',
        'snapshot',
        'destinations',
        'effects',
        'limitations',
        'executionEnabled',
        'remoteCompletenessVerified',
        'executionReadiness',
    ]);
    assert.doesNotMatch(
        JSON.stringify(result),
        /task-specific|user exception|SENSITIVE_SYNTHETIC/u
    );
    assert.match(result.effects.join(' '), /parent EID.*child MIDs/u);
    assert.match(result.effects.join(' '), /delete both.*SOAP key-not-found/u);
    assert.match(result.effects.join(' '), /no operation or deletion authorization/u);
    assert.match(result.effects.join(' '), /authentication\/session storage/u);
    assert.match(result.limitations.join(' '), /mutation exclusion/u);
}

function frozen(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
}

test('public projection is immutable bounded local evidence, never internal effect forwarding', () => {
    const internal = prepareQueryRetrieve({ ...selection, projectRoot: root });
    const result = prepareQueryRetrievePreview(selection);
    checkPublic(result);
    frozen(result);
    assert.equal(result.snapshot, internal.snapshot);
    assert.equal(result.reviewedMcdevVersion, '10.1.0');
    assert.equal(result.destinations.json.path, internal.destinations.json);
    assert.equal(result.destinations.sql.path, internal.destinations.sql);
    assert.equal(result.destinations.json.existedBefore, false);
    assert.equal(result.destinations.sql.existedBefore, false);
    fs.mkdirSync(path.dirname(internal.destinations.json), { recursive: true });
    fs.writeFileSync(internal.destinations.json, '{"key":"Example_1"}');
    const existing = prepareQueryRetrievePreview(selection);
    assert.equal(existing.destinations.json.existedBefore, true);
    assert.equal(existing.destinations.sql.existedBefore, false);
    assert.equal(prepareQueryRetrievePreview({ ...selection, credential: 'second' }).mid, '2001');
    assert.throws(() => prepareQueryRetrievePreview({ ...selection, key: '*' }), {
        message: failure,
    });
});

test(
    'actual production stdio strict schema safely rejects malformed values and private property names',
    { timeout: 30_000 },
    async () => {
        const client = new Client({ name: 'public-query-preparation-test', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: root,
            stderr: 'pipe',
        });
        const before = fs.readdirSync(root);
        try {
            await client.connect(transport);
            const { tools } = await client.listTools();
            const tool = tools.find((entry) => entry.name === 'prepare_mcdev_query_retrieve');
            assert.ok(tool);
            assert.match(tool.description, /No native mcdev launch/u);
            assert.match(tool.description, /fixed read-only Git metadata subprocesses/u);
            assert.doesNotMatch(tool.description, /No subprocess/u);
            assert.deepEqual(tool.inputSchema.required, [
                'workspaceRoot',
                'credential',
                'businessUnit',
                'key',
            ]);
            assert.deepEqual(Object.keys(tool.inputSchema.properties), tool.inputSchema.required);
            assert.equal(tool.inputSchema.additionalProperties, false);
            for (const property of Object.values(tool.inputSchema.properties))
                assert.equal(property.type, 'string');
            assert.ok(tools.some((entry) => entry.name === 'preview_mcdev_project_command'));
            assert.ok(!tools.some((entry) => entry.name === 'accept_fixed_query_retrieve'));
            const invoke = (args) => client.callTool({ name: tool.name, arguments: args });
            const response = await invoke(selection);
            assert.notEqual(response.isError, true);
            const result = JSON.parse(response.content[0].text);
            checkPublic(result);
            assert.deepEqual(result, prepareQueryRetrievePreview(selection));
            for (const args of [
                { ...selection, [sentinel]: sentinel },
                { ...selection, key: { [sentinel]: sentinel } },
                { ...selection, credential: [sentinel] },
                { ...selection, businessUnit: null },
                { ...selection, workspaceRoot: 5 },
                { ...selection, key: '*' },
                { ...selection, credential: sentinel },
                { ...selection, businessUnit: sentinel },
                { ...selection, key: 'one,two' },
                { ...selection, workspaceRoot: 'relative-private-root' },
                {},
            ]) {
                const rejected = await invoke(args);
                assert.equal(rejected.isError, true);
                assert.match(rejected.content[0].text, /Query retrieve preparation unavailable\./u);
                assert.doesNotMatch(
                    JSON.stringify(rejected),
                    /SENSITIVE_SYNTHETIC|relative-private-root|ENOENT|ZodError/u
                );
            }
            assert.deepEqual(fs.readdirSync(root), before);
        } finally {
            await client.close();
        }
    }
);
