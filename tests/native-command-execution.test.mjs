import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { executeNativeCommand, reconcileNativeCommand } from '../dist/native-command-execution.js';
import { validateTempEnvironment } from '../dist/temp-environment.js';

validateTempEnvironment();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-general-')));
fs.writeFileSync(path.join(root, '.owner'), randomUUID());
// Run-owned synthetic fixtures are retained; no recursive cleanup.
const config = {
    credentials: {
        cred: { eid: '100', businessUnits: { BU: '101', Target: '102' } },
    },
    marketList: { targets: { 'cred/Target': 'base' } },
    markets: { base: {} },
};
fs.writeFileSync(path.join(root, '.mcdevrc.json'), JSON.stringify(config));
const runtimeRoot = path.join(root, 'runtime');
fs.mkdirSync(path.join(runtimeRoot, 'lib'), { recursive: true });
fs.writeFileSync(
    path.join(runtimeRoot, 'package.json'),
    JSON.stringify({
        name: 'mcdev',
        version: '10.1.0',
        type: 'module',
        bin: { mcdev: 'lib/cli.js' },
    })
);
const cliEntry = path.join(runtimeRoot, 'lib', 'cli.js');
fs.writeFileSync(
    path.join(runtimeRoot, 'lib', 'index.js'),
    `export default { setOptions(options) { globalThis.nativeChoices = options; } };\n`
);
fs.writeFileSync(
    cliEntry,
    `import fs from 'node:fs';
if(globalThis.nativeChoices)fs.writeFileSync('choices.json',JSON.stringify(globalThis.nativeChoices));
fs.writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));
if(process.argv.includes('hang'))setInterval(()=>{},1000);
else if(process.argv.includes('explainTypes')) { const {default:Mcdev}=await import(${JSON.stringify(new URL('../node_modules/mcdev/lib/index.js', import.meta.url).href)}); Mcdev.setOptions({json:true,silent:true}); console.log(JSON.stringify(Mcdev.explainTypes())); }
else if(process.argv.includes('resolveId'))console.log(JSON.stringify({key:'native-welcome',name:'Welcome',isShared:false,folder:'Content Builder',mid:101,error:''}));
else {console.log('mcdev:: Retrieve');console.log('Authorization: Bearer TOP_SECRET');process.exitCode=0;}
`
);
const runtime = { cliEntry };
const lifetime = () => ({ signal: new AbortController().signal });

test('general execution preserves argv and projects diagnostics without auth reads', async () => {
    fs.writeFileSync(path.join(root, '.mcdev-auth.json'), 'NOT_JSON_AUTH_SECRET');
    const args = ['cred/BU', 'query', 'key: with spaces ; &'];
    const result = await executeNativeCommand(
        { workspaceRoot: root, command: 'retrieve', args },
        lifetime(),
        runtime
    );
    assert.equal(result.outcome, 'exited');
    assert.equal(result.process.exitCode, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8')), [
        'retrieve',
        ...args,
    ]);
    assert.equal(result.remoteCompletenessVerified, false);
    assert.equal(result.reconciliationRequired, false);
    assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET|Bearer/u);
    assert.ok(result.diagnostics.messages.some(({ code }) => code === 'retrieve-started'));
});

test('structured asset results return meaningful keys without reading authentication', async () => {
    const result = await executeNativeCommand(
        { workspaceRoot: root, command: 'resolveId', args: ['cred/BU', 'asset', '123', '--json'] },
        lifetime(),
        runtime
    );
    assert.equal(result.outcome, 'exited');
    assert.equal(result.result.kind, 'resolved-asset');
    assert.equal(result.result.asset.key, 'native-welcome');
    assert.doesNotMatch(JSON.stringify(result), /NOT_JSON_AUTH_SECRET/u);
});

