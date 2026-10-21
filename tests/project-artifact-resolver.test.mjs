import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readProjectConfig } from '../dist/project-inspection.js';
import {
    readProjectArtifactSource,
    resolveProjectArtifact,
} from '../dist/project-artifact-resolver.js';

for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
    if (value) {
        assert.ok(path.isAbsolute(value));
        assert.equal(
            path
                .normalize(value)
                .replace(/[\\/]+$/u, '')
                .toLowerCase(),
            String.raw`f:\temp`
        );
    }
}
assert.ok(process.env.TEMP);
const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-resolver-')));
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain owned fixtures, never recursively delete.
const selector = {
    rootKind: 'retrieve',
    credential: 'sample',
    businessUnit: 'example',
    metadataType: 'query',
    externalKey: 'demo',
};
function fixture() {
    const root = fs.mkdtempSync(path.join(runRoot, 'project-'));
    fs.writeFileSync(
        path.join(root, '.mcdevrc.json'),
        JSON.stringify({
            directories: { retrieve: 'custom/in', deploy: 'custom/out' },
            credentials: {
                sample: { businessUnits: { example: 123 } },
                second: { businessUnits: { example: 456 } },
            },
        })
    );
    return readProjectConfig(root);
}
function file(project, relative, content = 'synthetic source') {
    const target = path.join(project.projectRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
}
function metadata(project, type = 'query', stem = 'demo', key = 'demo', extra = '') {
    return file(
        project,
        `custom/in/sample/example/${type}/${extra}${stem}.${type}-meta.json`,
        JSON.stringify({ key })
    );
}
function companion(project, type = 'query', extension = 'sql', extra = '') {
    return file(project, `custom/in/sample/example/${type}/${extra}demo.${type}-meta.${extension}`);
}

const emailSelector = { ...selector, metadataType: 'asset-email' };
function email(project, options = {}) {
    const {
        credential = 'sample',
        stem = 'demo',
        key = 'demo',
        nested = true,
        assetType = 'htmlemail',
        views = { html: {}, preheader: {}, text: {} },
    } = options;
    const base = `custom/in/${credential}/example/asset/email`;
    const directory = nested ? `${base}/${key}` : base;
    const metadataPath = file(
        project,
        `${directory}/${stem}.asset-email-meta.json`,
        JSON.stringify({
            customerKey: key,
            key: 'not-the-customer-key',
            assetType: { name: assetType },
            views,
        })
    );
    return {
        metadataPath,
        source: (view = 'html', extension = view === 'html' ? 'html' : 'amp') =>
            file(project, `${base}/${key}/views.${view}.content.asset-email-meta.${extension}`),
    };
}

test('email customerKey resolves native top-level extracts in both metadata layouts', () => {
    for (const nested of [true, false]) {
        for (const assetType of ['htmlemail', 'templatebasedemail']) {
            const project = fixture();
            const asset = email(project, { nested, assetType });
            const source = asset.source();
            email(project, { credential: 'second' }).source();
            const result = resolveProjectArtifact(project, emailSelector);
            assert.equal(result.status, 'resolved');
            assert.deepEqual(result.metadataPaths, [asset.metadataPath]);
            assert.deepEqual(result.editableCompanions, [
                { absolutePath: source, language: 'html', role: 'source' },
            ]);
            assert.deepEqual(result.declaredDependencies, [
                'folder-asset',
                'folder-asset-shared',
                'folder-cloudpages',
            ]);
            assert.deepEqual(result.locallyConfirmedDependencies, []);
            assert.equal(result.dependencyResolution, 'not-evaluated');
            assert.equal(
                readProjectArtifactSource(project, emailSelector).source.sourcePath,
                source
            );
            assert.equal(
                resolveProjectArtifact(project, {
                    ...emailSelector,
                    externalKey: 'not-the-customer-key',
                }).status,
                'missing'
            );
            assert.equal(
                resolveProjectArtifact(project, { ...emailSelector, credential: 'second' }).status,
                'resolved'
            );
        }
    }
});

test('email multiple verified extracts stay explicit and never choose one source', () => {
    const project = fixture();
    const asset = email(project);
    asset.source();
    asset.source('preheader');
    asset.source('text');
    const result = resolveProjectArtifact(project, emailSelector);
    assert.equal(result.status, 'resolved');
    assert.deepEqual(
        result.editableCompanions.map((source) => source.language),
        ['html', 'ampscript', 'ampscript']
    );
    const handoff = readProjectArtifactSource(project, emailSelector);
    assert.equal(handoff.status, 'blocked');
    assert.equal(handoff.source, undefined);
    assert.ok(handoff.findings.some((finding) => finding.code === 'unverified-source-identity'));
});

test('email missing, mismatched, duplicate and unsupported layouts do not authorize edits', () => {
    for (const kind of [
        'missing',
        'filename',
        'duplicate',
        'slots',
        'textonly',
        'inline',
        'extra',
    ]) {
        const project = fixture();
        const asset = email(project, {
            ...(kind === 'filename' ? { stem: 'different' } : {}),
            ...(kind === 'slots' ? { views: { html: { slots: {} } } } : {}),
            ...(kind === 'inline' ? { views: { html: { content: 'inert inline marker' } } } : {}),
            ...(kind === 'textonly' ? { assetType: 'textonlyemail' } : {}),
        });
        if (kind !== 'missing') asset.source();
        if (kind === 'duplicate') email(project, { nested: false });
        if (kind === 'extra') asset.source('html', 'ssjs');
        const result = resolveProjectArtifact(project, emailSelector);
        assert.equal(result.status, 'ambiguous', kind);
        assert.deepEqual(result.editableCompanions, [], kind);
        assert.equal(readProjectArtifactSource(project, emailSelector).source, undefined, kind);
    }
});

test('email unsafe extracts fail inventory before opening any content', () => {
    for (const kind of ['hardlink', 'junction', 'private']) {
        const project = fixture();
        const asset = email(project);
        const source = asset.source();
        if (kind === 'hardlink') fs.linkSync(source, `${source}.alias`);
        if (kind === 'junction') {
            const outside = fs.mkdtempSync(path.join(runRoot, 'outside-'));
            fs.symlinkSync(outside, path.join(path.dirname(source), 'alias'), 'junction');
        }
        if (kind === 'private')
            file(project, 'custom/in/sample/example/asset/email/demo/logs/marker');
        const original = fs.openSync;
        let opens = 0;
        fs.openSync = () => {
            opens++;
            throw new Error('Denied before access');
        };
        try {
            assert.equal(readProjectArtifactSource(project, emailSelector).status, 'blocked');
            assert.equal(opens, 0);
        } finally {
            fs.openSync = original;
        }
    }
});

test('source handoff preserves full Unicode/BOM bytes, identity and honest capability state', () => {
    for (const [type, language, capability] of [
        ['query', 'sql', 'sql-validator-not-established'],
        ['script', 'ssjs', 'validate_ssjs'],
        ['script', 'html', 'validate_sfmc_html'],
    ]) {
        const project = fixture();
        metadata(project, type);
        const sourcePath = companion(project, type, language);
        const text = '\uFEFFsynthetic café 🌍\r\n終\n';
        const bytes = Buffer.from(text);
        fs.writeFileSync(sourcePath, bytes);
        const identity = { ...selector, metadataType: type };
        const result = readProjectArtifactSource(project, identity);
        assert.equal(result.status, 'resolved');
        assert.deepEqual(result.source.identity, identity);
        assert.equal(result.source.projectRoot, project.projectRoot);
        assert.equal(result.source.rootKind, 'retrieve');
        assert.equal(result.source.sourcePath, sourcePath);
        assert.equal(result.source.language, language);
        assert.equal(result.source.role, 'editable-source');
        assert.equal(result.source.text, text);
        assert.equal(result.source.hash, createHash('sha256').update(bytes).digest('hex'));
        assert.equal(result.source.hashAlgorithm, 'sha256');
        assert.equal(result.source.hashBasis, 'original-file-bytes');
        assert.equal(result.source.rendering, 'not-performed');
        assert.deepEqual(result.source.validation, {
            status: 'not-performed',
            requiredCapability: capability,
        });
        assert.equal(result.source.executionReadiness, 'unknown');
        assert.equal(Object.hasOwn(result.source, 'generated'), false);
        assert.ok(result.source.limitations.some((item) => item.includes('not atomic')));
    }
});

test('source handoff rejects oversized and malformed UTF-8 without returning partial content', () => {
    for (const bytes of [
        Buffer.alloc(1024 * 1024 + 1),
        Buffer.from([195, 40]),
        Buffer.from([226, 130]),
    ]) {
        const project = fixture();
        metadata(project);
        fs.writeFileSync(companion(project), bytes);
        const result = readProjectArtifactSource(project, selector);
        assert.equal(result.status, 'blocked');
        assert.equal(result.source, undefined);
    }
    const project = fixture();
    metadata(project);
    fs.writeFileSync(companion(project), Buffer.alloc(1024 * 1024, 0x61));
    assert.equal(readProjectArtifactSource(project, selector).source.text.length, 1024 * 1024);
});

test('source handoff returns no content for missing, unsupported or ambiguous resolution', () => {
    const project = fixture();
    assert.equal(readProjectArtifactSource(project, selector).status, 'missing');
    metadata(project, 'script');
    const request = { ...selector, metadataType: 'script' };
    assert.equal(readProjectArtifactSource(project, request).source, undefined);
    companion(project, 'script', 'ssjs');
    companion(project, 'script', 'html');
    const result = readProjectArtifactSource(project, request);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.source, undefined);
    assert.equal(
        readProjectArtifactSource(project, { ...selector, metadataType: 'asset' }).status,
        'unsupported'
    );
});

