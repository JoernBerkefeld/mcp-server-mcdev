import assert from 'node:assert/strict';
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
import {
    prepareQueryRetrieve,
    recheckPreparedQueryRetrieve,
    QueryRetrievePreparationError,
    createQueryRetrieveCoordinator,
} from '../dist/query-retrieve-integration.js';

assert.ok(process.env.TEMP);
for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) continue;
    assert.ok(path.isAbsolute(value));
    assert.equal(
        path
            .resolve(value)
            .replace(/[\\/]+$/u, '')
            .toLowerCase(),
        String.raw`f:\temp`
    );
}
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

for (const kind of [
    'correct',
    'wrong-key',
    'partial',
    'unchanged',
    'inline-sql',
    'oversized',
    'secret',
]) {
    test(`artifact settlement ${kind} never asserts remote completeness`, async () => {
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
        const result = await coordinator.runConfirmedQueryRetrieve(prepared, context());
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
