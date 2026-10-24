import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectProjectGitRange } from '../dist/project-git-range.js';

assert.ok(process.env.TEMP);
for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) continue;
    assert.ok(path.isAbsolute(value));
    assert.equal(
        path
            .resolve(value)
            .replace(/[\\/]+$/u, '')
            .toLowerCase(),
        path.normalize('F:/Temp').toLowerCase()
    );
}
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-range-tools-')));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
fs.writeFileSync(path.join(root, '.mcdevrc.json'), '{}');
// Retain owned fixtures; no synthetic commits or recursive deletion.
const entry = new URL('../dist/index.js', import.meta.url);
const name = 'inspect_mcdev_git_range';
const args = { workspaceRoot: root, sourceRef: 'main', targetRef: 'refs/heads/main' };

/**
 * Connect an isolated protocol client, optionally through a test-only bootstrap.
 * @param action - Client assertions to run.
 * @param bootstrap - Optional test bootstrap filename.
 * @returns {Promise<void>} Completion of assertions and transport shutdown.
 */
async function withClient(action, bootstrap = fileURLToPath(entry)) {
    const client = new Client({ name: 'git-range-protocol-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [bootstrap],
        cwd: root,
        stderr: 'pipe',
    });
    try {
        await client.connect(transport);
        await action(client);
    } finally {
        await client.close();
    }
}

test(
    'range tool protocol preserves schema, security registrations and unknown evidence',
    { timeout: 30_000 },
    async (t) => {
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
        );
        for (const command of [
            ['init', '--quiet', '--initial-branch=main'],
            ['config', '--local', 'user.name', 'Jörn Berkefeld'],
            ['config', '--local', 'user.email', 'joern.berkefeld@gmail.com'],
        ]) {
            const result = spawnSync('git', command, {
                cwd: root,
                env,
                encoding: 'utf8',
                timeout: 5000,
            });
            assert.ifError(result.error);
            assert.equal(result.status, 0, 'Unborn repository setup must succeed');
        }
        await withClient(async (client) => {
            const invoke = (input = args) => client.callTool({ name, arguments: input });
            await t.test('list and bounded schema preserve separate security tools', async () => {
                const { tools } = await client.listTools();
                for (const preserved of [
                    'inspect_mcdev_project',
                    'inspect_mcdev_git_policy',
                    'read_mcdev_project_config',
                ])
                    assert.ok(tools.some((tool) => tool.name === preserved));
                const tool = tools.find((tool) => tool.name === name);
                assert.ok(tool);
                assert.equal(tool.inputSchema.type, 'object');
                assert.deepEqual(tool.inputSchema.required, [
                    'workspaceRoot',
                    'sourceRef',
                    'targetRef',
                ]);
                assert.deepEqual(Object.keys(tool.inputSchema.properties), [
                    'workspaceRoot',
                    'sourceRef',
                    'targetRef',
                    'declaredEdge',
                ]);
                assert.equal(tool.inputSchema.additionalProperties, false);
                assert.deepEqual(tool.inputSchema.properties.declaredEdge.enum, [
                    'promotion',
                    'back-promotion',
                ]);
                assert.equal(tool.inputSchema.properties.workspaceRoot.type, 'string');
                for (const key of ['sourceRef', 'targetRef']) {
                    assert.equal(tool.inputSchema.properties[key].type, 'string');
                    assert.equal(tool.inputSchema.properties[key].minLength, 1);
                    assert.equal(tool.inputSchema.properties[key].maxLength, 256);
                }
                for (const pattern of [
                    /Read-only Git metadata/u,
                    /not promotion policy/u,
                    /Local snapshot only/u,
                    /remote freshness.*unknown/u,
                    /remote BU synchronization.*unknown/u,
                    /not an atomic snapshot/u,
                    /Separate from inspect_mcdev_project/u,
                ])
                    assert.match(tool.description, pattern);
            });
            await t.test('real unborn refs stay unknown with no fabricated endpoint', async () => {
                const response = await invoke();
                assert.notEqual(response.isError, true);
                assert.equal(response.content.length, 1);
                const report = JSON.parse(response.content[0].text);
                assert.deepEqual(
                    report,
                    inspectProjectGitRange(root, args.sourceRef, args.targetRef)
                );
                assert.deepEqual(report.source, { ref: 'main', commit: null });
                assert.deepEqual(report.target, { ref: 'refs/heads/main', commit: null });
                assert.equal(report.ancestry, 'unknown');
                assert.equal(report.snapshot, 'local');
                assert.equal(report.freshness, 'unknown');
                assert.equal(report.remoteBuSynchronization, 'unknown');
                assert.deepEqual(report.findings, ['endpoint-unverified']);
                assert.equal(report.limitations.length, 3);
                assert.doesNotMatch(JSON.stringify(response), /fatal:|stderr|stdout/u);
            });
            await t.test(
                'invalid refs retain sanitized module results; bounds reject invalid schemas',
                async () => {
                    for (const key of ['sourceRef', 'targetRef']) {
                        for (const ref of ['--help', 'main~1', 'a..b', 'a\nb']) {
                            const input = { ...args, [key]: ref };
                            const response = await invoke(input);
                            assert.notEqual(response.isError, true);
                            const report = JSON.parse(response.content[0].text);
                            assert.deepEqual(
                                report,
                                inspectProjectGitRange(root, input.sourceRef, input.targetRef)
                            );
                            assert.equal(report[key === 'sourceRef' ? 'source' : 'target'].ref, '');
                            assert.deepEqual(report.findings, ['invalid-ref']);
                        }
                        for (const value of ['', 'x'.repeat(257), 7])
                            assert.equal((await invoke({ ...args, [key]: value })).isError, true);
                    }
                    assert.equal((await invoke({})).isError, true);
                }
            );
            await t.test(
                'optional intent preserves unknown evidence and sanitizes strict SDK errors',
                async () => {
                    for (const declaredEdge of ['promotion', 'back-promotion']) {
                        const response = await invoke({ ...args, declaredEdge });
                        assert.notEqual(response.isError, true);
                        assert.deepEqual(
                            JSON.parse(response.content[0].text),
                            inspectProjectGitRange(
                                root,
                                args.sourceRef,
                                args.targetRef,
                                declaredEdge
                            )
                        );
                        assert.equal(
                            JSON.parse(response.content[0].text).promotionAssessment.status,
                            'unknown'
                        );
                    }
                    for (const extra of [
                        ...[
                            null,
                            '',
                            'PRIVATE-value',
                            7,
                            true,
                            [],
                            { 'PRIVATE-property': true },
                        ].map((declaredEdge) => ({ declaredEdge })),
                        { 'PRIVATE-property': 'PRIVATE-value' },
                    ]) {
                        const response = await invoke({ ...args, ...extra });
                        assert.equal(response.isError, true);
                        assert.match(
                            response.content[0].text,
                            /Project Git range inspection unavailable\./u
                        );
                        assert.doesNotMatch(JSON.stringify(response), /PRIVATE/u);
                    }
                }
            );
            await t.test(
                'invalid roots and malformed config expose only a fixed safe error',
                async () => {
                    const malformed = fs.realpathSync.native(
                        fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-range-invalid-'))
                    );
                    fs.writeFileSync(path.join(malformed, '.owner'), randomUUID());
                    fs.writeFileSync(
                        path.join(malformed, '.mcdevrc.json'),
                        '{"private-range-sentinel":'
                    );
                    for (const workspaceRoot of [
                        'relative-private-range-sentinel',
                        path.join(root, 'missing'),
                        path.join(root, '.mcdevrc.json'),
                        malformed,
                    ]) {
                        const response = await invoke({ ...args, workspaceRoot });
                        assert.equal(response.isError, true);
                        assert.deepEqual(response.content, [
                            { type: 'text', text: 'Project Git range inspection unavailable.' },
                        ]);
                        assert.doesNotMatch(
                            JSON.stringify(response),
                            /private-range-sentinel|SyntaxError|ENOENT|stack|stdout|stderr/u
                        );
                    }
                }
            );
        });
    }
);

