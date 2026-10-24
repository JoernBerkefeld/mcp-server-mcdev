/** Internal retrieve adapter, not authorization or proof of retrieval/artifact completeness. */
import {
    runNativeProcess,
    type NativeProcessEvidence,
    type NativeProcessLifetime,
    type NativeProcessRuntime,
} from './native-process.js';
import type { RetrieveMetadataType } from './query-retrieve-project-snapshot.js';

export interface QueryProcessInput {
    readonly projectRoot: string;
    readonly credential: string;
    readonly businessUnit: string;
    readonly key: string;
    readonly metadataType?: RetrieveMetadataType;
}
export type QueryProcessLifetime = NativeProcessLifetime;
/** Trusted internal executable selection only; never accept this from tool arguments. */
export type QueryProcessRuntime = NativeProcessRuntime;
export interface QueryProcessResult extends NativeProcessEvidence {
    readonly retrievalVerified: false;
}

/**
 * Launch exactly one native-shaped retrieve process. Caller owns authorization, full recheck and serialization.
 * Runtime selection is internal; tests substitute a synthetic package/CLI, never real account commands.
 * Paths must remain stable throughout launch; metadata checks are not a concurrent filesystem sandbox.
 * @param input - Exact inspected literal selection.
 * @param lifetime - Request cancellation and bounded timeout (default 30 seconds, maximum 120 seconds).
 * @param runtime - Trusted installed CLI selection; no caller argv, environment or Node override.
 * @returns {Promise<QueryProcessResult>} Output-free process evidence, never verified retrieval success.
 */
export async function runQueryRetrieveProcess(
    input: QueryProcessInput,
    lifetime: QueryProcessLifetime,
    runtime?: QueryProcessRuntime
): Promise<QueryProcessResult> {
    const metadataType = input.metadataType === undefined ? 'query' : input.metadataType;
    try {
        if (metadataType !== 'query' && metadataType !== 'script')
            throw new Error('Invalid metadata type');
        const literal = /^[A-Za-z0-9][A-Za-z0-9_. -]*$/u;
        for (const value of [input.credential, input.businessUnit, input.key]) {
            if (
                typeof value !== 'string' ||
                !literal.test(value) ||
                value.trim() !== value ||
                value.endsWith('.') ||
                value.includes('..')
            )
                throw new Error('Invalid selector');
        }
    } catch {
        return Object.freeze({
            outcome: 'invalid-input',
            stopReason: null,
            started: false,
            directChildClosed: false,
            descendantsStopped: false,
            exitCode: null,
            exitSignal: null,
            stdoutBytes: 0,
            stderrBytes: 0,
            retrievalVerified: false,
            partialEffectsPossible: false,
        });
    }
    const evidence = await runNativeProcess(
        {
            projectRoot: input.projectRoot,
            args: [
                'retrieve',
                `${input.credential}/${input.businessUnit}`,
                metadataType,
                input.key,
                '--no-purge',
                '--no-format',
                '--skipInteraction',
                '--noLogFile',
                '--noLogColors',
            ],
        },
        lifetime,
        runtime
    );
    return Object.freeze({ ...evidence, retrievalVerified: false });
}
