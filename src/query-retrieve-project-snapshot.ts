/** Config-only binding; no artifact, authentication, remote identity or execution readiness proof. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readProjectConfig } from './project-inspection.js';
import { QUERY_RETRIEVE_CONTRACT } from './query-retrieve-contract.js';

export interface QueryProjectSelection {
    readonly projectRoot: string;
    readonly credential: string;
    readonly businessUnit: string;
    readonly key: string;
}

export interface QueryProjectSnapshot extends QueryProjectSelection {
    readonly mid: string;
    readonly snapshot: string;
}

/** Fixed diagnostic: never include input, parser fragments or filesystem exceptions. */
export class QueryProjectSnapshotError extends Error {
    constructor() {
        super('Query project configuration snapshot unavailable.');
        this.name = 'QueryProjectSnapshotError';
    }
}

function ownRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = Object.hasOwn(parent, key) ? parent[key] : undefined;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new QueryProjectSnapshotError();
    }
    return value as Record<string, unknown>;
}

/**
 * Collect exact selectors and MID from the fixed config accessor, never caller-supplied config.
 * Hash complete decoded rawText re-encoded as UTF-8 without normalization, not original bytes.
 * Caller must prevent concurrent path mutation, as required by readProjectConfig.
 * @param input - Canonical absolute project root and exact literal credential, BU and query key.
 * @returns {QueryProjectSnapshot} Immutable config-only input compatible with the blocked gate.
 */
export function collectQueryProjectSnapshot(input: QueryProjectSelection): QueryProjectSnapshot {
    try {
        const { projectRoot, credential, businessUnit, key } = input;
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
            )
        ) {
            throw new QueryProjectSnapshotError();
        }
        const project = readProjectConfig(projectRoot);
        const credentials = ownRecord(project.config, 'credentials');
        const credentialConfig = ownRecord(credentials, credential);
        const units = ownRecord(credentialConfig, 'businessUnits');
        const mapped = Object.hasOwn(units, businessUnit) ? units[businessUnit] : undefined;
        let mid: string;
        if (typeof mapped === 'number' && Number.isSafeInteger(mapped) && mapped > 0) {
            mid = String(mapped);
        } else if (typeof mapped === 'string' && /^\d+$/u.test(mapped) && /[1-9]/u.test(mapped)) {
            mid = mapped;
        } else {
            throw new QueryProjectSnapshotError();
        }
        const identity = {
            basis: 'config-only-decoded-text-utf8-v1',
            projectRoot: project.projectRoot,
            credential,
            businessUnit,
            mid,
            key,
            configTextHash: createHash('sha256').update(project.rawText, 'utf8').digest('hex'),
            contract: QUERY_RETRIEVE_CONTRACT,
        };
        return Object.freeze({
            projectRoot: project.projectRoot,
            credential,
            businessUnit,
            mid,
            key,
            snapshot: createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex'),
        });
    } catch {
        throw new QueryProjectSnapshotError();
    }
}

/**
 * Reread config and compare exact binding; ready means unchanged config mapping only.
 * Does not establish artifact/source completeness, native readiness or operation authorization.
 * @param operation - Previously collected binding, also accepted as a gate descriptor.
 * @returns {Promise<Readonly<{ snapshot: string; ready: boolean }>>} Fixed fail-closed recheck.
 */
export async function recheckQueryProjectSnapshot(
    operation: QueryProjectSnapshot
): Promise<Readonly<{ snapshot: string; ready: boolean }>> {
    try {
        const current = collectQueryProjectSnapshot(operation);
        return Object.freeze({
            snapshot: current.snapshot,
            ready: current.snapshot === operation.snapshot && current.mid === operation.mid,
        });
    } catch {
        return Object.freeze({ snapshot: '', ready: false });
    }
}
