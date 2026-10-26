import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeDiagnostics } from '../dist/native-diagnostics.js';

test('reviewed mcdev failure and progress templates produce actionable fixed diagnostics', () => {
    const collector = createNativeDiagnostics();
    collector.write(
        'stdout',
        '17:29:00 info: mcdev:: Retrieve\n17:29:01 info: Downloaded: query (12)\n'
    );
    collector.write(
        'stderr',
        [
            '17:29:02 error: Could not find .mcdevrc.json in F:/private/customer.',
            'warn: Installed package has insufficient access. You might encounter malfunctions!',
            'warn: Missing scope: private-scope-name',
            'error:  - Retrieving query failed',
            "Run 'mcdev init' to initialize your project.",
            "Run 'mcdev upgrade' now to fix this.",
            "Your Accenture SFMC DevTools version 10.0.0 is lower than your project's config version 10.1.0",
            'Error: connect ECONNREFUSED 127.0.0.1:443',
            "Error: EACCES: permission denied, open 'F:/private/customer'",
        ].join('\n')
    );
    const result = collector.finish();
    assert.deepEqual(
        result.messages.map(({ code }) => code),
        [
            'retrieve-started',
            'download-reported',
            'configuration-missing',
            'insufficient-access',
            'missing-scope',
            'retrieve-failed',
            'initialization-required',
            'upgrade-required',
            'version-mismatch',
            'connection-failed',
            'filesystem-access-denied',
        ]
    );
    assert.equal(result.messages[0].stream, 'stdout');
    assert.equal(result.messages[2].stream, 'stderr');
    assert.match(result.messages[2].message, /mcdev init/u);
    assert.match(result.messages[1].message, /does not verify/u);
    assert.doesNotMatch(JSON.stringify(result), /private|127\.0\.0\.1|customer/u);
    assert.equal(result.suppressed, false);
    assert.equal(result.truncated, false);
});

const buildDeployCases = [
    ['No templates created. Aborting build', 'build-no-templates'],
    [":: 'PRIVATE_SELECTOR' is not a valid metadata type", 'metadata-type-invalid'],
    [
        ":: 'PRIVATE_SELECTOR' is not a valid metadata type. Please don't include subtypes.",
        'metadata-type-invalid',
    ],
    [
        "Could not find the market 'PRIVATE_MARKET' in your configuration file.",
        'build-market-missing',
    ],
    ['☇ skipped query PRIVATE_TEMPLATE: template not found', 'build-template-missing'],
    ['mcdev.buildDefinition: PRIVATE_BUILD_ERROR', 'build-definition-failed'],
    ['Please define properties.marketList in your config', 'build-market-list-missing'],
    [
        'Please create a directory called deploy and include your metadata in it: F:/PRIVATE_PATH',
        'deploy-directory-missing',
    ],
    ['No metadata found in deploy folder for selected BU', 'deploy-metadata-missing'],
    ['No metadata found in deploy folder for selected BU & type', 'deploy-metadata-missing'],
    ['No metadata found for deployment', 'deploy-metadata-missing'],
    ['No deployable metadata found for type query ', 'deploy-selection-empty'],
    [
        'No deployable metadata found for type query with keys PRIVATE_KEYS',
        'deploy-selection-empty',
    ],
    ['mcdev.deploy failed: PRIVATE_DEPLOY_ERROR', 'deploy-failed'],
    ['Upserting query failed: PRIVATE_UPSERT_ERROR', 'deploy-failed'],
    ['query upsert: 1 of 2 created / 3 of 4 updated / 5 filtered', 'deploy-upsert-reported'],
    ['query upsert: 0 of 0 created / 0 of 1 updated', 'deploy-upsert-reported'],
    [' - failed to publish triggeredSend: PRIVATE_KEY - PRIVATE_REASON', 'publish-failed'],
    ['Published 1 of 2 items', 'publish-summary-reported'],
];

test('reviewed build/deploy failures and summaries provide fixed actionable categories', () => {
    for (const [line, code] of buildDeployCases) {
        const collector = createNativeDiagnostics();
        collector.write('stderr', `error: ${line}\n`);
        const result = collector.finish();
        assert.equal(result.messages.length, 1, line);
        assert.equal(result.messages[0].code, code, line);
        assert.equal(result.messages[0].stream, 'stderr');
        assert.ok(result.messages[0].message.length > 50);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
        assert.equal(result.suppressed, false);
        assert.equal(result.truncated, false);
    }
});

