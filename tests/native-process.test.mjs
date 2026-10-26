import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runNativeProcess } from '../dist/native-process.js';

validateTempEnvironment();
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-native-process-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain synthetic run-owned fixtures; no recursive cleanup or native mcdev invocation.
function fixture(args = ['synthetic-command', 'literal ; & value'], version = '10.1.0') {
    const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'project-')));
    const packageRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'runtime-')));
    fs.mkdirSync(path.join(packageRoot, 'lib'));
    const cliEntry = path.join(packageRoot, 'lib', 'cli.js');
    fs.writeFileSync(
        cliEntry,
        `import fs from 'node:fs';
import { spawn } from 'node:child_process';
import Mcdev from './index.js';
Mcdev.setOptions({ ordinary: 'cli', fixShared: undefined });
fs.writeFileSync('options.json', JSON.stringify(Mcdev.options));
fs.writeFileSync('observed.json', JSON.stringify({ args: process.argv.slice(2), cliEntry: process.argv[1], cwd: process.cwd(), env: process.env }));
if (process.argv[2] === 'flood') { process.stderr.write('PRIVATE_OUTPUT'.repeat(100000)); setInterval(() => {}, 1000); }
else if (process.argv[2] === 'finite-flood') { process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 65)); process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 66)); }
else if (process.argv[2] === 'inherited-pipe') { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: ['ignore', process.stdout, process.stderr] }); process.stdout.write('started'); setInterval(() => {}, 1000); }
else if (process.argv[2] === 'long') { process.stdout.write('started'); setTimeout(() => process.stderr.write('finished'), 350); }
else if (process.argv[2] === 'hang') { setInterval(() => {}, 1000); }
else { process.stdout.write('PRIVATE_OUTPUT'); process.exitCode = 7; }
`
    );
    fs.writeFileSync(
        path.join(packageRoot, 'lib', 'index.js'),
        `export default class Mcdev {
    static options = {};
    static setOptions(argv) {
        for (const [key, value] of Object.entries(argv)) {
            if (value !== undefined) this.options[key] = value;
        }
    }
}
`
    );
    fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
            name: 'mcdev',
            version,
            type: 'module',
            bin: { mcdev: 'lib/cli.js' },
        })
    );
    return {
        input: { projectRoot, args },
        runtime: { cliEntry },
        controller: new AbortController(),
    };
}
const run = (f, timeoutMs = 3000) =>
    runNativeProcess(f.input, { signal: f.controller.signal, timeoutMs }, f.runtime);
function safe(result) {
    assert.ok(Object.isFrozen(result));
    assert.equal(Object.hasOwn(result, 'retrievalVerified'), false);
    assert.equal(result.descendantsStopped, false);
    assert.equal(result.partialEffectsPossible, result.started);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OUTPUT|observed|argv|Error/u);
    assert.deepEqual(
        Object.keys(result).toSorted(),
        [
            'outcome',
            'stopReason',
            'started',
            'directChildClosed',
            'descendantsStopped',
            'exitCode',
            'exitSignal',
            'stdoutBytes',
            'stderrBytes',
            'partialEffectsPossible',
        ].toSorted()
    );
}

test('transport prepends trusted CLI and forwards internal readonly argv without retrieval assumptions', async () => {
    const f = fixture(Object.freeze(['synthetic-command', 'literal ; & value']));
    const result = await run(f);
    safe(result);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 7);
    assert.equal(result.directChildClosed, true);
    assert.ok(result.stdoutBytes > 0);
    const observed = JSON.parse(
        fs.readFileSync(path.join(f.input.projectRoot, 'observed.json'), 'utf8')
    );
    assert.deepEqual(observed.args, f.input.args);
    assert.equal(observed.cliEntry, f.runtime.cliEntry);
    assert.equal(observed.cwd, f.input.projectRoot);
    assert.equal(observed.env.NODE_OPTIONS, undefined);
    assert.equal(observed.env.NO_COLOR, '1');
});

