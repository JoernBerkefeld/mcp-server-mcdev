import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { SCRIPT_RETRIEVE_CONTRACT as contract } from '../dist/script-retrieve-contract.js';

const read = (file) =>
    fs.readFileSync(new URL(`../node_modules/mcdev/${file}`, import.meta.url), 'utf8');

test('script evidence is immutable, version-bound data, never an executor or language validator', () => {
    assert.equal(JSON.parse(read('package.json')).version, contract.reviewedVersion);
    assert.equal(contract.reviewedVersion, '10.1.0');
    assert.equal(contract.scope.type, 'script');
    assert.equal(contract.scope.command, 'retrieve');
    assert.equal(contract.scope.purge, false);
    assert.equal(contract.executionEnabled, false);
    assert.equal(contract.executesProcess, false);
    assert.equal(contract.artifactPolicy.executesSource, false);
    assert.equal(contract.artifactPolicy.languageValidationPerformed, false);
    assert.equal(contract.artifactPolicy.remoteCompletenessVerified, false);
    const visit = (value) => {
        if (value === null || typeof value !== 'object') return;
        assert.ok(Object.isFrozen(value));
        for (const child of Object.values(value)) visit(child);
    };
    visit(contract);
    assert.throws(() => {
        contract.scope.type = 'query';
    }, TypeError);
    assert.deepEqual(contract.artifactPolicy.candidates, [
        'script-meta.json',
        'script-meta.ssjs',
        'script-meta.html',
    ]);
});

test('source anchors match installed native statements without importing metadata classes', () => {
    for (const { file, line, anchor } of contract.sourceReferences) {
        assert.ok(file.startsWith('lib/') && !file.includes('..'));
        assert.ok(Number.isSafeInteger(line) && line > 0);
        assert.equal(read(file).split('\n')[line - 1]?.trim(), anchor, `${file}:${line}`);
    }
});

test('literal-key script reads the paginated collection before exact local filtering, not Query SOAP', () => {
    const script = read('lib/metadataTypes/Script.js');
    const retrieve = script.slice(
        script.indexOf('static async retrieve('),
        script.indexOf('static async retrieveForCache(')
    );
    assert.ok(retrieve.includes("super.retrieveREST(retrieveDir, '/automation/v1/scripts/', key)"));
    assert.ok(!retrieve.includes('_getObjectIdForSingleRetrieve') && !retrieve.includes('.soap.'));
    const base = read('lib/metadataTypes/MetadataType.js');
    assert.match(
        base,
        /restPaginationForKey && singleRetrieve\)[\s\S]*?rest\.getBulk\(uri,[\s\S]*?parseResponseBody\(response, singleRetrieve\)/
    );
    assert.match(
        base,
        /const single = \{ \[singleRetrieve\]: metadataStructure\[singleRetrieve\] \};\s*return single;\s*\} else if \(singleRetrieve\) \{\s*return \{\};/
    );
    assert.match(
        contract.remoteEffects.join(' '),
        /broad remote collection read.*not a single-object.*Query SOAP/
    );
    assert.match(contract.remoteEffects.join(' '), /folder-ssjsactivity.*without a save directory/);
});

test('extraction removes inline script, chooses one companion, but zero-save can remove all candidates', () => {
    const script = read('lib/metadataTypes/Script.js');
    assert.match(
        script,
        /prepExtractedCode\(metadata\.script, metadata\.name\);\s*delete metadata\.script;/
    );
    assert.match(
        script,
        /if \(ssjs\) \{\s*code = ssjs;\s*fileExt = 'ssjs';\s*\} else \{\s*code = metadataScript;\s*fileExt = 'html';/
    );
    assert.match(
        script,
        /super\.postDeleteTasks\(customerKey, \[\s*`\$\{this\.definition\.type\}-meta\.ssjs`,\s*`\$\{this\.definition\.type\}-meta\.html`,/
    );
    assert.match(
        read('lib/metadataTypes/MetadataType.js'),
        /if \(Object\.keys\(savedMetadata\)\.length > 0\)[\s\S]*?else if \(singleRetrieve\) \{\s*await this\.postDeleteTasks\(singleRetrieve\);/
    );
    assert.match(contract.localEffects.join(' '), /delete JSON plus both SSJS and HTML.*no-purge/);
    assert.match(contract.localEffects.join(' '), /other companion is not automatically removed/);
    assert.match(
        contract.artifactPolicy.localMaterialization,
        /exactly one.*Both companions are ambiguous/
    );
});

test('format, validation, documentation and private native state restrictions remain explicit', () => {
    assert.match(
        read('lib/util/file.js'),
        /if \(!this\._isFormattingEnabled\(properties\)\) \{\s*return;/
    );
    assert.match(
        contract.restrictions.join(' '),
        /absent project validation hook.*skipValidation does not prevent/
    );
    assert.match(
        contract.restrictions.join(' '),
        /no-format.*Prettier.*Disable script documentOnRetrieve.*noLogFile/
    );
    assert.match(
        contract.remoteEffects.join(' '),
        /persist authentication\/session state.*inspection, search, hashing/
    );
    assert.match(contract.restrictions.join(' '), /metadata retrieval, not SSJS execution/);
});

test('contract module contains only frozen data with no imports or native calls', () => {
    const text = fs.readFileSync(
        new URL('../src/script-retrieve-contract.ts', import.meta.url),
        'utf8'
    );
    const source = ts.createSourceFile('contract.ts', text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
        assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
        assert.ok(!ts.isFunctionDeclaration(node) && !ts.isNewExpression(node));
        if (ts.isCallExpression(node))
            assert.equal(node.expression.getText(source), 'Object.freeze');
        ts.forEachChild(node, visit);
    };
    visit(source);
});
