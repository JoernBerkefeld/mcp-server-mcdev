/** Internal retrieval coordinator. No public registration or auth/session content inspection. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readProjectConfig } from './project-inspection.js';
import { inspectProjectGitSecurity } from './project-git-security.js';
import {
    collectQueryProjectSnapshot,
    type QueryProjectSelection,
    type QueryProjectSnapshot,
} from './query-retrieve-project-snapshot.js';
import { QUERY_RETRIEVE_CONTRACT } from './query-retrieve-contract.js';
import { SCRIPT_RETRIEVE_CONTRACT } from './script-retrieve-contract.js';
import type { RetrieveMetadataType } from './query-retrieve-project-snapshot.js';

import {
    createQueryRetrieveApproval,
    createQueryRetrieveSdkElicitor,
} from './query-retrieve-confirmation.js';
import { runQueryRetrieveProcess, type QueryProcessResult } from './query-retrieve-process.js';
import {
    tryAcquire,
    block,
    release,
    isBlocked,
    acknowledgeExternalReconciliation,
} from './project-operation-guard.js';

const MAX_BYTES = 1024 * 1024;
// Fixed reviewed surface, not a recursive source/dependency inventory or sandbox.
const RUNTIME_FILES = Object.freeze([
    'package.json',
    'lib/cli.js',
    'lib/index.js',
    'lib/Retriever.js',
    'lib/metadataTypes/Query.js',
    'lib/metadataTypes/MetadataType.js',
    'lib/metadataTypes/DataExtension.js',
    'lib/metadataTypes/Folder.js',
    'lib/metadataTypes/definitions/Query.definition.js',
    'lib/util/config.js',
    'lib/util/cli.js',
    'lib/util/util.js',
    'lib/util/file.js',
    'lib/util/validations.js',
    'lib/util/auth.js',
]);

// Script has only a folder cache dependency; Query/DataExtension are not Script evidence.
const SCRIPT_RUNTIME_FILES = Object.freeze(
    RUNTIME_FILES.filter(
        (file) =>
            ![
                'lib/metadataTypes/Query.js',
                'lib/metadataTypes/DataExtension.js',
                'lib/metadataTypes/definitions/Query.definition.js',
            ].includes(file)
    ).concat([
        'lib/metadataTypes/Script.js',
        'lib/metadataTypes/definitions/Script.definition.js',
        'lib/metadataTypes/definitions/Folder.definition.js',
        'lib/util/replaceContentBlockReference.js',
    ])
);

export interface QueryFileEvidence {
    readonly path: string;
    readonly exists: boolean;
    readonly size: number;
    readonly hash: string;
    readonly identity: string;
}
interface PreparedRetrieve extends QueryProjectSnapshot {
    readonly eid: string;
    readonly configSnapshot: string;
    readonly argv: readonly string[];
    readonly before: readonly QueryFileEvidence[];
    readonly runtime: Readonly<{
        cliEntry: string;
        node: string;
        nodeIdentity: string;
        version: '10.1.0';
        files: readonly QueryFileEvidence[];
    }>;
    readonly effects: readonly string[];
    readonly executionEnabled: false;
}

export interface PreparedQueryRetrieve extends PreparedRetrieve {
    readonly destinations: Readonly<{ json: string; sql: string }>;
}
export interface PreparedScriptRetrieve extends PreparedRetrieve {
    readonly metadataType: 'script';
    readonly destinations: Readonly<{ json: string; ssjs: string; html: string }>;
}

/** Fixed failure text excludes parser, filesystem, native and authentication diagnostics. */
export class QueryRetrievePreparationError extends Error {
    constructor() {
        super('Query retrieve preparation unavailable.');
        this.name = 'QueryRetrievePreparationError';
    }
}

function identity(stat: fs.Stats): string {
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]);
}

