import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import {
    CAPABILITY_ROUTES,
    COMMAND_CATALOG_SOURCE,
    NATIVE_RUNNER_COMMANDS,
    REVIEWED_MCDEV_VERSION,
    listCommands,
    lookupCommand,
} from '../dist/command-catalog.js';

const packageRoot = new URL('../node_modules/mcdev/', import.meta.url);
const cliText = fs.readFileSync(new URL('lib/cli.js', packageRoot), 'utf8');

// Parse source text only: importing this CLI would initialize yargs and its handlers.
function extractDeclarations(text) {
    const source = ts.createSourceFile(
        'cli.js',
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
    );
    const declarations = [];
    let commandCalls = 0;
    function visit(node) {
        ts.forEachChild(node, visit);
        if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            node.expression.name.text !== 'command'
        )
            return;
        commandCalls++;
        const argument = node.arguments[0];
        assert.ok(ts.isArrayLiteralExpression(argument), 'Review new command declaration shape');
        const values = argument.elements.map((element) => {
            assert.ok(ts.isStringLiteral(element), 'Review nonliteral command declaration');
            return element.text;
        });
        assert.ok(values.length > 0);
        declarations.push({
            name: values[0].split(' ')[0],
            signature: values[0],
            aliases: values.slice(1),
            line: source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1,
        });
    }
    visit(source);
    assert.ok(commandCalls > 0, 'No CLI declarations discovered');
    return declarations;
}

test('catalog exactly covers installed command declarations, aliases, signatures, and source lines', () => {
    const installed = JSON.parse(fs.readFileSync(new URL('package.json', packageRoot), 'utf8'));
    assert.equal(
        installed.version,
        REVIEWED_MCDEV_VERSION,
        'Review the newly installed mcdev version'
    );
    assert.equal(REVIEWED_MCDEV_VERSION, '10.1.1');
    assert.deepEqual(
        listCommands().map((command) => ({
            name: command.name,
            signature: command.signature,
            aliases: [...command.aliases],
            line: command.sourceReferences[0].line,
        })),
        extractDeclarations(cliText)
    );
});

test('source-text extraction sees added, removed, and changed aliases without executing handlers', () => {
    const text = `yargs.command(['one <KEY>', 'o'], '', {}, () => { throw Error('never run'); })
        .command(['two'], '', {}, () => process.exit(99));`;
    const original = extractDeclarations(text);
    assert.deepEqual(
        original.map(({ name }) => name),
        ['one', 'two']
    );
    assert.notDeepEqual(extractDeclarations(text.replace("'o'", "'other'")), original);
    assert.notDeepEqual(extractDeclarations(text.replace("['two']", "['three']")), original);
    assert.notDeepEqual(extractDeclarations(text.split('\n')[0]), original);
    assert.throws(() => extractDeclarations('yargs.command(dynamicCommand)'), /declaration shape/);
});

test('every canonical name and alias resolves uniquely with immutable bounded execution coverage', () => {
    const names = new Set();
    assert.equal(listCommands().length, 31);
    assert.equal(listCommands().flatMap((command) => command.aliases).length, 26);
    assert.ok(Object.isFrozen(listCommands()));
    for (const command of listCommands()) {
        assert.equal(command.reviewedVersion, REVIEWED_MCDEV_VERSION);
        const native = NATIVE_RUNNER_COMMANDS.includes(command.name);
        assert.equal(command.execution.status, native ? 'partially-executable' : 'guidance-only');
        if (native) {
            assert.equal(command.execution.nativeRunner.tool, 'run_mcdev_command');
            assert.equal(command.execution.nativeRunner.availability, 'noninteractive-cases');
            assert.match(
                command.execution.nativeRunner.prerequisites,
                /Ordinary host approval.*explicit.*target/u
            );
            assert.match(
                command.execution.nativeRunner.blockedCases,
                /Prompt-dependent cases without explicit choices are blocked/u
            );
            assert.match(
                command.execution.nativeRunner.blockedCases,
                /do not promise every invocation/u
            );
            assert.ok(Object.isFrozen(command.execution.nativeRunner));
        } else {
            assert.equal(command.execution.nativeRunner, undefined);
        }
        assert.equal(command.sourceReferences[0].file, COMMAND_CATALOG_SOURCE);
        assert.equal(command.sourceReferences[0].package, 'mcdev');
        for (const name of [command.name, ...command.aliases]) {
            assert.ok(!names.has(name), `Duplicate command or alias: ${name}`);
            names.add(name);
            assert.equal(lookupCommand(name), command);
        }
        for (const object of [
            command,
            command.aliases,
            command.execution,
            command.sourceReferences,
            command.sourceReferences[0],
        ])
            assert.ok(Object.isFrozen(object));
        assert.throws(() => command.aliases.push('injected'), TypeError);
    }
});

