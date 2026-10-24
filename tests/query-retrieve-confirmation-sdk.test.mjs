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
    projectRoot: String.raw`C:\synthetic\invented-project`,
    credential: 'demo',
    businessUnit: 'QA',
    mid: '123',
    key: 'sample',
    snapshot: 'synthetic-inspection-only',
});

async function fixture(
    t,
    handler,
    {
        capabilities = { elicitation: { form: {} } },
        timeoutMs = 1000,
        warmUp = false,
        observeBudget = () => {},
        beforeConfirm = () => {},
    } = {}
) {
    const server = new McpServer({ name: 'confirmation-test-only', version: '0' });
    const client = new Client({ name: 'confirmation-client', version: '0' }, { capabilities });
    const frames = [];
    const completed = [];
    const deliveries = [];
    const observers = new Set();
    const completion = Promise.withResolvers();
    const delivered = (predicate) => {
        const existing = deliveries.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve) => {
            const observe = (frame) => {
                if (!predicate(frame)) return;
                observers.delete(observe);
                resolve(frame);
            };
            observers.add(observe);
        });
    };
    let executions = 0;
    const elicitInput = server.server.elicitInput.bind(server.server);
    t.mock.method(server.server, 'elicitInput', (request, options) => {
        observeBudget(options);
        return elicitInput(request, options);
    });
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
        beforeConfirm();
        const value = await gate.confirm();
        completed.push(value);
        completion.resolve(value);
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
            const frame = { side, message, options };
            frames.push(frame);
            await send(message, options);
            deliveries.push(frame);
            for (const observe of observers) observe(frame);
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
    return {
        client,
        frames,
        completed,
        completion: completion.promise,
        delivered,
        executions: () => executions,
    };
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

async function terminalRace(t, { mode, warmUp }) {
    const cancelled = mode === 'cancel';
    const sdkFirst = mode === 'sdk-first';
    const waiting = Promise.withResolvers();
    const handlerReturned = Promise.withResolvers();
    let release;
    let handlerSignal;
    let forwardedBudget;
    let dateReads = 0;
    const durations = [];
    const f = await fixture(
        t,
        (request, extra) => {
            handlerSignal = extra.signal;
            return new Promise((resolve) => {
                release = () => resolve(accepted(request));
                waiting.resolve();
            }).then((response) => {
                handlerReturned.resolve();
                return response;
            });
        },
        {
            timeoutMs: 50,
            warmUp,
            observeBudget: (options) => {
                forwardedBudget = options.timeout;
                assert.equal(options.maxTotalTimeout, forwardedBudget);
            },
            beforeConfirm: () => {
                // Incoming-request entry sets the independent deadline baseline.
                // Budget calculation precedes the SDK adapter wrapper.
                const schedule = globalThis.setTimeout;
                t.mock.method(globalThis, 'setTimeout', (callback, duration, ...args) => {
                    durations.push(duration);
                    return schedule(callback, duration, ...args);
                });
                t.mock.method(Date, 'now', () => 1000 + (sdkFirst && dateReads++ > 0 ? 1 : 0));
            },
        }
    );
    const controller = new AbortController();
    // Install after connection handshake but before the outer SDK request creates
    // its timer, so teardown cannot strand a real timer behind mock clearTimeout.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    try {
        const pending = call(f.client, { signal: controller.signal });
        const rejected = cancelled ? assert.rejects(pending) : undefined;
        await waiting.promise;
        assert.equal(durations[0], 50);
        assert.equal(forwardedBudget, sdkFirst ? 49 : 50);
        assert.deepEqual(durations, [50, forwardedBudget]);
        const elicitation = f.frames.find(({ message }) => message.method === 'elicitation/create');
        if (!warmUp) assert.equal(elicitation.message.id, 0);
        if (cancelled) {
            controller.abort('SENSITIVE-parent-reason');
            await rejected;
        } else {
            // The timer clock has not moved during independent Date.now budget reads.
            t.mock.timers.tick(sdkFirst ? 49 : 50);
            assert.equal((await pending).outcome, 'timeout');
        }
        const notification = await f.delivered(
            ({ side, message }) => side === 'server' && message.method === 'notifications/cancelled'
        );
        assert.equal(notification.message.params.requestId, elicitation.message.id);
        assert.equal(
            notification.message.params.reason,
            sdkFirst
                ? 'McpError: MCP error -32001: Request timed out'
                : 'query_confirmation_stopped'
        );
        const terminal = await f.completion;
        assert.equal(handlerSignal.aborted, warmUp);
        assert.equal(f.completed.length, 1);
        assert.equal(terminal.outcome, cancelled ? 'cancel' : 'timeout');
        assert.equal(terminal.executionEnabled, false);
        assert.ok(Object.isFrozen(terminal));
        release();
        // Wait for the real SDK handler's response to be delivered, rather than
        // assuming a single setImmediate happens after its promise chain.
        await handlerReturned.promise;
        if (!warmUp) {
            await f.delivered(
                ({ side, message }) =>
                    side === 'client' &&
                    message.id === elicitation.message.id &&
                    ('result' in message || 'error' in message)
            );
        }
        // Aborted nonzero handlers deliberately suppress SDK response delivery.
        assert.equal(f.completed.length, 1);
        assert.equal(f.completed[0], terminal);
        assert.equal(f.executions(), 0);
    } finally {
        release?.();
        t.mock.restoreAll();
        t.mock.timers.reset();
    }
}

for (const warmUp of [true, false]) {
    for (const mode of ['gate-first', 'sdk-first', 'cancel']) {
        test(
            `SDK ${warmUp ? 'nonzero ID' : 'ID0'} ${mode} is terminal and rejects late acceptance`,
            { timeout: 2000, concurrency: false },
            (t) => terminalRace(t, { mode, warmUp })
        );
    }
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
