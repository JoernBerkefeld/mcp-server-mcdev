/** Internal process-local exclusion shared by native project operation coordinators. */
const sessions = new Map<string, 'running' | 'blocked'>();
const sessionKey = (root: string) => (process.platform === 'win32' ? root.toLowerCase() : root);

/**
 * Acquire exclusion for an idle canonical project; callers validate canonical paths.
 * @param root - Canonical project root, case-folded on Windows only.
 * @returns {boolean} Whether this operation acquired the project.
 */
export function tryAcquire(root: string): boolean {
    const key = sessionKey(root);
    if (sessions.has(key)) return false;
    sessions.set(key, 'running');
    return true;
}

/**
 * Latch exclusion when operation effects or termination remain uncertain.
 * @param root - Canonical project root.
 */
export function block(root: string): void {
    sessions.set(sessionKey(root), 'blocked');
}

/**
 * Release running exclusion only; uncertain operations remain blocked.
 * @param root - Canonical project root.
 */
export function release(root: string): void {
    const key = sessionKey(root);
    if (sessions.get(key) === 'running') sessions.delete(key);
}

/**
 * Inspect whether external reconciliation is required.
 * @param root - Canonical project root.
 * @returns {boolean} Whether exclusion is latched as blocked.
 */
export function isBlocked(root: string): boolean {
    return sessions.get(sessionKey(root)) === 'blocked';
}

/**
 * Acknowledge host-completed external reconciliation; never release a running operation.
 * @param root - Canonical project root whose external reconciliation completed.
 * @returns {boolean} Whether a blocked project was explicitly released.
 */
export function acknowledgeExternalReconciliation(root: string): boolean {
    const key = sessionKey(root);
    if (sessions.get(key) !== 'blocked') return false;
    sessions.delete(key);
    return true;
}
