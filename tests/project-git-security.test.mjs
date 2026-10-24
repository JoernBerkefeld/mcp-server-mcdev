import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectProjectGitSecurity } from '../dist/project-git-security.js';

validateTempEnvironment();
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-git-security-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain synthetic fixtures. No auth contents or history and no recursive cleanup.
const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
);
gitEnv.GIT_CONFIG_NOSYSTEM = '1';
gitEnv.GIT_CONFIG_GLOBAL = path.join(runRoot, 'empty-global-config');
fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');

function git(root, args, input) {
    const result = childProcess.spawnSync('git', args, {
        cwd: root,
        env: gitEnv,
        shell: false,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
        input,
    });
    assert.equal(result.status, 0, 'synthetic Git operation must succeed');
    return result.stdout.trim();
}

function fixture({ nested = false, rule } = {}) {
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'repo-')));
    git(repo, ['init', '--quiet']);
    git(repo, ['config', 'core.excludesFile', path.join(runRoot, 'empty-excludes')]);
    fs.writeFileSync(path.join(runRoot, 'empty-excludes'), '');
    const root = nested ? path.join(repo, 'nested') : repo;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.mcdevrc.json'), '{}');
    if (rule !== undefined) fs.writeFileSync(path.join(root, '.gitignore'), rule);
    return { repo, root };
}

function finding(result, code) {
    return result.findings.some((item) => item.code === code && item.severity === 'critical');
}

function withSpawn(replacement, action) {
    const original = childProcess.spawnSync;
    childProcess.spawnSync = (...args) => replacement(original, ...args);
    syncBuiltinESMExports();
    try {
        return action();
    } finally {
        childProcess.spawnSync = original;
        syncBuiltinESMExports();
    }
}

test('effective project rule protects nonexistent auth and yields bounded metadata-only commands', () => {
    const { root } = fixture({ rule: '.mcdev-auth.json\n' });
    const commands = [];
    const result = withSpawn(
        (original, command, args, options) => {
            commands.push(args);
            assert.equal(command, 'git');
            assert.equal(options.shell, false);
            assert.equal(options.timeout, 5000);
            assert.equal(options.maxBuffer, 64 * 1024);
            return original(command, args, options);
        },
        () => inspectProjectGitSecurity(root)
    );
    assert.equal(result.status, 'protected');
    assert.deepEqual(result.findings, []);
    assert.equal(result.ignore.source, 'project');
    assert.equal(result.ignore.portableProjectProtection, true);
    assert.equal(result.tracking.tracked, false);
    assert.equal(fs.existsSync(path.join(root, '.mcdev-auth.json')), false);
    assert.deepEqual(commands, [
        ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
        ['-c', 'core.fsmonitor=false', 'check-ignore', '--no-index', '--verbose', '-z', '--stdin'],
        [
            '-c',
            'core.fsmonitor=false',
            'ls-files',
            '--stage',
            '-z',
            '--',
            ':(literal).mcdev-auth.json',
        ],
    ]);
});

test('missing ignore policy is critical rather than safe', () => {
    const result = inspectProjectGitSecurity(fixture().root);
    assert.equal(result.status, 'critical');
    assert.equal(result.ignore.source, 'none');
    assert.equal(result.ignore.ignored, false);
    assert.ok(finding(result, 'missing-project-protection'));
});

test('last project negation defeats earlier positive protection', () => {
    const result = inspectProjectGitSecurity(
        fixture({ rule: '.mcdev-auth.json\n!.mcdev-auth.json\n' }).root
    );
    assert.equal(result.ignore.source, 'project');
    assert.equal(result.ignore.negated, true);
    assert.equal(result.ignore.line, 2);
    assert.equal(result.ignore.ignored, false);
    assert.ok(finding(result, 'missing-project-protection'));
});

test('later positive rule overrides an earlier negation', () => {
    const result = inspectProjectGitSecurity(
        fixture({ rule: '!.mcdev-auth.json\n/.mcdev-auth.json\n' }).root
    );
    assert.equal(result.status, 'protected');
    assert.equal(result.ignore.line, 2);
});

test('global excludes alone are not portable project protection', () => {
    const { root } = fixture();
    const excludes = path.join(runRoot, `global-${randomUUID()}`);
    fs.writeFileSync(excludes, '.mcdev-auth.json\n');
    git(root, ['config', 'core.excludesFile', excludes]);
    const result = inspectProjectGitSecurity(root);
    assert.equal(result.ignore.source, 'external');
    assert.equal(result.ignore.ignored, true);
    assert.ok(finding(result, 'missing-project-protection'));
});

