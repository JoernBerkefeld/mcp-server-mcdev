import assert from 'node:assert/strict';
import { validateTempEnvironment, createNativeEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runQueryRetrieveProcess } from '../dist/query-retrieve-process.js';
import { QUERY_RETRIEVE_CONTRACT } from '../dist/query-retrieve-contract.js';

validateTempEnvironment();
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-query-process-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain run-owned fixtures. No recursive cleanup or native mcdev invocation.
const stub = `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const key = process.argv[5];
fs.writeFileSync('observed.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
if (key === 'failure') { process.stdout.write('SECRET_AUTH_PARSER'); process.stderr.write('SECRET_ACCOUNT_MISMATCH'); process.exitCode = 7; }
else if (key === 'hang') { setInterval(() => {}, 1000); }
else if (key === 'stderr') { process.stderr.write('SECRET_STDERR'.repeat(150000)); setInterval(() => {}, 1000); }
else if (key === 'flood') { process.stdout.write('SECRET_AUTH_PARSER'.repeat(100000)); process.stderr.write('SECRET_ACCOUNT_MISMATCH'.repeat(100000)); setInterval(() => {}, 1000); }
else if (key === 'descendant') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1800)'], { stdio: 'ignore' });
    fs.writeFileSync('descendant.json', JSON.stringify({ pid: child.pid }));
    setInterval(() => {}, 1000);
}
else if (key === 'eof') { process.stdin.on('end', () => { fs.writeFileSync('eof', 'yes'); }); process.stdin.resume(); }
`;
function fixture(key = 'sample key') {
    const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'project-')));
    const packageRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'runtime-')));
    fs.mkdirSync(path.join(packageRoot, 'lib'));
    const cliEntry = path.join(packageRoot, 'lib', 'cli.js');
    fs.writeFileSync(cliEntry, stub);
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
        input: { projectRoot, credential: 'demo alias', businessUnit: 'QA BU', key },
        runtime: { cliEntry },
        controller: new AbortController(),
    };
}
const run = (f, timeoutMs = 3000) =>
    runQueryRetrieveProcess(f.input, { signal: f.controller.signal, timeoutMs }, f.runtime);
const observed = (f) =>
    JSON.parse(fs.readFileSync(path.join(f.input.projectRoot, 'observed.json'), 'utf8'));
async function waitForFile(filename) {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(filename)) {
        assert.ok(Date.now() < deadline, 'stub did not become ready');
        await delay(10);
    }
}
function safe(result) {
    assert.ok(Object.isFrozen(result));
    assert.equal(result.retrievalVerified, false);
    assert.equal(result.descendantsStopped, false);
    assert.doesNotMatch(
        JSON.stringify(result),
        /SECRET|observed|Error|argv|stdoutText|stderrText/u
    );
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
            'retrievalVerified',
            'partialEffectsPossible',
        ].toSorted()
    );
}

test('stub gets exactly fixed argv, canonical cwd, no shell and closed stdin', async () => {
    const f = fixture('eof');
    const result = await run(f);
    safe(result);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.started, true);
    assert.equal(result.directChildClosed, true);
    assert.equal(result.partialEffectsPossible, true);
    assert.equal(fs.readFileSync(path.join(f.input.projectRoot, 'eof'), 'utf8'), 'yes');
    assert.deepEqual(observed(f).argv, [
        'retrieve',
        'demo alias/QA BU',
        'query',
        'eof',
        '--no-purge',
        '--no-format',
        '--skipInteraction',
        '--noLogFile',
        '--noLogColors',
    ]);
    assert.equal(observed(f).cwd, f.input.projectRoot);
});

