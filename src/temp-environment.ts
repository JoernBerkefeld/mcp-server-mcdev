import os from 'node:os';
import path from 'node:path';

/**
 * Validate native temporary paths without changing the caller's environment.
 * Different configured variables are valid: the OS selects them by native precedence.
 * @param source - Environment to validate.
 * @param temporaryDirectory - Effective native OS temporary directory.
 * @param platform - Native path semantics.
 * @returns {void} Throws before any process or fixture is started for unsafe paths.
 */
export function validateTempEnvironment(
    source: NodeJS.ProcessEnv = process.env,
    temporaryDirectory: string = os.tmpdir(),
    platform: NodeJS.Platform = process.platform
): void {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (!temporaryDirectory) throw new Error('Invalid temporary environment');
    const configured = Object.entries(source)
        .filter(([name]) => /^(?:TEMP|TMP|TMPDIR)$/iu.test(name))
        .map(([, value]) => value);
    for (const value of [temporaryDirectory, ...configured]) {
        if (!value) continue;
        const normalized = paths.normalize(value);
        if (
            value.includes('\0') ||
            !paths.isAbsolute(value) ||
            (platform === 'win32' &&
                !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/iu.test(value)) ||
            normalized === paths.parse(normalized).root
        ) {
            throw new Error('Invalid temporary environment');
        }
    }
}

/**
 * Build the supervised child's allowlisted environment after validating temp paths.
 * @param source - Caller environment; never mutated.
 * @param temporaryDirectory - Effective native OS temporary directory.
 * @param platform - Native path semantics.
 * @returns {object} A fresh environment without arbitrary caller values.
 */
export function createNativeEnvironment(
    source: NodeJS.ProcessEnv = process.env,
    temporaryDirectory: string = os.tmpdir(),
    platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
    validateTempEnvironment(source, temporaryDirectory, platform);
    const allowed = new Set([
        'systemroot',
        'windir',
        'path',
        'pathext',
        'temp',
        'tmp',
        'tmpdir',
        'userprofile',
        'appdata',
        'localappdata',
        'programdata',
        'homedrive',
        'homepath',
    ]);
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(source)) {
        if (allowed.has(name.toLowerCase())) env[name.toUpperCase()] = value;
    }
    env.NO_COLOR = '1';
    return env;
}
