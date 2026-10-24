import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { QUERY_RETRIEVE_CONTRACT } from '../dist/query-retrieve-contract.js';
import { test } from 'node:test';
import {
    collectQueryProjectSnapshot,
    recheckQueryProjectSnapshot,
    QueryProjectSnapshotError,
} from '../dist/query-retrieve-project-snapshot.js';
import { createQueryRetrieveConfirmation } from '../dist/query-retrieve-confirmation.js';

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
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-query-config-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain owned synthetic fixtures; no recursive deletion is performed.
const config = () => ({
    credentials: {
        demo: { businessUnits: { QA: '00123' } },
        other: { businessUnits: { QA: 456 } },
    },
    custom: { text: 'independently invented' },
});
function fixture(raw = JSON.stringify(config())) {
    const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'project-')));
    fs.writeFileSync(path.join(projectRoot, '.mcdevrc.json'), raw);
    return { projectRoot, credential: 'demo', businessUnit: 'QA', key: 'sample' };
}
function write(input, raw) {
    fs.writeFileSync(path.join(input.projectRoot, '.mcdevrc.json'), raw);
}
function rejects(input) {
    assert.throws(
        () => collectQueryProjectSnapshot(input),
        (error) =>
            error instanceof QueryProjectSnapshotError &&
            error.message === 'Query project configuration snapshot unavailable.'
    );
}

test('real config accessor derives exact qualified MID and immutable gate-compatible input', async () => {
    const input = fixture();
    const collected = collectQueryProjectSnapshot(input);
    assert.equal(collected.mid, '00123');
    assert.equal(collectQueryProjectSnapshot({ ...input, credential: 'other' }).mid, '456');
    assert.ok(Object.isFrozen(collected));
    assert.throws(() => {
        collected.mid = '9';
    }, TypeError);
    assert.deepEqual(Object.keys(collected).toSorted(), [
        'businessUnit',
        'credential',
        'key',
        'mid',
        'projectRoot',
        'snapshot',
    ]);
    const checked = await recheckQueryProjectSnapshot(collected);
    assert.deepEqual(checked, { snapshot: collected.snapshot, ready: true });
    assert.ok(Object.isFrozen(checked));
    input.key = 'changed';
    assert.equal(collected.key, 'sample');
});

test('closed internal script selection binds its contract while preserving legacy query hashes', async () => {
    const input = fixture();
    const query = collectQueryProjectSnapshot(input);
    const explicitQuery = collectQueryProjectSnapshot({ ...input, metadataType: 'query' });
    assert.deepEqual(explicitQuery, query);
    const legacyIdentity = {
        basis: 'config-only-decoded-text-utf8-v1',
        projectRoot: query.projectRoot,
        credential: query.credential,
        businessUnit: query.businessUnit,
        mid: query.mid,
        key: query.key,
        configTextHash: createHash('sha256').update(JSON.stringify(config()), 'utf8').digest('hex'),
        contract: QUERY_RETRIEVE_CONTRACT,
    };
    assert.equal(
        query.snapshot,
        createHash('sha256').update(JSON.stringify(legacyIdentity), 'utf8').digest('hex')
    );
    const script = collectQueryProjectSnapshot({ ...input, metadataType: 'script' });
    assert.equal(script.metadataType, 'script');
    assert.notEqual(script.snapshot, query.snapshot);
    assert.ok(Object.isFrozen(script));
    assert.equal((await recheckQueryProjectSnapshot(script)).ready, true);
    assert.equal(
        (await recheckQueryProjectSnapshot({ ...query, metadataType: 'script' })).ready,
        false
    );
    assert.equal(
        (await recheckQueryProjectSnapshot({ ...script, metadataType: 'query' })).ready,
        false
    );
    for (const metadataType of ['asset', '', null, 1, {}, ['script']]) {
        rejects({ ...input, metadataType });
    }
    write(input, JSON.stringify(config()) + '\n');
    assert.equal((await recheckQueryProjectSnapshot(script)).ready, false);
});

