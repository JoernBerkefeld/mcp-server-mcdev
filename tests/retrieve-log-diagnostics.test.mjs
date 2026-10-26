import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    classifyRetrieveLog,
    diagnoseRetrieveLogs,
    parseRetrieveLogFilename,
    RETRIEVE_LOG_LIMITS,
} from '../dist/retrieve-log-diagnostics.js';

const selection = {
    file: '2026-10-22T12.00.00.000Z.log',
    credential: 'sample',
    businessUnit: 'Training',
    metadataType: 'query',
    key: 'example.key-1',
    startedAfter: '2026-10-22T11:00:00.000Z',
    startedBefore: '2026-10-22T13:00:00.000Z',
};
const info = (message) => `14:00:00.001 info: ${message}`;
const fixture = (type = 'query', key = selection.key) => [
    `14:00:00.000 debug: :: mcdev 10.1.0 :: ⚡ mcdev retrieve sample/Training ${type} ${key}`,
    info('mcdev:: Retrieve'),
    info(':: Retrieving sample/Training'),
    info(`Retrieving: ${type} - Key: ${key}`),
];
const classify = (lines, changes = {}) =>
    classifyRetrieveLog(lines.join('\n'), { ...selection, ...changes });

const read = (file) =>
    fs.readFileSync(new URL(`../node_modules/mcdev/${file}`, import.meta.url), 'utf8');

test('reviewed installed source anchors remain version-bound without native imports', () => {
    assert.equal(JSON.parse(read('package.json')).version, '10.1.1');
    for (const [file, anchor] of [
        ['lib/util/util.js', "Util.logFileName = new Date().toISOString().replaceAll(':', '.');"],
        ['lib/util/util.js', '`${info.timestamp} ${info.level}: ${info.message}`'],
        [
            'lib/util/util.js',
            "`:: mcdev ${Util.packageJsonMcdev.version} :: ⚡ mcdev ${processArgv.join(' ')}`",
        ],
        ['lib/cli.js', "['retrieve [BU] [TYPE] [KEY]', 'r']"],
        ['lib/index.js', "Util.logger.info('mcdev:: Retrieve');"],
        ['lib/index.js', 'Util.logger.info(`:: Retrieving ${cred}/${bu}`);'],
        ['lib/Retriever.js', '`Retrieving: ${type}`'],
        [
            'lib/util/util.js',
            "` - ${isId ? 'ID' : 'Key'}${keyArr.length > 1 ? 's' : ''}: ${keyArr.join(', ')}`",
        ],
        [
            'lib/metadataTypes/Query.js',
            '`Downloaded: ${this.definition.type} (0)${Util.getKeysString(key)}`',
        ],
        [
            'lib/metadataTypes/MetadataType.js',
            '`Downloaded: ${this.definition.type} (${Object.keys(savedMetadata).length})`',
        ],
    ])
        assert.ok(read(file).includes(anchor), file);
});

test('both historical 10.1.0 and current 10.1.1 invocation headers remain supported', () => {
    for (const version of ['10.1.0', '10.1.1']) {
        for (const metadataType of ['query', 'script']) {
            const lines = fixture(metadataType).map((line) => line.replace('10.1.0', version));
            assert.equal(classify(lines, { metadataType }).status, 'matched');
        }
    }
});

test('filename UTC is strict, normal-log-only, and independent of local record clocks', () => {
    assert.equal(parseRetrieveLogFilename(selection.file), '2026-10-22T12:00:00.000Z');
    for (const file of [
        '../' + selection.file,
        'F:\\logs\\' + selection.file,
        selection.file.replace('.log', '-errors.log'),
        '2026-02-30T12.00.00.000Z.log',
        '2026-10-22T24.00.00.000Z.log',
        '2026-10-22T12:00:00.000Z.log',
        '2026-10-22T12.00.00Z.log',
        selection.file + '\n',
        selection.file.toUpperCase(),
    ])
        assert.equal(parseRetrieveLogFilename(file), undefined);
    assert.equal(classify(fixture()).status, 'matched');
});

