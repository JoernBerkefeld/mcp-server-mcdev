import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runQueryRetrieveProcess } from '../dist/query-retrieve-process.js';
import * as projectGuard from '../dist/project-operation-guard.js';
import {
    prepareQueryRetrieve,
    prepareScriptRetrieve,
    recheckPreparedScriptRetrieve,
    recheckPreparedQueryRetrieve,
    QueryRetrievePreparationError,
    createQueryRetrieveCoordinator,
} from '../dist/query-retrieve-integration.js';

validateTempEnvironment();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-preparation-')));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
// Retain owned synthetic fixtures; no recursive cleanup or real mcdev execution.
const config = () => ({
    version: '10.1.0',
    credentials: {
        demo: { eid: '1000', businessUnits: { QA: '1001' } },
        another: { eid: '2000', businessUnits: { QA: '2001' } },
    },
    directories: { retrieve: 'custom/retrieved/' },
    options: { validation: { retrieve: { noGuidKeys: 'warn' } }, formatOnSave: true },
    metaDataTypes: { documentOnRetrieve: ['dataExtension'] },
});
function fixture(change = () => {}) {
    const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'project-')));
    const value = config();
    change(value);
    fs.writeFileSync(path.join(projectRoot, '.mcdevrc.json'), JSON.stringify(value));
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.mcdev-auth.json\n');
    const git = spawnSync('git', ['init', '--quiet'], {
        cwd: projectRoot,
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(git.status, 0);
    return { projectRoot, credential: 'demo', businessUnit: 'QA', key: 'Example_1' };
}
function rejects(input) {
    assert.throws(
        () => prepareQueryRetrieve(input),
        (error) =>
            error instanceof QueryRetrievePreparationError &&
            error.message === 'Query retrieve preparation unavailable.'
    );
}
function frozen(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
}

test('immutable exact config/EID/MID/key/runtime/argv and configured absent pair evidence', async () => {
    const input = fixture();
    const prepared = prepareQueryRetrieve(input);
    frozen(prepared);
    assert.equal(prepared.eid, '1000');
    assert.equal(prepared.mid, '1001');
    assert.equal(prepared.executionEnabled, false);
    assert.notEqual(prepared.configSnapshot, prepared.snapshot);
    assert.deepEqual(prepared.argv, [
        'retrieve',
        'demo/QA',
        'query',
        'Example_1',
        '--no-purge',
        '--no-format',
        '--skipInteraction',
        '--noLogFile',
        '--noLogColors',
    ]);
    assert.equal(
        prepared.destinations.json,
        path.join(
            input.projectRoot,
            'custom',
            'retrieved',
            'demo',
            'QA',
            'query',
            'Example_1.query-meta.json'
        )
    );
    assert.deepEqual(
        prepared.before.map((file) => file.exists),
        [false, false]
    );
    assert.ok(prepared.runtime.files.every((file) => file.hash.length === 64));
    assert.equal(prepared.runtime.node, process.execPath);
    assert.deepEqual(await recheckPreparedQueryRetrieve(prepared), {
        snapshot: prepared.snapshot,
        ready: true,
    });
    assert.equal(prepareQueryRetrieve({ ...input, credential: 'another' }).mid, '2001');
    assert.match(prepared.effects.join(' '), /parent EID/);
    assert.match(prepared.effects.join(' '), /session storage.*privately/);
    assert.match(prepared.effects.join(' '), /delete both.*early SOAP/);
});

test('Script preparation binds three candidates, reviewed runtime and effects without Query assumptions', async () => {
    const input = fixture();
    const query = prepareQueryRetrieve(input);
    const script = prepareScriptRetrieve(input);
    frozen(script);
    assert.equal(script.metadataType, 'script');
    assert.notEqual(script.configSnapshot, query.configSnapshot);
    assert.notEqual(script.snapshot, query.snapshot);
    assert.deepEqual(Object.keys(script.destinations), ['json', 'ssjs', 'html']);
    for (const [extension, destination] of Object.entries(script.destinations)) {
        assert.equal(
            destination,
            path.join(
                input.projectRoot,
                'custom',
                'retrieved',
                'demo',
                'QA',
                'script',
                `Example_1.script-meta.${extension}`
            )
        );
    }
    assert.deepEqual(
        script.before.map((file) => file.exists),
        [false, false, false]
    );
    assert.deepEqual(
        script.argv,
        query.argv.map((value) => (value === 'query' ? 'script' : value))
    );
    const files = script.runtime.files.map((file) => file.path.replaceAll(path.sep, '/'));
    for (const file of ['Script.js', 'definitions/Script.definition.js', 'Folder.js'])
        assert.ok(files.some((candidate) => candidate.endsWith(`/metadataTypes/${file}`)));
    assert.ok(!files.some((file) => /\/(?:Query|DataExtension)(?:\.definition)?\.js$/u.test(file)));
    assert.match(script.effects.join(' '), /paginated REST collection/);
    assert.match(script.effects.join(' '), /delete JSON plus both SSJS and HTML/);
    assert.match(script.effects.join(' '), /other companion is not automatically removed/);
    assert.deepEqual(await recheckPreparedScriptRetrieve(script), {
        snapshot: script.snapshot,
        ready: true,
    });
    assert.deepEqual(prepareQueryRetrieve({ ...input, metadataType: 'query' }), query);
    assert.equal(Object.hasOwn(query, 'metadataType'), false);
    assert.equal((await recheckPreparedQueryRetrieve(script)).ready, false);
    assert.equal((await recheckPreparedScriptRetrieve(query)).ready, false);
    for (const metadataType of [null, 'asset', 'query,script', false]) {
        assert.throws(
            () => prepareScriptRetrieve({ ...input, metadataType }),
            QueryRetrievePreparationError
        );
        rejects({ ...input, metadataType });
    }
    rejects({ ...input, metadataType: 'script' });
    assert.throws(
        () => prepareScriptRetrieve({ ...input, metadataType: 'query' }),
        QueryRetrievePreparationError
    );
});

test('Script recheck detects each candidate and config/runtime/effects drift', async () => {
    for (const extension of ['json', 'ssjs', 'html']) {
        const input = fixture();
        const initial = prepareScriptRetrieve(input);
        fs.mkdirSync(path.dirname(initial.destinations.json), { recursive: true });
        fs.writeFileSync(initial.destinations[extension], 'synthetic');
        assert.equal((await recheckPreparedScriptRetrieve(initial)).ready, false);
        const prepared = prepareScriptRetrieve(input);
        assert.equal(prepared.before.filter((file) => file.exists).length, 1);
        fs.unlinkSync(prepared.destinations[extension]);
        assert.equal((await recheckPreparedScriptRetrieve(prepared)).ready, false);
    }
    const input = fixture();
    const prepared = prepareScriptRetrieve(input);
    for (const change of [
        { metadataType: 'query' },
        { argv: ['deploy'] },
        { effects: [] },
        { runtime: { ...prepared.runtime, files: prepared.runtime.files.slice(1) } },
        {
            destinations: {
                ...prepared.destinations,
                html: path.join(input.projectRoot, 'outside'),
            },
        },
    ])
        assert.equal(
            (await recheckPreparedScriptRetrieve({ ...prepared, ...change })).ready,
            false
        );
    fs.appendFileSync(path.join(input.projectRoot, '.mcdevrc.json'), '\n');
    assert.equal((await recheckPreparedScriptRetrieve(prepared)).ready, false);
});

test('Script runtime evidence rechecks actual file bytes and refuses newly present hooks', async () => {
    const input = fixture();
    const prepared = prepareScriptRetrieve(input);
    const originalRead = fs.readSync;
    const originalOpen = fs.openSync;
    let selectedFd;
    let changed = false;
    try {
        fs.openSync = (candidate, ...args) => {
            const fd = originalOpen(candidate, ...args);
            if (String(candidate).endsWith(`${path.sep}Script.js`)) selectedFd = fd;
            return fd;
        };
        fs.readSync = (fd, buffer, ...args) => {
            const count = originalRead(fd, buffer, ...args);
            if (fd === selectedFd && count > 0) {
                buffer[0] ^= 1;
                changed = true;
            }
            return count;
        };
        assert.equal((await recheckPreparedScriptRetrieve(prepared)).ready, false);
        assert.equal(changed, true);
    } finally {
        fs.readSync = originalRead;
        fs.openSync = originalOpen;
    }
    assert.equal((await recheckPreparedScriptRetrieve(prepared)).ready, true);
    fs.writeFileSync(path.join(input.projectRoot, '.mcdev-validations.js'), 'never import');
    assert.equal((await recheckPreparedScriptRetrieve(prepared)).ready, false);
});

test('Script rejects unsafe paths, candidate links/size/type and enabled Script documentation', () => {
    for (const extension of ['json', 'ssjs', 'html']) {
        for (const kind of ['directory', 'hardlink', 'oversize', 'junction']) {
            const input = fixture();
            const prepared = prepareScriptRetrieve(input);
            fs.mkdirSync(path.dirname(prepared.destinations.json), { recursive: true });
            const target = prepared.destinations[extension];
            if (kind === 'directory') fs.mkdirSync(target);
            if (kind === 'oversize') fs.writeFileSync(target, Buffer.alloc(1024 * 1024 + 1));
            if (kind === 'hardlink') {
                const plain = path.join(input.projectRoot, 'plain.txt');
                fs.writeFileSync(plain, 'synthetic');
                fs.linkSync(plain, target);
            }
            if (kind === 'junction')
                fs.symlinkSync(fs.mkdtempSync(path.join(root, 'target-')), target, 'junction');
            assert.throws(() => prepareScriptRetrieve(input), QueryRetrievePreparationError);
        }
    }
    for (const retrieve of ['../outside', 'F:/outside', 'a//b', 'nul/']) {
        assert.throws(
            () =>
                prepareScriptRetrieve(
                    fixture((value) => {
                        value.directories.retrieve = retrieve;
                    })
                ),
            QueryRetrievePreparationError
        );
    }
    assert.throws(
        () =>
            prepareScriptRetrieve(
                fixture((value) => {
                    value.metaDataTypes.documentOnRetrieve.push('script');
                })
            ),
        QueryRetrievePreparationError
    );
    assert.equal(
        prepareScriptRetrieve(
            fixture((value) => {
                value.metaDataTypes.documentOnRetrieve.push('query');
            })
        ).metadataType,
        'script'
    );
});

test('historical Query entrypoints cannot accept Script even with trusted ready seams', async () => {
    const prepared = prepareScriptRetrieve(fixture());
    let checks = 0;
    let launches = 0;
    const coordinator = createQueryRetrieveCoordinator({
        recheck: async () => {
            checks++;
            return { ready: true, snapshot: prepared.snapshot };
        },
        launch: async () => {
            launches++;
            throw new Error('must not launch');
        },
    });
    assert.equal(
        (await coordinator.runQueryRetrieve(prepared, { signal: new AbortController().signal }))
            .outcome,
        'blocked'
    );
    assert.equal(
        (await coordinator.runConfirmedQueryRetrieve(prepared, context())).outcome,
        'blocked'
    );
    assert.equal(checks, 0);
    assert.equal(launches, 0);
});

test('existing JSON/SQL pair captures bounded bytes and detects content/deletion/replacement drift', async () => {
    const input = fixture();
    const initial = prepareQueryRetrieve(input);
    fs.mkdirSync(path.dirname(initial.destinations.json), { recursive: true });
    fs.writeFileSync(initial.destinations.json, '{"key":"Example_1"}');
    fs.writeFileSync(initial.destinations.sql, 'SELECT 1');
    const prepared = prepareQueryRetrieve(input);
    assert.ok(prepared.before.every((file) => file.exists && file.hash.length === 64));
    assert.equal((await recheckPreparedQueryRetrieve(initial)).ready, false);
    fs.writeFileSync(prepared.destinations.sql, 'SELECT 2');
    assert.equal((await recheckPreparedQueryRetrieve(prepared)).ready, false);
    const changed = prepareQueryRetrieve(input);
    fs.unlinkSync(changed.destinations.sql);
    assert.equal((await recheckPreparedQueryRetrieve(changed)).ready, false);
});

test('config byte-text changes and forged descriptor fields fail recheck', async () => {
    const input = fixture();
    const prepared = prepareQueryRetrieve(input);
    for (const change of [
        { eid: '9' },
        { mid: '9' },
        { argv: ['deploy'] },
        { effects: [] },
        { executionEnabled: true },
        { runtime: { ...prepared.runtime, nodeIdentity: 'changed' } },
    ]) {
        assert.equal((await recheckPreparedQueryRetrieve({ ...prepared, ...change })).ready, false);
    }
    fs.appendFileSync(path.join(input.projectRoot, '.mcdevrc.json'), '\n');
    assert.equal((await recheckPreparedQueryRetrieve(prepared)).ready, false);
});

test('hook absence is mandatory without opening or executing hook contents', async () => {
    const input = fixture();
    const prepared = prepareQueryRetrieve(input);
    fs.writeFileSync(
        path.join(input.projectRoot, '.mcdev-validations.js'),
        'throw Error("never load me")'
    );
    rejects(input);
    assert.equal((await recheckPreparedQueryRetrieve(prepared)).ready, false);
});

test('Git protection must remain effective and auth index untracked', async () => {
    const input = fixture();
    const prepared = prepareQueryRetrieve(input);
    fs.writeFileSync(
        path.join(input.projectRoot, '.gitignore'),
        '.mcdev-auth.json\n!.mcdev-auth.json\n'
    );
    rejects(input);
    assert.equal((await recheckPreparedQueryRetrieve(prepared)).ready, false);
});

test('unsupported versions, EIDs, query docs and unsafe retrieve roots fail closed', () => {
    for (const change of [
        (value) => {
            value.version = '99.0.0';
        },
        (value) => {
            delete value.version;
        },
        (value) => {
            value.credentials.demo.eid = 0;
        },
        (value) => {
            value.metaDataTypes.documentOnRetrieve.push('query');
        },
        (value) => {
            value.metaDataTypes.documentOnRetrieve = null;
        },
    ])
        rejects(fixture(change));
    for (const retrieve of [
        '../outside',
        '/absolute',
        'F:/outside',
        '.',
        'a//b',
        'a/../b',
        String.raw`a\b`,
        'a%20b',
        'a./b',
        'nul/',
    ]) {
        rejects(
            fixture((value) => {
                value.directories.retrieve = retrieve;
            })
        );
    }
    const input = fixture();
    for (const key of ['../bad', '*', 'a,b', 'name.', 'NUL', 'con.any']) rejects({ ...input, key });
});

test('unsafe pair entries, hardlinks, oversized files and junction ancestors are rejected', () => {
    for (const kind of ['directory', 'hardlink', 'oversize', 'junction']) {
        const input = fixture();
        const prepared = prepareQueryRetrieve(input);
        const directory = path.dirname(prepared.destinations.json);
        fs.mkdirSync(directory, { recursive: true });
        switch (kind) {
            case 'directory': {
                fs.mkdirSync(prepared.destinations.sql);
                break;
            }
            case 'hardlink': {
                const target = path.join(input.projectRoot, 'plain.txt');
                fs.writeFileSync(target, 'invented');
                fs.linkSync(target, prepared.destinations.sql);
                break;
            }
            case 'oversize': {
                fs.writeFileSync(prepared.destinations.json, Buffer.alloc(1024 * 1024 + 1));
                break;
            }
            default: {
                const target = fs.mkdtempSync(path.join(root, 'target-'));
                fs.symlinkSync(target, prepared.destinations.sql, 'junction');
            }
        }
        rejects(input);
    }
});

const read = (file) =>
    fs.readFileSync(new URL(`../node_modules/mcdev/lib/${file}`, import.meta.url), 'utf8');
test('fixed preparation effects are anchored to installed native predicates without native imports', () => {
    assert.match(
        read('metadataTypes/DataExtension.js'),
        /if \(!retrieveDir && this\.buObject\.eid !== this\.buObject\.mid\)/u
    );
    assert.match(
        read('metadataTypes/DataExtension.js'),
        /return this\.retrieve\(null, \['ObjectID', 'CustomerKey', 'Name'\]\)/u
    );
    assert.match(
        read('metadataTypes/DataExtension.js'),
        /mid: this\.properties\.credentials\[this\.buObject\.credential\]\.eid/u
    );
    assert.ok(read('util/auth.js').includes('sessionStore.set(sessionKey, authObject)'));
    assert.ok(read('util/file.js').includes('Util.OPTIONS.format === undefined'));
    assert.ok(
        read('metadataTypes/MetadataType.js').includes(
            'if (!this.properties.options?.validation?.[method])'
        )
    );
    assert.ok(read('util/validations.js').includes("path.resolve(root, '.mcdev-validations.js')"));
    assert.ok(
        read('metadataTypes/MetadataType.js').includes(
            'this.properties.metaDataTypes.documentOnRetrieve.includes(this.definition.type)'
        )
    );
    assert.ok(
        read('Retriever.js').includes(
            'result = await MetadataTypeInfo[type].retrieveForCache(null, subTypeArr)'
        )
    );
});

test('inspection opens no auth/session/hook content and remains unregistered', () => {
    const input = fixture();
    const open = fs.openSync;
    fs.openSync = (candidate, ...args) => {
        assert.ok(
            !/auth\.json|session|validations\.js$/iu.test(String(candidate)) ||
                String(candidate).includes(`${path.sep}node_modules${path.sep}mcdev${path.sep}`)
        );
        return open(candidate, ...args);
    };
    try {
        prepareQueryRetrieve(input);
    } finally {
        fs.openSync = open;
    }
    const source = fs.readFileSync(
        new URL('../src/query-retrieve-integration.ts', import.meta.url),
        'utf8'
    );
    assert.ok(!source.includes("from 'mcdev'"));
    assert.ok(
        !fs
            .readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
            .includes('query-retrieve-integration')
    );
});

const accept = (request) => ({
    action: 'accept',
    content: {
        confirmed: true,
        correlation: request.params.requestedSchema.properties.correlation.default,
    },
});
function context(controller = new AbortController(), patch = {}) {
    return {
        signal: controller.signal,
        extra: { requestId: 0 },
        server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            elicitInput: async (params) => accept({ params }),
        },
        ...patch,
    };
}
function pair(prepared, key = prepared.key) {
    fs.mkdirSync(path.dirname(prepared.destinations.json), { recursive: true });
    fs.writeFileSync(prepared.destinations.json, JSON.stringify({ key, name: 'Synthetic query' }));
    fs.writeFileSync(prepared.destinations.sql, 'SELECT 1 AS example');
}
const exited = Object.freeze({
    outcome: 'exited',
    stopReason: null,
    started: true,
    directChildClosed: true,
    descendantsStopped: false,
    exitCode: 0,
    exitSignal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    retrievalVerified: false,
    partialEffectsPossible: true,
});