test('unsupported output-only command forms block before launching', async () => {
    for (const [command, args] of [
        ['getFilesToCommit', ['cred/BU', 'query', 'key']],
        ['resolveId', ['cred/BU', 'query', '123', '--json']],
        ['explainTypes', []],
    ]) {
        fs.writeFileSync(path.join(root, 'argv.json'), 'not-launched');
        const result = await executeNativeCommand(
            { workspaceRoot: root, command, args },
            lifetime(),
            runtime
        );
        assert.equal(result.outcome, 'blocked');
        assert.match(result.message, /No command was launched/iu);
        assert.equal(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'), 'not-launched');
    }
});

test('explicit unknown selectors and bulk destinations never launch or leak values', async () => {
    const cases = [
        ['retrieve', ['SECRET_UNKNOWN/BU']],
        ['deploy', ['cred/SECRET_UNKNOWN']],
        ['retrieve', ['SECRET_UNKNOWN/*']],
        ['document', ['cred/SECRET_UNKNOWN', 'query']],
        ['buildDefinition', ['cred/SECRET_UNKNOWN', 'query', 'key', 'base']],
        [
            'build',
            [
                '--buFrom',
                'SECRET_UNKNOWN/BU',
                '--buTo',
                'cred/Target',
                '--metadata',
                'query:key',
                '--marketFrom',
                'base',
                '--marketTo',
                'base',
                '--no-purge',
            ],
        ],
        [
            'build',
            [
                '--buFrom',
                'cred/BU',
                '--buTo',
                'cred/SECRET_UNKNOWN',
                '--metadata',
                'query:key',
                '--marketFrom',
                'base',
                '--marketTo',
                'base',
                '--no-purge',
            ],
        ],
        ['buildDefinitionBulk', ['SECRET_UNKNOWN', 'query', 'key']],
    ];
    for (const [command, args] of cases) {
        fs.writeFileSync(path.join(root, 'argv.json'), 'not-launched');
        const result = await executeNativeCommand(
            { workspaceRoot: root, command, args },
            lifetime(),
            runtime
        );
        assert.equal(result.outcome, 'blocked', `${command}: ${JSON.stringify(result)}`);
        assert.equal(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'), 'not-launched');
        assert.doesNotMatch(JSON.stringify(result), /SECRET_UNKNOWN/u);
    }
});

test('wildcards, build selectors and bulk configured destinations preserve exact argv', async () => {
    const cases = [
        ['retrieve', ['*']],
        ['deploy', ['cred/*']],
        ['retrieve', ['--skipValidation', 'cred/BU', 'query']],
        ['deploy', ['--publish', 'cred/Target', 'query']],
        ['buildDefinitionBulk', ['targets', 'query', 'key']],
        [
            'build',
            [
                '--bf=cred/BU',
                '--bt=cred/Target',
                '-m',
                'query:key',
                '--mf',
                'base',
                '--mt',
                'base',
                '--no-purge',
            ],
        ],
        [
            'build',
            [
                '--bf=cred/BU',
                '--bulk',
                '-m',
                'query:key',
                '--mf',
                'base',
                '--mt',
                'targets',
                '--no-purge',
            ],
        ],
    ];
    for (const [command, args] of cases) {
        const result = await executeNativeCommand(
            { workspaceRoot: root, command, args },
            lifetime(),
            runtime
        );
        assert.equal(result.outcome, 'exited', JSON.stringify(result));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8')), [
            command,
            ...args,
        ]);
    }
});

test('explicit shared children use isolated bridge choices and remove only choice tokens', async () => {
    for (const choice of [
        ['--fixShared=BU,Target'],
        ['--fixShared', 'BU,Target'],
        ['--fixShared=*'],
    ]) {
        const args = ['--publish', ...choice, 'cred/BU', 'query', 'key: with spaces'];
        const result = await executeNativeCommand(
            { workspaceRoot: root, command: 'deploy', args },
            lifetime(),
            runtime
        );
        assert.equal(result.outcome, 'exited', JSON.stringify(result));
        assert.equal(result.process.exitCode, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8')), [
            'deploy',
            '--publish',
            'cred/BU',
            'query',
            'key: with spaces',
        ]);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'choices.json'), 'utf8')), {
            fixShared: choice.at(-1).split('=').at(-1),
            skipInteraction: true,
        });
    }
});