test('query and Script return only observed finite findings, including repeated zero downloads', () => {
    for (const metadataType of ['query', 'script']) {
        const lines = [
            ...fixture(metadataType),
            info(`Downloaded: ${metadataType} (0) - Key: ${selection.key}`),
            info(`Downloaded: ${metadataType} (0) - Key: ${selection.key}`),
            info(`Downloaded: ${metadataType} (2) - Key: ${selection.key}`),
        ];
        assert.deepEqual(classify(lines, { metadataType }), {
            status: 'matched',
            remoteCompletenessVerified: false,
            invocationStartedAt: '2026-10-22T12:00:00.000Z',
            findings: [
                { code: 'retrieve-start-observed', occurrences: 1 },
                { code: 'type-key-observed', occurrences: 1 },
                { code: 'download-zero-observed', occurrences: 2 },
                { code: 'download-nonzero-observed', occurrences: 1 },
            ],
            suppressedRecordCount: 0,
        });
    }
});

test('no observations and unrelated exact scope/time are honestly no-match', () => {
    for (const lines of [
        [],
        [info('unrecognized')],
        [info('Downloaded: query (0) - Key: example.key-1')],
    ]) {
        assert.equal(classify(lines).status, 'no-match');
        assert.deepEqual(classify(lines).findings, []);
    }
    for (const changes of [
        { credential: 'other' },
        { businessUnit: 'Other' },
        { key: 'another' },
        { metadataType: 'script' },
        { file: '2026-10-22T14.00.00.000Z.log' },
    ])
        assert.equal(classify(fixture(), changes).status, 'no-match');
});

test('missing/mixed scope, out-of-order evidence and multiple invocations fail closed', () => {
    const original = fixture();
    for (const lines of [
        original.slice(0, 1),
        original.filter((_, index) => index !== 1),
        original.filter((_, index) => index !== 2),
        original.filter((_, index) => index !== 3),
        [original[0], original[2], original[1], original[3]],
        [...original, info(':: Retrieving sample/Other')],
        [...original, info('Retrieving: script - Key: example.key-1')],
        [...original, info('Retrieving: query - Keys: one, two')],
    ]) {
        assert.equal(classify(lines).status, 'unsupported');
        assert.deepEqual(classify(lines).findings, []);
    }
    assert.equal(classify([...original, ...original]).status, 'ambiguous');
    assert.equal(classify([...original, 'unformatted :: mcdev 10.1.0']).status, 'ambiguous');
});

test('joined argv permits only the frozen literal positional spelling, never reconstruction', () => {
    for (const command of [
        'r sample/Training query example.key-1',
        'retrieve sample/Training query example.key-1 --yes',
        'retrieve --metadata query --key example.key-1 sample/Training',
        'retrieve "sample/Training" query example.key-1',
        "retrieve sample/Training query 'example.key-1'",
        'retrieve sample/Training query one two',
        'retrieve sample/Training query one,two',
        'retrieve sample/Training query *',
        'retrieve sample/Training query example.key-1;whoami',
        'retrieve sample/Training query $SECRET',
        'retrieve sample/Training query --secret=value',
        'retrieve  sample/Training query example.key-1',
    ]) {
        const lines = fixture();
        lines[0] = `14:00:00.000 debug: :: mcdev 10.1.0 :: ⚡ mcdev ${command}`;
        assert.equal(classify(lines).status, 'unsupported', command);
    }
    assert.equal(
        classify(fixture().map((line) => line.replace('10.1.0', '10.2.0'))).status,
        'unsupported'
    );
    for (const key of ['with space', 'a/b', '..', '*', '-option', 'a,b', 'a\nsecret']) {
        assert.equal(classify(fixture(), { key }).status, 'unsupported');
    }
});

test('unknown errors, paths, API/config fragments and suffixed findings are suppression-only', () => {
    const sensitive = [
        '14:00:00.001 error: SECRET_TOKEN /private/path {"clientSecret":"PRIVATE"}',
        'SyntaxError: malformed auth SECRET_VALUE',
        info('Downloaded: query (0) - Key: example.key-1 PRIVATE_SUFFIX'),
        info('Downloaded: query (2) - Key: another.secret'),
        info('Downloaded: query (01) - Key: example.key-1'),
        info('Downloaded: query (2) - Key: example.key-1\rPRIVATE'),
        '14:00:00.001 warn: mcdev:: Retrieve',
        '99:00:00.000 info: PRIVATE',
        info('{"accessToken":"PRIVATE"}'),
    ];
    const result = classify([...fixture(), ...sensitive]);
    assert.equal(result.status, 'matched');
    assert.equal(result.suppressedRecordCount, sensitive.length);
    assert.deepEqual(
        result.findings.map(({ code }) => code),
        ['retrieve-start-observed', 'type-key-observed']
    );
    assert.doesNotMatch(
        JSON.stringify(result),
        /SECRET|PRIVATE|sample|Training|example|auth|path|delet/i
    );
    // A fully correlated run with only unknown diagnostics is still not remote success.
    assert.equal(result.remoteCompletenessVerified, false);
});

