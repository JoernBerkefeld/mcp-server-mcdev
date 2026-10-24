import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createQueryRetrieveCoordinator } from '../dist/query-retrieve-integration.js';
import {
    ACCEPTANCE_SELECTION,
    checkAcceptanceDependency,
    createQueryRetrieveAcceptanceServer,
} from '../scripts/query-retrieve-acceptance.mjs';

const prepared = () => ({
    ...ACCEPTANCE_SELECTION,
    mid: '518005426',
    snapshot: 'synthetic-snapshot',
    effects: ['synthetic only'],
});
const accept = (request) => ({
    action: 'accept',
    content: {
        confirmed: true,
        correlation: request.params.requestedSchema.properties.correlation.default,
    },
});
const formCapabilities = { elicitation: { form: {} } };
async function fixture(t, seams, handler = accept, capabilities = formCapabilities) {
    const server = createQueryRetrieveAcceptanceServer(seams);
    const client = new Client({ name: 'synthetic-acceptance', version: '0' }, { capabilities });
    if (handler && capabilities.elicitation) client.setRequestHandler(ElicitRequestSchema, handler);
    const frames = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    for (const transport of [clientTransport, serverTransport]) {
        const send = transport.send.bind(transport);
        transport.send = (message, options) => {
            frames.push({ message, options });
            return send(message, options);
        };
    }
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client, frames };
}
async function call(client, args = {}) {
    const result = await client.callTool({ name: 'accept_fixed_query_retrieve', arguments: args });
    return JSON.parse(result.content[0].text);
}

test('import is inert, fixed tool has no selectors and production stays isolated', async (t) => {
    const f = await fixture(t, { prepare: prepared, checkDependency: () => false });
    const tools = (await f.client.listTools()).tools;
    assert.deepEqual(
        tools.map((tool) => tool.name),
        ['accept_fixed_query_retrieve']
    );
    assert.deepEqual(tools[0].inputSchema.properties, {});
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(!pkg.files.includes('scripts'));
    assert.doesNotMatch(
        fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
        /query-retrieve-acceptance|accept_fixed_query_retrieve/
    );
    const source = fs.readFileSync(
        new URL('../scripts/query-retrieve-acceptance.mjs', import.meta.url),
        'utf8'
    );
    assert.match(source, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    assert.match(
        source,
        /createQueryRetrieveAcceptanceServer\(\)\.connect\(new StdioServerTransport\(\)\)/
    );
    assert.match(source, /cannot enforce filesystem exclusion/);
    const rejected = await f.client.callTool({
        name: 'accept_fixed_query_retrieve',
        arguments: { key: 'other', argv: ['deploy'] },
    });
    assert.equal(rejected.isError, true);
});

for (const field of ['projectRoot', 'credential', 'businessUnit', 'key', 'mid']) {
    test(`fresh preparation rejects ${field} drift before dependency or execution`, async (t) => {
        const f = await fixture(t, {
            prepare: (selection) => {
                assert.equal(selection, ACCEPTANCE_SELECTION);
                return { ...prepared(), [field]: 'wrong' };
            },
            checkDependency: () => assert.fail('no dependency collection'),
            run: () => assert.fail('no coordinator'),
        });
        assert.equal((await call(f.client)).outcome, 'selection-rejected');
    });
}

test('fresh dependency rejection and private exceptions never execute or leak', async (t) => {
    for (const checkDependency of [
        () => false,
        () => {
            throw new Error('SENSITIVE-auth-session');
        },
    ]) {
        const f = await fixture(t, {
            prepare: prepared,
            checkDependency,
            run: () => assert.fail('no execution'),
        });
        const result = await call(f.client);
        assert.ok(['dependency-rejected', 'acceptance-failed'].includes(result.outcome));
        assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|auth|session/);
    }
});

test('bounded same-BU metadata requires populated query reference and actual DE CustomerKey', () => {
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
        fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-acceptance-'))
    );
    fs.writeFileSync(path.join(root, '.owner'), randomUUID());
    // Retain owned synthetic fixtures; never touch live metadata or recursively clean.
    const queryDir = path.join(root, 'ssjs', 'MCDEV_Training_QA', 'query');
    const deDir = path.join(path.dirname(queryDir), 'dataExtension');
    fs.mkdirSync(queryDir, { recursive: true });
    fs.mkdirSync(deDir);
    const json = path.join(queryDir, `${ACCEPTANCE_SELECTION.key}.query-meta.json`);
    const deFile = path.join(deDir, 'ssjsg_is_de_1785491597439.dataExtension-meta.json');
    const input = { destinations: { json } };
    assert.throws(() => checkAcceptanceDependency(input));
    for (const reference of [undefined, '', 'wrong']) {
        fs.writeFileSync(
            json,
            JSON.stringify({ key: ACCEPTANCE_SELECTION.key, r__dataExtension_key: reference })
        );
        assert.equal(checkAcceptanceDependency(input), false);
    }
    fs.writeFileSync(
        json,
        JSON.stringify({
            key: ACCEPTANCE_SELECTION.key,
            r__dataExtension_key: 'ssjsg_is_de_1785491597439',
        })
    );
    assert.throws(() => checkAcceptanceDependency(input));
    fs.writeFileSync(deFile, JSON.stringify({ CustomerKey: 'wrong' }));
    assert.equal(checkAcceptanceDependency(input), false);
    fs.writeFileSync(deFile, JSON.stringify({ CustomerKey: 'ssjsg_is_de_1785491597439' }));
    assert.equal(checkAcceptanceDependency(input), true);
    fs.unlinkSync(deFile);
    fs.mkdirSync(deFile);
    assert.throws(() => checkAcceptanceDependency(input));
});

