import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { validateTempEnvironment } from '../dist/temp-environment.js';

validateTempEnvironment();
if (process.platform === 'win32') {
    for (const [name, value] of Object.entries({
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
        node: os.tmpdir(),
    })) {
        if (name === 'TEMP' || name === 'node' || value) {
            assert.ok(value && path.isAbsolute(value), `${name} must be absolute`);
            assert.equal(
                path
                    .resolve(value)
                    .replace(/[\\/]+$/u, '')
                    .toLowerCase(),
                String.raw`f:\temp`
            );
        }
    }
}

// Real clocks and real SDK stdio transport: deliberately exceeds the SDK's default minute.
test(
    'native stdio survives 65 seconds and reconciles actual SDK cancellation',
    { timeout: 100_000 },
    async (t) => {
        assert.equal(DEFAULT_REQUEST_TIMEOUT_MSEC, 60_000);
        const root = fs.realpathSync.native(
            fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-long-stdio-'))
        );
        fs.writeFileSync(path.join(root, '.owner'), randomUUID());
        // Run-owned fixtures are retained with their ownership marker; no recursive cleanup.
        fs.writeFileSync(
            path.join(root, '.mcdevrc.json'),
            JSON.stringify({ credentials: { fixture: { businessUnits: { BU: '101' } } } })
        );
        const runtime = path.join(root, 'runtime');
        fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true });
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
            String.raw`import fs from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.argv.at(-1);
if (mode === 'long') {
    const started = Date.now();
    const timer = setInterval(() => process.stdout.write('x'.repeat(32768) + '\n'), 1000);
    setTimeout(() => {
        clearInterval(timer);
        fs.writeFileSync('long-completed.json', JSON.stringify({ elapsedMs: Date.now() - started, argv: process.argv.slice(2) }));
        process.stdout.write('\nmcdev:: Retrieve\n');
    }, 65_000);
} else if (mode === 'cancel') {
    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', "const fs = require('node:fs'); fs.writeFileSync('cancel-ready', String(process.pid)); setTimeout(() => fs.writeFileSync('descendant-completed', 'done'), 2000)"], { detached: true, stdio: 'ignore' });
    child.unref();
    setInterval(() => process.stdout.write('still running\n'), 100);
} else { process.stdout.write('mcdev:: Retrieve\n'); }
`
        );
        const client = new Client({ name: 'native-long-stdio-test', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [
                fileURLToPath(new URL('fixtures/native-long-stdio-server.mjs', import.meta.url)),
                root,
                cliEntry,
            ],
            stderr: 'pipe',
        });
        let stderr = '';
        transport.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        const call = async (name, args = {}, options) => {
            const response = await client.callTool({ name, arguments: args }, undefined, options);
            assert.notEqual(response.isError, true, JSON.stringify(response));
            return JSON.parse(response.content[0].text);
        };
        const waitFor = async (predicate) => {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
                const status = await call('status');
                if (predicate(status)) return status;
                await delay(50);
            }
            assert.fail(`Fixture did not settle: ${stderr}`);
        };
        try {
            await client.connect(transport);
            const progress = [];
            const started = Date.now();
            const running = call(
                'run',
                { mode: 'long' },
                {
                    timeout: 90_000,
                    maxTotalTimeout: 95_000,
                    resetTimeoutOnProgress: true,
                    onprogress: (event) => {
                        progress.push(event.progress);
                    },
                }
            );
            await waitFor(() => fs.existsSync(path.join(root, 'runtime')) && progress.length > 0);
            const busy = await call('run', { mode: 'quick' });
            assert.equal(busy.outcome, 'project-busy');
            assert.equal(busy.reconciliationRequired, false);
            assert.deepEqual(await call('reconcile', { operatorReconciled: true }), {
                released: false,
            });
            const result = await running;
            const elapsedMs = Date.now() - started;
            assert.ok(
                elapsedMs >= 65_000,
                `Elapsed ${elapsedMs}ms must cross real timeout boundary`
            );
            assert.ok(progress.length >= 12, JSON.stringify(progress));
            assert.ok(
                progress.some((seconds) => seconds >= 60),
                JSON.stringify(progress)
            );
            assert.ok(progress.every((value, index) => index === 0 || value > progress[index - 1]));
            assert.equal(result.outcome, 'exited');
            assert.equal(result.runtimeVersion, 'synthetic-test-runtime');
            assert.equal(result.process.started, true);
            assert.equal(result.process.directChildClosed, true);
            assert.equal(result.process.exitCode, 0);
            assert.equal(result.process.stopReason, null);
            assert.ok(result.process.stdoutBytes > 1024 * 1024);
            assert.equal(result.process.descendantsStopped, false);
            assert.equal(result.reconciliationRequired, false);
            assert.equal(result.remoteCompletenessVerified, false);
            const completed = JSON.parse(
                fs.readFileSync(path.join(root, 'long-completed.json'), 'utf8')
            );
            assert.ok(completed.elapsedMs >= 65_000);
            assert.deepEqual(completed.argv, ['retrieve', 'fixture/BU', 'query', 'long']);
            assert.equal((await call('run', { mode: 'quick' })).outcome, 'exited');

            const controller = new AbortController();
            const cancelled = call(
                'run',
                { mode: 'cancel' },
                { signal: controller.signal, timeout: 15_000 }
            );
            // Attach rejection observation before signalling; the SDK drops the eventual server response.
            const rejection = assert.rejects(cancelled, /cancel native fixture/u);
            await waitFor((status) => status.ready);
            controller.abort(new Error('cancel native fixture'));
            await rejection;
            const status = await waitFor((value) => value.signalObserved && value.settled);
            assert.ok(['cancelled', 'termination-unconfirmed'].includes(status.settled.outcome));
            assert.equal(status.settled.process.stopReason, 'cancelled');
            assert.equal(status.settled.process.started, true);
            assert.equal(status.settled.process.descendantsStopped, false);
            assert.equal(status.settled.process.partialEffectsPossible, true);
            assert.equal(status.settled.reconciliationRequired, true);
            assert.deepEqual(await call('run', { mode: 'quick' }), {
                outcome: 'project-busy',
                reconciliationRequired: true,
                message:
                    'Another operation is running or termination requires operator reconciliation.',
            });
            assert.deepEqual(await call('reconcile', { operatorReconciled: false }), {
                released: false,
            });
            // The synthetic descendant self-settles; reconciliation is not claimed to have killed it.
            await waitFor((value) => value.descendantCompleted);
            assert.deepEqual(await call('reconcile', { operatorReconciled: true }), {
                released: true,
            });
            assert.deepEqual(await call('reconcile', { operatorReconciled: true }), {
                released: false,
            });
            assert.equal((await call('run', { mode: 'quick' })).outcome, 'exited');
            t.diagnostic(
                `SDK default=${DEFAULT_REQUEST_TIMEOUT_MSEC}ms; configured=90000ms resetTimeoutOnProgress=true; native elapsed=${completed.elapsedMs}ms; request elapsed=${elapsedMs}ms; progress=${JSON.stringify(progress)}; stdoutBytes=${result.process.stdoutBytes}; SDK cancellation observed; descendants unconfirmed latch and reconciliation verified; retained=${root}`
            );
        } finally {
            await client.close();
        }
    }
);
