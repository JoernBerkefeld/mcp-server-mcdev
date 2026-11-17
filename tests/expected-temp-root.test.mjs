import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedTempRoot } from './expected-temp-root.mjs';

test('the local temp pin applies on Windows only', () => {
    assert.equal(expectedTempRoot({}, 'win32'), String.raw`f:\temp`);
    assert.equal(expectedTempRoot({ CI: 'true' }, 'win32'), false);
    assert.equal(expectedTempRoot({}, 'linux'), false);
    assert.equal(expectedTempRoot({}, 'darwin'), false);
});

test('MCDEV_EXPECTED_TEMP overrides the default, also on CI', () => {
    assert.equal(
        expectedTempRoot({ CI: 'true', MCDEV_EXPECTED_TEMP: 'D:\\Scratch\\' }, 'win32'),
        String.raw`d:\scratch`
    );
});