test('script snapshots retain selector and no-link config boundaries without opening auth', async () => {
    const input = { ...fixture(), metadataType: 'script' };
    for (const field of ['credential', 'businessUnit', 'key']) {
        for (const value of ['*', 'a,b', '../a', 'name:sample', '.mcdev-auth.json']) {
            rejects({ ...input, [field]: value });
        }
    }
    const open = fs.openSync;
    fs.openSync = (candidate, ...args) => {
        assert.equal(candidate, path.join(input.projectRoot, '.mcdevrc.json'));
        return open(candidate, ...args);
    };
    try {
        const script = collectQueryProjectSnapshot(input);
        assert.equal((await recheckQueryProjectSnapshot(script)).ready, true);
        rejects({ ...input, projectRoot: path.join(input.projectRoot, '.mcdev-auth.json') });
    } finally {
        fs.openSync = open;
    }
    const alias = path.join(runRoot, `script-junction-${randomUUID()}`);
    fs.symlinkSync(input.projectRoot, alias, 'junction');
    rejects({ ...input, projectRoot: alias });
});

test('positive safe numeric and positive digit-string MIDs follow exact normalization rules', () => {
    for (const mid of [1, Number.MAX_SAFE_INTEGER, '0001', '90071992547409999999']) {
        const value = config();
        value.credentials.demo.businessUnits.QA = mid;
        assert.equal(collectQueryProjectSnapshot(fixture(JSON.stringify(value))).mid, String(mid));
    }
    for (const mid of [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        '0',
        '000',
        '-1',
        '1e3',
        ' 1',
        '',
        null,
        true,
        {},
    ]) {
        const value = config();
        value.credentials.demo.businessUnits.QA = mid;
        rejects(fixture(JSON.stringify(value)));
    }
});

test('every mapping level requires an own object entry and selected BU never falls back', () => {
    for (const value of [
        {},
        { credentials: null },
        { credentials: [] },
        { credentials: { demo: null } },
        { credentials: { demo: [] } },
        { credentials: { demo: {} } },
        { credentials: { demo: { businessUnits: [] } } },
        { credentials: { demo: { businessUnits: {} } } },
    ])
        rejects(fixture(JSON.stringify(value)));
    const input = fixture();
    for (const change of [
        { credential: 'Demo' },
        { businessUnit: 'qa' },
        { credential: 'toString' },
        { businessUnit: 'toString' },
    ]) {
        rejects({ ...input, ...change });
    }
    // Poison inherited entries at each level; JSON parsing must not grant inherited mappings.
    for (const key of ['credentials', 'demo', 'businessUnits', 'QA']) {
        Object.defineProperty(Object.prototype, key, {
            value: { businessUnits: { QA: '123' } },
            configurable: true,
        });
        try {
            const value = config();
            switch (key) {
                case 'credentials': {
                    delete value.credentials;
                    break;
                }
                case 'demo': {
                    delete value.credentials.demo;
                    break;
                }
                case 'businessUnits': {
                    delete value.credentials.demo.businessUnits;
                    break;
                }
                default: {
                    delete value.credentials.demo.businessUnits.QA;
                }
            }
            rejects(fixture(JSON.stringify(value)));
        } finally {
            delete Object.prototype[key];
        }
    }
});

test('selector grammar matches gate literals and rejects broad or noncanonical inputs', () => {
    const input = fixture();
    for (const field of ['credential', 'businessUnit', 'key']) {
        for (const value of ['', '*', 'a,b', '../a', 'a..b', ' a', 'a ', 'a/b', null, 1]) {
            rejects({ ...input, [field]: value });
        }
    }
    for (const projectRoot of [
        'relative',
        `${input.projectRoot}\\`,
        String.raw`${input.projectRoot}\..\alias`,
        String.raw`\\host\share`,
    ]) {
        rejects({ ...input, projectRoot });
    }
    assert.ok(collectQueryProjectSnapshot({ ...input, key: 'Query_1. A-B' }).snapshot);
});

test('config text, selectors, MID and root changes alter binding with safe drift results', async () => {
    const input = fixture();
    const original = collectQueryProjectSnapshot(input);
    for (const change of [{ key: 'different' }, { credential: 'other' }]) {
        assert.notEqual(
            collectQueryProjectSnapshot({ ...input, ...change }).snapshot,
            original.snapshot
        );
    }
    assert.notEqual(collectQueryProjectSnapshot(fixture()).snapshot, original.snapshot);
    for (const raw of [
        JSON.stringify(config()) + '\n',
        JSON.stringify({ ...config(), custom: 'changed' }),
        JSON.stringify({ credentials: { demo: { businessUnits: { QA: '999' } } } }),
    ]) {
        write(input, raw);
        const checked = await recheckQueryProjectSnapshot(original);
        assert.equal(checked.ready, false);
        assert.notEqual(checked.snapshot, original.snapshot);
    }
    write(input, JSON.stringify(config()));
    assert.equal((await recheckQueryProjectSnapshot({ ...original, mid: '999' })).ready, false);
});

