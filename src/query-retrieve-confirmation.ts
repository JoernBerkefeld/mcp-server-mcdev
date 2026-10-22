/** Unregistered query confirmation boundary; no native executor is provided. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
    ErrorCode,
    McpError,
    type ServerRequest,
    type ServerNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { QUERY_RETRIEVE_CONTRACT } from './query-retrieve-contract.js';

interface QueryInput {
    projectRoot: string;
    credential: string;
    businessUnit: string;
    mid: string;
    key: string;
    snapshot: string;
}
export interface QueryDescriptor extends Readonly<QueryInput> {
    readonly command: 'retrieve';
    readonly type: 'query';
    readonly reviewedVersion: '10.1.0';
    readonly effects: readonly string[];
    readonly mode: 'blocked-contract' | 'synthetic-only' | 'approval-only';
}
interface Dependencies {
    elicit: (
        request: Readonly<{ message: string; correlation: string }>,
        lifetime: Readonly<{ signal: AbortSignal; timeoutMs: number }>
    ) => Promise<unknown>;
    recheck: (operation: QueryDescriptor) => Promise<{ snapshot: string; ready: boolean }>;
    execute: (operation: QueryDescriptor) => Promise<void>;
    signal: AbortSignal;
    timeoutMs?: number;
}
type Outcome =
    | 'accepted'
    | 'blocked'
    | 'cancel'
    | 'timeout'
    | 'invalid'
    | 'decline'
    | 'failed'
    | 'unsupported';
class ElicitationFailure extends Error {
    constructor(readonly outcome: 'unsupported' | 'invalid' | 'timeout' | 'failed') {
        super('Query confirmation elicitation failed');
    }
}

/**
 * Bind SDK form elicitation to one incoming request; never register or execute an operation.
 * @param server - Initialized SDK server supplying capability checks and form validation.
 * @param extra - SDK-owned incoming request identity; unrelated metadata is not forwarded.
 * @returns {Dependencies['elicit']} Gate-compatible elicitation callback.
 */
export function createQueryRetrieveSdkElicitor(
    server: Pick<Server, 'getClientCapabilities' | 'elicitInput'>,
    extra: Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, 'requestId' | 'taskId'>
): Dependencies['elicit'] {
    const { requestId, taskId } = extra;
    const getCapabilities = server.getClientCapabilities.bind(server);
    const elicitInput = server.elicitInput.bind(server);
    return async ({ message, correlation }, { signal, timeoutMs }) => {
        if (!getCapabilities()?.elicitation?.form) throw new ElicitationFailure('unsupported');
        try {
            return await elicitInput(
                {
                    mode: 'form',
                    message,
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            confirmed: {
                                type: 'boolean',
                                title: 'Confirm this exact query operation',
                            },
                            correlation: {
                                type: 'string',
                                title: 'Return correlation unchanged',
                                default: correlation,
                            },
                        },
                        required: ['confirmed', 'correlation'],
                    },
                },
                {
                    signal,
                    timeout: timeoutMs,
                    maxTotalTimeout: timeoutMs,
                    relatedRequestId: requestId,
                    ...(taskId === undefined ? {} : { relatedTask: { taskId } }),
                }
            );
        } catch (ex) {
            // Request cancellation takes precedence in the gate; never expose SDK error text.
            const outcome =
                ex instanceof ZodError ||
                (ex instanceof McpError && ex.code === ErrorCode.InvalidParams)
                    ? 'invalid'
                    : ex instanceof McpError && ex.code === ErrorCode.RequestTimeout
                      ? 'timeout'
                      : 'failed';
            throw new ElicitationFailure(outcome);
        }
    };
}
const result = (outcome: Outcome) =>
    Object.freeze({
        outcome,
        executionEnabled: false as const,
        consentBasis: 'trusted-client-assertion-not-independent-human-attestation' as const,
    });

/**
 * Construct a single-use gate from trusted internal inspection, not tool approval arguments.
 * @param input - Exact inspected mapping and opaque reviewed snapshot identity.
 * @param dependencies - Request-owned host, reinspection and fake callback seams.
 * @param synthetic - Explicit test harness only; never native execution authorization.
 * @param approvalEffects - Prepared effects for the internal non-executing approval path.
 * @returns {object} Single-use confirmation gate with an immutable operation descriptor.
 */