test('source read detects growth, descriptor drift and path drift', () => {
    for (const kind of ['growth', 'descriptor', 'path']) {
        const project = fixture();
        metadata(project);
        const source = companion(project);
        const originalOpen = fs.openSync;
        const originalRead = fs.readSync;
        const originalStat = fs.lstatSync;
        let sourceDescriptor;
        let sourceReads = 0;
        fs.openSync = (candidate, ...args) => {
            const descriptor = originalOpen(candidate, ...args);
            if (candidate === source) sourceDescriptor = descriptor;
            return descriptor;
        };
        fs.readSync = (descriptor, ...args) => {
            if (descriptor === sourceDescriptor && ++sourceReads === 1) {
                if (kind === 'growth') fs.appendFileSync(source, Buffer.alloc(1024 * 1024, 0x61));
                if (kind === 'descriptor') fs.appendFileSync(source, 'drift');
            }
            return originalRead(descriptor, ...args);
        };
        fs.lstatSync = (candidate, ...args) => {
            const stat = originalStat(candidate, ...args);
            if (kind === 'path' && candidate === source && sourceReads)
                stat.isSymbolicLink = () => true;
            return stat;
        };
        try {
            const result = readProjectArtifactSource(project, selector);
            assert.equal(result.status, 'blocked');
            assert.equal(result.source, undefined);
            assert.ok(sourceReads > 0);
        } finally {
            fs.openSync = originalOpen;
            fs.readSync = originalRead;
            fs.lstatSync = originalStat;
        }
    }
});

