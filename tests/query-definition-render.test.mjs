import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
    prepareQueryDefinitionRender,
    recheckQueryDefinitionRender,
    QueryDefinitionRenderPreparationError,
    createQueryDefinitionRenderCoordinator,
    executeQueryDefinitionRender,
} from '../dist/query-definition-render.js';
import * as guard from '../dist/project-operation-guard.js';
import { createQueryRetrieveCoordinator } from '../dist/query-retrieve-integration.js';

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
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-render-prepare-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain owned synthetic fixtures; no recursive cleanup and no native/account invocation.
function fixture(change = () => {}) {
    const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'project-')));
    const config = {
        version: '10.1.0',
        credentials: { demo: { eid: '100', businessUnits: { QA: '101' } } },
        directories: { template: 'templates', templateBuilds: ['build/one', 'build/two'] },
        options: { validation: { buildDefinition: false } },
        markets: {
            test: {
                NAME: 'safe value',
                OBJECT: { replace: 'safe:/@+-,._', inert: 'not interpreted "{}' },
            },
        },
    };
    change(config);
    fs.writeFileSync(path.join(projectRoot, '.mcdevrc.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.mcdev-auth.json\n');
    const git = (args) =>
        assert.equal(
            spawnSync('git', args, { cwd: projectRoot, shell: false, encoding: 'utf8' }).status,
            0
        );
    git(['init', '--quiet']);
    git(['config', '--local', 'user.name', 'Jörn Berkefeld']);
    git(['config', '--local', 'user.email', 'joern.berkefeld@gmail.com']);
    fs.mkdirSync(path.join(projectRoot, 'templates', 'query'), { recursive: true });
    const json = path.join(projectRoot, 'templates', 'query', 'source.query-meta.json');
    const sql = path.join(projectRoot, 'templates', 'query', 'source.query-meta.sql');
    fs.writeFileSync(json, '{"key":"output","name":"Static name"}');
    fs.writeFileSync(sql, "SELECT '{{{NAME}}}', '{{{OBJECT}}}'");
    return {
        input: {
            workspaceRoot: projectRoot,
            credential: 'demo',
            businessUnit: 'QA',
            templateName: 'source',
            market: 'test',
        },
        config,
        json,
        sql,
    };
}
function rejects(input) {
    assert.throws(
        () => prepareQueryDefinitionRender(input),
        (error) =>
            error instanceof QueryDefinitionRenderPreparationError &&
            error.message === 'Query definition render preparation unavailable.'
    );
}
function update(f) {
    fs.writeFileSync(path.join(f.input.workspaceRoot, '.mcdevrc.json'), JSON.stringify(f.config));
}
function frozen(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
}

test('static JSON and exact simple SQL tags produce immutable all-destination evidence without rendering', () => {
    const f = fixture();
    const bytes = fs.readFileSync(f.json);
    const prepared = prepareQueryDefinitionRender(f.input);
    frozen(prepared);
    assert.equal(prepared.outputKey, 'output');
    assert.equal(prepared.templateName, 'source');
    assert.equal(prepared.eid, '100');
    assert.equal(prepared.mid, '101');
    assert.equal(prepared.destinations.length, 2);
    for (const [index, destination] of prepared.destinations.entries()) {
        assert.equal(
            destination.json,
            path.join(
                f.input.workspaceRoot,
                'build',
                index ? 'two' : 'one',
                'demo',
                'QA',
                'query',
                'output.query-meta.json'
            )
        );
        assert.equal(destination.sql, destination.json.replace(/json$/u, 'sql'));
        assert.equal(destination.before.json.exists, false);
        assert.equal(destination.before.sql.exists, false);
    }
    assert.deepEqual(recheckQueryDefinitionRender(prepared), {
        ready: true,
        snapshot: prepared.snapshot,
    });
    assert.deepEqual(fs.readFileSync(f.json), bytes);
    assert.ok(!JSON.stringify(prepared).includes('safe value'));
    assert.equal(fs.existsSync(path.join(f.input.workspaceRoot, 'build')), false);
});

