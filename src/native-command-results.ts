import { StringDecoder } from 'node:string_decoder';
import Mcdev from 'mcdev';
import { ensureMcdevSilentJson } from './mcdev-safe.js';

const MAX_BYTES = 128 * 1024;
const MAX_ITEMS = 256;
const SENSITIVE =
    /authorization|bearer\s|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|debug:|verbose:|trace:/iu;

/** Canonical fields emitted by mcdev explainTypes --json. */
export interface NativeTypeInfo {
    name: string;
    apiName: string;
    retrieveByDefault: boolean | string[];
    supports: {
        retrieve: boolean;
        create: boolean;
        update: boolean;
        delete: boolean;
        changeKey: boolean;
        buildTemplate: boolean;
    };
    description: string;
}

/** Reviewed asset-only ID resolver fields, not remote API metadata. */
export interface NativeResolvedAsset {
    key?: string;
    name?: string;
    path?: string;
    folder?: string;
    mid?: number;
    legacyId?: number;
    isShared?: boolean;
    error?: '' | 'id not found' | 'file not found on local disk';
    sharedWith?: number[];
}

/** Only reviewed native stdout schemas are returned, never generic JSON or log text. */
export type NativeCommandResult =
    | { kind: 'type-catalog'; types: NativeTypeInfo[]; suppressed: boolean; truncated: boolean }
    | {
          kind: 'resolved-asset';
          asset: NativeResolvedAsset;
          suppressed: boolean;
          truncated: boolean;
      }
    | { kind: 'unavailable'; message: string; suppressed: boolean; truncated: boolean };

/**
 * Enforce native output capabilities before launch, without modifying argv.
 * @param command - Canonical command.
 * @param args - Native tokens.
 * @returns {string | undefined} Actionable reason for unsupported output forms.
 */
export function nativeResultBlock(command: string, args: readonly string[]): string | undefined {
    if (command === 'getFilesToCommit') {
        return 'The installed mcdev CLI discards getFilesToCommit results. Use the mcdev.getFilesToCommit(BU, TYPE, keys) programmatic API locally; no command was launched.';
    }
    if (!['resolveId', 'explainTypes'].includes(command)) return;
    // These commands have no value-taking options in the installed CLI. Unknown
    // options cannot safely be interpreted as selectors or advertised as supported.
    const options = new Set([
        '--json',
        '--json=true',
        '--silent',
        '--no-silent',
        '--noLogColors',
        '--noLogFile',
        '--errorLog',
    ]);
    const positionals: string[] = [];
    for (const token of args) {
        if (token.startsWith('-')) {
            if (!options.has(token))
                return 'Unsupported result option. Use explainTypes --json or resolveId BU asset ID --json with native logging flags only. No command was launched.';
        } else positionals.push(token);
    }
    if (!args.some((arg) => arg === '--json' || arg === '--json=true')) {
        return 'Structured native results require --json. Retry explainTypes --json or resolveId BU asset ID --json. No command was launched.';
    }
    if (command === 'explainTypes' && positionals.length) {
        return 'The installed explainTypes command has no filters or positional arguments. Use explainTypes --json for the complete catalog. No command was launched.';
    }
    if (command === 'resolveId' && (positionals.length !== 3 || positionals[1] !== 'asset')) {
        return 'Only resolveId BU asset ID --json has a supported native result schema. Other metadata types do not implement native ID resolution. No command was launched.';
    }
}

/**
 * Validate bounded plain metadata strings, rejecting controls and payload/log shapes.
 * @param value - Untrusted scalar.
 * @param limit - Maximum accepted string length.
 * @returns {boolean} Whether the scalar is reviewed plain text.
 */
function safeText(value: unknown, limit = 2048): value is string {
    return (
        typeof value === 'string' &&
        value.length <= limit &&
        !/[\p{Cc}\p{Cf}{}<>]/u.test(value) &&
        !SENSITIVE.test(value)
    );
}

/**
 * Project only the exact asset resolver output emitted by mcdev 10.1.x.
 * @param value - Parsed native JSON document.
 * @returns {NativeResolvedAsset | undefined} Validated fields or no result.
 */
function assetResult(value: unknown): NativeResolvedAsset | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    const allowed = [
        'key',
        'name',
        'path',
        'folder',
        'mid',
        'legacyId',
        'isShared',
        'error',
        'sharedWith',
    ];
    if (Object.keys(item).some((key) => !allowed.includes(key))) return;
    if (Object.keys(item).length === 1 && item.error === 'id not found')
        return { error: 'id not found' };
    if (
        !safeText(item.key, 512) ||
        !item.key ||
        !safeText(item.name, 512) ||
        !safeText(item.folder) ||
        typeof item.isShared !== 'boolean' ||
        !Number.isSafeInteger(item.mid) ||
        Number(item.mid) <= 0 ||
        (Object.hasOwn(item, 'error') &&
            item.error !== '' &&
            item.error !== 'file not found on local disk')
    )
        return;
    if (item.path !== undefined && !safeText(item.path)) return;
    if (
        item.legacyId !== undefined &&
        (!Number.isSafeInteger(item.legacyId) || Number(item.legacyId) <= 0)
    )
        return;
    if (
        item.sharedWith !== undefined &&
        (!Array.isArray(item.sharedWith) ||
            item.sharedWith.length > MAX_ITEMS ||
            item.sharedWith.some((mid) => !Number.isSafeInteger(mid) || mid <= 0))
    )
        return;
    return { ...item } as unknown as NativeResolvedAsset;
}