test('unsafe companion aliases and private names deny all content opens', () => {
    for (const kind of ['hardlink-auth', 'junction', 'private']) {
        const project = fixture();
        metadata(project);
        const source = companion(project);
        if (kind === 'hardlink-auth') {
            const auth = file(project, '.mcdev-auth.json', 'synthetic denial marker');
            fs.unlinkSync(source);
            fs.linkSync(auth, source);
        } else if (kind === 'junction') {
            const outside = fs.mkdtempSync(path.join(runRoot, 'outside-'));
            fs.symlinkSync(outside, path.join(path.dirname(source), 'alias'), 'junction');
        } else {
            file(project, 'custom/in/sample/example/query/logs/marker', 'synthetic denial marker');
        }
        const originalOpen = fs.openSync;
        let opens = 0;
        fs.openSync = () => {
            opens++;
            throw new Error('Denied before access');
        };
        try {
            const result = readProjectArtifactSource(project, selector);
            assert.equal(result.status, 'blocked');
            assert.equal(result.source, undefined);
            assert.equal(opens, 0);
        } finally {
            fs.openSync = originalOpen;
        }
    }
});

test('qualified key/root isolates duplicate BU/key identities and honors custom roots', () => {
    const project = fixture();
    const expected = metadata(project);
    const source = companion(project);
    file(project, 'custom/in/second/example/query/demo.query-meta.json', '{"key":"demo"}');
    file(project, 'custom/out/sample/example/query/demo.query-meta.json', '{"key":"demo"}');
    const result = resolveProjectArtifact(project, selector);
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.metadataPaths, [expected]);
    assert.deepEqual(result.editableCompanions, [
        { absolutePath: source, language: 'sql', role: 'source' },
    ]);
    assert.deepEqual(result.declaredDependencies, ['folder-queryactivity', 'dataExtension']);
    assert.deepEqual(result.locallyConfirmedDependencies, []);
    assert.equal(result.dependencyResolution, 'not-evaluated');
    assert.equal(
        resolveProjectArtifact(project, { ...selector, credential: 'second' }).metadataPaths.length,
        1
    );
    assert.equal(
        resolveProjectArtifact(project, { ...selector, rootKind: 'deploy' }).metadataPaths.length,
        1
    );
});

