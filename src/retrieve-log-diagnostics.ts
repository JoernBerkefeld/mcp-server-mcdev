import fs from 'node:fs';
import path from 'node:path';
import { readProjectConfig } from './project-inspection.js';

/** Private-read budgets for the bounded reader; never caller overrides. */
export const RETRIEVE_LOG_LIMITS = Object.freeze({
    directoryEntries: 256,
    candidates: 16,
    fileBytes: 1024 * 1024,
    totalBytes: 4 * 1024 * 1024,
    windowMilliseconds: 24 * 60 * 60 * 1000,
});

export type RetrieveLogFindingCode =
    | 'retrieve-start-observed'
    | 'type-key-observed'
    | 'download-zero-observed'
    | 'download-nonzero-observed';

export interface RetrieveLogSelection {
    credential: string;
    businessUnit: string;
    metadataType: 'query' | 'script';
    key: string;
    startedAfter: string;
    startedBefore: string;
    /** Validated normal-log basename, supplied by the reader, never a path. */
    file: string;
}

export interface RetrieveLogClassification {
    status: 'matched' | 'no-match' | 'ambiguous' | 'unsupported';
    remoteCompletenessVerified: false;
    invocationStartedAt?: string;
    findings: readonly { code: RetrieveLogFindingCode; occurrences: number }[];
    suppressedRecordCount: number;
}