test('single configured root, existing bounded pairs, empty effective strings and duplicate static key semantics', () => {
    const f = fixture((config) => {
        config.directories.templateBuilds = 'build';
        config.markets.test.NAME = '';
    });
    fs.writeFileSync(f.json, '{"key":"first","key":"last"}');
    const destination = path.join(f.input.workspaceRoot, 'build', 'demo', 'QA', 'query');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'last.query-meta.json'), '{}');
    fs.writeFileSync(path.join(destination, 'last.query-meta.sql'), 'SELECT 1');
    const prepared = prepareQueryDefinitionRender(f.input);
    assert.equal(prepared.outputKey, 'last');
    assert.equal(prepared.destinations.length, 1);
    assert.equal(prepared.destinations[0].before.sql.exists, true);
    assert.equal(recheckQueryDefinitionRender(prepared).ready, true);
});

test('type-directory template collisions refuse before launch without touching either destination', async () => {
    for (const unsafeActualDirectory of [false, true]) {
        const f = fixture();
        const destinations = prepareQueryDefinitionRender(f.input).destinations;
        for (const destination of destinations) writePair(destination);
        const actualFiles = destinations.map((destination) => {
            const directory = path.join(path.dirname(path.dirname(destination.json)), 'output');
            if (unsafeActualDirectory) {
                fs.writeFileSync(directory, 'unsafe actual directory sentinel');
                return directory;
            }
            fs.mkdirSync(directory);
            const file = path.join(directory, 'output.query-meta.json');
            fs.writeFileSync(file, 'actual destination sentinel');
            return file;
        });
        fs.renameSync(f.json, path.join(path.dirname(f.json), 'query.query-meta.json'));
        fs.renameSync(f.sql, path.join(path.dirname(f.sql), 'query.query-meta.sql'));
        const input = { ...f.input, templateName: 'query' };
        const files = [
            ...destinations.flatMap((destination) => [destination.json, destination.sql]),
            ...actualFiles,
        ];
        const before = files.map((file) => fs.readFileSync(file));
        let launches = 0;
        const runner = createQueryDefinitionRenderCoordinator({
            launch: async () => {
                launches++;
                return closed();
            },
        });
        rejects(input);
        const result = await runner.executeQueryDefinitionRender(input, context());
        assert.equal(result.outcome, 'unavailable');
        assert.equal(launches, 0);
        assert.deepEqual(
            files.map((file) => fs.readFileSync(file)),
            before
        );
    }
    const f = fixture();
    fs.renameSync(f.json, path.join(path.dirname(f.json), 'query.query-meta.json'));
    fs.renameSync(f.sql, path.join(path.dirname(f.sql), 'query.query-meta.sql'));
    fs.writeFileSync(path.join(path.dirname(f.json), 'query.query-meta.json'), '{"key":"query"}');
    assert.equal(
        prepareQueryDefinitionRender({ ...f.input, templateName: 'query' }).outputKey,
        'query'
    );
});

test('direct and object later-key injection and unused malicious entries refuse before any launcher or write', () => {
    for (const object of [false, true]) {
        for (const used of [false, true]) {
            const f = fixture();
            const attack = '","key":"../../escape","x":"';
            f.config.markets.test[used ? 'NAME' : 'UNUSED'] = object ? { replace: attack } : attack;
            update(f);
            fs.writeFileSync(f.json, '{"key":"output","later":"{{{NAME}}}"}');
            const original = fs.readFileSync(f.json);
            let launches = 0;
            try {
                prepareQueryDefinitionRender(f.input);
                launches++;
                assert.fail('injection accepted');
            } catch (ex) {
                assert.ok(ex instanceof QueryDefinitionRenderPreparationError);
            }
            assert.equal(launches, 0);
            assert.deepEqual(fs.readFileSync(f.json), original);
            assert.equal(fs.existsSync(path.join(f.input.workspaceRoot, 'build')), false);
            // Independently prove all effective market strings are checked even with static JSON.
            fs.writeFileSync(f.json, '{"key":"output"}');
            rejects(f.input);
        }
    }
});