test('complete decoded rawText UTF8 basis preserves text without claiming original byte identity', () => {
    const prefix = Buffer.from(JSON.stringify(config()).slice(0, -1) + ',"extra":"');
    const suffix = Buffer.from('"}');
    const input = fixture(Buffer.concat([prefix, Buffer.from([0x80]), suffix]));
    const first = collectQueryProjectSnapshot(input);
    write(input, Buffer.concat([prefix, Buffer.from([0x81]), suffix]));
    assert.equal(collectQueryProjectSnapshot(input).snapshot, first.snapshot);
    write(input, Buffer.concat([prefix, Buffer.from('\uFFFD'), suffix]));
    assert.equal(collectQueryProjectSnapshot(input).snapshot, first.snapshot);
    write(input, Buffer.concat([prefix, Buffer.from('é'), suffix]));
    const composed = collectQueryProjectSnapshot(input).snapshot;
    write(input, Buffer.concat([prefix, Buffer.from('e\u0301'), suffix]));
    assert.notEqual(collectQueryProjectSnapshot(input).snapshot, composed);
    write(input, JSON.stringify(config()) + '\r\n');
    const crlf = collectQueryProjectSnapshot(input).snapshot;
    write(input, JSON.stringify(config()) + '\n');
    assert.notEqual(collectQueryProjectSnapshot(input).snapshot, crlf);
});

test('missing invalid and unsafe config fail closed without raw parser or filesystem errors', async () => {
    const input = fixture();
    const original = collectQueryProjectSnapshot(input);
    for (const raw of ['{"sensitive-fragment":', 'null', '[]', '{}']) {
        write(input, raw);
        rejects(input);
        assert.deepEqual(await recheckQueryProjectSnapshot(original), {
            snapshot: '',
            ready: false,
        });
    }
    fs.unlinkSync(path.join(input.projectRoot, '.mcdevrc.json'));
    rejects(input);
    assert.deepEqual(await recheckQueryProjectSnapshot(original), { snapshot: '', ready: false });
    const alias = path.join(runRoot, 'junction');
    fs.symlinkSync(fixture().projectRoot, alias, 'junction');
    rejects({ ...input, projectRoot: alias });
    const linked = fixture();
    const target = path.join(runRoot, 'invented-config.json');
    fs.writeFileSync(target, JSON.stringify(config()));
    fs.unlinkSync(path.join(linked.projectRoot, '.mcdevrc.json'));
    fs.linkSync(target, path.join(linked.projectRoot, '.mcdevrc.json'));
    rejects(linked);
});

test('collector and recheck open only literal config, never auth or project hook content', async () => {
    const input = fixture();
    const open = fs.openSync;
    const opened = [];
    fs.openSync = (candidate, ...args) => {
        assert.equal(candidate, path.join(input.projectRoot, '.mcdevrc.json'));
        opened.push(candidate);
        return open(candidate, ...args);
    };
    try {
        const collected = collectQueryProjectSnapshot(input);
        assert.equal((await recheckQueryProjectSnapshot(collected)).ready, true);
        rejects({ ...input, projectRoot: path.join(input.projectRoot, '.mcdev-auth.json') });
        assert.equal(opened.length, 2);
    } finally {
        fs.openSync = open;
    }
});

test('real blocked gate never executes after unchanged acceptance or accepted config drift', async () => {
    for (const drift of [false, true]) {
        const input = fixture();
        const snapshot = collectQueryProjectSnapshot(input);
        let executions = 0;
        let checked;
        const gate = createQueryRetrieveConfirmation(snapshot, {
            signal: new AbortController().signal,
            elicit: async ({ correlation }) => {
                if (drift) write(input, JSON.stringify(config()) + ' ');
                return { action: 'accept', content: { confirmed: true, correlation } };
            },
            recheck: async (operation) => {
                checked = await recheckQueryProjectSnapshot(operation);
                return checked;
            },
            execute: async () => {
                executions++;
            },
        });
        const result = await gate.confirm();
        assert.equal(checked.ready, !drift);
        assert.equal(result.outcome, 'blocked');
        assert.equal(result.executionEnabled, false);
        assert.equal(executions, 0);
    }
});
