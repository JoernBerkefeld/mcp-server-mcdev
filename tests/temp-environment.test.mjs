import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTempEnvironment, createNativeEnvironment } from '../dist/temp-environment.js';

// Pure policy inputs only: never mutate real temp configuration or create unsafe fixtures.
test('native temp policy accepts custom Windows drives and independent configured variables', () => {
    const source = Object.freeze({
        TEMP: String.raw`C:\Users\demo\AppData\Local\Temp`,
        TMP: 'G:/scratch/cache/',
        TMPDIR: 'H:/Build/../Temp/',
    });
    assert.doesNotThrow(() => validateTempEnvironment(source, source.TMP, 'win32'));
    assert.doesNotThrow(() => validateTempEnvironment({}, String.raw`C:\Windows\Temp`, 'win32'));
    assert.doesNotThrow(() =>
        validateTempEnvironment({}, String.raw`\\server\share\scratch`, 'win32')
    );
});

test('native temp policy accepts POSIX defaults, mixed case, and native variable precedence', () => {
    assert.doesNotThrow(() => validateTempEnvironment({}, '/tmp', 'linux'));
    assert.doesNotThrow(() => validateTempEnvironment({ TEMP: '', TMP: '' }, '/var/tmp', 'darwin'));
    assert.doesNotThrow(() =>
        validateTempEnvironment(
            {
                TMPDIR: '/private/var/folders/cache/',
                TMP: '/var/tmp',
                TEMP: '/Temp/../Temp',
            },
            '/private/var/folders/cache',
            'darwin'
        )
    );
});

for (const [platform, valid, invalid] of [
    [
        'win32',
        String.raw`C:\Users\demo\Temp`,
        [
            '',
            'relative',
            'C:',
            'C:relative',
            'C:/',
            'C:\\',
            '/scratch',
            String.raw`\scratch`,
            'C:/scratch/..',
            '\\\\server\\share\\',
            'C:/bad\0path',
        ],
    ],
    ['linux', '/tmp', ['', 'relative', '/', '/tmp/..', 'C:', 'C:/scratch', '/bad\0path']],
]) {
    test(`${platform} rejects unsafe effective and configured paths through production builder`, () => {
        for (const candidate of invalid) {
            assert.throws(
                () => createNativeEnvironment({}, candidate, platform),
                /Invalid temporary environment/u,
                JSON.stringify(candidate)
            );
            if (!candidate) continue; // Empty optional variables are native fallbacks.
            for (const name of ['TEMP', 'TMP', 'TMPDIR', 'temp', 'Tmp', 'tmpdir']) {
                assert.throws(
                    () => createNativeEnvironment({ [name]: candidate }, valid, platform),
                    /Invalid temporary environment/u,
                    `${name}: ${JSON.stringify(candidate)}`
                );
            }
        }
    });
}

test('child environment preserves allowed temp configuration without leaking caller injections', () => {
    const source = Object.freeze({
        PATH: '/usr/bin',
        TMPDIR: '/var/tmp/build',
        TEMP: '/tmp/other',
        NODE_OPTIONS: '--require=private',
        NODE_PATH: '/private',
        HTTP_PROXY: 'private',
        SECRET_TEST_TOKEN: 'private',
        npm_config_userconfig: '/private',
        NO_COLOR: '0',
    });
    assert.deepEqual(createNativeEnvironment(source, source.TMPDIR, 'linux'), {
        PATH: source.PATH,
        TMPDIR: source.TMPDIR,
        TEMP: source.TEMP,
        NO_COLOR: '1',
    });
    assert.deepEqual(createNativeEnvironment({}, '/tmp', 'linux'), { NO_COLOR: '1' });
});
