import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ElicitRequestSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
    createProbeServer,
    observeProbeTransport,
    runProbe,
} from '../scripts/elicitation-probe.mjs';

function accepted(request) {
    return {
        action: 'accept',
        content: {
            confirmed: true,
            correlation: request.params.requestedSchema.properties.correlation.default,
        },
    };
}

async function fixture(
    t,
    handler,
    { capabilities = { elicitation: { form: {} } }, timeoutMs = 1000 } = {}
) {
    const diagnostics = [];
    const diagnostic = (entry) => diagnostics.push(entry);
    const server = createProbeServer({ timeoutMs, diagnostic });
    const client = new Client({ name: 'synthetic-probe-client', version: '1' }, { capabilities });
    if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(observeProbeTransport(serverTransport, diagnostic));
    await client.connect(clientTransport);
    return { client, server, clientTransport, diagnostics };
}

async function call(client) {
    const response = await client.callTool({ name: 'probe_elicitation', arguments: {} });
    const value = JSON.parse(response.content[0].text);
    assert.equal(value.executionEnabled, false);
    assert.equal(value.consentBasis, 'trusted-client-assertion-not-independent-human-attestation');
    return value;
}

for (const action of ['accept', 'decline', 'cancel']) {
    test(`client ${action} remains non-executing`, async (t) => {
        const { client } = await fixture(t, (request) =>
            action === 'accept' ? accepted(request) : { action }
        );
        assert.deepEqual(
            (await client.listTools()).tools.map((tool) => tool.name),
            ['probe_elicitation']
        );
        assert.equal((await call(client)).outcome, action);
    });
}

for (const [name, response] of [
    ['missing content', () => ({ action: 'accept' })],
    [
        'false confirmation',
        (request) => ({
            ...accepted(request),
            content: { ...accepted(request).content, confirmed: false },
        }),
    ],
    [
        'missing confirmation',
        (request) => ({
            action: 'accept',
            content: { correlation: accepted(request).content.correlation },
        }),
    ],
    [
        'malformed content',
        () => ({ action: 'accept', content: { confirmed: 'yes', correlation: 7 } }),
    ],
    [
        'mismatched correlation',
        () => ({ action: 'accept', content: { confirmed: true, correlation: 'wrong' } }),
    ],
    ['unexpected action', () => ({ action: 'unexpected' })],
]) {
    test(`rejects ${name}`, async (t) => {
        const { client } = await fixture(t, response);
        assert.equal((await call(client)).outcome, 'invalid');
    });
}

test('unsupported client is not asked', async (t) => {
    const { client } = await fixture(t, undefined, { capabilities: {} });
    assert.equal((await call(client)).outcome, 'unsupported');
});

test('unexpected client failure is safely classified', async (t) => {
    const { client } = await fixture(t, () => {
        throw new Error('private diagnostic');
    });
    assert.equal((await call(client)).outcome, 'invalid');
});

test('diagnostics correlate incoming call and successful elicitation send without content', async (t) => {
    const { client, diagnostics } = await fixture(t, accepted);
    const sentinel = 'SENSITIVE-unrelated-metadata';
    await client.callTool({
        name: 'probe_elicitation',
        arguments: {},
        _meta: {
            'io.modelcontextprotocol/related-task': { taskId: 'diagnostic-task', secret: sentinel },
            unrelated: sentinel,
        },
    });
    assert.deepEqual(
        diagnostics.map((entry) => entry.event),
        ['probe_call_received', 'elicitation_sent', 'elicitation_reply_received']
    );
    assert.deepEqual(Object.keys(diagnostics[0]).toSorted(), [
        'event',
        'relatedTaskId',
        'requestId',
        'timestamp',
    ]);
    assert.equal(diagnostics[0].relatedTaskId, 'diagnostic-task');
    assert.equal(diagnostics[1].requestId, diagnostics[2].requestId);
    assert.equal(diagnostics[2].kind, 'result');
    for (const entry of diagnostics) assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
    assert.doesNotMatch(
        JSON.stringify(diagnostics),
        /SENSITIVE|requestedSchema|confirmed|correlation/
    );
});

