import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { syncServerVersions } from '../scripts/sync-server-version.mjs';

const pkg = {
    name: 'mcp-server-mcdev',
    version: '1.1.0',
    mcpName: 'io.github.JoernBerkefeld/mcp-server-mcdev',
};
const server = {
    name: pkg.mcpName,
    version: '1.0.0',
    description: 'Preserve me',
    packages: [
        {
            registryType: 'npm',
            identifier: pkg.name,
            version: '1.0.0',
            transport: { type: 'stdio' },
        },
    ],
    extra: { nested: [1, true] },
};

/**
 * Execute a fixture process without shell expansion.
 * @param command - Executable.
 * @param args - Literal arguments.
 * @param cwd - Owned fixture directory.
 * @returns {object} Captured process result.
 */
function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    return result;
}

/**
 * Execute successful fixture Git commands.
 * @param cwd - Owned fixture directory.
 * @param args - Literal Git arguments.
 * @returns {string} Standard output.
 */
function git(cwd, ...args) {
    const result = run('git', args, cwd);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

/**
 * Create an owned retained OS-temp fixture, never a checkout history target.
 * @param t - Test context.
 * @param malformed - Start with intentionally malformed registry JSON.
 * @returns {string} Fixture repository path.
 */
function fixture(t, malformed = false) {
    const normalize = (value) =>
        path
            .resolve(value)
            .replaceAll(/[/\\]+$/gu, '')
            .toLowerCase();
    if (process.platform === 'win32') {
        for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
            if (value) {
                assert.ok(path.isAbsolute(value));
                assert.equal(normalize(value), String.raw`f:\temp`);
            }
        }
        assert.ok(process.env.TEMP);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-version-'));
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(cwd);
    fs.writeFileSync(
        path.join(root, 'ownership.json'),
        JSON.stringify({ owner: randomUUID(), registered: [cwd] })
    );
    t.diagnostic(`Retained owned fixture ${root}; no cleanup attempted`);
    git(cwd, 'init');
    git(cwd, 'config', '--local', 'user.name', 'Jörn Berkefeld');
    git(cwd, 'config', '--local', 'user.email', 'joern.berkefeld@gmail.com');
    git(cwd, 'config', '--local', 'core.autocrlf', 'false');
    fs.mkdirSync(path.join(cwd, 'scripts'));
    fs.copyFileSync(
        new URL('../scripts/sync-server-version.mjs', import.meta.url),
        path.join(cwd, 'scripts/sync-server-version.mjs')
    );
    fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({
            ...pkg,
            version: '1.0.0',
            scripts: { version: 'node scripts/sync-server-version.mjs && node scripts/record.mjs' },
        })
    );
    fs.writeFileSync(
        path.join(cwd, 'package-lock.json'),
        JSON.stringify({
            name: pkg.name,
            version: '1.0.0',
            lockfileVersion: 3,
            packages: { '': { name: pkg.name, version: '1.0.0' } },
        })
    );
    fs.writeFileSync(path.join(cwd, 'server.json'), malformed ? '{broken' : JSON.stringify(server));
    fs.writeFileSync(
        path.join(cwd, 'scripts/record.mjs'),
        `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
fs.writeFileSync('.git/order.json', JSON.stringify({ staged: execFileSync('git', ['diff','--cached','--name-only'], {encoding:'utf8'}).trim(), versions: [read('package.json').version, read('package-lock.json').version, read('package-lock.json').packages[''].version, read('server.json').version] }));
`
    );
    fs.writeFileSync(
        path.join(cwd, 'scripts/hook.mjs'),
        String.raw`import fs from 'node:fs'; import assert from 'node:assert/strict'; import {execFileSync} from 'node:child_process';
const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
const pkg = read('package.json'), lock = read('package-lock.json'), server = read('server.json');
assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version); assert.equal(server.version, pkg.version); for(const entry of server.packages) assert.equal(entry.version, pkg.version);
fs.writeFileSync('.git/hook.json', JSON.stringify({ version: pkg.version, staged: execFileSync('git', ['diff','--cached','--name-only'], {encoding:'utf8'}).trim().split('\n').sort() }));
`
    );
    git(cwd, 'add', '--', 'package.json', 'package-lock.json', 'server.json', 'scripts');
    git(cwd, 'commit', '-m', 'synthetic baseline');
    fs.writeFileSync(
        path.join(cwd, '.git/hooks/pre-commit'),
        '#!/bin/sh\nnode scripts/hook.mjs\n',
        { mode: 0o755 }
    );
    return cwd;
}

/**
 * Run the installed npm with defaults and normal enabled hooks.
 * @param cwd - Owned synthetic repository.
 * @returns {object} Process result.
 */
function version(cwd) {
    assert.ok(process.env.npm_execpath, 'Run this test through npm');
    return run(
        process.execPath,
        [process.env.npm_execpath, 'version', '1.1.0', '--no-workspaces'],
        cwd
    );
}

test('copies all owning versions, preserves other fields and is idempotent', () => {
    const input = structuredClone(server);
    input.packages.push(structuredClone(input.packages[0]), {
        registryType: 'other',
        identifier: 'unrelated',
        version: '4.2.0',
        nested: { keep: true },
    });
    const before = structuredClone(input);
    const packageBefore = structuredClone(pkg);
    const result = syncServerVersions(pkg, input);
    assert.deepEqual(result, {
        ...before,
        version: pkg.version,
        packages: before.packages.map((entry) =>
            entry.identifier === pkg.name ? { ...entry, version: pkg.version } : entry
        ),
    });
    assert.deepEqual(input, before);
    assert.deepEqual(pkg, packageBefore);
    assert.deepEqual(syncServerVersions(pkg, result), result);
});