function spelling(candidate: string): void {
    if (
        !path.isAbsolute(candidate) ||
        candidate.startsWith('\\\\') ||
        path.normalize(candidate) !== candidate ||
        candidate
            .split(/[\\/]/u)
            .some((part, index) =>
                index === 0 && /^[a-z]:$/iu.test(part)
                    ? false
                    : /[ .:]$/u.test(part) ||
                      part.includes(':') ||
                      part.toLowerCase() === '.mcdev-auth.json'
            )
    )
        throw new QueryRetrievePreparationError();
}

/**
 * Validate every existing ancestor; missing paths are evidence, never permission to create.
 * @param candidate - Exact absolute path to inspect without following links.
 * @returns {fs.Stats | undefined} Selected entry metadata, or absence.
 */
function metadata(candidate: string): fs.Stats | undefined {
    spelling(candidate);
    let selected: fs.Stats | undefined;
    let current = candidate;
    for (;;) {
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || fs.realpathSync.native(current) !== current) {
                throw new QueryRetrievePreparationError();
            }
            if (current === candidate) selected = stat;
            else if (!stat.isDirectory()) throw new QueryRetrievePreparationError();
        } catch (ex) {
            if ((ex as NodeJS.ErrnoException).code !== 'ENOENT') throw ex;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return selected;
}

function evidence(
    candidate: string,
    required = false,
    capture?: (bytes: Buffer) => void
): QueryFileEvidence {
    const before = metadata(candidate);
    if (!before) {
        if (required) throw new QueryRetrievePreparationError();
        return Object.freeze({ path: candidate, exists: false, size: 0, hash: '', identity: '' });
    }
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) {
        throw new QueryRetrievePreparationError();
    }
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        if (identity(before) !== identity(fs.fstatSync(fd)))
            throw new QueryRetrievePreparationError();
        const bytes = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
            if (count === 0) break;
            length += count;
        }
        const after = metadata(candidate);
        if (
            length !== before.size ||
            !after ||
            identity(before) !== identity(after) ||
            identity(before) !== identity(fs.fstatSync(fd))
        )
            throw new QueryRetrievePreparationError();
        capture?.(bytes.subarray(0, length));
        return Object.freeze({
            path: candidate,
            exists: true,
            size: length,
            hash: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'),
            identity: identity(before),
        });
    } finally {
        fs.closeSync(fd);
    }
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new QueryRetrievePreparationError();
    return value as Record<string, unknown>;
}

function positive(value: unknown): string {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^\d+$/u.test(value) && /[1-9]/u.test(value)) return value;
    throw new QueryRetrievePreparationError();
}

/**
 * Bind exact config, Git protection, safe pair destinations and a fixed installed-runtime surface.
 * Caller must hold project/path mutation exclusion throughout collection, recheck and later settlement.
 * This is local evidence, not remote/auth readiness, approval or a complete dependency integrity proof.
 * @param selection - Exact canonical project, credential, business unit and literal query key.
 * @returns {PreparedQueryRetrieve} Deeply immutable, non-executing preparation.
 */
export function prepareQueryRetrieve(selection: QueryProjectSelection): PreparedQueryRetrieve {
    if (selection.metadataType !== undefined && selection.metadataType !== 'query')
        throw new QueryRetrievePreparationError();
    return prepareRetrieve(selection, 'query') as PreparedQueryRetrieve;
}

/**
 * Prepare Script metadata candidates only; no process, settlement or source execution.
 * @param selection - Exact project, credential, BU and literal key; optional type must be script.
 * @returns {PreparedScriptRetrieve} Immutable Script-specific evidence.
 */
export function prepareScriptRetrieve(selection: QueryProjectSelection): PreparedScriptRetrieve {
    if (selection.metadataType !== undefined && selection.metadataType !== 'script')
        throw new QueryRetrievePreparationError();
    return prepareRetrieve(selection, 'script') as PreparedScriptRetrieve;
}

