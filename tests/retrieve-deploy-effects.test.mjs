import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { RETRIEVE_DEPLOY_EFFECTS, previewRetrieveDeploy } from '../dist/retrieve-deploy-effects.js';

const base = { command: 'deploy', bu: 'example/Business Unit', type: 'automation', key: 'item-1' };

test('static effects cover retrieve/deploy only and expose immutable evidence and blockers', () => {
    assert.deepEqual(
        RETRIEVE_DEPLOY_EFFECTS.map((entry) => entry.command),
        ['retrieve', 'deploy']
    );
    for (const entry of RETRIEVE_DEPLOY_EFFECTS) {
        assert.equal(entry.reviewedVersion, '10.1.1');
        assert.equal(entry.status, 'guidance-only');
        assert.ok(Object.isFrozen(entry));
        for (const reference of entry.sourceReferences) {
            const text = fs.readFileSync(
                new URL(`../node_modules/mcdev/${reference.file}`, import.meta.url),
                'utf8'
            );
            assert.ok(reference.startLine > 0);
            assert.ok(reference.endLine >= reference.startLine);
            assert.ok(reference.endLine <= text.split('\n').length);
            assert.ok(Object.isFrozen(reference));
        }
        const preview = previewRetrieveDeploy({ ...base, command: entry.command });
        assert.equal(preview.effects, entry);
        assert.equal(preview.executesProcess, false);
        assert.equal(preview.remoteStateValidated, false);
        assert.equal(preview.status, 'guidance-only');
        assert.match(preview.blockedReasons.join(' '), /cleanup.*unresolved/);
        assert.match(preview.blockedReasons.join(' '), /Host approval/);
        assert.match(preview.warnings.join(' '), /not a dry run/);
        assert.ok(Object.isFrozen(preview.scope));
        assert.ok(Object.isFrozen(preview.options));
        assert.ok(Object.isFrozen(preview.warnings));
    }
});

const read = (file) =>
    fs.readFileSync(new URL(`../node_modules/mcdev/lib/${file}`, import.meta.url), 'utf8');

test('native evidence anchors cleanup, hooks, interactive exceptions and rule semantics', () => {
    assert.match(
        read('index.js'),
        /\(!areKeySet && !Util\.OPTIONS\.like\) \|\| Util\.OPTIONS\.purge/
    );
    assert.match(
        read('Deployer.js'),
        /await File\.remove\(File\.normalizePath\(\[this\.deployDir, 'folder'\]\)\)/
    );
    assert.match(
        read('metadataTypes/MetadataType.js'),
        /!Util\.OPTIONS\.skipValidation && mode === 'fix'/
    );
    assert.match(read('metadataTypes/Automation.js'), /if \(Util\.OPTIONS\.schedule\)/);
    assert.match(read('metadataTypes/Automation.js'), /if \(Util\.OPTIONS\.execute\)/);
    assert.match(read('metadataTypes/Asset.js'), /if \(Util\.OPTIONS\.refresh\)/);
    assert.match(read('metadataTypes/DataExtension.js'), /if \(!fixBuPreselected\.length\)/);
    assert.match(read('cli.js'), /choices: \['log', 'cli'\]/);
    assert.match(RETRIEVE_DEPLOY_EFFECTS[1].interaction, /still prompt/);
});

test('synthetic flags describe widened scopes, diagnostics and skipValidation without claiming execution', () => {
    const deploy = previewRetrieveDeploy({
        ...base,
        options: { execute: true, schedule: true, skipValidation: true, api: 'log' },
    });
    assert.match(deploy.warnings.join(' '), /both run/);
    assert.match(deploy.warnings.join(' '), /still runs.*passed\(\)/);
    assert.match(deploy.warnings.join(' '), /sensitive API payloads/);
    const shared = previewRetrieveDeploy({
        ...base,
        type: 'dataExtension',
        options: { fixShared: true, skipInteraction: true },
    });
    assert.match(shared.warnings.join(' '), /outside this BU/);
    const asset = previewRetrieveDeploy({
        ...base,
        type: 'asset-email',
        options: { refresh: true, fromRetrieve: true, noUpdate: true, fix: true, format: false },
    });
    assert.match(asset.effects.remoteEffects.join(' '), /related active triggered sends/);
    const retrieve = previewRetrieveDeploy({
        ...base,
        command: 'retrieve',
        options: { purge: true, onlyPublished: true },
    });
    assert.match(retrieve.warnings.join(' '), /entire selected type directory/);
    assert.throws(() => {
        retrieve.options.purge = false;
    }, TypeError);
});

