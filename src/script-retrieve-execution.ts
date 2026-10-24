/** Production Script metadata retrieval; source and native diagnostics stay private. */
import { z } from 'zod';
import {
    prepareScriptRetrieve,
    runScriptRetrieve,
    type QueryRetrieveRunContext,
} from './query-retrieve-integration.js';
import { queryRetrievePreviewInputSchema } from './query-retrieve-preview.js';

export const SCRIPT_RETRIEVE_EXECUTION_FAILURE = 'Script retrieve unavailable.';
export const scriptRetrieveExecutionInputSchema = z.strictObject(
    Object.fromEntries(
        Object.keys(queryRetrievePreviewInputSchema.shape).map((key) => [
            key,
            z.string({ error: SCRIPT_RETRIEVE_EXECUTION_FAILURE }),
        ])
    ) as Record<keyof typeof queryRetrievePreviewInputSchema.shape, z.ZodString>,
    { error: SCRIPT_RETRIEVE_EXECUTION_FAILURE }
);

const processOutcomes = new Set([
    'invalid-input',
    'exited',
    'spawn-failed',
    'cancelled',
    'timed-out',
    'output-limit',
    'termination-unconfirmed',
]);
const outcomes = new Set(['project-busy', 'cancel', 'blocked', 'failed', ...processOutcomes]);
const classifications = new Set([
    'local-materialization',
    'unchanged-unverified',
    'partial',
    'unverified',
]);

/**
 * Bind trusted synthetic substitutes, never public execution arguments.
 * @param seams - Internal preparation and shared coordinator substitutes.
 * @param seams.prepare - Fresh Script preparation substitute.
 * @param seams.run - Direct request-cancellable Script runner substitute.
 * @returns {object} Strict-selector executor with an allowlisted public result.
 */
export function createScriptRetrieveExecutor(
    seams: { prepare?: typeof prepareScriptRetrieve; run?: typeof runScriptRetrieve } = {}
) {
    const prepare = seams.prepare ?? prepareScriptRetrieve;
    const run = seams.run ?? runScriptRetrieve;
    return async (
        input: z.infer<typeof scriptRetrieveExecutionInputSchema>,
        context: QueryRetrieveRunContext
    ) => {
        try {
            const exact = scriptRetrieveExecutionInputSchema.parse(input);
            const prepared = prepare({
                projectRoot: exact.workspaceRoot,
                credential: exact.credential,
                businessUnit: exact.businessUnit,
                key: exact.key,
            });
            const result = await run(prepared, {
                signal: context.signal,
                processTimeoutMs: context.processTimeoutMs,
            });
            return Object.freeze({
                outcome: outcomes.has(result.outcome) ? result.outcome : 'failed',
                processOutcome:
                    result.process === null
                        ? null
                        : processOutcomes.has(result.process.outcome)
                          ? result.process.outcome
                          : 'invalid-input',
                artifactClassification: classifications.has(result.materialization)
                    ? result.materialization
                    : 'unverified',
                projectBlocked: result.projectBlocked === true,
                remoteCompletenessVerified: false as const,
            });
        } catch {
            throw new Error(SCRIPT_RETRIEVE_EXECUTION_FAILURE);
        }
    };
}

export const executeScriptRetrieve = createScriptRetrieveExecutor();