function prepareRetrieve(
    selection: QueryProjectSelection,
    metadataType: RetrieveMetadataType
): PreparedQueryRetrieve | PreparedScriptRetrieve {
    try {
        const selected = metadataType === 'script' ? { ...selection, metadataType } : selection;
        const base = collectQueryProjectSnapshot(selected);
        if (
            [base.credential, base.businessUnit, base.key].some(
                (value) =>
                    value.endsWith('.') ||
                    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
            )
        ) {
            throw new QueryRetrievePreparationError();
        }
        const project = readProjectConfig(base.projectRoot);
        const config = project.config;
        const eid = positive(record(record(config.credentials)[base.credential]).eid);
        if (config.version !== QUERY_RETRIEVE_CONTRACT.reviewedVersion)
            throw new QueryRetrievePreparationError();
        const security = inspectProjectGitSecurity(base.projectRoot);
        if (security.status !== 'protected') throw new QueryRetrievePreparationError();
        // Presence alone is a stop boundary. Never read, import or hash a project hook.
        if (metadata(path.join(base.projectRoot, '.mcdev-validations.js')))
            throw new QueryRetrievePreparationError();
        const docs = record(config.metaDataTypes).documentOnRetrieve;
        if (
            !Array.isArray(docs) ||
            docs.some((type) => typeof type !== 'string') ||
            docs.includes(metadataType)
        ) {
            throw new QueryRetrievePreparationError();
        }
        const retrieve = record(config.directories).retrieve;
        // Native filename/path encoding preserves this deliberately small relative grammar.
        if (
            typeof retrieve !== 'string' ||
            !/^[A-Za-z0-9_. /-]+$/u.test(retrieve) ||
            path.isAbsolute(retrieve)
        )
            throw new QueryRetrievePreparationError();
        const parts = retrieve.replace(/\/$/u, '').split('/');
        if (
            parts.some(
                (part) =>
                    !part ||
                    part === '.' ||
                    part.includes('..') ||
                    /[ .]$/u.test(part) ||
                    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
            )
        )
            throw new QueryRetrievePreparationError();
        const destination = path.join(
            base.projectRoot,
            ...parts,
            base.credential,
            base.businessUnit,
            metadataType
        );
        const directory = metadata(destination);
        if (directory && !directory.isDirectory()) throw new QueryRetrievePreparationError();
        const destinations =
            metadataType === 'query'
                ? Object.freeze({
                      json: path.join(destination, `${base.key}.query-meta.json`),
                      sql: path.join(destination, `${base.key}.query-meta.sql`),
                  })
                : Object.freeze({
                      json: path.join(destination, `${base.key}.script-meta.json`),
                      ssjs: path.join(destination, `${base.key}.script-meta.ssjs`),
                      html: path.join(destination, `${base.key}.script-meta.html`),
                  });
        const before = Object.freeze(Object.values(destinations).map((file) => evidence(file)));
        const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('mcdev'))));
        const runtimeFiles = metadataType === 'query' ? RUNTIME_FILES : SCRIPT_RUNTIME_FILES;
        const files = Object.freeze(
            runtimeFiles.map((file) => evidence(path.join(packageRoot, file), true))
        );
        const manifest = JSON.parse(fs.readFileSync(files[0].path, 'utf8'));
        if (
            manifest.name !== 'mcdev' ||
            manifest.version !== '10.1.0' ||
            manifest.bin?.mcdev !== 'lib/cli.js'
        )
            throw new QueryRetrievePreparationError();
        if (evidence(files[0].path, true).hash !== files[0].hash)
            throw new QueryRetrievePreparationError();
        const node = metadata(process.execPath);
        if (!node?.isFile() || node.nlink !== 1) throw new QueryRetrievePreparationError();
        const runtime = Object.freeze({
            cliEntry: files[1].path,
            node: process.execPath,
            nodeIdentity: identity(node),
            version: '10.1.0' as const,
            files,
        });
        const argv = Object.freeze([
            'retrieve',
            `${base.credential}/${base.businessUnit}`,
            metadataType,
            base.key,
            '--no-purge',
            '--no-format',
            '--skipInteraction',
            '--noLogFile',
            '--noLogColors',
        ]);
        const effects =
            metadataType === 'script'
                ? Object.freeze([
                      ...SCRIPT_RETRIEVE_CONTRACT.remoteEffects,
                      ...SCRIPT_RETRIEVE_CONTRACT.localEffects,
                      ...SCRIPT_RETRIEVE_CONTRACT.restrictions,
                  ])
                : Object.freeze([
                      'Native SOAP active-key lookup and REST query read; dependency caches read folders and data extensions, including parent EID shared data extensions/folders for child MIDs.',
                      'Native authentication and session storage may be privately read and refreshed/persisted by mcdev/SDK. No assistant auth/session content inspection is permitted.',
                      'Native persistence may create or overwrite the exact JSON/SQL pair; zero-saved REST persistence may delete both, while early SOAP key-not-found leaves them untouched. No-purge suppresses wrapper cleanup only.',
                      'Fixed no-format bypasses formatter configuration/plugins; project validation hook must be absent; query documentOnRetrieve must be disabled; fixed noLogFile suppresses native file logging. Native output remains private.',
                      'Native mcdev deletions have the task-specific user exception, not proven native cleanup safety or portable operation authorization. No query activation, execution or other command is performed by this preparation.',
                  ]);
        if (collectQueryProjectSnapshot(selected).snapshot !== base.snapshot)
            throw new QueryRetrievePreparationError();
        const prepared = {
            ...base,
            eid,
            configSnapshot: base.snapshot,
            argv,
            destinations,
            before,
            runtime,
            effects,
            executionEnabled: false as const,
        };
        return Object.freeze({
            ...prepared,
            snapshot: createHash('sha256').update(JSON.stringify(prepared)).digest('hex'),
        }) as PreparedQueryRetrieve | PreparedScriptRetrieve;
    } catch {
        throw new QueryRetrievePreparationError();
    }
}