function scriptPair(prepared, extension = 'ssjs', metadata) {
    fs.mkdirSync(path.dirname(prepared.destinations.json), { recursive: true });
    fs.writeFileSync(prepared.destinations.json, JSON.stringify(metadata ?? { key: prepared.key }));
    fs.writeFileSync(
        prepared.destinations[extension],
        'synthetic source; not executed or validated'
    );
}

for (const kind of [
    'ssjs',
    'html',
    'dual',
    'stale-alternate',
    'unchanged-dual',
    'missing-json',
    'missing-source',
    'deleted',
    'absent',
    'malformed',
    'wrong-key',
    'inline-script',
    'unchanged',
    'json-unchanged',
    'empty',
    'nul',
    'invalid-utf8',
    'oversized',
    'post-parse-drift',
]) {
    test(`Script settlement ${kind} classifies only local metadata bytes`, async () => {
        const initial = prepareScriptRetrieve(fixture());
        if (['deleted', 'unchanged', 'json-unchanged'].includes(kind)) scriptPair(initial);
        if (kind === 'stale-alternate') scriptPair(initial, 'html');
        if (kind === 'unchanged-dual') {
            scriptPair(initial);
            fs.writeFileSync(initial.destinations.html, 'stale alternate');
        }
        const prepared = prepareScriptRetrieve(initial);
        const coordinator = createQueryRetrieveCoordinator({
            launch: async () => {
                if (kind === 'deleted') {
                    for (const file of Object.values(prepared.destinations))
                        if (fs.existsSync(file)) fs.unlinkSync(file);
                } else if (!['unchanged', 'unchanged-dual', 'absent'].includes(kind)) {
                    scriptPair(prepared, kind === 'html' ? 'html' : 'ssjs');
                    if (kind === 'dual') fs.writeFileSync(prepared.destinations.html, 'alternate');
                    if (kind === 'missing-json') fs.unlinkSync(prepared.destinations.json);
                    if (kind === 'missing-source') fs.unlinkSync(prepared.destinations.ssjs);
                    if (kind === 'malformed') fs.writeFileSync(prepared.destinations.json, '{');
                    if (kind === 'wrong-key') scriptPair(prepared, 'ssjs', { key: 'other' });
                    if (kind === 'inline-script')
                        scriptPair(prepared, 'ssjs', { key: prepared.key, script: '' });
                    if (kind === 'json-unchanged')
                        fs.appendFileSync(prepared.destinations.ssjs, 'changed');
                    if (kind === 'empty') fs.writeFileSync(prepared.destinations.ssjs, '  ');
                    if (kind === 'nul') fs.writeFileSync(prepared.destinations.ssjs, '\0');
                    if (kind === 'invalid-utf8')
                        fs.writeFileSync(prepared.destinations.ssjs, Buffer.from([255]));
                    if (kind === 'oversized')
                        fs.writeFileSync(prepared.destinations.ssjs, Buffer.alloc(1024 * 1024 + 1));
                }
                return exited;
            },
        });
        const parse = JSON.parse;
        if (kind === 'post-parse-drift') {
            JSON.parse = (...args) => {
                const result = parse(...args);
                if (result?.key === prepared.key) {
                    fs.writeFileSync(prepared.destinations.html, 'late alternate');
                }
                return result;
            };
        }
        let result;
        try {
            result = await coordinator.runScriptRetrieve(prepared, {
                signal: new AbortController().signal,
                get server() {
                    throw new Error('Script must not inspect forms');
                },
            });
        } finally {
            JSON.parse = parse;
        }
        const expected = ['ssjs', 'html'].includes(kind)
            ? 'local-materialization'
            : ['missing-json', 'missing-source'].includes(kind)
              ? 'partial'
              : ['unchanged', 'absent'].includes(kind)
                ? 'unchanged-unverified'
                : 'unverified';
        assert.equal(result.materialization, expected);
        assert.equal(result.remoteCompletenessVerified, false);
        assert.equal(result.outcome, 'exited');
        assert.equal(result.projectBlocked, false);
        assert.deepEqual(Object.keys(result), [
            'outcome',
            'process',
            'materialization',
            'projectBlocked',
            'remoteCompletenessVerified',
        ]);
    });
}

