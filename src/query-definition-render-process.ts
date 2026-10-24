/** Internal exact-query render adapter, not authorization or artifact verification. */
import {
    runNativeProcess,
    type NativeProcessEvidence,
    type NativeProcessLifetime,
    type NativeProcessRuntime,
} from './native-process.js';

export interface QueryDefinitionRenderProcessInput {
    readonly projectRoot: string;
    readonly credential: string;
    readonly businessUnit: string;
    readonly templateName: string;
    readonly market: string;
}

/**
 * Launch one fixed native definition render; caller owns configuration checks and serialization.
 * Runtime is trusted internal selection only. Exit evidence never establishes rendered outputs.
 * @param input - Canonical project and exact literal selectors from preparation.
 * @param lifetime - Request signal and bounded transport timeout.
 * @param runtime - Trusted CLI identity; synthetic CLI only in tests.
 * @returns {Promise<NativeProcessEvidence>} Private-output-free process evidence without artifact claims.
 */
export async function runQueryDefinitionRenderProcess(
    input: QueryDefinitionRenderProcessInput,
    lifetime: NativeProcessLifetime,
    runtime?: NativeProcessRuntime
): Promise<NativeProcessEvidence> {
    try {
        const literal = /^[A-Za-z0-9][A-Za-z0-9_. -]*$/u;
        for (const value of [
            input.credential,
            input.businessUnit,
            input.templateName,
            input.market,
        ]) {
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
            partialEffectsPossible: false,
        });
    }
    return runNativeProcess(
        {
            projectRoot: input.projectRoot,
            args: [
                'buildDefinition',
                `${input.credential}/${input.businessUnit}`,
                'query',
                input.templateName,
                input.market,
                '--no-purge',
                '--skipInteraction',
                '--noLogFile',
                '--noLogColors',
            ],
        },
        lifetime,
        runtime
    );
}