test('invalid shared choices reject before child launch without exposing configuration', async () => {
    const configPath = path.join(root, '.mcdevrc.json');
    const cases = [
        [config, ['cred/BU', '--fixShared=SECRET_CHILD']],
        [config, ['cred/BU', '--fixShared=BU,SECRET_CHILD']],
        [config, ['cred/BU', '--fixShared=']],
        [config, ['cred/BU', '--fixShared=BU,']],
        [
            { credentials: { cred: { businessUnits: { _ParentBU_: '100' } } } },
            ['cred/_ParentBU_', '--fixShared=*'],
        ],
        [
            { credentials: { cred: { businessUnits: { _ParentBU_: '100', BU: '101' } } } },
            ['cred/BU', '--fixShared=_ParentBU_'],
        ],
        [
            { credentials: { cred: { businessUnits: { _ParentBU_: '100', BU: '101' } } } },
            ['cred/BU', '--fixShared=BU,_ParentBU_'],
        ],
        [{ credentials: { cred: { businessUnits: {} } } }, ['cred/*', '--fixShared=*']],
        [
            {
                credentials: {
                    ...config.credentials,
                    SECRET_OTHER: { businessUnits: { Other: '103' } },
                },
            },
            ['*', '--fixShared=BU'],
        ],
        [
            {
                credentials: {
                    ...config.credentials,
                    SECRET_OTHER: { businessUnits: { _ParentBU_: '103' } },
                },
            },
            ['*', '--fixShared=*'],
        ],
    ];
    try {
        for (const [contents, args] of cases) {
            fs.writeFileSync(configPath, JSON.stringify(contents));
            fs.writeFileSync(path.join(root, 'argv.json'), 'not-launched');
            const result = await executeNativeCommand(
                { workspaceRoot: root, command: 'deploy', args },
                lifetime(),
                runtime
            );
            assert.ok(
                ['blocked', 'invalid-input'].includes(result.outcome),
                JSON.stringify(result)
            );
            assert.equal(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'), 'not-launched');
            assert.doesNotMatch(JSON.stringify(result), /SECRET_CHILD|SECRET_OTHER/u);
        }
    } finally {
        fs.writeFileSync(configPath, JSON.stringify(config));
    }
});

test('wildcard deployment checks shared children for every selected credential', async () => {
    const configPath = path.join(root, '.mcdevrc.json');
    try {
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                credentials: { ...config.credentials, second: { businessUnits: { BU: '103' } } },
            })
        );
        const result = await executeNativeCommand(
            { workspaceRoot: root, command: 'deploy', args: ['*', '--fixShared=BU'] },
            lifetime(),
            runtime
        );
        assert.equal(result.outcome, 'exited', JSON.stringify(result));
        assert.equal(result.process.exitCode, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8')), [
            'deploy',
            '*',
        ]);
    } finally {
        fs.writeFileSync(configPath, JSON.stringify(config));
    }
});

test('explainTypes accepts object configuration without credential validation', async () => {
    const configPath = path.join(root, '.mcdevrc.json');
    try {
        for (const contents of [{}, { credentials: { arbitrary: 'SECRET_NOT_AN_ACCOUNT' } }]) {
            fs.writeFileSync(configPath, JSON.stringify(contents));
            const result = await executeNativeCommand(
                { workspaceRoot: root, command: 'explainTypes', args: ['--json'] },
                lifetime(),
                runtime
            );
            assert.equal(result.outcome, 'exited');
            assert.equal(result.result.kind, 'type-catalog');
            assert.ok(result.result.types.some((type) => type.apiName === 'query'));
            assert.doesNotMatch(JSON.stringify(result), /SECRET_NOT_AN_ACCOUNT/u);
        }
    } finally {
        fs.writeFileSync(configPath, JSON.stringify(config));
    }
});

