import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createQueryRetrieveExecutor } from '../dist/query-retrieve-execution.js';
import {
    createQueryRetrieveCoordinator,
    prepareQueryRetrieve,
} from '../dist/query-retrieve-integration.js';

validateTempEnvironment();
const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-query-executor-'))
);
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
// Retain synthetic fixtures; no cleanup, authentication/session contents or native execution.
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
const selection = { workspaceRoot: root, credential: 'demo', businessUnit: 'QA', key: 'Sample_1' };
const sentinel = 'PRIVATE_SYNTHETIC_EXECUTOR_SENTINEL';
const signal = () => new AbortController().signal;
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
const publicKeys = [
    'outcome',
    'processOutcome',
    'artifactClassification',
    'projectBlocked',
    'remoteCompletenessVerified',
];
function checkPublic(result) {
    assert.deepEqual(Object.keys(result), publicKeys);
    assert.equal(result.remoteCompletenessVerified, false);
    assert.ok(Object.isFrozen(result));
    assert.doesNotMatch(
        JSON.stringify(result),
        /PRIVATE_SYNTHETIC|stdout|stderr|exitCode|projectRoot|runtime/u
    );
}

test('adapter freshly prepares exact selectors and forwards the actual cancellation signal', async () => {
    let preparations = 0;
    const requestSignal = signal();
    const execute = createQueryRetrieveExecutor({
        prepare(input) {
            preparations++;
            assert.deepEqual(input, {
                projectRoot: root,
                credential: 'demo',
                businessUnit: 'QA',
                key: 'Sample_1',
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
                remoteCompletenessVerified: false,
                process: { ...processResult, stdout: sentinel, privateConfig: sentinel },
            };
        },
    });
    for (let i = 0; i < 2; i++) {
        const result = await execute(selection, { signal: requestSignal, processTimeoutMs: 100 });
        checkPublic(result);
        assert.deepEqual(result, {
            outcome: 'exited',
            processOutcome: 'exited',
            artifactClassification: 'local-materialization',
            projectBlocked: false,
            remoteCompletenessVerified: false,
        });
    }
    assert.equal(preparations, 2);
});

test('adapter excludes unknown runtime fields and fixed failures hide private exceptions', async () => {
    for (const seam of ['prepare', 'run']) {
        const execute = createQueryRetrieveExecutor({
            prepare: () => ({}),
            run: async () => ({}),
            [seam]: () => {
                throw new Error(sentinel);
            },
        });
        await assert.rejects(execute(selection, { signal: signal() }), {
            message: 'Query retrieve unavailable.',
        });
    }
    const execute = createQueryRetrieveExecutor({
        prepare: () => ({}),
        run: async () => ({
            outcome: sentinel,
            materialization: sentinel,
            projectBlocked: sentinel,
            remoteCompletenessVerified: true,
            process: { outcome: sentinel },
        }),
    });
    const result = await execute(selection, { signal: signal() });
    checkPublic(result);
    assert.deepEqual(result, {
        outcome: 'failed',
        processOutcome: 'invalid-input',
        artifactClassification: 'unverified',
        projectBlocked: false,
        remoteCompletenessVerified: false,
    });
});

test('adapter preserves every supervised outcome and honest artifact classification', async () => {
    for (const outcome of [
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
            const execute = createQueryRetrieveExecutor({
                prepare: () => ({}),
                run: async () => ({
                    outcome,
                    materialization,
                    projectBlocked: outcome === 'termination-unconfirmed',
                    remoteCompletenessVerified: false,
                    process: { ...processResult, outcome },
                }),
            });
            const result = await execute(selection, { signal: signal() });
            checkPublic(result);
            assert.equal(result.outcome, outcome);
            assert.equal(result.processOutcome, outcome);
            assert.equal(result.artifactClassification, materialization);
            assert.equal(result.projectBlocked, outcome === 'termination-unconfirmed');
        }
    }
});

test('adapter uses direct coordinator guard, final drift, cancellation, settlement and blocked latch', async () => {
    const controller = new AbortController();
    controller.abort();
    let launches = 0;
    const coordinator = createQueryRetrieveCoordinator({
        recheck: async (prepared) => ({ ready: true, snapshot: prepared.snapshot }),
        launch: async () => {
            launches++;
            return processResult;
        },
    });
    const execute = createQueryRetrieveExecutor({ run: coordinator.runQueryRetrieve });
    const cancelled = await execute(selection, { signal: controller.signal });
    checkPublic(cancelled);
    assert.equal(cancelled.outcome, 'cancel');
    assert.equal(cancelled.processOutcome, null);
    const drift = createQueryRetrieveCoordinator({
        recheck: async () => ({ ready: false, snapshot: '' }),
        launch: async () => {
            launches++;
            return processResult;
        },
    });
    assert.equal(
        (
            await createQueryRetrieveExecutor({ run: drift.runQueryRetrieve })(selection, {
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
        recheck: async (prepared) => ({ ready: true, snapshot: prepared.snapshot }),
        launch: () => {
            entered();
            return new Promise((resolve) => {
                settle = resolve;
            });
        },
    });
    const held = createQueryRetrieveExecutor({ run: holding.runQueryRetrieve })(selection, {
        signal: signal(),
    });
    await started;
    assert.equal((await execute(selection, { signal: signal() })).outcome, 'project-busy');
    settle({ ...processResult, outcome: 'termination-unconfirmed' });
    const blocked = await held;
    checkPublic(blocked);
    assert.equal(blocked.projectBlocked, true);
    assert.equal((await execute(selection, { signal: signal() })).projectBlocked, true);
    assert.equal(holding.acknowledgeExternalReconciliation(root), true);
    const prepared = prepareQueryRetrieve({ ...selection, projectRoot: root });
    const writing = createQueryRetrieveCoordinator({
        recheck: async (value) => ({ ready: true, snapshot: value.snapshot }),
        launch: async () => {
            fs.mkdirSync(path.dirname(prepared.destinations.json), { recursive: true });
            fs.writeFileSync(prepared.destinations.json, JSON.stringify({ key: selection.key }));
            fs.writeFileSync(prepared.destinations.sql, 'SELECT 1');
            return processResult;
        },
    });
    const materialized = await createQueryRetrieveExecutor({ run: writing.runQueryRetrieve })(
        selection,
        { signal: signal() }
    );
    checkPublic(materialized);
    assert.equal(materialized.artifactClassification, 'local-materialization');
    assert.equal(
        (await execute(selection, { signal: signal() })).artifactClassification,
        'unchanged-unverified'
    );
});

test(
    'production stdio inventory and strict sanitized execution schema without elicitation capability',
    { timeout: 30_000 },
    async () => {
        const client = new Client({ name: 'production-query-test', version: '1.0.0' });
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
            assert.ok(tools.some((entry) => entry.name === 'retrieve_mcdev_script'));
            assert.ok(!tools.some((entry) => entry.name === 'accept_fixed_query_retrieve'));
            const tool = tools.find((entry) => entry.name === 'retrieve_mcdev_query');
            assert.ok(tool);
            assert.deepEqual(tool.inputSchema.required, [
                'workspaceRoot',
                'credential',
                'businessUnit',
                'key',
            ]);
            assert.deepEqual(Object.keys(tool.inputSchema.properties), tool.inputSchema.required);
            assert.equal(tool.inputSchema.additionalProperties, false);
            for (const property of Object.values(tool.inputSchema.properties))
                assert.equal(property.type, 'string');
            assert.deepEqual(tool.annotations, {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            });
            assert.match(tool.description, /no preview token or custom approval form/iu);
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
                assert.match(result.content[0].text, /Query retrieve unavailable\./u);
                assert.doesNotMatch(
                    JSON.stringify(result),
                    /PRIVATE_SYNTHETIC|relative-private-root|ENOENT|ZodError/u
                );
            }
            assert.deepEqual(fs.readdirSync(root), before);
        } finally {
            await client.close();
        }
    }
);
