/** Fixed-name, metadata-checked project configuration inspection. */
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_NAME = '.mcdevrc.json';
const MAX_CONFIG_BYTES = 1024 * 1024;

type InspectionFailure =
    'unsafe-path' | 'missing-config' | 'config-too-large' | 'invalid-config' | 'unavailable';

export interface ProjectConfig {
    projectRoot: string;
    configPath: string;
    rawText: string;
    config: Record<string, unknown>;
}

/** Safe classifications only: never forward filesystem or parser exception text. */
export class ProjectInspectionError extends Error {
    constructor(public readonly code: InspectionFailure) {
        super(`Project configuration inspection failed: ${code}.`);
        this.name = 'ProjectInspectionError';
    }
}

function fail(code: InspectionFailure): never {
    throw new ProjectInspectionError(code);
}

function checkSpelling(candidate: string): void {
    // Deny the auth name before even inspecting filesystem metadata.
    const parts = candidate.split(/[\\/]/);
    if (
        parts.some((part) => part.replace(/[ .]+$/u, '').toLowerCase() === '.mcdev-auth.json') ||
        !path.isAbsolute(candidate) ||
        candidate.startsWith('\\\\') ||
        parts.some((part, index) =>
            index === 0 && /^[a-z]:$/iu.test(part)
                ? false
                : part === '.' || part === '..' || /[ .:]$/u.test(part) || part.includes(':')
        ) ||
        path.normalize(candidate) !== candidate.replaceAll('/', path.sep)
    ) {
        fail('unsafe-path');
    }
}

function checkCanonical(candidate: string): fs.Stats {
    checkSpelling(candidate);
    const normalized = path.normalize(candidate);
    let current = normalized;
    let selected: fs.Stats | undefined;
    for (;;) {
        const metadata = fs.lstatSync(current);
        if (metadata.isSymbolicLink() || fs.realpathSync.native(current) !== current) {
            fail('unsafe-path');
        }
        selected ??= metadata;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return selected!;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
    return (
        right.isFile() &&
        right.nlink === 1 &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs
    );
}

/**
 * Read only a canonical project's complete config; never load validation hooks or auth.
 * This is not an atomic filesystem sandbox: callers must prevent concurrent path mutation.
 * @param projectRoot - Explicit absolute root with its canonical filesystem spelling.
 * @returns {ProjectConfig} The entire config text and object, including all user-owned fields.
 */
export function readProjectConfig(projectRoot: string): ProjectConfig {
    let descriptor: number | undefined;
    try {
        if (typeof projectRoot !== 'string') fail('unsafe-path');
        if (!checkCanonical(projectRoot).isDirectory()) fail('unsafe-path');
        const configPath = path.join(projectRoot, CONFIG_NAME);
        // The private content accessor is deliberately restricted to this one literal name.
        checkSpelling(configPath);
        if (path.basename(configPath) !== CONFIG_NAME) fail('unsafe-path');
        let before: fs.Stats;
        try {
            before = checkCanonical(configPath);
        } catch (ex) {
            if ((ex as NodeJS.ErrnoException).code === 'ENOENT') fail('missing-config');
            throw ex;
        }
        if (!before.isFile() || before.nlink !== 1) fail('unsafe-path');
        if (before.size > MAX_CONFIG_BYTES) fail('config-too-large');
        descriptor = fs.openSync(
            configPath,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
        );
        if (!sameFile(before, fs.fstatSync(descriptor))) fail('unsafe-path');
        const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
        let length = 0;
        for (;;) {
            const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
            length += count;
            if (length > MAX_CONFIG_BYTES) fail('config-too-large');
            if (count === 0) break;
        }
        if (
            !sameFile(before, fs.fstatSync(descriptor)) ||
            !sameFile(before, checkCanonical(configPath))
        ) {
            fail('unsafe-path');
        }
        const rawText = bytes.subarray(0, length).toString('utf8');
        let config: unknown;
        try {
            config = JSON.parse(rawText);
        } catch {
            fail('invalid-config');
        }
        if (config === null || Array.isArray(config) || typeof config !== 'object') {
            fail('invalid-config');
        }
        return {
            projectRoot: path.normalize(projectRoot),
            configPath,
            rawText,
            config: config as Record<string, unknown>,
        };
    } catch (ex) {
        if (ex instanceof ProjectInspectionError) throw ex;
        return fail('unavailable');
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Do not expose raw filesystem exceptions, including close failures.
            }
        }
    }
}
