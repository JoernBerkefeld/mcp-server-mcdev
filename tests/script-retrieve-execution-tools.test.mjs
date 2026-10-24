import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createScriptRetrieveExecutor } from '../dist/script-retrieve-execution.js';
import {
    createQueryRetrieveCoordinator,
    prepareScriptRetrieve,
} from '../dist/query-retrieve-integration.js';

assert.ok(process.env.TEMP);
for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (!value) continue;
    assert.ok(path.isAbsolute(value));
    assert.equal(
        path
            .resolve(value)
            .replace(/[\\/]+$/u, '')
            .toLowerCase(),
        String.raw`f:\temp`
    );
}
const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-script-executor-'))
);
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
// Retain owned synthetic fixtures; no recursive cleanup or native execution.
fs.writeFileSync(path.join(root, '.gitignore'), '.mcdev-auth.json\n');
fs.writeFileSync(
    path.join(root, '.mcdevrc.json'),
    JSON.stringify({
        version: '10.1.0',
        credentials: { demo: { eid: '1000', businessUnits: { QA: '1001' } } },
        directories: { retrieve: 'retrieved/' },
        metaDataTypes: { documentOnRetrieve: [] },
    })
);
for (const args of [
    ['init', '--quiet'],
    ['config', '--local', 'user.name', 'Jörn Berkefeld'],
    ['config', '--local', 'user.email', 'joern.berkefeld@gmail.com'],
]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr);
}
const selection = { workspaceRoot: root, credential: 'demo', businessUnit: 'QA', key: 'Script_1' };
const sentinel = 'PRIVATE_SCRIPT_EXECUTOR_SENTINEL';
const signal = () => new AbortController().signal;
const ready = async (prepared) => ({ ready: true, snapshot: prepared.snapshot });
const processResult = {
    outcome: 'exited',
    stopReason: null,
    started: true,
    directChildClosed: true,
    descendantsStopped: false,
    exitCode: 0,
    exitSignal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    retrievalVerified: false,
    partialEffectsPossible: true,
};
function checkPublic(result) {
    assert.deepEqual(Object.keys(result), [
        'outcome',
        'processOutcome',
        'artifactClassification',
        'projectBlocked',
        'remoteCompletenessVerified',
    ]);
    assert.equal(result.remoteCompletenessVerified, false);
    assert.ok(Object.isFrozen(result));
    assert.doesNotMatch(
        JSON.stringify(result),
        /PRIVATE_SCRIPT|stdout|stderr|exitCode|projectRoot|runtime|snapshot/u
    );
}

test('Script adapter freshly prepares only four selectors and forwards actual request signal', async () => {
    let preparations = 0;
    const requestSignal = signal();
    const execute = createScriptRetrieveExecutor({
        prepare(input) {
            preparations++;
            assert.deepEqual(input, {
                projectRoot: root,
                credential: 'demo',
                businessUnit: 'QA',
                key: 'Script_1',
            });
            return { snapshot: preparations };
        },
        async run(prepared, context) {
            assert.equal(prepared.snapshot, preparations);
            assert.equal(context.signal, requestSignal);
            assert.equal(context.processTimeoutMs, 100);
            return {
                outcome: 'exited',
                materialization: 'local-materialization',
                projectBlocked: false,
                process: { ...processResult, stdout: sentinel },
                prepared: sentinel,
            };
        },
    });
    for (let i = 0; i < 2; i++) {
        const result = await execute(selection, { signal: requestSignal, processTimeoutMs: 100 });
        checkPublic(result);
        assert.equal(result.artifactClassification, 'local-materialization');
    }
    assert.equal(preparations, 2);
});

