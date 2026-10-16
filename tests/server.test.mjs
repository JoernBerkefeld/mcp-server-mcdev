/**
 * mcp-server-mcdev — unit tests for doc search, config topics, checklists, mcdev types.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Mcdev from 'mcdev';
import { ensureMcdevSilentJson, getBundledMcdevVersion } from '../dist/mcdev-safe.js';
import { clearChunkCache, searchDocs } from '../dist/doc-search.js';
import { listConfigTopicKeys, resolveTopicKey } from '../dist/config-topics.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(testsDir, '..');

describe('doc search', () => {
    test('finds marketList in bundled wiki', () => {
        clearChunkCache();
        const hits = searchDocs('marketList', 5);
        assert.ok(hits.length > 0, 'expected wiki hits for marketList');
        const joined = hits.map((h) => `${h.chunk.file} ${h.chunk.body}`).join('\n');
        assert.match(joined, /market/i);
    });

    test('finds createDeltaPkg in bundled wiki', () => {
        clearChunkCache();
        const hits = searchDocs('createDeltaPkg', 5);
        assert.ok(hits.length > 0, 'expected wiki hits for createDeltaPkg');
    });
});

describe('config topics', () => {
    test('lists known keys', () => {
        const keys = listConfigTopicKeys();
        assert.ok(keys.includes('markets'));
        assert.ok(keys.includes('marketList'));
    });

    test('resolves topic aliases', () => {
        assert.equal(resolveTopicKey('Markets'), 'markets');
    });
});

describe('metadata checklists JSON', () => {
    test('journey checklist has questions and deps', () => {
        const raw = readFileSync(path.join(repoRoot, 'data', 'metadata-checklists.json'), 'utf8');
        const data = JSON.parse(raw);
        assert.ok(data.journey.questions.length >= 3);
        assert.ok(data.journey.dependentMetadataTypes.includes('senderProfile'));
        assert.ok(data.journey.dependentMetadataTypes.includes('asset-email'));
        assert.ok(!data.journey.dependentMetadataTypes.includes('asset-message'));
        assert.match(
            data.journey.questions.find((q) => q.id === 'email_activity').prompt,
            /asset-email/
        );
        assert.doesNotMatch(JSON.stringify(data.journey), /asset-message/);
        for (const mobile of [
            'mobileMessage',
            'mobileCode',
            'mobileKeyword',
            'asset-mobile',
            'mobileApplication',
        ]) {
            assert.ok(data.journey.dependentMetadataTypes.includes(mobile), `missing ${mobile}`);
        }
    });
});

describe('release runtime contract', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'server.json'), 'utf8'));

    test('aligns the package, lock and MCP manifest versions', () => {
        assert.equal(pkg.version, '1.0.0');
        assert.equal(lock.version, pkg.version);
        assert.equal(lock.packages[''].version, pkg.version);
        assert.equal(manifest.version, pkg.version);
        assert.equal(manifest.name, pkg.mcpName);
        assert.ok(manifest.description.length <= 100);
        assert.ok(manifest.packages.length > 0);
        for (const entry of manifest.packages) {
            assert.equal(entry.identifier, pkg.name);
            assert.equal(entry.version, pkg.version);
            assert.equal(entry.transport.type, 'stdio');
        }
    });

    test('uses registry mcdev 10.1.0 and its SDK 4.0.2', () => {
        assert.equal(pkg.dependencies.mcdev, '^10.1.0');
        assert.equal(lock.packages[''].dependencies.mcdev, '^10.1.0');
        assert.equal(lock.packages['node_modules/mcdev'].version, '10.1.0');
        assert.equal(getBundledMcdevVersion(), '10.1.0');
        const require = createRequire(import.meta.url);
        const mcdevRequire = createRequire(require.resolve('mcdev'));
        const sdkPackage = JSON.parse(
            readFileSync(
                path.join(path.dirname(mcdevRequire.resolve('sfmc-sdk')), '..', 'package.json'),
                'utf8'
            )
        );
        assert.equal(sdkPackage.version, '4.0.2');
        for (const entry of Object.values(lock.packages)) {
            assert.notEqual(entry.link, true);
            if (entry.resolved) assert.match(entry.resolved, /^https:\/\//);
            for (const spec of Object.values(entry.dependencies ?? {})) {
                assert.doesNotMatch(spec, /^(?:file|link|workspace):/);
            }
        }
    });

    test('declares supported Node floors and exercises both exact floors in CI', () => {
        assert.equal(pkg.engines.node, '^22.22.2 || >=24.15.0');
        assert.equal(lock.packages[''].engines.node, pkg.engines.node);
        const workflow = readFileSync(
            path.join(repoRoot, '.github', 'workflows', 'code-test.yml'),
            'utf8'
        );
        assert.match(workflow, /node: \['22\.22\.2', '24\.15\.0', 24, 25\]/);
    });

    test('configures silent JSON repeatedly without writing to stdout', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import Mcdev from 'mcdev';
                 import { ensureMcdevSilentJson } from './dist/mcdev-safe.js';
                 import assert from 'node:assert/strict';
                 const original = Mcdev.setOptions;
                 const calls = [];
                 Mcdev.setOptions = (options) => { calls.push(options); return original.call(Mcdev, options); };
                 ensureMcdevSilentJson();
                 ensureMcdevSilentJson();
                 assert.deepEqual(calls, [{ json: true, silent: true }]);
                 assert.ok(Array.isArray(Mcdev.explainTypes()));`,
            ],
            { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '');
    });
});

describe('mcdev explainTypes', () => {
    test('includes journey type', () => {
        ensureMcdevSilentJson();
        const types = Mcdev.explainTypes();
        const journey = types.find((t) => t.apiName === 'journey');
        assert.ok(journey, 'expected journey metadata type');
        assert.match(journey.description, /journey|interaction/i);
    });

    test('retains the API shape used by metadata type listing', () => {
        ensureMcdevSilentJson();
        assert.equal(typeof Mcdev.setOptions, 'function');
        assert.equal(typeof Mcdev.explainTypes, 'function');
        const types = Mcdev.explainTypes();
        assert.ok(Array.isArray(types));
        assert.ok(types.length > 0);
        for (const type of types) {
            for (const key of ['name', 'apiName', 'description']) {
                assert.equal(typeof type[key], 'string', `${type.apiName}.${key}`);
            }
            assert.ok(type.supports && typeof type.supports === 'object');
            for (const key of ['retrieve', 'create', 'update', 'delete', 'buildTemplate']) {
                assert.ok(
                    type.supports[key] === undefined || typeof type.supports[key] === 'boolean',
                    `${type.apiName}.supports.${key}`
                );
            }
        }
        assert.ok(types.some((type) => type.apiName === 'asset'));
    });
});
