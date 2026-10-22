import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
    createQueryRetrieveConfirmation,
    createQueryRetrieveSdkElicitor,
} from '../dist/query-retrieve-confirmation.js';

const accepted = (request) => ({
    action: 'accept',
    content: {
        confirmed: true,
        correlation: request.params.requestedSchema.properties.correlation.default,
    },
});
const input = () => ({
    projectRoot: String.raw`F:\Temp\invented-project`,
    credential: 'demo',
    businessUnit: 'QA',
    mid: '123',
    key: 'sample',
    snapshot: 'synthetic-inspection-only',
});

async function fixture(
    t,
    handler,
    { capabilities = { elicitation: { form: {} } }, timeoutMs = 1000, warmUp = false } = {}
) {
    const server = new McpServer({ name: 'confirmation-test-only', version: '0' });
    const client = new Client({ name: 'confirmation-client', version: '0' }, { capabilities });
    const frames = [];
    const completed = [];
    let executions = 0;
    server.registerTool('test_confirmation', { inputSchema: {} }, async (_args, extra) => {
        const gate = createQueryRetrieveConfirmation(input(), {
            signal: extra.signal,
            timeoutMs,
            elicit: createQueryRetrieveSdkElicitor(server.server, extra),
            recheck: async (operation) => ({ snapshot: operation.snapshot, ready: true }),
            execute: async () => {
                executions++;
            },
        });
        const value = await gate.confirm();
        completed.push(value);
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    });
    if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Observe send arguments without replacing SDK request handling or callbacks.
    for (const [side, transport] of [
        ['client', clientTransport],
        ['server', serverTransport],
    ]) {
        const send = transport.send.bind(transport);
        transport.send = async (message, options) => {
            frames.push({ side, message, options });
            return send(message, options);
        };
    }
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Opt in only when exercising the SDK's nonzero-ID cancellation propagation.
    if (warmUp) await server.server.ping();
    return { client, frames, completed, executions: () => executions };
}
async function call(client, options) {
    const response = await client.callTool(
        { name: 'test_confirmation', arguments: {} },
        undefined,
        options
    );
    const value = JSON.parse(response.content[0].text);
    assert.equal(value.executionEnabled, false);
    assert.equal(value.consentBasis, 'trusted-client-assertion-not-independent-human-attestation');
    return value;
}

for (const [action, outcome] of [
    ['accept', 'blocked'],
    ['decline', 'decline'],
    ['cancel', 'cancel'],
]) {
    test(`SDK ${action} exercises actual blocked gate and request association`, async (t) => {
        const f = await fixture(t, (request) =>
            action === 'accept' ? accepted(request) : { action }
        );
        assert.equal((await call(f.client)).outcome, outcome);
        assert.equal(f.executions(), 0);
        const incoming = f.frames.find(({ message }) => message.method === 'tools/call');
        const sent = f.frames.find(({ message }) => message.method === 'elicitation/create');
        assert.equal(sent.options.relatedRequestId, incoming.message.id);
        assert.equal(sent.options.relatedTask, undefined);
        const descriptor = JSON.parse(sent.message.params.message.split('effects: ')[1]);
        assert.deepEqual(descriptor, {
            ...input(),
            command: 'retrieve',
            type: 'query',
            reviewedVersion: '10.1.0',
            mode: 'blocked-contract',
            effects: descriptor.effects,
        });
        assert.ok(descriptor.effects.length > 0);
        assert.equal(sent.message.params.mode, 'form');
    });
}
for (const capabilities of [{}, { elicitation: { url: {} } }]) {
    test(`SDK missing form capability sends no request ${JSON.stringify(capabilities)}`, async (t) => {
        const f = await fixture(t, undefined, { capabilities });
        assert.equal((await call(f.client)).outcome, 'unsupported');
        assert.ok(!f.frames.some(({ message }) => message.method === 'elicitation/create'));
        assert.equal(f.executions(), 0);
    });
}
for (const [name, reply] of [
    ['missing content', () => ({ action: 'accept' })],
    [
        'form validation',
        () => ({ action: 'accept', content: { confirmed: 'SENSITIVE', correlation: 7 } }),
    ],
    ['result validation', () => ({ action: 'SENSITIVE' })],
    [
        'false confirmation',
        (request) => ({
            ...accepted(request),
            content: { ...accepted(request).content, confirmed: false },
        }),
    ],
    [
        'wrong correlation',
        () => ({ action: 'accept', content: { confirmed: true, correlation: 'SENSITIVE' } }),
    ],
]) {
    test(`SDK ${name} remains invalid without exception text`, async (t) => {
        const f = await fixture(t, reply);
        const value = await call(f.client);
        assert.equal(value.outcome, 'invalid');
        assert.doesNotMatch(JSON.stringify(value), /SENSITIVE|validation|stack/);
        assert.equal(f.executions(), 0);
    });
}
test('SDK client error remains fixed failed diagnostic', async (t) => {
    const f = await fixture(t, () => {
        throw new Error('SENSITIVE-error');
    });
    assert.deepEqual(await call(f.client), {
        outcome: 'failed',
        executionEnabled: false,
        consentBasis: 'trusted-client-assertion-not-independent-human-attestation',
    });
    assert.equal(f.executions(), 0);
});