test('build/deploy templates preserve chunk, control and API payload suppression', () => {
    for (const [line] of buildDeployCases) {
        const content = Buffer.from(`\u001B[31m17:29:00 error:\u001B[0m ${line}\u202E\r\n`);
        const whole = createNativeDiagnostics();
        whole.write('stderr', content);
        const expected = whole.finish();
        for (let split = 0; split <= content.length; split++) {
            const collector = createNativeDiagnostics();
            collector.write('stderr', content.subarray(0, split));
            collector.write('stderr', content.subarray(split));
            assert.deepEqual(collector.finish(), expected, `${line} split ${split}`);
        }
        for (const suffix of [
            ' {"api":"PRIVATE_BODY"}',
            ' <SOAP>PRIVATE_BODY</SOAP>',
            ' Bearer PRIVATE_TOKEN',
        ]) {
            const collector = createNativeDiagnostics();
            collector.write('stderr', `${line}${suffix}\n`);
            assert.deepEqual(collector.finish(), {
                messages: [],
                suppressed: true,
                truncated: false,
            });
        }
    }
});

test('build/deploy matching rejects arbitrary wrappers and respects retention limits', () => {
    const collector = createNativeDiagnostics();
    for (const line of [
        'prefix No templates created. Aborting build',
        'No templates created. Aborting build suffix',
        'Published 1 of 2 items suffix',
        'debug: mcdev.deploy failed: PRIVATE_ERROR',
    ]) {
        collector.write('stderr', `${line}\n`);
    }
    assert.deepEqual(collector.finish(), { messages: [], suppressed: true, truncated: false });
    const bounded = createNativeDiagnostics();
    bounded.write('stderr', 'mcdev.deploy failed: PRIVATE_ERROR\n'.repeat(100));
    bounded.write('stdout', 'unreviewed PRIVATE_TRAILER\n');
    const result = bounded.finish();
    assert.ok(result.messages.length <= 32);
    assert.ok(result.messages.reduce((total, { message }) => total + message.length, 0) <= 4096);
    assert.equal(result.truncated, true);
    assert.equal(result.suppressed, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
});

test('missing authentication diagnostics never reproduce file paths or contents', () => {
    const collector = createNativeDiagnostics();
    collector.write('stderr', 'Could not find .mcdev-auth.json in F:/confidential.\n');
    collector.write(
        'stderr',
        ".mcdev-auth.json not found. Please run 'mcdev init' to provide the missing credential details."
    );
    const result = collector.finish();
    assert.deepEqual(
        result.messages.map(({ code }) => code),
        ['authentication-missing', 'authentication-missing']
    );
    assert.doesNotMatch(JSON.stringify(result), /confidential|\.mcdev-auth\.json/u);
});

test('unknown errors, credentials, tokens, API bodies and debug payloads are suppressed', () => {
    const collector = createNativeDiagnostics();
    collector.write(
        'stderr',
        [
            'error: unreviewed server message SECRET_ONE',
            'Authorization: Bearer SECRET_TWO',
            'client_secret=SECRET_THREE',
            'access_token=SECRET_FOUR',
            '{"message":"ETIMEDOUT","token":"SECRET_FIVE"}',
            '<SOAP-ENV:Body>SECRET_SIX</SOAP-ENV:Body>',
            '17:29:00 debug: Downloaded: query (1)',
            'Error: EACCES Bearer SECRET_SEVEN',
            'Missing scope: password=SECRET_EIGHT',
            'Error: ETIMEDOUT {"payload":"SECRET_NINE"}',
            '    at secretFunction (F:/private/file.js:1:1)',
            '🔑 account=SECRET_TEN',
        ].join('\n')
    );
    assert.deepEqual(collector.finish(), { messages: [], suppressed: true, truncated: false });
});

test('untrusted captures are projected to fixed messages rather than universally redacted', () => {
    const collector = createNativeDiagnostics();
    collector.write('stderr', 'Missing scope: UNLABELLED_SECRET\n');
    collector.write('stderr', 'ETIMEDOUT arbitrary personal information\n');
    collector.write('stdout', 'Downloaded: SecretMetadata (123) private remote response\n');
    const result = collector.finish();
    assert.equal(result.messages.length, 3);
    assert.doesNotMatch(
        JSON.stringify(result),
        /UNLABELLED|personal|SecretMetadata|123|remote response/u
    );
});

test('ANSI colors, OSC sequences, control and bidi text do not reach the result', () => {
    const collector = createNativeDiagnostics();
    collector.write('stderr', '\u001B[31merror:\u001B[0m \u001B]0;SECRET_TITLE\u0007');
    collector.write('stderr', 'Missing scope: test\u202E\u0000\u0008\n');
    const result = collector.finish();
    assert.equal(result.messages[0].code, 'missing-scope');
    assert.doesNotMatch(JSON.stringify(result), /SECRET_TITLE|\\u001b|\\u0000|\\u0008|\u202E/u);
});

test('UTF-8, ANSI and log prefix splits produce the same result as whole chunks', () => {
    const content = Buffer.from(
        '\u001B[31m17:29:00 error:\u001B[0m Could not find .mcdevrc.json in F:/Jörn/🔒.\r\n' +
            'warn: Missing scope: café\n'
    );
    const whole = createNativeDiagnostics();
    whole.write('stderr', content);
    const expected = whole.finish();
    for (let split = 0; split <= content.length; split++) {
        const collector = createNativeDiagnostics();
        collector.write('stderr', content.subarray(0, split));
        collector.write('stderr', content.subarray(split));
        assert.deepEqual(collector.finish(), expected, `split ${split}`);
    }
    const bytewise = createNativeDiagnostics();
    for (const byte of content) bytewise.write('stderr', Buffer.from([byte]));
    assert.deepEqual(bytewise.finish(), expected);
});

test('streams retain independent partial lines and decoders', () => {
    const collector = createNativeDiagnostics();
    collector.write('stdout', Buffer.from('Missing sco'));
    collector.write('stderr', Buffer.from('Error: ECONN'));
    collector.write('stdout', Buffer.from('pe: café\n'));
    collector.write('stderr', Buffer.from('RESET\n'));
    assert.deepEqual(
        collector.finish().messages.map(({ stream, code }) => [stream, code]),
        [
            ['stdout', 'missing-scope'],
            ['stderr', 'connection-failed'],
        ]
    );
});

test('mixed string/buffer chunks and incomplete UTF-8 flush safely without exposing input', () => {
    const collector = createNativeDiagnostics();
    collector.write('stderr', Buffer.from('Missing scope: '));
    collector.write('stderr', Buffer.from([195]));
    collector.write('stderr', 'private\n');
    collector.write('stdout', Buffer.from([240, 159]));
    const result = collector.finish();
    assert.equal(result.messages[0].code, 'missing-scope');
    assert.equal(result.suppressed, true);
    assert.doesNotMatch(JSON.stringify(result), /private|�/u);
});

test('oversized lines are discarded entirely while subsequent lines still drain', () => {
    const collector = createNativeDiagnostics();
    collector.write('stderr', 'Missing scope: ');
    for (let index = 0; index < 100; index++) collector.write('stderr', 'SECRET'.repeat(1024));
    collector.write('stderr', '\nError: ENOTFOUND\n');
    collector.write('stdout', 'mcdev:: Retrieve\r');
    const result = collector.finish();
    assert.deepEqual(
        result.messages.map(({ code }) => code),
        ['connection-failed', 'retrieve-started']
    );
    assert.equal(result.suppressed, true);
    assert.equal(result.truncated, true);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/u);
});

