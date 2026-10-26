import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { preflight } from './native-temp-preflight.test.mjs';

// Check placement independently of the bridge and retain every owned fixture.
preflight();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-native-bridge-'));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
const nativeRoot = new URL('../node_modules/mcdev/lib/', import.meta.url);
const installedCLI = fileURLToPath(new URL('cli.js', nativeRoot));
const bridgeURL = new URL('../src/native-cli-bridge.ts', import.meta.url).href;
const runner = path.join(root, 'runner.mjs');
fs.writeFileSync(
    runner,
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
const observed = { events: [], forbidden: [] };
const denied = (label) => (...args) => {
    observed.forbidden.push(label);
    throw new Error('Native account/network/config operation forbidden: ' + label);
};
net.Socket.prototype.connect = denied('network');
globalThis.fetch = denied('fetch');
syncBuiltinESMExports();
process.on('exit', () => fs.writeFileSync('observed.json', JSON.stringify(observed)));
const { default: Mcdev } = await import(${JSON.stringify(new URL('index.js', nativeRoot).href)});
const { Util } = await import(${JSON.stringify(new URL('util/util.js', nativeRoot).href)});
for (const url of ${JSON.stringify(['util/auth.js', 'util/config.js', 'util/sessionStore.js'].map((entry) => new URL(entry, nativeRoot).href))}) {
    const { default: boundary } = await import(url);
    for (const key of Object.keys(boundary)) {
        if (typeof boundary[key] === 'function') boundary[key] = denied(url + ':' + key);
    }
}
// Keep the real singleton, real setOptions and real metadata conversion untouched.
const originalSetOptions = Mcdev.setOptions;
const originalMetadataParser = Mcdev.metadataToTypeKey;
Mcdev.deploy = (...args) => {
    assert.equal(Mcdev.setOptions, originalSetOptions);
    assert.equal(Mcdev.metadataToTypeKey, originalMetadataParser);
    observed.events.push({
        args,
        options: structuredClone(Util.OPTIONS),
        skipInteraction: Util.skipInteraction,
        argv: [...process.argv],
        cwd: process.cwd(),
    });
};
// Transform only the production bridge in memory; never build or use stale dist output.
registerHooks({
    load(url, context, nextLoad) {
        if (url !== ${JSON.stringify(bridgeURL)}) return nextLoad(url, context);
        return {
            format: 'module',
            source: stripTypeScriptTypes(fs.readFileSync(new URL(url), 'utf8')),
            shortCircuit: true,
        };
    },
});
const { runNativeCliBridge } = await import(${JSON.stringify(bridgeURL)});
await runNativeCliBridge(${JSON.stringify(installedCLI)}, 'ChildA,ChildB', JSON.parse(process.env.BRIDGE_ARGS));
`
);

function run(args) {
    preflight();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-native-bridge-case-'));
    fs.writeFileSync(path.join(cwd, '.owner'), randomUUID());
    const env = {};
    for (const name of [
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'PATH',
        'PATHEXT',
        'TEMP',
        'TMP',
        'TMPDIR',
    ]) {
        if (process.env[name]) env[name] = process.env[name];
    }
    Object.assign(env, {
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        LOCALAPPDATA: cwd,
        NO_COLOR: '1',
        BRIDGE_ARGS: JSON.stringify(args),
    });
    const result = spawnSync(process.execPath, [runner], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 20000,
        shell: false,
        maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(fs.readFileSync(path.join(cwd, 'observed.json'), 'utf8'));
    assert.deepEqual(observed.forbidden, [], 'no account, authentication, config or network calls');
    assert.equal(observed.events.length, 1, JSON.stringify(observed));
    const [event] = observed.events;
    assert.deepEqual(event.argv, [process.execPath, installedCLI, ...args]);
    assert.equal(event.cwd, cwd);
    assert.equal(event.options.publish, true);
    assert.equal(event.options.noLogFile, true);
    assert.equal(event.skipInteraction, true);
    return event;
}

const positional = ['deploy', 'cred/BU', 'dataExtension', 'key', '--publish', '--noLogFile'];

test('bridge seeds the installed singleton without CLI defaults erasing API-only choices', () => {
    assert.ok(!positional.includes('--fixShared'));
    assert.ok(!positional.includes('--skipInteraction'));
    assert.ok(!positional.includes('--yes'));
    const event = run(positional);
    assert.deepEqual(event.args, ['cred/BU', ['dataExtension'], ['key']]);
    assert.equal(event.options.fixShared, 'ChildA,ChildB');
});

test('bridge preserves native --yes alias and positional CSV parsing', () => {
    const event = run([
        'deploy',
        'cred/BU',
        'dataExtension, query',
        'key, 日本:part',
        '--publish',
        '--noLogFile',
        '--yes',
    ]);
    assert.deepEqual(event.args, ['cred/BU', ['dataExtension', 'query'], ['key', '日本:part']]);
    assert.equal(event.options.fixShared, 'ChildA,ChildB');
});

test('bridge leaves native metadata conversion and explicit --no-fixShared tokens intact', () => {
    const event = run([
        ...positional,
        '--metadata',
        'dataExtension:k:日本:part',
        '--metadata',
        'query:i:007',
        '--no-fixShared',
    ]);
    assert.deepEqual(event.args, ['cred/BU', { dataExtension: ['日本:part'], query: ['id:007'] }]);
    assert.equal(event.options.fixShared, false);
});
