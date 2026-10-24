import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import {
    CONFIG_PREVIEW_LIMITS as limits,
    ProjectConfigPreviewError,
    previewProjectConfig,
} from '../dist/project-config-preview.js';
import { diagnoseProjectConfig } from '../dist/project-config-diagnostics.js';

const project = (rawText = '{}') => ({
    projectRoot: 'synthetic-unread-root',
    configPath: 'synthetic-unread-config',
    rawText,
    config: JSON.parse(rawText),
});
const nested = (count) => '{"x":'.repeat(count) + '0' + '}'.repeat(count);
const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const rejects = (current, proposed, code, budget) => {
    assert.throws(
        () => previewProjectConfig(current, proposed, budget),
        (ex) => {
            assert.ok(ex instanceof ProjectConfigPreviewError);
            assert.equal(ex.code, code);
            assert.equal(ex.complete, false);
            assert.equal(ex.message, `Project configuration preview incomplete: ${code}.`);
            assert.equal(Object.hasOwn(ex, 'changes'), false);
            return true;
        }
    );
};

test('unchanged unknown/user-owned fields and credential topology are preserved', () => {
    const config = {
        credentials: { invented: { eid: '123', businessUnits: { example: '456' } } },
        unknown: { nested: [1, { custom: true }], nullable: null },
        options: { deployment: { mpb_pipeline: { custom: 'retained' } } },
    };
    const current = project(JSON.stringify(config));
    assert.deepEqual(previewProjectConfig(current, JSON.stringify(config)).changes, []);
    const next = { ...config, extra: { entire: [1, 2] } };
    assert.deepEqual(previewProjectConfig(current, JSON.stringify(next)).changes, [
        { op: 'add', path: '/extra', after: next.extra },
    ]);
    assert.deepEqual(current.config, config);
});

test('deterministic changes show complete added, removed and replaced values with pointers', () => {
    const current = project('{"z":{"old":[1,2]},"a/b":{"~key":1},"gone":{"x":true}}');
    const result = previewProjectConfig(current, '{"z":{"new":null},"a/b":{"~key":2},"":7}');
    assert.deepEqual(result.changes, [
        { op: 'add', path: '/', after: 7 },
        { op: 'replace', path: '/a~1b/~0key', before: 1, after: 2 },
        { op: 'remove', path: '/gone', before: { x: true } },
        { op: 'add', path: '/z/new', after: null },
        { op: 'remove', path: '/z/old', before: [1, 2] },
    ]);
});

test('arrays compare atomically and object key order inside arrays is immaterial', () => {
    const current = project('{"list":[{"a":1,"b":2},3]}');
    assert.deepEqual(previewProjectConfig(current, '{"list":[{"b":2,"a":1},3]}').changes, []);
    assert.deepEqual(previewProjectConfig(current, '{"list":[3]}').changes, [
        { op: 'replace', path: '/list', before: [{ a: 1, b: 2 }, 3], after: [3] },
    ]);
    assert.deepEqual(previewProjectConfig(project('{"x":{}}'), '{"x":[]}').changes, [
        { op: 'replace', path: '/x', before: {}, after: [] },
    ]);
});

test('special own keys stay data and do not modify object prototypes', () => {
    const current = project('{"__proto__":{"x":1},"constructor":1}');
    assert.deepEqual(previewProjectConfig(current, '{"__proto__":{"x":2}}').changes, [
        { op: 'replace', path: '/__proto__/x', before: 1, after: 2 },
        { op: 'remove', path: '/constructor', before: 1 },
    ]);
    assert.equal(Object.getPrototypeOf(current.config), Object.prototype);
    assert.equal(Object.prototype.x, undefined);
});

test('raw text is authoritative and hashing preserves whitespace, CRLF, Unicode and escapes', () => {
    const raw = ' {\r\n"label":"é", "x":"\\u0061"\r\n}\n';
    const current = project(raw);
    current.config = { ignoredMutation: true };
    Object.freeze(current.config);
    Object.freeze(current);
    const proposed = '{"label":"é","x":"a"}\n';
    const result = previewProjectConfig(current, proposed);
    assert.deepEqual(result.changes, []);
    assert.equal(result.current.sha256, digest(raw));
    assert.equal(result.current.bytes, Buffer.byteLength(raw));
    assert.equal(result.proposed.sha256, digest(proposed));
    assert.notEqual(result.current.sha256, result.proposed.sha256);
    assert.equal(result.current.basis, 'rawText encoded as UTF-8, without normalization');
    assert.equal(current.rawText, raw);
    assert.deepEqual(current.config, { ignoredMutation: true });
});

test('result values do not alias the supplied current config', () => {
    const current = project('{"x":{"deep":[1]}}');
    const result = previewProjectConfig(current, '{}');
    result.changes[0].before.deep.push(2);
    assert.deepEqual(current.config, { x: { deep: [1] } });
});

test('invalid input yields safe explicit incomplete errors without fragments', () => {
    for (const text of ['{"private-fragment":', '', '{"x":NaN}']) {
        rejects(project(), text, 'invalid-json');
        rejects({ ...project(), rawText: text }, '{}', 'invalid-json');
    }
    for (const text of ['null', '[]', '42', '"secret"', 'true']) {
        rejects(project(), text, 'non-object');
        rejects({ ...project(), rawText: text }, '{}', 'non-object');
    }
    rejects(project(), undefined, 'invalid-input');
    rejects(project(), '{"x":1e400}', 'invalid-json');
    for (const budget of [0, -1, 1.5, Number.NaN, limits.maxOutputBytes + 1])
        rejects(project(), '{}', 'invalid-input', budget);
});

