import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { preflight } from './native-temp-preflight.test.mjs';

// This machine's temp policy is checked independently of production code under test.
preflight();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-native-cli-parity-'));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
const nativeRoot = new URL('../node_modules/mcdev/lib/', import.meta.url);
const runner = path.join(root, 'runner.mjs');
const methods = [
    'retrieve',
    'deploy',
    'build',
    'buildTemplate',
    'buildDefinition',
    'buildDefinitionBulk',
    'clone',
];
// No cleanup: each fixture and its ownership marker are deliberately retained.
fs.writeFileSync(
    runner,
    `
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Native account/network operation forbidden'); };
net.Socket.prototype.connect = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();
const { default: Mcdev } = await import(${JSON.stringify(new URL('index.js', nativeRoot).href)});
const { default: auth } = await import(${JSON.stringify(new URL('util/auth.js', nativeRoot).href)});
const { default: config } = await import(${JSON.stringify(new URL('util/config.js', nativeRoot).href)});
for (const boundary of [auth, config]) {
    for (const key of Object.keys(boundary)) {
        if (typeof boundary[key] === 'function') boundary[key] = denied;
    }
}
const events = [];
Mcdev.setOptions = (options) => events.push({ method: 'setOptions', options });
for (const method of ${JSON.stringify(methods)}) {
    Mcdev[method] = (...args) => events.push({ method, args });
}
process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(new URL('cli.js', nativeRoot)))}, ...JSON.parse(process.env.PARITY_ARGS)];
process.on('exit', () => fs.writeFileSync('observed.json', JSON.stringify(events)));
await import(${JSON.stringify(new URL('cli.js', nativeRoot).href)});
`
);

function run(args) {
    preflight();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-native-case-'));
    fs.writeFileSync(path.join(cwd, '.owner'), randomUUID());
    const env = {};
    for (const name of [
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'PATH',
        'PATHEXT',
        'TEMP',
        'TMP',
        'TMPDIR',
    ]) {
        if (process.env[name]) env[name] = process.env[name];
    }
    Object.assign(env, {
        HOME: cwd,
        USERPROFILE: cwd,
        APPDATA: cwd,
        LOCALAPPDATA: cwd,
        NO_COLOR: '1',
        PARITY_ARGS: JSON.stringify(args),
    });
    const result = spawnSync(process.execPath, [runner], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 20000,
        shell: false,
        maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    const observed = path.join(cwd, 'observed.json');
    return {
        ...result,
        events: fs.existsSync(observed) ? JSON.parse(fs.readFileSync(observed, 'utf8')) : [],
    };
}

function dispatch(args, method, expectedArgs, expectedOptions = {}) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events.length, 2, JSON.stringify(result.events));
    assert.equal(result.events[0].method, 'setOptions');
    assert.deepEqual(result.events[1], { method, args: expectedArgs });
    for (const [name, value] of Object.entries(expectedOptions)) {
        assert.deepEqual(result.events[0].options[name], value, name);
    }
    return result.events[0].options;
}