test('Script cancellation, final drift and cross-family replay never launch', async () => {
    for (const kind of ['pre-cancel', 'recheck-cancel', 'drift', 'snapshot', 'throw', 'query']) {
        const prepared = prepareScriptRetrieve(fixture());
        const controller = new AbortController();
        let checks = 0,
            launches = 0;
        if (kind === 'pre-cancel') controller.abort();
        const coordinator = createQueryRetrieveCoordinator({
            recheckScript: async () => {
                checks++;
                if (kind === 'throw') throw new Error('RAW_SECRET');
                if (kind === 'recheck-cancel') controller.abort();
                return {
                    ready: kind !== 'drift',
                    snapshot: kind === 'snapshot' ? '' : prepared.snapshot,
                };
            },
            launch: async () => {
                launches++;
                return exited;
            },
        });
        const result = await coordinator
            .runScriptRetrieve(
                kind === 'query'
                    ? prepareQueryRetrieve({ ...prepared, metadataType: 'query' })
                    : prepared,
                { signal: controller.signal }
            )
            .catch(() => null);
        assert.ok(result);
        assert.equal(
            result.outcome,
            kind.includes('cancel') ? 'cancel' : kind === 'throw' ? 'failed' : 'blocked'
        );
        assert.equal(launches, 0);
        assert.equal(checks, ['pre-cancel', 'query'].includes(kind) ? 0 : 1);
        assert.equal(result.projectBlocked, false);
        assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET/);
    }
});

