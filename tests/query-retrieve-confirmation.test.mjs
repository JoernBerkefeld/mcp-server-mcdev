import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
    createQueryRetrieveConfirmation,
    createQueryRetrieveSdkElicitor,
    createSyntheticQueryConfirmation,
} from '../dist/query-retrieve-confirmation.js';

const input = () => ({
    projectRoot: String.raw`F:\Temp\invented-project`,
    credential: 'demo',
    businessUnit: 'QA',
    mid: '123',
    key: 'sample',
    snapshot: 'config-artifacts-effects-version-v1',
});
const accept = async ({ correlation }) => ({
    action: 'accept',
    content: { confirmed: true, correlation },
});
function harness(overrides = {}, production = false) {
    const calls = [];
    const controller = new AbortController();
    const dependencies = {
        signal: controller.signal,
        elicit: accept,
        recheck: async (operation) => ({ snapshot: operation.snapshot, ready: true }),
        execute: async (operation) => {
            calls.push(operation);
        },
        ...overrides,
    };
    const original = input();
    const gate = (production ? createQueryRetrieveConfirmation : createSyntheticQueryConfirmation)(
        original,
        dependencies
    );
    return { gate, calls, controller, original, dependencies };
}

test('exact synthetic accept calls fake once and captures immutable inspected values', async () => {
    const { gate, calls, original, dependencies } = harness();
    original.key = 'changed';
    dependencies.execute = async () => {
        throw new Error('replacement');
    };
    assert.ok(Object.isFrozen(gate.operation));
    assert.ok(Object.isFrozen(gate.operation.effects));
    assert.throws(() => {
        gate.operation.key = 'changed';
    }, TypeError);
    assert.match(gate.operation.effects.join(' '), /overwrite both/);
    assert.equal((await gate.confirm()).outcome, 'accepted');
    assert.equal((await gate.confirm()).outcome, 'invalid');
    assert.deepEqual(calls, [gate.operation]);
    assert.equal(calls[0].key, 'sample');
});

for (const action of ['decline', 'cancel', 'unsupported']) {
    test(`${action} never calls fake execution`, async () => {
        const { gate, calls } = harness({ elicit: async () => ({ action }) });
        assert.equal((await gate.confirm()).outcome, action === 'unsupported' ? 'invalid' : action);
        assert.equal(calls.length, 0);
    });
}
for (const content of [
    undefined,
    {},
    { confirmed: true, correlation: 'wrong' },
    { confirmed: false },
]) {
    test(`malformed acceptance ${JSON.stringify(content)} cannot approve`, async () => {
        const { gate, calls } = harness({
            elicit: async () => ({ action: 'accept', content, approved: true }),
        });
        assert.equal((await gate.confirm()).outcome, 'invalid');
        assert.equal(calls.length, 0);
    });
}
for (const field of ['config', 'artifacts', 'selectors', 'effects', 'reviewedVersion']) {
    test(`changed ${field} snapshot blocks accepted confirmation`, async () => {
        const { gate, calls } = harness({
            recheck: async () => ({ snapshot: `${field}-changed`, ready: true }),
        });
        assert.equal((await gate.confirm()).outcome, 'blocked');
        assert.equal(calls.length, 0);
    });
}

test('actual blocked contract cannot be overridden by positive readiness', async () => {
    const { gate, calls } = harness({}, true);
    assert.equal((await gate.confirm()).outcome, 'blocked');
    assert.equal(calls.length, 0);
});

test('negative readiness remains blocked', async () => {
    const { gate, calls } = harness({
        recheck: async (operation) => ({ snapshot: operation.snapshot, ready: false }),
    });
    assert.equal((await gate.confirm()).outcome, 'blocked');
    assert.equal(calls.length, 0);
});

test('concurrent confirmation cannot reuse one request', async () => {
    const { gate, calls } = harness();
    const results = await Promise.all([gate.confirm(), gate.confirm()]);
    assert.deepEqual(
        results.map((value) => value.outcome),
        ['accepted', 'invalid']
    );
    assert.equal(calls.length, 1);
});

test('timeout is terminal despite a late accepted response', async () => {
    let finish;
    const { gate, calls } = harness({
        timeoutMs: 5,
        elicit: (request) =>
            new Promise((resolve) => {
                finish = () => resolve(accept(request));
            }),
    });
    assert.equal((await gate.confirm()).outcome, 'timeout');
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0);
});