test('omitted, broad, nonliteral and unsupported selectors are rejected', () => {
    for (const field of ['command', 'bu', 'type', 'key']) {
        const request = { ...base };
        delete request[field];
        assert.throws(() => previewRetrieveDeploy(request));
    }
    for (const command of ['r', 'd', 'execute', 'deploy --help']) {
        assert.throws(() => previewRetrieveDeploy({ ...base, command }));
    }
    for (const bu of [
        '*',
        'example/*',
        'example',
        'a/b/c',
        '../x',
        'a/../b',
        'a/b;whoami',
        'a/b\n',
    ]) {
        assert.throws(() => previewRetrieveDeploy({ ...base, bu }));
    }
    for (const key of [
        '',
        '*',
        'a,b',
        'n:name',
        'i:123',
        '--help',
        '../x',
        'a/b',
        'x%y',
        'x;whoami',
        '$(whoami)',
        'x\n',
    ]) {
        assert.throws(() => previewRetrieveDeploy({ ...base, key }));
    }
    for (const type of ['folder', 'unknown', 'asset', 'automation,query', '--help']) {
        assert.throws(() => previewRetrieveDeploy({ ...base, type }));
    }
});

test('unsupported, aliased, injection and wrong-family options fail closed', () => {
    for (const options of [
        { api: 'cli' },
        { api: true },
        { execute: 'true' },
        { e: true },
        { metadata: ['automation:item'] },
        { like: '%' },
        { publish: true },
        { keySuffix: ';whoami' },
        { unknown: false },
        { __proto__: { execute: true } },
        [],
        null,
    ]) {
        assert.throws(() => previewRetrieveDeploy({ ...base, options }));
    }
    assert.throws(() => previewRetrieveDeploy({ ...base, options: { purge: true } }));
    assert.throws(() =>
        previewRetrieveDeploy({ ...base, command: 'retrieve', options: { execute: true } })
    );
    for (const flag of ['refresh', 'fixShared']) {
        assert.throws(() => previewRetrieveDeploy({ ...base, options: { [flag]: true } }));
    }
    assert.throws(() => previewRetrieveDeploy({ ...base, shell: true }));
    let getterCalls = 0;
    const request = {
        ...base,
        get options() {
            getterCalls++;
            return {};
        },
    };
    assert.throws(() => previewRetrieveDeploy(request));
    assert.equal(getterCalls, 0);
    assert.throws(() =>
        previewRetrieveDeploy({
            ...base,
            options: {
                get execute() {
                    getterCalls++;
                    return true;
                },
            },
        })
    );
    assert.equal(getterCalls, 0);
});

test('preview module has zero subprocess/IO imports or dynamic loading and executes only pure guidance', () => {
    const text = fs.readFileSync(
        new URL('../src/retrieve-deploy-effects.ts', import.meta.url),
        'utf8'
    );
    const source = ts.createSourceFile('effects.ts', text, ts.ScriptTarget.Latest, true);
    const imports = [];
    function visit(node) {
        if (ts.isImportDeclaration(node)) {
            imports.push(node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node)) {
            assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword);
            assert.ok(
                !['require', 'eval', 'Function', 'exec', 'spawn', 'execFile', 'fork'].includes(
                    node.expression.getText(source)
                )
            );
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.deepEqual(imports, ['./command-catalog.js']);
    for (let index = 0; index < 50; index++) {
        assert.equal(previewRetrieveDeploy(base).executesProcess, false);
    }
});