const bu = 'Ünicode credential/QA 日本';
const selectors = [
    'query:k:Köln:part',
    'query:i:007',
    'asset:n:日本:welcome',
    'script',
    'query:plain',
];
const converted = {
    query: ['Köln:part', 'id:007', 'plain'],
    asset: ['name:日本:welcome'],
    script: null,
};
const globals = [
    '--verbose',
    '--debug',
    '--silent',
    '--noLogColors',
    '--noLogFile',
    '--skipInteraction',
    '--api',
    'cli',
    '--errorLog',
];
const globalOptions = {
    verbose: true,
    debug: true,
    silent: true,
    noLogColors: true,
    noLogFile: true,
    skipInteraction: true,
    api: 'cli',
    errorLog: true,
};
const optionSets = {
    retrieve: ['skipValidation', 'fix', 'format', 'purge', 'onlyPublished'],
    deploy: [
        'autoMidSuffix',
        'fromRetrieve',
        'refresh',
        'execute',
        'schedule',
        'fixShared',
        'noUpdate',
        'publish',
        'validate',
        'skipStatusCheck',
        'matchName',
        'skipValidation',
        'format',
        'ignoreFolder',
        'ignoreSfFields',
        'fix',
    ],
    build: ['bulk', 'dependencies', 'retrieve', 'skipValidation', 'purge', 'fix', 'shareAsset'],
    buildTemplate: ['dependencies', 'retrieve', 'shareAsset'],
    buildDefinition: ['skipValidation', 'purge', 'fix'],
    buildDefinitionBulk: ['skipValidation', 'purge', 'fix'],
    clone: ['dependencies', 'retrieve', 'skipValidation', 'purge'],
};
function invocation(command) {
    switch (command) {
        case 'retrieve':
        case 'deploy': {
            return [command, bu];
        }
        case 'build': {
            return [
                command,
                '--buFrom',
                bu,
                '--buTo',
                'other/*',
                '--marketFrom',
                'source market',
                '--marketTo',
                'target market',
            ];
        }
        case 'clone': {
            return [command, '--buFrom', bu, '--buTo', 'other/*'];
        }
        case 'buildTemplate':
        case 'buildDefinition': {
            return [command, bu, '--market', '日本 market'];
        }
        case 'buildDefinitionBulk': {
            return [command, 'list 日本'];
        }
        default: {
            throw new Error(command);
        }
    }
}
function expected(command, bulk) {
    switch (command) {
        case 'retrieve':
        case 'deploy': {
            return [bu, converted];
        }
        case 'build': {
            return [bu, 'other/*', converted, ['source market'], ['target market'], bulk];
        }
        case 'clone': {
            return [bu, 'other/*', converted];
        }
        case 'buildTemplate':
        case 'buildDefinition': {
            return [bu, converted, null, ['日本 market']];
        }
        case 'buildDefinitionBulk': {
            return ['list 日本', converted];
        }
        default: {
            throw new Error(command);
        }
    }
}

for (const command of methods) {
    test(`native ${command}: every command/global option reaches dispatch with real selector conversion`, () => {
        const extra =
            command === 'retrieve'
                ? ['--like', '%日本_']
                : command === 'deploy'
                  ? [
                        '--keySuffix',
                        ':suffix',
                        '--changeKeyField',
                        'c__newKey',
                        '--changeKeyValue',
                        'new:日本',
                    ]
                  : [];
        const options = Object.fromEntries(optionSets[command].map((name) => [name, true]));
        if (command === 'retrieve') options.like = '%日本_';
        if (command === 'deploy')
            Object.assign(options, {
                keySuffix: ':suffix',
                changeKeyField: 'c__newKey',
                changeKeyValue: 'new:日本',
            });
        dispatch(
            [
                ...invocation(command),
                '--metadata',
                ...selectors,
                ...optionSets[command].map((name) => `--${name}`),
                ...extra,
                ...globals,
            ],
            command,
            expected(command, true),
            { ...options, ...globalOptions, metadata: selectors }
        );
    });
    test(`native ${command}: explicit --no-option retains false rather than dropping it`, () => {
        const options = Object.fromEntries(optionSets[command].map((name) => [name, false]));
        dispatch(
            [
                ...invocation(command),
                '-m',
                ...selectors,
                ...optionSets[command].map((name) => `--no-${name}`),
            ],
            command,
            expected(command, false),
            options
        );
    });
}

test('installed 10.1.1 parser preserves joined, separate, wildcard and negative shared choices', () => {
    for (const [choice, expectedChoice] of [
        [['--fixShared=ChildA,ChildB'], 'ChildA,ChildB'],
        [['--fixShared', 'ChildA,ChildB'], 'ChildA,ChildB'],
        [['--fixShared=*'], '*'],
        [['--fixShared', '*'], '*'],
        [['--no-fixShared'], false],
        [['--fixShared=false'], 'false'],
    ]) {
        dispatch(
            ['deploy', '--skipInteraction=true', ...choice, bu, 'dataExtension', 'key'],
            'deploy',
            [bu, ['dataExtension'], ['key']],
            { fixShared: expectedChoice, skipInteraction: 'true' }
        );
    }
});

