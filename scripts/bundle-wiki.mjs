/** Frozen wiki builds and explicit, non-recursive refresh with provenance. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assertNoLinks(target) {
    const absolute = path.resolve(target);
    if (!path.isAbsolute(target)) throw new Error('bundle-wiki: absolute paths required');
    if (target.split(/[\\/]/).includes('..'))
        throw new Error('bundle-wiki: path escapes forbidden');
    for (let current = absolute; ; current = path.dirname(current)) {
        if (
            (fs.existsSync(current) || fs.lstatSync(current, { throwIfNoEntry: false })) &&
            fs.lstatSync(current).isSymbolicLink()
        ) {
            throw new Error(`bundle-wiki: links forbidden: ${current}`);
        }
        if (current === path.dirname(current)) break;
    }
}

function inventory(directory) {
    assertNoLinks(directory);
    const pages = {};
    for (const name of fs.readdirSync(directory).toSorted()) {
        if (!name.endsWith('.md')) continue;
        if (name.includes('\\') || name.includes('/') || name.includes(':')) {
            throw new Error('bundle-wiki: invalid page name');
        }
        const target = path.join(directory, name);
        assertNoLinks(target);
        if (!fs.lstatSync(target).isFile()) throw new Error('bundle-wiki: page is not a file');
        Object.defineProperty(pages, name, {
            value: hash(fs.readFileSync(target)),
            enumerable: true,
        });
    }
    if (Object.keys(pages).length === 0) throw new Error('bundle-wiki: no Markdown files');
    return pages;
}

/**
 * Read revision and dirty state without assuming that local edits were reviewed.
 * @param {string} directory Source checkout.
 * @param {typeof execFileSync} git Git command runner (injectable for synthetic tests).
 * @returns {object} Source provenance, with unknowns explicit.
 */
export function readSourceProvenance(directory, git = execFileSync) {
    try {
        const options = { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
        const root = git('git', ['rev-parse', '--show-toplevel'], options).trim();
        if (path.resolve(root).toLowerCase() !== path.resolve(directory).toLowerCase()) {
            throw new Error('not a checkout root');
        }
        const revision = git('git', ['rev-parse', 'HEAD'], options).trim();
        if (!/^[\da-f]{40,64}$/.test(revision)) throw new Error('invalid revision');
        const dirty =
            git('git', ['status', '--porcelain', '--untracked-files=all'], options).length > 0;
        return { revision, dirty, localReviewStatus: 'not-reviewed' };
    } catch {
        return { revision: null, dirty: null, localReviewStatus: 'unknown' };
    }
}

/**
 * Build a deterministic manifest; refresh is explicit and conflicts fail before writes.
 * @param {object} options Paths, refresh selection and installed mcdev version.
 * @param options.root Package root.
 * @param options.sourceDir Selected wiki checkout root.
 * @param options.refresh Explicit refresh selection.
 * @param options.mcdevVersion Installed mcdev version override for fixtures.
 * @param options.git Git command runner for fixtures.
 * @param options.reconciliation Exact changed-page old/proposed SHA256 pairs; null means absent.
 * @returns {object} Manifest and names of obsolete pages removed by this refresh.
 */
export function bundleWiki({
    root = packageRoot,
    sourceDir,
    refresh = false,
    mcdevVersion,
    git = execFileSync,
    reconciliation,
} = {}) {
    if (reconciliation !== undefined && !refresh) {
        throw new Error('bundle-wiki: reconciliation requires explicit refresh');
    }
    const outDir = path.join(root, 'bundled', 'wiki');
    const manifestPath = path.join(root, 'bundled', 'wiki-provenance.json');
    assertNoLinks(manifestPath);
    const currentPages = inventory(outDir);
    const previous = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        : null;
    const version =
        mcdevVersion ??
        JSON.parse(
            fs.readFileSync(
                path.join(
                    path.dirname(createRequire(path.join(root, 'package.json')).resolve('mcdev')),
                    '..',
                    'package.json'
                ),
                'utf8'
            )
        ).version;
    let source = previous?.source ?? {
        revision: null,
        dirty: null,
        localReviewStatus: 'unknown',
    };
    let pages = currentPages;
    let obsoletePages = [];
    if (refresh) {
        if (!sourceDir) throw new Error('bundle-wiki: refresh requires a source');
        pages = inventory(sourceDir);
        source = readSourceProvenance(sourceDir, git);
        obsoletePages = Object.keys(currentPages).filter((name) => !Object.hasOwn(pages, name));
        // An explicit reconciliation is bound to the complete observed content diff, not a force flag.
        if (reconciliation !== undefined) {
            const changed = [...new Set([...Object.keys(currentPages), ...Object.keys(pages)])]
                .filter((name) => currentPages[name] !== pages[name])
                .toSorted();
            if (
                !reconciliation ||
                typeof reconciliation !== 'object' ||
                Array.isArray(reconciliation) ||
                JSON.stringify(Object.keys(reconciliation).toSorted()) !== JSON.stringify(changed)
            ) {
                throw new Error('bundle-wiki: reconciliation must list the complete exact diff');
            }
            for (const name of changed) {
                const expected = reconciliation[name];
                if (
                    !expected ||
                    Object.keys(expected).toSorted().join(',') !== 'oldSha256,proposedSha256' ||
                    expected.oldSha256 !== (currentPages[name] ?? null) ||
                    expected.proposedSha256 !== (pages[name] ?? null)
                ) {
                    throw new Error(`bundle-wiki: stale reconciliation hashes: ${name}`);
                }
            }
        }
        // Local annotations remain protected unless this exact replacement was reconciled.
        for (const [name, digest] of Object.entries(currentPages)) {
            const baseline = previous?.pages?.[name];
            const knownSource = previous?.source?.revision != null;
            if (
                !Object.hasOwn(reconciliation ?? {}, name) &&
                ((baseline && baseline !== digest) ||
                    ((!baseline || !knownSource) && pages[name] !== digest))
            ) {
                throw new Error(`bundle-wiki: annotation conflict: ${name}; reconcile separately`);
            }
        }
        for (const name of Object.keys(pages)) {
            const destination = path.join(outDir, name);
            assertNoLinks(destination);
        }
        for (const name of Object.keys(pages)) {
            fs.copyFileSync(path.join(sourceDir, name), path.join(outDir, name));
        }
        // Only literal, validated top-level Markdown files are removed, never a directory tree.
        for (const name of obsoletePages) fs.unlinkSync(path.join(outDir, name));
    } else if (previous) {
        // Do not rebaseline annotations during ordinary builds.
        return { manifest: previous, obsoletePages };
    }
    const manifest = { schemaVersion: 1, source, mcdevVersion: version, pages };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, obsoletePages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const refresh = process.argv.includes('--refresh');
    const result = bundleWiki({
        refresh,
        sourceDir: refresh
            ? path.resolve(
                  process.env.SFMC_DEVTOOLS_WIKI ||
                      path.join(packageRoot, '..', 'sfmc-devtools.wiki')
              )
            : undefined,
    });
    process.stderr.write(
        `bundle-wiki: ${refresh ? 'refreshed' : 'retained frozen'} wiki; obsolete pages removed: ${result.obsoletePages.join(', ') || 'none'}\n`
    );
}
