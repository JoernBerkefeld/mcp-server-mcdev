/** Production exact-key retrieval boundary; native diagnostics never cross this projection. */
import { z } from 'zod';
import {
    prepareQueryRetrieve,
    runQueryRetrieve,
    type QueryRetrieveRunContext,
} from './query-retrieve-integration.js';
import { queryRetrievePreviewInputSchema } from './query-retrieve-preview.js';

export const QUERY_RETRIEVE_EXECUTION_FAILURE = 'Query retrieve unavailable.';
// Reuse the exact preparation selectors, with fixed execution-specific SDK validation text.
export const queryRetrieveExecutionInputSchema = z.strictObject(
    Object.fromEntries(
        Object.keys(queryRetrievePreviewInputSchema.shape).map((key) => [
            key,
            z.string({ error: QUERY_RETRIEVE_EXECUTION_FAILURE }),
        ])
    ) as Record<keyof typeof queryRetrievePreviewInputSchema.shape, z.ZodString>,
    { error: QUERY_RETRIEVE_EXECUTION_FAILURE }
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
 * Bind trusted internal substitutes for synthetic tests, never public tool arguments.
 * @param seams - Preparation and direct coordinator substitutes.
 * @param seams.prepare - Fresh local preparation substitute.
 * @param seams.run - Direct request-cancellable runner substitute.
 * @returns {object} Exact-selector production executor with an allowlisted result.
 */
export function createQueryRetrieveExecutor(
    seams: { prepare?: typeof prepareQueryRetrieve; run?: typeof runQueryRetrieve } = {}
) {
    const prepare = seams.prepare ?? prepareQueryRetrieve;
    const run = seams.run ?? runQueryRetrieve;
    return async (
        input: z.infer<typeof queryRetrieveExecutionInputSchema>,
        context: QueryRetrieveRunContext
    ) => {
        try {
            const exact = queryRetrieveExecutionInputSchema.parse(input);
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
            throw new Error(QUERY_RETRIEVE_EXECUTION_FAILURE);
        }
    };
}

export const executeQueryRetrieve = createQueryRetrieveExecutor();
