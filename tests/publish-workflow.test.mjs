import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const workflow = fs
    .readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n');

test('MCP publication waits until npm serves the published version', () => {
    const steps = workflow.split(/^ {12}- /m).slice(1);
    // comment lines that introduce the next step belong to the text of this one
    const publish = steps.findIndex((step) => /^run: npm publish\s*(?:\n\s*#.*)*\s*$/.test(step));
    assert.ok(publish !== -1, 'npm publication step exists');
    const wait = steps[publish + 1];
    assert.match(wait, /^name: Wait until the version is available on npm\n/);
    // polls the public registry for the exact version instead of sleeping for a fixed time
    assert.match(
        wait,
        /until npm view "\$\{pkg_name\}@\$\{pkg_version\}" version --registry=https:\/\/registry\.npmjs\.org\/ --prefer-online/
    );
    assert.match(wait, /\n\s+sleep 30\n/);
    // gives up after 15 minutes and fails the job, so the registry step never runs too early
    assert.match(wait, /deadline=\$\(\( \$\(date \+%s\) \+ 900 \)\)/);
    assert.match(wait, /\n\s+exit 1\n/);
    assert.doesNotMatch(wait, /\bif:|continue-on-error:|always\(|failure\(/);
    for (const command of ['./mcp-publisher login github-oidc', './mcp-publisher publish']) {
        const index = steps.findIndex((step) => step.includes(`run: ${command}\n`));
        assert.ok(index > publish + 1, `${command} runs after the wait for npm`);
    }
});
