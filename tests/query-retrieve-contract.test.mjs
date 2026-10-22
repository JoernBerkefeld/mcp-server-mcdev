import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { QUERY_RETRIEVE_CONTRACT as contract } from '../dist/query-retrieve-contract.js';

const read = (file) =>
    fs.readFileSync(new URL(`../node_modules/mcdev/${file}`, import.meta.url), 'utf8');

test('query retrieve contract is bound to the installed reviewed version, not an executor', () => {
    assert.equal(JSON.parse(read('package.json')).version, contract.reviewedVersion);
    assert.equal(contract.reviewedVersion, '10.1.0');
    assert.equal(contract.status, 'blocked-source-contract');
    assert.equal(contract.executionEnabled, false);
    assert.equal(contract.executesProcess, false);
    assert.deepEqual(Object.keys(contract.scope), [
        'command',
        'type',
        'selectors',
        'purge',
        'options',
    ]);
    assert.equal(contract.scope.command, 'retrieve');
    assert.equal(contract.scope.type, 'query');
    assert.equal(contract.scope.purge, false);
    assert.match(contract.scope.selectors, /one literal external key.*no CSV/);
    assert.match(contract.scope.options, /not an executable argv contract/);
});

test('all nested contract values and evidence records are immutable', () => {
    const visit = (value) => {
        if (value === null || typeof value !== 'object') return;
        assert.ok(Object.isFrozen(value));
        for (const child of Object.values(value)) visit(child);
    };
    visit(contract);
    assert.throws(() => {
        contract.scope.purge = true;
    }, TypeError);
    assert.throws(() => {
        contract.blockers.push('clear');
    }, TypeError);
});

test('source references identify actual installed native statements without executing them', () => {
    assert.ok(contract.sourceReferences.length > 0);
    for (const reference of contract.sourceReferences) {
        assert.ok(reference.file.startsWith('lib/'));
        assert.ok(!reference.file.includes('..'));
        const lines = read(reference.file).split('\n');
        assert.ok(Number.isSafeInteger(reference.line) && reference.line > 0);
        assert.equal(lines[reference.line - 1]?.trim(), reference.anchor, reference.file);
    }
});

test('explicit key and no-purge suppress only the selected-type wrapper cleanup branch', () => {
    const native = read('lib/index.js');
    assert.ok(native.includes('if ((!areKeySet && !Util.OPTIONS.like) || Util.OPTIONS.purge) {'));
    assert.ok(native.includes('if (!retrieveTypesArr.length) {'));
    assert.match(native, /const areKeySet = Array\.isArray\(selectedTypesArr\)\s*\? !!keys/);
    assert.ok(
        read('lib/cli.js').includes(
            'Mcdev.retrieve(argv.BU, csvToArray(argv.TYPE), csvToArray(argv.KEY));'
        )
    );
    assert.equal(contract.wrapperCleanup.transitiveCleanupSafety, 'not-established');
    assert.match(contract.wrapperCleanup.condition, /whole BU tree.*even with a key/);
});

test('zero-saved REST result can delete local query companions despite no-purge', () => {
    assert.match(
        read('lib/metadataTypes/MetadataType.js'),
        /if \(Object\.keys\(savedMetadata\)\.length > 0\)[\s\S]*?else if \(singleRetrieve\) \{\s*await this\.postDeleteTasks\(singleRetrieve\);/
    );
    assert.ok(
        read('lib/metadataTypes/Query.js').includes(
            'await super.postDeleteTasks(customerKey, [`${this.definition.type}-meta.sql`]);'
        )
    );
    assert.ok(read('lib/metadataTypes/MetadataType.js').includes('await File.remove(jsonFile);'));
    assert.match(
        contract.localEffects.join(' '),
        /early SOAP key-not-found return.*distinct cases/
    );
    assert.equal(contract.deletionPolicy.nativeSafety, 'not-established');
    assert.equal(contract.deletionPolicy.portableAuthorization, false);
    assert.match(contract.deletionPolicy.taskException, /not native behavior, operation consent/);
    assert.match(contract.deletionPolicy.taskException, /excludes agent-authored cleanup/);
    assert.match(contract.deletionPolicy.taskException, /does not waive TEMP/);
});

test('dependency reads, overwrites and dynamic validation/formatting remain explicit blockers', () => {
    assert.ok(
        read('lib/metadataTypes/definitions/Query.definition.js').includes(
            "dependencies: ['folder-queryactivity', 'dataExtension']"
        )
    );
    assert.match(
        contract.remoteEffects.join(' '),
        /shared\/parent scope.*not exhaustively audited/
    );
    assert.match(contract.localEffects.join(' '), /overwrite both/);
    const validation = read('lib/metadataTypes/MetadataType.js');
    assert.ok(
        validation.indexOf('const validationRules = await validationsRules(') <
            validation.indexOf(
                'const fixable = Object.prototype.hasOwnProperty.call(validationRules[rule]'
            )
    );
    assert.ok(
        read('lib/util/validations.js').includes('customRuleImport = await import(rulesUrl);')
    );
    assert.match(contract.dynamicBoundaries.join(' '), /skipValidation does not prevent.*import/);
    assert.match(
        contract.dynamicBoundaries.join(' '),
        /configured plugins.*unresolved dynamic boundary/
    );
    assert.match(contract.prerequisites.join(' '), /auth-derived EID mismatch/);
    assert.match(contract.conclusion, /Do not enable execution/);
});

test('contract module has no imports, functions or side-effect calls beyond frozen data construction', () => {
    const text = fs.readFileSync(
        new URL('../src/query-retrieve-contract.ts', import.meta.url),
        'utf8'
    );
    const source = ts.createSourceFile('contract.ts', text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
        assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
        assert.ok(!ts.isFunctionDeclaration(node) && !ts.isNewExpression(node));
        if (ts.isCallExpression(node)) {
            assert.ok(
                ['Object.freeze', 'String', 'Number', '[\n'].some((prefix) =>
                    node.expression.getText(source).startsWith(prefix)
                ) ||
                    (ts.isPropertyAccessExpression(node.expression) &&
                        node.expression.name.text === 'map')
            );
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    const index = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.ok(!index.includes('query-retrieve-contract'));
});
