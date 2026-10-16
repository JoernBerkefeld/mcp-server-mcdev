import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const script = new URL('../scripts/bundle-wiki.mjs', import.meta.url);

test('wiki builds keep committed content; refresh and explicit source opt into copying', () => {
    if (process.platform === 'win32') {
        for (const value of [process.env.TEMP, os.tmpdir(), process.env.TMP, process.env.TMPDIR]) {
            if (value) {
                assert.ok(path.isAbsolute(value));
                assert.equal(path.resolve(value).toLowerCase(), String.raw`f:\temp`);
            }
        }
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-wiki-test-'));
    const packageRoot = path.join(root, 'package');
    const scriptDir = path.join(packageRoot, 'scripts');
    const bundle = path.join(packageRoot, 'bundled', 'wiki');
    const sibling = path.join(root, 'sfmc-devtools.wiki');
    const frozen = path.join(root, 'frozen');
    const registered = [scriptDir, bundle, sibling, frozen];
    fs.writeFileSync(
        path.join(root, 'ownership.json'),
        JSON.stringify({ owner: randomUUID(), registered })
    );
    for (const directory of registered) {
        assert.ok(path.relative(root, directory));
        assert.ok(!path.relative(root, directory).startsWith('..'));
        fs.mkdirSync(directory, { recursive: true });
    }
    const fixtureScript = path.join(scriptDir, 'bundle-wiki.mjs');
    fs.copyFileSync(script, fixtureScript);
    fs.writeFileSync(path.join(bundle, 'Home.md'), 'committed pending annotation\n');
    fs.writeFileSync(path.join(sibling, 'Home.md'), 'dirty sibling\n');
    fs.writeFileSync(path.join(frozen, 'Home.md'), 'reviewed frozen source\n');
    const env = { ...process.env, SFMC_DEVTOOLS_WIKI: '' };

    execFileSync(process.execPath, [fixtureScript], { env });
    assert.equal(
        fs.readFileSync(path.join(bundle, 'Home.md'), 'utf8'),
        'committed pending annotation\n'
    );
    execFileSync(process.execPath, [fixtureScript, '--refresh'], { env });
    assert.equal(fs.readFileSync(path.join(bundle, 'Home.md'), 'utf8'), 'dirty sibling\n');
    execFileSync(process.execPath, [fixtureScript, '--refresh'], {
        env: { ...env, SFMC_DEVTOOLS_WIKI: frozen },
    });
    assert.equal(fs.readFileSync(path.join(bundle, 'Home.md'), 'utf8'), 'reviewed frozen source\n');
    const missing = spawnSync(process.execPath, [fixtureScript], {
        env: { ...env, SFMC_DEVTOOLS_WIKI: path.join(root, 'missing') },
    });
    assert.notEqual(missing.status, 0);
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    const emptyResult = spawnSync(process.execPath, [fixtureScript], {
        env: { ...env, SFMC_DEVTOOLS_WIKI: empty },
    });
    assert.notEqual(emptyResult.status, 0);
    assert.equal(fs.readFileSync(path.join(bundle, 'Home.md'), 'utf8'), 'reviewed frozen source\n');
    // Retain owned OS-temp fixtures; never recursively delete an unvalidated tree.
});
