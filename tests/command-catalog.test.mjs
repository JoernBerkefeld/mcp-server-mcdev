import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import {
    CAPABILITY_ROUTES,
    COMMAND_CATALOG_SOURCE,
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
        ) {
            return;
        }
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
    assert.equal(REVIEWED_MCDEV_VERSION, '10.1.0');
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
        assert.equal(
            command.execution.status,
            command.name === 'retrieve' ? 'partially-executable' : 'guidance-only'
        );
        switch (command.name) {
            case 'retrieve': {
                assert.deepEqual(command.execution.supportedCases, [
                    { metadataType: 'query', tool: 'retrieve_mcdev_query' },
                    { metadataType: 'script', tool: 'retrieve_mcdev_script' },
                ]);
                assert.match(
                    command.execution.reason,
                    /full native retrieve signature is not executable/u
                );
                assert.match(
                    command.execution.restrictions,
                    /Windows and installed mcdev 10\.1\.0 only/u
                );
                assert.match(
                    command.execution.restrictions,
                    /exactly workspaceRoot, credential, businessUnit and key/u
                );
                assert.match(command.execution.restrictions, /one literal external key/u);
                assert.match(
                    command.execution.restrictions,
                    /no arbitrary type, argv, flags or broad selectors/u
                );
                assert.match(
                    command.execution.remainingGuidanceOnlyScope,
                    /All other metadata types/u
                );
                assert.match(
                    command.execution.remainingGuidanceOnlyScope,
                    /whole-type, whole-BU, wildcard, name\/ID and fallback/u
                );
                assert.ok(Object.isFrozen(command.execution.supportedCases));
                for (const supported of command.execution.supportedCases) {
                    assert.ok(Object.isFrozen(supported));
                }
                assert.equal(command.reviewedEffects, undefined);

                break;
            }
            case 'createDeltaPkg': {
                assert.match(command.execution.reason, /Only partial createDeltaPkg effects/u);

                break;
            }
            case 'clone': {
                assert.match(command.execution.reason, /Only partial clone effects/u);
                assert.equal(command.reviewedEffects.status, 'partial-source-review');

                break;
            }
            default: {
                if (
                    ['build', 'buildTemplate', 'buildDefinition', 'buildDefinitionBulk'].includes(
                        command.name
                    )
                ) {
                    assert.match(command.execution.reason, /Only partial build-family effects/u);
                    assert.equal(command.reviewedEffects.status, 'partial-source-review');
                } else {
                    assert.deepEqual(command.execution, {
                        status: 'guidance-only',
                        reason: 'Declaration inventory only. No execution adapter exists; effects, prerequisites, and interactive prompts have not been reviewed.',
                    });
                    assert.equal(command.reviewedEffects, undefined);
                }
            }
        }
        assert.equal(command.sourceReferences[0].file, COMMAND_CATALOG_SOURCE);
        assert.equal(command.sourceReferences[0].package, 'mcdev');
        for (const name of [command.name, ...command.aliases]) {
            assert.ok(!names.has(name), `Duplicate command or alias: ${name}`);
            names.add(name);
            assert.equal(lookupCommand(name), command);
        }
        assert.ok(Object.isFrozen(command));
        assert.ok(Object.isFrozen(command.aliases));
        assert.ok(Object.isFrozen(command.execution));
        assert.ok(Object.isFrozen(command.sourceReferences));
        assert.ok(Object.isFrozen(command.sourceReferences[0]));
        assert.throws(() => {
            command.aliases.push('injected');
        }, TypeError);
    }
});

test('capability routes have exactly eight ordered immutable descriptive records', () => {
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
    assert.equal(new Set(CAPABILITY_ROUTES.map(({ intent }) => intent)).size, 8);
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
        assert.ok(route.requiredCapability.length > 0);
        assert.ok(route.standaloneFallback.length > 0);
        assert.throws(() => {
            route.backend = 'injected';
        }, TypeError);
        assert.throws(() => {
            route.standaloneFallback = 'injected';
        }, TypeError);
    }
});

test('each route retains its bounded capability and honest standalone limitation', () => {
    const expectations = [
        [/retrieve_mcdev_query.*never SQL execution/u, /retrieval unperformed.*No broad fallback/u],
        [
            /retrieve_mcdev_script.*never SSJS or automation execution/u,
            /retrieval unperformed.*No broad fallback/u,
        ],
        [
            /Prefer local-source changes.*build\/deploy remain guidance-only/u,
            /unperformed build\/deploy.*No synchronization claim/u,
        ],
        [
            /platform detection.*lookups.*full-document.*polyfills/u,
            /lookups\/validation unperformed.*stop only/u,
        ],
        [
            /Optional host-discovered SQL-text validation.*candidate, not an established check/u,
            /SQL validation remains unperformed/u,
        ],
        [
            /requested read or write.*DE schema metadata retrieval is not row access/u,
            /No row read or write is performed/u,
        ],
        [
            /definition.*not sending a message/u,
            /never substitute an actual send.*local synchronization/u,
        ],
        [
            /Manual\/unsupported unless.*actual-send.*authorization/u,
            /unsupported here.*unperformed.*authorizes a send/u,
        ],
    ];
    for (const [index, route] of CAPABILITY_ROUTES.entries()) {
        assert.match(route.requiredCapability, expectations[index][0]);
        assert.match(route.standaloneFallback, expectations[index][1]);
    }
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
    ]) {
        assert.equal(lookupCommand(input), undefined);
    }
    assert.equal(lookupCommand('r'), lookupCommand('retrieve'));
    assert.equal(lookupCommand('resume'), lookupCommand('execute'));
    assert.notEqual(lookupCommand('stop'), lookupCommand('pause'));
});