test('all raw JSON adjacent/spaced opening pairs, property-name tags and dynamic keys fail closed', () => {
    const f = fixture();
    for (const raw of [
        '{"key":"{{{NAME}}}"}',
        '{"key":"output","{{{NAME}}}":1}',
        '{"key":"output","later":"{\n\t{NAME}"}',
        ...['{{{NAME}}}', '{ { {NAME} } }', '{{ {NAME} }}', '{ {{NAME}} }'].map((value) =>
            JSON.stringify({ key: 'output', later: value })
        ),
    ]) {
        fs.writeFileSync(f.json, raw);
        rejects(f.input);
    }
    for (const key of ['', '../escape', '%20', 'CON', 'trailing.', '__proto__', 'a,b']) {
        fs.writeFileSync(f.json, JSON.stringify({ key }));
        rejects(f.input);
    }
});

test('SQL rejects every nonexact or unsupported tag without substitution', () => {
    const f = fixture();
    for (const sql of [
        '{{NAME}}',
        '{{{MISSING}}}',
        '{{{constructor}}}',
        '{{{a.b}}}',
        '{{{#NAME}}}',
        '{{{^NAME}}}',
        '{{{>NAME}}}',
        '{{{!comment}}}',
        '{{{=x x=}}}',
        '{{{&NAME}}}',
        '{{{ NAME }}}',
        '{ {{NAME}} }',
        '{{ {NAME} }}',
        '{ { {NAME} } }',
        '{{{NAME}}',
        'NAME}}}',
        '{{{NAME}}}}',
        '{{{{NAME}}}',
        '{ {{{NAME}}}',
        '{\n{{{NAME}}}',
        '{{{NAME}}}\n{\t{',
        '',
    ]) {
        fs.writeFileSync(f.sql, sql);
        rejects(f.input);
    }
});

test('entire market requires own simple names and strict direct/object effective string allowlist', () => {
    const f = fixture();
    for (const value of [
        null,
        [],
        true,
        1,
        {},
        { replace: 1 },
        { replace: null },
        { replace: [] },
        'quote"',
        "quote'",
        'slash\\',
        'brace{',
        'newline\n',
        'tab\t',
        'é',
        { replace: 'bad\n' },
    ]) {
        f.config.markets.test.UNUSED = value;
        update(f);
        rejects(f.input);
    }
    delete f.config.markets.test.UNUSED;
    for (const name of [
        'constructor',
        'prototype',
        '__proto__',
        'a.b',
        '#section',
        'name\n',
        '_name',
        '0name',
    ]) {
        Object.defineProperty(f.config.markets.test, name, {
            value: 'safe',
            enumerable: true,
            configurable: true,
        });
        update(f);
        rejects(f.input);
        delete f.config.markets.test[name];
    }
});

test('exact selectors, configured identities and disabled hooks are required', () => {
    const f = fixture();
    for (const field of ['credential', 'businessUnit', 'templateName', 'market']) {
        for (const value of [
            'missing',
            'a,b',
            '../a',
            '%20',
            'a:b',
            '*',
            '__clone__',
            'CON',
            'name.',
        ])
            rejects({ ...f.input, [field]: value });
    }
    for (const value of [undefined, true, {}, 'false', null]) {
        f.config.options.validation.buildDefinition = value;
        update(f);
        rejects(f.input);
    }
    f.config.options.validation.buildDefinition = false;
    f.config.version = '10.2.0';
    update(f);
    rejects(f.input);
});

test('all configured roots are bounded, contained, distinct and separate from template/security paths', () => {
    const f = fixture();
    for (const roots of [
        [],
        Array.from({ length: 17 }).fill('build'),
        ['build', 'build'],
        ['build', 'BUILD'],
        ['build', 'build/nested'],
        ['templates'],
        ['templates/nested'],
        ['../escape'],
        ['F:/outside'],
        ['build//two'],
        ['build/../two'],
        ['build/%20'],
        ['.git/build'],
        ['logs'],
        ['.mcdev-auth.json/build'],
        ['.sf/build'],
        [String.raw`build\two`],
        [null],
    ]) {
        f.config.directories.templateBuilds = roots;
        update(f);
        rejects(f.input);
    }
});

