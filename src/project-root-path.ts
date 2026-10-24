import path from 'node:path';

/**
 * Check exact native absolute spelling without accessing the filesystem.
 * Filesystem canonical identity and no-link checks remain the inspector's responsibility.
 * @param projectRoot - Untrusted project-root spelling.
 * @param pathApi - Native path rules; explicit dialects are for pure regression tests.
 * @returns {boolean} Whether the root has canonical absolute spelling and is not UNC.
 */
export function isCanonicalProjectRootPath(
    projectRoot: unknown,
    pathApi: Pick<typeof path, 'isAbsolute' | 'normalize'> = path
): projectRoot is string {
    return (
        typeof projectRoot === 'string' &&
        pathApi.isAbsolute(projectRoot) &&
        pathApi.normalize(projectRoot) === projectRoot &&
        !projectRoot.startsWith('\\\\')
    );
}
