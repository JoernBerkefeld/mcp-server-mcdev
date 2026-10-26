import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { listCommands, lookupCommand } from '../dist/command-catalog.js';

// Source text only: never load native mcdev modules, project hooks or credentials.
const root = new URL('../node_modules/mcdev/', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const between = (text, start, end) => {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `Missing source boundaries: ${start}`);
    return text.slice(from, to);
};
const contains = (text, fragments) => {
    for (const fragment of fragments) assert.ok(text.includes(fragment), fragment);
};
const index = read('lib/index.js');
const builder = read('lib/Builder.js');
const effects = lookupCommand('clone').reviewedEffects;

test('clone is an immutable version-pinned guidance record, not a new command or alias', () => {
    assert.equal(effects.reviewedVersion, JSON.parse(read('package.json')).version);
    assert.equal(effects.reviewedVersion, '10.1.0');
    assert.equal(effects.status, 'partial-source-review');
    assert.equal(listCommands().length, 31);
    assert.equal(listCommands().flatMap((entry) => entry.aliases).length, 26);
    assert.deepEqual(lookupCommand('clone').aliases, []);
    assert.equal(lookupCommand('bt'), lookupCommand('buildTemplate'));
    assert.equal(lookupCommand('clone').execution.status, 'partially-executable');
    assert.equal(effects.sourceReferences.length, 21);
    assert.ok(Object.isFrozen(effects));
    assert.ok(Object.isFrozen(effects.sourceReferences));
    for (const reference of effects.sourceReferences) {
        assert.ok(Object.isFrozen(reference));
        const { file, line, anchor } = reference;
        assert.ok(file.startsWith('mcdev/lib/'));
        assert.equal(read(file.slice('mcdev/'.length)).split('\n')[line - 1].trim(), anchor);
    }
    for (const field of ['approved', 'argv', 'executable']) assert.equal(effects[field], undefined);
    for (const field of ['destinations', 'localRemoval', 'validationAndRemote'])
        assert.equal(effects[field], lookupCommand('build').reviewedEffects[field]);
});

test('clone declaration and exact delegation preserve selectors without inventing bulk or aliases', () => {
    const cli = between(read('lib/cli.js'), "        ['clone'],", "        ['build'],");
    for (const [name, alias] of [
        ['metadata', 'm'],
        ['buFrom', 'bf'],
        ['buTo', 'bt'],
        ['dependencies', 'D'],
        ['retrieve', 'r'],
        ['skipValidation', 'sv'],
    ]) {
        contains(cli, [`.option('${name}',`, `alias: '${alias}'`]);
    }
    for (const required of ['metadata', 'buFrom'])
        assert.ok(between(cli, `.option('${required}',`, '})').includes('demandOption: true'));
    assert.ok(!between(cli, ".option('buTo',", '})').includes('demandOption'));
    contains(cli, [
        ".option('purge',",
        'Mcdev.setOptions(argv);',
        'Mcdev.metadataToTypeKey(argv.metadata)',
        'Mcdev.clone(argv.buFrom, argv.buTo, typeKeyCombo);',
    ]);
    for (const option of ['bulk', 'market', 'fix', 'shareAsset'])
        assert.ok(!cli.includes(`.option('${option}',`));
    const wrapper = between(index, '    static async clone(', '    /**');
    assert.equal(
        wrapper.trim(),
        "static async clone(businessUnitTemplate, businessUnitDefinition, typeKeyCombo) {\n        return this.build(\n            businessUnitTemplate,\n            businessUnitDefinition,\n            typeKeyCombo,\n            ['__clone__'],\n            ['__clone__']\n        );\n    }"
    );
    contains(index.slice(index.indexOf('    static metadataToTypeKey(')), [
        "allowedIdentifiers = ['key', 'id', 'name']",
        "itemArr.join(':')",
        "(item.id ? 'id:' + item.id : item.name ? 'name:' + item.name : null)",
    ]);
});

test('clone sentinel skips market substitutions, not transformations, hooks or cleanup', () => {
    assert.equal(builder.split("if (marketArr[0] !== '__clone__')").length - 1, 2);
    contains(read('lib/util/util.js'), ["if (marketArr[0] !== '__clone__')"]);
    const compound = between(index, '    static async build(', '    static async buildTemplate(');
    contains(compound, [
        'if (!bulk && !businessUnitDefinition)',
        '!Array.isArray(typeKeyCombo[type]) || typeKeyCombo[type].length === 0',
        "properties.directories.template = '.mcdev/template/';",
        "if (typeof Util.OPTIONS.purge !== 'boolean')",
        'Util.OPTIONS.purge = await confirm({',
        'default: true,',
        'await File.remove(properties.directories.template);',
    ]);
    assert.ok(!compound.includes('skipInteraction'));
    assert.ok(!compound.includes('.deploy('));
    const metadata = read('lib/metadataTypes/MetadataType.js');
    contains(metadata, [
        'this.keepTemplateFields(metadata);',
        'metadata = await this.validation(',
        'await this.buildDefinitionForNested(',
        "metadata[this.definition.keyField] + '.' + this.definition.type + suffix",
    ]);
    contains(builder, ['properties.directories.templateBuilds', 'auth.getSDK(this.buObject)']);
    assert.match(effects.markets, /key\/name rewriting remains unknown/u);
    assert.match(effects.retrieval, /implicit deployments and remote writes remain unknown/u);
    assert.match(effects.validationAndRemote, /dynamically import project/u);
});

test('native BU fallback and retrieval conditions forbid an unattended or local-only promise', () => {
    const cli = read('lib/util/cli.js');
    const selection = between(cli, '    async _selectBU(', '    /**');
    contains(selection, [
        'answer.credential = await select({',
        'answer.businessUnit = await select({',
    ]);
    assert.ok(!selection.includes('skipInteraction'));
    const resolve = between(cli, '    async getCredentialObject(', '    /**');
    contains(resolve, [
        'if (Util.skipInteraction)',
        'throw new Error(msg);',
        '(!businessUnit || !properties.credentials[credential].businessUnits[businessUnit])',
        'await this._selectBU(properties, credential, null, allowAll)',
    ]);
    contains(index, [
        'if (!Util.OPTIONS.dependencies)',
        'await this._reRetrieve(businessUnit, false, typeKeyList);',
        'if (runRetrieveNow || Util.OPTIONS.retrieve)',
        'await this.retrieve(businessUnit, retrieveTypes);',
        'await this.addDependencies(businessUnit, typeKeyList);',
        'await this.addDependentCbReferences(businessUnit, typeKeyList);',
    ]);
    assert.match(effects.interaction, /Unattended prerequisites remain unverified/u);
    assert.match(effects.inputs, /downstream support is not established/u);
});
