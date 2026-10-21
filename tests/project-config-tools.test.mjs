import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { diagnoseProjectConfig } from '../dist/project-config-diagnostics.js';

for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) continue;
    assert.ok(path.isAbsolute(value), 'temporary paths must be absolute');
    assert.equal(
        path
            .resolve(value)
            .replaceAll(/[\\/]+$/gu, '')
            .toLowerCase(),
        path.normalize('F:/Temp').toLowerCase()
    );
}
assert.ok(process.env.TEMP, 'TEMP must be set');
const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-config-tools-'))
);
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain synthetic fixtures with their ownership marker; never recursively delete them.
const sentinel = 'synthetic-private-config-fragment';

function fixture(raw) {
    const root = fs.mkdtempSync(path.join(runRoot, 'project-'));
    if (raw !== undefined) fs.writeFileSync(path.join(root, '.mcdevrc.json'), raw);
    return root;
}

test(
    'config diagnosis exposes a partial read-only SDK protocol operation',
    { timeout: 30_000 },
    async (t) => {
        const config = {
            credentials: { example: { businessUnits: { source: '123' } } },
            markets: { sample: { custom: [sentinel] } },
            marketList: { source: { 'example/source': 'missing' } },
            directories: { retrieve: 7 },
            options: { validation: { hook: sentinel } },
            custom: { nested: [true, null, sentinel] },
        };
        const rawText = `  ${JSON.stringify(config, null, 2)}\n`;
        const root = fixture(rawText);
        const expected = diagnoseProjectConfig({
            projectRoot: root,
            configPath: path.join(root, '.mcdevrc.json'),
            rawText,
            config,
        });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: runRoot,
            stderr: 'pipe',
        });
        const client = new Client({ name: 'synthetic-config-test', version: '1.0.0' });
        try {
            await client.connect(transport);
            const invoke = (workspaceRoot) =>
                client.callTool({
                    name: 'diagnose_mcdev_project_config',
                    arguments: { workspaceRoot },
                });
            await t.test('schema and description explicitly bound the operation', async () => {
                const { tools } = await client.listTools();
                const tool = tools.find((entry) => entry.name === 'diagnose_mcdev_project_config');
                assert.ok(tool);
                assert.equal(tool.inputSchema.type, 'object');
                assert.deepEqual(tool.inputSchema.required, ['workspaceRoot']);
                assert.deepEqual(Object.keys(tool.inputSchema.properties), ['workspaceRoot']);
                assert.equal(tool.inputSchema.properties.workspaceRoot.type, 'string');
                assert.match(tool.description, /partial static diagnosis/u);
                assert.match(
                    tool.description,
                    /not native mcdev validation or execution readiness/u
                );
                assert.match(tool.description, /FIRST.*Pipeline Builder before editing/u);
                assert.match(tool.description, /never writes files, loads hooks, reads auth/u);
            });
            await t.test(
                'builder recommendation is first and module findings and limits remain intact',
                async () => {
                    const response = await invoke(root);
                    assert.notEqual(response.isError, true);
                    assert.equal(response.content.length, 2);
                    assert.ok(
                        response.content[0].text.startsWith(expected.recommendation.firstStep)
                    );
                    assert.match(
                        response.content[0].text,
                        /not native mcdev validation or execution readiness/u
                    );
                    const diagnosis = JSON.parse(response.content[1].text);
                    assert.deepEqual(diagnosis, expected);
                    assert.match(
                        diagnosis.recommendation.firstStep,
                        /^Before editing.*Pipeline Builder/u
                    );
                    assert.equal(
                        diagnosis.recommendation.url,
                        'https://sfmc.guide/tools/mcdev-pipeline-builder/'
                    );
                    assert.match(
                        diagnosis.recommendation.guidance,
                        /Load your existing \.mcdevrc\.json/u
                    );
                    assert.match(
                        diagnosis.recommendation.guidance,
                        /Never load \.mcdev-auth\.json/u
                    );
                    for (const value of Object.values(diagnosis.recommendation)) {
                        assert.ok(response.content[0].text.includes(value));
                    }
                    assert.ok(
                        diagnosis.findings.some((finding) => finding.code === 'invalid-directory')
                    );
                    assert.ok(
                        diagnosis.findings.some((finding) => finding.code === 'unresolved-market')
                    );
                    assert.equal(diagnosis.limitations.length, 4);
                    assert.match(
                        diagnosis.limitations[0],
                        /Partial static diagnosis, not native mcdev validation/u
                    );
                    assert.match(
                        diagnosis.limitations[1],
                        /No auth, hooks, files, native CLI or live account checks/u
                    );
                    assert.match(diagnosis.limitations[2], /not validated/u);
                    assert.match(diagnosis.limitations[3], /not structural errors/u);
                    assert.ok(!JSON.stringify(response).includes(sentinel));
                    assert.equal(
                        fs.readFileSync(path.join(root, '.mcdevrc.json'), 'utf8'),
                        rawText
                    );
                    assert.deepEqual(fs.readdirSync(root), ['.mcdevrc.json']);
                    const original = await client.callTool({
                        name: 'read_mcdev_project_config',
                        arguments: { workspaceRoot: root },
                    });
                    assert.notEqual(original.isError, true);
                    assert.equal(original.content[0].text, rawText);
                }
            );
            await t.test(
                'empty optional config is not presented as execution readiness',
                async () => {
                    const response = await invoke(fixture('{}'));
                    assert.notEqual(response.isError, true);
                    const diagnosis = JSON.parse(response.content[1].text);
                    assert.deepEqual(diagnosis.findings, []);
                    assert.deepEqual(diagnosis.limitations, expected.limitations);
                    assert.match(
                        response.content[0].text,
                        /not native mcdev validation or execution readiness/u
                    );
                }
            );
            await t.test('invalid roots and configs return only one fixed safe error', async () => {
                for (const workspaceRoot of [
                    `relative-${sentinel}`,
                    path.join(runRoot, `missing-${sentinel}`),
                    path.join(root, '.mcdevrc.json'),
                    fixture(),
                    fixture(`{"${sentinel}":`),
                    fixture('[]'),
                    fixture('null'),
                ]) {
                    const response = await invoke(workspaceRoot);
                    assert.equal(response.isError, true);
                    assert.deepEqual(response.content, [
                        { type: 'text', text: 'Project configuration diagnosis unavailable.' },
                    ]);
                    assert.ok(!JSON.stringify(response).includes(sentinel));
                    assert.doesNotMatch(
                        JSON.stringify(response),
                        /SyntaxError|ENOENT|node:fs|stack/u
                    );
                }
                for (const args of [{}, { workspaceRoot: 7 }]) {
                    const response = await client.callTool({
                        name: 'diagnose_mcdev_project_config',
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