const literal = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?![\s\S])/;
const utcIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const normalFilename = /^\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}\.\d{3}Z\.log$/;
const record = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3} (debug|info|warn|error): (.*)$/;
const invocation =
    /^:: mcdev 10\.1\.[01] :: ⚡ mcdev retrieve ([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}) (query|script) ([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;

/**
 * Accept only canonical, real UTC timestamps (not Date's normalized invalid dates).
 * @param value Candidate timestamp.
 * @returns {boolean} Whether the timestamp is canonical UTC ISO with milliseconds.
 */
function isUtc(value: string): boolean {
    return (
        utcIso.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value
    );
}

/**
 * Decode only mcdev's normal timestamp basename; error companions are excluded.
 * @param file A basename, never an absolute or relative path.
 * @returns {string | undefined} Canonical invocation start, or undefined for unsupported names.
 */
export function parseRetrieveLogFilename(file: string): string | undefined {
    if (!normalFilename.test(file)) return undefined;
    const timestamp = file.slice(0, -4).replace(/T(\d{2})\.(\d{2})\.(\d{2})\./, 'T$1:$2:$3.');
    return isUtc(timestamp) ? timestamp : undefined;
}

/**
 * Classify a single historical log privately, without I/O or native mcdev imports.
 * Grammar is deliberately literal: exactly four positional arguments, no options,
 * whitespace in selectors, quoting, lists, wildcards, aliases or shell syntax.
 * Filename UTC establishes time only alongside one version-bound invocation and
 * ordered retrieve / qualified-BU / exact type-key evidence. Record clocks are local
 * wall time and are deliberately not interpreted as UTC. Logs are observations,
 * not authenticated remote evidence. Dynamic suffixes never qualify as findings.
 * @param text Private bounded normal-log contents, already decoded strictly by the reader.
 * @param selection Exact configured aliases/key and filename selected by the reader.
 * @returns {RetrieveLogClassification} Finite codes and counts only; never echoes selectors or record text.
 */
export function classifyRetrieveLog(
    text: string,
    selection: RetrieveLogSelection
): RetrieveLogClassification {
    const finish = (
        status: RetrieveLogClassification['status'],
        suppressedRecordCount: number,
        findings: RetrieveLogClassification['findings'] = [],
        invocationStartedAt?: string
    ): RetrieveLogClassification => ({
        status,
        remoteCompletenessVerified: false,
        ...(invocationStartedAt ? { invocationStartedAt } : {}),
        findings,
        suppressedRecordCount,
    });
    const start = parseRetrieveLogFilename(selection.file);
    if (
        !start ||
        ![selection.credential, selection.businessUnit, selection.key].every((value) =>
            literal.test(value)
        ) ||
        !['query', 'script'].includes(selection.metadataType) ||
        !isUtc(selection.startedAfter) ||
        !isUtc(selection.startedBefore) ||
        Date.parse(selection.startedBefore) < Date.parse(selection.startedAfter) ||
        Date.parse(selection.startedBefore) - Date.parse(selection.startedAfter) >
            RETRIEVE_LOG_LIMITS.windowMilliseconds ||
        Buffer.byteLength(text, 'utf8') > RETRIEVE_LOG_LIMITS.fileBytes ||
        [...text].some((character) => {
            const code = character.codePointAt(0)!;
            return (
                (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
                code === 127 ||
                code === 65533
            );
        })
    )
        return finish('unsupported', 0);

    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const records = lines.map((line) => record.exec(line));
    // Count even malformed invocation-shaped records to reject concatenated runs.
    const headers = lines.filter((line) => line.includes(':: mcdev '));
    if (headers.length > 1) return finish('ambiguous', lines.length);
    if (headers.length === 0) return finish('no-match', lines.length);
    const headerIndex = lines.indexOf(headers[0]);
    const headerRecord = records[headerIndex];
    const parsed = headerRecord?.[1] === 'debug' ? invocation.exec(headerRecord[2]) : null;
    if (!parsed) return finish('unsupported', lines.length);
    const [, credential, businessUnit, metadataType, key] = parsed;
    if (
        credential !== selection.credential ||
        businessUnit !== selection.businessUnit ||
        metadataType !== selection.metadataType ||
        key !== selection.key ||
        start < selection.startedAfter ||
        start > selection.startedBefore
    )
        return finish('no-match', lines.length);

    const qualifiedBu = `:: Retrieving ${credential}/${businessUnit}`;
    const typeKey = `Retrieving: ${metadataType} - Key: ${key}`;
    const zero = `Downloaded: ${metadataType} (0) - Key: ${key}`;
    const nonzero =
        /^Downloaded: (query|script) \(([1-9]\d{0,8})\) - Key: ([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;
    const counts = new Map<RetrieveLogFindingCode, number>();
    let phase = 0;
    let suppressed = 0;
    let conflict = false;
    for (const [index, entry] of records.entries()) {
        if (index === headerIndex) continue;
        if (!entry) {
            suppressed++;
            continue;
        }
        const [, level, message] = entry;
        if (
            level === 'info' &&
            (message.startsWith(':: Retrieving ') || message.startsWith('Retrieving: ')) &&
            message !== qualifiedBu &&
            message !== typeKey
        )
            conflict = true;
        let code: RetrieveLogFindingCode | undefined;
        if (index > headerIndex && level === 'info') {
            if (message === 'mcdev:: Retrieve' && phase === 0) {
                phase = 1;
                code = 'retrieve-start-observed';
            } else if (message === qualifiedBu && phase === 1) phase = 2;
            else if (message === typeKey && phase === 2) {
                phase = 3;
                code = 'type-key-observed';
            } else if (phase === 3 && message === zero) code = 'download-zero-observed';
            else if (
                phase === 3 &&
                nonzero.exec(message)?.[1] === metadataType &&
                nonzero.exec(message)?.[3] === key
            )
                code = 'download-nonzero-observed';
            else {
                suppressed++;
                continue;
            }
            if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
        } else suppressed++;
    }
    if (conflict || phase !== 3) return finish('unsupported', lines.length);
    return finish(
        'matched',
        suppressed,
        [...counts].map(([code, occurrences]) => ({ code, occurrences })),
        start
    );
}

export interface RetrieveLogInput extends Omit<RetrieveLogSelection, 'file'> {
    workspaceRoot: string;
}

export interface RetrieveLogDiagnosis {
    status: RetrieveLogClassification['status'] | 'blocked' | 'unavailable';
    remoteCompletenessVerified: false;
    logs: readonly {
        file: string;
        invocationStartedAt: string;
        findings: RetrieveLogClassification['findings'];
        suppressedRecordCount: number;
    }[];
}

/** Internal sentinel only; neither paths nor native exception messages escape. */
class LogReadBlocked extends Error {}

function unchanged(left: fs.Stats, right: fs.Stats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs
    );
}

function canonical(candidate: string, directory: boolean): fs.Stats {
    const stat = fs.lstatSync(candidate);
    if (
        stat.isSymbolicLink() ||
        fs.realpathSync.native(candidate) !== candidate ||
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    )
        throw new LogReadBlocked();
    return stat;
}

/**
 * Inspect only historical normal logs in mcdev 10.1.0/10.1.1's fixed project/logs root.
 * Requires caller quiescence: metadata checks detect drift, not a filesystem lock.
 * Missing historical evidence never initiates retrieval, native execution or retries.
 * @param input Exact configured aliases, literal key and inclusive canonical UTC window.
 * @returns {RetrieveLogDiagnosis} Finite observations or a sanitized empty failure result.
 */
export function diagnoseRetrieveLogs(input: RetrieveLogInput): RetrieveLogDiagnosis {
    const finish = (status: RetrieveLogDiagnosis['status']): RetrieveLogDiagnosis => ({
        status,
        remoteCompletenessVerified: false,
        logs: [],
    });
    try {
        const fields = [
            'workspaceRoot',
            'credential',
            'businessUnit',
            'metadataType',
            'key',
            'startedAfter',
            'startedBefore',
        ];
        if (
            !input ||
            Object.keys(input).length !== fields.length ||
            fields.some((field) => typeof input[field as keyof RetrieveLogInput] !== 'string') ||
            Object.keys(input).some((field) => !fields.includes(field)) ||
            classifyRetrieveLog('', { ...input, file: '2000-01-01T00.00.00.000Z.log' }).status ===
                'unsupported'
        )
            return finish('unsupported');
        const project = readProjectConfig(input.workspaceRoot);
        const credentials = project.config.credentials;
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials))
            return finish('blocked');
        const credential = Object.hasOwn(credentials, input.credential)
            ? (credentials as Record<string, unknown>)[input.credential]
            : undefined;
        const units =
            credential && typeof credential === 'object' && !Array.isArray(credential)
                ? (credential as Record<string, unknown>).businessUnits
                : undefined;
        if (
            !units ||
            typeof units !== 'object' ||
            Array.isArray(units) ||
            !Object.hasOwn(units, input.businessUnit)
        )
            return finish('blocked');
        const rootBefore = canonical(project.projectRoot, true);
        // Source checkpoint: mcdev/lib/util/util.js uses literal 'logs/' for normal files.
        const logRoot = path.join(project.projectRoot, 'logs');
        let directoryBefore: fs.Stats;
        try {
            directoryBefore = canonical(logRoot, true);
        } catch (ex) {
            if ((ex as NodeJS.ErrnoException).code === 'ENOENT') return finish('no-match');
            throw ex;
        }
        const candidates: { file: string; stat: fs.Stats }[] = [];
        let entryCount = 0;
        const directory = fs.opendirSync(logRoot);
        try {
            for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
                if (++entryCount > RETRIEVE_LOG_LIMITS.directoryEntries) throw new LogReadBlocked();
                const timestamp = parseRetrieveLogFilename(entry.name);
                if (!timestamp || timestamp < input.startedAfter || timestamp > input.startedBefore)
                    continue;
                if (candidates.length === RETRIEVE_LOG_LIMITS.candidates)
                    throw new LogReadBlocked();
                const stat = canonical(path.join(logRoot, entry.name), false);
                if (stat.size > RETRIEVE_LOG_LIMITS.fileBytes) throw new LogReadBlocked();
                candidates.push({ file: entry.name, stat });
            }
        } finally {
            directory.closeSync();
        }
        // Complete discovery and all budgets precede classification/selection.
        if (
            candidates.reduce((sum, candidate) => sum + candidate.stat.size, 0) >
            RETRIEVE_LOG_LIMITS.totalBytes
        )
            throw new LogReadBlocked();
        const matches: RetrieveLogDiagnosis['logs'][number][] = [];
        let uncertain: 'ambiguous' | 'unsupported' | undefined;
        let totalRead = 0;
        for (const candidate of candidates) {
            const filename = path.join(logRoot, candidate.file);
            if (!unchanged(candidate.stat, canonical(filename, false))) throw new LogReadBlocked();
            const descriptor = fs.openSync(
                filename,
                fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
            );
            let text: string;
            try {
                if (!unchanged(candidate.stat, fs.fstatSync(descriptor)))
                    throw new LogReadBlocked();
                const bytes = Buffer.alloc(candidate.stat.size + 1);
                let length = 0;
                for (;;) {
                    const count = fs.readSync(
                        descriptor,
                        bytes,
                        length,
                        bytes.length - length,
                        null
                    );
                    length += count;
                    totalRead += count;
                    if (length > candidate.stat.size || totalRead > RETRIEVE_LOG_LIMITS.totalBytes)
                        throw new LogReadBlocked();
                    if (count === 0) break;
                }
                if (
                    length !== candidate.stat.size ||
                    !unchanged(candidate.stat, fs.fstatSync(descriptor)) ||
                    !unchanged(candidate.stat, canonical(filename, false))
                )
                    throw new LogReadBlocked();
                try {
                    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                        bytes.subarray(0, length)
                    );
                } catch {
                    return finish('unsupported');
                }
            } finally {
                fs.closeSync(descriptor);
            }
            const result = classifyRetrieveLog(text, { ...input, file: candidate.file });
            if (result.status === 'ambiguous') uncertain = 'ambiguous';
            else if (result.status === 'unsupported') uncertain ??= 'unsupported';
            else if (result.status === 'matched' && result.invocationStartedAt)
                matches.push({
                    file: candidate.file,
                    invocationStartedAt: result.invocationStartedAt,
                    findings: result.findings,
                    suppressedRecordCount: result.suppressedRecordCount,
                });
        }
        if (
            !unchanged(rootBefore, canonical(project.projectRoot, true)) ||
            !unchanged(directoryBefore, canonical(logRoot, true)) ||
            candidates.some(
                (candidate) =>
                    !unchanged(candidate.stat, canonical(path.join(logRoot, candidate.file), false))
            ) ||
            readProjectConfig(input.workspaceRoot).rawText !== project.rawText
        )
            throw new LogReadBlocked();
        if (uncertain) return finish(uncertain);
        matches.sort((left, right) =>
            right.invocationStartedAt.localeCompare(left.invocationStartedAt)
        );
        if (!matches.length) return finish('no-match');
        if (matches[1]?.invocationStartedAt === matches[0].invocationStartedAt)
            return finish('ambiguous');
        return { status: 'matched', remoteCompletenessVerified: false, logs: [matches[0]] };
    } catch (ex) {
        return finish(ex instanceof LogReadBlocked ? 'blocked' : 'unavailable');
    }
}
