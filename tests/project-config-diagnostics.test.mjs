import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { diagnoseProjectConfig } from '../dist/project-config-diagnostics.js';

function diagnose(config) {
    const project = {
        config,
        projectRoot: 'unused',
        configPath: 'unused',
        rawText: JSON.stringify(config),
    };
    const before = structuredClone(project);
    const result = diagnoseProjectConfig(project);
    assert.deepEqual(project, before, 'entire input must remain unchanged');
    return result;
}

function valid() {
    return {
        credentials: {
            first: { eid: 1, businessUnits: { shared: 12 } },
            second: { eid: '2', businessUnits: { shared: '34' } },
        },
        markets: { empty: {}, other: { custom: ['arbitrary'] } },
        marketList: {
            source: { description: 'keep me', filter: { custom: true }, 'first/shared': 'empty' },
            target: { 'second/shared': ['empty', 'other'] },
        },
        options: { deployment: { sourceTargetMapping: { source: 'target' } } },
    };
}

test('credential-qualified duplicate aliases and string/array market shorthand are valid', () => {
    assert.deepEqual(diagnose(valid()).findings, []);
});

test('invalid structural fields return evidence and exact JSON paths', () => {
    const result = diagnose({
        directories: { retrieve: 7 },
        metaDataTypes: { retrieve: true },
        options: [],
    });
    assert.ok(result.findings.some((finding) => finding.path === '$.directories["retrieve"]'));
    assert.ok(result.findings.some((finding) => finding.code === 'invalid-type-list'));
    assert.ok(result.findings.some((finding) => finding.path === '$.options'));
    assert.ok(result.findings.every((finding) => finding.evidence.startsWith('mcdev/')));
});

test('references are checked within their credential and market namespaces', () => {
    const config = valid();
    config.marketList.target = {
        'second/missing': 'missing-market',
        'absent/shared': 'empty',
        shared: 'empty',
    };
    config.options.deployment.sourceTargetMapping.source = 'missing-list';
    const codes = diagnose(config).findings.map((finding) => finding.code);
    for (const code of [
        'unresolved-bu',
        'unresolved-credential',
        'invalid-bu-reference',
        'unresolved-market',
        'unresolved-market-list',
    ]) {
        assert.ok(codes.includes(code), code);
    }
});

test('mapping targets and source cardinality follow native devops semantics', () => {
    const config = valid();
    config.options.deployment.branchSourceTargetMapping = { test: { source: ['target'] } };
    config.marketList.source['first/shared'] = ['empty'];
    const findings = diagnose(config).findings;
    assert.ok(findings.some((finding) => finding.code === 'invalid-source-list'));
    assert.ok(
        findings.some(
            (finding) =>
                finding.code === 'invalid-mapping-target' && finding.path.includes('["test"]')
        )
    );
});

test('native defaults and sparse configs are not classified as structural errors', () => {
    const defaults = JSON.parse(
        fs.readFileSync(
            new URL('../node_modules/mcdev/boilerplate/config.json', import.meta.url),
            'utf8'
        )
    );
    assert.deepEqual(
        diagnose(defaults).findings.filter((finding) => finding.severity === 'error'),
        []
    );
    assert.deepEqual(diagnose({}).findings, []);
});

test('unknown fields, filters and user-owned market variables are never changed', () => {
    const config = valid();
    config.userOwned = { sentinel: ['retain', { value: null }] };
    config.options.deployment.targetBranchBuMapping = { 'release/*': ['second/shared'] };
    assert.deepEqual(diagnose(config).findings, []);
});

test('builder recommendation is first step, excludes auth and never gates diagnosis', () => {
    const result = diagnose({ credentials: false });
    assert.ok(result.findings.length > 0);
    assert.equal(result.recommendation.url, 'https://sfmc.guide/tools/mcdev-pipeline-builder/');
    assert.match(result.recommendation.firstStep, /Before editing.*visual/u);
    assert.match(result.recommendation.guidance, /existing \.mcdevrc\.json/u);
    assert.match(result.recommendation.guidance, /Never load \.mcdev-auth\.json/u);
    assert.match(result.recommendation.guidance, /without the builder/u);
    assert.ok(result.limitations.some((value) => value.includes('targetBranchBuMapping')));
});

test('unsupported market composition is explicitly unvalidated rather than rejected', () => {
    const config = valid();
    config.marketList.target['second/shared'] = [['empty', 'other']];
    assert.ok(
        diagnose(config).findings.some(
            (finding) =>
                finding.code === 'unsupported-market-shape' && finding.severity === 'warning'
        )
    );
});