test('strict UTF-8, required companions and bounded config/JSON/SQL/output reads', () => {
    for (const file of ['json', 'sql']) {
        const f = fixture();
        fs.writeFileSync(f[file], Buffer.from([195, 40]));
        rejects(f.input);
        fs.writeFileSync(f[file], '\uFEFF{"key":"output"}');
        rejects(f.input);
        fs.writeFileSync(f[file], 'null\0');
        rejects(f.input);
        fs.writeFileSync(
            f[file],
            Buffer.alloc((file === 'json' ? 1024 * 1024 : 4 * 1024 * 1024) + 1, 65)
        );
        rejects(f.input);
        fs.unlinkSync(f[file]);
        rejects(f.input);
    }
    const f = fixture();
    fs.writeFileSync(
        path.join(f.input.workspaceRoot, '.mcdevrc.json'),
        Buffer.alloc(1024 * 1024 + 1)
    );
    rejects(f.input);
});

test('recheck binds raw source/config/market and all destination bytes and ancestor identities', () => {
    for (const which of ['json', 'sql', 'market', 'config', 'destination', 'ancestor']) {
        const f = fixture();
        const prepared = prepareQueryDefinitionRender(f.input);
        if (which === 'json' || which === 'sql') fs.appendFileSync(f[which], '\n');
        if (which === 'market') {
            f.config.markets.test.NAME = 'changed';
            update(f);
        }
        if (which === 'config')
            fs.appendFileSync(path.join(f.input.workspaceRoot, '.mcdevrc.json'), '\n');
        if (which === 'destination') {
            const file = prepared.destinations[1].sql;
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'SELECT 1');
        }
        if (which === 'ancestor') fs.mkdirSync(path.join(f.input.workspaceRoot, 'build'));
        assert.equal(recheckQueryDefinitionRender(prepared).ready, false, which);
    }
    const f = fixture();
    const prepared = prepareQueryDefinitionRender(f.input);
    assert.equal(recheckQueryDefinitionRender({ ...prepared, outputKey: 'forged' }).ready, false);
});

test('junction, hardlink, non-directory ancestors and unsafe output files are refused', () => {
    const f = fixture();
    const original = path.join(f.input.workspaceRoot, 'templates');
    const moved = path.join(f.input.workspaceRoot, 'moved');
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original, 'junction');
    rejects(f.input);
    const g = fixture();
    const target = path.join(g.input.workspaceRoot, 'hardlink');
    fs.linkSync(g.json, target);
    rejects(g.input);
    const h = fixture();
    fs.writeFileSync(path.join(h.input.workspaceRoot, 'build'), 'file');
    rejects(h.input);
});

test('existing oversized outputs and replaced missing ancestors invalidate preparation', () => {
    const f = fixture();
    const prepared = prepareQueryDefinitionRender(f.input);
    const file = prepared.destinations[0].sql;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    rejects(f.input);
    assert.equal(recheckQueryDefinitionRender(prepared).ready, false);
    const g = fixture();
    fs.mkdirSync(path.join(g.input.workspaceRoot, 'build'));
    const prior = prepareQueryDefinitionRender(g.input);
    fs.renameSync(
        path.join(g.input.workspaceRoot, 'build'),
        path.join(g.input.workspaceRoot, 'old-build')
    );
    fs.symlinkSync(
        path.join(g.input.workspaceRoot, 'old-build'),
        path.join(g.input.workspaceRoot, 'build'),
        'junction'
    );
    assert.equal(recheckQueryDefinitionRender(prior).ready, false);
});