test('config parse, size, shape and invalid list destinations fail without disclosure', async () => {
    const configPath = path.join(root, '.mcdevrc.json');
    const cases = [
        '{"SECRET_CONFIG":',
        ' '.repeat(1024 * 1024 + 1) + 'SECRET_CONFIG',
        '{}',
        JSON.stringify({ ...config, marketList: { targets: { 'cred/SECRET_CONFIG': 'base' } } }),
    ];
    try {
        for (const contents of cases) {
            fs.writeFileSync(configPath, contents);
            fs.writeFileSync(path.join(root, 'argv.json'), 'not-launched');
            const result = await executeNativeCommand(
                {
                    workspaceRoot: root,
                    command: 'buildDefinitionBulk',
                    args: ['targets', 'query', 'key'],
                },
                lifetime(),
                runtime
            );
            assert.equal(result.outcome, 'blocked');
            assert.doesNotMatch(JSON.stringify(result), /SECRET_CONFIG/u);
            assert.equal(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'), 'not-launched');
        }
    } finally {
        fs.writeFileSync(configPath, JSON.stringify(config));
    }
});

test('prelaunch cancellation does not latch; started timeout does', async () => {
    const controller = new AbortController();
    controller.abort();
    const input = { workspaceRoot: root, command: 'retrieve', args: ['cred/BU', 'query', 'hang'] };
    const cancelled = await executeNativeCommand(input, { signal: controller.signal }, runtime);
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.process.started, false);
    assert.equal(cancelled.reconciliationRequired, false);
    const timedOut = await executeNativeCommand({ ...input, timeoutMs: 200 }, lifetime(), runtime);
    assert.ok(['timed-out', 'termination-unconfirmed'].includes(timedOut.outcome));
    assert.equal(timedOut.process.started, true);
    assert.equal(timedOut.reconciliationRequired, true);
    assert.deepEqual(reconcileNativeCommand(root), { released: true });
});

test('invalid envelope and missing project are actionable without child launch', async () => {
    const invalid = await executeNativeCommand(
        { workspaceRoot: root, command: 'unknown', args: [] },
        lifetime(),
        runtime
    );
    assert.equal(invalid.outcome, 'invalid-input');
    const blocked = await executeNativeCommand(
        { workspaceRoot: runtimeRoot, command: 'retrieve', args: ['cred/BU'] },
        lifetime(),
        runtime
    );
    assert.equal(blocked.outcome, 'blocked');
    assert.deepEqual(reconcileNativeCommand(runtimeRoot), { released: false });
});

test('same-project operations serialize and started cancellation latches until reconciliation', async () => {
    const controller = new AbortController();
    const input = { workspaceRoot: root, command: 'retrieve', args: ['cred/BU', 'query', 'hang'] };
    const running = executeNativeCommand(input, { signal: controller.signal }, runtime);
    const busy = await executeNativeCommand(input, lifetime(), runtime);
    assert.equal(busy.outcome, 'project-busy');
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    const result = await running;
    assert.ok(['cancelled', 'termination-unconfirmed'].includes(result.outcome));
    assert.equal(result.process.started, true);
    assert.equal(result.reconciliationRequired, true);
    const latched = await executeNativeCommand(input, lifetime(), runtime);
    assert.equal(latched.outcome, 'project-busy');
    assert.equal(latched.reconciliationRequired, true);
    assert.deepEqual(reconcileNativeCommand(root), { released: true });
    const next = await executeNativeCommand(
        { ...input, args: ['cred/BU', 'query', 'key'] },
        lifetime(),
        runtime
    );
    assert.equal(next.outcome, 'exited');
});
