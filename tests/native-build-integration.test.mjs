import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// This machine requires F:/Temp; other platforms use their actual OS temporary directory.
function preflight() {
    const temporaryDirectory = os.tmpdir();
    for (const [name, value] of Object.entries({
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
        'os.tmpdir()': temporaryDirectory,
    })) {
        if (!value && name !== 'os.tmpdir()' && name !== 'TEMP') continue;
        if (!value && process.platform !== 'win32') continue;
        assert.ok(value && path.isAbsolute(value), `${name} must be absolute`);
        const normalized = path
            .resolve(value)
            .replaceAll(/[\\/]+$/gu, '')
            .toLowerCase();
        assert.notEqual(path.resolve(value), path.parse(path.resolve(value)).root);
        if (process.platform === 'win32') assert.equal(normalized, String.raw`f:\temp`, name);
    }
}

// Run the real metadata API in a fresh process so static mcdev state cannot leak to other tests.
async function buildInChild() {
    const fs = await import('node:fs');
    const net = await import('node:net');
    const { syncBuiltinESMExports } = await import('node:module');
    net.default.Socket.prototype.connect = () => {
        throw new Error('Network access is forbidden in native offline integration');
    };
    globalThis.fetch = () => {
        throw new Error('Fetch is forbidden in native offline integration');
    };
    syncBuiltinESMExports();
    const { default: types } = await import(process.argv[1]);
    const Query = types.query;
    const properties = JSON.parse(fs.readFileSync('properties.json', 'utf8'));
    Query.properties = properties;
    // The metadata API takes already-merged variables. This is the same ordered,
    // shallow overlay used by Builder, without entering its credential/SDK path.
    const variables = Object.assign(
        {},
        ...JSON.parse(process.argv[2]).map((market) => properties.markets[market])
    );
    const snapshot = JSON.stringify(properties);
    const result = await Query.buildDefinition(
        properties.directories.template,
        properties.directories.templateBuilds,
        'source',
        variables
    );
    if (!result || result.type !== 'query')
        throw new Error('Native query build returned no result');
    if (JSON.stringify(properties) !== snapshot) throw new Error('Native build mutated properties');
    fs.writeFileSync('result.json', JSON.stringify(result));
}

for (const order of [
    ['base', 'regional'],
    ['regional', 'base'],
]) {
    test(`installed mcdev builds full query JSON and SQL offline: ${order.join(' then ')}`, (t) => {
        preflight();
        const started = new Date().toISOString();
        const root = fs.realpathSync.native(
            fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-native-build-'))
        );
        const owner = randomUUID();
        fs.writeFileSync(path.join(root, '.owner'), owner);
        // Retain all run-owned fixtures and generated outputs; intentionally no cleanup.
        t.diagnostic(`start=${started}; fixture=${root}; owner=${owner}`);
        fs.mkdirSync(path.join(root, 'templates', 'query'), { recursive: true });
        const properties = {
            directories: { template: 'templates', templateBuilds: ['build/one', 'build/two'] },
            options: { validation: { buildDefinition: false } },
            markets: {
                base: {
                    REGION: 'global',
                    LABEL: 'Global audience',
                    SOURCE: 'Subscribers_Global',
                    LIMIT: 50,
                    ENABLED: true,
                    BASE_ONLY: 'preserved',
                    MATCH: { regex: 'unused-pattern', replace: 'base-value' },
                },
                regional: {
                    REGION: 'de',
                    LABEL: 'German audience',
                    SOURCE: 'Subscribers_DE',
                    LIMIT: 7,
                    ENABLED: false,
                    MATCH: { regex: 'unused-pattern', replace: 'regional-value' },
                },
            },
        };
        fs.writeFileSync(path.join(root, 'properties.json'), JSON.stringify(properties));
        const template = `{
    "key": "audience_{{{REGION}}}",
    "name": "{{{LABEL}}}",
    "description": "{{{BASE_ONLY}}}: {{{MATCH}}}",
    "targetKey": "target_{{{REGION}}}",
    "r__folder_Path": "Query/Synthetic/{{{REGION}}}",
    "targetUpdateTypeName": "Overwrite",
    "nested": { "{{{REGION}}}": ["{{{SOURCE}}}", {{{LIMIT}}}, {{{ENABLED}}}] }
}`;
        const sql =
            "SELECT TOP {{{LIMIT}}} SubscriberKey, '{{{MATCH}}}' AS Marker\n" +
            "FROM [{{{SOURCE}}}]\nWHERE Locale = '{{{REGION}}}'\n";
        const sourceJson = path.join(root, 'templates', 'query', 'source.query-meta.json');
        const sourceSql = path.join(root, 'templates', 'query', 'source.query-meta.sql');
        fs.writeFileSync(sourceJson, template);
        fs.writeFileSync(sourceSql, sql);
        const child = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '--eval',
                `await (${buildInChild.toString()})();`,
                import.meta.resolve('mcdev/MetadataTypeInfo'),
                JSON.stringify(order),
            ],
            {
                cwd: root,
                shell: false,
                encoding: 'utf8',
                timeout: 30_000,
                env: {
                    TEMP: os.tmpdir(),
                    TMP: os.tmpdir(),
                    TMPDIR: os.tmpdir(),
                    SystemRoot: process.env.SystemRoot,
                    HOME: root,
                    USERPROFILE: root,
                },
            }
        );
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.signal, null);
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        const regionalWins = order.at(-1) === 'regional';
        const region = regionalWins ? 'de' : 'global';
        const label = regionalWins ? 'German audience' : 'Global audience';
        const source = regionalWins ? 'Subscribers_DE' : 'Subscribers_Global';
        const limit = regionalWins ? 7 : 50;
        const match = regionalWins ? 'regional-value' : 'base-value';
        const expected = {
            key: `audience_${region}`,
            name: label,
            description: `preserved: ${match}`,
            targetKey: `target_${region}`,
            r__folder_Path: `Query/Synthetic/${region}`,
            targetUpdateTypeName: 'Overwrite',
            nested: { [region]: [source, limit, !regionalWins] },
        };
        const expectedSql = `SELECT TOP ${limit} SubscriberKey, '${match}' AS Marker\nFROM [${source}]\nWHERE Locale = '${region}'\n`;
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8')), {
            metadata: expected,
            type: 'query',
        });
        for (const destination of properties.directories.templateBuilds) {
            const output = path.join(root, destination, 'query');
            assert.deepEqual(fs.readdirSync(output).toSorted(), [
                `audience_${region}.query-meta.json`,
                `audience_${region}.query-meta.sql`,
            ]);
            assert.deepEqual(
                JSON.parse(
                    fs.readFileSync(path.join(output, `audience_${region}.query-meta.json`), 'utf8')
                ),
                expected
            );
            assert.equal(
                fs.readFileSync(path.join(output, `audience_${region}.query-meta.sql`), 'utf8'),
                expectedSql
            );
        }
        assert.equal(fs.readFileSync(sourceJson, 'utf8'), template);
        assert.equal(fs.readFileSync(sourceSql, 'utf8'), sql);
        assert.deepEqual(
            JSON.parse(fs.readFileSync(path.join(root, 'properties.json'), 'utf8')),
            properties
        );
        assert.equal(fs.readFileSync(path.join(root, '.owner'), 'utf8'), owner);
        t.diagnostic(
            `end=${new Date().toISOString()}; native generated JSON+SQL verified in two destinations`
        );
    });
}