test('total retention is bounded while all later chunks and streams continue to drain', () => {
    const collector = createNativeDiagnostics();
    collector.write('stdout', 'mcdev:: Retrieve\n'.repeat(10_000));
    collector.write('stderr', 'private final unknown line\n');
    const result = collector.finish();
    assert.equal(result.messages.length, 32);
    assert.ok(result.messages.reduce((size, { message }) => size + message.length, 0) <= 4096);
    assert.equal(result.truncated, true);
    assert.equal(result.suppressed, true);
    assert.ok(JSON.stringify(result).length < 10_000);
});

test('longer projected messages remain within the total text budget', () => {
    const collector = createNativeDiagnostics();
    const line =
        "Your Accenture SFMC DevTools version 10.0.0 is lower than your project's config version 10.1.0\n";
    collector.write('stderr', line.repeat(100));
    const result = collector.finish();
    const size = result.messages.reduce((total, { message }) => total + message.length, 0);
    assert.ok(size <= 4096);
    assert.ok(result.messages.length <= 32);
    assert.equal(result.truncated, true);
    assert.equal(result.suppressed, false);
});

test('line overflow at EOF never projects a valid-looking prefix', () => {
    const collector = createNativeDiagnostics();
    collector.write('stderr', `Missing scope: ${'x'.repeat(4096)}`);
    assert.deepEqual(collector.finish(), { messages: [], suppressed: true, truncated: true });
});

test('finish flushes both lines once, returns a frozen stable snapshot and ignores later writes', () => {
    const collector = createNativeDiagnostics();
    collector.write('stdout', 'mcdev:: Retrieve');
    collector.write('stderr', 'Error: ETIMEDOUT');
    const result = collector.finish();
    assert.equal(result.messages.length, 2);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.messages));
    assert.ok(Object.isFrozen(result.messages[0]));
    collector.write('stderr', 'unknown\n');
    assert.equal(collector.finish(), result);
    assert.equal(result.suppressed, false);
});

test('empty and blank streams have no suppression or truncation', () => {
    const collector = createNativeDiagnostics();
    collector.write('stdout', Buffer.alloc(0));
    collector.write('stderr', '\r\n \t\n');
    assert.deepEqual(collector.finish(), { messages: [], suppressed: false, truncated: false });
});