function createGate(
    input: QueryInput,
    dependencies: Dependencies,
    synthetic: boolean,
    approvalEffects?: readonly string[]
) {
    const { projectRoot, credential, businessUnit, mid, key, snapshot } = input;
    const literal = /^[A-Za-z0-9][A-Za-z0-9_. -]*$/u;
    if (
        typeof projectRoot !== 'string' ||
        !path.win32.isAbsolute(projectRoot) ||
        path.win32.normalize(projectRoot) !== projectRoot ||
        projectRoot.startsWith('\\\\') ||
        [credential, businessUnit, key].some(
            (value) =>
                typeof value !== 'string' ||
                !literal.test(value) ||
                value.trim() !== value ||
                value.includes('..')
        ) ||
        typeof mid !== 'string' ||
        !/^\d+$/u.test(mid) ||
        !/[1-9]/u.test(mid) ||
        typeof snapshot !== 'string' ||
        !snapshot ||
        !Number.isSafeInteger(dependencies.timeoutMs ?? 30_000) ||
        (dependencies.timeoutMs ?? 30_000) <= 0
    )
        throw new Error('Invalid inspected query operation');
    const operation: QueryDescriptor = Object.freeze({
        projectRoot,
        credential,
        businessUnit,
        mid,
        key,
        snapshot,
        command: 'retrieve',
        type: 'query',
        reviewedVersion: QUERY_RETRIEVE_CONTRACT.reviewedVersion,
        mode: approvalEffects ? 'approval-only' : synthetic ? 'synthetic-only' : 'blocked-contract',
        effects: Object.freeze(
            approvalEffects
                ? [...approvalEffects]
                : [
                      ...QUERY_RETRIEVE_CONTRACT.localEffects,
                      ...QUERY_RETRIEVE_CONTRACT.remoteEffects,
                      ...QUERY_RETRIEVE_CONTRACT.dynamicBoundaries,
                      'Native deletions require operation authorization; no personal policy exception is portable.',
                  ]
        ),
    });
    // Capture dependencies so later caller mutation cannot replace the callback or request lifetime.
    const { elicit, recheck, execute, signal } = dependencies;
    const timeoutMs = dependencies.timeoutMs ?? 30_000;
    let used = false;
    return Object.freeze({
        operation,
        async confirm() {
            if (used) return result('invalid');
            used = true;
            if (signal.aborted) return result('cancel');
            const correlation = randomUUID();
            const deadline = Date.now() + timeoutMs;
            const elicitationController = new AbortController();
            let terminal: Outcome | undefined;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let cancel!: () => void;
            const stopped = new Promise<Outcome>((resolve) => {
                const stop = (outcome: 'cancel' | 'timeout') => {
                    terminal ??= outcome;
                    resolve(terminal);
                    elicitationController.abort('query_confirmation_stopped');
                };
                cancel = () => stop('cancel');
                signal.addEventListener('abort', cancel, { once: true });
                timer = setTimeout(() => stop('timeout'), timeoutMs);
            });
            const expired = () =>
                terminal ??
                (signal.aborted ? 'cancel' : Date.now() >= deadline ? 'timeout' : undefined);
            try {
                const work = async (): Promise<Outcome> => {
                    const response = await elicit(
                        Object.freeze({
                            message: `Confirm only this exact query operation and effects: ${JSON.stringify(operation)}`,
                            correlation,
                        }),
                        Object.freeze({
                            signal: elicitationController.signal,
                            timeoutMs: Math.max(1, deadline - Date.now()),
                        })
                    );
                    if (expired()) return expired()!;
                    if (!response || typeof response !== 'object') return 'invalid';
                    const reply = response as {
                        action?: unknown;
                        content?: { confirmed?: unknown; correlation?: unknown };
                    };
                    if (reply.action === 'cancel' || reply.action === 'decline')
                        return reply.action;
                    if (
                        reply.action !== 'accept' ||
                        reply.content?.confirmed !== true ||
                        reply.content.correlation !== correlation
                    )
                        return 'invalid';
                    const checked = await recheck(operation);
                    if (expired()) return expired()!;
                    if (checked.snapshot !== operation.snapshot || checked.ready !== true)
                        return 'blocked';
                    // Even a positive recheck cannot override the actual immutable blocked contract.
                    if (approvalEffects) return 'accepted';
                    if (!synthetic && !QUERY_RETRIEVE_CONTRACT.executionEnabled) return 'blocked';
                    await execute(operation);
                    return expired() ?? 'accepted';
                };
                return result(await Promise.race([work(), stopped]));
            } catch (ex) {
                return result(
                    expired() ?? (ex instanceof ElicitationFailure ? ex.outcome : 'failed')
                );
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
            }
        },
    });
}

/**
 * Create an internal approval-only gate. No execution callback is accepted or invoked.
 * The coordinator must await settlement and recheck before any process launch.
 * @param input - Prepared exact operation and disclosed effects.
 * @param dependencies - Request-bound elicitation and read-only recheck.
 * @returns {object} Single-use approval evidence, never execution itself.
 */
export function createQueryRetrieveApproval(
    input: QueryInput & { readonly effects: readonly string[] },
    dependencies: Omit<Dependencies, 'execute'>
) {
    return createGate(input, { ...dependencies, execute: async () => {} }, false, input.effects);
}

/**
 * Create a production-shaped gate which cannot execute the blocked native contract.
 * @param input - Internally inspected exact query operation.
 * @param dependencies - Request-bound host and inspection seams; no native launcher supplied.
 * @returns {object} Single-use blocked-contract gate.
 */
export function createQueryRetrieveConfirmation(input: QueryInput, dependencies: Dependencies) {
    return createGate(input, dependencies, false);
}

/**
 * Exercise acceptance only with synthetic data and a fake callback; never register in production.
 * @param input - Invented operation and snapshot.
 * @param dependencies - Synthetic host, snapshot recheck and recording callback.
 * @returns {object} Explicitly synthetic single-use gate, not native execution authority.
 */
export function createSyntheticQueryConfirmation(input: QueryInput, dependencies: Dependencies) {
    return createGate(input, dependencies, true);
}