test('cancellation during recheck is terminal despite late readiness', async () => {
    let finish;
    let entered;
    const checking = new Promise((resolve) => {
        entered = resolve;
    });
    const { gate, calls, controller } = harness({
        recheck: (operation) =>
            new Promise((resolve) => {
                finish = () => resolve({ snapshot: operation.snapshot, ready: true });
                entered();
            }),
    });
    const pending = gate.confirm();
    await checking;
    controller.abort();
    assert.equal((await pending).outcome, 'cancel');
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0);
});

test('pre-cancelled request never elicits or executes', async () => {
    const { gate, controller, calls } = harness({
        elicit: async () => {
            throw new Error('must not elicit');
        },
    });
    controller.abort();
    assert.equal((await gate.confirm()).outcome, 'cancel');
    assert.equal(calls.length, 0);
});

test('unknown auth-bearing exceptions produce fixed diagnostics only', async () => {
    for (const seam of ['elicit', 'recheck', 'execute']) {
        const { gate } = harness({
            [seam]: async () => {
                throw new Error('AUTH_SECRET parser fragment');
            },
        });
        assert.deepEqual(await gate.confirm(), {
            outcome: 'failed',
            executionEnabled: false,
            consentBasis: 'trusted-client-assertion-not-independent-human-attestation',
        });
    }
});

test('literal operation validation rejects widening, invalid paths and missing snapshot', () => {
    for (const change of [
        { key: '*' },
        { key: 'one,two' },
        { credential: '../escape' },
        { mid: '0' },
        { snapshot: '' },
        { projectRoot: 'relative' },
    ]) {
        assert.throws(
            () =>
                createSyntheticQueryConfirmation({ ...input(), ...change }, harness().dependencies),
            /Invalid inspected query operation/
        );
    }
});

test('SDK adapter captures only request identity and genuine optional task association', async () => {
    for (const taskId of [undefined, 'synthetic-related-task']) {
        const calls = [];
        const controller = new AbortController();
        const server = {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            elicitInput: async (...args) => {
                calls.push(args);
                return { action: 'decline' };
            },
        };
        const extra = {
            requestId: 17,
            taskId,
            _meta: { secret: 'SENSITIVE' },
            authInfo: 'SENSITIVE',
        };
        const elicit = createQueryRetrieveSdkElicitor(server, extra);
        extra.requestId = 99;
        extra.taskId = 'replacement';
        assert.deepEqual(
            await elicit(
                { message: 'Exact effects', correlation: 'call-correlation' },
                { signal: controller.signal, timeoutMs: 123 }
            ),
            { action: 'decline' }
        );
        assert.deepEqual(calls[0][1], {
            signal: controller.signal,
            timeout: 123,
            maxTotalTimeout: 123,
            relatedRequestId: 17,
            ...(taskId === undefined ? {} : { relatedTask: { taskId } }),
        });
        assert.equal(calls[0][0].message, 'Exact effects');
        assert.doesNotMatch(JSON.stringify(calls), /SENSITIVE|replacement/);
    }
});

test('gate passes bounded lifetime and aborts it before late elicitation rejection', async () => {
    let lifetime;
    let entered;
    const ready = new Promise((resolve) => {
        entered = resolve;
    });
    const { gate, controller, calls } = harness({
        elicit: (_request, options) =>
            new Promise((_resolve, reject) => {
                lifetime = options;
                options.signal.addEventListener('abort', () => reject(new Error('SENSITIVE')), {
                    once: true,
                });
                entered();
            }),
    });
    const pending = gate.confirm();
    await ready;
    assert.ok(lifetime.timeoutMs > 0 && lifetime.timeoutMs <= 30_000);
    assert.notEqual(lifetime.signal, controller.signal);
    controller.abort('SENSITIVE');
    assert.equal((await pending).outcome, 'cancel');
    assert.equal(lifetime.signal.aborted, true);
    assert.equal(lifetime.signal.reason, 'query_confirmation_stopped');
    assert.equal(calls.length, 0);
});

test('production registration never imports the confirmation module or synthetic seam', () => {
    const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.ok(!source.includes('query-retrieve-confirmation'));
    assert.ok(!source.includes('createSyntheticQueryConfirmation'));
});
