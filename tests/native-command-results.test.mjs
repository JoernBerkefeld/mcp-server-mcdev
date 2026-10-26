import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import Mcdev from 'mcdev';
import { ensureMcdevSilentJson } from '../dist/mcdev-safe.js';
import { createNativeCommandResults, nativeResultBlock } from '../dist/native-command-results.js';

ensureMcdevSilentJson();
const catalog = Mcdev.explainTypes();
const asset = {
    key: 'welcome-key',
    isShared: false,
    name: 'Welcome',
    path: 'retrieve/cred/BU/asset/welcome.html',
    folder: 'Content Builder',
    mid: 101,
    error: '',
};
const collect = (command, text, success = true) => {
    const collector = createNativeCommandResults(command);
    collector.write('stdout', text);
    return collector.finish(success);
};

test('complete actual canonical native catalog returns meaningful metadata capabilities', () => {
    const result = collect('explainTypes', JSON.stringify(catalog, null, 2));
    assert.equal(result.kind, 'type-catalog');
    assert.ok(result.types.some((type) => type.apiName === 'query' && type.supports.retrieve));
    assert.deepEqual(result.types, catalog);
    assert.equal(collect('explainTypes', JSON.stringify(catalog.slice(1))).kind, 'unavailable');
});

test('asset result survives UTF8 byte chunks and documented logger colors', () => {
    const collector = createNativeCommandResults('resolveId');
    const bytes = Buffer.from(
        `info: Starting\n\u001B[32m${JSON.stringify({ ...asset, name: 'Grüße' }, null, 2)}\u001B[0m\n`
    );
    for (const byte of bytes) collector.write('stdout', Buffer.from([byte]));
    const result = collector.finish(true);
    assert.equal(result.kind, 'resolved-asset');
    assert.equal(result.asset.key, 'welcome-key');
    assert.equal(result.asset.name, 'Grüße');
    assert.equal(result.suppressed, true);
    assert.equal(collector.finish(true), result);
    collector.write('stdout', 'ignored');
});

test('real native Asset.resolveId local success returns path without an error field', async (t) => {
    validateTempEnvironment();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-resolved-asset-'));
    fs.writeFileSync(path.join(root, '.owner'), randomUUID());
    // Retain this run-owned fixture; no recursive cleanup.
    const require = createRequire(import.meta.url);
    const { default: Asset } = await import(
        pathToFileURL(path.join(path.dirname(require.resolve('mcdev')), 'metadataTypes/Asset.js'))
            .href
    );
    const cwd = process.cwd();
    const saved = { client: Asset.client, buObject: Asset.buObject, properties: Asset.properties };
    t.after(() => {
        process.chdir(cwd);
        Object.assign(Asset, saved);
    });
    const local = path.join(root, 'retrieve', 'cred', 'BU', 'asset', 'block');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'welcome-key.asset-block-meta.html'), '<p>Welcome</p>');
    fs.writeFileSync(
        path.join(local, 'welcome-key.asset-block-meta.json'),
        JSON.stringify({ r__folder_Path: 'Content Builder' })
    );
    process.chdir(root);
    Asset.buObject = { credential: 'cred', businessUnit: 'BU', mid: 101 };
    Asset.properties = { credentials: { cred: { businessUnits: { BU: 101 } } } };
    const requests = [];
    Asset.client = {
        rest: {
            get: async (url) => {
                requests.push(url);
                return {
                    id: 123,
                    customerKey: 'welcome-key',
                    name: 'Welcome',
                    memberId: 101,
                    assetType: { name: 'htmlblock' },
                };
            },
        },
    };
    const output = [];
    t.mock.method(console, 'log', (text) => output.push(text));
    const native = await Asset.resolveId('123');
    assert.equal(requests.length, 1);
    assert.match(requests[0], /^asset\/v1\/content\/assets\/123\?/u);
    assert.equal(Object.hasOwn(native, 'error'), false);
    assert.match(native.path, /welcome-key\.asset-block-meta\.html$/u);
    const result = collect('resolveId', output.join('\n'));
    assert.equal(result.kind, 'resolved-asset');
    assert.deepEqual(result.asset, native);
    assert.equal(Object.hasOwn(result.asset, 'error'), false);
});