for (const failure of ['remote error', 'malformed accepted content']) {
    test(`${failure} diagnostics exclude sensitive error and validation text`, async (t) => {
        const sentinel = 'SENSITIVE-error-content-credential';
        const { client, diagnostics } = await fixture(t, () => {
            if (failure === 'remote error') throw new Error(sentinel);
            return {
                action: 'accept',
                content: { confirmed: sentinel, correlation: sentinel },
            };
        });
        assert.equal((await call(client)).outcome, 'invalid');
        const error = diagnostics.find((entry) => entry.event === 'probe_error');
        assert.ok(error);
        assert.equal(error.summary, 'elicitation_failed');
        assert.equal(typeof error.code, 'number');
        assert.ok(error.elapsedMs >= 0);
        assert.equal(error.requestId, diagnostics[0].requestId);
        assert.equal(
            diagnostics.find((entry) => entry.event === 'elicitation_reply_received').kind,
            failure === 'remote error' ? 'error' : 'result'
        );
        assert.doesNotMatch(
            JSON.stringify(diagnostics),
            /SENSITIVE|credential|confirmed|correlation/
        );
        assert.deepEqual(Object.keys(error).toSorted(), [
            'code',
            'elapsedMs',
            'event',
            'requestId',
            'summary',
            'timestamp',
        ]);
    });
}

test('transport observer preserves forwarding, successful send timing and matching cancellation', async () => {
    const diagnostics = [];
    const forwarded = [];
    const received = [];
    let release;
    const transport = {
        onmessage(...args) {
            received.push([this, ...args]);
        },
        send(...args) {
            forwarded.push([this, ...args]);
            return new Promise((resolve) => {
                release = resolve;
            });
        },
    };
    assert.equal(
        observeProbeTransport(transport, (entry) => diagnostics.push(entry)),
        transport
    );
    const frame = {
        jsonrpc: '2.0',
        id: 7,
        method: 'elicitation/create',
        params: { secret: 'SENSITIVE' },
    };
    const options = { relatedRequestId: 4 };
    const pending = transport.send(frame, options);
    assert.equal(diagnostics.length, 0);
    assert.deepEqual(forwarded, [[transport, frame, options]]);
    release();
    await pending;
    assert.equal(diagnostics[0].event, 'elicitation_sent');
    const extra = { secret: 'SENSITIVE' };
    const unrelated = { jsonrpc: '2.0', id: 999, error: { code: -1, message: 'SENSITIVE' } };
    transport.onmessage(unrelated, extra);
    assert.equal(diagnostics.length, 1);
    const cancellation = {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 7, reason: 'SENSITIVE' },
    };
    const sent = transport.send(cancellation, options);
    release();
    await sent;
    assert.equal(diagnostics[1].event, 'cancellation_sent');
    const callFrame = {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'probe_elicitation' },
    };
    transport.onmessage(callFrame, extra);
    const incomingCancellation = { ...cancellation, params: { requestId: 4, reason: 'SENSITIVE' } };
    transport.onmessage(incomingCancellation, extra);
    assert.equal(diagnostics.at(-1).event, 'cancellation_received');
    assert.deepEqual(received, [
        [transport, unrelated, extra],
        [transport, callFrame, extra],
        [transport, incomingCancellation, extra],
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /SENSITIVE|secret|reason/);
});

test('failed transport send is not reported as a successful elicitation', async () => {
    const diagnostics = [];
    const failure = new Error('SENSITIVE-send-error');
    const transport = observeProbeTransport(
        {
            send: async () => {
                throw failure;
            },
        },
        (entry) => diagnostics.push(entry)
    );
    await assert.rejects(
        transport.send({ jsonrpc: '2.0', id: 8, method: 'elicitation/create' }),
        (ex) => ex === failure
    );
    transport.onmessage({ jsonrpc: '2.0', id: 8, result: { action: 'cancel' } });
    assert.deepEqual(diagnostics, []);
});

