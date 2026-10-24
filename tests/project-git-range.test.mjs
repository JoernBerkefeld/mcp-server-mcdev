import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectProjectGitRange } from '../dist/project-git-range.js';

validateTempEnvironment();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-git-range-')));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
fs.writeFileSync(path.join(root, '.mcdevrc.json'), '{}');
// Retain owned fixtures; no synthetic commits or recursive cleanup.
const source = 'a'.repeat(40);
const target = 'b'.repeat(40);
const output = (stdout = '', status = 0) => ({ stdout, stderr: '', status });
const endpoints = (right = target) => [
    output('refs/heads/feature/topic\n'),
    output(`${source}\n`),
    output('refs/remotes/origin/main\n'),
    output(`${right}\n`),
];

function mocked(
    responses,
    action = () => inspectProjectGitRange(root, 'feature/topic', 'origin/main')
) {
    const original = childProcess.spawnSync;
    const calls = [];
    childProcess.spawnSync = (command, args, options) => {
        assert.equal(command, 'git');
        assert.equal(options.cwd, root);
        assert.equal(options.shell, false);
        assert.equal(options.timeout, 5000);
        assert.equal(options.maxBuffer, 64 * 1024);
        assert.equal(options.windowsHide, true);
        assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
        assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
        assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1');
        assert.equal(options.env.GIT_DIR, undefined);
        assert.deepEqual(args.slice(0, 6), [
            '-c',
            'core.fsmonitor=false',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.warnAmbiguousRefs=true',
        ]);
        calls.push(args.slice(6));
        assert.ok(responses.length, 'unexpected subprocess');
        return responses.shift();
    };
    syncBuiltinESMExports();
    try {
        const result = action();
        assert.equal(responses.length, 0);
        return { result, calls };
    } finally {
        childProcess.spawnSync = original;
        syncBuiltinESMExports();
    }
}

test('equal endpoints require only fixed ref resolution, never status or content', () => {
    const { result, calls } = mocked(endpoints(source));
    assert.equal(result.ancestry, 'equal');
    assert.equal(result.source.commit, source);
    assert.equal(result.target.commit, source);
    assert.equal(result.snapshot, 'local');
    assert.equal(result.freshness, 'unknown');
    assert.equal(result.remoteBuSynchronization, 'unknown');
    assert.deepEqual(calls, [
        ['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', 'feature/topic'],
        ['rev-parse', '--verify', '--end-of-options', 'refs/heads/feature/topic^{commit}'],
        ['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', 'origin/main'],
        ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main^{commit}'],
    ]);
});

test('ahead and behind compare resolved hashes, not mutable ref names', () => {
    for (const [left, right, ancestry] of [
        [0, 1, 'source-ahead'],
        [1, 0, 'target-ahead'],
    ]) {
        const { result, calls } = mocked([...endpoints(), output('', left), output('', right)]);
        assert.equal(result.ancestry, ancestry);
        assert.deepEqual(calls.slice(4), [
            ['merge-base', '--is-ancestor', target, source],
            ['merge-base', '--is-ancestor', source, target],
        ]);
    }
});

test('divergence requires a non-shallow repository', () => {
    for (const shallow of ['false\n', 'true\n', 'malformed']) {
        const { result, calls } = mocked([
            ...endpoints(),
            output('', 1),
            output('', 1),
            output(shallow),
        ]);
        assert.equal(result.ancestry, shallow === 'false\n' ? 'diverged' : 'unknown');
        assert.deepEqual(calls.at(-1), ['rev-parse', '--is-shallow-repository']);
    }
});

test('invalid and revision expression inputs fail closed before spawning', () => {
    for (const ref of [
        '-main',
        '--help',
        'main~1',
        'main^',
        'a..b',
        'a...b',
        '*',
        'a?',
        'a[0]',
        'a@{1}',
        'a:b',
        'a b',
        'a\nb',
        '../a',
        'a//b',
        '.a',
        'a.',
        'a.lock',
        'refs/a',
        '',
        'x'.repeat(257),
    ]) {
        const { result, calls } = mocked([], () => inspectProjectGitRange(root, ref, 'main'));
        assert.deepEqual(calls, []);
        assert.equal(result.ancestry, 'unknown');
        assert.deepEqual(result.findings, ['invalid-ref']);
    }
});