test('actual key wins over filename; mismatch never authorizes edits', () => {
    const project = fixture();
    metadata(project, 'query', 'demo', 'different');
    companion(project);
    assert.equal(resolveProjectArtifact(project, selector).status, 'missing');
    const result = resolveProjectArtifact(project, { ...selector, externalKey: 'different' });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.findings[0].code, 'filename-key-mismatch');
    assert.deepEqual(result.editableCompanions, []);
});

test('duplicate metadata identities are ambiguous', () => {
    const project = fixture();
    metadata(project);
    companion(project);
    metadata(project, 'query', 'demo', 'demo', 'nested/');
    companion(project, 'query', 'sql', 'nested/');
    const result = resolveProjectArtifact(project, selector);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.metadataPaths.length, 2);
    assert.deepEqual(result.editableCompanions, []);
});

test('script alternatives report missing and multiple companions', () => {
    const project = fixture();
    metadata(project, 'script');
    const request = { ...selector, metadataType: 'script' };
    assert.equal(resolveProjectArtifact(project, request).findings[0].code, 'missing-companion');
    const expected = companion(project, 'script', 'html');
    assert.equal(
        resolveProjectArtifact(project, request).editableCompanions[0].absolutePath,
        expected
    );
    companion(project, 'script', 'ssjs');
    const result = resolveProjectArtifact(project, request);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.findings[0].code, 'multiple-companions');
    assert.deepEqual(result.editableCompanions, []);
});

test('invalid and oversized metadata block safely', () => {
    for (const content of [
        'broken',
        '[]',
        'null',
        '{}',
        '{"key":123}',
        ' '.repeat(1024 * 1024 + 1),
    ]) {
        const project = fixture();
        file(project, 'custom/in/sample/example/query/demo.query-meta.json', content);
        assert.equal(resolveProjectArtifact(project, selector).status, 'blocked');
    }
});

test('unsupported types and selectors never open project content', () => {
    const project = fixture();
    const original = fs.openSync;
    let opens = 0;
    fs.openSync = () => {
        opens++;
        throw new Error('No opens');
    };
    try {
        for (const metadataType of ['asset', 'automation', 'dataExtension', 'unknown'])
            assert.equal(
                resolveProjectArtifact(project, { ...selector, metadataType }).status,
                'unsupported'
            );
        assert.equal(
            resolveProjectArtifact(project, { ...selector, externalKey: '../escape' }).status,
            'unsupported'
        );
        assert.equal(opens, 0);
    } finally {
        fs.openSync = original;
    }
});

test('junctions, hardlinks, private paths and incomplete inventories block before opens', () => {
    for (const kind of ['junction', 'hardlink', 'private', 'limit']) {
        const project = fixture();
        const target = metadata(project);
        switch (kind) {
            case 'junction': {
                const outside = fs.mkdtempSync(path.join(runRoot, 'outside-'));
                fs.symlinkSync(outside, path.join(path.dirname(target), 'nested'), 'junction');

                break;
            }
            case 'hardlink': {
                fs.linkSync(target, path.join(path.dirname(target), 'alias.query-meta.json'));
                break;
            }
            case 'private': {
                file(project, 'custom/in/sample/example/query/.mcdev-auth.json');
                // No default
                break;
            }
        }
        const original = fs.openSync;
        let opens = 0;
        fs.openSync = () => {
            opens++;
            throw new Error('No opens');
        };
        try {
            assert.equal(
                resolveProjectArtifact(project, selector, kind === 'limit' ? { maxEntries: 1 } : {})
                    .status,
                'blocked'
            );
            assert.equal(opens, 0);
        } finally {
            fs.openSync = original;
        }
    }
});

test('revalidates after inventory and never opens extracts', () => {
    const project = fixture();
    const target = metadata(project);
    companion(project);
    const originalStat = fs.lstatSync;
    const originalOpen = fs.openSync;
    let checks = 0;
    let opens = 0;
    fs.lstatSync = (candidate, ...args) => {
        const stat = originalStat(candidate, ...args);
        if (candidate === target && ++checks > 1) stat.isSymbolicLink = () => true;
        return stat;
    };
    fs.openSync = (...args) => {
        opens++;
        return originalOpen(...args);
    };
    try {
        assert.equal(resolveProjectArtifact(project, selector).status, 'blocked');
        assert.equal(opens, 0);
        assert.equal(checks, 2);
    } finally {
        fs.lstatSync = originalStat;
        fs.openSync = originalOpen;
    }
    fs.openSync = (candidate, ...args) => {
        assert.equal(candidate, target);
        return originalOpen(candidate, ...args);
    };
    try {
        assert.equal(resolveProjectArtifact(project, selector).status, 'resolved');
    } finally {
        fs.openSync = originalOpen;
    }
});
