import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { inspectProjectGitPolicy } from '../dist/project-git-policy.js';

validateTempEnvironment();
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-git-policy-tools-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain synthetic fixtures and their ownership marker; never recursively delete them.
const sentinel = 'synthetic-private-policy-fragment';

/**
 * Create a synthetic project without reading auth, logs or history.
 * @param raw - Optional project configuration text.
 * @returns {string} The isolated project root.
 */
function fixture(raw = '{}') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-policy-project-'));
    fs.writeFileSync(path.join(root, '.owner'), randomUUID());
    if (raw !== undefined) fs.writeFileSync(path.join(root, '.mcdevrc.json'), raw);
    return root;
}

/**
 * Initialize only an unborn synthetic repository; never create commits.
 * @param root - Synthetic project root.
 * @returns {void} Nothing.
 */
function init(root) {
    for (const args of [
        ['init', '--initial-branch=fixture-policy'],
        ['config', '--local', 'user.name', 'Jörn Berkefeld'],
        ['config', '--local', 'user.email', 'joern.berkefeld@gmail.com'],
    ]) {
        const result = spawnSync('git', args, {
            cwd: root,
            encoding: 'utf8',
            timeout: 5000,
            env: Object.fromEntries(
                Object.entries(process.env).filter(
                    ([name]) => !name.toUpperCase().startsWith('GIT_')
                )
            ),
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, 'Synthetic repository initialization must succeed');
    }
}

test(
    'Git policy inspection is a separate read-only SDK protocol tool',
    { timeout: 30_000 },
    async (t) => {
        const root = fixture();
        init(root);
        const expected = inspectProjectGitPolicy(root);
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: runRoot,
            stderr: 'pipe',
        });
        const client = new Client({ name: 'synthetic-git-policy-test', version: '1.0.0' });
        try {
            await client.connect(transport);
            const invoke = (workspaceRoot) =>
                client.callTool({ name: 'inspect_mcdev_git_policy', arguments: { workspaceRoot } });
            await t.test(
                'list and schema preserve the separate project inspection tool',
                async () => {
                    const { tools } = await client.listTools();
                    assert.ok(tools.some((entry) => entry.name === 'inspect_mcdev_project'));
                    const tool = tools.find((entry) => entry.name === 'inspect_mcdev_git_policy');
                    assert.ok(tool);
                    assert.equal(tool.inputSchema.type, 'object');
                    assert.deepEqual(tool.inputSchema.required, ['workspaceRoot']);
                    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['workspaceRoot']);
                    assert.equal(tool.inputSchema.properties.workspaceRoot.type, 'string');
                    for (const pattern of [
                        /Read-only Git metadata/u,
                        /local remote-tracking snapshot, not fresh remote/u,
                        /conventions remain unresolved/u,
                        /remote BU synchronization is unknown/u,
                        /Top-level verified covers status metadata only; refs\.verified is independent/u,
                        /Separate from inspect_mcdev_project auth protection checks/u,
                        /No policy persistence, branch changes, commit-message\/history\/auth\/artifact-content reads/u,
                        /not an atomic snapshot/u,
                    ])
                        assert.match(tool.description, pattern);
                }
            );
            await t.test(
                'unborn dirty output retains unresolved policy and metadata limits',
                async () => {
                    const response = await invoke(root);
                    assert.notEqual(response.isError, true);
                    assert.equal(response.content.length, 2);
                    assert.match(response.content[0].text, /Read-only Git metadata only/u);
                    assert.match(
                        response.content[0].text,
                        /local remote-tracking snapshot, not fresh remote/u
                    );
                    assert.match(response.content[0].text, /conventions remain unresolved/u);
                    assert.match(response.content[0].text, /remote BU synchronization is unknown/u);
                    assert.match(
                        response.content[0].text,
                        /Top-level verified covers status metadata only; refs\.verified is independent/u
                    );
                    assert.match(
                        response.content[0].text,
                        /does not replace inspect_mcdev_project/u
                    );
                    const report = JSON.parse(response.content[1].text);
                    assert.deepEqual(report, expected);
                    assert.equal(report.verified, true);
                    assert.equal(report.refs.verified, true);
                    assert.deepEqual(report.refs.names, []);
                    assert.deepEqual(report.branch, {
                        name: 'fixture-policy',
                        detached: false,
                        unborn: true,
                    });
                    assert.deepEqual(report.status, { dirty: true, conflicted: false });
                    assert.equal(report.tracking.ancestry, 'unknown');
                    assert.equal(report.remoteBuSynchronization, 'unknown');
                    assert.equal(report.policy.verified, false);
                    assert.equal(report.policy.branchRoles, null);
                    assert.equal(report.policy.ticketConvention, null);
                    assert.equal(report.policy.commitPrefix, null);
                    assert.equal(report.policy.questions.length, 3);
                    assert.match(report.policy.questions[0], /branches.*roles.*base branch/u);
                    assert.match(report.policy.questions[1], /ticket identifier.*format/u);
                    assert.match(report.policy.questions[2], /commit-message prefix.*format/u);
                    assert.deepEqual(report.findings, ['dirty', 'unborn', 'missing-upstream']);
                    assert.deepEqual(inspectProjectGitPolicy(root), expected);
                    assert.deepEqual(fs.readdirSync(root).toSorted(), [
                        '.git',
                        '.mcdevrc.json',
                        '.owner',
                    ]);
                }
            );
            await t.test(
                'valid non-repository output is unverified rather than a raw Git error',
                async () => {
                    const response = await invoke(fixture());
                    assert.notEqual(response.isError, true);
                    const report = JSON.parse(response.content[1].text);
                    assert.equal(report.verified, false);
                    assert.equal(report.refs.verified, false);
                    assert.deepEqual(report.findings, [
                        'git-status-unverified',
                        'git-refs-unverified',
                    ]);
                    assert.doesNotMatch(
                        JSON.stringify(response),
                        /fatal:|not a git repository|stderr|stdout/u
                    );
                }
            );
            await t.test('invalid roots and configs expose only a fixed safe error', async () => {
                const missingConfig = fs.mkdtempSync(
                    path.join(os.tmpdir(), 'mcdev-policy-missing-')
                );
                fs.writeFileSync(path.join(missingConfig, '.owner'), randomUUID());
                for (const workspaceRoot of [
                    `relative-${sentinel}`,
                    path.join(runRoot, `missing-${sentinel}`),
                    path.join(root, '.mcdevrc.json'),
                    missingConfig,
                    fixture(`{"${sentinel}":`),
                    fixture('[]'),
                    fixture('null'),
                ]) {
                    const response = await invoke(workspaceRoot);
                    assert.equal(response.isError, true);
                    assert.deepEqual(response.content, [
                        { type: 'text', text: 'Project Git policy inspection unavailable.' },
                    ]);
                    assert.ok(!JSON.stringify(response).includes(sentinel));
                    assert.doesNotMatch(
                        JSON.stringify(response),
                        /SyntaxError|ENOENT|node:fs|stack|stdout|stderr/u
                    );
                }
                for (const args of [{}, { workspaceRoot: 7 }]) {
                    const response = await client.callTool({
                        name: 'inspect_mcdev_git_policy',
                        arguments: args,
                    });
                    assert.equal(response.isError, true);
                }
            });
        } finally {
            await client.close();
        }
    }
);