test('no authentication contents or native modules are read and missing Git protection fails', () => {
    const f = fixture();
    const open = fs.openSync;
    fs.openSync = (file, ...args) => {
        assert.ok(!String(file).includes('.mcdev-auth'));
        return open(file, ...args);
    };
    try {
        prepareQueryDefinitionRender(f.input);
    } finally {
        fs.openSync = open;
    }
    fs.writeFileSync(path.join(f.input.workspaceRoot, '.gitignore'), '');
    rejects(f.input);
});

const context = () => ({ signal: new AbortController().signal });
const closed = (change = {}) =>
    Object.freeze({
        outcome: 'exited',
        stopReason: null,
        started: true,
        directChildClosed: true,
        descendantsStopped: false,
        exitCode: 0,
        exitSignal: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        partialEffectsPossible: true,
        ...change,
    });
function writePair(destination, sql = 'SELECT 1', json = '{"key":"output"}') {
    fs.mkdirSync(path.dirname(destination.json), { recursive: true });
    fs.writeFileSync(destination.json, json);
    fs.writeFileSync(destination.sql, sql);
}
const classifications = (result) => result.destinations.map((d) => d.artifactClassification);

test('render projects only finite safe results for all ordered native companion destinations', async () => {
    const f = fixture();
    let calls = 0;
    const runner = createQueryDefinitionRenderCoordinator({
        launch: async (prepared, lifetime, runtime) => {
            calls++;
            assert.equal(lifetime.signal, ctx.signal);
            assert.equal(lifetime.timeoutMs, 1234);
            assert.deepEqual(runtime, { cliEntry: prepared.runtime.cliEntry });
            assert.equal(guard.tryAcquire(prepared.projectRoot), false);
            writePair(prepared.destinations[0]);
            fs.mkdirSync(path.dirname(prepared.destinations[1].json), { recursive: true });
            fs.writeFileSync(prepared.destinations[1].json, '{"key":"output"}');
            return closed({ privateOutput: 'secret native diagnostic' });
        },
    });
    const ctx = { ...context(), processTimeoutMs: 1234 };
    const result = await runner.executeQueryDefinitionRender(f.input, ctx);
    assert.equal(calls, 1);
    assert.deepEqual(result, {
        outcome: 'exited',
        processOutcome: 'exited',
        projectBlocked: false,
        destinations: [
            { index: 0, artifactClassification: 'local-materialization' },
            { index: 1, artifactClassification: 'partial' },
        ],
        artifactCompletenessVerified: false,
        remoteCompletenessVerified: false,
        languageValidationPerformed: false,
    });
    frozen(result);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(result).includes(f.input.workspaceRoot));
    assert.equal(guard.tryAcquire(f.input.workspaceRoot), true);
    guard.release(f.input.workspaceRoot);
});

test('unchanged deterministic rerenders and ignored single-companion failures stay conservative', async () => {
    for (const change of ['none', 'json', 'sql', 'both']) {
        const f = fixture();
        for (const destination of prepareQueryDefinitionRender(f.input).destinations)
            writePair(destination);
        const runner = createQueryDefinitionRenderCoordinator({
            launch: async (prepared) => {
                for (const destination of prepared.destinations) {
                    if (change === 'json' || change === 'both')
                        fs.writeFileSync(destination.json, '{"key":"output","changed":true}');
                    if (change === 'sql' || change === 'both')
                        fs.writeFileSync(destination.sql, 'SELECT 2');
                }
                return closed();
            },
        });
        const result = await runner.executeQueryDefinitionRender(f.input, context());
        const expected =
            change === 'none'
                ? 'unchanged-unverified'
                : change === 'both'
                  ? 'local-materialization'
                  : 'partial';
        assert.deepEqual(classifications(result), [expected, expected]);
    }
});

