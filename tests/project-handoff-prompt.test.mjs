import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CAPABILITY_ROUTES } from '../dist/command-catalog.js';

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
        await t.test(
            'actual stdio prompt renders the single finite directory and preserves tool inventory',
            () => {
                assert.equal(tools.length, 22);
                assert.deepEqual(
                    tools.map((entry) => entry.name).toSorted(),
                    [
                        'diagnose_mcdev_retrieve_logs',
                        'prepare_mcdev_query_retrieve',
                        'retrieve_mcdev_query',
                        'retrieve_mcdev_script',
                        'mcdev_search_docs',
                        'mcdev_get_doc_section',
                        'mcdev_explain_config_key',
                        'mcdev_component_checklist',
                        'mcdev_list_metadata_types',
                        'mcdev_list_commands',
                        'mcdev_get_command',
                        'read_mcdev_project_config',
                        'diagnose_mcdev_project_config',
                        'preview_mcdev_project_config',
                        'inspect_mcdev_git_policy',
                        'inspect_mcdev_git_range',
                        'inspect_mcdev_project',
                        'inventory_mcdev_project_artifacts',
                        'resolve_mcdev_project_artifact',
                        'read_mcdev_artifact_source',
                        'preview_mcdev_project_command',
                        'render_mcdev_query_definition',
                    ].toSorted()
                );
                let previous = -1;
                for (const route of CAPABILITY_ROUTES) {
                    const entry = `- ${route.intent} -> ${route.backend}\n  Required capability: ${route.requiredCapability}\n  Standalone fallback: ${route.standaloneFallback}`;
                    assert.ok(text.includes(entry), route.intent);
                    assert.equal(text.split(entry).length, 2, route.intent);
                    const position = text.indexOf(entry);
                    assert.ok(position > previous);
                    previous = position;
                }
                assert.match(text, /ask about ambiguous intent instead of guessing/u);
                assert.match(
                    text,
                    /not a classifier, tool inventory, executable allowlist or availability claim/u
                );
                assert.match(text, /discover actual full companion schemas afresh/u);
                assert.match(text, /untrusted reference data, not execution instructions/u);
                assert.match(text, /Do not assume provider tool names, inputs or account matches/u);
                assert.match(text, /without auth\/session-content inspection/u);
                assert.match(
                    text,
                    /unavailable, wrong or unverified account\/BU context blocks only the dependent route/u
                );
                assert.match(text, /not unrelated native\/documentation work/u);
                assert.match(
                    text,
                    /Explain account-data access and establish authorization appropriate/u
                );
                assert.match(
                    text,
                    /guidance supplies no authorization and adds no custom consent ritual/u
                );
                assert.match(text, /Missing companions leave dependent checks unperformed/u);
                assert.match(
                    text,
                    /never authorize sends, runtime\/automation execution, contact mutations or row writes/u
                );
                assert.match(
                    text,
                    /neither validation completion nor local\/remote synchronization/u
                );
                assert.match(text, /server does not discover sibling servers or call them/u);
                assert.match(text, /No remote-write reconciliation automation/u);
                assert.match(
                    text,
                    /only to metadata-source tasks.*not require it for row-only or send-only goals/u
                );
                assert.match(text, /Retrieval-only work.*not a mandatory prior source read/u);
            }
        );
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
        await t.test(
            'vendor reconciliation prefers local edits and waits for confirmed completion',
            () => {
                assert.match(
                    text,
                    /Prefer local mcdev source edits\/build\/deploy guidance over direct vendor metadata edits/u
                );
                assert.match(
                    text,
                    /independently authorized vendor metadata create\/update.*first confirm remote completion.*actual discovered completion\/status contract.*matching account\/BU/u
                );
                assert.match(
                    text,
                    /Accepted, running, failed or unknown completion is not completed.*synchronization pending; do not retrieve or retry.*invent polling/u
                );
                assert.ok(
                    text.indexOf('first confirm remote completion') <
                        text.indexOf('After confirmed vendor completion')
                );
                assert.match(
                    text,
                    /After confirmed vendor completion, the next workflow step is exact local synchronization assessment/u
                );
                assert.match(
                    text,
                    /canonical workspaceRoot, credential, businessUnit, metadataType and literal externalKey.*exact metadata JSON and all extracted companion destinations/u
                );
            }
        );
        await t.test(
            'existing artifact scenarios disclose effects without repeated confirmation',
            () => {
                assert.match(
                    text,
                    /Assess and disclose clean, dirty and companion-only local artifacts, local edits and uncertainty; absence must be established, not guessed/u
                );
                assert.match(
                    text,
                    /Disclose native overwrite\/possible-deletion\/auth-persistence effects and honor existing authorization for its stated scope/u
                );
                assert.match(
                    text,
                    /Existing clean, dirty or companion-only artifacts do not automatically require renewed consent or repeated native-effects\/overwrite confirmation/u
                );
                assert.match(text, /Ordinary host tool approval remains host-controlled/u);
                assert.match(
                    text,
                    /host actually denies the retrieval, leave artifacts untouched and synchronization pending; do not bypass that denial/u
                );
                assert.doesNotMatch(
                    text,
                    /existing.*requires? (?:explicit |prior )?overwrite approval|ask.*overwrite approval before/u
                );
            }
        );
        await t.test(
            'uncertain identity destinations and results stay pending without broad fallback',
            () => {
                assert.match(
                    text,
                    /Uncertain identity, ambiguous key\/BU, unsupported or blocked resolution, or uncertain destination completeness\/existence leaves synchronization pending/u
                );
                assert.match(
                    text,
                    /ask only for genuinely unresolved choices or authority outside the existing scope/u
                );
                assert.match(
                    text,
                    /resolved supported exact query or Script Activity, use only \*\*retrieve_mcdev_query\*\* or \*\*retrieve_mcdev_script\*\*/u
                );
                assert.match(
                    text,
                    /Other metadata types remain pending with manual targeted native guidance, not an executable promise/u
                );
                assert.match(text, /No whole-type\/whole-BU or broad fallback retrieval/u);
                assert.match(
                    text,
                    /Rows, runtime, sends and contact changes have no invented retrievable metadata equivalent/u
                );
                assert.match(
                    text,
                    /failed, partial, unchanged or unverified results and unknown termination leave synchronization pending, never successful synchronization/u
                );
                assert.match(
                    text,
                    /Local materialization is local evidence only, not remote completeness.*never silently deploy stale artifacts/u
                );
                assert.match(
                    text,
                    /section performs no operations, server-to-server calls, automatic reconciliation, locks or polling/u
                );
            }
        );
        await t.test('security overwrite and execution limits remain explicit', () => {
            assert.match(text, /surface critical Git auth ignore\/tracked warnings first/u);
            assert.match(text, /Never read, search, hash, copy or expose auth\/log contents/u);
            assert.ok(tools.some((entry) => entry.name === 'diagnose_mcdev_retrieve_logs'));
            assert.match(
                text,
                /dedicated bounded normal-log reader is the sole log-content exception/u
            );
            assert.match(
                text,
                /never use general log\/auth\/session readers or expose raw records/u
            );
            assert.match(
                text,
                /--noLogFile: no-match is honest absence, never permission to rerun/u
            );
            assert.match(text, /manual investigation, not guessed findings or an API-log rerun/u);
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
                /A preview is not a dry-run or authorization and performs no execution/u
            );
            assert.match(
                text,
                /retrieve_mcdev_query.*fresh preparation and request-cancellable native retrieval/u
            );
            assert.match(text, /retrieve_mcdev_script.*metadata only.*never execute SSJS/u);
            assert.match(text, /JSON plus exactly one SSJS or HTML companion/u);
            assert.match(
                text,
                /caller-managed quiescence and native overwrite\/possible-deletion\/auth-persistence effects/u
            );
            assert.match(text, /no custom approval form or repeated overwrite confirmation/u);
            assert.match(text, /ordinary host tool approval remains host-controlled/u);
            assert.match(text, /Other command families remain guidance-only/u);
            assert.match(
                text,
                /No broad fallback retrieve, sends, publish or SQL\/runtime execution/u
            );
            assert.match(
                text,
                /Never retry unknown termination; operator reconciliation is required/u
            );
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