/**
 * Collect bounded stdout separately from diagnostics. Only SGR color escapes are
 * stripped; other terminal controls are rejected. JSON must occupy complete lines,
 * with no logger prefix. No substring extraction from debug lines or API bodies.
 * @param command - Native command whose reviewed result is expected.
 * @returns {object} Draining collector; overflow discards the result, never returns partial JSON.
 */
export function createNativeCommandResults(command: string): {
    write: (stream: 'stdout' | 'stderr', chunk: Buffer | string) => void;
    finish: (successful: boolean) => NativeCommandResult | undefined;
} {
    const expected = ['explainTypes', 'resolveId'].includes(command);
    let decoder = new StringDecoder('utf8');
    let text = '';
    let bytes = 0;
    let truncated = false;
    let suppressed = false;
    let finished = false;
    let snapshot: NativeCommandResult | undefined;
    return {
        write(stream, chunk) {
            if (finished || !expected) return;
            if (stream !== 'stdout') {
                if (chunk.length) suppressed = true;
                return;
            }
            const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
            if (size > MAX_BYTES - bytes) {
                truncated = true;
                suppressed = true;
                text = '';
                return;
            }
            bytes += size;
            if (truncated) return;
            if (typeof chunk === 'string') {
                text += decoder.end() + chunk;
                decoder = new StringDecoder('utf8');
            } else text += decoder.write(chunk);
        },
        finish(successful) {
            if (finished) return snapshot;
            finished = true;
            if (!expected) return;
            text += decoder.end();
            const unavailable = (): NativeCommandResult => ({
                kind: 'unavailable',
                message:
                    'No complete reviewed native JSON result was available. Retry with --json and without debug/verbose logging; inspect the native CLI locally if this persists.',
                suppressed: true,
                truncated,
            });
            if (!successful || truncated) return (snapshot = unavailable());
            // Only documented logger SGR styling is normalized. Preserve line
            // boundaries and reject all other controls instead of joining words.
            // eslint-disable-next-line no-control-regex -- SGR is the only accepted terminal control sequence.
            text = text.replaceAll(/\u001B\[[\d;]*m/gu, '');
            if (/[\p{Cc}\p{Cf}]/u.test(text.replaceAll(/[\r\n\t]/gu, '')))
                return (snapshot = unavailable());
            if (SENSITIVE.test(text)) return (snapshot = unavailable());
            const lines = text.split(/\r?\n/u);
            const documents: unknown[] = [];
            let pending = '';
            let depth = 0;
            let quoted = false;
            let escaped = false;
            for (const line of lines) {
                if (!pending && !/^\s*[[{]/u.test(line)) {
                    if (line.trim()) suppressed = true;
                    continue;
                }
                pending += line + '\n';
                for (const char of line) {
                    if (escaped) {
                        escaped = false;
                        continue;
                    }
                    if (quoted && char === '\\') {
                        escaped = true;
                        continue;
                    }
                    if (char === '"') quoted = !quoted;
                    else if (!quoted && (char === '{' || char === '[')) {
                        depth++;
                        if (depth > 16) return (snapshot = unavailable());
                    } else if (!quoted && (char === '}' || char === ']')) depth--;
                }
                if (depth <= 0 && !quoted) {
                    try {
                        documents.push(JSON.parse(pending));
                    } catch {
                        suppressed = true;
                    }
                    pending = '';
                    depth = 0;
                    if (documents.length > 1) return (snapshot = unavailable());
                }
            }
            if (pending || documents.length !== 1) return (snapshot = unavailable());
            if (command === 'resolveId') {
                const asset = assetResult(documents[0]);
                snapshot = asset
                    ? { kind: 'resolved-asset', asset, suppressed, truncated }
                    : unavailable();
            } else {
                // Canonical API is local, credential-free and silent. Match the
                // complete catalog exactly: never echo arbitrary description fields.
                ensureMcdevSilentJson();
                const canonical: unknown = Mcdev.explainTypes();
                const types = documents[0];
                snapshot =
                    Array.isArray(types) &&
                    types.length <= MAX_ITEMS &&
                    JSON.stringify(types) === JSON.stringify(canonical)
                        ? { kind: 'type-catalog', types, suppressed, truncated }
                        : unavailable();
            }
            text = '';
            return snapshot;
        },
    };
}