test('Script adapter suppresses exceptions, rejects extra arguments before preparation and allowlists results', async () => {
    for (const seam of ['prepare', 'run']) {
        const execute = createScriptRetrieveExecutor({
            prepare: () => ({}),
            run: async () => ({}),
            [seam]: () => {
                throw new Error(sentinel);
            },
        });
        await assert.rejects(execute(selection, { signal: signal() }), {
            message: 'Script retrieve unavailable.',
        });
    }
    let prepared = false;
    const execute = createScriptRetrieveExecutor({
        prepare: () => {
            prepared = true;
            return {};
        },
        run: async () => ({
            outcome: sentinel,
            process: { outcome: sentinel },
            materialization: sentinel,
            projectBlocked: sentinel,
            remoteCompletenessVerified: true,
        }),
    });
    for (const extra of [
        { metadataType: 'query' },
        { approved: true },
        { processTimeoutMs: 1 },
        { previewToken: sentinel },
    ]) {
        await assert.rejects(execute({ ...selection, ...extra }, { signal: signal() }), {
            message: 'Script retrieve unavailable.',
        });
    }
    assert.equal(prepared, false);
    const result = await execute(selection, { signal: signal() });
    checkPublic(result);
    assert.deepEqual(result, {
        outcome: 'failed',
        processOutcome: 'invalid-input',
        artifactClassification: 'unverified',
        projectBlocked: false,
        remoteCompletenessVerified: false,
    });
    for (const outcome of [
        'project-busy',
        'cancel',
        'blocked',
        'failed',
        'invalid-input',
        'exited',
        'spawn-failed',
        'cancelled',
        'timed-out',
        'output-limit',
        'termination-unconfirmed',
    ]) {
        for (const materialization of [
            'local-materialization',
            'unchanged-unverified',
            'partial',
            'unverified',
        ]) {
            const result = await createScriptRetrieveExecutor({
                prepare: () => ({}),
                run: async () => ({
                    outcome,
                    materialization,
                    projectBlocked: true,
                    process: null,
                }),
            })(selection, { signal: signal() });
            checkPublic(result);
            assert.equal(result.outcome, outcome);
            assert.equal(result.artifactClassification, materialization);
            assert.equal(result.processOutcome, null);
            assert.equal(result.projectBlocked, true);
        }
    }
});

test('Script adapter reaches shared coordinator cancellation, drift, cross-family guard and settlement', async () => {
    let launches = 0;
    const coordinator = createQueryRetrieveCoordinator({
        recheckScript: ready,
        launch: async () => {
            launches++;
            return processResult;
        },
    });
    const execute = createScriptRetrieveExecutor({ run: coordinator.runScriptRetrieve });
    const controller = new AbortController();
    controller.abort();
    assert.equal((await execute(selection, { signal: controller.signal })).outcome, 'cancel');
    const drift = createQueryRetrieveCoordinator({
        recheckScript: async () => ({ ready: false, snapshot: '' }),
        launch: async () => {
            launches++;
            return processResult;
        },
    });
    assert.equal(
        (
            await createScriptRetrieveExecutor({ run: drift.runScriptRetrieve })(selection, {
                signal: signal(),
            })
        ).outcome,
        'blocked'
    );
    assert.equal(launches, 0);
    let settle;
    let entered;
    const started = new Promise((resolve) => {
        entered = resolve;
    });
    const holding = createQueryRetrieveCoordinator({
        recheckScript: ready,
        launch: () => {
            entered();
            return new Promise((resolve) => {
                settle = resolve;
            });
        },
    });
    const held = createScriptRetrieveExecutor({ run: holding.runScriptRetrieve })(selection, {
        signal: signal(),
    });
    await started;
    assert.equal((await execute(selection, { signal: signal() })).outcome, 'project-busy');
    // The shared guard also excludes Query without invoking its default native launcher.
    const { createQueryRetrieveExecutor } = await import('../dist/query-retrieve-execution.js');
    assert.equal(
        (await createQueryRetrieveExecutor()(selection, { signal: signal() })).outcome,
        'project-busy'
    );
    settle({ ...processResult, outcome: 'termination-unconfirmed' });
    const blocked = await held;
    checkPublic(blocked);
    assert.equal(blocked.processOutcome, 'termination-unconfirmed');
    assert.equal(blocked.projectBlocked, true);
    assert.equal((await execute(selection, { signal: signal() })).projectBlocked, true);
    assert.equal(holding.acknowledgeExternalReconciliation(root), true);
    for (const extension of ['ssjs', 'html']) {
        const selected = { ...selection, key: `Script_${extension}` };
        const prepared = prepareScriptRetrieve({ ...selected, projectRoot: root });
        const writing = createQueryRetrieveCoordinator({
            recheckScript: ready,
            launch: async () => {
                fs.mkdirSync(path.dirname(prepared.destinations.json), { recursive: true });
                fs.writeFileSync(prepared.destinations.json, JSON.stringify({ key: selected.key }));
                fs.writeFileSync(
                    prepared.destinations[extension],
                    extension === 'ssjs'
                        ? '/* synthetic source, never executed */'
                        : '<p>Synthetic source</p>'
                );
                return processResult;
            },
        });
        const result = await createScriptRetrieveExecutor({ run: writing.runScriptRetrieve })(
            selected,
            { signal: signal() }
        );
        checkPublic(result);
        assert.equal(result.artifactClassification, 'local-materialization');
        assert.equal(
            (await execute(selected, { signal: signal() })).artifactClassification,
            'unchanged-unverified'
        );
    }
});

