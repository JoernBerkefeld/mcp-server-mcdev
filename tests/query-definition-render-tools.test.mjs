import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

validateTempEnvironment();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-render-tools-')));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
// Retain this owned synthetic fixture; never launch native mcdev or inspect real projects.
fs.writeFileSync(path.join(root, '.mcdevrc.json'), JSON.stringify({ version: '10.1.0' }));
const sentinel = 'PRIVATE_SYNTHETIC_RENDER';
const selection = {
    workspaceRoot: root,
    credential: 'demo',
    businessUnit: 'QA',
    templateName: 'Source_1',
    market: 'qa',
};

test('production render registration directly forwards the request signal without consent machinery', () => {
    const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(
        source,
        /await executeQueryDefinitionRender\(input, \{ signal: extra.signal \}\)/u
    );
    const registration = source.slice(
        source.indexOf("    'render_mcdev_query_definition',"),
        source.indexOf('// Tool: mcdev_search_docs')
    );
    assert.doesNotMatch(
        registration,
        /elicitation|requestApproval|acknowledgeExternalReconciliation/u
    );
});

test(
    'production stdio render schema, mutation annotations and bounded unavailable responses',
    { timeout: 30_000 },
    async () => {
        const client = new Client({ name: 'synthetic-render-test', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: root,
            stderr: 'pipe',
        });
        const before = fs
            .readdirSync(root)
            .map((name) => [name, fs.readFileSync(path.join(root, name)).toString('hex')]);
        try {
            await client.connect(transport);
            const { tools } = await client.listTools();
            const tool = tools.find((entry) => entry.name === 'render_mcdev_query_definition');
            assert.ok(tool);
            assert.deepEqual(tool.inputSchema.required, Object.keys(selection));
            assert.deepEqual(Object.keys(tool.inputSchema.properties), Object.keys(selection));
            assert.equal(tool.inputSchema.additionalProperties, false);
            for (const property of Object.values(tool.inputSchema.properties))
                assert.deepEqual(property, { type: 'string' });
            assert.deepEqual(tool.annotations, {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            });
            assert.match(tool.description, /all configured.*templateBuilds/u);
            assert.match(tool.description, /best-effort.*partial effects/u);
            for (const args of [
                {},
                { ...selection, [sentinel]: sentinel },
                ...Object.keys(selection).map((key) => ({
                    ...selection,
                    [key]: { [sentinel]: sentinel },
                })),
            ]) {
                const result = await client.callTool({ name: tool.name, arguments: args });
                assert.equal(result.isError, true);
                assert.match(result.content[0].text, /Query definition render unavailable\./u);
                assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC|ZodError|ENOENT/u);
            }
            for (const args of [
                selection,
                { ...selection, credential: sentinel },
                { ...selection, templateName: '*' },
                { ...selection, market: 'one,two' },
                { ...selection, businessUnit: '__clone__' },
                { ...selection, workspaceRoot: 'relative-private-root' },
            ]) {
                const result = await client.callTool({ name: tool.name, arguments: args });
                assert.notEqual(result.isError, true);
                assert.deepEqual(JSON.parse(result.content[0].text), {
                    outcome: 'unavailable',
                    processOutcome: null,
                    projectBlocked: false,
                    destinations: [],
                    artifactCompletenessVerified: false,
                    remoteCompletenessVerified: false,
                    languageValidationPerformed: false,
                });
                assert.doesNotMatch(
                    JSON.stringify(result),
                    /PRIVATE_SYNTHETIC|relative-private-root|stdout|stderr|ENOENT/u
                );
            }
            assert.deepEqual(
                fs
                    .readdirSync(root)
                    .map((name) => [name, fs.readFileSync(path.join(root, name)).toString('hex')]),
                before
            );
        } finally {
            await client.close();
        }
    }
);