test('bounds, malformed text and noncanonical time windows are unsupported and never echoed', () => {
    assert.ok(Object.isFrozen(RETRIEVE_LOG_LIMITS));
    assert.deepEqual(RETRIEVE_LOG_LIMITS, {
        directoryEntries: 256,
        candidates: 16,
        fileBytes: 1048576,
        totalBytes: 4194304,
        windowMilliseconds: 86400000,
    });
    for (const text of [
        '\0PRIVATE',
        '\uFFFDPRIVATE',
        '\u001BPRIVATE',
        'x'.repeat(RETRIEVE_LOG_LIMITS.fileBytes + 1),
    ]) {
        const result = classifyRetrieveLog(text, selection);
        assert.equal(result.status, 'unsupported');
        assert.deepEqual(result.findings, []);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
    for (const changes of [
        { startedAfter: '2026-02-30T00:00:00.000Z' },
        { startedAfter: '2026-10-22T14:00:00.000Z' },
        { startedBefore: '2026-10-24T13:00:00.000Z' },
        { startedBefore: '2026-10-22T13:00:00+00:00' },
        { metadataType: 'asset' },
    ])
        assert.equal(classify(fixture(), changes).status, 'unsupported');
    assert.equal(classifyRetrieveLog(fixture().join('\r\n') + '\r\n', selection).status, 'matched');
});

// Synthetic, run-owned fixtures deliberately remain in OS temp; no recursive cleanup.
function project() {
    validateTempEnvironment();
    const workspaceRoot = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-log-'))
    );
    fs.writeFileSync(
        path.join(workspaceRoot, '.mcdevrc.json'),
        JSON.stringify({ credentials: { sample: { businessUnits: { Training: '123' } } } })
    );
    const logs = path.join(workspaceRoot, 'logs');
    fs.mkdirSync(logs);
    const { file, ...scope } = selection;
    return {
        logs,
        input: { ...scope, workspaceRoot },
        write: (text = fixture().join('\n'), name = file) =>
            fs.writeFileSync(path.join(logs, name), text),
    };
}

const safeEmpty = (result, status) => {
    assert.deepEqual(result, { status, remoteCompletenessVerified: false, logs: [] });
    assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|sample|Training|example|Temp/i);
};

test('reader source checkpoint fixes normal logs under project root without native imports', () => {
    assert.ok(read('lib/util/util.js').includes("filename: 'logs/' + Util.logFileName + '.log'"));
    const p = project();
    safeEmpty(diagnoseRetrieveLogs(p.input), 'no-match');
    p.write('PRIVATE', selection.file.replace('.log', '-errors.log'));
    p.write('PRIVATE', 'malformed.log');
    safeEmpty(diagnoseRetrieveLogs(p.input), 'no-match');
    const missing = project();
    fs.rmdirSync(missing.logs);
    safeEmpty(diagnoseRetrieveLogs(missing.input), 'no-match');
});

test('reader selects latest correlated start, not unrelated log or mtime', () => {
    const p = project();
    p.write();
    const later = '2026-10-22T12.30.00.000Z.log';
    p.write(fixture().join('\n'), later);
    p.write(fixture('query', 'unrelated').join('\n'), '2026-10-22T12.59.00.000Z.log');
    const result = diagnoseRetrieveLogs(p.input);
    assert.equal(result.status, 'matched');
    assert.equal(result.logs[0].file, later);
    assert.equal(result.logs[0].invocationStartedAt, '2026-10-22T12:30:00.000Z');
    assert.equal(result.remoteCompletenessVerified, false);
    assert.doesNotMatch(JSON.stringify(result), /sample|Training|example|Temp/);
    assert.equal(
        diagnoseRetrieveLogs({
            ...p.input,
            startedAfter: '2026-10-22T12:30:00.000Z',
            startedBefore: '2026-10-22T12:30:00.000Z',
        }).status,
        'matched'
    );
});