test('native bridge seeds the CLI singleton without changing argv, cwd or environment isolation', async () => {
    const f = fixture(Object.freeze(['deploy', 'credential/business-unit', 'folder ; & value']));
    f.input.nativeChoices = Object.freeze({ fixShared: 'shared folder ; & literal' });
    const parentArgv = [...process.argv];
    const parentCwd = process.cwd();
    const parentEnv = { ...process.env };
    const result = await runNativeProcess(
        f.input,
        { signal: f.controller.signal, nativeCommandMode: true },
        f.runtime
    );
    safe(result);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 7);
    assert.equal(result.directChildClosed, true);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(f.input.projectRoot, 'options.json'), 'utf8')),
        { fixShared: 'shared folder ; & literal', skipInteraction: true, ordinary: 'cli' }
    );
    const observed = JSON.parse(
        fs.readFileSync(path.join(f.input.projectRoot, 'observed.json'), 'utf8')
    );
    assert.deepEqual(observed.args, f.input.args);
    assert.equal(observed.cliEntry, f.runtime.cliEntry);
    assert.equal(observed.cwd, f.input.projectRoot);
    assert.equal(observed.env.NODE_OPTIONS, undefined);
    assert.equal(observed.env.NO_COLOR, '1');
    assert.deepEqual(process.argv, parentArgv);
    assert.equal(process.cwd(), parentCwd);
    assert.deepEqual({ ...process.env }, parentEnv);
});

test('native choices reject invalid selections and non-deploy or legacy launches before spawn', async () => {
    for (const nativeChoices of [
        null,
        {},
        { fixShared: '' },
        { fixShared: '  ' },
        { fixShared: true },
        { fixShared: 'x\0y' },
        { fixShared: 'folder', other: true },
    ]) {
        const f = fixture(['deploy']);
        f.input.nativeChoices = nativeChoices;
        const result = await runNativeProcess(
            f.input,
            { signal: f.controller.signal, nativeCommandMode: true },
            f.runtime
        );
        safe(result);
        assert.equal(result.outcome, 'invalid-input');
        assert.equal(result.started, false);
    }
    for (const [args, nativeCommandMode] of [
        [['deploy'], false],
        [['retrieve'], true],
        [[], true],
    ]) {
        const f = fixture(args);
        f.input.nativeChoices = { fixShared: 'folder' };
        assert.equal(
            (
                await runNativeProcess(
                    f.input,
                    { signal: f.controller.signal, nativeCommandMode },
                    f.runtime
                )
            ).outcome,
            'invalid-input'
        );
        assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
    }
});

test('native bridge retains package validation and prelaunch cancellation evidence', async () => {
    const f = fixture(['deploy']);
    f.input.nativeChoices = { fixShared: 'folder' };
    f.controller.abort();
    const lifetime = { signal: f.controller.signal, nativeCommandMode: true };
    const result = await runNativeProcess(f.input, lifetime, f.runtime);
    safe(result);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.started, false);
    fs.unlinkSync(path.join(path.dirname(f.runtime.cliEntry), 'index.js'));
    assert.equal((await runNativeProcess(f.input, lifetime, f.runtime)).outcome, 'invalid-input');
});

test('transport rejects invalid args, lifetime, cwd and CLI identity before launch', async () => {
    for (const args of [null, 'command', [42]]) {
        const f = fixture();
        f.input.args = args;
        const result = await run(f);
        safe(result);
        assert.equal(result.outcome, 'invalid-input');
        assert.equal(result.started, false);
    }
    const f = fixture();
    assert.equal((await run(f, 0)).outcome, 'invalid-input');
    f.input.projectRoot = 'relative';
    assert.equal((await run(f)).outcome, 'invalid-input');
    const other = fixture();
    fs.writeFileSync(
        path.join(path.dirname(path.dirname(other.runtime.cliEntry)), 'package.json'),
        '{}'
    );
    assert.equal((await run(other)).outcome, 'invalid-input');
});

test('transport preserves prelaunch cancellation and invalid-input precedence', async () => {
    const f = fixture();
    f.controller.abort('PRIVATE_OUTPUT');
    const result = await run(f);
    safe(result);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(result.started, false);
    assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
    assert.equal((await run(f, 0)).outcome, 'invalid-input');
});

test('general transport drains finite flood without retaining output or imposing the legacy cap', async () => {
    const f = fixture(['finite-flood'], '10.12.3');
    const captured = { stdout: 0, stderr: 0 };
    const progress = [];
    const result = await runNativeProcess(
        f.input,
        {
            signal: f.controller.signal,
            nativeCommandMode: true,
            onOutput(stream, chunk) {
                assert.ok(Buffer.isBuffer(chunk));
                assert.equal(chunk[0], stream === 'stdout' ? 65 : 66);
                captured[stream] += chunk.length;
            },
            onProgress(value) {
                assert.ok(Object.isFrozen(value));
                progress.push(value);
            },
        },
        f.runtime
    );
    safe(result);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(captured, { stdout: 2 * 1024 * 1024, stderr: 2 * 1024 * 1024 });
    assert.equal(result.stdoutBytes, captured.stdout);
    assert.equal(result.stderrBytes, captured.stderr);
    assert.deepEqual(progress.at(-1), {
        stdoutBytes: captured.stdout,
        stderrBytes: captured.stderr,
    });
    assert.equal((await run(f)).outcome, 'invalid-input');
});