for (const [alias, command] of [
    ['r', 'retrieve'],
    ['d', 'deploy'],
    ['bt', 'buildTemplate'],
    ['bd', 'buildDefinition'],
    ['bdb', 'buildDefinitionBulk'],
]) {
    test(`native ${alias}: positional CSV, whitespace, colon, wildcard and Unicode survive`, () => {
        const templating = command.startsWith('build');
        const args = [alias, bu, templating ? 'query' : 'query, script,', ' Köln:part, 日本*, ,'];
        if (command !== 'buildDefinitionBulk' && templating) args.push('market 日本');
        const expectedArgs =
            command === 'buildDefinitionBulk'
                ? [bu, 'query', ['Köln:part', '日本*']]
                : templating
                  ? [bu, 'query', ['Köln:part', '日本*'], ['market 日本']]
                  : [bu, ['query', 'script'], ['Köln:part', '日本*']];
        dispatch(args, command, expectedArgs);
    });
}

test('native retrieve/deploy preserve omitted positionals and wildcard BU without expanding them', () => {
    for (const command of ['retrieve', 'deploy']) {
        dispatch([command], command, [null, null, null]);
        dispatch([command, 'credential/*', 'query', '*'], command, [
            'credential/*',
            ['query'],
            ['*'],
        ]);
    }
});

test('native repeated metadata merges aliases; explicit identifiers and colon keys retain native meanings', () => {
    dispatch(
        [
            'retrieve',
            bu,
            '-m',
            'query:key:a:b',
            '--metadata',
            'query:k:日本',
            '-m',
            'asset:id:123',
            '--metadata',
            'asset:name:welcome:one',
            '-m',
            'dataExtensionField:de:field',
        ],
        'retrieve',
        [
            bu,
            {
                query: ['a:b', '日本'],
                asset: ['id:123', 'name:welcome:one'],
                dataExtensionField: ['de:field'],
            },
        ],
        {
            metadata: [
                'query:key:a:b',
                'query:k:日本',
                'asset:id:123',
                'asset:name:welcome:one',
                'dataExtensionField:de:field',
            ],
        }
    );
});

test('native repeated scalars, dotted interaction flags and typed/untyped false match yargs behavior', () => {
    dispatch(
        [
            'deploy',
            bu,
            'query',
            'key',
            '--ks',
            'one',
            '--keySuffix',
            'two',
            '--execute=false',
            '--skipInteraction.deploy',
            'false',
            '--skipInteraction.purge',
            'true',
            '--api',
            'log',
        ],
        'deploy',
        [bu, ['query'], ['key']],
        {
            keySuffix: ['one', 'two'],
            execute: false,
            skipInteraction: { deploy: 'false', purge: 'true' },
            api: 'log',
        }
    );
    dispatch(
        [
            ...invocation('build'),
            '-m',
            ...selectors,
            '--skipValidation=false',
            '--fix=false',
            '--purge=false',
            '--bulk=false',
        ],
        'build',
        expected('build', false),
        { skipValidation: 'false', fix: 'false', purge: false, bulk: false }
    );
});

test('native command option aliases are expanded before dispatch', () => {
    dispatch(
        ['retrieve', bu, '-m', 'query:key', '--sv', '--op', '-f'],
        'retrieve',
        [bu, { query: ['key'] }],
        { skipValidation: true, onlyPublished: true, format: true }
    );
    dispatch(
        [
            'deploy',
            bu,
            '-m',
            'query:key',
            '--ks',
            'suffix',
            '--ckf',
            'name',
            '--ckv',
            'new',
            '--fr',
            '-r',
            '-e',
            '-s',
            '--sv',
            '-f',
            '--if',
            '--isf',
        ],
        'deploy',
        [bu, { query: ['key'] }],
        {
            keySuffix: 'suffix',
            changeKeyField: 'name',
            changeKeyValue: 'new',
            fromRetrieve: true,
            refresh: true,
            execute: true,
            schedule: true,
            skipValidation: true,
            format: true,
            ignoreFolder: true,
            ignoreSfFields: true,
        }
    );
    for (const command of ['build', 'clone']) {
        const args = [
            command,
            '--bf',
            bu,
            '--bt',
            'other/*',
            '-m',
            ...selectors,
            '-D',
            '-r',
            '--sv',
            '-y',
        ];
        if (command === 'build') args.push('--mf', 'source market', '--mt', 'target market');
        dispatch(args, command, expected(command, null), {
            dependencies: true,
            retrieve: true,
            skipValidation: true,
            skipInteraction: true,
        });
    }
});

