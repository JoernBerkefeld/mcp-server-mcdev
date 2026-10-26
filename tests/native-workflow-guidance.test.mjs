import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    NATIVE_WORKFLOW_GUIDANCE,
    NATIVE_WORKFLOW_INSTRUCTIONS,
} from '../dist/native-workflow-guidance.js';

test('native workflow guidance is immutable and can be embedded without a runner import', () => {
    assert.ok(Object.isFrozen(NATIVE_WORKFLOW_INSTRUCTIONS));
    assert.equal(NATIVE_WORKFLOW_INSTRUCTIONS.length, 8);
    assert.equal(NATIVE_WORKFLOW_GUIDANCE, NATIVE_WORKFLOW_INSTRUCTIONS.join('\n'));
    assert.throws(() => NATIVE_WORKFLOW_INSTRUCTIONS.push('injected'), TypeError);
});

test('guidance covers native choices, honest results, companion fallback and explicit actions', () => {
    for (const expectation of [
        /run_mcdev_command.*retrieve, deploy, build, buildTemplate, buildDefinition, buildDefinitionBulk and clone/u,
        /supports badKeys and document reports, explainTypes --json catalogs/u,
        /getFilesToCommit execution is blocked.*CLI discards its result/u,
        /ordinary host approval/u,
        /explicit credential\/BU target.*explicit native choices/u,
        /do not replace it with a second CLI parser/u,
        /Prompt-dependent cases without explicit choices are blocked/u,
        /--fixShared=ChildA,ChildB.*configured child selections are validated.*installed native CLI/u,
        /Missing companion.*do not block otherwise supported native work/u,
        /A useful result is not independently verified success/u,
        /zero exit code.*do not prove/u,
        /Native cleanup.*authentication.*executable validation hooks/u,
        /No implicit deploy or runtime action/u,
        /explicit operation-specific intent/u,
    ]) {
        assert.match(NATIVE_WORKFLOW_GUIDANCE, expectation);
    }
});
