/** Bounded path-metadata inventory. Callers must prevent concurrent filesystem mutation. */
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from './project-inspection.js';

export interface ArtifactLimits {
    maxEntries: number;
    maxDepth: number;
}
export interface ArtifactFinding {
    code: 'invalid-config' | 'unsafe-path' | 'unavailable' | 'incomplete' | 'ambiguous';
    path: string;
}
export interface ProjectArtifact {
    rootKind: 'retrieve' | 'deploy';
    credential: string;
    businessUnit: string;
    metadataType: string;
    assetSubtype?: string;
    /** Canonical absolute path; not authorization to open the file. */
    absolutePath: string;
    relativePath: string;
    filename: string;
    /** Filename evidence only: never decoded or treated as a resolved customer key. */
    metadataFilename?: { stem: string; type: string; extension: string };
    extension: string;
    bytes: number;
}
export interface ArtifactInventory {
    projectRoot: string;
    artifacts: ProjectArtifact[];
    findings: ArtifactFinding[];
    complete: boolean;
    visitedEntries: number;
    limits: ArtifactLimits;
}

const DEFAULT_LIMITS: ArtifactLimits = { maxEntries: 10000, maxDepth: 12 };
// Verified against installed mcdev lib/util/config.js getDefaultProperties() and boilerplate/config.json.
const DEFAULT_ROOTS = { retrieve: 'retrieve/', deploy: 'deploy/' } as const;
const forbidden = new Set(['.mcdev-auth.json', '.git', 'logs']);
const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const segment = (value: string): boolean =>
    !!value &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/:]/u.test(value) &&
    [...value].every((character) => character.codePointAt(0)! >= 32) &&
    !/[ .]$/u.test(value) &&
    !forbidden.has(value.toLowerCase());
