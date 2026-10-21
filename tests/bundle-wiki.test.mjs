import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bundleWiki, readSourceProvenance } from '../scripts/bundle-wiki.mjs';

function fixture() {
    const expected = path.resolve('F:/Temp').toLowerCase();
    for (const [name, value] of Object.entries({
        TEMP: process.env.TEMP,
        node: os.tmpdir(),
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
    })) {
        if (!value && ['TMP', 'TMPDIR'].includes(name)) continue;
        assert.ok(value && path.isAbsolute(value), `${name} must be absolute`);
        assert.equal(
            path
                .resolve(value)
                .replace(/[\\/]+$/, '')
                .toLowerCase(),
            expected
        );
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-wiki-provenance-'));
    fs.writeFileSync(path.join(root, '.run-owner'), randomUUID());
    const sourceDir = path.join(root, 'source');
    const outDir = path.join(root, 'bundled', 'wiki');
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(outDir, { recursive: true });
    for (const directory of [sourceDir, outDir]) {
        fs.writeFileSync(path.join(directory, 'Guide.md'), '# Guide\noriginal\n');
    }
    const git = (_command, args) => {
        if (args.includes('--show-toplevel')) return sourceDir;
        if (args.includes('HEAD')) return 'a'.repeat(40);
        return ' M Guide.md\n';
    };
    // Run-owned fixtures deliberately retained; no recursive cleanup.
    return { root, sourceDir, outDir, mcdevVersion: '10.1.0', git };
}

function manifestBytes(options) {
    return fs.readFileSync(path.join(options.root, 'bundled', 'wiki-provenance.json'), 'utf8');
}

test('historical provenance is unknown, inventory is hashed, ordinary builds are frozen', () => {
    const options = fixture();
    const { manifest } = bundleWiki(options);
    assert.deepEqual(manifest.source, {
        revision: null,
        dirty: null,
        localReviewStatus: 'unknown',
    });
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.mcdevVersion, '10.1.0');
    assert.equal(
        manifest.pages['Guide.md'],
        createHash('sha256').update('# Guide\noriginal\n').digest('hex')
    );
    const before = manifestBytes(options);
    fs.writeFileSync(path.join(options.outDir, 'Guide.md'), '# Guide\nlocal annotation\n');
    fs.writeFileSync(path.join(options.sourceDir, 'Guide.md'), 'upstream change');
    bundleWiki({ ...options, mcdevVersion: '99.0.0' });
    assert.equal(manifestBytes(options), before);
    assert.equal(
        fs.readFileSync(path.join(options.outDir, 'Guide.md'), 'utf8'),
        '# Guide\nlocal annotation\n'
    );
});

test('explicit refresh records revision and dirty state without claiming review', () => {
    const options = fixture();
    const result = bundleWiki({ ...options, refresh: true });
    assert.deepEqual(result.manifest.source, {
        revision: 'a'.repeat(40),
        dirty: true,
        localReviewStatus: 'not-reviewed',
    });
    const before = manifestBytes(options);
    bundleWiki({ ...options, refresh: true });
    assert.equal(manifestBytes(options), before);
    const cleanGit = (command, args, config) =>
        args.includes('status') ? '' : options.git(command, args, config);
    assert.equal(readSourceProvenance(options.sourceDir, cleanGit).dirty, false);
    assert.deepEqual(
        readSourceProvenance(options.sourceDir, () => {
            throw new Error('not git');
        }),
        { revision: null, dirty: null, localReviewStatus: 'unknown' }
    );
    assert.equal(readSourceProvenance(options.sourceDir, () => options.root).revision, null);
});

