/** Bounded production projection. Never invoke confirmation or native execution. */
import { z } from 'zod';
import { prepareQueryRetrieve } from './query-retrieve-integration.js';

export const QUERY_RETRIEVE_PREVIEW_FAILURE = 'Query retrieve preparation unavailable.';

// SDK validation happens before the callback. Fixed messages must cover unknown key names too.
export const queryRetrievePreviewInputSchema = z.strictObject(
    {
        workspaceRoot: z.string({ error: QUERY_RETRIEVE_PREVIEW_FAILURE }),
        credential: z.string({ error: QUERY_RETRIEVE_PREVIEW_FAILURE }),
        businessUnit: z.string({ error: QUERY_RETRIEVE_PREVIEW_FAILURE }),
        key: z.string({ error: QUERY_RETRIEVE_PREVIEW_FAILURE }),
    },
    { error: QUERY_RETRIEVE_PREVIEW_FAILURE }
);

const effects = Object.freeze([
    'A future native retrieve would perform a SOAP active-key lookup and REST query read. Dependency caches also read folders and data extensions, including parent EID shared data extensions and folders for child MIDs.',
    'Native mcdev/SDK may privately read authentication/session storage and refresh or persist it during a future operation. This preparation does not inspect authentication/session contents.',
    'Native persistence may create or overwrite the exact JSON/SQL destinations. Zero-saved REST persistence may delete both files; an early SOAP key-not-found leaves them untouched. No-purge suppresses wrapper cleanup only, not these native deletions.',
    'The reviewed preparation requires no project validation hook and disabled query documentOnRetrieve. Its fixed native configuration bypasses formatting/plugins and native file logging; native output must remain private.',
    'Preparation grants no operation or deletion authorization. Native deletion safety and any future operation authorization must be resolved separately. No retrieval, query activation or execution occurs here.',
]);
const limitations = Object.freeze([
    'The host must hold project/path mutation exclusion throughout evidence collection; this tool does not establish or enforce that exclusion.',
    'Evidence is local only. Remote identity, authentication readiness, execution readiness and remote completeness are not established.',
    'The snapshot is correlation/drift input, not an execution credential, approval or durable readiness proof.',
    'This is not a dry-run: native mcdev has no dry-run mode. Execution remains disabled.',
]);

/**
 * Collect the existing local preparation and project only approved public evidence.
 * @param input - Exact project root, credential, business unit and literal query key.
 * @returns {object} Immutable non-executing descriptor; all failures use a fixed diagnostic.
 */
export function prepareQueryRetrievePreview(
    input: z.infer<typeof queryRetrievePreviewInputSchema>
) {
    try {
        const exact = queryRetrievePreviewInputSchema.parse(input);
        const prepared = prepareQueryRetrieve({
            projectRoot: exact.workspaceRoot,
            credential: exact.credential,
            businessUnit: exact.businessUnit,
            key: exact.key,
        });
        return Object.freeze({
            projectRoot: prepared.projectRoot,
            credential: prepared.credential,
            businessUnit: prepared.businessUnit,
            eid: prepared.eid,
            mid: prepared.mid,
            key: prepared.key,
            reviewedMcdevVersion: prepared.runtime.version,
            snapshot: prepared.snapshot,
            destinations: Object.freeze({
                json: Object.freeze({
                    path: prepared.destinations.json,
                    existedBefore: prepared.before[0].exists,
                }),
                sql: Object.freeze({
                    path: prepared.destinations.sql,
                    existedBefore: prepared.before[1].exists,
                }),
            }),
            effects,
            limitations,
            executionEnabled: false as const,
            remoteCompletenessVerified: false as const,
            executionReadiness: 'not-established' as const,
        });
    } catch {
        throw new Error(QUERY_RETRIEVE_PREVIEW_FAILURE);
    }
}