const contained = (root: string, target: string): boolean => {
    const relative = path.relative(root, target);
    return (
        !!relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
};

/**
 * Inventory configured credential/BU/type paths without opening artifact files.
 * Findings invalidate completeness; even a complete result is not file-open authorization.
 * @param project - Unmodified result of readProjectConfig; config contents are never reread here.
 * @param requested - Optional lower traversal bounds; hard ceilings cannot be raised.
 * @returns {ArtifactInventory} Metadata-only inventory and explicit safety, ambiguity and incompleteness findings.
 */
export function inventoryProjectArtifacts(
    project: ProjectConfig,
    requested: Partial<ArtifactLimits> = {}
): ArtifactInventory {
    const limits = { ...DEFAULT_LIMITS, ...requested };
    const result: ArtifactInventory = {
        projectRoot: project.projectRoot,
        artifacts: [],
        findings: [],
        complete: true,
        visitedEntries: 0,
        limits,
    };
    const report = (code: ArtifactFinding['code'], location: string): void => {
        result.complete = false;
        result.findings.push({ code, path: location });
    };
    if (
        Object.keys(requested).some((key) => !(key in DEFAULT_LIMITS)) ||
        Object.entries(limits).some(
            ([key, value]) =>
                !Number.isSafeInteger(value) ||
                value < 1 ||
                value > DEFAULT_LIMITS[key as keyof ArtifactLimits]
        )
    ) {
        report('invalid-config', 'limits');
        return result;
    }
    const inspect = (candidate: string, allowMissing = false): fs.Stats | undefined => {
        try {
            const stat = fs.lstatSync(candidate);
            if (
                stat.isSymbolicLink() ||
                fs.realpathSync.native(candidate) !== candidate ||
                (stat.isFile() ? stat.nlink !== 1 : !stat.isDirectory())
            ) {
                report('unsafe-path', path.relative(project.projectRoot, candidate));
                return;
            }
            return stat;
        } catch (ex) {
            if (!allowMissing || (ex as NodeJS.ErrnoException).code !== 'ENOENT')
                report('unavailable', path.relative(project.projectRoot, candidate));
        }
    };
    const root = project.projectRoot;
    if (!path.isAbsolute(root) || path.normalize(root) !== root || root.startsWith('\\\\')) {
        report('unsafe-path', 'projectRoot');
        return result;
    }
    for (let current = root; ; current = path.dirname(current)) {
        if (!inspect(current)?.isDirectory()) {
            report('unsafe-path', 'projectRoot');
            return result;
        }
        if (path.dirname(current) === current) break;
    }
    const config = project.config;
    if (
        !object(config) ||
        !object(config.credentials) ||
        (config.directories !== undefined && !object(config.directories))
    ) {
        report('invalid-config', 'config');
        return result;
    }
    const roots: { kind: 'retrieve' | 'deploy'; absolute: string }[] = [];
    for (const kind of ['retrieve', 'deploy'] as const) {
        const configured =
            config.directories && Object.hasOwn(config.directories, kind)
                ? (config.directories as Record<string, unknown>)[kind]
                : DEFAULT_ROOTS[kind];
        if (
            typeof configured !== 'string' ||
            !configured ||
            path.isAbsolute(configured) ||
            !configured
                .replace(/[\\/]$/u, '')
                .split(/[\\/]/u)
                .every(segment)
        ) {
            report('invalid-config', `directories.${kind}`);
            continue;
        }
        if (configured.split(/[\\/]/u).length > limits.maxDepth) {
            report('incomplete', `directories.${kind}`);
            continue;
        }
        const absolute = path.resolve(root, configured);
        if (contained(root, absolute)) {
            roots.push({ kind, absolute });
        } else {
            report('unsafe-path', `directories.${kind}`);
        }
    }
    if (roots.length !== 2) return result;
    if (
        roots[0].absolute.toLowerCase() === roots[1].absolute.toLowerCase() ||
        contained(roots[0].absolute, roots[1].absolute) ||
        contained(roots[1].absolute, roots[0].absolute)
    ) {
        report('ambiguous', 'directories');
        return result;
    }
    const units: { credential: string; businessUnit: string }[] = [];
    const credentials = new Set<string>();
    for (const [credential, definition] of Object.entries(config.credentials)) {
        if (credentials.has(credential.toLowerCase())) {
            report('ambiguous', 'credentials');
            return result;
        }
        credentials.add(credential.toLowerCase());
        if (!segment(credential) || !object(definition) || !object(definition.businessUnits)) {
            report('invalid-config', 'credentials');
            return result;
        }
        const mids = new Set<string>();
        const aliases = new Set<string>();
        for (const [businessUnit, mid] of Object.entries(definition.businessUnits)) {
            if (
                !segment(businessUnit) ||
                !(
                    (typeof mid === 'string' && /^\d+$/u.test(mid)) ||
                    (typeof mid === 'number' && Number.isSafeInteger(mid) && mid >= 0)
                )
            ) {
                report('invalid-config', 'businessUnits');
                return result;
            }
            if (mids.has(String(mid)) || aliases.has(businessUnit.toLowerCase()))
                report('ambiguous', `${credential}/${businessUnit}`);
            mids.add(String(mid));
            aliases.add(businessUnit.toLowerCase());
            units.push({ credential, businessUnit });
            if (units.length > limits.maxEntries) {
                report('incomplete', 'businessUnits');
                return result;
            }
        }
    }
    let exhausted = false;
    const walk = (
        directory: string,
        context: Omit<
            ProjectArtifact,
            'absolutePath' | 'relativePath' | 'filename' | 'extension' | 'bytes'
        >,
        parts: string[]
    ): void => {
        let handle: fs.Dir | undefined;
        try {
            handle = fs.opendirSync(directory);
            for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
                if (result.visitedEntries >= limits.maxEntries) {
                    if (!exhausted) report('incomplete', path.relative(root, directory));
                    exhausted = true;
                    break;
                }
                result.visitedEntries++;
                if (!segment(entry.name)) {
                    report('unsafe-path', path.relative(root, directory));
                    continue;
                }
                const absolutePath = path.join(directory, entry.name);
                const stat = inspect(absolutePath);
                if (!stat) continue;
                const next = [...parts, entry.name];
                if (stat.isDirectory()) {
                    if (next.length >= limits.maxDepth)
                        report('incomplete', path.relative(root, absolutePath));
                    else walk(absolutePath, context, next);
                } else if (parts.length === 0)
                    report('ambiguous', path.relative(root, absolutePath));
                else {
                    const metadata = /^(.*)\.([^.]+)-meta\.([^.]+)$/u.exec(entry.name);
                    result.artifacts.push({
                        ...context,
                        metadataType: parts[0],
                        ...(parts[0] === 'asset' && parts.length > 1
                            ? { assetSubtype: parts[1] }
                            : {}),
                        absolutePath,
                        relativePath: path.relative(root, absolutePath),
                        filename: entry.name,
                        extension: path.extname(entry.name),
                        bytes: stat.size,
                        ...(metadata
                            ? {
                                  metadataFilename: {
                                      stem: metadata[1],
                                      type: metadata[2],
                                      extension: metadata[3],
                                  },
                              }
                            : {}),
                    });
                }
                if (exhausted) break;
            }
        } catch {
            report('unavailable', path.relative(root, directory));
        } finally {
            handle?.closeSync();
        }
    };
    for (const selected of roots) {
        for (const unit of units) {
            if (exhausted) break;
            const target = path.join(selected.absolute, unit.credential, unit.businessUnit);
            let current = root;
            let valid = true;
            for (const part of path.relative(root, target).split(path.sep)) {
                current = path.join(current, part);
                if (!inspect(current, true)?.isDirectory()) {
                    valid = false;
                    break;
                }
            }
            if (valid) walk(target, { rootKind: selected.kind, ...unit, metadataType: '' }, []);
        }
    }
    return result;
}
