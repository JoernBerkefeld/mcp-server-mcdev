import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { lookupCommand, NATIVE_RUNNER_COMMANDS } from '../dist/command-catalog.js';
import {
    CORE_ALLOWED_COMMANDS,
    SUPPORTED_NATIVE_COMMANDS,
    normalizeNativeCommandRun,
    validateNativeSharedSelection,
} from '../dist/native-command-contract.js';

import { preflight } from './native-temp-preflight.test.mjs';

const workspaceRoot = path.resolve('synthetic-project');
const request = (command, args, extra = {}) => ({ workspaceRoot, command, args, ...extra });
const compound = ['-m', 'query:key', '--bf', 'cred/source', '--bt', 'cred/target'];
const build = [...compound, '--mf', 'source', '--mt', 'target'];

test('core coverage uses canonical catalog names, excluding account commands and aliases', () => {
    assert.deepEqual(CORE_ALLOWED_COMMANDS, [
        'retrieve',
        'deploy',
        'build',
        'buildTemplate',
        'buildDefinition',
        'buildDefinitionBulk',
        'clone',
    ]);
    assert.ok(Object.isFrozen(CORE_ALLOWED_COMMANDS));
    for (const command of CORE_ALLOWED_COMMANDS) assert.equal(lookupCommand(command).name, command);
    for (const command of [
        'r',
        'bt',
        'bd',
        'bdb',
        'et',
        'doc',
        'rid',
        'fc',
        'init',
        'upgrade',
        'reloadBUs',
        'delete',
        'execute',
        'node',
        'Retrieve',
    ]) {
        assert.throws(() => normalizeNativeCommandRun(request(command, ['cred/bu'])), /canonical/);
    }
});

test('all seven native command families accept their explicit native inputs', () => {
    for (const [command, args] of [
        ['retrieve', ['cred/bu']],
        ['deploy', ['cred/bu', '-m', 'query:n:A name', '--execute']],
        ['build', [...build, '--no-purge']],
        ['clone', [...compound, '--purge']],
        ['buildTemplate', ['cred/bu', 'query', '123', '456']],
        ['buildDefinition', ['cred/bu', '--metadata=query:key', '--market', 'one', 'two']],
        ['buildDefinitionBulk', ['target-list', '--metadata', 'query:key']],
    ]) {
        const result = normalizeNativeCommandRun(request(command, args));
        assert.equal(result.command, command);
        assert.deepEqual(result.args, args);
        assert.ok(result.effects.length);
        assert.equal(result.catalogEntry, lookupCommand(command));
        assert.ok(!Object.hasOwn(result, 'timeoutMs'));
    }
});

test('supported command admission matches every catalog-advertised native runner', () => {
    assert.equal(SUPPORTED_NATIVE_COMMANDS, NATIVE_RUNNER_COMMANDS);
    assert.ok(Object.isFrozen(SUPPORTED_NATIVE_COMMANDS));
    assert.equal(SUPPORTED_NATIVE_COMMANDS.length, 12);
    for (const [command, args] of [
        ['explainTypes', []],
        ['explainTypes', ['--json']],
        ['badKeys', ['cred/bu']],
        ['document', ['--verbose', 'cred/bu', 'dataExtension']],
        ['resolveId', ['--json', 'cred/bu', 'asset', '007']],
        ['getFilesToCommit', ['cred/bu', 'asset', 'one,two:日本']],
    ]) {
        const result = normalizeNativeCommandRun(request(command, args));
        assert.equal(result.catalogEntry, lookupCommand(command));
        assert.equal(result.command, command);
        assert.deepEqual(result.args, args);
        assert.ok(Object.isFrozen(result.effects));
        assert.ok(result.effects.length);
    }
});

