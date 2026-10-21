import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import {
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

test('every canonical name and alias resolves uniquely to an immutable guidance-only entry', () => {
    const names = new Set();
    assert.equal(listCommands().length, 31);
    assert.equal(listCommands().flatMap((command) => command.aliases).length, 26);
    assert.ok(Object.isFrozen(listCommands()));
    for (const command of listCommands()) {
        assert.equal(command.reviewedVersion, REVIEWED_MCDEV_VERSION);
        assert.equal(command.execution.status, 'guidance-only');
        if (command.name === 'createDeltaPkg') {
            assert.match(command.execution.reason, /Only partial createDeltaPkg effects/u);
        } else if (['build', 'buildTemplate', 'buildDefinition'].includes(command.name)) {
            assert.match(command.execution.reason, /Only partial build-family effects/u);
            assert.equal(command.reviewedEffects.status, 'partial-source-review');
        } else {
            assert.deepEqual(command.execution, {
                status: 'guidance-only',
                reason: 'Declaration inventory only. No execution adapter exists; effects, prerequisites, and interactive prompts have not been reviewed.',
            });
            assert.equal(command.reviewedEffects, undefined);
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
    assert.equal(lookupCommand('resume'), lookupCommand('execute'));
    assert.notEqual(lookupCommand('stop'), lookupCommand('pause'));
});