test('controlled refresh removes only obsolete pages and reports them', () => {
    const options = fixture();
    for (const directory of [options.sourceDir, options.outDir]) {
        fs.writeFileSync(path.join(directory, 'Obsolete.md'), 'old');
    }
    bundleWiki({ ...options, refresh: true });
    fs.unlinkSync(path.join(options.sourceDir, 'Obsolete.md'));
    fs.writeFileSync(path.join(options.outDir, 'notes.txt'), 'preserved');
    fs.writeFileSync(path.join(options.sourceDir, 'Guide.md'), 'new');
    const result = bundleWiki({ ...options, refresh: true });
    assert.deepEqual(result.obsoletePages, ['Obsolete.md']);
    assert.equal(fs.existsSync(path.join(options.outDir, 'Obsolete.md')), false);
    assert.equal(fs.readFileSync(path.join(options.outDir, 'notes.txt'), 'utf8'), 'preserved');
    assert.equal(fs.readFileSync(path.join(options.outDir, 'Guide.md'), 'utf8'), 'new');
});

test('annotations and historical mismatches fail before any refresh writes', () => {
    for (const historical of [true, false]) {
        const options = fixture();
        bundleWiki({ ...options, refresh: !historical });
        const before = manifestBytes(options);
        fs.writeFileSync(path.join(options.outDir, 'Guide.md'), 'local annotation');
        fs.writeFileSync(path.join(options.sourceDir, 'Added.md'), 'new page');
        assert.throws(() => bundleWiki({ ...options, refresh: true }), /annotation conflict/);
        assert.equal(manifestBytes(options), before);
        assert.equal(
            fs.readFileSync(path.join(options.outDir, 'Guide.md'), 'utf8'),
            'local annotation'
        );
        assert.equal(fs.existsSync(path.join(options.outDir, 'Added.md')), false);
    }
});

test('rejects linked source, destination ancestor, page and manifest paths', () => {
    for (const kind of ['source', 'destination', 'page', 'manifest']) {
        const options = fixture();
        const link = path.join(options.root, 'linked');
        fs.symlinkSync(options.sourceDir, link, 'junction');
        if (kind === 'source') options.sourceDir = link;
        if (kind === 'destination') options.root = link;
        if (kind === 'page') {
            fs.symlinkSync(options.sourceDir, path.join(options.outDir, 'Linked.md'), 'junction');
        }
        if (kind === 'manifest') {
            fs.symlinkSync(
                options.sourceDir,
                path.join(options.root, 'bundled', 'wiki-provenance.json'),
                'junction'
            );
        }
        assert.throws(() => bundleWiki({ ...options, refresh: true }), /links forbidden/);
    }
});

test('ordinary CLI ignores source environment and preserves frozen manifest and annotations', () => {
    const options = fixture();
    const scripts = path.join(options.root, 'scripts');
    const dependency = path.join(options.root, 'node_modules', 'mcdev');
    fs.mkdirSync(scripts);
    fs.mkdirSync(path.join(dependency, 'lib'), { recursive: true });
    fs.copyFileSync(
        new URL('../scripts/bundle-wiki.mjs', import.meta.url),
        path.join(scripts, 'bundle-wiki.mjs')
    );
    fs.writeFileSync(
        path.join(dependency, 'package.json'),
        JSON.stringify({ name: 'mcdev', version: '10.1.0', main: 'lib/index.js' })
    );
    fs.writeFileSync(path.join(dependency, 'lib', 'index.js'), '');
    const run = () =>
        spawnSync(process.execPath, [path.join(scripts, 'bundle-wiki.mjs')], {
            encoding: 'utf8',
            env: { ...process.env, SFMC_DEVTOOLS_WIKI: path.join(options.root, 'missing') },
        });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const before = manifestBytes(options);
    fs.writeFileSync(path.join(options.outDir, 'Guide.md'), 'annotation');
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(manifestBytes(options), before);
    assert.equal(fs.readFileSync(path.join(options.outDir, 'Guide.md'), 'utf8'), 'annotation');
});