test('malformed wrong-key unsafe and drifting postprocess observations never materialize', async () => {
    for (const variant of ['json', 'key', 'utf8', 'empty', 'nul', 'junction', 'drift']) {
        const f = fixture();
        const read = fs.readSync;
        let changed = false;
        let target;
        const runner = createQueryDefinitionRenderCoordinator({
            launch: async (prepared) => {
                target = prepared.destinations[0].json;
                for (const destination of prepared.destinations) {
                    writePair(destination);
                    if (variant === 'json') fs.writeFileSync(destination.json, '{');
                    if (variant === 'key') fs.writeFileSync(destination.json, '{"key":"other"}');
                    if (variant === 'utf8')
                        fs.writeFileSync(destination.sql, Buffer.from([195, 40]));
                    if (variant === 'empty') fs.writeFileSync(destination.sql, ' ');
                    if (variant === 'nul') fs.writeFileSync(destination.sql, 'SELECT\0');
                    if (variant === 'junction') {
                        fs.unlinkSync(destination.sql);
                        fs.symlinkSync(path.dirname(f.sql), destination.sql, 'junction');
                    }
                }
                if (variant === 'drift')
                    fs.readSync = (...args) => {
                        const count = read(...args);
                        if (!changed) {
                            changed = true;
                            fs.appendFileSync(target, ' ');
                        }
                        return count;
                    };
                return closed();
            },
        });
        try {
            const result = await runner.executeQueryDefinitionRender(f.input, context());
            assert.equal(classifications(result)[0], 'unverified', variant);
        } finally {
            fs.readSync = read;
        }
    }
});

test('each lone companion is validated before partial or unchanged classification', async () => {
    for (const existing of [false, true]) {
        for (const [file, bytes, valid] of [
            ['json', '{', false],
            ['json', '{"key":"other"}', false],
            ['sql', Buffer.from([195, 40]), false],
            ['sql', 'SELECT\0', false],
            ['sql', '', false],
            ['sql', ' \n', false],
            ['json', '{"key":"output"}', true],
            ['sql', 'SELECT 1', true],
        ]) {
            const f = fixture();
            const destinations = prepareQueryDefinitionRender(f.input).destinations;
            const writeCompanion = () => {
                for (const destination of destinations) {
                    fs.mkdirSync(path.dirname(destination[file]), { recursive: true });
                    fs.writeFileSync(destination[file], bytes);
                }
            };
            if (existing) writeCompanion();
            let launches = 0;
            const runner = createQueryDefinitionRenderCoordinator({
                launch: async () => {
                    launches++;
                    if (!existing) writeCompanion();
                    return closed();
                },
            });
            const result = await runner.executeQueryDefinitionRender(f.input, context());
            assert.equal(launches, 1);
            const expected = valid ? (existing ? 'unchanged-unverified' : 'partial') : 'unverified';
            assert.deepEqual(classifications(result), [expected, expected]);
            assert.equal(result.artifactCompletenessVerified, false);
            assert.equal(result.remoteCompletenessVerified, false);
            assert.equal(result.languageValidationPerformed, false);
        }
    }
});

test('refusal cancellation and immediate guarded drift never launch or write', async () => {
    for (const variant of ['invalid', 'cancel', 'during-recheck', 'drift']) {
        const f = fixture();
        const controller = new AbortController();
        let calls = 0;
        const runner = createQueryDefinitionRenderCoordinator({
            recheck: (prepared) => {
                assert.equal(guard.tryAcquire(prepared.projectRoot), false);
                if (variant === 'during-recheck') controller.abort();
                if (variant === 'drift') fs.appendFileSync(f.sql, ' ');
                return recheckQueryDefinitionRender(prepared);
            },
            launch: async () => {
                calls++;
                return closed();
            },
        });
        if (variant === 'cancel') controller.abort();
        const result = await runner.executeQueryDefinitionRender(
            variant === 'invalid' ? { ...f.input, market: 'missing' } : f.input,
            { signal: controller.signal }
        );
        assert.equal(
            result.outcome,
            variant === 'invalid' ? 'unavailable' : variant === 'drift' ? 'blocked' : 'cancelled'
        );
        assert.equal(calls, 0);
        assert.equal(fs.existsSync(path.join(f.input.workspaceRoot, 'build')), false);
    }
    assert.equal(typeof executeQueryDefinitionRender, 'function');
});

