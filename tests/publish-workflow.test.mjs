import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const workflow = fs
    .readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n');

test('MCP publication waits five minutes after successful npm publication', () => {
    const steps = workflow.split(/^ {12}- /m).slice(1);
    const publish = steps.findIndex((step) => /^run: npm publish\s*$/.test(step));
    assert.ok(publish !== -1, 'npm publication step exists');
    const wait = steps[publish + 1];
    assert.match(wait, /^name: Wait for npm registry propagation\n {14}run: sleep 300\s*$/);
    assert.doesNotMatch(wait, /\bif:|continue-on-error:|always\(|failure\(/);
    for (const command of ['./mcp-publisher login github-oidc', './mcp-publisher publish']) {
        const index = steps.findIndex((step) => step.includes(`run: ${command}\n`));
        assert.ok(index > publish + 1, `${command} runs after the propagation delay`);
    }
});
