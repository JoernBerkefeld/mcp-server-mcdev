import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { listCommands, lookupCommand } from '../dist/command-catalog.js';

validateTempEnvironment();
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-command-tools-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain the run-owned fixture; never recursively delete it.

test('command catalog tools expose reviewed declarations only', { timeout: 30_000 }, async (t) => {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
        cwd: runRoot,
        stderr: 'pipe',
    });
    const client = new Client({ name: 'command-catalog-test', version: '1.0.0' });
    try {
        await client.connect(transport);
        const invoke = (name, args = {}) => client.callTool({ name, arguments: args });
        await t.test('schemas accept no execution or project selectors', async () => {
            const { tools } = await client.listTools();
            const list = tools.find((tool) => tool.name === 'mcdev_list_commands');
            const get = tools.find((tool) => tool.name === 'mcdev_get_command');
            assert.ok(list);
            assert.ok(get);
            assert.deepEqual(Object.keys(list.inputSchema.properties), []);
            assert.deepEqual(list.inputSchema.required ?? [], []);
            assert.deepEqual(Object.keys(get.inputSchema.properties), ['nameOrAlias']);
            assert.deepEqual(get.inputSchema.required, ['nameOrAlias']);
            assert.equal(get.inputSchema.properties.nameOrAlias.type, 'string');
            for (const tool of [list, get]) {
                assert.equal(tool.inputSchema.type, 'object');
                assert.match(tool.description, /Read-only/u);
                assert.match(tool.description, /Guidance-only/u);
                assert.match(tool.description, /No subprocess or dry run/u);
                assert.match(tool.description, /native mcdev has no dry-run mode/u);
                assert.match(tool.description, /not verified/u);
            }
            assert.ok(tools.some((tool) => tool.name === 'inspect_mcdev_project'));
        });
        await t.test(
            'list preserves the exact inventory and bounded retrieve execution coverage',
            async () => {
                const response = await invoke('mcdev_list_commands');
                assert.notEqual(response.isError, true);
                const entries = JSON.parse(response.content[0].text);
                assert.deepEqual(entries, listCommands());
                assert.equal(entries.length, 31);
                const { tools } = await client.listTools();
                for (const entry of entries) {
                    if (entry.name === 'retrieve') {
                        assert.equal(entry.execution.status, 'partially-executable');
                        assert.deepEqual(entry.execution.supportedCases, [
                            { metadataType: 'query', tool: 'retrieve_mcdev_query' },
                            { metadataType: 'script', tool: 'retrieve_mcdev_script' },
                        ]);
                        for (const supported of entry.execution.supportedCases) {
                            assert.ok(tools.some((tool) => tool.name === supported.tool));
                        }
                        assert.match(
                            entry.execution.remainingGuidanceOnlyScope,
                            /All other metadata types/u
                        );
                        assert.match(
                            entry.execution.restrictions,
                            /no arbitrary type, argv, flags or broad selectors/u
                        );
                    } else {
                        assert.equal(entry.execution.status, 'guidance-only');
                        assert.match(entry.execution.reason, /No execution adapter exists/u);
                        assert.equal(entry.execution.supportedCases, undefined);
                    }
                    if (
                        [
                            'clone',
                            'build',
                            'buildTemplate',
                            'buildDefinition',
                            'buildDefinitionBulk',
                            'createDeltaPkg',
                        ].includes(entry.name)
                    ) {
                        assert.equal(entry.reviewedEffects.status, 'partial-source-review');
                        assert.match(entry.execution.reason, /remain unverified/u);
                    } else {
                        if (entry.name !== 'retrieve') {
                            assert.match(entry.execution.reason, /have not been reviewed/u);
                        }
                        assert.equal(entry.reviewedEffects, undefined);
                    }
                    assert.equal(entry.approved, undefined);
                    assert.equal(entry.argv, undefined);
                    assert.equal(entry.executable, undefined);
                }
            }
        );
        await t.test(
            'canonical names and aliases resolve without command-line interpretation',
            async () => {
                for (const entry of listCommands()) {
                    for (const nameOrAlias of [entry.name, ...entry.aliases]) {
                        const response = await invoke('mcdev_get_command', { nameOrAlias });
                        assert.notEqual(response.isError, true);
                        assert.deepEqual(
                            JSON.parse(response.content[0].text),
                            lookupCommand(nameOrAlias)
                        );
                    }
                }
            }
        );
        await t.test(
            'unknown names and argv return a fixed error without echoing input',
            async () => {
                for (const nameOrAlias of [
                    '',
                    'Retrieve',
                    ' retrieve',
                    'retrieve a/b query key',
                    '--help',
                    '; private-sentinel',
                ]) {
                    const response = await invoke('mcdev_get_command', { nameOrAlias });
                    assert.equal(response.isError, true);
                    assert.deepEqual(response.content, [
                        { type: 'text', text: 'Unknown reviewed command name or alias.' },
                    ]);
                    assert.doesNotMatch(JSON.stringify(response), /private-sentinel|stack|ENOENT/u);
                }
                for (const args of [{}, { nameOrAlias: 7 }]) {
                    const response = await invoke('mcdev_get_command', args);
                    assert.equal(response.isError, true);
                }
            }
        );
    } finally {
        await client.close();
    }
});