/**
 * Recollect all preparation evidence; readiness means unchanged local evidence only.
 * No approval, launch or remote result follows from a true return value.
 * @param prepared - Previously prepared exact selection and evidence.
 * @returns {Promise<Readonly<{ snapshot: string; ready: boolean }>>} Fail-closed drift comparison.
 */
export async function recheckPreparedQueryRetrieve(
    prepared: PreparedQueryRetrieve
): Promise<Readonly<{ snapshot: string; ready: boolean }>> {
    try {
        const current = prepareQueryRetrieve(prepared);
        return Object.freeze({
            snapshot: current.snapshot,
            ready: JSON.stringify(current) === JSON.stringify(prepared),
        });
    } catch {
        return Object.freeze({ snapshot: '', ready: false });
    }
}

/**
 * Recollect Script evidence without launch or artifact settlement.
 * @param prepared - Previously prepared Script selection and evidence.
 * @returns {Promise<Readonly<{ snapshot: string; ready: boolean }>>} Fail-closed comparison.
 */
export async function recheckPreparedScriptRetrieve(
    prepared: PreparedScriptRetrieve
): Promise<Readonly<{ snapshot: string; ready: boolean }>> {
    try {
        const current = prepareScriptRetrieve(prepared);
        return Object.freeze({
            snapshot: current.snapshot,
            ready: JSON.stringify(current) === JSON.stringify(prepared),
        });
    } catch {
        return Object.freeze({ snapshot: '', ready: false });
    }
}