test('bonus and wildcard admission preserve installed native CLI dispatch without account access', () => {
    preflight();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-bonus-parity-'));
    fs.writeFileSync(path.join(root, '.owner'), randomUUID());
    // Deliberately retain the run-owned fixture; no recursive cleanup.
    const nativeRoot = new URL('../node_modules/mcdev/lib/', import.meta.url);
    const cases = [
        ['retrieve', ['*', 'query'], ['*', ['query'], null]],
        ['deploy', ['*', 'query'], ['*', ['query'], null]],
        ['retrieve', ['cred/*', 'query'], ['cred/*', ['query'], null]],
        ['deploy', ['cred/*', 'query'], ['cred/*', ['query'], null]],
        [
            'deploy',
            ['--fixShared=ChildA,ChildB', 'cred/bu', 'dataExtension'],
            ['cred/bu', ['dataExtension'], null],
        ],
        ['explainTypes', ['--json'], []],
        ['badKeys', ['cred/bu'], ['cred/bu']],
        ['document', ['cred/bu', 'dataExtension'], ['cred/bu', 'dataExtension']],
        ['resolveId', ['--json', 'cred/bu', 'asset', '007'], ['cred/bu', 'asset', '007']],
        ['getFilesToCommit', ['cred/bu', 'asset', 'one,two'], ['cred/bu', 'asset', ['one', 'two']]],
    ];
    for (const [command, args, expected] of cases) {
        const admitted = normalizeNativeCommandRun(request(command, args));
        const output = path.join(root, `${command}.json`);
        const script = `
            import fs from 'node:fs';
            import net from 'node:net';
            import { syncBuiltinESMExports } from 'node:module';
            const deny = () => { throw Error('Account/network access forbidden'); };
            net.Socket.prototype.connect = deny;
            globalThis.fetch = deny;
            syncBuiltinESMExports();
            const { default: Mcdev } = await import(${JSON.stringify(new URL('index.js', nativeRoot).href)});
            for (const file of ['util/auth.js', 'util/config.js']) {
                const { default: boundary } = await import(new URL(file, ${JSON.stringify(nativeRoot.href)}));
                for (const key of Object.keys(boundary)) {
                    if (typeof boundary[key] === 'function') boundary[key] = deny;
                }
            }
            const { Util } = await import(new URL('util/util.js', ${JSON.stringify(nativeRoot.href)}));
            if (${JSON.stringify(admitted.nativeChoices ?? null)}) Mcdev.setOptions({ ...${JSON.stringify(admitted.nativeChoices ?? {})}, skipInteraction: true });
            const setOptions = Mcdev.setOptions.bind(Mcdev);
            Mcdev.setOptions = (argv) => {
                setOptions(argv);
                if (${JSON.stringify(admitted.nativeChoices ?? null)}) {
                    if (Util.OPTIONS.fixShared !== ${JSON.stringify(admitted.nativeChoices?.fixShared)} || Util.skipInteraction !== true) throw Error('Native seed overwritten');
                }
            };
            Mcdev[${JSON.stringify(command)}] = (...args) => fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(args));
            process.argv = [process.execPath, ${JSON.stringify(new URL('cli.js', nativeRoot).pathname)}, ...${JSON.stringify([command, ...admitted.nativeArgs])}];
            await import(${JSON.stringify(new URL('cli.js', nativeRoot).href)});
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            env: {
                ...process.env,
                HOME: root,
                USERPROFILE: root,
                APPDATA: root,
                LOCALAPPDATA: root,
            },
            encoding: 'utf8',
            timeout: 20000,
            shell: false,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), expected);
    }
});

test('every installed native boolean and alias preserves prerequisites before BU/selectors', (t) => {
    const mcdevRequire = createRequire(createRequire(import.meta.url).resolve('mcdev'));
    const yargsRequire = createRequire(mcdevRequire.resolve('yargs'));
    const yargs = yargsRequire('yargs');
    const commands = new Map();
    const globals = {};
    const chain = new Proxy(
        {},
        {
            get: (_, key) => {
                if (key === 'argv') return {};
                if (key === 'terminalWidth') return () => 80;
                return (...args) => {
                    if (key === 'command') {
                        const [names, , builder] = args;
                        commands.set(names[0].split(' ')[0], { names, builder });
                    }
                    if (key === 'option') globals[args[0]] = args[1];
                    return chain;
                };
            },
        }
    );
    // Execute only registration against a recorder, not the CLI runtime or its handlers.
    const source = fs
        .readFileSync(path.join(path.dirname(mcdevRequire.resolve('mcdev')), 'cli.js'), 'utf8')
        .replace(/^#!.*\n/u, '')
        .replaceAll(/^import .*;$/gmu, '');
    vm.runInNewContext(source, {
        yargs: () => chain,
        hideBin: () => [],
        process: { argv: [] },
        Util: { packageJsonMcdev: { version: '0.0.0' } },
        Mcdev: {},
    });
    let checked = 0;
    for (const command of SUPPORTED_NATIVE_COMMANDS) {
        const { names, builder } = commands.get(command);
        const options = { ...globals };
        const recorder = {
            positional: () => recorder,
            option: (name, declaration) => {
                options[name] = declaration;
                return recorder;
            },
            check: () => recorder,
        };
        builder(recorder);
        const base =
            command === 'build'
                ? [...build, '--no-purge']
                : command === 'clone'
                  ? [...compound, '--no-purge']
                  : command === 'explainTypes'
                    ? []
                    : command === 'buildDefinitionBulk'
                      ? ['target-list', 'query', '007']
                      : ['cred/bu', 'query', '007', 'market'];
        for (const [name, declaration] of Object.entries(options)) {
            if (declaration.type !== 'boolean') continue;
            for (const alias of [name, ...[declaration.alias ?? []].flat()]) {
                const flag = `--${alias}`;
                const args = [flag, ...base];
                let native;
                yargs([command, ...args])
                    .exitProcess(false)
                    .help(false)
                    .version(false)
                    .options(globals)
                    .command(names, '', builder, (argv) => {
                        native = argv;
                    })
                    .parseSync();
                assert.equal(native[name], true, `${command} ${flag}`);
                if (!['build', 'clone', 'explainTypes'].includes(command)) {
                    assert.equal(native.BU ?? native.LISTNAME, base[0], `${command} ${flag}`);
                }
                if (command === 'deploy' && name === 'fixShared') {
                    assert.throws(
                        () => normalizeNativeCommandRun(request(command, args)),
                        /child-BU selection/
                    );
                } else {
                    assert.deepEqual(normalizeNativeCommandRun(request(command, args)).args, args);
                }
                checked++;
            }
        }
    }
    assert.ok(checked > 100, `Only checked ${checked} boolean spellings`);
    t.diagnostic(`Verified ${checked} installed boolean/alias spellings across 12 commands`);
});

test('native scalar string options and aliases do not consume positional prerequisites', () => {
    for (const [command, names] of [
        ['retrieve', ['like']],
        ['deploy', ['keySuffix', 'ks', 'changeKeyField', 'ckf', 'changeKeyValue', 'ckv']],
    ]) {
        for (const name of names) {
            const args = [`--${name}`, '007', 'cred/bu', 'query', '007'];
            assert.deepEqual(normalizeNativeCommandRun(request(command, args)).args, args);
            assert.throws(
                () => normalizeNativeCommandRun(request(command, [`--${name}`, 'cred/bu'])),
                /explicit/
            );
        }
    }
});

test('bonus command prompt prerequisites are explicit without restricting native selectors', () => {
    for (const command of ['badKeys', 'document', 'resolveId', 'getFilesToCommit']) {
        for (const selector of [undefined, '', 'cred', 'cred/']) {
            const args = selector === undefined ? [] : [selector];
            assert.throws(() => normalizeNativeCommandRun(request(command, args)), /explicit/);
        }
    }
    for (const command of ['document', 'resolveId', 'getFilesToCommit']) {
        assert.throws(
            () => normalizeNativeCommandRun(request(command, ['cred/bu'])),
            /metadata type/
        );
    }
    for (const command of ['resolveId', 'getFilesToCommit']) {
        assert.throws(
            () => normalizeNativeCommandRun(request(command, ['cred/bu', 'asset'])),
            /metadata (ID|key)/
        );
        assert.doesNotThrow(() =>
            normalizeNativeCommandRun(request(command, ['cred/bu', 'future-type', '123']))
        );
    }
});

test('retrieve and deploy preserve native all-credential and per-credential wildcards', () => {
    for (const command of ['retrieve', 'deploy']) {
        for (const selector of ['*', 'cred/*', 'cred/bu']) {
            const args = ['--verbose', selector, '-m', 'query'];
            assert.deepEqual(normalizeNativeCommandRun(request(command, args)).args, args);
        }
    }
    assert.throws(() => normalizeNativeCommandRun(request('badKeys', ['*'])), /credential\/BU/);
});

test('deploy fixShared boolean choices match native parsing and block child-BU prompts', () => {
    const mcdevRequire = createRequire(createRequire(import.meta.url).resolve('mcdev'));
    const yargsRequire = createRequire(mcdevRequire.resolve('yargs'));
    const yargs = yargsRequire('yargs');
    for (const [choice, expected] of [
        ['--fixShared', true],
        ['--fixShared=true', true],
        ['--no-fixShared', false],
        ['--fixShared=false', false],
    ]) {
        const args = [choice, 'cred/bu', '-m', 'dataExtension'];
        const parsed = yargs(args)
            .exitProcess(false)
            .help(false)
            .version(false)
            .option('fixShared', { type: 'boolean' })
            .parseSync();
        assert.equal(parsed.fixShared, expected);
        assert.equal(parsed._[0], 'cred/bu');
        if (expected) {
            assert.throws(
                () => normalizeNativeCommandRun(request('deploy', args)),
                /child-BU selection/
            );
        } else {
            assert.deepEqual(normalizeNativeCommandRun(request('deploy', args)).args, args);
        }
    }
    assert.throws(
        () =>
            normalizeNativeCommandRun(
                request('deploy', ['cred/bu', '--fixShared', '--skipInteraction'])
            ),
        /child-BU selection/
    );
});

test('explicit shared-child choices bridge only their own tokens and preserve original argv', () => {
    for (const choice of [
        ['--fixShared=ChildA,ChildB'],
        ['--fixShared', 'ChildA,ChildB'],
        ['--fixShared=*'],
    ]) {
        const args = [...choice, 'cred/bu', 'dataExtension', '007', '--future=value'];
        const run = normalizeNativeCommandRun(request('deploy', args));
        assert.deepEqual(run.args, args);
        assert.deepEqual(run.nativeArgs, args.slice(choice.length));
        assert.equal(
            run.nativeChoices.fixShared,
            choice.length === 2 ? choice[1] : choice[0].split('=')[1]
        );
        assert.ok(Object.isFrozen(run.nativeArgs));
        assert.ok(Object.isFrozen(run.nativeChoices));
    }
    for (const command of ['deploy', 'retrieve']) {
        const args = ['cred/bu', '--', '--fixShared=ChildA'];
        const run = normalizeNativeCommandRun(request(command, args));
        assert.deepEqual(run.nativeArgs, args);
        assert.equal(run.nativeChoices, undefined);
    }
    for (const suffix of [
        ['--fixShared'],
        ['--fixShared='],
        ['--fixShared=true'],
        ['--fixShared', 'true'],
        ['--fixShared=ChildA,,ChildB'],
        ['--fixShared=ChildA,'],
        ['--fixShared=*,ChildA'],
        ['--fixShared.child=ChildA'],
        ['--fix-shared=ChildA'],
        ['--fixShared=ChildA', '--fixShared=ChildA'],
        ['--fixShared=ChildA', '--no-fixShared'],
        ['--fixShared=ChildA', '--no-skipInteraction'],
        ['--fixShared=ChildA', '--no-yes'],
        ['--fixShared=ChildA', '--skipInteraction=false'],
        ['--fixShared=ChildA', '--yes=false'],
    ]) {
        assert.throws(
            () => normalizeNativeCommandRun(request('deploy', ['cred/bu', ...suffix])),
            /shared|child|skipInteraction/iu
        );
    }
    const negative = ['--no-fixShared', 'cred/bu'];
    assert.deepEqual(normalizeNativeCommandRun(request('deploy', negative)).nativeArgs, negative);
});

test('shared-child selection validates every targeted credential and excludes native parent BU', () => {
    const config = {
        credentials: {
            first: { businessUnits: { _ParentBU_: 1, ChildA: 2, ChildB: 3 } },
            second: { businessUnits: { _ParentBU_: 4, ChildA: 5 } },
            empty: { businessUnits: { _ParentBU_: 6 } },
        },
    };
    assert.doesNotThrow(() => validateNativeSharedSelection('ChildA', ['first', 'second'], config));
    assert.doesNotThrow(() => validateNativeSharedSelection('ChildA, ChildB', ['first'], config));
    assert.doesNotThrow(() => validateNativeSharedSelection('*', ['first', 'second'], config));
    for (const [selection, credentials, value] of [
        ['ChildA,ChildB', ['first', 'second'], config],
        ['_ParentBU_', ['first'], config],
        ['*', ['empty'], config],
        ['ChildA', ['missing'], config],
        ['ChildA', [], config],
        ['', ['first'], config],
        ['ChildA,', ['first'], config],
        ['*,ChildA', ['first'], config],
        ['ChildA', ['first'], null],
    ])
        assert.throws(
            () => validateNativeSharedSelection(selection, credentials, value),
            /selection|credentials/
        );
});

test('argv is frozen and copied, never split, trimmed, escaped or metadata-restricted', () => {
    const args = [
        'cred/*',
        '--metadata',
        'asset-message:n:Hello world',
        'query:i:42',
        '--like=%sale_',
        '--api',
        'log',
        '--future-option=a&b;$(value)',
        '',
        '--',
        'literal',
    ];
    const result = normalizeNativeCommandRun(request('retrieve', args, { timeoutMs: 600000 }));
    assert.deepEqual(result.args, args);
    assert.notEqual(result.args, args);
    assert.equal(result.timeoutMs, 600000);
    assert.equal(result.workspaceRoot, workspaceRoot);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.args));
    assert.ok(Object.isFrozen(result.effects));
    args[0] = 'changed';
    assert.equal(result.args[0], 'cred/*');
});

test('native yargs oracle confirms multi-character aliases and purge boolean semantics', () => {
    const mcdevRequire = createRequire(createRequire(import.meta.url).resolve('mcdev'));
    const yargsRequire = createRequire(mcdevRequire.resolve('yargs'));
    const yargs = yargsRequire('yargs');
    const parse = (args) =>
        yargs(args)
            .exitProcess(false)
            .help(false)
            .version(false)
            .option('metadata', { type: 'string', array: true, alias: 'm' })
            .option('buFrom', { type: 'string', alias: 'bf' })
            .option('buTo', { type: 'string', alias: 'bt' })
            .option('purge', {})
            .parseSync();
    assert.equal(parse([...compound, '--no-purge']).buFrom, 'cred/source');
    assert.equal(parse([...compound, '--purge']).purge, true);
    assert.equal(parse([...compound, '--no-purge']).purge, false);
    assert.equal(parse([...compound, '--purge=true']).purge, 'true');
    assert.equal(parse(['-bf', 'cred/source']).buFrom, undefined);
});

test('BU omission and credential-only values cannot enter native BU-selection prompts', () => {
    for (const command of ['retrieve', 'deploy', 'buildTemplate', 'buildDefinition']) {
        for (const args of [[], ['cred'], ['cred/'], ['--metadata', 'query:key']]) {
            assert.throws(() => normalizeNativeCommandRun(request(command, args)), /explicit/);
        }
    }
    assert.throws(
        () => normalizeNativeCommandRun(request('buildDefinitionBulk', [])),
        /market list/
    );
    assert.throws(
        () =>
            normalizeNativeCommandRun(
                request('clone', ['-m', 'query:key', '--bf', 'cred', '--bt', 'cred/bu', '--purge'])
            ),
        /credential\/BU/
    );
});

test('compound prerequisites require every native mandatory option and boolean purge', () => {
    for (const flag of ['-m', '--bf', '--bt', '--mf', '--mt']) {
        const args = [...build, '--no-purge'];
        args.splice(args.indexOf(flag), 2);
        assert.throws(() => normalizeNativeCommandRun(request('build', args)), /explicit/);
    }
    for (const [command, args] of [
        ['build', build],
        ['clone', compound],
    ]) {
        for (const suffix of [[], ['--purge=true'], ['--purge=false'], ['--purge', 'true']]) {
            assert.throws(
                () => normalizeNativeCommandRun(request(command, [...args, ...suffix])),
                /boolean purge choice/
            );
        }
        for (const choice of ['--purge', '--no-purge']) {
            assert.doesNotThrow(() =>
                normalizeNativeCommandRun(request(command, [...args, choice]))
            );
        }
    }
});

test('bulk builds take a target market list without a target BU; clone still needs a target BU', () => {
    const args = [
        '--metadata=query:key',
        '--buFrom=cred/bu',
        '--marketFrom=source',
        '--marketTo=targets',
        '--bulk',
        '--no-purge',
    ];
    assert.deepEqual(normalizeNativeCommandRun(request('build', args)).args, args);
    assert.throws(
        () => normalizeNativeCommandRun(request('build', [...args, '--no-bulk'])),
        /target BU/
    );
    assert.throws(
        () =>
            normalizeNativeCommandRun(
                request('clone', ['-m', 'query:key', '--bf', 'cred/bu', '--bulk', '--no-purge'])
            ),
        /target BU/
    );
});

test('native arrays, option placement and single-stage markets are not narrowed', () => {
    const args = [
        '--verbose',
        '--no-format',
        'cred/bu',
        '--metadata=query:key',
        '-m',
        'asset:n:Name with spaces',
        '-m',
        'email:i:123',
    ];
    assert.deepEqual(normalizeNativeCommandRun(request('retrieve', args)).args, args);
    const buildArgs = [
        '-m',
        'query:key',
        '--metadata',
        'asset:n:name',
        '--buFrom=cred/bu',
        '--bt=cred/dest',
        '--marketFrom',
        'one',
        'two',
        '--mt=three',
        '--no-purge',
    ];
    assert.deepEqual(normalizeNativeCommandRun(request('build', buildArgs)).args, buildArgs);
    for (const command of ['buildTemplate', 'buildDefinition']) {
        assert.throws(
            () => normalizeNativeCommandRun(request(command, ['cred/bu', '-m', 'query:key'])),
            /market/
        );
        assert.doesNotThrow(() =>
            normalizeNativeCommandRun(
                request(command, ['cred/bu', '-m', 'query:key', '--market', '__clone__'])
            )
        );
    }
});

test('strict run envelope rejects runtime overrides, accessors, invalid arrays, paths and timeouts', () => {
    for (const extra of [
        { shell: true },
        { executable: 'other' },
        { env: {} },
        { cwd: workspaceRoot },
        { commandLine: 'mcdev retrieve' },
    ]) {
        assert.throws(
            () => normalizeNativeCommandRun(request('retrieve', ['cred/bu'], extra)),
            /Expected only/
        );
    }
    for (const input of [
        null,
        [],
        'retrieve',
        {
            ...request('retrieve', []),
            get args() {
                throw new Error('getter executed');
            },
        },
    ]) {
        assert.throws(() => normalizeNativeCommandRun(input), /Expected only/);
    }
    for (const args of [
        'cred/bu',
        [null],
        [42],
        ['cred/bu', 'bad\0arg'],
        Array.from({ length: 1 }),
    ]) {
        assert.throws(() => normalizeNativeCommandRun(request('retrieve', args)), /args/);
    }
    for (const root of ['', 'relative', 'F:', `${workspaceRoot}\0`]) {
        assert.throws(
            () =>
                normalizeNativeCommandRun({
                    ...request('retrieve', ['cred/bu']),
                    workspaceRoot: root,
                }),
            /workspaceRoot/
        );
    }
    for (const timeoutMs of [
        0,
        -1,
        1.5,
        Number.NaN,
        Infinity,
        '100',
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        assert.throws(
            () => normalizeNativeCommandRun(request('retrieve', ['cred/bu'], { timeoutMs })),
            /timeoutMs/
        );
    }
});
