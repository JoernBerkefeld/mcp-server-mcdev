/**
 * mcp-server-mcdev — unit tests for doc search, config topics, checklists, mcdev types.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Mcdev from 'mcdev';
import { ensureMcdevSilentJson } from '../dist/mcdev-safe.js';
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
});