test('both text inputs use UTF-8 byte bounds including exact maximum', () => {
    const exact = '{}'.padEnd(limits.maxInputBytes, ' ');
    assert.deepEqual(previewProjectConfig(project(exact), exact).changes, []);
    const huge = exact + ' ';
    rejects(project(), huge, 'input-too-large');
    rejects({ ...project(), rawText: huge }, '{}', 'input-too-large');
    rejects(
        project(),
        JSON.stringify({ x: 'é'.repeat(limits.maxInputBytes / 2) }),
        'input-too-large'
    );
});

test('depth, total nodes and change count fail closed for both snapshots', () => {
    assert.doesNotThrow(() => previewProjectConfig(project(nested(64)), nested(64)));
    for (const raw of [
        nested(65),
        nested(10000),
        JSON.stringify({ x: Array.from({ length: 20000 }).fill(0) }),
    ]) {
        rejects(project(), raw, 'complexity-limit');
        rejects({ ...project(), rawText: raw }, '{}', 'complexity-limit');
    }
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`k${i}`, i]));
    rejects(project(), JSON.stringify(many), 'change-limit', limits.maxOutputBytes);
});

test('whole-result budget includes diagnostics and never truncates change values', () => {
    const current = project();
    const raw = '{"added":"entire value"}';
    const result = previewProjectConfig(current, raw);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.deepEqual(previewProjectConfig(current, raw, bytes), result);
    rejects(current, raw, 'output-budget', bytes - 1);
    rejects(current, '{}', 'output-budget', 1);
    rejects(current, JSON.stringify({ huge: 'x'.repeat(10000) }), 'output-budget', 3000);
    rejects(current, JSON.stringify({ directories: { retrieve: 1 } }), 'output-budget', 1500);
});

test('proposed diagnosis retains builder-first recommendation and partial limitations', () => {
    const raw = '{"directories":{"retrieve":42},"unknown":{"kept":true}}';
    const result = previewProjectConfig(project(), raw);
    assert.deepEqual(result.diagnosis, diagnoseProjectConfig(project(raw)));
    assert.equal(result.diagnosis.findings[0].code, 'invalid-directory');
    assert.match(result.diagnosis.recommendation.firstStep, /visual MCDev Pipeline Builder/u);
    assert.equal(
        result.diagnosis.recommendation.url,
        'https://sfmc.guide/tools/mcdev-pipeline-builder/'
    );
    assert.ok(result.diagnosis.limitations.some((text) => text.includes('not native')));
    assert.ok(result.limitations.some((text) => text.includes('no writes')));
    assert.ok(result.limitations.some((text) => text.includes('no redaction')));
});

test('composed-reference preview diagnoses proposed raw text and budgets the entire result', () => {
    const config = {
        credentials: { synthetic: { businessUnits: { unit: '123' } } },
        markets: { base: {}, currentOnly: {} },
        marketList: { target: { 'synthetic/unit': [['base', 'currentOnly']] } },
        custom: { untouched: ['retain', { value: true }] },
    };
    const rawText = ` ${JSON.stringify(config)}\n`;
    const current = project(rawText);
    // The parsed wrapper must not override either authoritative raw snapshot.
    current.config = { ignored: true };
    const before = structuredClone(current);
    const proposed = structuredClone(config);
    proposed.marketList.target['synthetic/unit'] = [['base', 'proposed-missing'], [], [null]];
    const text = `${JSON.stringify(proposed, null, 2)}\n`;
    const result = previewProjectConfig(current, text);
    assert.deepEqual(result.diagnosis, diagnoseProjectConfig(project(text)));
    assert.deepEqual(
        result.diagnosis.findings.map(({ code, path }) => ({ code, path })),
        [
            { code: 'unresolved-market', path: '$.marketList["target"]["synthetic/unit"][0][1]' },
            {
                code: 'unsupported-market-shape',
                path: '$.marketList["target"]["synthetic/unit"][2][0]',
            },
        ]
    );
    assert.deepEqual(result.changes, [
        {
            op: 'replace',
            path: '/marketList/target/synthetic~1unit',
            before: [['base', 'currentOnly']],
            after: [['base', 'proposed-missing'], [], [null]],
        },
    ]);
    assert.equal(result.current.sha256, digest(rawText));
    assert.equal(result.proposed.sha256, digest(text));
    assert.match(result.diagnosis.recommendation.firstStep, /Before editing.*Pipeline Builder/u);
    assert.deepEqual(current, before);
    assert.deepEqual(proposed.custom, config.custom);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.deepEqual(previewProjectConfig(current, text, bytes), result);
    rejects(current, text, 'output-budget', bytes - 1);
});

test('core imports only hashing and pure diagnosis, not inspection runtime or write tools', () => {
    const source = fs.readFileSync(
        new URL('../src/project-config-preview.ts', import.meta.url),
        'utf8'
    );
    const imports = [...source.matchAll(/^import (?!type\b)[\s\S]*?from '([^']+)';$/gmu)].map(
        (m) => m[1]
    );
    assert.deepEqual(imports, ['node:crypto', './project-config-diagnostics.js']);
    assert.doesNotMatch(
        source,
        /node:(?:fs|child_process)|import\(|writeFile|mcdev\/|\.mcdev-auth/u
    );
});