export interface QueryRetrieveRunContext {
    readonly signal: AbortSignal;
    readonly processTimeoutMs?: number;
}
export interface QueryRetrieveRequestContext extends QueryRetrieveRunContext {
    readonly server: Parameters<typeof createQueryRetrieveSdkElicitor>[0];
    readonly extra: Parameters<typeof createQueryRetrieveSdkElicitor>[1];
    readonly confirmationTimeoutMs?: number;
}
type Materialization = 'local-materialization' | 'unchanged-unverified' | 'partial' | 'unverified';
export interface ConfirmedQueryRetrieveResult {
    readonly outcome: string;
    readonly materialization: Materialization;
    readonly projectBlocked: boolean;
    readonly remoteCompletenessVerified: false;
    readonly process: QueryProcessResult | null;
}
function materialization(prepared: PreparedQueryRetrieve): Materialization {
    try {
        const contents: Buffer[] = [];
        const after = [prepared.destinations.json, prepared.destinations.sql].map((file) =>
            evidence(file, false, (bytes) => contents.push(bytes))
        );
        // This classifies local bytes only; even a valid pair cannot prove remote completeness.
        if (
            after.every(
                (file, i) =>
                    file.exists === prepared.before[i].exists &&
                    file.size === prepared.before[i].size &&
                    file.hash === prepared.before[i].hash
            )
        )
            return 'unchanged-unverified';
        if (!after.every((file) => file.exists))
            return after.some((file) => file.exists) ? 'partial' : 'unverified';
        const decode = new TextDecoder('utf-8', { fatal: true });
        const json = record(JSON.parse(decode.decode(contents[0])));
        const sql = decode.decode(contents[1]);
        if (
            json.key !== prepared.key ||
            Object.hasOwn(json, 'queryText') ||
            !sql.trim() ||
            sql.includes('\0')
        )
            return 'unverified';
        // Reinspect after parsing to catch replacement/drift during pair settlement.
        if (
            after.some((file) => JSON.stringify(evidence(file.path, true)) !== JSON.stringify(file))
        )
            return 'unverified';
        return 'local-materialization';
    } catch {
        return 'unverified';
    }
}

function scriptMaterialization(prepared: PreparedScriptRetrieve): Materialization {
    try {
        const contents = new Map<string, Buffer>();
        const after = Object.values(prepared.destinations).map((file) =>
            evidence(file, false, (bytes) => contents.set(file, bytes))
        );
        const [jsonFile, ssjs, html] = after;
        // Native extraction may leave the alternate companion stale. Never guess which is current.
        if (ssjs.exists && html.exists) return 'unverified';
        if (
            after.every(
                (file, i) =>
                    file.exists === prepared.before[i].exists &&
                    file.size === prepared.before[i].size &&
                    file.hash === prepared.before[i].hash
            )
        )
            return 'unchanged-unverified';
        if (!jsonFile.exists || (!ssjs.exists && !html.exists))
            return after.some((file) => file.exists) ? 'partial' : 'unverified';
        // A companion-only change cannot establish a newly retrieved metadata result.
        if (jsonFile.hash === prepared.before[0].hash) return 'unverified';
        const decode = new TextDecoder('utf-8', { fatal: true });
        const json = record(JSON.parse(decode.decode(contents.get(jsonFile.path))));
        const source = decode.decode(contents.get((ssjs.exists ? ssjs : html).path));
        if (
            json.key !== prepared.key ||
            Object.hasOwn(json, 'script') ||
            !source.trim() ||
            source.includes('\0')
        )
            return 'unverified';
        // Reinspect all candidates, including the absent alternate, after parsing.
        if (after.some((file) => JSON.stringify(evidence(file.path)) !== JSON.stringify(file)))
            return 'unverified';
        return 'local-materialization';
    } catch {
        return 'unverified';
    }
}

/**
 * Construct an internal coordinator; injected seams are trusted test-only dependencies, not tool input.
 * @param seams - Controlled recheck and launcher substitutes; default binds the prepared CLI entry.
 * @param seams.recheck - Read-only Query drift check substitute.
 * @param seams.recheckScript - Read-only Script drift check substitute.
 * @param seams.launch - Controlled launcher substitute for synthetic tests.
 * @returns {object} Serialized runner and explicit external reconciliation acknowledgement.
 */
