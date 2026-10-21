import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { BUILD_EFFECTS } from '../dist/build-effects.js';
import { lookupCommand } from '../dist/command-catalog.js';

const root = new URL('../node_modules/mcdev/', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const cli = read('lib/cli.js');
const index = read('lib/index.js');
const builder = read('lib/Builder.js');
const metadata = read('lib/metadataTypes/MetadataType.js');
const validations = read('lib/util/validations.js');
const between = (text, start, end) => {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `Missing source boundaries: ${start}`);
    return text.slice(from, to);
};
const contains = (text, fragments) => {
    for (const fragment of fragments) assert.ok(text.includes(fragment), fragment);
};

test('three immutable build records retain canonical/alias identity and installed source anchors', () => {
    assert.deepEqual(Object.keys(BUILD_EFFECTS), ['build', 'buildTemplate', 'buildDefinition']);
    assert.ok(Object.isFrozen(BUILD_EFFECTS));
    for (const [name, alias] of [
        ['build', 'build'],
        ['buildTemplate', 'bt'],
        ['buildDefinition', 'bd'],
    ]) {
        const effects = BUILD_EFFECTS[name];
        assert.equal(lookupCommand(name), lookupCommand(alias));
        assert.equal(lookupCommand(alias).reviewedEffects, effects);
        assert.equal(effects.reviewedVersion, JSON.parse(read('package.json')).version);
        assert.equal(effects.status, 'partial-source-review');
        assert.ok(Object.isFrozen(effects));
        assert.ok(Object.isFrozen(effects.sourceReferences));
        assert.equal(effects.sourceReferences.length, 15);
        for (const { file, line, anchor } of effects.sourceReferences) {
            assert.equal(read(file.slice('mcdev/'.length)).split('\n')[line - 1].trim(), anchor);
        }
        for (const reference of effects.sourceReferences) assert.ok(Object.isFrozen(reference));
        assert.match(effects.validationAndRemote, /remain unknown/u);
        assert.equal(effects.approved, undefined);
        assert.equal(effects.argv, undefined);
    }
    assert.equal(lookupCommand('bdb').reviewedEffects, undefined);
});

test('CLI selection precedence and market overlay ordering stay source-grounded', () => {
    for (const [start, end, positional] of [
        ["['buildTemplate <BU>", "['buildDefinition <BU>", 'KEY'],
        ["['buildDefinition <BU>", "['buildDefinitionBulk <LISTNAME>", 'FILENAME'],
    ]) {
        const block = between(cli, start, end);
        contains(block, [
            'if (!argv.MARKET && !argv.market)',
            "if ('undefined' === typeof typeKeyCombo)",
            `csvToArray(argv.${positional})`,
            'argv.MARKET ? [argv.MARKET] : argv.market',
        ]);
    }
    contains(builder, [
        "if (marketArr[0] !== '__clone__')",
        'for (const market of marketArr)',
        'Object.assign(templateVariables, properties.markets[market]);',
        "name = name.replaceAll('%20', ' ');",
    ]);
});

test('compound build cleanup and standalone purge differ without destination guard', () => {
    const compound = between(index, '    static async build(', '    static async buildTemplate(');
    contains(compound, [
        "properties.directories.template = '.mcdev/template/';",
        "if (typeof Util.OPTIONS.purge !== 'boolean')",
        'Util.OPTIONS.purge = await confirm({',
        'default: true,',
        'await this.buildDefinitionBulk(marketDefinition[0], typeKeyCombo, null)',
        'await File.remove(properties.directories.template);',
        'properties.directories.template = templateDirBackup;',
    ]);
    assert.ok(!compound.includes('skipInteraction'));
    const definition = between(
        index,
        '    static async buildDefinition(',
        '    static async buildDefinitionBulk('
    );
    contains(definition, [
        'if (Util.OPTIONS.purge)',
        "await Builder.purgeDeployFolder(buObject.credential + '/' + buObject.businessUnit);",
    ]);
    assert.ok(!definition.includes('confirm('));
    const purge = builder.slice(
        builder.indexOf('    static async purgeDeployFolder(businessUnit)')
    );
    contains(purge, ['properties.directories.deploy,', 'await File.remove(deployDir);']);
    assert.ok(!purge.includes('properties.directories.templateBuilds'));
    contains(builder, [
        'this.templateDir = properties.directories.template;',
        'properties.directories.retrieve,',
        'const templateBuildsArr = Array.isArray(properties.directories.templateBuilds)',
        'this.targetDir = templateBuildsArr.map',
    ]);
});

test('template retrieval and delegated effects are not treated as local-only', () => {
    const template = between(
        index,
        '    static async buildTemplate(',
        '    static applyKeyFilters('
    );
    contains(template, [
        'if (!Util.OPTIONS.dependencies)',
        'await this._reRetrieve(businessUnit, false, typeKeyList);',
        "key.startsWith('name:')",
        'await this.addDependencies(businessUnit, typeKeyList);',
        'await this.addDependentCbReferences(businessUnit, typeKeyList);',
    ]);
    const retrieve = between(
        index,
        '    static async _reRetrieve(',
        '    static async buildDefinition('
    );
    contains(retrieve, [
        'Util.OPTIONS.retrieve === undefined && alwaysAsk',
        'if (runRetrieveNow || Util.OPTIONS.retrieve)',
        'await this.retrieve(businessUnit, retrieveTypes);',
    ]);
    assert.ok(!template.includes('purgeDeployFolder'));
    for (const name of ['build', 'buildTemplate'])
        assert.match(BUILD_EFFECTS[name].retrieval, /unknown/u);
});

test('base definition validates before writes and can execute project validation hooks', () => {
    const definition = between(
        metadata,
        '    static async buildDefinition(templateDir',
        '    static getErrorsREST('
    );
    contains(definition, [
        "'buildDefinition',",
        'Array.isArray(targetDir) ? targetDir[0] : targetDir',
        'await this.buildDefinitionForNested(',
        'for (const targetDir of targetDirArr)',
        'await File.writeJSONToFile(',
    ]);
    assert.ok(
        definition.indexOf('await this.validation(') <
            definition.indexOf('await this.buildDefinitionForNested(')
    );
    contains(metadata.slice(metadata.indexOf('    static async validation(')), [
        'if (!this.properties.options?.validation?.[method])',
        'const validationRules = await validationsRules(',
        'validationRules[rule].fix()',
        'validationRules[rule].passed()',
    ]);
    contains(validations, [
        "path.resolve(root, '.mcdev-validations.js')",
        'customRuleImport = await import(rulesUrl);',
        'await customRuleImport.validation(',
    ]);
    assert.match(
        BUILD_EFFECTS.buildDefinition.validationAndRemote,
        /not a promise to avoid loading\/executing hooks/u
    );
});