test(
    'successful metadata crosses the real protocol through a test-only subprocess boundary',
    { timeout: 30_000 },
    async () => {
        const bootstrap = path.join(root, 'range-bootstrap.mjs');
        const hash = 'a'.repeat(40);
        // Patch only the isolated test process's Git subprocess boundary, never production code.
        fs.writeFileSync(
            bootstrap,
            String.raw`
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
const expected = [
    [['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', 'main'], 'refs/heads/main\n'],
    [['rev-parse', '--verify', '--end-of-options', 'refs/heads/main^{commit}'], '${hash}\n'],
    [['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', 'refs/heads/main'], 'refs/heads/main\n'],
    [['rev-parse', '--verify', '--end-of-options', 'refs/heads/main^{commit}'], '${hash}\n'],
];
let calls = 0;
childProcess.spawnSync = (command, argv, options) => {
    if (command !== 'git') return original(command, argv, options);
    const next = expected[calls++ % expected.length];
    assert.ok(next, 'unexpected Git operation');
    assert.deepEqual(argv.slice(6), next[0]);
    assert.equal(options.cwd, ${JSON.stringify(root)});
    assert.equal(options.shell, false);
    return { status: 0, stdout: next[1], stderr: '' };
};
syncBuiltinESMExports();
await import(${JSON.stringify(entry.href)});
`
        );
        await withClient(async (client) => {
            const response = await client.callTool({ name, arguments: args });
            assert.notEqual(response.isError, true);
            const report = JSON.parse(response.content[0].text);
            assert.deepEqual(report, {
                projectRoot: root,
                source: { ref: 'main', commit: hash },
                target: { ref: 'refs/heads/main', commit: hash },
                ancestry: 'equal',
                snapshot: 'local',
                freshness: 'unknown',
                remoteBuSynchronization: 'unknown',
                findings: [],
                limitations: inspectProjectGitRange(root, args.sourceRef, args.targetRef)
                    .limitations,
            });
            for (const declaredEdge of ['promotion', 'back-promotion']) {
                const annotated = await client.callTool({
                    name,
                    arguments: { ...args, declaredEdge },
                });
                assert.notEqual(annotated.isError, true);
                assert.deepEqual(JSON.parse(annotated.content[0].text), {
                    ...report,
                    promotionAssessment: {
                        declaredEdge,
                        direction: 'source-to-target',
                        basis: 'exact-source-commit-ancestry',
                        status: 'contained',
                        policySource: 'caller-declared',
                    },
                });
            }
        }, bootstrap);
    }
);