test(
    'production Script protocol is strict, metadata-only and safe without elicitation capability',
    { timeout: 30_000 },
    async () => {
        const client = new Client({ name: 'script-execution-test', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            cwd: root,
            stderr: 'pipe',
        });
        try {
            await client.connect(transport);
            const { tools } = await client.listTools();
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
            const tool = tools.find((entry) => entry.name === 'retrieve_mcdev_script');
            assert.ok(tool);
            assert.ok(tools.some((entry) => entry.name === 'retrieve_mcdev_query'));
            assert.ok(
                !tools.some((entry) => /accept_fixed|prepare_mcdev_script/u.test(entry.name))
            );
            const selectors = ['workspaceRoot', 'credential', 'businessUnit', 'key'];
            assert.deepEqual(tool.inputSchema.required, selectors);
            assert.deepEqual(Object.keys(tool.inputSchema.properties), selectors);
            assert.equal(tool.inputSchema.additionalProperties, false);
            for (const property of Object.values(tool.inputSchema.properties))
                assert.equal(property.type, 'string');
            assert.deepEqual(tool.annotations, {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            });
            for (const phrase of [
                'never execute SSJS',
                'no preview token or custom approval form',
                'paginated collection reads',
                'local key filtering',
                'JSON plus exactly one SSJS or HTML',
                'No automatic retry',
                'remote completeness',
            ])
                assert.ok(tool.description.includes(phrase), phrase);
            const before = fs.readdirSync(root);
            for (const args of [
                {},
                { ...selection, [sentinel]: sentinel },
                { ...selection, key: { [sentinel]: sentinel } },
                { ...selection, credential: [sentinel] },
                { ...selection, businessUnit: null },
                { ...selection, workspaceRoot: 5 },
                { ...selection, key: '*' },
                { ...selection, credential: sentinel },
                { ...selection, businessUnit: sentinel },
                { ...selection, key: 'one,two' },
                { ...selection, workspaceRoot: 'relative-private-root' },
            ]) {
                const result = await client.callTool({ name: tool.name, arguments: args });
                assert.equal(result.isError, true);
                assert.match(result.content[0].text, /Script retrieve unavailable\./u);
                assert.doesNotMatch(
                    JSON.stringify(result),
                    /PRIVATE_SCRIPT|relative-private-root|ENOENT|ZodError/u
                );
            }
            assert.deepEqual(fs.readdirSync(root), before);
        } finally {
            await client.close();
        }
    }
);