test('failure and stopped process outcomes survive artifacts without retry or rollback', async () => {
    for (const outcome of ['exited', 'cancelled', 'timed-out', 'output-limit', 'spawn-failed']) {
        const f = fixture();
        let calls = 0;
        const runner = createQueryDefinitionRenderCoordinator({
            launch: async (prepared) => {
                calls++;
                for (const destination of prepared.destinations) writePair(destination);
                return closed({
                    outcome,
                    exitCode: 1,
                    started: outcome !== 'spawn-failed',
                    directChildClosed: outcome !== 'spawn-failed',
                });
            },
        });
        const result = await runner.executeQueryDefinitionRender(f.input, context());
        assert.equal(result.outcome, outcome === 'exited' ? 'failed' : outcome);
        assert.equal(result.processOutcome, outcome);
        assert.equal(calls, 1);
        assert.deepEqual(
            classifications(result),
            Array.from({ length: 2 }).fill(
                outcome === 'spawn-failed' ? 'unverified' : 'local-materialization'
            )
        );
        for (const destination of prepareQueryDefinitionRender(f.input).destinations)
            assert.equal(fs.readFileSync(destination.sql, 'utf8'), 'SELECT 1');
    }
});

test('render and both retrieve families share exclusion throughout unsettled launch', async () => {
    const f = fixture();
    let finish;
    let entered;
    const started = new Promise((resolve) => {
        entered = resolve;
    });
    const runner = createQueryDefinitionRenderCoordinator({
        launch: async () => {
            entered();
            return new Promise((resolve) => {
                finish = resolve;
            });
        },
    });
    const pending = runner.executeQueryDefinitionRender(f.input, context());
    await started;
    let retrievalCalls = 0;
    const retrieve = createQueryRetrieveCoordinator({
        recheck: async () => {
            retrievalCalls++;
            throw new Error('must not run');
        },
    });
    for (const type of ['query', 'script']) {
        const method = type === 'query' ? 'runQueryRetrieve' : 'runScriptRetrieve';
        assert.equal(
            (
                await retrieve[method](
                    {
                        projectRoot: f.input.workspaceRoot.toUpperCase(),
                        metadataType: type,
                    },
                    context()
                )
            ).outcome,
            'project-busy'
        );
    }
    assert.equal(retrievalCalls, 0);
    assert.equal(
        (await runner.executeQueryDefinitionRender(f.input, context())).outcome,
        'project-busy'
    );
    assert.equal(guard.acknowledgeExternalReconciliation(f.input.workspaceRoot), false);
    finish(closed());
    await pending;
    assert.equal(guard.tryAcquire(f.input.workspaceRoot), true);
    assert.equal(
        (await runner.executeQueryDefinitionRender(f.input, context())).outcome,
        'project-busy'
    );
    guard.release(f.input.workspaceRoot);
});

test('throwing launch and unknown termination latch shared blocking until external reconciliation', async () => {
    for (const variant of ['throw', 'termination-unconfirmed', 'open-child']) {
        const f = fixture();
        let calls = 0;
        const runner = createQueryDefinitionRenderCoordinator({
            launch: async () => {
                calls++;
                if (variant === 'throw') throw new Error('private secret');
                return closed({
                    outcome: variant === 'open-child' ? 'timed-out' : variant,
                    directChildClosed: false,
                });
            },
        });
        const result = await runner.executeQueryDefinitionRender(f.input, context());
        assert.equal(result.projectBlocked, true);
        assert.deepEqual(classifications(result), ['unverified', 'unverified']);
        assert.equal(guard.isBlocked(f.input.workspaceRoot.toUpperCase()), true);
        guard.release(f.input.workspaceRoot);
        assert.equal(
            (await runner.executeQueryDefinitionRender(f.input, context())).outcome,
            'project-busy'
        );
        assert.equal(calls, 1);
        assert.ok(!JSON.stringify(result).includes('private'));
        assert.equal(runner.acknowledgeExternalReconciliation(f.input.workspaceRoot), true);
        assert.equal(guard.tryAcquire(f.input.workspaceRoot), true);
        guard.release(f.input.workspaceRoot);
    }
});