for (const action of ['decline', 'cancel', 'unsupported', 'drift']) {
    test(`genuine SDK/coordinator ${action} forwards incoming identity and launches zero`, async (t) => {
        let launches = 0;
        let context;
        const coordinator = createQueryRetrieveCoordinator({
            recheck: async () => ({ ready: action !== 'drift', snapshot: 'synthetic-snapshot' }),
            launch: async () => {
                launches++;
                assert.fail('no launch');
            },
        });
        const f = await fixture(
            t,
            {
                prepare: prepared,
                checkDependency: () => true,
                run: (value, incoming) => {
                    context = incoming;
                    return coordinator.runConfirmedQueryRetrieve(value, incoming);
                },
            },
            action === 'drift' ? accept : () => ({ action }),
            action === 'unsupported' ? {} : { elicitation: { form: {} } }
        );
        const value = await call(f.client);
        assert.equal(value.outcome, action === 'drift' ? 'blocked' : action);
        assert.equal(context.server, f.server.server);
        assert.equal(context.signal, context.extra.signal);
        assert.equal(
            context.extra.requestId,
            f.frames.find(({ message }) => message.method === 'tools/call').message.id
        );
        const sent = f.frames.find(({ message }) => message.method === 'elicitation/create');
        if (sent) assert.equal(sent.options.relatedRequestId, context.extra.requestId);
        assert.equal(launches, 0);
        assert.equal(value.processOutcome, 'not-started');
    });
}

test('actual incoming cancellation stops genuine coordinator before launch', async (t) => {
    let entered;
    let release;
    let finished;
    const waiting = new Promise((resolve) => {
        entered = resolve;
    });
    const completed = new Promise((resolve) => {
        finished = resolve;
    });
    let launches = 0;
    let incoming;
    const coordinator = createQueryRetrieveCoordinator({
        recheck: async () => ({ ready: true, snapshot: 'synthetic-snapshot' }),
        launch: async () => {
            launches++;
            assert.fail('no launch');
        },
    });
    const f = await fixture(
        t,
        {
            prepare: prepared,
            checkDependency: () => true,
            run: async (value, context) => {
                incoming = context;
                const result = await coordinator.runConfirmedQueryRetrieve(value, context);
                finished(result);
                return result;
            },
        },
        (request) =>
            new Promise((resolve) => {
                release = () => resolve(accept(request));
                entered();
            })
    );
    // Give elicitation a nonzero ID, matching existing SDK cancellation tests.
    await f.server.server.ping();
    const controller = new AbortController();
    const pending = f.client.callTool(
        { name: 'accept_fixed_query_retrieve', arguments: {} },
        undefined,
        { signal: controller.signal }
    );
    const rejected = assert.rejects(pending);
    await waiting;
    controller.abort();
    await rejected;
    assert.equal((await completed).outcome, 'cancel');
    assert.equal(incoming.signal, incoming.extra.signal);
    assert.equal(incoming.signal.aborted, true);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launches, 0);
});

test('unconfirmed termination is private and cannot retry', async (t) => {
    let runs = 0;
    const f = await fixture(t, {
        prepare: prepared,
        checkDependency: () => true,
        run: () => {
            runs++;
            return {
                outcome: 'termination-unconfirmed',
                materialization: 'partial',
                projectBlocked: true,
                process: { outcome: 'termination-unconfirmed', stderr: 'SENSITIVE' },
            };
        },
    });
    const result = await call(f.client);
    assert.equal(result.processOutcome, 'termination-unconfirmed');
    assert.equal(result.artifactClassification, 'partial');
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|stderr/);
    assert.equal((await call(f.client)).outcome, 'acceptance-stopped');
    assert.equal(runs, 1);
});

for (const materialization of ['unchanged-unverified', 'partial', 'local-materialization']) {
    test(`output separates process from ${materialization} and stops retry`, async (t) => {
        let calls = 0;
        const f = await fixture(t, {
            prepare: prepared,
            checkDependency: () => true,
            run: () => {
                calls++;
                return {
                    outcome: 'exited',
                    materialization,
                    process: { outcome: 'exited', stdout: 'SENSITIVE', exitCode: 0 },
                    remoteCompletenessVerified: true,
                };
            },
        });
        const value = await call(f.client);
        assert.equal(value.processOutcome, 'exited');
        assert.equal(value.artifactClassification, materialization);
        assert.equal(value.remoteCompletenessVerified, false);
        assert.equal(value.retryAllowed, false);
        assert.doesNotMatch(JSON.stringify(value), /SENSITIVE|success|stdout|exitCode/);
        assert.equal((await call(f.client)).outcome, 'acceptance-stopped');
        assert.equal(calls, 1);
    });
}