for (const first of ['query', 'script']) {
    for (const phase of ['recheck', 'launch']) {
        test(`${first} ${phase} holds one Query/Script guard through cancellation`, async () => {
            const input = fixture();
            const query = prepareQueryRetrieve(input),
                script = prepareScriptRetrieve(input);
            const controller = new AbortController();
            let entered, release;
            const started = new Promise((resolve) => {
                entered = resolve;
            });
            const wait = async () => {
                entered();
                await new Promise((resolve) => {
                    release = resolve;
                });
            };
            const coordinator = createQueryRetrieveCoordinator({
                recheck: async () => {
                    if (phase === 'recheck') await wait();
                    return { ready: true, snapshot: query.snapshot };
                },
                recheckScript: async () => {
                    if (phase === 'recheck') await wait();
                    return { ready: true, snapshot: script.snapshot };
                },
                launch: async (_prepared, lifetime) => {
                    assert.equal(lifetime.signal, controller.signal);
                    assert.equal(lifetime.timeoutMs, 1234);
                    await wait();
                    return exited;
                },
            });
            const pending =
                first === 'query'
                    ? coordinator.runQueryRetrieve(query, {
                          signal: controller.signal,
                          processTimeoutMs: 1234,
                      })
                    : coordinator.runScriptRetrieve(script, {
                          signal: controller.signal,
                          processTimeoutMs: 1234,
                      });
            await started;
            controller.abort();
            const other = createQueryRetrieveCoordinator();
            assert.equal(
                (await other.runScriptRetrieve(script, context())).outcome,
                'project-busy'
            );
            assert.equal((await other.runQueryRetrieve(query, context())).outcome, 'project-busy');
            assert.equal(
                (await other.runConfirmedQueryRetrieve(query, context())).outcome,
                'project-busy'
            );
            assert.equal(other.acknowledgeExternalReconciliation(input.projectRoot), false);
            release();
            assert.equal((await pending).outcome, phase === 'recheck' ? 'cancel' : 'exited');
            assert.equal(
                (
                    await createQueryRetrieveCoordinator({
                        launch: async () => exited,
                    }).runScriptRetrieve(script, context())
                ).outcome,
                'exited'
            );
        });
    }
}

