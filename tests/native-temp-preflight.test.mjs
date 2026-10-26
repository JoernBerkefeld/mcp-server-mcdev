import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Keep the development machine's Windows policy without imposing it on CI hosts.
export function preflight(
    source = process.env,
    temporaryDirectory = os.tmpdir(),
    platform = process.platform
) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    for (const [name, value] of Object.entries({
        TEMP: source.TEMP,
        TMP: source.TMP,
        TMPDIR: source.TMPDIR,
        tmpdir: temporaryDirectory,
    })) {
        if (!value && name !== 'tmpdir' && (name !== 'TEMP' || platform !== 'win32')) continue;
        assert.ok(value && paths.isAbsolute(value), `${name} must be absolute`);
        assert.ok(!value.includes('\0'), `${name} must not contain NUL`);
        const normalized = paths.normalize(value);
        assert.notEqual(normalized, paths.parse(normalized).root, `${name} must not be a root`);
        if (platform === 'win32') {
            assert.match(value, /^[a-z]:[\\/]/iu, `${name} must be drive-absolute`);
            assert.equal(
                paths
                    .resolve(value)
                    .replace(/[\\/]+$/u, '')
                    .toLowerCase(),
                String.raw`f:\temp`,
                name
            );
        }
    }
}

for (const platform of ['win32', 'linux', 'darwin']) {
    test(`native temp preflight follows ${platform} path and environment rules`, () => {
        const windows = platform === 'win32';
        const temporaryDirectory = windows ? String.raw`F:\Temp` : '/var/tmp/native-tests';
        const source = Object.freeze(windows ? { TEMP: 'f:/TEMP/' } : {});
        assert.doesNotThrow(() => preflight(source, temporaryDirectory, platform));
        assert.doesNotThrow(() =>
            preflight(
                { ...source, TMP: temporaryDirectory, TMPDIR: temporaryDirectory },
                temporaryDirectory,
                platform
            )
        );
        // Non-Windows configured paths may differ: native OS precedence selects tmpdir.
        if (windows) {
            assert.throws(() => preflight({}, temporaryDirectory, platform));
            assert.throws(() => preflight({ TEMP: 'C:/Temp' }, temporaryDirectory, platform));
            assert.throws(() => preflight(source, 'C:/Temp', platform));
            assert.throws(() => preflight(source, String.raw`\Temp`, platform));
        } else {
            assert.doesNotThrow(() =>
                preflight(
                    { TEMP: '/tmp/other', TMPDIR: '/tmp/native' },
                    temporaryDirectory,
                    platform
                )
            );
        }
        for (const invalid of [
            '',
            'relative',
            windows ? 'F:\\' : '/',
            windows ? 'F:' : '/tmp/..',
        ]) {
            assert.throws(() => preflight(source, invalid, platform));
        }
        for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
            for (const invalid of ['relative', windows ? 'F:\\' : '/', 'bad\0path']) {
                assert.throws(() =>
                    preflight({ ...source, [name]: invalid }, temporaryDirectory, platform)
                );
            }
        }
    });
}