test('rejects malformed shape, identity, owner and release semver', () => {
    for (const value of ['', 'v1.0.0', '01.0.0', '1.0', '1.0.0-01', null]) {
        assert.throws(() => syncServerVersions({ ...pkg, version: value }, server));
    }
    for (const value of ['0.0.0', '1.2.3-rc.1+build.4']) {
        assert.equal(syncServerVersions({ ...pkg, version: value }, server).version, value);
    }
    for (const value of [null, [], {}, { ...pkg, name: 'wrong' }, { ...pkg, mcpName: '' }])
        assert.throws(() => syncServerVersions(value, server));
    for (const value of [
        null,
        [],
        {},
        { ...server, name: 'wrong' },
        { ...server, packages: {} },
        { ...server, packages: [] },
        { ...server, packages: [null] },
        ...[{ registryType: 'other' }, { version: null }, { transport: null }].map((extra) => ({
            ...server,
            packages: [{ ...server.packages[0], ...extra }],
        })),
    ])
        assert.throws(() => syncServerVersions(pkg, value));
});

test('normal npm version orders lifecycle, staging, hooks, commit and annotated tag', (t) => {
    const cwd = fixture(t);
    const result = version(cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(cwd, name), 'utf8'));
    assert.deepEqual(read('.git/order.json'), {
        staged: 'server.json',
        versions: Array.from({ length: 4 }, () => '1.1.0'),
    });
    const names = ['package-lock.json', 'package.json', 'server.json'];
    assert.deepEqual(read('.git/hook.json'), { version: '1.1.0', staged: names });
    assert.deepEqual(
        git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'),
        names
    );
    assert.equal(git(cwd, 'cat-file', '-t', 'v1.1.0'), 'tag');
    assert.equal(git(cwd, 'rev-parse', 'v1.1.0^{}'), git(cwd, 'rev-parse', 'HEAD'));
    assert.equal(git(cwd, 'status', '--porcelain'), '');
    assert.deepEqual(read('server.json').extra, server.extra);
    const output = fs.readFileSync(path.join(cwd, 'server.json'));
    assert.equal(output[0], 123);
    assert.equal(output.includes(13), false);
    assert.equal(output.at(-1), 10);
    t.diagnostic(
        'Lifecycle index: server.json only; package and both lock versions already 1.1.0; enabled hook saw all three staged files and equal versions; annotated tag and clean tree confirmed.'
    );
});

test('npm refuses pre-staged metadata before any version writes', (t) => {
    const cwd = fixture(t);
    fs.appendFileSync(path.join(cwd, 'server.json'), '\n');
    git(cwd, 'add', '--', 'server.json');
    const before = git(cwd, 'rev-parse', 'HEAD');
    const result = version(cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /working directory not clean/iu);
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).version,
        '1.0.0'
    );
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), before);
    assert.equal(git(cwd, 'tag'), '');
    assert.equal(fs.existsSync(path.join(cwd, '.git/order.json')), false);
});

test('CLI rejects staged inputs, arguments and deterministic write failure', (t) => {
    const cwd = fixture(t);
    const before = git(cwd, 'rev-parse', 'HEAD');
    let result = run(process.execPath, ['scripts/sync-server-version.mjs', 'unexpected'], cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No arguments/u);
    fs.appendFileSync(path.join(cwd, 'server.json'), '\n');
    git(cwd, 'add', '--', 'server.json');
    result = run(process.execPath, ['scripts/sync-server-version.mjs'], cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Index must be empty/u);
    const separate = fixture(t);
    const preload = path.join(separate, '.git/fail-write.mjs');
    fs.writeFileSync(
        preload,
        "import fs from 'node:fs'; fs.writeFileSync = () => { throw new Error('synthetic write failure'); };\n"
    );
    result = run(
        process.execPath,
        ['--import', pathToFileURL(preload).href, 'scripts/sync-server-version.mjs'],
        separate
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /synthetic write failure/u);
    assert.equal(git(separate, 'status', '--porcelain'), '');
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), before);
    assert.equal(git(cwd, 'tag'), '');
    assert.equal(git(separate, 'tag'), '');
});

test('malformed JSON and staging failure abort npm without rollback or history', (t) => {
    for (const failure of ['parse', 'stage']) {
        const cwd = fixture(t, failure === 'parse');
        if (failure === 'stage')
            fs.writeFileSync(path.join(cwd, '.git/index.lock'), 'owned synthetic staging failure');
        const before = git(cwd, 'rev-parse', 'HEAD');
        const result = version(cwd);
        assert.notEqual(result.status, 0);
        assert.equal(git(cwd, 'rev-parse', 'HEAD'), before);
        assert.equal(git(cwd, 'tag'), '');
        for (const name of [
            'package.json',
            'package-lock.json',
            ...(failure === 'stage' ? ['server.json'] : []),
        ])
            assert.equal(
                JSON.parse(fs.readFileSync(path.join(cwd, name), 'utf8')).version,
                '1.1.0'
            );
        if (failure === 'parse')
            assert.equal(fs.readFileSync(path.join(cwd, 'server.json'), 'utf8'), '{broken');
        assert.equal(fs.existsSync(path.join(cwd, '.git/hook.json')), false);
        assert.equal(fs.existsSync(path.join(cwd, '.git/order.json')), false);
    }
});