test('missing-file error remains a strict typed result', () => {
    const { path: ignored, ...missing } = asset;
    assert.ok(ignored);
    missing.error = 'file not found on local disk';
    assert.deepEqual(collect('resolveId', JSON.stringify(missing)).asset, missing);
    assert.equal(
        collect('resolveId', JSON.stringify({ ...missing, error: null })).kind,
        'unavailable'
    );
    assert.equal(
        collect('resolveId', JSON.stringify({ ...missing, error: 'id not found' })).kind,
        'unavailable'
    );
});

test('missing ID has native typed not-found result', () => {
    assert.deepEqual(collect('resolveId', '{"error":"id not found"}').asset, {
        error: 'id not found',
    });
});

test('arbitrary JSON, API bodies, debug payloads, secrets and controls never escape', () => {
    for (const text of [
        JSON.stringify({ ...asset, access_token: 'SECRET' }),
        JSON.stringify({ ...asset, key: 'Bearer SECRET' }),
        JSON.stringify({ ...asset, name: '<html>SECRET</html>' }),
        JSON.stringify({ ...asset, error: 'SECRET API FAILURE' }),
        JSON.stringify({ ...asset, response: { body: 'SECRET' } }),
        `debug: ${JSON.stringify(asset)}`,
        JSON.stringify({ ...asset, key: 'sec\u0000ret' }),
        `\u001B]0;SECRET\u0007${JSON.stringify(asset)}`,
        `${JSON.stringify(asset)}\n${JSON.stringify(asset)}`,
        '{"unexpected":"SECRET"}',
        '['.repeat(20) + '0' + ']'.repeat(20),
        `debug: API response\n${JSON.stringify(asset)}`,
        JSON.stringify({ ...asset, sharedWith: ['SECRET'] }),
    ]) {
        const result = collect('resolveId', text);
        assert.equal(result.kind, 'unavailable', text);
        assert.doesNotMatch(JSON.stringify(result), /SECRET/u);
    }
    const failed = collect('resolveId', JSON.stringify(asset), false);
    assert.equal(failed.kind, 'unavailable');
});

test('oversized chunks, split oversized output and incomplete documents are discarded', () => {
    for (const chunks of [
        ['x'.repeat(200_000)],
        ['x'.repeat(70_000), 'x'.repeat(70_000), JSON.stringify(asset)],
    ]) {
        const collector = createNativeCommandResults('resolveId');
        for (const chunk of chunks) collector.write('stdout', chunk);
        const result = collector.finish(true);
        assert.equal(result.kind, 'unavailable');
        assert.equal(result.truncated, true);
    }
    assert.equal(collect('resolveId', '{"key":').kind, 'unavailable');
});

test('stderr never supplies a result; side-effect commands do not collect output', () => {
    const collector = createNativeCommandResults('resolveId');
    collector.write('stderr', JSON.stringify(asset));
    assert.equal(collector.finish(true).kind, 'unavailable');
    assert.equal(collect('retrieve', JSON.stringify(asset)), undefined);
});

test('output forms without a reviewed native result fail actionably before launch', () => {
    for (const [command, args] of [
        ['getFilesToCommit', ['cred/BU', 'query', 'key']],
        ['resolveId', ['cred/BU', 'query', '123', '--json']],
        ['resolveId', ['cred/BU', 'asset', '123']],
        ['explainTypes', []],
        ['explainTypes', ['query', '--json']],
        ['explainTypes', ['--json', '--filter=query']],
    ])
        assert.match(nativeResultBlock(command, args), /No command was launched/iu);
    assert.equal(nativeResultBlock('explainTypes', ['--json']), undefined);
    assert.equal(nativeResultBlock('resolveId', ['--json', 'cred/BU', 'asset', '123']), undefined);
});
