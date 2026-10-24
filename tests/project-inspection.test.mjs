import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ProjectInspectionError, readProjectConfig } from '../dist/project-inspection.js';

validateTempEnvironment();
const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-inspection-')));
fs.writeFileSync(path.join(runRoot, '.owner'), randomUUID());
// Retain every synthetic fixture: no cleanup or recursive deletion is performed.

function fixture(raw = '{}') {
    const root = fs.mkdtempSync(path.join(runRoot, 'project-'));
    fs.writeFileSync(path.join(root, '.mcdevrc.json'), raw);
    return root;
}

function rejects(root, code) {
    assert.throws(
        () => readProjectConfig(root),
        (ex) =>
            ex instanceof ProjectInspectionError &&
            ex.code === code &&
            ex.message === `Project configuration inspection failed: ${code}.`
    );
}

function withoutContentReads(action) {
    const originalRead = fs.readSync;
    const originalReadFile = fs.readFileSync;
    let reads = 0;
    fs.readSync = fs.readFileSync = () => {
        reads++;
        throw new Error('content access forbidden');
    };
    try {
        action();
        assert.equal(reads, 0);
    } finally {
        fs.readSync = originalRead;
        fs.readFileSync = originalReadFile;
    }
}

test('returns complete raw text and all parsed credentials/custom fields', () => {
    const config = {
        credentials: { fictional: { eid: '10001', businessUnits: { sample: '10002' } } },
        markets: { invented: { locale: 'en-XA' } },
        marketList: { sample: ['invented'] },
        directories: { retrieve: 'custom-downloads' },
        options: { deployment: { mpb_pipeline: { custom: true } } },
        customOwnedKey: { nested: ['unchanged', 42] },
    };
    const raw = `  ${JSON.stringify(config, null, 2)}\n`;
    const root = fixture(raw);
    const actual = readProjectConfig(root);
    assert.equal(actual.projectRoot, root);
    assert.equal(actual.configPath, path.join(root, '.mcdevrc.json'));
    assert.equal(actual.rawText, raw);
    assert.deepEqual(actual.config, config);
});

test('invalid JSON errors never contain parser fragments', () => {
    rejects(fixture('{"private-fragment":'), 'invalid-config');
});

test('requires an object instead of null, scalar or array config', () => {
    for (const raw of ['null', '[]', '42', '"example"']) rejects(fixture(raw), 'invalid-config');
});

test('missing fixed config has a safe classification', () => {
    const root = fs.mkdtempSync(path.join(runRoot, 'missing-'));
    rejects(root, 'missing-config');
});

test('relative, traversal and noncanonical spellings are rejected before reads', () => {
    const root = fixture();
    withoutContentReads(() => {
        for (const candidate of [
            '',
            '.',
            'relative',
            `${root}${path.sep}..${path.sep}alias`,
            `${root}${path.sep}`,
        ]) {
            rejects(candidate, 'unsafe-path');
        }
    });
});

test('auth path is denied before metadata or content access, including absent names', () => {
    const root = fixture();
    const original = fs.lstatSync;
    let inspections = 0;
    fs.lstatSync = () => {
        inspections++;
        throw new Error('metadata access forbidden');
    };
    try {
        withoutContentReads(() => {
            for (const name of ['.mcdev-auth.json', '.MCDEV-AUTH.JSON', '.mcdev-auth.json.']) {
                rejects(path.join(root, name), 'unsafe-path');
            }
        });
        assert.equal(inspections, 0);
    } finally {
        fs.lstatSync = original;
    }
});

test('directory junction aliases are rejected before reads', () => {
    const root = fixture();
    const alias = path.join(runRoot, 'junction');
    fs.symlinkSync(root, alias, 'junction');
    withoutContentReads(() => rejects(alias, 'unsafe-path'));
});

test('file-link metadata is rejected before reads even without OS symlink privileges', () => {
    const root = fixture();
    const original = fs.lstatSync;
    fs.lstatSync = (candidate, ...args) => {
        const metadata = original(candidate, ...args);
        if (candidate === path.join(root, '.mcdevrc.json')) {
            metadata.isSymbolicLink = () => true;
        }
        return metadata;
    };
    try {
        withoutContentReads(() => rejects(root, 'unsafe-path'));
    } finally {
        fs.lstatSync = original;
    }
});

test('file symlink aliases are rejected before reads', (t) => {
    const root = fs.mkdtempSync(path.join(runRoot, 'symlink-'));
    const target = path.join(runRoot, 'synthetic-target.json');
    fs.writeFileSync(target, '{}');
    try {
        fs.symlinkSync(target, path.join(root, '.mcdevrc.json'), 'file');
    } catch (ex) {
        if (ex.code === 'EPERM') {
            t.skip('Windows file symlinks require developer mode or symlink privilege');
            return;
        }
        throw ex;
    }
    withoutContentReads(() => rejects(root, 'unsafe-path'));
});

test('hardlink aliases fail closed before reads without inspecting auth', () => {
    const root = fs.mkdtempSync(path.join(runRoot, 'hardlink-'));
    const target = path.join(runRoot, 'hardlink-target.json');
    fs.writeFileSync(target, '{}');
    fs.linkSync(target, path.join(root, '.mcdevrc.json'));
    withoutContentReads(() => rejects(root, 'unsafe-path'));
});

test('oversize config is denied before reads and exact bound is accepted', () => {
    withoutContentReads(() => rejects(fixture(' '.repeat(1024 * 1024 + 1)), 'config-too-large'));
    const raw = '{}'.padEnd(1024 * 1024, ' ');
    assert.equal(readProjectConfig(fixture(raw)).rawText, raw);
});

test('filesystem failures do not expose raw exception details', () => {
    const root = fixture();
    const original = fs.openSync;
    fs.openSync = () => {
        throw new Error('sensitive filesystem fragment');
    };
    try {
        rejects(root, 'unavailable');
    } finally {
        fs.openSync = original;
    }
});