for (const first of ['query', 'script']) {
    for (const kind of ['unknown', 'throw']) {
        test(`${first} ${kind} latches both families until external reconciliation`, async () => {
            const input = fixture();
            const query = prepareQueryRetrieve(input),
                script = prepareScriptRetrieve(input);
            let launches = 0;
            const coordinator = createQueryRetrieveCoordinator({
                launch: async () => {
                    launches++;
                    if (kind === 'throw') throw new Error('RAW_SECRET');
                    return { ...exited, outcome: 'termination-unconfirmed' };
                },
            });
            const result =
                first === 'query'
                    ? await coordinator.runQueryRetrieve(query, context())
                    : await coordinator.runScriptRetrieve(script, context());
            assert.equal(result.projectBlocked, true);
            assert.equal(result.outcome, kind === 'throw' ? 'failed' : 'termination-unconfirmed');
            assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET/);
            const other = createQueryRetrieveCoordinator({ launch: async () => exited });
            assert.equal(
                (await other.runScriptRetrieve(script, context())).outcome,
                'project-busy'
            );
            assert.equal((await other.runQueryRetrieve(query, context())).outcome, 'project-busy');
            assert.equal(
                (await other.runConfirmedQueryRetrieve(query, context())).outcome,
                'project-busy'
            );
            assert.equal(launches, 1);
            assert.equal(other.acknowledgeExternalReconciliation(input.projectRoot), true);
            assert.equal((await other.runScriptRetrieve(script, context())).outcome, 'exited');
            assert.equal((await other.runQueryRetrieve(query, context())).outcome, 'exited');
        });
    }
}

test('shared guard ownership excludes every retrieval entrypoint without recheck or launch', async () => {
    const input = fixture();
    const query = prepareQueryRetrieve(input);
    const script = prepareScriptRetrieve(input);
    let checks = 0;
    let launches = 0;
    const recheck = async () => {
        checks++;
        return { ready: true, snapshot: query.snapshot };
    };
    const coordinator = createQueryRetrieveCoordinator({
        recheck,
        recheckScript: recheck,
        launch: async () => {
            launches++;
            return exited;
        },
    });
    const alias = input.projectRoot.toUpperCase();
    assert.equal(projectGuard.tryAcquire(alias), true);
    try {
        for (const blocked of [false, true]) {
            if (blocked) projectGuard.block(alias);
            for (const result of [
                await coordinator.runQueryRetrieve(query, context()),
                await coordinator.runScriptRetrieve(script, context()),
                await coordinator.runConfirmedQueryRetrieve(query, context()),
            ]) {
                assert.equal(result.outcome, 'project-busy');
                assert.equal(result.projectBlocked, blocked);
                assert.equal(result.process, null);
            }
            assert.equal(checks, 0);
            assert.equal(launches, 0);
            if (!blocked) assert.equal(coordinator.acknowledgeExternalReconciliation(alias), false);
        }
        projectGuard.release(alias);
        assert.equal(projectGuard.isBlocked(input.projectRoot), true);
        assert.equal(coordinator.acknowledgeExternalReconciliation(input.projectRoot), true);
        assert.equal((await coordinator.runQueryRetrieve(query, context())).outcome, 'exited');
        assert.equal(projectGuard.tryAcquire(alias), true);
    } finally {
        projectGuard.release(alias);
        projectGuard.acknowledgeExternalReconciliation(alias);
    }
});

