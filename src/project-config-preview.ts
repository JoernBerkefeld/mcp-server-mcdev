/** Pure complete-snapshot comparison; never applies or authorizes configuration changes. */
import { createHash } from 'node:crypto';
import type { ProjectConfig } from './project-inspection.js';
import {
    diagnoseProjectConfig,
    type ProjectConfigDiagnosis,
} from './project-config-diagnostics.js';

export const CONFIG_PREVIEW_LIMITS = Object.freeze({
    maxInputBytes: 1024 * 1024,
    maxDepth: 64,
    maxNodes: 20000,
    maxChanges: 1000,
    defaultOutputBytes: 64 * 1024,
    maxOutputBytes: 1024 * 1024,
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
export type ConfigPreviewChange =
    | { op: 'add'; path: string; after: Json }
    | { op: 'remove'; path: string; before: Json }
    | { op: 'replace'; path: string; before: Json; after: Json };
type PreviewFailure =
    | 'invalid-input'
    | 'input-too-large'
    | 'invalid-json'
    | 'non-object'
    | 'complexity-limit'
    | 'change-limit'
    | 'output-budget';

/** Safe failure with no partial diff and no input or parser fragments. */
export class ProjectConfigPreviewError extends Error {
    readonly complete = false;
    constructor(public readonly code: PreviewFailure) {
        super(`Project configuration preview incomplete: ${code}.`);
        this.name = 'ProjectConfigPreviewError';
    }
}

export interface ConfigPreviewSnapshot {
    sha256: string;
    bytes: number;
    basis: 'rawText encoded as UTF-8, without normalization';
}

export interface ProjectConfigPreview {
    complete: true;
    current: ConfigPreviewSnapshot;
    proposed: ConfigPreviewSnapshot;
    changes: ConfigPreviewChange[];
    diagnosis: ProjectConfigDiagnosis;
    limitations: string[];
}

const object = (value: Json): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code: PreviewFailure): never => {
    throw new ProjectConfigPreviewError(code);
};

/**
 * Parse a bounded complete object and reject excessive structure before recursive work.
 * @param rawText - Original JSON text, not a serialization of an overlay.
 * @returns {JsonObject} Parsed complete object, retaining unknown fields.
 */
function parse(rawText: string): JsonObject {
    if (typeof rawText !== 'string') fail('invalid-input');
    if (Buffer.byteLength(rawText, 'utf8') > CONFIG_PREVIEW_LIMITS.maxInputBytes)
        fail('input-too-large');
    let value: Json;
    try {
        value = JSON.parse(rawText) as Json;
    } catch {
        return fail('invalid-json');
    }
    if (!object(value)) return fail('non-object');
    const pending: { value: Json; depth: number }[] = [{ value, depth: 0 }];
    let nodes = 1;
    while (pending.length > 0) {
        const entry = pending.pop()!;
        if (entry.depth > CONFIG_PREVIEW_LIMITS.maxDepth) fail('complexity-limit');
        if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) fail('invalid-json');
        if (entry.value !== null && typeof entry.value === 'object') {
            const children = Object.values(entry.value);
            nodes += children.length;
            if (nodes > CONFIG_PREVIEW_LIMITS.maxNodes) fail('complexity-limit');
            for (const child of children) pending.push({ value: child, depth: entry.depth + 1 });
        }
    }
    return value;
}

/**
 * Compare bounded JSON values semantically, ignoring object key order but not array order.
 * @param before - Parsed current value.
 * @param after - Parsed proposed value.
 * @returns {boolean} Whether complete values match.
 */
function equal(before: Json, after: Json): boolean {
    if (before === after) return true;
    if (Array.isArray(before) && Array.isArray(after))
        return before.length === after.length && before.every((item, i) => equal(item, after[i]));
    if (!object(before) || !object(after)) return false;
    const keys = Object.keys(before);
    return (
        keys.length === Object.keys(after).length &&
        keys.every((key) => Object.hasOwn(after, key) && equal(before[key], after[key]))
    );
}

/**
 * Hash the exact supplied text encoding; original filesystem bytes are not available here.
 * @param rawText - Unmodified snapshot text.
 * @returns {ConfigPreviewSnapshot} Explicit hash basis and encoded byte length.
 */
function snapshot(rawText: string): ConfigPreviewSnapshot {
    return {
        sha256: createHash('sha256').update(rawText, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(rawText, 'utf8'),
        basis: 'rawText encoded as UTF-8, without normalization',
    };
}

/**
 * Preview two complete JSON snapshots without defaults, overlays, redaction or application.
 * Current rawText is authoritative, not a potentially changed config object on the wrapper.
 * Arrays are atomic; object changes use sorted, escaped JSON pointers. On any limit failure
 * no partial result is returned. The byte budget covers JSON.stringify of the whole result.
 * @param current - Previously inspected current snapshot; never re-read or mutated.
 * @param proposedRawText - Complete proposed JSON text, preserving its original text hash basis.
 * @param maxOutputBytes - Whole-result UTF-8 budget, positive integer up to 1 MiB.
 * @returns {ProjectConfigPreview} Complete bounded comparison with partial static proposed diagnosis.
 */
export function previewProjectConfig(
    current: ProjectConfig,
    proposedRawText: string,
    maxOutputBytes: number = CONFIG_PREVIEW_LIMITS.defaultOutputBytes
): ProjectConfigPreview {
    if (
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes < 1 ||
        maxOutputBytes > CONFIG_PREVIEW_LIMITS.maxOutputBytes
    )
        fail('invalid-input');
    const before = parse(current.rawText);
    const after = parse(proposedRawText);
    const changes: ConfigPreviewChange[] = [];
    let changeBytes = 2;
    const add = (change: ConfigPreviewChange): void => {
        if (changes.length >= CONFIG_PREVIEW_LIMITS.maxChanges) fail('change-limit');
        changeBytes += Buffer.byteLength(JSON.stringify(change), 'utf8') + 1;
        if (changeBytes > maxOutputBytes) fail('output-budget');
        changes.push(change);
    };
    const compare = (left: JsonObject, right: JsonObject, base: string): void => {
        const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].toSorted();
        for (const key of keys) {
            const pointer = `${base}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
            if (!Object.hasOwn(left, key)) add({ op: 'add', path: pointer, after: right[key] });
            else if (!Object.hasOwn(right, key))
                add({ op: 'remove', path: pointer, before: left[key] });
            else if (object(left[key]) && object(right[key]))
                compare(left[key], right[key], pointer);
            else if (!equal(left[key], right[key]))
                add({ op: 'replace', path: pointer, before: left[key], after: right[key] });
        }
    };
    compare(before, after, '');
    const result: ProjectConfigPreview = {
        complete: true,
        current: snapshot(current.rawText),
        proposed: snapshot(proposedRawText),
        changes,
        diagnosis: diagnoseProjectConfig({ ...current, rawText: proposedRawText, config: after }),
        limitations: [
            'Preview only: no writes, atomic file binding, apply authorization or deployment readiness.',
            'Hashes bind the supplied rawText UTF-8 encoding, not independently verified original filesystem bytes. No files are read again.',
            'Current rawText is the comparison snapshot. Removed and unknown fields are neither restored nor defaulted; arrays are compared atomically.',
            'Complete before/after values may contain sensitive user-owned configuration; no redaction is performed.',
        ],
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxOutputBytes) fail('output-budget');
    return result;
}
