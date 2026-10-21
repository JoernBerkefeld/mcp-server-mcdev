import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { listCommands, lookupCommand } from '../dist/command-catalog.js';

const root = new URL('../node_modules/mcdev/', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const cli = read('lib/cli.js');
const index = read('lib/index.js');
const devops = read('lib/util/devops.js');
const builder = read('lib/Builder.js');
const effects = lookupCommand('createDeltaPkg').reviewedEffects;

// These are native implementation contracts, not assertions against our explanatory prose.
// Any drift requires a source review; no mcdev module or handler is loaded here.
test('reviewed effects are pinned to the installed version and exact native source anchors', () => {
    assert.equal(effects.reviewedVersion, JSON.parse(read('package.json')).version);
    assert.equal(effects.reviewedVersion, '10.1.0');
    assert.equal(effects.sourceReferences.length, 12);
    for (const { file, line, anchor } of effects.sourceReferences) {
        assert.ok(file.startsWith('mcdev/lib/'));
        assert.equal(read(file.slice('mcdev/'.length)).split('\n')[line - 1].trim(), anchor);
    }
});

test('reviewed commands retain the exact delta fields and aliases share its record', () => {
    assert.deepEqual(
        listCommands()
            .filter((entry) => entry.reviewedEffects)
            .map((entry) => entry.name),
        [
            'clone',
            'build',
            'buildTemplate',
            'buildDefinition',
            'buildDefinitionBulk',
            'createDeltaPkg',
        ]
    );
    assert.deepEqual(Object.keys(effects), [
        'status',
        'reviewedVersion',
        'range',
        'inputs',
        'mapping',
        'filteredCopy',
        'localRemoval',
        'build',
        'reportsAndDeletions',
        'remoteAndHooks',
        'sourceReferences',
    ]);
    assert.equal(effects.status, 'partial-source-review');
    assert.equal(lookupCommand('cdp'), lookupCommand('createDeltaPkg'));
    assert.equal(lookupCommand('cdp').reviewedEffects, effects);
    assert.equal(lookupCommand('cdp').execution.status, 'guidance-only');
    assert.ok(Object.isFrozen(effects));
    assert.ok(Object.isFrozen(effects.sourceReferences));
    for (const reference of effects.sourceReferences) assert.ok(Object.isFrozen(reference));
    assert.equal(effects.approved, undefined);
    assert.equal(effects.argv, undefined);
    assert.equal(effects.executable, undefined);
});

test('range precedence, native expansion, interactive selection and mapping key stay source-grounded', () => {
    assert.ok(cli.includes("alias: ['branch', 'commit', 'R']"));
    assert.ok(index.includes('const range = argv.commitrange || Util.OPTIONS.range;'));
    assert.ok(devops.includes("if (!range.includes('..'))"));
    assert.ok(devops.includes("range += '..HEAD';"));
    assert.ok(devops.includes("await getGit().log([\n                '--skip=1',"));
    assert.ok(
        devops.includes('commitHistory || properties.options.deployment.commitHistory || 10')
    );
    assert.ok(devops.includes('const baseCommit = await select({'));
    assert.ok(devops.includes('range = `${baseCommit}..HEAD`;'));
    assert.ok(devops.includes('await getGit().diffSummary([range])'));
    const mapping = devops.indexOf(
        'properties.options.deployment.branchSourceTargetMapping?.[range]'
    );
    const delta = devops.indexOf(
        'await DevOps.getDeltaList(properties, range, false, sourceBU, commitHistory)'
    );
    assert.ok(mapping > 0 && mapping < delta);
    assert.ok(
        devops.includes('Object.keys(properties.options.deployment.sourceTargetMapping).length')
    );
    assert.ok(devops.includes('sourceMarketBuArr.length !== 1'));
    assert.ok(
        devops.includes("'string' !== typeof properties.marketList[sourceML][sourceMarketBuArr[0]]")
    );
});

test('filesystem copy inputs, native removal, build outputs and deletion warnings stay source-grounded', () => {
    for (const fragment of [
        'await File.pathExists(file.file)',
        "file.gitAction = 'delete';",
        'await MetadataType[file.type].readBUMetadataForType(',
        'await MetadataType[type].getFilesToCommit(',
        '.normalize(properties.directories.retrieve + filePath)',
        'if (Util.skipInteraction || isPurgeDeployFolder)',
        'await File.remove(',
        'File.copyFileSimple(\n                        file.file,',
        'path.normalize(properties.directories.deploy)',
        "const directoryDeltaPkg = 'logs/';",
        'await File.writeJSONToFile(',
        'this.document(directoryDeltaPkg, filterPathsCSV, delta);',
        'if (Util.OPTIONS.purge === true && sourceMarketListArr.length > 1)',
        'await Builder.purgeDeployFolderList(sourceTargetMapping[sourceMlName]);',
        ".filter((file) => file.gitAction !== 'delete' && file.name)",
        'Array.isArray(properties.metaDataTypes.createDeltaPkg)',
        'await mcdev.build(',
        'sourceMarketLists.filter',
        "file.type !== 'asset' || (file.type === 'asset' && file.file.endsWith('.json'))",
        "Util.logger.warn(`mcdev delete ${targetBu} -m ${metadataList.join(' ')}`);",
        'gitClient.revparse([`${baseRef}:${oldPath}`])',
        'gitClient.revparse([`${targetRef}:${newFile.file}`])',
    ])
        assert.ok(devops.includes(fragment), fragment);
    const copyBlock = devops.slice(
        devops.indexOf('if (saveToDeployDir)'),
        devops.indexOf('    async buildDeltaDefinitions(')
    );
    assert.ok(!copyBlock.includes('Util.OPTIONS.purge'));
    const deletionBlock = devops.slice(devops.indexOf('    _generateDeleteInstructions('));
    assert.ok(!deletionBlock.includes('mcdev.delete('));
    for (const fragment of [
        "properties.directories.template = '.mcdev/template/';",
        "if (typeof Util.OPTIONS.purge !== 'boolean')",
        'Util.OPTIONS.purge = await confirm({',
        'await File.remove(properties.directories.template);',
        'await Builder.purgeDeployFolderList(listName);',
    ])
        assert.ok(index.includes(fragment), fragment);
    for (const fragment of [
        'properties.directories.templateBuilds',
        'this.retrieveDir,\n                                this.templateDir,',
        'this.templateDir,\n                            this.targetDir,',
        'properties.directories.deploy,',
        'await File.remove(deployDir);',
    ])
        assert.ok(builder.includes(fragment), fragment);
});

test('remote retrieval evidence is explicit without claiming complete delegated effects', () => {
    assert.ok(index.includes('await this._reRetrieve(businessUnit, false, typeKeyList);'));
    assert.ok(index.includes('if (runRetrieveNow || Util.OPTIONS.retrieve)'));
    assert.ok(index.includes('await this.retrieve(businessUnit, retrieveTypes);'));
    for (const option of ['dependencies', 'retrieve', 'skipValidation', 'fix', 'shareAsset']) {
        const deltaDeclaration = cli.slice(
            cli.indexOf("['createDeltaPkg [commitrange]', 'cdp']"),
            cli.indexOf("['getFilesToCommit")
        );
        assert.ok(deltaDeclaration.includes(`.option('${option}',`));
    }
    assert.match(effects.remoteAndHooks, /unknown/u);
    assert.match(effects.remoteAndHooks, /implicit deployments/u);
});