for (const family of ['query', 'script']) {
    test(`${family} running and blocked state is visible to shared operation consumers`, async () => {
        const prepared =
            family === 'query' ? prepareQueryRetrieve(fixture()) : prepareScriptRetrieve(fixture());
        const alias = prepared.projectRoot.toUpperCase();
        let entered, finish;
        const started = new Promise((resolve) => {
            entered = resolve;
        });
        const coordinator = createQueryRetrieveCoordinator({
            launch: async () => {
                entered();
                return new Promise((resolve) => {
                    finish = resolve;
                });
            },
        });
        const pending =
            family === 'query'
                ? coordinator.runQueryRetrieve(prepared, context())
                : coordinator.runScriptRetrieve(prepared, context());
        await started;
        assert.equal(projectGuard.tryAcquire(alias), false);
        assert.equal(projectGuard.isBlocked(alias), false);
        assert.equal(projectGuard.acknowledgeExternalReconciliation(alias), false);
        finish({ ...exited, outcome: 'termination-unconfirmed' });
        assert.equal((await pending).projectBlocked, true);
        assert.equal(projectGuard.isBlocked(alias), true);
        projectGuard.release(alias);
        assert.equal(projectGuard.tryAcquire(alias), false);
        assert.equal(projectGuard.acknowledgeExternalReconciliation(alias), true);
        assert.equal(projectGuard.tryAcquire(alias), true);
        projectGuard.release(alias);
    });
}

test('direct runner needs no SDK capability or form and preserves process lifetime', async () => {
    const prepared = prepareQueryRetrieve(fixture());
    const controller = new AbortController();
    let launches = 0;
    const coordinator = createQueryRetrieveCoordinator({
        launch: async (input, lifetime, runtime) => {
            launches++;
            assert.equal(input, prepared);
            assert.equal(lifetime.signal, controller.signal);
            assert.equal(lifetime.timeoutMs, 1234);
            assert.equal(runtime.cliEntry, prepared.runtime.cliEntry);
            pair(prepared);
            return exited;
        },
    });
    const result = await coordinator.runQueryRetrieve(prepared, {
        signal: controller.signal,
        processTimeoutMs: 1234,
        get server() {
            throw new Error('Direct execution must not inspect SDK capabilities');
        },
    });
    assert.equal(launches, 1);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.materialization, 'local-materialization');
    assert.equal(result.projectBlocked, false);
    assert.equal(result.remoteCompletenessVerified, false);
});

test('direct cancellation and final evidence drift prevent launch and release exclusion', async () => {
    for (const kind of ['pre-cancel', 'recheck-cancel', 'drift', 'snapshot', 'throw']) {
        const prepared = prepareQueryRetrieve(fixture());
        const controller = new AbortController();
        let launches = 0;
        let checks = 0;
        if (kind === 'pre-cancel') controller.abort('RAW_SECRET');
        const coordinator = createQueryRetrieveCoordinator({
            recheck: async () => {
                checks++;
                if (kind === 'throw') throw new Error('RAW_SECRET');
                if (kind === 'recheck-cancel') controller.abort('RAW_SECRET');
                return {
                    ready: kind !== 'drift',
                    snapshot: kind === 'snapshot' ? 'changed' : prepared.snapshot,
                };
            },
            launch: async () => {
                launches++;
                return exited;
            },
        });
        const result = await coordinator.runQueryRetrieve(prepared, { signal: controller.signal });
        assert.equal(
            result.outcome,
            kind.includes('cancel') ? 'cancel' : kind === 'throw' ? 'failed' : 'blocked'
        );
        assert.equal(result.process, null);
        assert.equal(result.projectBlocked, false);
        assert.equal(launches, 0);
        assert.equal(checks, kind === 'pre-cancel' ? 0 : 1);
        assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET/);
        const next = createQueryRetrieveCoordinator({
            launch: async () => exited,
        });
        assert.equal(
            (await next.runQueryRetrieve(prepared, { signal: new AbortController().signal }))
                .outcome,
            'exited'
        );
    }
});

test('direct final recheck holds the shared project guard across coordinator instances', async () => {
    const prepared = prepareQueryRetrieve(fixture());
    let entered, release;
    const started = new Promise((resolve) => {
        entered = resolve;
    });
    const coordinator = createQueryRetrieveCoordinator({
        recheck: async () => {
            entered();
            await new Promise((resolve) => {
                release = resolve;
            });
            return { ready: true, snapshot: prepared.snapshot };
        },
        launch: async () => exited,
    });
    const pending = coordinator.runQueryRetrieve(prepared, {
        signal: new AbortController().signal,
    });
    await started;
    const other = createQueryRetrieveCoordinator();
    assert.equal(
        (await other.runConfirmedQueryRetrieve(prepared, context())).outcome,
        'project-busy'
    );
    release();
    assert.equal((await pending).outcome, 'exited');
});