export function createQueryRetrieveCoordinator(
    seams: {
        recheck?: typeof recheckPreparedQueryRetrieve;
        recheckScript?: typeof recheckPreparedScriptRetrieve;
        launch?: typeof runQueryRetrieveProcess;
    } = {}
) {
    const recheck = seams.recheck ?? recheckPreparedQueryRetrieve;
    const recheckScript = seams.recheckScript ?? recheckPreparedScriptRetrieve;
    const launch = seams.launch ?? runQueryRetrieveProcess;
    async function run(
        prepared: PreparedQueryRetrieve | PreparedScriptRetrieve,
        context: QueryRetrieveRunContext,
        metadataType: RetrieveMetadataType,
        confirm?: () => Promise<string>
    ): Promise<ConfirmedQueryRetrieveResult> {
        const root = prepared.projectRoot;
        const response = (
            outcome: string,
            process: QueryProcessResult | null = null,
            classification: Materialization = 'unverified'
        ): ConfirmedQueryRetrieveResult =>
            Object.freeze({
                outcome,
                process,
                materialization: classification,
                projectBlocked: isBlocked(root),
                remoteCompletenessVerified: false,
            });
        // Reject cross-family replay before confirmation, recheck or launch.
        if (
            (prepared.metadataType === undefined ? 'query' : prepared.metadataType) !== metadataType
        )
            return response('blocked');
        if (!tryAcquire(root)) return response('project-busy');
        let launching = false;
        try {
            if (context.signal.aborted) return response('cancel');
            if (confirm) {
                const outcome = await confirm();
                if (outcome !== 'accepted') return response(outcome);
            }
            // No launcher runs inside the cancellable approval race. Its deadline is now settled.
            const final =
                metadataType === 'script'
                    ? await recheckScript(prepared as PreparedScriptRetrieve)
                    : await recheck(prepared as PreparedQueryRetrieve);
            if (context.signal.aborted) return response('cancel');
            if (!final.ready || final.snapshot !== prepared.snapshot) return response('blocked');
            launching = true;
            const process = await launch(
                prepared,
                {
                    signal: context.signal,
                    timeoutMs: context.processTimeoutMs,
                },
                { cliEntry: prepared.runtime.cliEntry }
            );
            if (process.outcome === 'termination-unconfirmed') block(root);
            return response(
                process.outcome,
                process,
                metadataType === 'script'
                    ? scriptMaterialization(prepared as PreparedScriptRetrieve)
                    : materialization(prepared as PreparedQueryRetrieve)
            );
        } catch {
            // A throwing launcher has unknown partial effects/termination. Keep exclusion latched.
            if (launching) block(root);
            return response('failed');
        } finally {
            release(root);
        }
    }
    return Object.freeze({
        /**
         * Explicit host acknowledgement only; never automatically reconcile or retry.
         * @param projectRoot - Exact canonical project whose external reconciliation completed.
         * @returns {boolean} Whether a blocked session was explicitly released.
         */
        acknowledgeExternalReconciliation,
        runQueryRetrieve(prepared: PreparedQueryRetrieve, context: QueryRetrieveRunContext) {
            return run(prepared, context, 'query');
        },
        runScriptRetrieve(prepared: PreparedScriptRetrieve, context: QueryRetrieveRunContext) {
            return run(prepared, context, 'script');
        },
        runConfirmedQueryRetrieve(
            prepared: PreparedQueryRetrieve,
            context: QueryRetrieveRequestContext
        ) {
            return run(prepared, context, 'query', async () => {
                const gate = createQueryRetrieveApproval(prepared, {
                    elicit: createQueryRetrieveSdkElicitor(context.server, context.extra),
                    signal: context.signal,
                    timeoutMs: context.confirmationTimeoutMs,
                    recheck: () => recheck(prepared),
                });
                return (await gate.confirm()).outcome;
            });
        },
    });
}

const coordinator = createQueryRetrieveCoordinator();
export const runScriptRetrieve = coordinator.runScriptRetrieve;
export const runQueryRetrieve = coordinator.runQueryRetrieve;
export const runConfirmedQueryRetrieve = coordinator.runConfirmedQueryRetrieve;
