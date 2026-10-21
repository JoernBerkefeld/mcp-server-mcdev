/** Read-only, deliberately narrow resolver. Callers must prevent concurrent filesystem mutation. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { inventoryProjectArtifacts, type ArtifactLimits } from './project-artifacts.js';
import type { ProjectConfig } from './project-inspection.js';

export interface ArtifactSelector {
    rootKind: 'retrieve' | 'deploy';
    credential: string;
    businessUnit: string;
    metadataType: string;
    externalKey: string;
}
export interface ArtifactResolution {
    status: 'resolved' | 'missing' | 'ambiguous' | 'unsupported' | 'blocked';
    metadataPaths: string[];
    editableCompanions: {
        absolutePath: string;
        language: 'sql' | 'ssjs' | 'html' | 'ampscript';
        role: 'source';
    }[];
    declaredDependencies: string[];
    /** Dependency types are declarations, not proof that a particular dependency exists. */
    locallyConfirmedDependencies: string[];
    dependencyResolution: 'not-evaluated';
    findings: { code: string; path?: string }[];
}

// Installed mcdev: Query.definition.js:2-5,14; Script.definition.js:3,9.
// Query.js:411-423,214-222; Script.js:100-124,335-348. No native modules execute here.
const supported = {
    query: { extensions: ['sql'], dependencies: ['folder-queryactivity', 'dataExtension'] },
    script: { extensions: ['ssjs', 'html'], dependencies: ['folder-ssjsactivity'] },
    'asset-email': {
        extensions: ['html', 'amp'],
        dependencies: ['folder-asset', 'folder-asset-shared', 'folder-cloudpages'],
    },
} as const;
const MAX_BYTES = 1024 * 1024;
const privateNames = new Set(['.mcdev-auth.json', '.git', '.mcdev', 'logs']);
const literal = (value: string): boolean =>
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_. -]*$/u.test(value) &&
    value.trim() === value &&
    !value.endsWith('.') &&
    !value.includes('..') &&
    !privateNames.has(value.toLowerCase());

/**
 * Revalidate spelling, containment and every ancestor without following links.
 * @param root - Canonical project root.
 * @param candidate - Explicit inventoried path, never read authorization by itself.
 * @returns {fs.Stats} Single-link regular-file metadata.
 */
