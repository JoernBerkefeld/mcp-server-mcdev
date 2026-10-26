/** Internal supervised transport, not authorization or proof of artifact completeness. */
import fs from 'node:fs';
import { createNativeEnvironment } from './temp-environment.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUTPUT_LIMIT = 1024 * 1024;
const GRACE_MS = 1000;
const MAX_TIMEOUT_MS = 120_000;
const NATIVE_COMMAND_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type StopReason = 'cancelled' | 'timed-out' | 'output-limit';
export interface NativeProcessInput {
    readonly projectRoot: string;
    readonly args: readonly string[];
}
export interface NativeProcessProgress {
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
}
export interface NativeProcessLifetime {
    readonly signal: AbortSignal;
    readonly timeoutMs?: number;
    /** Opt in to long-running commands; default wrappers retain legacy evidence and limits. */
    readonly nativeCommandMode?: boolean;
    /** Synchronous observer; retention/redaction belongs to the caller, not this transport. */
    readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
    readonly onProgress?: (progress: Readonly<NativeProcessProgress>) => void;
}
/** Trusted internal executable selection only; never accept this from tool arguments. */
export interface NativeProcessRuntime {
    readonly cliEntry: string;
}
export interface NativeProcessEvidence {
    readonly outcome:
        'invalid-input' | 'exited' | 'spawn-failed' | StopReason | 'termination-unconfirmed';
    readonly stopReason: StopReason | null;
    readonly started: boolean;
    readonly directChildClosed: boolean;
    readonly descendantsStopped: false;
    readonly exitCode: number | null;
    readonly exitSignal: NodeJS.Signals | null;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
    readonly partialEffectsPossible: boolean;
}

