import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runQueryDefinitionRenderProcess } from '../dist/query-definition-render-process.js';

validateTempEnvironment();
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-render-process-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain synthetic run-owned fixtures; no recursive cleanup or native mcdev invocation.
function fixture(templateName = 'sample template') {
    const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'project-')));
    const packageRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'runtime-')));
    fs.mkdirSync(path.join(packageRoot, 'lib'));
    const cliEntry = path.join(packageRoot, 'lib', 'cli.js');
    fs.writeFileSync(
        cliEntry,
        `import fs from 'node:fs';
const template = process.argv[5];
fs.writeFileSync('observed.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (template === 'hang') { setInterval(() => {}, 1000); }
else if (template === 'flood') { process.stderr.write('PRIVATE_RENDER_OUTPUT'.repeat(100000)); setInterval(() => {}, 1000); }
else { process.stdout.write('PRIVATE_RENDER_OUTPUT'); process.stderr.write('PRIVATE_RENDER_ERROR'); process.exitCode = template === 'failure' ? 7 : 0; }
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
        input: {
            projectRoot,
            credential: 'demo alias',
            businessUnit: 'QA BU',
            templateName,
            market: 'test market',
        },
        runtime: { cliEntry },
        controller: new AbortController(),
    };
}
const run = (f, timeoutMs = 3000) =>
    runQueryDefinitionRenderProcess(f.input, { signal: f.controller.signal, timeoutMs }, f.runtime);
function safe(result) {
    assert.ok(Object.isFrozen(result));
    assert.equal(result.descendantsStopped, false);
    assert.equal(result.partialEffectsPossible, result.started);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Error|argv|observed/u);
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

test('render passes only exact fixed strict-CLI argv and never purge, formatting or overrides', async () => {
    const f = fixture();
    Object.assign(f.input, {
        args: ['deploy', '--purge', '--metadata', 'script'],
        env: { NODE_OPTIONS: '--invalid-render-injection' },
        outputKey: 'different output key',
    });
    const original = childProcess.spawn;
    try {
        childProcess.spawn = (command, argv, options) => {
            assert.equal(command, process.execPath);
            assert.equal(argv[0], f.runtime.cliEntry);
            assert.equal(options.shell, false);
            assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
            assert.equal(options.env.NODE_OPTIONS, undefined);
            assert.equal(options.cwd, f.input.projectRoot);
            return original(command, argv, options);
        };
        syncBuiltinESMExports();
        const result = await run(f);
        safe(result);
        assert.equal(result.outcome, 'exited');
        assert.equal(result.exitCode, 0);
        assert.equal(result.directChildClosed, true);
        const observed = JSON.parse(
            fs.readFileSync(path.join(f.input.projectRoot, 'observed.json'), 'utf8')
        );
        assert.deepEqual(observed.argv, [
            'buildDefinition',
            'demo alias/QA BU',
            'query',
            'sample template',
            'test market',
            '--no-purge',
            '--skipInteraction',
            '--noLogFile',
            '--noLogColors',
        ]);
        assert.equal(observed.cwd, f.input.projectRoot);
        assert.ok(result.stdoutBytes > 0);
        assert.ok(result.stderrBytes > 0);
    } finally {
        childProcess.spawn = original;
        syncBuiltinESMExports();
    }
});

test('render rejects invalid exact selectors before spawning, including preaborted requests', async () => {
    const f = fixture();
    const original = childProcess.spawn;
    let calls = 0;
    try {
        childProcess.spawn = () => {
            calls++;
            throw new Error('PRIVATE unexpected launch');
        };
        syncBuiltinESMExports();
        f.controller.abort('PRIVATE abort');
        for (const field of ['credential', 'businessUnit', 'templateName', 'market']) {
            const valid = f.input[field];
            for (const value of [
                null,
                undefined,
                4,
                {},
                [],
                ['one', 'two'],
                '',
                'one,two',
                '__clone__',
                '--purge',
                '--metadata=query',
                '../escape',
                'a/b',
                String.raw`a\b`,
                'a..b',
                ' leading',
                'trailing ',
                'trailing.',
                'a;whoami',
                'a\nb',
                'a\0b',
                '*',
            ]) {
                f.input[field] = value;
                const result = await run(f);
                safe(result);
                assert.equal(result.outcome, 'invalid-input', `${field}: ${String(value)}`);
                assert.equal(result.started, false);
            }
            f.input[field] = valid;
        }
        assert.equal(calls, 0);
        assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
    } finally {
        childProcess.spawn = original;
        syncBuiltinESMExports();
    }
});

test('render retains prelaunch cancellation and transport input validation', async () => {
    const f = fixture();
    f.controller.abort('PRIVATE abort');
    const result = await run(f);
    safe(result);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(result.started, false);
    assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
    assert.equal((await run(f, 0)).outcome, 'invalid-input');
    const invalid = fixture();
    invalid.input.projectRoot = 'relative';
    assert.equal((await run(invalid)).outcome, 'invalid-input');
});

test('render preserves native failure and throwing-spawn evidence without output claims', async () => {
    const result = await run(fixture('failure'));
    safe(result);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 7);
    assert.equal(result.partialEffectsPossible, true);
    const original = childProcess.spawn;
    try {
        childProcess.spawn = () => {
            throw new Error('PRIVATE launcher error');
        };
        syncBuiltinESMExports();
        const failed = await run(fixture());
        safe(failed);
        assert.equal(failed.outcome, 'spawn-failed');
        assert.equal(failed.started, false);
    } finally {
        childProcess.spawn = original;
        syncBuiltinESMExports();
    }
});

test('render forwards lifetime cancellation, timeout and output overflow conservatively', async () => {
    for (const reason of ['cancelled', 'timed-out', 'output-limit']) {
        const f = fixture(reason === 'output-limit' ? 'flood' : 'hang');
        const pending = run(f, reason === 'timed-out' ? 250 : 5000);
        if (reason === 'cancelled') {
            const deadline = Date.now() + 3000;
            while (!fs.existsSync(path.join(f.input.projectRoot, 'observed.json'))) {
                assert.ok(Date.now() < deadline, 'synthetic CLI did not start');
                await delay(10);
            }
            f.controller.abort('PRIVATE abort');
        }
        const result = await pending;
        safe(result);
        assert.equal(result.outcome, 'termination-unconfirmed');
        assert.equal(result.stopReason, reason);
        assert.equal(result.started, true);
        if (reason === 'output-limit') assert.equal(result.stderrBytes, 1024 * 1024 + 1);
    }
});