test('prior-call correlation is rejected', async (t) => {
    let first;
    const { client } = await fixture(t, (request) => {
        const response = accepted(request);
        if (first) response.content.correlation = first;
        else first = response.content.correlation;
        return response;
    });
    assert.equal((await call(client)).outcome, 'accept');
    assert.equal((await call(client)).outcome, 'invalid');
});

test('timeout is terminal even after late acceptance', async (t) => {
    let release;
    let entered;
    const ready = new Promise((resolve) => {
        entered = resolve;
    });
    const { client, diagnostics } = await fixture(
        t,
        (request) =>
            new Promise((resolve) => {
                release = () => resolve(accepted(request));
                entered();
            }),
        { timeoutMs: 30 }
    );
    const pending = call(client);
    await ready;
    const value = await pending;
    assert.equal(value.outcome, 'timeout');
    assert.equal(
        diagnostics.find((entry) => entry.event === 'probe_error').summary,
        'elicitation_timeout'
    );
    assert.ok(diagnostics.some((entry) => entry.event === 'cancellation_sent'));
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(value.outcome, 'timeout');
    assert.equal(value.executionEnabled, false);
});

test('request cancellation is terminal even after late acceptance', async (t) => {
    let release;
    let entered;
    const ready = new Promise((resolve) => {
        entered = resolve;
    });
    const { server } = await fixture(
        t,
        (request) =>
            new Promise((resolve) => {
                release = () => resolve(accepted(request));
                entered();
            })
    );
    const controller = new AbortController();
    const pending = runProbe(server.server, { signal: controller.signal });
    await ready;
    controller.abort();
    const value = await pending;
    assert.equal(value.outcome, 'cancel');
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(value.outcome, 'cancel');
    assert.equal(value.executionEnabled, false);
});

test('injected stdio emits only MCP frames and shuts down cleanly', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = [];
    const server = createProbeServer({ diagnostic: (entry) => diagnostics.push(entry) });
    let text = '';
    output.on('data', (chunk) => {
        text += chunk.toString();
    });
    await server.connect(
        observeProbeTransport(new StdioServerTransport(input, output), (entry) =>
            diagnostics.push(entry)
        )
    );
    try {
        input.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } })}\n`
        );
        await new Promise((resolve) => setImmediate(resolve));
        input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        input.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`
        );
        input.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe_elicitation', arguments: {} } })}\n`
        );
        await new Promise((resolve) => setImmediate(resolve));
        const frames = text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        assert.deepEqual(
            diagnostics.map((entry) => entry.event),
            ['probe_call_received']
        );
        assert.equal(diagnostics[0].requestId, 3);
        assert.equal(frames.length, 3);
        assert.ok(frames.every((frame) => frame.jsonrpc === '2.0'));
        assert.equal(
            frames.find((frame) => frame.id === 2).result.tools[0].name,
            'probe_elicitation'
        );
        assert.deepEqual(
            JSON.parse(frames.find((frame) => frame.id === 3).result.content[0].text).outcome,
            'unsupported'
        );
        assert.equal(
            JSON.parse(frames.find((frame) => frame.id === 3).result.content[0].text)
                .executionEnabled,
            false
        );
    } finally {
        await server.close();
        input.destroy();
        output.destroy();
    }
});

test('probe stays outside production registration and publish allowlist', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(!pkg.files.includes('scripts') && !pkg.files.includes('tests'));
    assert.doesNotMatch(
        readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
        /elicitation-probe|probe_elicitation/
    );
    const source = readFileSync(
        new URL('../scripts/elicitation-probe.mjs', import.meta.url),
        'utf8'
    );
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(imports, [
        'node:crypto',
        'node:url',
        '@modelcontextprotocol/sdk/server/mcp.js',
        '@modelcontextprotocol/sdk/server/stdio.js',
        '@modelcontextprotocol/sdk/types.js',
    ]);
});
