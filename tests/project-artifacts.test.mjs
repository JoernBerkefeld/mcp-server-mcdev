import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readProjectConfig } from '../dist/project-inspection.js';
import { inventoryProjectArtifacts } from '../dist/project-artifacts.js';

validateTempEnvironment();
const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-artifacts-')));
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// All synthetic fixtures are retained; no recursive cleanup.
function fixture(overrides = {}) {
    const root = fs.mkdtempSync(path.join(runRoot, 'project-'));
    fs.writeFileSync(
        path.join(root, '.mcdevrc.json'),
        JSON.stringify({
            credentials: { sample: { businessUnits: { example: '123' } } },
            ...overrides,
        })
    );
    return readProjectConfig(root);
}
function file(project, relative) {
    const target = path.join(project.projectRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'synthetic');
    return target;
}
const denied = () => {
    throw new Error('No file content access allowed');
};
function inventory(project, limits) {
    const originals = [fs.openSync, fs.readSync, fs.readFileSync];
    fs.openSync = fs.readSync = fs.readFileSync = denied;
    try {
        return inventoryProjectArtifacts(project, limits);
    } finally {
        [fs.openSync, fs.readSync, fs.readFileSync] = originals;
    }
}
const codes = (result) => result.findings.map((finding) => finding.code);

test('defaults match installed mcdev config source and inventory stays metadata-only', () => {
    const defaults = JSON.parse(
        fs.readFileSync(
            new URL('../node_modules/mcdev/boilerplate/config.json', import.meta.url),
            'utf8'
        )
    );
    assert.equal(defaults.directories.retrieve, 'retrieve/');
    assert.equal(defaults.directories.deploy, 'deploy/');
    const project = fixture();
    file(project, 'retrieve/sample/example/query/demo.query-meta.json');
    const result = inventory(project);
    assert.equal(result.complete, true);
    assert.equal(result.artifacts.length, 1);
    assert.deepEqual(result.artifacts[0].metadataFilename, {
        stem: 'demo',
        type: 'query',
        extension: 'json',
    });
    assert.equal(result.artifacts[0].credential, 'sample');
    assert.equal(result.artifacts[0].businessUnit, 'example');
});

test('custom roots preserve asset subtypes, nested companions and duplicate BU names across credentials', () => {
    const project = fixture({
        directories: { retrieve: 'custom/in', deploy: 'custom/out' },
        credentials: {
            sample: { businessUnits: { example: '123' } },
            second: { businessUnits: { example: '456' } },
        },
    });
    file(project, 'custom/in/sample/example/asset/email/demo.asset-email-meta.json');
    file(project, 'custom/in/sample/example/asset/email/demo/blocks/block.html');
    file(project, 'custom/out/second/example/query/demo.query-meta.sql');
    file(project, 'retrieve/sample/example/query/not-selected.query-meta.json');
    const result = inventory(project);
    assert.equal(result.complete, true);
    assert.equal(result.artifacts.length, 3);
    const asset = result.artifacts.find((item) => item.filename.endsWith('.json'));
    assert.equal(asset.assetSubtype, 'email');
    assert.equal(asset.metadataFilename.type, 'asset-email');
    assert.equal(
        result.artifacts.find((item) => item.filename === 'block.html').metadataFilename,
        undefined
    );
    assert.equal(result.artifacts.find((item) => item.extension === '.sql').rootKind, 'deploy');
});

test('duplicate MID aliases are explicitly ambiguous, not silently merged', () => {
    const project = fixture({
        credentials: { sample: { businessUnits: { first: '123', second: 123 } } },
    });
    assert.ok(codes(inventory(project)).includes('ambiguous'));
});

test('invalid config and escaping, private, aliased or overlapping roots fail closed', () => {
    for (const retrieve of [
        '',
        '.',
        '../outside',
        '.git',
        'logs/sub',
        '.mcdev-auth.json',
        'in/../retrieve',
        'folder.',
        'F:/elsewhere',
        'retrieve//nested',
        'folder:stream',
    ]) {
        const result = inventory(fixture({ directories: { retrieve } }));
        assert.equal(result.complete, false, retrieve);
        assert.equal(result.artifacts.length, 0);
    }
    for (const overrides of [
        { directories: [] },
        { directories: { retrieve: null } },
        {
            credentials: {
                sample: { businessUnits: { a: 1 } },
                SAMPLE: { businessUnits: { b: 2 } },
            },
        },
        { credentials: [] },
        { credentials: { sample: {} } },
        { credentials: { sample: { businessUnits: { '..': '123' } } } },
        { credentials: { sample: { businessUnits: { example: {} } } } },
        { directories: { retrieve: 'same', deploy: 'same/sub' } },
    ])
        assert.equal(inventory(fixture(overrides)).complete, false);
});

test('directory junctions, hardlinked files and noncanonical project spelling are rejected', () => {
    const project = fixture();
    const outside = fs.mkdtempSync(path.join(runRoot, 'outside-'));
    fs.mkdirSync(path.join(project.projectRoot, 'retrieve'));
    fs.symlinkSync(outside, path.join(project.projectRoot, 'retrieve/sample'), 'junction');
    assert.ok(codes(inventory(project)).includes('unsafe-path'));
    const second = fixture();
    const source = file(second, 'retrieve/sample/example/query/first.query-meta.json');
    fs.linkSync(source, path.join(path.dirname(source), 'second.query-meta.json'));
    const result = inventory(second);
    assert.equal(result.artifacts.length, 0);
    assert.equal(codes(result).filter((code) => code === 'unsafe-path').length, 2);
    assert.equal(
        inventory({ ...second, projectRoot: `${second.projectRoot}${path.sep}` }).complete,
        false
    );
});

test('private names and unrelated credentials are never traversed', () => {
    const project = fixture();
    file(project, 'retrieve/sample/example/query/.mcdev-auth.json');
    file(project, 'retrieve/sample/example/logs/private.json');
    file(project, 'retrieve/sample/example/.git/private.json');
    file(project, 'retrieve/unconfigured/example/query/ignored.json');
    const original = fs.opendirSync;
    fs.opendirSync = (candidate, ...args) => {
        assert.ok(!/[\\/](?:logs|\.git|unconfigured)(?:[\\/]|$)/u.test(candidate));
        return original(candidate, ...args);
    };
    try {
        const result = inventory(project);
        assert.equal(result.artifacts.length, 0);
        assert.equal(result.findings.length, 3);
    } finally {
        fs.opendirSync = original;
    }
});

test('count, depth and unit limits report explicit incomplete results', () => {
    const project = fixture();
    for (let index = 0; index < 5; index++)
        file(project, `retrieve/sample/example/asset/email/deep/${index}.html`);
    const counted = inventory(project, { maxEntries: 2 });
    assert.equal(counted.visitedEntries, 2);
    assert.ok(codes(counted).includes('incomplete'));
    assert.ok(codes(inventory(project, { maxDepth: 2 })).includes('incomplete'));
    assert.ok(
        codes(
            inventory(fixture({ credentials: { sample: { businessUnits: { a: 1, b: 2 } } } }), {
                maxEntries: 1,
            })
        ).includes('incomplete')
    );
    for (const limits of [
        { maxEntries: 10001 },
        { maxDepth: 13 },
        { maxEntries: 0 },
        { maxDepth: Number.NaN },
    ]) {
        assert.ok(codes(inventory(project, limits)).includes('invalid-config'));
    }
});
