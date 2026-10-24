import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runNativeProcess } from '../dist/native-process.js';

for (const [name, value] of Object.entries({
    TEMP: process.env.TEMP,
    NODE: os.tmpdir(),
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
})) {
    if (name !== 'TEMP' && name !== 'NODE' && !value) continue;
    assert.ok(value && path.win32.isAbsolute(value));
    assert.equal(
        path.win32
            .normalize(value)
            .replace(/[\\/]+$/u, '')
            .toLowerCase(),
        String.raw`f:\temp`
    );
}
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-native-process-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain synthetic run-owned fixtures; no recursive cleanup or native mcdev invocation.
function fixture(args = ['synthetic-command', 'literal ; & value']) {
    const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'project-')));
    const packageRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'runtime-')));
    fs.mkdirSync(path.join(packageRoot, 'lib'));
    const cliEntry = path.join(packageRoot, 'lib', 'cli.js');
    fs.writeFileSync(
        cliEntry,
        `import fs from 'node:fs';
fs.writeFileSync('observed.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
if (process.argv[2] === 'flood') { process.stderr.write('PRIVATE_OUTPUT'.repeat(100000)); setInterval(() => {}, 1000); }
else if (process.argv[2] === 'hang') { setInterval(() => {}, 1000); }
else { process.stdout.write('PRIVATE_OUTPUT'); process.exitCode = 7; }
`
    );
    fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
            name: 'mcdev',
            version: '10.1.0',
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
    assert.equal(observed.cwd, f.input.projectRoot);
    assert.equal(observed.env.NODE_OPTIONS, undefined);
    assert.equal(observed.env.NO_COLOR, '1');
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
