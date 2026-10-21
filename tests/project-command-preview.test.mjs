import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { previewProjectCommand } from '../dist/project-command-preview.js';
import { previewRetrieveDeploy } from '../dist/retrieve-deploy-effects.js';

const project = (config = {}) => ({
    projectRoot: 'F:/synthetic-project',
    configPath: 'F:/synthetic-project/.mcdevrc.json',
    rawText: 'unchanged',
    config: {
        credentials: {
            alpha: { businessUnits: { QA: 12345 } },
            beta: { businessUnits: { QA: '67890', Other: 56789 } },
        },
        ...config,
    },
});
const base = {
    command: 'retrieve',
    credential: 'alpha',
    businessUnit: 'QA',
    type: 'query',
    key: 'one-item',
};

test('exact qualified mappings distinguish duplicate BU aliases without inferring defaults', () => {
    for (const credential of ['alpha', 'beta']) {
        const result = previewProjectCommand(project(), { ...base, credential });
        assert.equal(result.scope.bu, `${credential}/QA`);
        assert.equal(result.selectorVerification, 'verified-config-mapping');
        assert.deepEqual(result.projectSelectors, { credential, businessUnit: 'QA' });
    }
    for (const request of [
        { ...base, credential: 'unknown' },
        { ...base, credential: 'Alpha' },
        { ...base, businessUnit: 'qa' },
        { ...base, businessUnit: 'unknown' },
        { ...base, businessUnit: 'Other' },
        { ...base, credential: 'toString' },
        { ...base, businessUnit: 'toString' },
    ]) {
        assert.throws(() => previewProjectCommand(project(), request));
    }
});

test('missing, broad, ambiguous and malformed selectors and fields fail closed', () => {
    for (const field of ['command', 'credential', 'businessUnit', 'type', 'key']) {
        const request = { ...base };
        delete request[field];
        assert.throws(() => previewProjectCommand(project(), request));
    }
    for (const field of ['credential', 'businessUnit', 'key']) {
        for (const value of ['', '*', 'alpha/*', 'a,b', ' QA', 'QA ', 'a/b', '..', 'x\n', null]) {
            assert.throws(() => previewProjectCommand(project(), { ...base, [field]: value }));
        }
    }
    for (const extra of [{ approved: true }, { bu: 'alpha/QA' }, { dryRun: true }]) {
        assert.throws(() => previewProjectCommand(project(), { ...base, ...extra }));
    }
    for (const input of [null, [], Object.create(base)]) {
        assert.throws(() => previewProjectCommand(project(), input));
    }
    let calls = 0;
    assert.throws(() =>
        previewProjectCommand(project(), {
            ...base,
            get credential() {
                calls++;
                return 'alpha';
            },
        })
    );
    assert.equal(calls, 0);
});

test('invalid mappings and placeholder MIDs never verify a selected BU', () => {
    for (const credentials of [null, [], {}, { alpha: null }, { alpha: { businessUnits: [] } }]) {
        assert.throws(() => previewProjectCommand(project({ credentials }), base));
    }
    for (const mid of [0, '0', '000', '', ' ', -1, 1.5, '12x', true, null, {}]) {
        assert.throws(() =>
            previewProjectCommand(
                project({ credentials: { alpha: { businessUnits: { QA: mid } } } }),
                base
            )
        );
    }
    const credentials = Object.create({ alpha: { businessUnits: { QA: 12345 } } });
    assert.throws(() => previewProjectCommand(project({ credentials }), base));
});

test('composition retains supported effects and rejects unsupported types/options', () => {
    for (const command of ['retrieve', 'deploy']) {
        for (const type of ['automation', 'asset-email', 'dataExtension', 'query', 'script']) {
            const result = previewProjectCommand(project(), { ...base, command, type });
            const synthetic = previewRetrieveDeploy({
                command,
                bu: 'alpha/QA',
                type,
                key: base.key,
            });
            assert.equal(result.effects, synthetic.effects);
            assert.deepEqual(result.blockedReasons, synthetic.blockedReasons);
        }
    }
    const purge = previewProjectCommand(project(), { ...base, options: { purge: true } });
    assert.match(purge.warnings.join(' '), /entire selected type directory/);
    const execute = previewProjectCommand(project(), {
        ...base,
        command: 'deploy',
        type: 'automation',
        options: { execute: true, schedule: true },
    });
    assert.match(execute.warnings.join(' '), /both run/);
    for (const input of [
        { command: 'r' },
        { type: 'folder' },
        { type: 'asset' },
        { options: { metadata: 'query:one-item' } },
        { options: { api: 'cli' } },
        { options: { execute: true } },
        { options: { like: '%' } },
    ]) {
        assert.throws(() => previewProjectCommand(project(), { ...base, ...input }));
    }
});

test('custom relevant roots are blocked and default spellings never prove filesystem effects', () => {
    for (const name of ['retrieve', 'deploy', 'docs']) {
        for (const value of ['custom-output', '../outside', 'F:/elsewhere', '', null]) {
            assert.throws(
                () => previewProjectCommand(project({ directories: { [name]: value } }), base),
                /roots are unsupported/
            );
        }
    }
    for (const directories of [null, []]) {
        assert.throws(() => previewProjectCommand(project({ directories }), base));
    }
    for (const config of [
        {},
        { directories: { retrieve: 'retrieve/', deploy: 'deploy', docs: 'docs/' } },
    ]) {
        const result = previewProjectCommand(project(config), base);
        assert.equal(result.configuredPaths, 'unknown');
        assert.equal(result.executionReadiness, 'unknown');
        assert.equal(result.executesProcess, false);
        assert.equal(result.remoteStateValidated, false);
        assert.match(
            result.limitations.join(' '),
            /Generic native effects are not proven project effects/
        );
        assert.match(result.limitations.join(' '), /host-consent/);
        assert.match(result.limitations.join(' '), /no dry-run mode/);
        assert.match(result.limitations.join(' '), /lib\/Deployer.js:69-379/);
    }
});

test('project/config and request stay untouched and output markers are immutable', () => {
    const selected = project();
    const request = { ...base, options: { skipInteraction: true } };
    const before = structuredClone({ selected, request });
    const result = previewProjectCommand(selected, request);
    assert.deepEqual({ selected, request }, before);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.projectSelectors));
    assert.ok(Object.isFrozen(result.limitations));
});

test('adapter runtime imports are pure and exclude native execution and IO loading', () => {
    const text = fs.readFileSync(
        new URL('../src/project-command-preview.ts', import.meta.url),
        'utf8'
    );
    const source = ts.createSourceFile('preview.ts', text, ts.ScriptTarget.Latest, true);
    const imports = [];
    function visit(node) {
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
            imports.push(node.moduleSpecifier.text);
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
    assert.deepEqual(imports, ['./retrieve-deploy-effects.js']);
});