test('repository info/exclude alone is not portable project protection', () => {
    const { root, repo } = fixture();
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.mcdev-auth.json\n');
    const result = inspectProjectGitSecurity(root);
    assert.equal(result.ignore.source, 'external');
    assert.equal(result.ignore.ignored, true);
    assert.ok(finding(result, 'missing-project-protection'));
});

test('project negation takes precedence over repository-local exclusion', () => {
    const { root, repo } = fixture({ rule: '!.mcdev-auth.json\n' });
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.mcdev-auth.json\n');
    const result = inspectProjectGitSecurity(root);
    assert.equal(result.ignore.negated, true);
    assert.equal(result.ignore.ignored, false);
    assert.ok(finding(result, 'missing-project-protection'));
});

test('nested project own ignore is recognized relative to Git root', () => {
    const { root } = fixture({ nested: true, rule: '.mcdev-auth.json\n' });
    const result = inspectProjectGitSecurity(root);
    assert.equal(result.status, 'protected');
    assert.equal(result.ignore.source, 'project');
});

test('ancestor gitignore protection is distinguished from nested project policy', () => {
    const { root, repo } = fixture({ nested: true });
    fs.writeFileSync(path.join(repo, '.gitignore'), '.mcdev-auth.json\n');
    const result = inspectProjectGitSecurity(root);
    assert.equal(result.ignore.source, 'other-gitignore');
    assert.equal(result.ignore.ignored, true);
    assert.ok(finding(result, 'missing-project-protection'));
});

test('nested project negation overrides ancestor rule', () => {
    const { root, repo } = fixture({ nested: true, rule: '!.mcdev-auth.json\n' });
    fs.writeFileSync(path.join(repo, '.gitignore'), '.mcdev-auth.json\n');
    const result = inspectProjectGitSecurity(root);
    assert.equal(result.ignore.source, 'project');
    assert.equal(result.ignore.ignored, false);
    assert.ok(finding(result, 'missing-project-protection'));
});

test('tracked auth is critical even when ignored, without creating or reading auth contents', () => {
    const { root, repo } = fixture({ nested: true, rule: '.mcdev-auth.json\n' });
    const blob = git(repo, ['hash-object', '-w', '--stdin'], '');
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},nested/.mcdev-auth.json`]);
    const result = inspectProjectGitSecurity(root);
    assert.equal(result.status, 'critical');
    assert.equal(result.ignore.portableProjectProtection, true);
    assert.equal(result.tracking.tracked, true);
    assert.ok(finding(result, 'tracked-auth'));
    assert.equal(fs.existsSync(path.join(root, '.mcdev-auth.json')), false);
});

test('nonrepository is unverified and never exposes raw Git diagnostics', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(runRoot, 'not-git-')));
    fs.writeFileSync(path.join(root, '.mcdevrc.json'), '{}');
    const result = inspectProjectGitSecurity(root);
    assert.equal(result.status, 'unverified');
    assert.equal(result.ignore.verified, false);
    assert.equal(result.tracking.verified, false);
    assert.ok(finding(result, 'git-check-unverified'));
    assert.equal(JSON.stringify(result).includes('fatal:'), false);
});

test('failed ignore and index commands remain independently unverified and sanitized', () => {
    const { root } = fixture({ rule: '.mcdev-auth.json\n' });
    for (const failed of ['check-ignore', 'ls-files']) {
        const result = withSpawn(
            (original, command, args, options) => {
                if (args.includes(failed))
                    return { status: 128, stdout: '', stderr: 'PRIVATE DIAGNOSTIC' };
                return original(command, args, options);
            },
            () => inspectProjectGitSecurity(root)
        );
        assert.equal(result.status, 'unverified');
        assert.equal(result.ignore.verified, failed !== 'check-ignore');
        assert.equal(result.tracking.verified, failed !== 'ls-files');
        assert.ok(finding(result, 'git-check-unverified'));
        assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
});

test('malformed successful output and spawn failures cannot imply protection', () => {
    const { root } = fixture({ rule: '.mcdev-auth.json\n' });
    for (const response of [
        { status: 0, stdout: 'malformed\0', stderr: '' },
        { status: null, stdout: '', stderr: '', error: new Error('PRIVATE') },
    ]) {
        const result = withSpawn(
            (original, command, args, options) => {
                if (args.includes('check-ignore') || args.includes('ls-files')) return response;
                return original(command, args, options);
            },
            () => inspectProjectGitSecurity(root)
        );
        assert.equal(result.status, 'unverified');
        assert.equal(result.ignore.verified, false);
        assert.equal(result.tracking.verified, false);
        assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
});

test('canonical config guard rejects unsafe roots before any Git command', () => {
    withSpawn(
        () => assert.fail('Git must not run for an unsafe root'),
        () => {
            assert.throws(() => inspectProjectGitSecurity('relative'), { code: 'unsafe-path' });
        }
    );
});