for (const first of ['direct', 'confirmed']) {
    test(`${first} launch holds shared guard until cancelled supervision settles`, async () => {
        const prepared = prepareQueryRetrieve(fixture());
        const controller = new AbortController();
        let entered, finish;
        const started = new Promise((resolve) => {
            entered = resolve;
        });
        const coordinator = createQueryRetrieveCoordinator({
            launch: async (_input, lifetime) => {
                assert.equal(lifetime.signal, controller.signal);
                entered();
                return new Promise((resolve) => {
                    finish = resolve;
                });
            },
        });
        let settled = false;
        const pending = (
            first === 'direct'
                ? coordinator.runQueryRetrieve(prepared, { signal: controller.signal })
                : coordinator.runConfirmedQueryRetrieve(prepared, context(controller))
        ).then((result) => {
            settled = true;
            return result;
        });
        await started;
        controller.abort('RAW_SECRET');
        const other = createQueryRetrieveCoordinator();
        assert.equal(
            (await other.runQueryRetrieve(prepared, { signal: new AbortController().signal }))
                .outcome,
            'project-busy'
        );
        assert.equal(
            (await other.runConfirmedQueryRetrieve(prepared, context())).outcome,
            'project-busy'
        );
        assert.equal(settled, false);
        assert.equal(other.acknowledgeExternalReconciliation(prepared.projectRoot), false);
        finish(exited);
        assert.equal((await pending).projectBlocked, false);
        const next = createQueryRetrieveCoordinator({ launch: async () => exited });
        assert.equal(
            (await next.runQueryRetrieve(prepared, { signal: new AbortController().signal }))
                .outcome,
            'exited'
        );
    });
}

for (const kind of ['unknown', 'throw']) {
    test(`direct ${kind} launch remains blocked across entrypoints without retry`, async () => {
        const prepared = prepareQueryRetrieve(fixture());
        let launches = 0;
        const coordinator = createQueryRetrieveCoordinator({
            launch: async () => {
                launches++;
                if (kind === 'throw') throw new Error('RAW_SECRET');
                return { ...exited, outcome: 'termination-unconfirmed' };
            },
        });
        const result = await coordinator.runQueryRetrieve(prepared, {
            signal: new AbortController().signal,
        });
        assert.equal(result.projectBlocked, true);
        assert.equal(result.outcome, kind === 'throw' ? 'failed' : 'termination-unconfirmed');
        assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET/);
        const other = createQueryRetrieveCoordinator();
        assert.equal(
            (await other.runQueryRetrieve(prepared, { signal: new AbortController().signal }))
                .outcome,
            'project-busy'
        );
        assert.equal(
            (await other.runConfirmedQueryRetrieve(prepared, context())).outcome,
            'project-busy'
        );
        assert.equal(launches, 1);
        assert.equal(other.acknowledgeExternalReconciliation(prepared.projectRoot), true);
    });
}