test('closed internal type selects fixed Script argv and preserves explicit Query defaults', async () => {
    for (const metadataType of ['script', 'query']) {
        const f = fixture('eof');
        f.input.metadataType = metadataType;
        const original = childProcess.spawn;
        try {
            childProcess.spawn = (command, argv, options) => {
                assert.equal(command, process.execPath);
                assert.equal(options.shell, false);
                assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
                assert.equal(options.cwd, f.input.projectRoot);
                assert.equal(options.env.NODE_OPTIONS, undefined);
                return original(command, argv, options);
            };
            syncBuiltinESMExports();
            const result = await run(f);
            safe(result);
            assert.equal(result.exitCode, 0);
            assert.deepEqual(observed(f).argv, [
                'retrieve',
                'demo alias/QA BU',
                metadataType,
                'eof',
                '--no-purge',
                '--no-format',
                '--skipInteraction',
                '--noLogFile',
                '--noLogColors',
            ]);
        } finally {
            childProcess.spawn = original;
            syncBuiltinESMExports();
        }
    }
    for (const metadataType of [null, '', 'asset', 'script,query', '--help', false, {}]) {
        const f = fixture();
        f.input.metadataType = metadataType;
        assert.equal((await run(f)).outcome, 'invalid-input');
        assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
    }
});

test('Script uses the same environment, timeout, cancellation and output bounds', async () => {
    for (const [key, expected] of [
        ['hang', 'timed-out'],
        ['flood', 'output-limit'],
    ]) {
        const f = fixture(key);
        f.input.metadataType = 'script';
        const result = await run(f, key === 'hang' ? 250 : 3000);
        safe(result);
        assert.equal(result.outcome, 'termination-unconfirmed');
        assert.equal(result.stopReason, expected);
    }
    const f = fixture('hang');
    f.input.metadataType = 'script';
    const pending = run(f);
    await waitForFile(path.join(f.input.projectRoot, 'observed.json'));
    f.controller.abort('SECRET_CANCEL');
    const result = await pending;
    safe(result);
    assert.equal(result.stopReason, 'cancelled');
});

test('Script rejects unsafe environment and selector before starting a process', async () => {
    const f = fixture();
    f.input.metadataType = 'script';
    assert.throws(
        () => createNativeEnvironment({ ...process.env, TMPDIR: 'relative-not-temp' }),
        /Invalid temporary environment/u
    );
    assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
    f.input.key = '../outside';
    assert.equal((await run(f)).outcome, 'invalid-input');
    assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
});

test('explicit environment excludes case-insensitive injection and arbitrary secrets', async () => {
    const names = [
        'NODE_OPTIONS',
        'NODE_PATH',
        'SECRET_TEST_TOKEN',
        'HTTP_PROXY',
        'npm_config_userconfig',
    ];
    const old = names.map((name) => process.env[name]);
    try {
        for (const name of names) process.env[name] = 'SECRET_ENV';
        const f = fixture();
        assert.equal((await run(f)).exitCode, 0);
        const env = observed(f).env;
        for (const name of Object.keys(env))
            assert.ok(!names.some((blocked) => blocked.toLowerCase() === name.toLowerCase()));
        assert.equal(env.NO_COLOR, '1');
        for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
            assert.equal(env[name], process.env[name]);
        }
    } finally {
        for (const [index, name] of names.entries()) {
            if (old[index] === undefined) delete process.env[name];
            else process.env[name] = old[index];
        }
    }
});

test('nonzero exit and secret stdout/stderr never become retrieval success or text', async () => {
    const result = await run(fixture('failure'));
    safe(result);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 7);
    assert.ok(result.stdoutBytes > 0);
    assert.ok(result.stderrBytes > 0);
});

test('strict selectors reject injection, CSV, traversal and option-like input without spawning', async () => {
    for (const field of ['credential', 'businessUnit', 'key']) {
        for (const value of [
            '',
            ' leading',
            'trailing ',
            'a,b',
            '*',
            'a/b',
            String.raw`a\b`,
            '..',
            'a..b',
            '--help',
            'a;whoami',
            'a\nother',
            'a.',
            'a:stream',
            'a|x',
            'a%',
        ]) {
            const f = fixture();
            f.input[field] = value;
            const result = await run(f);
            assert.equal(result.outcome, 'invalid-input');
            assert.equal(result.started, false);
            assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
        }
    }
});