test('native market arrays repeat, while positional markets take precedence', () => {
    for (const command of ['buildTemplate', 'buildDefinition']) {
        dispatch(
            [command, bu, 'query', 'key', 'positional', '--market', 'first', '--market', 'second'],
            command,
            [bu, 'query', ['key'], ['positional']],
            { market: ['first', 'second'] }
        );
        dispatch([command, bu, '-m', 'query:key', '--market', 'first', 'second'], command, [
            bu,
            { query: ['key'] },
            null,
            ['first', 'second'],
        ]);
    }
});

test('native template aliases and definition validation aliases reach their canonical options', () => {
    dispatch(
        ['bt', bu, '-m', 'query:key', '--market', 'source', '-D', '-r', '--shareAsset'],
        'buildTemplate',
        [bu, { query: ['key'] }, null, ['source']],
        { dependencies: true, retrieve: true, shareAsset: true }
    );
    for (const [alias, command] of [
        ['bd', 'buildDefinition'],
        ['bdb', 'buildDefinitionBulk'],
    ]) {
        const args = [alias, bu, '-m', 'query:key', '--sv'];
        if (command === 'buildDefinition') args.push('--market', 'target');
        dispatch(
            args,
            command,
            command === 'buildDefinition'
                ? [bu, { query: ['key'] }, null, ['target']]
                : [bu, { query: ['key'] }],
            { skipValidation: true }
        );
    }
});

test('native build market aliases accumulate arrays and bulk needs no target BU at parser boundary', () => {
    dispatch(
        [
            'build',
            '--bf',
            bu,
            '-m',
            'query:key',
            '--mf',
            'one',
            '--marketFrom',
            'two',
            '--mt',
            'list one',
            '--marketTo',
            'list two',
            '--bulk',
        ],
        'build',
        [bu, null, { query: ['key'] }, ['one', 'two'], ['list one', 'list two'], true],
        { marketFrom: ['one', 'two'], marketTo: ['list one', 'list two'], bulk: true }
    );
});

test('native metadata overrides positional selectors and global negation preserves explicit false', () => {
    dispatch(
        [
            'retrieve',
            bu,
            'script',
            'ignored',
            '-m',
            'query:key',
            '--no-verbose',
            '--no-debug',
            '--no-silent',
            '--no-noLogColors',
            '--no-noLogFile',
            '--no-errorLog',
            '--no-skipInteraction',
        ],
        'retrieve',
        [bu, { query: ['key'] }],
        {
            verbose: false,
            debug: false,
            silent: false,
            noLogColors: false,
            noLogFile: false,
            errorLog: false,
            skipInteraction: false,
        }
    );
});

for (const [label, args, message] of [
    ['unknown flag', ['retrieve', bu, '--notAFlag'], /Unknown argument/u],
    ['unknown dotted flag', ['deploy', bu, '--notAFlag.value', 'false'], /Unknown argument/u],
    ['missing build selectors', ['build'], /Missing required arguments/u],
    ['missing clone source', ['clone', '-m', 'query:key'], /Missing required argument/u],
    ['missing template market', ['buildTemplate', bu, 'query', 'key'], /provide a market/u],
    ['missing definition market', ['buildDefinition', bu, 'query', 'key'], /provide a market/u],
    ['missing bulk list', ['buildDefinitionBulk'], /Not enough non-option arguments/u],
    ['invalid api choice', ['retrieve', bu, '--api', 'invalid'], /Invalid values/u],
]) {
    test(`native rejects ${label} before option-setting or account dispatch`, () => {
        const result = run(args);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
        assert.deepEqual(result.events, []);
    });
}