test('SDK approval, real prepared evidence and bounded synthetic CLI end-to-end', async (t) => {
    const prepared = prepareQueryRetrieve(fixture());
    const runtime = fs.mkdtempSync(path.join(root, 'stub-runtime-'));
    fs.mkdirSync(path.join(runtime, 'lib'));
    fs.writeFileSync(
        path.join(runtime, 'package.json'),
        JSON.stringify({
            name: 'mcdev',
            version: '10.1.0',
            type: 'module',
            bin: { mcdev: 'lib/cli.js' },
        })
    );
    const cliEntry = path.join(runtime, 'lib', 'cli.js');
    fs.writeFileSync(
        cliEntry,
        `import fs from 'node:fs'; import path from 'node:path';
        const target = path.join('custom','retrieved','demo','QA','query');
        fs.mkdirSync(target,{recursive:true});
        fs.writeFileSync(path.join(target,process.argv[5]+'.query-meta.json'),JSON.stringify({key:process.argv[5]}));
        fs.writeFileSync(path.join(target,process.argv[5]+'.query-meta.sql'),'SELECT 1');
        process.stderr.write('RAW_SECRET'); process.exitCode=7;`
    );
    const coordinator = createQueryRetrieveCoordinator({
        launch: (input, lifetime, selected) => {
            assert.equal(selected.cliEntry, prepared.runtime.cliEntry);
            return runQueryRetrieveProcess(input, lifetime, { cliEntry });
        },
    });
    const server = new McpServer({ name: 'integration-only', version: '0' });
    const client = new Client(
        { name: 'test', version: '0' },
        { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, (request) => {
        assert.match(request.params.message, /parent EID/);
        return accept(request);
    });
    server.registerTool('synthetic', { inputSchema: {} }, async (_args, extra) => ({
        content: [
            {
                type: 'text',
                text: JSON.stringify(
                    await coordinator.runConfirmedQueryRetrieve(prepared, {
                        server: server.server,
                        extra,
                        signal: extra.signal,
                    })
                ),
            },
        ],
    }));
    t.after(async () => {
        await client.close();
        await server.close();
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const response = await client.callTool({ name: 'synthetic', arguments: {} });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.materialization, 'local-materialization');
    assert.equal(result.process.exitCode, 7);
    assert.equal(result.remoteCompletenessVerified, false);
    assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET/);
});

test('SDK request ID0 late acceptance cannot launch internal coordinator', async (t) => {
    const prepared = prepareQueryRetrieve(fixture());
    let release,
        entered,
        launches = 0;
    const enteredPromise = new Promise((resolve) => {
        entered = resolve;
    });
    const coordinator = createQueryRetrieveCoordinator({
        launch: async () => {
            launches++;
            return exited;
        },
    });
    const server = new McpServer({ name: 'late-integration', version: '0' });
    const client = new Client(
        { name: 'late-client', version: '0' },
        { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
        entered();
        await new Promise((resolve) => {
            release = resolve;
        });
        return accept(request);
    });
    const sent = [];
    const [a, b] = InMemoryTransport.createLinkedPair();
    const send = b.send.bind(b);
    b.send = (message, ...args) => {
        sent.push(message);
        return send(message, ...args);
    };
    server.registerTool('late', { inputSchema: {} }, async (_args, extra) => ({
        content: [
            {
                type: 'text',
                text: JSON.stringify(
                    await coordinator.runConfirmedQueryRetrieve(prepared, {
                        server: server.server,
                        extra,
                        signal: extra.signal,
                        confirmationTimeoutMs: 40,
                    })
                ),
            },
        ],
    }));
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(b);
    await client.connect(a);
    const pending = client.callTool({ name: 'late', arguments: {} });
    await enteredPromise;
    assert.equal(JSON.parse((await pending).content[0].text).outcome, 'timeout');
    assert.equal(sent.find((message) => message.method === 'elicitation/create').id, 0);
    release();
    await delay(15);
    assert.equal(launches, 0);
});

test('approval deadline cannot settle launched execution; cancellation forwards and guard remains latched', async () => {
    const prepared = prepareQueryRetrieve(fixture());
    const controller = new AbortController();
    let entered, finish;
    const started = new Promise((resolve) => {
        entered = resolve;
    });
    const coordinator = createQueryRetrieveCoordinator({
        // This test starts at launched supervision, not disk/Git preflight latency.
        recheck: async () => ({ snapshot: prepared.snapshot, ready: true }),
        launch: async (_input, lifetime) => {
            assert.equal(lifetime.signal, controller.signal);
            entered();
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    });
    let settled = false;
    const pending = coordinator
        .runConfirmedQueryRetrieve(prepared, context(controller, { confirmationTimeoutMs: 500 }))
        .then((value) => {
            settled = true;
            return value;
        });
    await started;
    await delay(550);
    assert.equal(settled, false);
    controller.abort('RAW_SECRET');
    assert.equal(
        (await coordinator.runConfirmedQueryRetrieve(prepared, context())).outcome,
        'project-busy'
    );
    assert.equal(coordinator.acknowledgeExternalReconciliation(prepared.projectRoot), false);
    finish({ ...exited, outcome: 'termination-unconfirmed', stopReason: 'cancelled' });
    const result = await pending;
    assert.equal(result.projectBlocked, true);
    assert.equal(
        (await coordinator.runConfirmedQueryRetrieve(prepared, context())).outcome,
        'project-busy'
    );
    assert.equal(coordinator.acknowledgeExternalReconciliation(prepared.projectRoot), true);
});

for (const [entry, kind] of ['direct', 'confirmed'].flatMap((entry) =>
    ['correct', 'wrong-key', 'partial', 'unchanged', 'inline-sql', 'oversized', 'secret'].map(
        (kind) => [entry, kind]
    )
)) {
    test(`${entry} artifact settlement ${kind} never asserts remote completeness`, async () => {
        const initial = prepareQueryRetrieve(fixture());
        if (kind === 'unchanged') pair(initial);
        const prepared = prepareQueryRetrieve(initial);
        const coordinator = createQueryRetrieveCoordinator({
            launch: async () => {
                if (kind === 'secret') throw new Error('RAW_SECRET');
                if (kind !== 'unchanged')
                    pair(prepared, kind === 'wrong-key' ? 'different' : prepared.key);
                if (kind === 'partial') fs.unlinkSync(prepared.destinations.sql);
                if (kind === 'inline-sql')
                    fs.writeFileSync(
                        prepared.destinations.json,
                        JSON.stringify({ key: prepared.key, queryText: 'SELECT 1' })
                    );
                if (kind === 'oversized')
                    fs.writeFileSync(prepared.destinations.sql, Buffer.alloc(1024 * 1024 + 1));
                return exited;
            },
        });
        const result =
            entry === 'direct'
                ? await coordinator.runQueryRetrieve(prepared, {
                      signal: new AbortController().signal,
                  })
                : await coordinator.runConfirmedQueryRetrieve(prepared, context());
        assert.equal(
            result.materialization,
            kind === 'correct'
                ? 'local-materialization'
                : kind === 'partial'
                  ? 'partial'
                  : kind === 'unchanged'
                    ? 'unchanged-unverified'
                    : 'unverified'
        );
        assert.equal(result.remoteCompletenessVerified, false);
        assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET/);
        if (kind === 'secret') assert.equal(result.projectBlocked, true);
    });
}

test('drift and newly present validation hook after acceptance prevent launch', async () => {
    for (const hook of [false, true]) {
        const prepared = prepareQueryRetrieve(fixture());
        let launches = 0;
        const coordinator = createQueryRetrieveCoordinator({
            launch: async () => {
                launches++;
                return exited;
            },
        });
        const c = context();
        c.server.elicitInput = async (params) => {
            if (hook)
                fs.writeFileSync(
                    path.join(prepared.projectRoot, '.mcdev-validations.js'),
                    'RAW_SECRET'
                );
            else fs.appendFileSync(path.join(prepared.projectRoot, '.mcdevrc.json'), '\n');
            return accept({ params });
        };
        assert.equal((await coordinator.runConfirmedQueryRetrieve(prepared, c)).outcome, 'blocked');
        assert.equal(launches, 0);
    }
});

test('late acceptance and cancellation during final recheck cannot launch', async () => {
    for (const final of [false, true]) {
        const prepared = prepareQueryRetrieve(fixture());
        const controller = new AbortController();
        let release,
            entered,
            checks = 0,
            launches = 0;
        const ready = new Promise((resolve) => {
            entered = resolve;
        });
        const coordinator = createQueryRetrieveCoordinator({
            recheck: async () => {
                if (final && ++checks === 2) {
                    entered();
                    await new Promise((resolve) => {
                        release = resolve;
                    });
                }
                return { snapshot: prepared.snapshot, ready: true };
            },
            launch: async () => {
                launches++;
                return exited;
            },
        });
        const c = context(controller, { confirmationTimeoutMs: 20 });
        if (!final)
            c.server.elicitInput = async (params) => {
                entered();
                await new Promise((resolve) => {
                    release = resolve;
                });
                return accept({ params });
            };
        const pending = coordinator.runConfirmedQueryRetrieve(prepared, c);
        await ready;
        if (!final) assert.equal((await pending).outcome, 'timeout');
        controller.abort();
        release();
        if (final) assert.equal((await pending).outcome, 'cancel');
        await delay(10);
        assert.equal(launches, 0);
    }
});