test('invalid lifetime, relative cwd and unsupported package identity fail closed', async () => {
    for (const timeout of [0, -1, 1.2, 120001, Number.NaN]) {
        assert.equal((await run(fixture(), timeout)).outcome, 'invalid-input');
    }
    for (const projectRoot of [
        'relative',
        'F:relative',
        String.raw`\\server\share`,
        String.raw`C:\scratch\..\scratch`,
    ]) {
        const f = fixture();
        f.input.projectRoot = projectRoot;
        assert.equal((await run(f)).outcome, 'invalid-input');
    }
    for (const patch of [
        { name: 'other' },
        { version: '10.1.1' },
        { bin: { mcdev: 'other.js' } },
    ]) {
        const f = fixture();
        const manifest = path.join(path.dirname(path.dirname(f.runtime.cliEntry)), 'package.json');
        fs.writeFileSync(
            manifest,
            JSON.stringify({
                name: 'mcdev',
                version: '10.1.0',
                bin: { mcdev: 'lib/cli.js' },
                ...patch,
            })
        );
        assert.equal((await run(f)).outcome, 'invalid-input');
    }
    const f = fixture();
    f.runtime.cliEntry = path.join(f.input.projectRoot, 'missing.js');
    assert.equal((await run(f)).outcome, 'invalid-input');
});

test('linked cwd, CLI and manifest are rejected without following contents', async () => {
    for (const target of ['cwd', 'cli', 'manifest']) {
        const f = fixture();
        if (target === 'cwd') {
            const link = path.join(runRoot, `junction-${randomUUID()}`);
            fs.symlinkSync(f.input.projectRoot, link, 'junction');
            f.input.projectRoot = link;
        } else {
            const original =
                target === 'cli'
                    ? f.runtime.cliEntry
                    : path.join(path.dirname(path.dirname(f.runtime.cliEntry)), 'package.json');
            const saved = `${original}.saved`;
            fs.renameSync(original, saved);
            fs.linkSync(saved, original);
        }
        assert.equal((await run(f)).outcome, 'invalid-input');
    }
});

test('pre-aborted request never starts child', async () => {
    const f = fixture();
    f.controller.abort();
    const result = await run(f);
    safe(result);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(result.started, false);
});

test('adapter retains invalid selector precedence over pre-aborted cancellation', async () => {
    const f = fixture('../outside');
    f.controller.abort();
    const result = await run(f);
    safe(result);
    assert.equal(result.outcome, 'invalid-input');
    assert.equal(result.stopReason, null);
    assert.equal(result.partialEffectsPossible, false);
    assert.equal(fs.existsSync(path.join(f.input.projectRoot, 'observed.json')), false);
});

test('cancellation is terminal with conservative descendant status', async () => {
    const f = fixture('hang');
    const promise = run(f);
    await waitForFile(path.join(f.input.projectRoot, 'observed.json'));
    f.controller.abort('SECRET_CANCEL');
    const result = await promise;
    safe(result);
    assert.equal(result.outcome, 'termination-unconfirmed');
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(result.directChildClosed, true);
    await delay(25);
    assert.equal(result.stopReason, 'cancelled');
});

test('timeout remains bounded and never proves descendant termination', async () => {
    const start = Date.now();
    const result = await run(fixture('hang'), 250);
    safe(result);
    assert.equal(result.outcome, 'termination-unconfirmed');
    assert.equal(result.stopReason, 'timed-out');
    assert.ok(Date.now() - start < 4000);
});

test('combined output flood is suppressed, counted with saturation, and terminal', async () => {
    const result = await run(fixture('flood'));
    safe(result);
    assert.equal(result.outcome, 'termination-unconfirmed');
    assert.equal(result.stopReason, 'output-limit');
    assert.ok(result.stdoutBytes + result.stderrBytes > 1024 * 1024);
    assert.ok(result.stdoutBytes <= 1024 * 1024 + 1);
    assert.ok(result.stderrBytes <= 1024 * 1024 + 1);
});