function approvedDiff(options) {
    const digest = (directory, name) => {
        const file = path.join(directory, name);
        return fs.existsSync(file)
            ? createHash('sha256').update(fs.readFileSync(file)).digest('hex')
            : null;
    };
    const names = [
        ...new Set([...fs.readdirSync(options.outDir), ...fs.readdirSync(options.sourceDir)]),
    ];
    return Object.fromEntries(
        names
            .filter(
                (name) =>
                    name.endsWith('.md') &&
                    digest(options.outDir, name) !== digest(options.sourceDir, name)
            )
            .map((name) => [
                name,
                {
                    oldSha256: digest(options.outDir, name),
                    proposedSha256: digest(options.sourceDir, name),
                },
            ])
    );
}

test('content-bound reconciliation bootstraps changed and removed historical pages honestly', () => {
    const options = fixture();
    fs.writeFileSync(path.join(options.outDir, 'Obsolete.md'), 'historical annotation');
    bundleWiki(options);
    fs.writeFileSync(
        path.join(options.sourceDir, 'Guide.md'),
        'reconciled local unreleased content'
    );
    const reconciliation = approvedDiff(options);
    const { manifest, obsoletePages } = bundleWiki({ ...options, refresh: true, reconciliation });
    assert.deepEqual(obsoletePages, ['Obsolete.md']);
    assert.equal(fs.existsSync(path.join(options.outDir, 'Obsolete.md')), false);
    assert.equal(manifest.source.revision, 'a'.repeat(40));
    assert.equal(manifest.source.dirty, true);
    assert.equal(manifest.source.localReviewStatus, 'not-reviewed');
    assert.equal(manifest.pages['Guide.md'], reconciliation['Guide.md'].proposedSha256);
    const before = manifestBytes(options);
    fs.writeFileSync(path.join(options.outDir, 'Guide.md'), 'later annotation drift');
    assert.throws(() => bundleWiki({ ...options, refresh: true }), /annotation conflict/);
    assert.throws(
        () => bundleWiki({ ...options, refresh: true, reconciliation }),
        /complete exact diff|stale/
    );
    assert.equal(manifestBytes(options), before);
    assert.equal(
        fs.readFileSync(path.join(options.outDir, 'Guide.md'), 'utf8'),
        'later annotation drift'
    );
});

test('reconciliation rejects stale, missing and unexpected differences before writes', () => {
    for (const scenario of ['old', 'proposed', 'missing', 'extra', 'unexpected']) {
        const options = fixture();
        bundleWiki(options);
        fs.writeFileSync(path.join(options.sourceDir, 'Guide.md'), 'proposed');
        const reconciliation = approvedDiff(options);
        const before = manifestBytes(options);
        if (scenario === 'old') reconciliation['Guide.md'].oldSha256 = '0'.repeat(64);
        if (scenario === 'proposed') reconciliation['Guide.md'].proposedSha256 = '0'.repeat(64);
        if (scenario === 'missing') delete reconciliation['Guide.md'];
        if (scenario === 'extra')
            reconciliation['../escape.md'] = { oldSha256: null, proposedSha256: null };
        if (scenario === 'unexpected')
            fs.writeFileSync(path.join(options.sourceDir, 'Added.md'), 'unapproved');
        assert.throws(
            () => bundleWiki({ ...options, refresh: true, reconciliation }),
            /reconciliation/
        );
        assert.equal(manifestBytes(options), before);
        assert.equal(
            fs.readFileSync(path.join(options.outDir, 'Guide.md'), 'utf8'),
            '# Guide\noriginal\n'
        );
        assert.equal(fs.existsSync(path.join(options.outDir, 'Added.md')), false);
        assert.throws(() => bundleWiki({ ...options, reconciliation }), /explicit refresh/);
    }
});

test('rejects relative source paths and empty source inventories', () => {
    const options = fixture();
    assert.throws(
        () => bundleWiki({ ...options, refresh: true, sourceDir: '../escape' }),
        /absolute/
    );
    fs.unlinkSync(path.join(options.sourceDir, 'Guide.md'));
    assert.throws(() => bundleWiki({ ...options, refresh: true }), /no Markdown/);
});
