/** Internal render adapter. External path/config quiescence is required through settlement. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readProjectConfig } from './project-inspection.js';
import { collectQueryProjectSnapshot } from './query-retrieve-project-snapshot.js';
import { inspectProjectGitSecurity } from './project-git-security.js';
import { runQueryDefinitionRenderProcess } from './query-definition-render-process.js';
import type { NativeProcessEvidence } from './native-process.js';
import {
    tryAcquire,
    block,
    release,
    isBlocked,
    acknowledgeExternalReconciliation,
} from './project-operation-guard.js';

const JSON_LIMIT = 1024 * 1024;
const SQL_LIMIT = 4 * JSON_LIMIT;
const OPENING = /\{\s*\{/u;
const VARIABLE = /^[A-Za-z][A-Za-z0-9_]*$/u;
const UNSAFE_VALUE = /[^A-Za-z0-9 _.,:/@+-]/u;
const RESERVED = new Set(['constructor', 'prototype', '__proto__']);
const RUNTIME_FILES = [
    'package.json',
    'lib/cli.js',
    'lib/index.js',
    'lib/Builder.js',
    'lib/metadataTypes/Query.js',
    'lib/metadataTypes/MetadataType.js',
    'lib/metadataTypes/definitions/Query.definition.js',
    'lib/util/config.js',
    'lib/util/cli.js',
    'lib/util/util.js',
    'lib/util/file.js',
    'lib/util/validations.js',
];

export interface QueryDefinitionRenderInput {
    readonly workspaceRoot: string;
    readonly credential: string;
    readonly businessUnit: string;
    readonly templateName: string;
    readonly market: string;
}
export interface RenderFileEvidence {
    readonly path: string;
    readonly exists: boolean;
    readonly size: number;
    readonly hash: string;
    readonly identity: string;
    readonly ancestors: readonly string[];
}
export interface PreparedQueryDefinitionRender {
    readonly projectRoot: string;
    readonly credential: string;
    readonly businessUnit: string;
    readonly templateName: string;
    readonly market: string;
    readonly eid: string;
    readonly mid: string;
    readonly outputKey: string;
    readonly config: RenderFileEvidence;
    readonly sources: Readonly<{ json: RenderFileEvidence; sql: RenderFileEvidence }>;
    readonly marketHash: string;
    readonly destinations: readonly Readonly<{
        json: string;
        sql: string;
        before: Readonly<{ json: RenderFileEvidence; sql: RenderFileEvidence }>;
    }>[];
    readonly runtime: Readonly<{
        cliEntry: string;
        node: string;
        nodeIdentity: string;
        version: '10.1.0';
        files: readonly RenderFileEvidence[];
    }>;
    readonly snapshot: string;
}

/** Fixed error text never exposes parser, filesystem or native diagnostics. */
export class QueryDefinitionRenderPreparationError extends Error {
    constructor() {
        super('Query definition render preparation unavailable.');
        this.name = 'QueryDefinitionRenderPreparationError';
    }
}
function fail(): never {
    throw new QueryDefinitionRenderPreparationError();
}
function hash(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    return value as Record<string, unknown>;
}
function own(parent: Record<string, unknown>, key: string): unknown {
    if (!Object.hasOwn(parent, key)) fail();
    return parent[key];
}
function literal(value: unknown): asserts value is string {
    if (
        typeof value !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_. -]*$/u.test(value) ||
        value.trim() !== value ||
        /[ .]$/u.test(value) ||
        value.includes('..') ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
    )
        fail();
}
function positive(value: unknown): string {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string' && /^\d+$/u.test(value) && /[1-9]/u.test(value)) return value;
    return fail();
}
function identity(stat: fs.Stats): string {
    return JSON.stringify([
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        stat.ctimeMs,
        stat.mode,
        stat.nlink,
    ]);
}
function metadata(candidate: string): { selected?: fs.Stats; ancestors: readonly string[] } {
    if (
        !path.win32.isAbsolute(candidate) ||
        candidate.startsWith('\\\\') ||
        path.normalize(candidate) !== candidate
    )
        fail();
    const parts = candidate.split(/[\\/]/u);
    if (
        parts.some((part, index) =>
            index === 0 && /^[A-Za-z]:$/u.test(part)
                ? false
                : /[ .:]$/u.test(part) ||
                  part.includes(':') ||
                  /^(?:\.mcdev-auth(?:\.|$)|\.git$|logs$|\.sf$|\.sfdx$)/iu.test(part)
        )
    )
        fail();
    const ancestors: string[] = [];
    let selected: fs.Stats | undefined;
    for (let current = candidate; ; current = path.dirname(current)) {
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || fs.realpathSync.native(current) !== current) fail();
            if (current === candidate) selected = stat;
            else {
                if (!stat.isDirectory()) fail();
                // Directory timestamps change for unrelated entries; bind stable filesystem identity.
                ancestors.push(
                    JSON.stringify([current, stat.dev, stat.ino, stat.mode, stat.birthtimeMs])
                );
            }
        } catch (ex) {
            if ((ex as NodeJS.ErrnoException).code !== 'ENOENT') throw ex;
            ancestors.push(JSON.stringify([current, 'missing']));
        }
        if (path.dirname(current) === current) break;
    }
    return { selected, ancestors: Object.freeze(ancestors) };
}
function evidence(
    candidate: string,
    limit: number,
    capture?: (bytes: Buffer) => void,
    required = capture !== undefined
): RenderFileEvidence {
    const before = metadata(candidate);
    if (!before.selected) {
        if (required) fail();
        return Object.freeze({
            path: candidate,
            exists: false,
            size: 0,
            hash: '',
            identity: '',
            ancestors: before.ancestors,
        });
    }
    const stat = before.selected;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) fail();
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        if (identity(stat) !== identity(fs.fstatSync(fd))) fail();
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
            if (!count) break;
            length += count;
        }
        const after = metadata(candidate);
        if (
            length !== stat.size ||
            !after.selected ||
            identity(stat) !== identity(after.selected) ||
            identity(stat) !== identity(fs.fstatSync(fd)) ||
            JSON.stringify(before.ancestors) !== JSON.stringify(after.ancestors)
        )
            fail();
        const content = bytes.subarray(0, length);
        capture?.(content);
        return Object.freeze({
            path: candidate,
            exists: true,
            size: length,
            hash: hash(content),
            identity: identity(stat),
            ancestors: before.ancestors,
        });
    } finally {
        fs.closeSync(fd);
    }
}
function text(bytes: Buffer): string {
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (value.includes('\0') || value.startsWith('\uFEFF')) fail();
    return value;
}
function rootPath(projectRoot: string, value: unknown): string {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_. /-]+$/u.test(value))
        fail();
    const parts = value.replace(/\/$/u, '').split('/');
    for (const part of parts) literal(part);
    const resolved = path.join(projectRoot, ...parts);
    const stat = metadata(resolved).selected;
    if (stat && !stat.isDirectory()) fail();
    return resolved;
}
function overlaps(left: string, right: string): boolean {
    const a = left.toLowerCase(),
        b = right.toLowerCase();
    return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

/**
 * Prepare one static-JSON query with lexical SQL tags; never substitute or launch native code.
 * Caller must keep external writers quiescent; snapshots are not locks or authorization.
 * @param input - Exact explicit project and configured selectors.
 * @returns {PreparedQueryDefinitionRender} Immutable bounded evidence without raw source/config values.
 */
export function prepareQueryDefinitionRender(
    input: QueryDefinitionRenderInput
): PreparedQueryDefinitionRender {
    try {
        for (const value of [
            input.credential,
            input.businessUnit,
            input.templateName,
            input.market,
        ])
            literal(value);
        if (input.market === '__clone__') fail();
        const base = collectQueryProjectSnapshot({
            projectRoot: input.workspaceRoot,
            credential: input.credential,
            businessUnit: input.businessUnit,
            key: input.templateName,
        });
        const projectRoot = base.projectRoot;
        let configValue: Record<string, unknown> = {};
        const config = evidence(path.join(projectRoot, '.mcdevrc.json'), JSON_LIMIT, (bytes) => {
            configValue = record(JSON.parse(text(bytes)));
        });
        // Reuse the fixed config accessor and its canonical project checks; bind its exact bytes too.
        if (hash(readProjectConfig(projectRoot).rawText) !== config.hash) fail();
        if (
            configValue.version !== '10.1.0' ||
            own(
                record(own(record(own(configValue, 'options')), 'validation')),
                'buildDefinition'
            ) !== false
        )
            fail();
        const credential = record(own(record(own(configValue, 'credentials')), input.credential));
        const eid = positive(own(credential, 'eid'));
        if (
            positive(own(record(own(credential, 'businessUnits')), input.businessUnit)) !== base.mid
        )
            fail();
        if (inspectProjectGitSecurity(projectRoot).status !== 'protected') fail();
        const market = record(own(record(own(configValue, 'markets')), input.market));
        for (const [name, value] of Object.entries(market)) {
            if (!VARIABLE.test(name) || name.trim() !== name || RESERVED.has(name)) fail();
            const effective = typeof value === 'string' ? value : own(record(value), 'replace');
            if (typeof effective !== 'string' || UNSAFE_VALUE.test(effective)) fail();
        }
        const directories = record(own(configValue, 'directories'));
        const templateRoot = rootPath(projectRoot, own(directories, 'template'));
        const builds = own(directories, 'templateBuilds');
        const roots = Array.isArray(builds) ? builds : [builds];
        if (!roots.length || roots.length > 16) fail();
        const outputRoots = roots.map((value) => rootPath(projectRoot, value));
        for (let i = 0; i < outputRoots.length; i++) {
            if (
                overlaps(templateRoot, outputRoots[i]) ||
                outputRoots.slice(0, i).some((root) => overlaps(root, outputRoots[i]))
            )
                fail();
        }
        let jsonText = '',
            sqlText = '';
        const json = evidence(
            path.join(templateRoot, 'query', `${input.templateName}.query-meta.json`),
            JSON_LIMIT,
            (bytes) => {
                jsonText = text(bytes);
            }
        );
        const sql = evidence(
            path.join(templateRoot, 'query', `${input.templateName}.query-meta.sql`),
            SQL_LIMIT,
            (bytes) => {
                sqlText = text(bytes);
            }
        );
        if (OPENING.test(jsonText)) fail();
        const outputKey = own(record(JSON.parse(jsonText)), 'key');
        literal(outputKey);
        // Native JSON rendering also replaces matching type-directory components.
        if (input.templateName === 'query' && outputKey !== 'query') fail();
        if (!sqlText.trim() || /\{\s+\{\{\{/u.test(sqlText)) fail();
        const remaining = sqlText.replaceAll(
            /(?<!\{)\{\{\{([A-Za-z][A-Za-z0-9_]*)\}\}\}(?!\})/gu,
            (_, name: string) => {
                if (!Object.hasOwn(market, name) || RESERVED.has(name)) fail();
                return '';
            }
        );
        if (OPENING.test(remaining) || remaining.includes('}}}')) fail();
        const destinations = Object.freeze(
            outputRoots.map((root) => {
                const directory = path.join(root, input.credential, input.businessUnit, 'query');
                const json = path.join(directory, `${outputKey}.query-meta.json`);
                const sql = path.join(directory, `${outputKey}.query-meta.sql`);
                return Object.freeze({
                    json,
                    sql,
                    before: Object.freeze({
                        json: evidence(json, JSON_LIMIT),
                        sql: evidence(sql, SQL_LIMIT),
                    }),
                });
            })
        );
        const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('mcdev'))));
        let manifest: Record<string, unknown> = {};
        const files = Object.freeze(
            RUNTIME_FILES.map((file, index) =>
                evidence(path.join(packageRoot, file), JSON_LIMIT, (bytes) => {
                    if (index === 0) manifest = record(JSON.parse(text(bytes)));
                })
            )
        );
        if (
            manifest.name !== 'mcdev' ||
            manifest.version !== '10.1.0' ||
            record(manifest.bin).mcdev !== 'lib/cli.js'
        )
            fail();
        const node = metadata(process.execPath).selected;
        if (!node?.isFile() || node.nlink !== 1) fail();
        const result = {
            projectRoot,
            credential: input.credential,
            businessUnit: input.businessUnit,
            templateName: input.templateName,
            market: input.market,
            eid,
            mid: base.mid,
            outputKey,
            config,
            sources: Object.freeze({ json, sql }),
            marketHash: hash(JSON.stringify(market)),
            destinations,
            runtime: Object.freeze({
                cliEntry: files[1].path,
                node: process.execPath,
                nodeIdentity: identity(node),
                version: '10.1.0' as const,
                files,
            }),
        };
        return Object.freeze({ ...result, snapshot: hash(JSON.stringify(result)) });
    } catch {
        return fail();
    }
}

/**
 * Recollect every bounded input immediately before guarded launch. No launch or lock is performed.
 * @param prepared - Prior immutable preparation; caller supplies external quiescence and shared guard.
 * @returns {Readonly<{ ready: boolean; snapshot: string }>} Unchanged local evidence only, never authorization.
 */
export function recheckQueryDefinitionRender(
    prepared: PreparedQueryDefinitionRender
): Readonly<{ ready: boolean; snapshot: string }> {
    try {
        const current = prepareQueryDefinitionRender({
            workspaceRoot: prepared.projectRoot,
            credential: prepared.credential,
            businessUnit: prepared.businessUnit,
            templateName: prepared.templateName,
            market: prepared.market,
        });
        const { snapshot, ...binding } = prepared;
        return Object.freeze({
            ready: current.snapshot === snapshot && hash(JSON.stringify(binding)) === snapshot,
            snapshot: current.snapshot,
        });
    } catch {
        return Object.freeze({ ready: false, snapshot: '' });
    }
}

export type RenderArtifactClassification =
    'local-materialization' | 'unchanged-unverified' | 'partial' | 'unverified';
export interface QueryDefinitionRenderContext {
    readonly signal: AbortSignal;
    readonly processTimeoutMs?: number;
}
export interface QueryDefinitionRenderResult {
    readonly outcome:
        | 'unavailable'
        | 'project-busy'
        | 'cancelled'
        | 'blocked'
        | 'failed'
        | NativeProcessEvidence['outcome'];
    readonly processOutcome: NativeProcessEvidence['outcome'] | null;
    readonly projectBlocked: boolean;
    readonly destinations: readonly Readonly<{
        index: number;
        artifactClassification: RenderArtifactClassification;
    }>[];
    readonly artifactCompletenessVerified: false;
    readonly remoteCompletenessVerified: false;
    readonly languageValidationPerformed: false;
}

function classifyRenderDestination(
    destination: PreparedQueryDefinitionRender['destinations'][number],
    outputKey: string
): RenderArtifactClassification {
    try {
        const contents: Buffer[] = [];
        const after = [destination.json, destination.sql].map((file, index) =>
            evidence(
                file,
                index ? SQL_LIMIT : JSON_LIMIT,
                (bytes) => {
                    contents[index] = bytes;
                },
                false
            )
        );
        const before = [destination.before.json, destination.before.sql];
        const changed = after.map(
            (file, index) =>
                file.exists !== before[index].exists ||
                file.size !== before[index].size ||
                file.hash !== before[index].hash
        );
        if (after[0].exists && record(JSON.parse(text(contents[0]))).key !== outputKey)
            return 'unverified';
        if (after[1].exists && !text(contents[1]).trim()) return 'unverified';
        let classification: RenderArtifactClassification;
        if (!changed.some(Boolean)) classification = 'unchanged-unverified';
        else if (after.every((file) => file.exists)) {
            classification = changed.every(Boolean) ? 'local-materialization' : 'partial';
        } else {
            classification = after.some((file) => file.exists) ? 'partial' : 'unverified';
        }
        // Reinspect every companion, including absent files, before reporting observations.
        if (
            after.some(
                (file, index) =>
                    JSON.stringify(evidence(file.path, index ? SQL_LIMIT : JSON_LIMIT)) !==
                    JSON.stringify(file)
            )
        )
            return 'unverified';
        return classification;
    } catch {
        return 'unverified';
    }
}

/**
 * Create the internal render coordinator. Seams are trusted synthetic-test dependencies only.
 * External writers must remain quiescent from preparation through settlement; this guard is local.
 * @param seams - Narrow preparation, recheck and launch substitutes, never public tool input.
 * @param seams.prepare - Synthetic preparation substitute.
 * @param seams.recheck - Synthetic immediate prelaunch drift check.
 * @param seams.launch - Synthetic process evidence producer.
 * @returns {object} Exact-operation executor and internal external-reconciliation acknowledgement.
 */
export function createQueryDefinitionRenderCoordinator(
    seams: {
        prepare?: typeof prepareQueryDefinitionRender;
        recheck?: typeof recheckQueryDefinitionRender;
        launch?: typeof runQueryDefinitionRenderProcess;
    } = {}
) {
    const prepare = seams.prepare ?? prepareQueryDefinitionRender;
    const recheck = seams.recheck ?? recheckQueryDefinitionRender;
    const launch = seams.launch ?? runQueryDefinitionRenderProcess;
    return Object.freeze({
        acknowledgeExternalReconciliation,
        async executeQueryDefinitionRender(
            input: QueryDefinitionRenderInput,
            context: QueryDefinitionRenderContext
        ): Promise<QueryDefinitionRenderResult> {
            let prepared: PreparedQueryDefinitionRender;
            const response = (
                outcome: QueryDefinitionRenderResult['outcome'],
                process: NativeProcessEvidence | null = null
            ): QueryDefinitionRenderResult =>
                Object.freeze({
                    outcome,
                    processOutcome: process?.outcome ?? null,
                    projectBlocked: prepared ? isBlocked(prepared.projectRoot) : false,
                    destinations: Object.freeze(
                        (prepared?.destinations ?? []).map((destination, index) =>
                            Object.freeze({
                                index,
                                artifactClassification:
                                    process?.directChildClosed && process.started
                                        ? classifyRenderDestination(destination, prepared.outputKey)
                                        : ('unverified' as const),
                            })
                        )
                    ),
                    artifactCompletenessVerified: false,
                    remoteCompletenessVerified: false,
                    languageValidationPerformed: false,
                });
            try {
                prepared = prepare(input);
            } catch {
                return response('unavailable');
            }
            const root = prepared.projectRoot;
            if (!tryAcquire(root)) return response('project-busy');
            let launching = false;
            try {
                if (context.signal.aborted) return response('cancelled');
                const final = recheck(prepared);
                if (context.signal.aborted) return response('cancelled');
                if (!final.ready || final.snapshot !== prepared.snapshot)
                    return response('blocked');
                launching = true;
                const process = await launch(
                    prepared,
                    { signal: context.signal, timeoutMs: context.processTimeoutMs },
                    { cliEntry: prepared.runtime.cliEntry }
                );
                if (
                    process.outcome === 'termination-unconfirmed' ||
                    (process.started && !process.directChildClosed)
                )
                    block(root);
                return response(
                    process.outcome === 'exited' &&
                        (process.exitCode !== 0 || process.exitSignal !== null)
                        ? 'failed'
                        : process.outcome,
                    process
                );
            } catch {
                if (launching) block(root);
                return response('failed');
            } finally {
                release(root);
            }
        },
    });
}

const renderCoordinator = createQueryDefinitionRenderCoordinator();
export const executeQueryDefinitionRender = renderCoordinator.executeQueryDefinitionRender;