test('native output availability identifies structured forms and blocked CLI results', () => {
    const execution = lookupCommand('resolveId').execution;
    assert.match(execution.nativeRunner.blockedCases, /resolveId BU asset ID --json/u);
    assert.match(
        lookupCommand('getFilesToCommit').execution.nativeRunner.blockedCases,
        /getFilesToCommit execution is blocked/u
    );
});

test('native support includes core seven and bounded noninteractive bonus commands', () => {
    assert.deepEqual(NATIVE_RUNNER_COMMANDS, [
        'retrieve',
        'deploy',
        'build',
        'buildTemplate',
        'buildDefinition',
        'buildDefinitionBulk',
        'clone',
        'explainTypes',
        'badKeys',
        'document',
        'resolveId',
        'getFilesToCommit',
    ]);
    assert.ok(Object.isFrozen(NATIVE_RUNNER_COMMANDS));
    for (const command of [
        'init',
        'join',
        'selectTypes',
        'execute',
        'publish',
        'delete',
        'createDeltaPkg',
    ]) {
        assert.equal(lookupCommand(command).execution.status, 'guidance-only');
    }
});

test('native retrieval has no compatibility fields and reviewed effects survive', () => {
    const retrieve = lookupCommand('retrieve');
    assert.equal(retrieve.execution.nativeRunner.tool, 'run_mcdev_command');
    assert.equal(retrieve.execution.supportedCases, undefined);
    assert.equal(retrieve.execution.restrictions, undefined);
    for (const name of [
        'build',
        'buildTemplate',
        'buildDefinition',
        'buildDefinitionBulk',
        'clone',
        'createDeltaPkg',
    ]) {
        const effects = lookupCommand(name).reviewedEffects;
        assert.equal(effects.status, 'partial-source-review');
        assert.ok(effects.sourceReferences.length > 0);
        assert.ok(Object.isFrozen(effects));
    }
    assert.match(
        lookupCommand('createDeltaPkg').execution.reason,
        /Only partial createDeltaPkg effects/u
    );
});

test('capability routes retain eight immutable records and route native workflows to the runner', () => {
    assert.deepEqual(
        CAPABILITY_ROUTES.map(({ intent, backend }) => [intent, backend]),
        [
            ['query-metadata-retrieve', 'mcdev'],
            ['script-metadata-retrieve', 'mcdev'],
            ['metadata-source-change', 'mcdev'],
            ['language-validation', 'sfmc-language'],
            ['sql-text-validation', 'vendor-mce'],
            ['data-extension-rows', 'vendor-mce'],
            ['transactional-definition', 'vendor-mce'],
            ['message-send', 'manual'],
        ]
    );
    assert.ok(Object.isFrozen(CAPABILITY_ROUTES));
    assert.throws(() => CAPABILITY_ROUTES.push({}), TypeError);
    for (const route of CAPABILITY_ROUTES) {
        assert.deepEqual(Object.keys(route), [
            'intent',
            'backend',
            'requiredCapability',
            'standaloneFallback',
        ]);
        assert.ok(Object.isFrozen(route));
        for (const value of Object.values(route)) assert.equal(typeof value, 'string');
        assert.throws(() => {
            route.backend = 'injected';
        }, TypeError);
    }
    for (const route of CAPABILITY_ROUTES.slice(0, 3)) {
        assert.match(route.requiredCapability, /run_mcdev_command/u);
        assert.doesNotMatch(route.requiredCapability, /guidance-only/u);
        assert.match(route.standaloneFallback, /without requiring companion MCPs/u);
    }
    assert.match(CAPABILITY_ROUTES[0].requiredCapability, /never SQL execution/u);
    assert.match(CAPABILITY_ROUTES[1].requiredCapability, /never SSJS or automation execution/u);
    assert.match(
        CAPABILITY_ROUTES[2].requiredCapability,
        /deploy requires explicit authorization/u
    );
    assert.match(
        CAPABILITY_ROUTES[3].standaloneFallback,
        /lookups\/validation unperformed.*stop only/u
    );
    assert.match(CAPABILITY_ROUTES[4].standaloneFallback, /SQL validation remains unperformed/u);
    assert.match(CAPABILITY_ROUTES[5].standaloneFallback, /No row read or write is performed/u);
    assert.match(CAPABILITY_ROUTES[6].standaloneFallback, /never substitute an actual send/u);
    assert.match(CAPABILITY_ROUTES[7].standaloneFallback, /unperformed.*authorizes a send/u);
});

test('lookup rejects unknown names, command lines, whitespace, and case variants', () => {
    for (const input of [
        '',
        'unknown',
        'retrieve BU',
        ' retrieve',
        'Retrieve',
        '--help',
        '; deploy',
    ])
        assert.equal(lookupCommand(input), undefined);
    assert.equal(lookupCommand('r'), lookupCommand('retrieve'));
    assert.equal(lookupCommand('resume'), lookupCommand('execute'));
    assert.notEqual(lookupCommand('stop'), lookupCommand('pause'));
});