function checkedFile(root: string, candidate: string): fs.Stats {
    const relative = path.relative(root, candidate);
    if (
        !path.isAbsolute(root) ||
        !path.isAbsolute(candidate) ||
        candidate.startsWith('\\\\') ||
        path.normalize(candidate) !== candidate ||
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        candidate
            .split(/[\\/]/u)
            .some((part, index) =>
                index === 0 && /^[A-Za-z]:$/u.test(part)
                    ? false
                    : privateNames.has(part.replace(/[ .]+$/u, '').toLowerCase()) ||
                      part === '..' ||
                      /[ .:]$/u.test(part) ||
                      part.includes(':')
            )
    )
        throw new Error('unsafe-path');
    let selected: fs.Stats | undefined;
    for (let current = candidate; ; current = path.dirname(current)) {
        const stat = fs.lstatSync(current);
        if (
            stat.isSymbolicLink() ||
            fs.realpathSync.native(current) !== current ||
            (current === candidate ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
        )
            throw new Error('unsafe-path');
        selected ??= stat;
        if (path.dirname(current) === current) break;
    }
    return selected!;
}

/**
 * Compare the opened descriptor with revalidated path metadata.
 * @param before - Metadata captured immediately before opening.
 * @param after - Descriptor or canonical path metadata.
 * @returns {boolean} Whether the same unchanged single-link file remains selected.
 */
function unchanged(before: fs.Stats, after: fs.Stats): boolean {
    return (
        after.isFile() &&
        after.nlink === 1 &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs
    );
}

/**
 * Read only a resolver-selected file, rechecking path and descriptor around bounded IO.
 * This detects some drift; it is not an atomic sandbox against concurrent mutation.
 * @param root - Canonical project root.
 * @param candidate - File selected privately from the verified inventory.
 * @returns {Buffer} Original bytes, never truncated.
 */
function readSelectedBytes(root: string, candidate: string): Buffer {
    const before = checkedFile(root, candidate);
    if (before.size > MAX_BYTES) throw new Error('metadata-too-large');
    const descriptor = fs.openSync(
        candidate,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    try {
        if (
            !unchanged(before, fs.fstatSync(descriptor)) ||
            !unchanged(before, checkedFile(root, candidate))
        )
            throw new Error('unsafe-path');
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        for (;;) {
            const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
            length += count;
            if (length > MAX_BYTES) throw new Error('metadata-too-large');
            if (!count) break;
        }
        if (
            !unchanged(before, fs.fstatSync(descriptor)) ||
            !unchanged(before, checkedFile(root, candidate))
        )
            throw new Error('unsafe-path');
        if (length !== before.size) throw new Error('unsafe-path');
        return bytes.subarray(0, length);
    } finally {
        fs.closeSync(descriptor);
    }
}

/**
 * Parse resolver-selected metadata without exposing its contents.
 * @param root - Canonical project root.
 * @param candidate - Inventoried metadata JSON.
 * @returns {unknown} Parsed metadata.
 */
function readMetadata(root: string, candidate: string): unknown {
    return JSON.parse(readSelectedBytes(root, candidate).toString('utf8')) as unknown;
}

export interface ProjectArtifactSource {
    status: ArtifactResolution['status'];
    findings: ArtifactResolution['findings'];
    source?: {
        identity: ArtifactSelector;
        projectRoot: string;
        rootKind: ArtifactSelector['rootKind'];
        sourcePath: string;
        role: 'editable-source';
        language: 'sql' | 'ssjs' | 'html' | 'ampscript';
        text: string;
        hash: string;
        hashAlgorithm: 'sha256';
        hashBasis: 'original-file-bytes';
        rendering: 'not-performed';
        validation: {
            status: 'not-performed';
            requiredCapability:
                | 'sql-validator-not-established'
                | 'validate_ssjs'
                | 'validate_sfmc_html'
                | 'validate_ampscript';
        };
        executionReadiness: 'unknown';
        limitations: string[];
    };
}

/**
 * Hand off exactly one editable companion selected by qualified metadata identity.
 * Callers must prevent concurrent mutation; no path argument or execution is supported.
 * @param project - Unmodified configuration from readProjectConfig.
 * @param selector - Explicit qualified identity, never a caller-supplied file path.
 * @param limits - Optional lower inventory traversal bounds.
 * @returns {ProjectArtifactSource} Complete UTF-8 source and byte hash, or no source on failure.
 */
export function readProjectArtifactSource(
    project: ProjectConfig,
    selector: ArtifactSelector,
    limits: Partial<ArtifactLimits> = {}
): ProjectArtifactSource {
    const resolution = resolveProjectArtifact(project, selector, limits);
    const result: ProjectArtifactSource = {
        status: resolution.status,
        findings: [...resolution.findings],
    };
    if (resolution.status !== 'resolved') return result;
    if (resolution.metadataPaths.length !== 1 || resolution.editableCompanions.length !== 1) {
        result.status = 'blocked';
        result.findings.push({ code: 'unverified-source-identity' });
        return result;
    }
    const companion = resolution.editableCompanions[0];
    try {
        const bytes = readSelectedBytes(project.projectRoot, companion.absolutePath);
        // Preserve a UTF-8 BOM in text; hash the original bytes, not re-encoded text.
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        result.source = {
            identity: {
                rootKind: selector.rootKind,
                credential: selector.credential,
                businessUnit: selector.businessUnit,
                metadataType: selector.metadataType,
                externalKey: selector.externalKey,
            },
            projectRoot: project.projectRoot,
            rootKind: selector.rootKind,
            sourcePath: companion.absolutePath,
            role: 'editable-source',
            language: companion.language,
            text,
            hash: createHash('sha256').update(bytes).digest('hex'),
            hashAlgorithm: 'sha256',
            hashBasis: 'original-file-bytes',
            rendering: 'not-performed',
            validation: {
                status: 'not-performed',
                requiredCapability:
                    companion.language === 'sql'
                        ? 'sql-validator-not-established'
                        : companion.language === 'ssjs'
                          ? 'validate_ssjs'
                          : companion.language === 'ampscript'
                            ? 'validate_ampscript'
                            : 'validate_sfmc_html',
            },
            executionReadiness: 'unknown',
            limitations: [
                'Editable-source role is not evidence of historical generation or provenance.',
                'No rendering, validation, filesystem mutation or live execution was performed.',
                'The host must discover companion capabilities and coordinate platform detection, lookups and full-document validation; SQL validation is not established.',
                'Bounded checks reject detectable drift but are not atomic or a concurrent-mutation sandbox; callers must prevent concurrent filesystem mutation.',
            ],
        };
    } catch {
        result.status = 'blocked';
        result.findings.push({ code: 'unverified-source-content-or-path' });
    }
    return result;
}

/**
 * Associate only proven top-level HTML email extracts, not arbitrary files in an asset folder.
 * Installed Asset.definition.js:3-10,741; Asset.js:1561-1667,2336-2379,2733-2808.
 * Native commit candidates include nonexistent extension alternatives; those are not sources.
 * @param root - Canonical project root.
 * @param metadataPath - Verified metadata path.
 * @param metadata - Parsed metadata matched by customerKey.
 * @param files - Inventoried files in the qualified email subtype.
 * @param result - Resolution receiving verified associations or explicit findings.
 */
function associateEmail(
    root: string,
    metadataPath: string,
    metadata: Record<string, unknown>,
    files: { absolutePath: string }[],
    result: ArtifactResolution
): void {
    const assetType = metadata.assetType as { name?: unknown } | undefined;
    const views = metadata.views as
        Record<string, { slots?: unknown; content?: unknown }> | undefined;
    if (
        !['htmlemail', 'templatebasedemail'].includes(String(assetType?.name)) ||
        !views ||
        typeof views !== 'object' ||
        !views.html ||
        typeof views.html !== 'object' ||
        views.html.slots !== undefined
    ) {
        result.findings.push({ code: 'unsupported-email-layout' });
        return;
    }
    const key = metadata.customerKey as string;
    const directory = path.dirname(metadataPath);
    const sourceDirectory =
        path.basename(path.dirname(directory)) === 'asset' ? path.join(directory, key) : directory;
    const expected = [
        ['html', 'html'],
        ['preheader', 'amp'],
        ['text', 'amp'],
    ] as const;
    for (const [view, extension] of expected) {
        const candidate = path.join(
            sourceDirectory,
            `views.${view}.content.asset-email-meta.${extension}`
        );
        const found = files.some((file) => file.absolutePath === candidate);
        if (found && (!views[view] || typeof views[view] !== 'object')) {
            result.findings.push({ code: 'unsupported-email-layout' });
            continue;
        }
        // Inline content is not proof that a companion is the native editable source.
        if (views[view]?.content !== undefined || (view === 'html' && !found)) {
            result.findings.push({ code: found ? 'inline-source-conflict' : 'missing-companion' });
            continue;
        }
        if (!found) continue;
        checkedFile(root, candidate);
        result.editableCompanions.push({
            absolutePath: candidate,
            language: extension === 'html' ? 'html' : 'ampscript',
            role: 'source',
        });
    }
    // Anything else under this asset may be an unimplemented extract: never silently select HTML.
    if (
        files.some(
            (file) =>
                file.absolutePath.startsWith(`${sourceDirectory}${path.sep}`) &&
                file.absolutePath !== metadataPath &&
                !result.editableCompanions.some(
                    (source) => source.absolutePath === file.absolutePath
                )
        )
    )
        result.findings.push({ code: 'unsupported-email-layout' });
}

/**
 * Resolve one qualified identity without reading extracts or executing mcdev/hooks.
 * Unsupported types and unsafe/incomplete inventories never authorize content reads.
 * @param project - Unmodified configuration from readProjectConfig.
 * @param selector - Explicit root, credential, BU, type and external key.
 * @param limits - Optional lower inventory traversal bounds.
 * @returns {ArtifactResolution} Proven paths, unresolved declarations and explicit blockers.
 */
export function resolveProjectArtifact(
    project: ProjectConfig,
    selector: ArtifactSelector,
    limits: Partial<ArtifactLimits> = {}
): ArtifactResolution {
    const result: ArtifactResolution = {
        status: 'unsupported',
        metadataPaths: [],
        editableCompanions: [],
        declaredDependencies: [],
        locallyConfirmedDependencies: [],
        dependencyResolution: 'not-evaluated',
        findings: [],
    };
    if (!Object.hasOwn(supported, selector.metadataType)) {
        result.findings.push({ code: 'unsupported-type' });
        return result;
    }
    if (
        !['retrieve', 'deploy'].includes(selector.rootKind) ||
        ![selector.credential, selector.businessUnit, selector.externalKey].every(literal)
    ) {
        result.findings.push({ code: 'unsupported-selector' });
        return result;
    }
    const semantics = supported[selector.metadataType as keyof typeof supported];
    result.declaredDependencies = [...semantics.dependencies];
    const inventory = inventoryProjectArtifacts(project, limits);
    if (!inventory.complete) {
        result.status = 'blocked';
        result.findings.push(...inventory.findings);
        return result;
    }
    const scoped = inventory.artifacts.filter(
        (item) =>
            item.rootKind === selector.rootKind &&
            item.credential === selector.credential &&
            item.businessUnit === selector.businessUnit &&
            (selector.metadataType === 'asset-email'
                ? item.metadataType === 'asset' && item.assetSubtype === 'email'
                : item.metadataType === selector.metadataType)
    );
    for (const item of scoped) {
        if (
            item.metadataFilename?.type !== selector.metadataType ||
            item.metadataFilename.extension !== 'json'
        )
            continue;
        try {
            const metadata = readMetadata(project.projectRoot, item.absolutePath);
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
                throw new Error('invalid-metadata');
            const email = selector.metadataType === 'asset-email';
            const record = metadata as Record<string, unknown>;
            const key = record[email ? 'customerKey' : 'key'];
            if (typeof key !== 'string' || !key) throw new Error('invalid-metadata');
            if (key !== selector.externalKey) continue;
            result.metadataPaths.push(item.absolutePath);
            const directories = project.config.directories as Record<string, unknown> | undefined;
            const typeDirectory = path.resolve(
                project.projectRoot,
                (directories?.[selector.rootKind] as string | undefined) ?? selector.rootKind,
                selector.credential,
                selector.businessUnit,
                ...(email ? ['asset', 'email'] : [selector.metadataType])
            );
            if (
                path.dirname(item.absolutePath) !== typeDirectory &&
                !(email && path.dirname(item.absolutePath) === path.join(typeDirectory, key))
            ) {
                result.findings.push({
                    code: 'unsupported-nested-layout',
                    path: item.relativePath,
                });
                continue;
            }
            if (item.metadataFilename.stem !== key) {
                result.findings.push({ code: 'filename-key-mismatch', path: item.relativePath });
                continue;
            }
            if (email) {
                associateEmail(project.projectRoot, item.absolutePath, record, scoped, result);
                continue;
            }
            const companions = scoped.filter(
                (candidate) =>
                    path.dirname(candidate.absolutePath) === path.dirname(item.absolutePath) &&
                    semantics.extensions.some(
                        (extension) =>
                            candidate.filename ===
                            `${key}.${selector.metadataType}-meta.${extension}`
                    )
            );
            if (companions.length !== 1) {
                result.findings.push({
                    code: companions.length ? 'multiple-companions' : 'missing-companion',
                    path: item.relativePath,
                });
                continue;
            }
            const companion = companions[0];
            checkedFile(project.projectRoot, companion.absolutePath);
            result.editableCompanions.push({
                absolutePath: companion.absolutePath,
                language: companion.extension.slice(1) as 'sql' | 'ssjs' | 'html',
                role: 'source',
            });
        } catch {
            result.findings.push({ code: 'unverified-metadata-or-path', path: item.relativePath });
        }
    }
    result.status = result.findings.some(
        (finding) => finding.code === 'unverified-metadata-or-path'
    )
        ? 'blocked'
        : result.metadataPaths.length > 1 || result.findings.length
          ? 'ambiguous'
          : result.metadataPaths.length
            ? 'resolved'
            : 'missing';
    // Never offer an edit target when any identity, file or companion is unresolved.
    if (result.status !== 'resolved') result.editableCompanions = [];
    return result;
}
