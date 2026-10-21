import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-prompt-')));
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain owned synthetic fixtures; no recursive cleanup.

test('planning prompt preserves arguments and coordinates qualified source handoff', async (t) => {
    const client = new Client({ name: 'synthetic-handoff-prompt-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
        cwd: runRoot,
        stderr: 'pipe',
    });
    try {
        await client.connect(transport);
        const { prompts } = await client.listPrompts();
        const prompt = prompts.find((entry) => entry.name === 'plan_mcdev_change');
        assert.ok(prompt);
        assert.deepEqual(
            prompt.arguments.map(({ name, required }) => ({ name, required })),
            [
                { name: 'goal', required: true },
                { name: 'workspaceRoot', required: false },
            ]
        );
        const { tools } = await client.listTools();
        const response = await client.getPrompt({
            name: prompt.name,
            arguments: { goal: 'Review the selected email extract', workspaceRoot: runRoot },
        });
        assert.equal(response.messages.length, 1);
        assert.equal(response.messages[0].role, 'user');
        assert.equal(response.messages[0].content.type, 'text');
        const text = response.messages[0].content.text;
        await t.test('actual project chain and qualified full-document hash binding', () => {
            let previous = -1;
            for (const name of [
                'inspect_mcdev_project',
                'inspect_mcdev_git_policy',
                'inventory_mcdev_project_artifacts',
                'resolve_mcdev_project_artifact',
                'read_mcdev_artifact_source',
                'preview_mcdev_project_command',
            ]) {
                assert.ok(
                    tools.some((entry) => entry.name === name),
                    name
                );
                const position = text.indexOf(`**${name}**`);
                assert.ok(position > previous, name);
                previous = position;
            }
            assert.ok(text.includes(runRoot));
            assert.match(
                text,
                /workspaceRoot, rootKind \(retrieve\/deploy\), credential, businessUnit, metadataType and externalKey/u
            );
            assert.match(text, /stop on blocked, ambiguous or unsupported/u);
            assert.match(
                text,
                /multiple email extracts.*sourceRole \(html, preheader or text\).*do not guess/u
            );
            assert.match(
                text,
                /selected editable role and complete original text plus SHA-256 of original bytes/u
            );
            assert.match(text, /re-read after edits.*current full document and hash/u);
        });
        await t.test(
            'host discovers optional schemas and detects platform before full validation',
            () => {
                assert.match(
                    text,
                    /host must discover available companion tool schemas before use/u
                );
                assert.match(text, /sibling tools are optional and cannot be assumed available/u);
                assert.match(text, /detect_sfmc_platform.*before language lookups or validation/u);
                assert.match(
                    text,
                    /target engagement only after confirmation.*unknown or conflicting detection/u
                );
                assert.match(
                    text,
                    /lookup_ssjs_function.*lookup_ampscript_function.*before authoring/u
                );
                assert.match(text, /supported status, caveats and required polyfills/u);
                assert.match(
                    text,
                    /SSJS to \*\*validate_ssjs\*\*.*HTML \(including mixed content\) to \*\*validate_sfmc_html\*\*.*complete current document and target engagement/u
                );
                assert.match(
                    text,
                    /validate_ampscript.*only for established AMPscript source, not every \.amp file/u
                );
                assert.match(
                    text,
                    /Preheader\/text are text-validator-not-established; SQL validation is not established/u
                );
                assert.match(
                    text,
                    /missing.*explicitly report unperformed lookups\/validation and limitations; stop only when that capability is essential/u
                );
                assert.match(
                    text,
                    /no server-to-server RPC and embeds no duplicated language data/u
                );
            }
        );
        await t.test('security overwrite and execution limits remain explicit', () => {
            assert.match(text, /surface critical Git auth ignore\/tracked warnings first/u);
            assert.match(text, /Never read, search, hash, copy or expose auth\/log contents/u);
            assert.match(
                text,
                /Request approval before ignore repairs; tracked auth can remain exposed/u
            );
            assert.match(
                text,
                /Never claim native rendering was performed: no Builder calls, rendering or native dry-run/u
            );
            assert.match(
                text,
                /Execution readiness remains unknown.*preview is not a dry-run or authorization and performs no execution/u
            );
            assert.match(
                text,
                /vendor-write targeted retrieve, require explicit overwrite approval.*including clean or companion-only files/u
            );
            assert.match(text, /No broad fallback retrieve, sends, publish or runtime operations/u);
            assert.doesNotMatch(text, /https?:\/\/|npm install|npx /u);
            assert.ok(text.endsWith('Review the selected email extract'));
        });
        await t.test('goal-only callers still work without inferred project identity', async () => {
            const result = await client.getPrompt({
                name: prompt.name,
                arguments: { goal: 'Plan a change' },
            });
            assert.match(
                result.messages[0].content.text,
                /Ask for the canonical absolute workspaceRoot/u
            );
            assert.ok(result.messages[0].content.text.endsWith('Plan a change'));
        });
    } finally {
        await client.close();
    }
});
