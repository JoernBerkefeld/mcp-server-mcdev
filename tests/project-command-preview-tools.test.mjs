import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { previewProjectCommand } from '../dist/project-command-preview.js';

assert.ok(process.env.TEMP);
for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) continue;
    assert.ok(path.isAbsolute(value));
    assert.equal(
        path
            .resolve(value)
            .replaceAll(/[\\/]+$/gu, '')
            .toLowerCase(),
        path.normalize('F:/Temp').toLowerCase()
    );
}
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-project-preview-tools-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain the ownership-marked synthetic fixture; never recursively delete it.
const sentinel = 'synthetic-private-preview-sentinel';
const config = {
    credentials: {
        first: { businessUnits: { shared: '123' } },
        second: { businessUnits: { shared: 456 } },
    },
    custom: { private: sentinel },
};

function fixture(value) {
    const root = fs.mkdtempSync(path.join(runRoot, 'project-'));
    fs.writeFileSync(path.join(root, '.mcdevrc.json'), JSON.stringify(value));
    return root;
}

const root = fixture(config);
const request = {
    command: 'retrieve',
    credential: 'first',
    businessUnit: 'shared',
    type: 'query',
    key: 'example-key',
};
const blocked =
    'Project command preview blocked: unsupported selectors, options or configured directories.';

test('project command preview protocol remains guidance-only', { timeout: 30_000 }, async (t) => {
    const client = new Client({ name: 'project-preview-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
        cwd: runRoot,
        stderr: 'pipe',
    });
    try {
        await client.connect(transport);
        const invoke = (args) =>
            client.callTool({
                name: 'preview_mcdev_project_command',
                arguments: { workspaceRoot: root, ...request, ...args },
            });
        await t.test('schema exposes exact supported fields and explicit limits', async () => {
            const { tools } = await client.listTools();
            const tool = tools.find((entry) => entry.name === 'preview_mcdev_project_command');
            assert.ok(tool);
            assert.deepEqual(tool.inputSchema.required, [
                'workspaceRoot',
                'command',
                'credential',
                'businessUnit',
                'type',
                'key',
            ]);
            assert.deepEqual(Object.keys(tool.inputSchema.properties), [
                'workspaceRoot',
                'command',
                'credential',
                'businessUnit',
                'type',
                'key',
                'options',
            ]);
            assert.deepEqual(tool.inputSchema.properties.command.enum, ['retrieve', 'deploy']);
            const options = tool.inputSchema.properties.options;
            assert.equal(options.additionalProperties, false);
            assert.deepEqual(
                Object.keys(options.properties).toSorted(),
                [
                    'api',
                    'execute',
                    'fix',
                    'fixShared',
                    'format',
                    'fromRetrieve',
                    'noUpdate',
                    'onlyPublished',
                    'purge',
                    'refresh',
                    'schedule',
                    'skipInteraction',
                    'skipValidation',
                ].toSorted()
            );
            assert.equal(options.properties.api.const, 'log');
            for (const [name, value] of Object.entries(options.properties)) {
                if (name !== 'api') assert.equal(value.type, 'boolean');
            }
            assert.match(tool.description, /Read-only, guidance-only/u);
            assert.match(tool.description, /No subprocess/u);
            assert.match(tool.description, /native mcdev has no dry-run mode/u);
            assert.match(tool.description, /Execution remains disabled/u);
            assert.match(tool.description, /not proven project-local effects/u);
            for (const name of [
                'read_mcdev_project_config',
                'inspect_mcdev_project',
                'inspect_mcdev_git_policy',
            ]) {
                assert.ok(tools.some((entry) => entry.name === name));
            }
        });
        await t.test('qualified duplicate BU aliases preserve exact adapter output', async () => {
            for (const selection of [
                { ...request, options: { purge: true, api: 'log' } },
                {
                    ...request,
                    credential: 'second',
                    command: 'deploy',
                    options: { fromRetrieve: true },
                },
            ]) {
                const response = await invoke(selection);
                assert.notEqual(response.isError, true);
                const result = JSON.parse(response.content[0].text);
                assert.deepEqual(result, previewProjectCommand({ config }, selection));
                assert.equal(result.scope.bu, `${selection.credential}/shared`);
                assert.equal(result.selectorVerification, 'verified-config-mapping');
                assert.equal(result.executionReadiness, 'unknown');
                assert.equal(result.configuredPaths, 'unknown');
                assert.equal(result.status, 'guidance-only');
                assert.equal(result.executesProcess, false);
                assert.equal(result.remoteStateValidated, false);
                assert.match(result.limitations.join(' '), /not proven project effects/u);
                assert.match(result.limitations.join(' '), /Execution remains disabled/u);
                assert.ok(result.blockedReasons.length > 0);
                assert.equal(result.argv, undefined);
                assert.equal(result.approved, undefined);
                assert.ok(!JSON.stringify(response).includes(sentinel));
            }
            assert.deepEqual(fs.readdirSync(root), ['.mcdevrc.json']);
            const full = await client.callTool({
                name: 'read_mcdev_project_config',
                arguments: { workspaceRoot: root },
            });
            assert.deepEqual(JSON.parse(full.content[0].text), config);
        });
        await t.test(
            'unsupported scope and configured roots use a fixed safe rejection',
            async () => {
                for (const args of [
                    { credential: sentinel },
                    { businessUnit: sentinel },
                    { credential: '*' },
                    { businessUnit: '../shared' },
                    { key: '*' },
                    { key: 'one,two' },
                    { type: 'journey' },
                    { options: { fromRetrieve: true } },
                    { command: 'deploy', options: { purge: true } },
                    { command: 'deploy', options: { execute: true } },
                    { workspaceRoot: fixture({ ...config, directories: { retrieve: sentinel } }) },
                    {
                        workspaceRoot: fixture({
                            ...config,
                            directories: { deploy: '../outside' },
                        }),
                    },
                    { workspaceRoot: fixture({ ...config, directories: { docs: 'custom' } }) },
                    {
                        workspaceRoot: fixture({
                            credentials: { first: { businessUnits: { shared: '0' } } },
                        }),
                    },
                ]) {
                    const response = await invoke(args);
                    assert.equal(response.isError, true);
                    assert.deepEqual(response.content, [{ type: 'text', text: blocked }]);
                    assert.doesNotMatch(JSON.stringify(response), /sentinel|stack|ENOENT/u);
                }
                const response = await invoke({ workspaceRoot: path.join(runRoot, sentinel) });
                assert.equal(response.isError, true);
                assert.deepEqual(response.content, [
                    {
                        type: 'text',
                        text: 'Project command preview blocked: configuration unavailable.',
                    },
                ]);
            }
        );
        await t.test(
            'schema rejects unsupported options and missing required selectors',
            async () => {
                for (const args of [
                    { options: { dryRun: true } },
                    { options: { metadata: 'query:key' } },
                    { options: { api: 'cli' } },
                    { options: { purge: 'true' } },
                    { command: 'r' },
                    { credential: 7 },
                ]) {
                    assert.equal((await invoke(args)).isError, true);
                }
                for (const field of ['workspaceRoot', ...Object.keys(request)]) {
                    const args = { workspaceRoot: root, ...request };
                    delete args[field];
                    const response = await client.callTool({
                        name: 'preview_mcdev_project_command',
                        arguments: args,
                    });
                    assert.equal(response.isError, true);
                }
            }
        );
    } finally {
        await client.close();
    }
});