function canonical(candidate: string, directory: boolean): void {
    if (
        typeof candidate !== 'string' ||
        candidate.includes('\0') ||
        !path.isAbsolute(candidate) ||
        candidate.startsWith('\\\\') ||
        path.normalize(candidate) !== candidate ||
        candidate
            .split(path.sep)
            .some((part, index) =>
                index === 0 && process.platform === 'win32' && /^[a-z]:$/iu.test(part)
                    ? false
                    : part.toLowerCase() === '.mcdev-auth.json' ||
                      (process.platform === 'win32' && (/[ .:]$/u.test(part) || part.includes(':')))
            )
    )
        throw new Error('Invalid process path');
    let current = candidate;
    for (;;) {
        const stat = fs.lstatSync(current);
        const resolved = fs.realpathSync.native(current);
        if (stat.isSymbolicLink() || resolved !== current) {
            throw new Error('Invalid process path');
        }
        if (
            current === candidate &&
            (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
        ) {
            throw new Error('Invalid process path');
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}

/**
 * Launch one supervised process. Caller owns authorization, fixed argv, recheck and serialization.
 * Runtime selection is internal; tests substitute a synthetic package/CLI, never real account commands.
 * Paths must remain stable throughout launch; metadata checks are not a concurrent filesystem sandbox.
 * @param input - Canonical project and internally constructed command arguments after the CLI entry.
 * @param lifetime - Legacy: 30s default/120s max; opt-in commands: 30m default/24h max, streamed output.
 * @param runtime - Trusted installed CLI selection; no public argv, environment or Node override.
 * @returns {Promise<NativeProcessEvidence>} Output-free process evidence, never verified artifact success.
 */
export async function runNativeProcess(
    input: NativeProcessInput,
    lifetime: NativeProcessLifetime,
    runtime?: NativeProcessRuntime
): Promise<NativeProcessEvidence> {
    const state = {
        started: false,
        directChildClosed: false,
        descendantsStopped: false as const,
        exitCode: null as number | null,
        exitSignal: null as NodeJS.Signals | null,
        stdoutBytes: 0,
        stderrBytes: 0,
    };
    const result = (
        outcome: NativeProcessEvidence['outcome'],
        stopReason: StopReason | null = null
    ): NativeProcessEvidence =>
        Object.freeze({
            ...state,
            outcome,
            stopReason,
            partialEffectsPossible: state.started,
        });
    let cliEntry: string;
    let env: NodeJS.ProcessEnv;
    const generalMode = lifetime?.nativeCommandMode === true;
    const timeoutMs = lifetime?.timeoutMs ?? (generalMode ? 30 * 60 * 1000 : 30_000);
    try {
        if (
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs <= 0 ||
            timeoutMs > (generalMode ? NATIVE_COMMAND_MAX_TIMEOUT_MS : MAX_TIMEOUT_MS) ||
            !(lifetime.signal instanceof AbortSignal) ||
            (lifetime.nativeCommandMode !== undefined &&
                typeof lifetime.nativeCommandMode !== 'boolean') ||
            (lifetime.onOutput !== undefined && typeof lifetime.onOutput !== 'function') ||
            (lifetime.onProgress !== undefined && typeof lifetime.onProgress !== 'function')
        )
            throw new Error('Invalid lifetime');
        if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string'))
            throw new Error('Invalid arguments');
        canonical(input.projectRoot, true);
        canonical(process.execPath, false);
        cliEntry =
            runtime?.cliEntry ??
            path.join(path.dirname(fileURLToPath(import.meta.resolve('mcdev'))), 'cli.js');
        canonical(cliEntry, false);
        if (path.basename(cliEntry) !== 'cli.js' || path.basename(path.dirname(cliEntry)) !== 'lib')
            throw new Error('Invalid CLI');
        const manifestPath = path.join(path.dirname(path.dirname(cliEntry)), 'package.json');
        canonical(manifestPath, false);
        if (fs.statSync(manifestPath).size > 64 * 1024) throw new Error('Invalid manifest');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (
            manifest.name !== 'mcdev' ||
            manifest.version !== '10.1.1' ||
            manifest.bin?.mcdev !== 'lib/cli.js'
        )
            throw new Error('Unsupported CLI');
        env = createNativeEnvironment();
    } catch {
        return result('invalid-input');
    }
    if (lifetime.signal.aborted) return result('cancelled', 'cancelled');
    const argv = [cliEntry, ...input.args];
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(process.execPath, argv, {
                cwd: input.projectRoot,
                env,
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch {
            resolve(result('spawn-failed'));
            return;
        }
        let settled = false;
        let stopping: StopReason | null = null;
        let grace: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: NativeProcessEvidence['outcome']) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(grace);
            lifetime.signal.removeEventListener('abort', cancel);
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            resolve(result(outcome, stopping));
        };
        const stop = (reason: StopReason) => {
            if (settled || stopping) return;
            stopping = reason;
            // No independently trusted OS helper identity: never select executables from SYSTEMROOT.
            // Direct-child termination is bounded best effort, not proof that descendants stopped.
            grace = setTimeout(() => finish('termination-unconfirmed'), GRACE_MS);
            try {
                child.kill('SIGKILL');
            } catch {
                // A failed kill is not evidence of termination; wait for close or bounded grace.
            }
        };
        const cancel = () => stop('cancelled');
        const timer = setTimeout(() => stop('timed-out'), timeoutMs);
        lifetime.signal.addEventListener('abort', cancel, { once: true });
        child.on('spawn', () => {
            state.started = true;
        });
        child.on('error', () => {
            if (!stopping) finish('spawn-failed');
        });
        child.on('close', (code, signal) => {
            state.directChildClosed = true;
            state.exitCode = code;
            state.exitSignal = signal;
            if (!stopping) finish('exited');
            else if (generalMode) finish(stopping);
        });
        for (const [stream, counter] of [
            [child.stdout, 'stdoutBytes'],
            [child.stderr, 'stderrBytes'],
        ] as const) {
            stream?.on('data', (chunk: Buffer) => {
                state[counter] = Math.min(
                    generalMode ? Number.MAX_SAFE_INTEGER : OUTPUT_LIMIT + 1,
                    state[counter] + chunk.length
                );
                if (generalMode) {
                    // Observer failures must not leave pipes undrained or change process outcomes.
                    try {
                        lifetime.onOutput?.(counter === 'stdoutBytes' ? 'stdout' : 'stderr', chunk);
                    } catch {
                        // Diagnostics are best effort; the caller owns observer reliability.
                    }
                    try {
                        lifetime.onProgress?.(
                            Object.freeze({
                                stdoutBytes: state.stdoutBytes,
                                stderrBytes: state.stderrBytes,
                            })
                        );
                    } catch {
                        // Progress delivery is best effort and never stops the child.
                    }
                } else if (state.stdoutBytes + state.stderrBytes > OUTPUT_LIMIT)
                    stop('output-limit');
            });
            stream?.on('error', () => stop('output-limit'));
        }
        if (lifetime.signal.aborted) cancel();
    });
}
