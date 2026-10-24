import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
    tryAcquire,
    block,
    release,
    isBlocked,
    acknowledgeExternalReconciliation,
} from '../dist/project-operation-guard.js';

// Synthetic identities only: these lifecycle tests perform no filesystem operations.
const project = () => path.join(String.raw`F:\Temp`, `mcdev-guard-${randomUUID()}`);

test('idle/running lifecycle case-folds roots and never reconciles a running operation', () => {
    const root = project();
    assert.equal(isBlocked(root), false);
    assert.equal(acknowledgeExternalReconciliation(root), false);
    release(root);
    assert.equal(tryAcquire(root), true);
    assert.equal(tryAcquire(root.toUpperCase()), false);
    assert.equal(isBlocked(root), false);
    assert.equal(acknowledgeExternalReconciliation(root.toUpperCase()), false);
    assert.equal(tryAcquire(root), false);
    release(root.toUpperCase());
    assert.equal(tryAcquire(root), true);
    release(root);
});

test('blocked exclusion survives release and requires explicit case-insensitive reconciliation', () => {
    const root = project();
    assert.equal(tryAcquire(root), true);
    block(root.toUpperCase());
    block(root);
    assert.equal(isBlocked(root.toUpperCase()), true);
    release(root);
    assert.equal(tryAcquire(root), false);
    assert.equal(acknowledgeExternalReconciliation(root.toUpperCase()), true);
    assert.equal(isBlocked(root), false);
    assert.equal(acknowledgeExternalReconciliation(root), false);
    assert.equal(tryAcquire(root), true);
    release(root);
});

test('projects remain independent and blocking an idle project latches exclusion', () => {
    const first = project();
    const second = project();
    block(first);
    assert.equal(tryAcquire(first), false);
    assert.equal(tryAcquire(second), true);
    release(first);
    assert.equal(isBlocked(first), true);
    assert.equal(isBlocked(second), false);
    assert.equal(acknowledgeExternalReconciliation(first), true);
    assert.equal(tryAcquire(second), false);
    release(second);
});
