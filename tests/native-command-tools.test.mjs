import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateTempEnvironment } from '../dist/temp-environment.js';

validateTempEnvironment();
test('stdio exposes native execution with host-controlled approval and actionable invalid requests', async () => {
    const client = new Client({ name: 'native-contract-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
        stderr: 'pipe',
    });
    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const tool = tools.find(({ name }) => name === 'run_mcdev_command');
        assert.ok(tool);
        assert.equal(tool.annotations.readOnlyHint, false);
        assert.equal(tool.annotations.destructiveHint, true);
        assert.equal(tool.annotations.idempotentHint, false);
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.ok(tools.some(({ name }) => name === 'reconcile_mcdev_operation'));
        const result = await client.callTool({
            name: 'run_mcdev_command',
            arguments: { workspaceRoot: 'relative', command: 'retrieve', args: ['cred/BU'] },
        });
        assert.equal(JSON.parse(result.content[0].text).outcome, 'invalid-input');
        const reconcile = await client.callTool({
            name: 'reconcile_mcdev_operation',
            arguments: { workspaceRoot: 'relative', operatorReconciled: false },
        });
        assert.equal(reconcile.isError, true);
        const root = fs.realpathSync.native(
            fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-stdio-native-'))
        );
        fs.writeFileSync(path.join(root, '.owner'), randomUUID());
        fs.writeFileSync(path.join(root, '.mcdevrc.json'), '{}');
        // Retain this run-owned fixture; no recursive cleanup.
        const executed = await client.callTool(
            {
                name: 'run_mcdev_command',
                arguments: {
                    workspaceRoot: root,
                    command: 'explainTypes',
                    args: ['--json', '--noLogFile'],
                },
            },
            undefined,
            { timeout: 30_000 }
        );
        const evidence = JSON.parse(executed.content[0].text);
        assert.equal(evidence.outcome, 'exited');
        assert.equal(evidence.process.exitCode, 0);
        assert.equal(evidence.runtimeVersion, '10.1.1');
        assert.equal(evidence.remoteCompletenessVerified, false);
    } finally {
        await client.close();
    }
});