test('ambiguous, missing, pseudo and malformed refs never become endpoints', () => {
    for (const failure of [
        output('', 128),
        output(''),
        output('refs/tags/main\n'),
        output('refs/heads/a\nrefs/tags/a\n'),
        { ...output('refs/heads/main\n'), stderr: 'PRIVATE ambiguous' },
        { ...output(), status: null, error: new Error('PRIVATE timeout') },
    ]) {
        const { result } = mocked([failure, output('', 128)]);
        assert.equal(result.source.commit, null);
        assert.equal(result.ancestry, 'unknown');
        assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
});

test('exact refs and SHA-256 commit endpoints are accepted', () => {
    const hash = 'c'.repeat(64);
    const { result } = mocked(
        [
            output('refs/tags/v1\n'),
            output(`${hash}\n`),
            output('refs/heads/main\n'),
            output(`${hash}\n`),
        ],
        () => inspectProjectGitRange(root, 'refs/tags/v1', 'refs/heads/main')
    );
    assert.equal(result.ancestry, 'equal');
});

test('endpoint and ancestry failures remain sanitized unknown evidence', () => {
    for (const failure of [
        output('bad\n'),
        output('', 128),
        { ...output(), status: null, error: new Error('PRIVATE timeout') },
    ]) {
        const { result } = mocked([output('refs/heads/feature/topic\n'), failure, output('', 128)]);
        assert.equal(result.source.commit, null);
        assert.equal(result.ancestry, 'unknown');
    }
    for (const failure of [
        output('', 128),
        output('PRIVATE'),
        { ...output(), status: null, error: new Error('PRIVATE timeout') },
    ]) {
        const { result } = mocked([...endpoints(), failure, output('', 1)]);
        assert.equal(result.ancestry, 'unknown');
        assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
});

test('real unborn repository has unknown endpoints without synthetic commits', () => {
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    );
    const run = (args) =>
        childProcess.spawnSync('git', args, {
            cwd: root,
            env,
            shell: false,
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 64 * 1024,
        });
    assert.equal(run(['init', '--quiet', '--initial-branch=main']).status, 0);
    assert.equal(run(['config', '--local', 'user.name', 'Jörn Berkefeld']).status, 0);
    assert.equal(run(['config', '--local', 'user.email', 'joern.berkefeld@gmail.com']).status, 0);
    const result = inspectProjectGitRange(root, 'main', 'refs/heads/main');
    assert.equal(result.source.commit, null);
    assert.equal(result.target.commit, null);
    assert.equal(result.ancestry, 'unknown');
    assert.deepEqual(result.findings, ['endpoint-unverified']);
});

test('caller-declared edges annotate every relation without changing evidence or Git calls', () => {
    const cases = [
        [endpoints(source), 'contained'],
        [[...endpoints(), output('', 0), output('', 1)], 'not-contained'],
        [[...endpoints(), output('', 1), output('', 0)], 'contained'],
        [[...endpoints(), output('', 1), output('', 1), output('false\n')], 'not-contained'],
        [[...endpoints(), output('', 1), output('', 1), output('true\n')], 'unknown'],
        [[...endpoints(), output('', 1), output('', 1), output('PRIVATE')], 'unknown'],
        [[...endpoints(), output('', 128), output('', 1)], 'unknown'],
        [[output('', 128), output('', 128)], 'unknown'],
    ];
    for (const [responses, status] of cases) {
        const baseline = mocked([...responses]);
        assert.equal(Object.hasOwn(baseline.result, 'promotionAssessment'), false);
        for (const declaredEdge of ['promotion', 'back-promotion']) {
            const { result, calls } = mocked([...responses], () =>
                inspectProjectGitRange(root, 'feature/topic', 'origin/main', declaredEdge)
            );
            const { promotionAssessment, ...evidence } = result;
            assert.deepEqual(evidence, baseline.result);
            assert.deepEqual(calls, baseline.calls);
            assert.deepEqual(promotionAssessment, {
                declaredEdge,
                direction: 'source-to-target',
                basis: 'exact-source-commit-ancestry',
                status,
                policySource: 'caller-declared',
            });
            assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
        }
    }
    for (const declaredEdge of ['promotion', 'back-promotion']) {
        const { result, calls } = mocked([], () =>
            inspectProjectGitRange(root, '--help', 'main', declaredEdge)
        );
        assert.deepEqual(calls, []);
        assert.equal(result.promotionAssessment.status, 'unknown');
        assert.deepEqual(result.findings, ['invalid-ref']);
        assert.equal(
            inspectProjectGitRange(root, 'main', 'refs/heads/main', declaredEdge)
                .promotionAssessment.status,
            'unknown'
        );
    }
});

test('invalid declared intent fails before config or subprocess access without echoing input', () => {
    for (const value of [null, '', 'reverse', 'PRIVATE', 1, true, [], { PRIVATE: true }]) {
        mocked([], () => {
            assert.throws(() => inspectProjectGitRange('relative', 'main', 'other', value), {
                name: 'TypeError',
                message: 'Invalid declared edge.',
            });
        });
    }
});

test('unsafe roots fail before subprocess inspection', () => {
    assert.throws(() => inspectProjectGitRange('relative', 'main', 'other'), {
        code: 'unsafe-path',
    });
});