test('reader validates exact config aliases and input shape without exposing failures', () => {
    const p = project();
    p.write();
    safeEmpty(diagnoseRetrieveLogs({ ...p.input, credential: 'missing' }), 'blocked');
    safeEmpty(diagnoseRetrieveLogs({ ...p.input, businessUnit: 'missing' }), 'blocked');
    safeEmpty(diagnoseRetrieveLogs({ ...p.input, key: '*' }), 'unsupported');
    safeEmpty(diagnoseRetrieveLogs({ ...p.input, limit: 1 }), 'unsupported');
    safeEmpty(
        diagnoseRetrieveLogs({
            ...p.input,
            workspaceRoot: path.join(p.input.workspaceRoot, 'missing'),
        }),
        'unavailable'
    );
});

test('reader enforces strict UTF8 and closed missing, mixed and ambiguous correlation', () => {
    const p = project();
    for (const [text, status] of [
        [Buffer.from([195, 40]), 'unsupported'],
        ['\0PRIVATE', 'unsupported'],
        ['PRIVATE', 'no-match'],
        [fixture().slice(0, 2).join('\n'), 'unsupported'],
        [[...fixture(), info(':: Retrieving sample/Other')].join('\n'), 'unsupported'],
        [[...fixture(), ...fixture()].join('\n'), 'ambiguous'],
    ]) {
        p.write(text);
        safeEmpty(diagnoseRetrieveLogs(p.input), status);
    }
});

test('reader fails closed for directory, candidate, file and total-byte budgets', () => {
    const entries = project();
    for (let i = 0; i <= RETRIEVE_LOG_LIMITS.directoryEntries; i++)
        entries.write('', `ignored-${i}`);
    safeEmpty(diagnoseRetrieveLogs(entries.input), 'blocked');
    const candidates = project();
    for (let i = 0; i <= RETRIEVE_LOG_LIMITS.candidates; i++)
        candidates.write('', `2026-10-22T12.00.${String(i).padStart(2, '0')}.000Z.log`);
    safeEmpty(diagnoseRetrieveLogs(candidates.input), 'blocked');
    const oversized = project();
    oversized.write(Buffer.alloc(RETRIEVE_LOG_LIMITS.fileBytes + 1));
    safeEmpty(diagnoseRetrieveLogs(oversized.input), 'blocked');
    const total = project();
    for (let i = 0; i < 5; i++)
        total.write(Buffer.alloc(RETRIEVE_LOG_LIMITS.fileBytes), `2026-10-22T12.00.0${i}.000Z.log`);
    safeEmpty(diagnoseRetrieveLogs(total.input), 'blocked');
});

test('reader rejects hardlinks, nonregular candidates and log-root junctions', () => {
    const hard = project();
    const outside = path.join(hard.input.workspaceRoot, 'PRIVATE');
    fs.writeFileSync(outside, fixture().join('\n'));
    fs.linkSync(outside, path.join(hard.logs, selection.file));
    safeEmpty(diagnoseRetrieveLogs(hard.input), 'blocked');
    const nonregular = project();
    fs.mkdirSync(path.join(nonregular.logs, selection.file));
    safeEmpty(diagnoseRetrieveLogs(nonregular.input), 'blocked');
    const linked = project();
    fs.rmdirSync(linked.logs);
    fs.symlinkSync(hard.logs, linked.logs, 'junction');
    safeEmpty(diagnoseRetrieveLogs(linked.input), 'blocked');
});

test('reader detects file replacement and directory drift during private read', () => {
    for (const mode of ['replace', 'directory', 'grow']) {
        const p = project();
        p.write();
        const logIdentity = fs.statSync(path.join(p.logs, selection.file)).ino;
        const original = fs.readSync;
        let changed = false;
        fs.readSync = (...args) => {
            const count = original(...args);
            if (!changed && fs.fstatSync(args[0]).ino === logIdentity) {
                changed = true;
                if (mode === 'replace') {
                    fs.renameSync(path.join(p.logs, selection.file), path.join(p.logs, 'old'));
                    p.write();
                } else if (mode === 'directory') p.write('PRIVATE', 'new-entry');
                else fs.appendFileSync(path.join(p.logs, selection.file), 'PRIVATE');
            }
            return count;
        };
        try {
            safeEmpty(diagnoseRetrieveLogs(p.input), 'blocked');
        } finally {
            fs.readSync = original;
        }
    }
});