test('stderr-only overflow is bounded without exposing content', async () => {
    const result = await run(fixture('stderr'));
    safe(result);
    assert.equal(result.outcome, 'termination-unconfirmed');
    assert.equal(result.stopReason, 'output-limit');
    assert.equal(result.stdoutBytes, 0);
    assert.ok(result.stderrBytes > 1024 * 1024);
});

test('redirected SYSTEMROOT cannot select or execute a termination helper', async () => {
    const original = childProcess.spawn;
    const previousRoot = process.env.SYSTEMROOT;
    const redirectedRoot = fs.realpathSync.native(
        fs.mkdtempSync(path.join(runRoot, 'fake-system-'))
    );
    fs.mkdirSync(path.join(redirectedRoot, 'System32'));
    const fakeHelper = path.join(redirectedRoot, 'System32', 'taskkill.exe');
    // A real regular executable at the redirected path must still never be selected.
    fs.copyFileSync(process.execPath, fakeHelper);
    const calls = [];
    try {
        process.env.SYSTEMROOT = redirectedRoot;
        childProcess.spawn = (command, args, options) => {
            calls.push(command);
            assert.equal(command, process.execPath, 'only the selected Node runtime may launch');
            assert.equal(options.env.SYSTEMROOT, redirectedRoot);
            // Windows may need its real system root to initialize Node itself. Restore only
            // the actual stub child environment after observing the launcher's redirected value.
            return original(command, args, {
                ...options,
                env: { ...options.env, SYSTEMROOT: previousRoot },
            });
        };
        syncBuiltinESMExports();
        const f = fixture('hang');
        const promise = run(f);
        await waitForFile(path.join(f.input.projectRoot, 'observed.json'));
        f.controller.abort();
        const result = await promise;
        safe(result);
        assert.equal(result.outcome, 'termination-unconfirmed');
        assert.equal(result.stopReason, 'cancelled');
        assert.equal(result.directChildClosed, true);
        assert.deepEqual(calls, [process.execPath]);
    } finally {
        if (previousRoot === undefined) delete process.env.SYSTEMROOT;
        else process.env.SYSTEMROOT = previousRoot;
        childProcess.spawn = original;
        syncBuiltinESMExports();
    }
});

test('descendant fixture cannot turn direct close into full-tree proof', async () => {
    const f = fixture('descendant');
    const promise = run(f);
    await waitForFile(path.join(f.input.projectRoot, 'descendant.json'));
    f.controller.abort();
    const result = await promise;
    safe(result);
    assert.equal(result.outcome, 'termination-unconfirmed');
    assert.equal(result.stopReason, 'cancelled');
    // Stub descendant self-expires after direct-child termination. No external discovery/cleanup.
    await delay(1900);
});

test('synchronous and asynchronous spawn failures expose no raw exception', async () => {
    const original = childProcess.spawn;
    try {
        childProcess.spawn = () => {
            throw new Error('SECRET_SPAWN_ERROR');
        };
        syncBuiltinESMExports();
        const result = await run(fixture());
        safe(result);
        assert.equal(result.outcome, 'spawn-failed');
        assert.equal(result.started, false);
        childProcess.spawn = (command, args, options) =>
            original(command, args, { ...options, cwd: path.join(runRoot, 'nonexistent') });
        syncBuiltinESMExports();
        const asynchronous = await run(fixture());
        safe(asynchronous);
        assert.equal(asynchronous.outcome, 'spawn-failed');
    } finally {
        childProcess.spawn = original;
        syncBuiltinESMExports();
    }
});

test('production contract and registration remain blocked and unchanged', () => {
    assert.equal(QUERY_RETRIEVE_CONTRACT.executionEnabled, false);
    const registration = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.ok(!registration.includes('query-retrieve-process'));
});
