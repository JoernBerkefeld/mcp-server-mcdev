import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectProjectGitPolicy } from '../dist/project-git-policy.js';

const normalize = (value) =>
    path
        .resolve(value)
        .replace(/[\\/]+$/u, '')
        .toLowerCase();
assert.ok(process.env.TEMP);
for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (value) {
        assert.ok(path.isAbsolute(value));
        assert.equal(normalize(value), normalize('F:/Temp'));
    }
}
const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-git-policy-')));
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain owned fixtures; no recursive cleanup and no synthetic commits.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'project-')));
fs.writeFileSync(path.join(root, '.mcdevrc.json'), '{}');
const oid = 'a'.repeat(40);
const header = `# branch.oid ${oid}\0# branch.head feature/ABC-123\0`;

function mocked(status, refs, action) {
    const original = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
        assert.equal(command, 'git');
        assert.equal(options.shell, false);
        assert.equal(options.timeout, 5000);
        assert.equal(options.maxBuffer, 64 * 1024);
        assert.equal(options.cwd, root);
        assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
        assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(options.env.GIT_DIR, undefined);
        assert.deepEqual(args.slice(0, 2), ['-c', 'core.fsmonitor=false']);
        if (args[2] === 'status') {
            assert.deepEqual(args.slice(2), [
                'status',
                '--porcelain=v2',
                '-z',
                '--branch',
                '--untracked-files=normal',
            ]);
            return typeof status === 'string' ? { status: 0, stdout: status } : status;
        }
        assert.deepEqual(args.slice(2), [
            'for-each-ref',
            '--count=101',
            '--format=%(refname)',
            'refs/heads/',
            'refs/remotes/',
        ]);
        return typeof refs === 'string' ? { status: 0, stdout: refs } : refs;
    };
    syncBuiltinESMExports();
    try {
        return action ? action() : inspectProjectGitPolicy(root);
    } finally {
        childProcess.spawnSync = original;
        syncBuiltinESMExports();
    }
}

const inspect = (status, refs = 'refs/heads/feature/ABC-123\n') => mocked(status, refs);

test('clean branch evidence never infers conventions or BU synchronization', () => {
    const result = inspect(`${header}# branch.upstream origin/main\0# branch.ab +0 -0\0`);
    assert.equal(result.verified, true);
    assert.equal(result.status.dirty, false);
    assert.equal(result.branch.name, 'feature/ABC-123');
    assert.equal(result.tracking.ancestry, 'equal');
    assert.deepEqual(result.findings, []);
    assert.equal(result.policy.verified, false);
    assert.equal(result.policy.branchRoles, null);
    assert.equal(result.policy.ticketConvention, null);
    assert.equal(result.policy.commitPrefix, null);
    assert.equal(result.policy.questions.length, 3);
    assert.equal(result.remoteBuSynchronization, 'unknown');
});

test('dirty and renamed credential paths are never returned', () => {
    const result = inspect(
        `${header}? .mcdev-auth.json\0` +
            `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 public.json\0nested/.mcdev-auth.json\0`
    );
    assert.equal(result.status.dirty, true);
    assert.ok(result.findings.includes('dirty'));
    assert.ok(result.findings.includes('missing-upstream'));
    assert.deepEqual(result.excludedPaths, ['.mcdev-auth.json']);
    assert.equal(JSON.stringify(result).includes('public.json'), false);
    assert.equal(JSON.stringify(result).includes('nested/'), false);
});

test('detached and conflicted metadata are explicit', () => {
    const result = inspect(
        `# branch.oid ${oid}\0# branch.head (detached)\0` +
            `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} private-name\0`
    );
    assert.equal(result.branch.detached, true);
    assert.equal(result.branch.name, null);
    assert.equal(result.status.conflicted, true);
    assert.ok(result.findings.includes('conflicted'));
    assert.ok(result.findings.includes('detached'));
});

test('tracking counts describe local remote-tracking ancestry only', () => {
    for (const [ahead, behind, ancestry] of [
        [0, 2, 'behind'],
        [3, 0, 'ahead'],
        [1, 2, 'diverged'],
    ]) {
        const result = inspect(
            `${header}# branch.upstream origin/main\0# branch.ab +${ahead} -${behind}\0`
        );
        assert.deepEqual(result.tracking, { upstream: 'origin/main', ahead, behind, ancestry });
        assert.equal(result.findings.includes('behind'), behind > 0);
    }
    const result = inspect(`${header}# branch.upstream origin/missing\0`);
    assert.equal(result.tracking.ancestry, 'unknown');
    assert.ok(result.findings.includes('ancestry-unverified'));
});

test('refs are capped at 100 with truncation reported', () => {
    const result = inspect(
        header,
        Array.from({ length: 101 }, (_, index) => `refs/heads/b${index}\n`).join('')
    );
    assert.equal(result.refs.names.length, 100);
    assert.equal(result.refs.truncated, true);
});

test('subprocess failures and malformed output stay unknown and sanitized', () => {
    for (const failure of [
        { status: 128, stdout: '', stderr: 'PRIVATE' },
        { status: null, stdout: '', error: new Error('PRIVATE') },
        { status: 0, stdout: 'PRIVATE\0' },
    ]) {
        const result = inspect(failure, failure);
        assert.equal(result.verified, false);
        assert.equal(result.status.dirty, null);
        assert.equal(result.refs.verified, false);
        assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
    for (const malformed of [
        header.slice(0, -1),
        `${header}2 R. invalid\0`,
        `${header}# branch.ab +1 -2\0`,
    ]) {
        assert.equal(inspect(malformed).verified, false);
    }
});

test('unsafe project roots are rejected before Git runs', () => {
    assert.throws(() => inspectProjectGitPolicy('relative'), { code: 'unsafe-path' });
});

test('real isolated unborn repository reports dirty and missing upstream without commits', () => {
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    );
    const init = childProcess.spawnSync('git', ['init', '--quiet', '--initial-branch=main'], {
        cwd: root,
        env,
        shell: false,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
    });
    assert.equal(init.status, 0);
    for (const [key, value] of [
        ['user.name', 'Jörn Berkefeld'],
        ['user.email', 'joern.berkefeld@gmail.com'],
    ]) {
        const configured = childProcess.spawnSync('git', ['config', '--local', key, value], {
            cwd: root,
            env,
            shell: false,
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 64 * 1024,
        });
        assert.equal(configured.status, 0);
    }
    const result = inspectProjectGitPolicy(root);
    assert.equal(result.verified, true);
    assert.equal(result.branch.unborn, true);
    assert.equal(result.status.dirty, true);
    assert.ok(result.findings.includes('missing-upstream'));
    fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '*\n');
    const clean = inspectProjectGitPolicy(root);
    assert.equal(clean.verified, true);
    assert.equal(clean.status.dirty, false);
});