test('general transport accepts the 24h bound and rejects other major or malformed versions', async () => {
    const f = fixture(['long']);
    const chunks = [];
    const result = await runNativeProcess(
        f.input,
        {
            signal: f.controller.signal,
            nativeCommandMode: true,
            timeoutMs: 24 * 60 * 60 * 1000,
            onOutput: (stream, chunk) => chunks.push([stream, chunk.toString()]),
        },
        f.runtime
    );
    safe(result);
    assert.equal(result.outcome, 'exited');
    assert.deepEqual(chunks, [
        ['stdout', 'started'],
        ['stderr', 'finished'],
    ]);
    for (const version of ['11.0.0', '9.99.0', '10.01.0', '10.2.0-beta.1']) {
        const invalid = fixture([], version);
        assert.equal(
            (
                await runNativeProcess(
                    invalid.input,
                    {
                        signal: invalid.controller.signal,
                        nativeCommandMode: true,
                    },
                    invalid.runtime
                )
            ).outcome,
            'invalid-input'
        );
    }
    for (const timeoutMs of [0, -1, 24 * 60 * 60 * 1000 + 1, Number.NaN]) {
        assert.equal(
            (
                await runNativeProcess(
                    f.input,
                    {
                        signal: f.controller.signal,
                        nativeCommandMode: true,
                        timeoutMs,
                    },
                    f.runtime
                )
            ).outcome,
            'invalid-input'
        );
    }
});

test('general transport classifies observed direct-child close after timeout or cancellation', async () => {
    const hanging = fixture(['hang']);
    const timedOut = await runNativeProcess(
        hanging.input,
        {
            signal: hanging.controller.signal,
            nativeCommandMode: true,
            timeoutMs: 250,
        },
        hanging.runtime
    );
    safe(timedOut);
    assert.equal(timedOut.outcome, 'timed-out');
    assert.equal(timedOut.stopReason, 'timed-out');
    assert.equal(timedOut.directChildClosed, true);
    const f = fixture(['long']);
    const result = await runNativeProcess(
        f.input,
        {
            signal: f.controller.signal,
            nativeCommandMode: true,
            onOutput() {
                f.controller.abort();
                throw new Error('observer failure');
            },
        },
        f.runtime
    );
    safe(result);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.directChildClosed, true);
});

test('general transport reports only observed closure with inherited descendant pipes', async () => {
    const f = fixture(['inherited-pipe']);
    const result = await runNativeProcess(
        f.input,
        {
            signal: f.controller.signal,
            nativeCommandMode: true,
            onOutput() {
                f.controller.abort();
            },
        },
        f.runtime
    );
    safe(result);
    assert.equal(
        result.outcome,
        result.directChildClosed ? 'cancelled' : 'termination-unconfirmed'
    );
    assert.equal(result.stopReason, 'cancelled');
    if (process.platform !== 'win32') assert.equal(result.directChildClosed, false);
});

test('general transport keeps draining after observer exceptions', async () => {
    const f = fixture(['finite-flood']);
    const result = await runNativeProcess(
        f.input,
        {
            signal: f.controller.signal,
            nativeCommandMode: true,
            onOutput() {
                throw new Error('observer failure');
            },
            onProgress() {
                throw new Error('observer failure');
            },
        },
        f.runtime
    );
    safe(result);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.stdoutBytes, 2 * 1024 * 1024);
    assert.equal(result.stderrBytes, 2 * 1024 * 1024);
});

test('transport retains conservative timeout and private output-limit settlement', async () => {
    for (const [command, reason] of [
        ['hang', 'timed-out'],
        ['flood', 'output-limit'],
    ]) {
        const result = await run(fixture([command]), command === 'hang' ? 250 : 3000);
        safe(result);
        assert.equal(result.outcome, 'termination-unconfirmed');
        assert.equal(result.stopReason, reason);
        assert.equal(result.started, true);
        if (reason === 'output-limit') {
            assert.ok(result.stderrBytes > 1024 * 1024);
            assert.ok(result.stderrBytes <= 1024 * 1024 + 1);
        }
    }
});
