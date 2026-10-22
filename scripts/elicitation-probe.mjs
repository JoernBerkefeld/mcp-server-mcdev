#!/usr/bin/env node
/** Development-only probe. Client assertions are not independent human attestation. */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, RELATED_TASK_META_KEY } from '@modelcontextprotocol/sdk/types.js';

const stderrDiagnostic = (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`);

/**
 * Emit only caller-selected diagnostic fields without affecting the probe.
 * @param diagnostic - Diagnostic sink.
 * @param event - Fixed event name.
 * @param fields - Allowlisted fields.
 */
function emit(diagnostic, event, fields) {
    try {
        diagnostic({ event, timestamp: new Date().toISOString(), ...fields });
    } catch {
        // Diagnostics must not alter MCP forwarding or probe outcomes.
    }
}

/**
 * Observe development probe traffic while retaining transport ownership and forwarding.
 * @param transport - Transport owned by the SDK after connection.
 * @param diagnostic - Optional stderr-compatible diagnostic sink.
 * @returns {object} The unchanged transport instance with selective observation.
 */
export function observeProbeTransport(transport, diagnostic = stderrDiagnostic) {
    const calls = new Set();
    const elicitations = new Set();
    const receive = transport.onmessage;
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP transports expose callbacks, not EventTarget listeners.
    transport.onmessage = (message, extra) => {
        if (message.method === 'tools/call' && message.params?.name === 'probe_elicitation') {
            calls.add(message.id);
            const taskId = message.params?._meta?.[RELATED_TASK_META_KEY]?.taskId;
            emit(diagnostic, 'probe_call_received', {
                requestId: message.id,
                ...(typeof taskId === 'string' ? { relatedTaskId: taskId } : {}),
            });
        } else if (elicitations.has(message.id) && ('result' in message || 'error' in message)) {
            elicitations.delete(message.id);
            emit(diagnostic, 'elicitation_reply_received', {
                requestId: message.id,
                kind: 'error' in message ? 'error' : 'result',
            });
        } else if (
            message.method === 'notifications/cancelled' &&
            (calls.has(message.params?.requestId) || elicitations.has(message.params?.requestId))
        ) {
            emit(diagnostic, 'cancellation_received', { requestId: message.params.requestId });
        }
        receive?.call(transport, message, extra);
    };
    const send = transport.send;
    transport.send = async (message, options) => {
        const elicitation = message.method === 'elicitation/create';
        if (elicitation) elicitations.add(message.id);
        try {
            await send.call(transport, message, options);
        } catch (ex) {
            if (elicitation) elicitations.delete(message.id);
            throw ex;
        }
        if (elicitation) {
            emit(diagnostic, 'elicitation_sent', { requestId: message.id });
        } else if (
            message.method === 'notifications/cancelled' &&
            elicitations.has(message.params?.requestId)
        ) {
            elicitations.delete(message.params.requestId);
            emit(diagnostic, 'cancellation_sent', { requestId: message.params.requestId });
        }
        if ('result' in message || 'error' in message) calls.delete(message.id);
    };
    return transport;
}

const result = (outcome) =>
    Object.freeze({
        outcome,
        executionEnabled: false,
        consentBasis: 'trusted-client-assertion-not-independent-human-attestation',
    });

/**
 * Ask for a harmless, call-correlated client assertion; never enable execution.
 * @param server - Initialized underlying MCP server.
 * @param root0 - Request lifetime options.
 * @param root0.signal - Optional request cancellation signal.
 * @param root0.timeoutMs - Maximum elicitation wait in milliseconds.
 * @param root0.diagnostic - Optional diagnostic sink.
 * @param root0.requestId - Incoming probe call ID, when available.
 * @returns {Promise<object>} Frozen non-executing outcome.
 */
export async function runProbe(
    server,
    { signal, timeoutMs = 30_000, diagnostic = stderrDiagnostic, requestId } = {}
) {
    const started = Date.now();
    if (signal?.aborted) return result('cancel');
    if (!server.getClientCapabilities()?.elicitation?.form) return result('unsupported');
    const correlation = randomUUID();
    try {
        const response = await server.elicitInput(
            {
                mode: 'form',
                message:
                    'Harmless development probe: confirm only this in-memory interaction. No operation will execute. The reply is a trusted client assertion, not independent human attestation.',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        confirmed: { type: 'boolean', title: 'Confirm this harmless probe' },
                        correlation: {
                            type: 'string',
                            title: 'Return this call correlation unchanged',
                            default: correlation,
                        },
                    },
                    required: ['confirmed', 'correlation'],
                },
            },
            { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs }
        );
        if (signal?.aborted) return result('cancel');
        if (response.action === 'decline' || response.action === 'cancel')
            return result(response.action);
        const content = response.content;
        if (
            response.action !== 'accept' ||
            !content ||
            content.confirmed !== true ||
            content.correlation !== correlation
        ) {
            return result('invalid');
        }
        return result('accept');
    } catch (ex) {
        emit(diagnostic, 'probe_error', {
            ...(requestId === undefined ? {} : { requestId }),
            ...(Number.isFinite(ex?.code) ? { code: ex.code } : {}),
            summary: signal?.aborted
                ? 'request_cancelled'
                : ex?.code === ErrorCode.RequestTimeout
                  ? 'elicitation_timeout'
                  : 'elicitation_failed',
            elapsedMs: Date.now() - started,
        });
        if (signal?.aborted) return result('cancel');
        return result(ex?.code === ErrorCode.RequestTimeout ? 'timeout' : 'invalid');
    }
}

/**
 * Create an isolated server; importing this module never starts a transport.
 * @param root0 - Development test options.
 * @param root0.timeoutMs - Maximum elicitation wait in milliseconds.
 * @param root0.diagnostic - Optional diagnostic sink.
 * @returns {McpServer} Isolated probe server, not connected to a transport.
 */
export function createProbeServer({ timeoutMs = 30_000, diagnostic = stderrDiagnostic } = {}) {
    const server = new McpServer({ name: 'mcdev-development-elicitation-probe', version: '0.0.0' });
    server.registerTool(
        'probe_elicitation',
        {
            description:
                'Harmless development-only elicitation check. No execution, files, accounts or independent proof of human consent.',
            inputSchema: {},
        },
        async (_args, extra) => {
            const value = await runProbe(server.server, {
                signal: extra.signal,
                timeoutMs,
                diagnostic,
                requestId: extra.requestId,
            });
            return { content: [{ type: 'text', text: JSON.stringify(value) }] };
        }
    );
    return server;
}

// Only the standalone development command starts stdio; production never imports this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await createProbeServer().connect(observeProbeTransport(new StdioServerTransport()));
}