for (const cancelled of [false, true]) {
    test(
        `SDK ${cancelled ? 'incoming cancellation' : 'deadline'} cancels pending elicitation and rejects late acceptance`,
        { timeout: 2000 },
        async (t) => {
            let release;
            let entered;
            let stopped;
            const waiting = new Promise((resolve) => {
                entered = resolve;
            });
            const cancellation = new Promise((resolve) => {
                stopped = resolve;
            });
            const f = await fixture(
                t,
                (request, extra) =>
                    new Promise((resolve) => {
                        extra.signal.addEventListener('abort', stopped, { once: true });
                        release = () => resolve(accepted(request));
                        entered();
                    }),
                { timeoutMs: cancelled ? 1000 : 50, warmUp: true }
            );
            const controller = new AbortController();
            const pending = call(f.client, { signal: controller.signal });
            // Attach rejection handling before aborting the actual SDK tools/call.
            const rejected = cancelled ? assert.rejects(pending) : undefined;
            await waiting;
            if (cancelled) controller.abort('SENSITIVE-parent-reason');
            else assert.equal((await pending).outcome, 'timeout');
            await cancellation;
            if (rejected) await rejected;
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(f.completed[0].outcome, cancelled ? 'cancel' : 'timeout');
            const elicitation = f.frames.find(
                ({ message }) => message.method === 'elicitation/create'
            );
            const notification = f.frames.find(
                ({ side, message }) =>
                    side === 'server' && message.method === 'notifications/cancelled'
            );
            assert.equal(notification.message.params.requestId, elicitation.message.id);
            assert.equal(notification.message.params.reason, 'query_confirmation_stopped');
            release();
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(f.completed.length, 1);
            assert.equal(f.executions(), 0);
        }
    );
}
for (const cancelled of [false, true]) {
    test(
        `SDK ID0 ${cancelled ? 'cancel' : 'timeout'} is gate-terminal despite unpropagated handler cancellation`,
        { timeout: 2000 },
        async (t) => {
            let release;
            let handlerSignal;
            let entered;
            const waiting = new Promise((resolve) => {
                entered = resolve;
            });
            const f = await fixture(
                t,
                (request, extra) =>
                    new Promise((resolve) => {
                        handlerSignal = extra.signal;
                        release = () => resolve(accepted(request));
                        entered();
                    }),
                { timeoutMs: cancelled ? 500 : 50 }
            );
            t.after(() => release?.());
            const controller = new AbortController();
            const pending = call(f.client, { signal: controller.signal });
            const rejected = cancelled ? assert.rejects(pending) : undefined;
            await waiting;
            const elicitation = f.frames.find(
                ({ message }) => message.method === 'elicitation/create'
            );
            assert.equal(elicitation.message.id, 0);
            if (cancelled) {
                controller.abort('SENSITIVE-parent-reason');
                await rejected;
            } else {
                assert.equal((await pending).outcome, 'timeout');
            }
            // Drain delivery without waiting on the SDK's broken ID0 abort signal.
            await new Promise((resolve) => setImmediate(resolve));
            const notification = f.frames.find(
                ({ side, message }) =>
                    side === 'server' && message.method === 'notifications/cancelled'
            );
            assert.equal(notification.message.params.requestId, 0);
            assert.equal(notification.message.params.reason, 'query_confirmation_stopped');
            assert.equal(handlerSignal.aborted, false);
            assert.equal(f.completed.length, 1);
            const terminal = f.completed[0];
            assert.equal(terminal.outcome, cancelled ? 'cancel' : 'timeout');
            assert.equal(terminal.executionEnabled, false);
            release();
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(f.completed.length, 1);
            assert.equal(f.completed[0], terminal);
            assert.equal(f.executions(), 0);
        }
    );
}

test('concurrent SDK calls cannot exchange operation confirmation correlations', async (t) => {
    const waiting = [];
    const f = await fixture(
        t,
        (request) =>
            new Promise((resolve) => {
                waiting.push({ request, resolve });
                if (waiting.length === 2) {
                    waiting[0].resolve(accepted(waiting[1].request));
                    waiting[1].resolve(accepted(waiting[0].request));
                }
            })
    );
    assert.deepEqual(
        (await Promise.all([call(f.client), call(f.client)])).map(({ outcome }) => outcome),
        ['invalid', 'invalid']
    );
    const sent = f.frames.filter(({ message }) => message.method === 'elicitation/create');
    assert.notEqual(sent[0].options.relatedRequestId, sent[1].options.relatedRequestId);
    assert.equal(f.executions(), 0);
});
