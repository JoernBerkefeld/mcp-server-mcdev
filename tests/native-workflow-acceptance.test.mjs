import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { executeNativeCommand } from '../dist/native-command-execution.js';
import { validateTempEnvironment } from '../dist/temp-environment.js';

function preflight() {
    validateTempEnvironment();
    for (const [name, value] of Object.entries({
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
        node: os.tmpdir(),
    })) {
        if (!value && name !== 'node' && (name !== 'TEMP' || process.platform !== 'win32'))
            continue;
        assert.ok(value && path.isAbsolute(value), name);
        if (process.platform === 'win32')
            assert.equal(
                path
                    .resolve(value)
                    .replaceAll(/[\\/]+$/gu, '')
                    .toLowerCase(),
                String.raw`f:\temp`,
                name
            );
    }
}
preflight();
const nativeRoot = fileURLToPath(new URL('../node_modules/mcdev/lib/', import.meta.url));

function fixture(t) {
    preflight();
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-workflow-')));
    fs.writeFileSync(path.join(root, '.owner'), randomUUID());
    // Retain all run-owned inputs and outputs. No authored recursive cleanup.
    t.diagnostic(`retained workflow fixture: ${root}`);
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true });
    fs.writeFileSync(
        path.join(runtime, 'package.json'),
        JSON.stringify({
            name: 'mcdev',
            version: '10.1.0',
            type: 'module',
            bin: { mcdev: 'lib/cli.js' },
        })
    );
    const cliEntry = path.join(runtime, 'lib/cli.js');
    fs.copyFileSync(new URL('native-workflow-fixtures/offline-cli.mjs', import.meta.url), cliEntry);
    fs.writeFileSync(path.join(runtime, 'lib/native-root.txt'), nativeRoot);
    const config = JSON.parse(
        fs.readFileSync(path.join(nativeRoot, '../boilerplate/config.json'), 'utf8')
    );
    config.credentials = {
        cred: { eid: 100, businessUnits: { Source: 100, Target: 200, Other: 300 } },
    };
    config.directories.templateBuilds = ['deploy', 'mirror'];
    config.options.formatOnSave = false;
    config.options.validation = { retrieve: false, buildDefinition: false, deploy: false };
    config.metaDataTypes.documentOnRetrieve = [];
    config.metaDataTypes.retrieve = ['query'];
    config.markets = {
        source: { REGION: 'global' },
        base: { REGION: 'base' },
        regional: { REGION: 'de' },
    };
    config.marketList = { targets: { 'cred/Target': ['base', 'regional'], 'cred/Other': 'base' } };
    fs.writeFileSync(path.join(root, '.mcdevrc.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(root, '.mcdev-auth.json'), 'MUST NEVER BE READ');
    const remote = ['audience_global', 'reject_me'].map((key) => ({
        key,
        name: key,
        queryDefinitionId: `remote-${key}`,
        categoryId: 10,
        targetKey: 'target',
        targetId: 'target-id',
        targetUpdateTypeName: 'Overwrite',
        queryText: 'SELECT SubscriberKey FROM [Subscribers_global]',
    }));
    fs.writeFileSync(path.join(root, 'remote.json'), JSON.stringify(remote));
    const run = async (command, args, expectedExit = 0) => {
        const result = await executeNativeCommand(
            {
                workspaceRoot: root,
                command,
                args: [...args, '--noLogFile', '--noLogColors', '--skipInteraction'],
                timeoutMs: 30_000,
            },
            { signal: new AbortController().signal },
            { cliEntry }
        );
        assert.equal(result.outcome, 'exited', JSON.stringify(result));
        assert.equal(result.process.exitCode, expectedExit, JSON.stringify(result));
        assert.equal(result.remoteCompletenessVerified, false);
        return {
            result,
            observations: JSON.parse(fs.readFileSync(path.join(root, 'observations.json'), 'utf8')),
        };
    };
    const read = (directory, bu, key, extension = 'json') =>
        fs.readFileSync(
            path.join(root, directory, 'cred', bu, 'query', `${key}.query-meta.${extension}`),
            'utf8'
        );
    return { root, run, read };
}

test('production executor runs real retrieve -> edit -> compound build -> deploy with partial remote failure', async (t) => {
    const { root, run, read } = fixture(t);
    const retrieved = await run('retrieve', ['cred/Source', 'query', '--no-purge']);
    assert.equal(
        retrieved.observations.filter(({ operation }) => operation === 'rest.get').length,
        1
    );
    const original = JSON.parse(read('retrieve', 'Source', 'audience_global'));
    assert.equal(original.r__folder_Path, 'Query');
    assert.equal(original.r__dataExtension_key, 'target');
    const sourceSql = path.join(root, 'retrieve/cred/Source/query/audience_global.query-meta.sql');
    fs.writeFileSync(sourceSql, 'SELECT SubscriberKey FROM [Edited_global]\n');
    await run('build', [
        '--buFrom',
        'cred/Source',
        '--buTo',
        'cred/Target',
        '-m',
        'query:audience_global',
        'query:reject_me',
        '--marketFrom',
        'source',
        '--marketTo',
        'base',
        'regional',
        '--no-purge',
    ]);
    for (const destination of ['deploy', 'mirror']) {
        assert.equal(JSON.parse(read(destination, 'Target', 'audience_de')).key, 'audience_de');
        assert.match(read(destination, 'Target', 'audience_de', 'sql'), /Edited_de/u);
        assert.equal(JSON.parse(read(destination, 'Target', 'reject_me')).key, 'reject_me');
    }
    assert.match(fs.readFileSync(sourceSql, 'utf8'), /Edited_global/u);
    const deployed = await run('deploy', ['cred/Target', 'query', '--skipValidation'], 1);
    const writes = deployed.observations.filter(({ operation }) => operation === 'rest.post');
    assert.deepEqual(writes.map(({ args }) => args[1].key).toSorted(), [
        'audience_de',
        'reject_me',
    ]);
    const payload = writes.find(({ args }) => args[1].key === 'audience_de').args[1];
    assert.match(payload.queryText, /Edited_de/u);
    assert.equal(payload.categoryId, 10);
    assert.equal(payload.targetId, 'target-id');
    assert.equal(payload.targetUpdateTypeId, 0);
    assert.equal(JSON.parse(read('retrieve', 'Target', 'audience_de')).key, 'audience_de');
    assert.equal(
        fs.existsSync(path.join(root, 'retrieve/cred/Target/query/reject_me.query-meta.json')),
        false
    );
    assert.ok(
        deployed.result.diagnostics.messages.some(({ code }) => code === 'deploy-upsert-reported')
    );
    assert.equal(deployed.result.process.partialEffectsPossible, true);
});

test('real bulk build and clone preserve configured destination routing', async (t) => {
    const { run, read } = fixture(t);
    await run('retrieve', ['cred/Source', 'query', '--no-purge']);
    await run('build', [
        '--buFrom',
        'cred/Source',
        '--bulk',
        '-m',
        'query:audience_global',
        '--marketFrom',
        'source',
        '--marketTo',
        'targets',
        '--no-purge',
    ]);
    for (const destination of ['deploy', 'mirror']) {
        assert.equal(JSON.parse(read(destination, 'Target', 'audience_de')).key, 'audience_de');
        assert.equal(JSON.parse(read(destination, 'Other', 'audience_base')).key, 'audience_base');
    }
    await run('clone', [
        '--buFrom',
        'cred/Source',
        '--buTo',
        'cred/Other',
        '-m',
        'query:audience_global',
        '--no-purge',
    ]);
    for (const destination of ['deploy', 'mirror']) {
        assert.equal(
            JSON.parse(read(destination, 'Other', 'audience_global')).key,
            'audience_global'
        );
        assert.match(read(destination, 'Other', 'audience_global', 'sql'), /Subscribers_global/u);
    }
});
