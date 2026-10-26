import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readProjectConfig } from './project-inspection.js';
import {
    normalizeNativeCommandRun,
    validateNativeSharedSelection,
} from './native-command-contract.js';
import { createNativeDiagnostics } from './native-diagnostics.js';
import { createNativeCommandResults, nativeResultBlock } from './native-command-results.js';
import { runNativeProcess, type NativeProcessRuntime } from './native-process.js';
import * as guard from './project-operation-guard.js';
import { getBundledMcdevVersion } from './mcdev-safe.js';

const mcdevRequire = createRequire(createRequire(import.meta.url).resolve('mcdev'));
const parse = createRequire(mcdevRequire.resolve('yargs'))('yargs-parser') as (
    args: readonly string[],
    options: Record<string, unknown>
) => Record<string, unknown> & { _: unknown[] };

/**
 * Narrow object view; inherited names never select credentials or business units.
 * @param value - Untrusted parsed JSON value.
 * @returns {Record<string, unknown>} Own-property lookup object or an empty object.
 */
function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * Validate native selectors without loading authentication or rewriting native arguments.
 * @param root - Canonical project directory.
 * @param command - Validated native command name.
 * @param args - Native argv after explicit choice extraction.
 * @returns {{config: Record<string, unknown>, credentialNames: string[]}} Private configuration and selected deployment credentials.
 */
function validateProjectSelections(
    root: string,
    command: string,
    args: readonly string[]
): { config: Record<string, unknown>; credentialNames: string[] } {
    const config = readProjectConfig(root).config;
    const credentialNames = new Set<string>();
    if (command === 'explainTypes') return { config, credentialNames: [] };
    const credentials = record(config.credentials);
    const parsed = parse(args, {
        string: [
            'buFrom',
            'buTo',
            'metadata',
            'marketFrom',
            'marketTo',
            'market',
            ...(command === 'retrieve' ? ['like'] : []),
            ...(command === 'deploy'
                ? ['keySuffix', 'ks', 'changeKeyField', 'ckf', 'changeKeyValue', 'ckv', 'fixShared']
                : []),
        ],
        array: [
            { key: 'metadata', string: true },
            { key: 'marketFrom', string: true },
            { key: 'marketTo', string: true },
            { key: 'market', string: true },
        ],
        key: Object.fromEntries(
            ['metadata', 'buFrom', 'buTo', 'marketFrom', 'marketTo', 'market'].map((key) => [
                key,
                true,
            ])
        ),
        alias: {
            buFrom: ['bf'],
            buTo: ['bt'],
            metadata: ['m'],
            marketFrom: ['mf'],
            marketTo: ['mt'],
        },
        boolean: [
            'bulk',
            'verbose',
            'debug',
            'silent',
            'noLogColors',
            'noLogFile',
            'errorLog',
            ...(['explainTypes', 'resolveId'].includes(command) ? ['json'] : []),
            ...(command === 'retrieve'
                ? ['format', 'f', 'purge', 'onlyPublished', 'op', 'skipValidation', 'sv', 'fix']
                : []),
            ...(command === 'deploy'
                ? [
                      'autoMidSuffix',
                      'fromRetrieve',
                      'fr',
                      'refresh',
                      'r',
                      'execute',
                      'e',
                      'schedule',
                      's',
                      'format',
                      'f',
                      'noUpdate',
                      'publish',
                      'validate',
                      'skipStatusCheck',
                      'matchName',
                      'skipValidation',
                      'sv',
                      'ignoreFolder',
                      'if',
                      'ignoreSfFields',
                      'isf',
                      'fix',
                  ]
                : []),
            ...(['build', 'clone', 'buildTemplate'].includes(command)
                ? ['dependencies', 'D', 'retrieve', 'r']
                : []),
            ...(['build', 'clone'].includes(command) ? ['purge'] : []),
            ...(['build', 'buildTemplate'].includes(command) ? ['shareAsset'] : []),
            ...(command === 'clone' ? ['skipValidation', 'sv'] : []),
            ...(['buildDefinition', 'buildDefinitionBulk'].includes(command)
                ? ['skipValidation', 'sv', 'purge', 'fix']
                : []),
        ],
        configuration: { 'parse-positional-numbers': false },
    });
    const checkBU = (selector: unknown, wildcard = false): void => {
        if (wildcard && selector === '*') {
            if (!Object.keys(credentials).length) throw new Error('Invalid project selection');
            for (const credential of Object.keys(credentials)) checkBU(`${credential}/*`, true);
            return;
        }
        if (typeof selector !== 'string') throw new Error('Invalid project selection');
        const parts = selector.split('/');
        const [credential, bu] = parts;
        const entry = Object.hasOwn(credentials, credential) ? record(credentials[credential]) : {};
        const units = record(entry.businessUnits);
        if (parts.length !== 2 || !credential || !bu || !Object.keys(units).length) {
            throw new Error('Invalid project selection');
        }
        if (wildcard && bu === '*') {
            for (const unit of Object.keys(units)) checkBU(`${credential}/${unit}`);
            return;
        }
        if (!Object.hasOwn(units, bu) || !units[bu] || bu === '*') {
            throw new Error('Invalid project selection');
        }
        credentialNames.add(credential);
    };
    const checkList = (name: unknown): void => {
        const lists = record(config.marketList);
        if (typeof name !== 'string' || !Object.hasOwn(lists, name)) {
            throw new Error('Invalid project selection');
        }
        const targets = Object.keys(record(lists[name])).filter(
            (key) => key !== 'description' && key !== 'filter'
        );
        if (!targets.length) throw new Error('Invalid project selection');
        for (const target of targets) checkBU(target);
    };
    if (command === 'build' || command === 'clone') {
        checkBU(parsed.buFrom);
        if (parsed.buTo !== undefined) checkBU(parsed.buTo);
        if (command === 'build' && parsed.bulk) {
            const targets = Array.isArray(parsed.marketTo) ? parsed.marketTo : [parsed.marketTo];
            checkList(targets[0]);
        }
    } else if (command === 'buildDefinitionBulk') {
        checkList(parsed._[0]);
    } else {
        checkBU(parsed._[0], command === 'retrieve' || command === 'deploy');
    }
    return { config, credentialNames: [...credentialNames] };
}

/** Host request lifetime; progress contains no native output or account data. */
export interface NativeCommandLifetime {
    readonly signal: AbortSignal;
    readonly progress?: (elapsedSeconds: number) => void;
}

/**
 * Resolve a project identity without reading authentication or returning configuration.
 * This is identity validation, not an external filesystem lock or a project-code sandbox.
 * @param root - Absolute developer-selected project directory.
 * @returns {string} Canonical native identity.
 */
function projectIdentity(root: string): string {
    const identity = fs.realpathSync.native(root);
    if (!fs.statSync(identity).isDirectory() || identity === path.parse(identity).root) {
        throw new Error('workspaceRoot must identify a project directory, not a filesystem root');
    }
    const config = path.join(identity, '.mcdevrc.json');
    const stat = fs.lstatSync(config);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('A regular .mcdevrc.json is required; initialize the project first');
    }
    return identity;
}

/**
 * Run one explicitly requested native command, preserving native argv and effects.
 * Ordinary host approval is external; this function adds no consent/token exchange.
 * @param input - Strict native command envelope.
 * @param lifetime - Cancellation and optional content-free progress callback.
 * @param runtime - Internal synthetic CLI seam for offline tests only.
 * @returns {Promise<object>} Native process evidence and bounded diagnostic projection, not synchronization proof.
 */
export async function executeNativeCommand(
    input: unknown,
    lifetime: NativeCommandLifetime,
    runtime?: NativeProcessRuntime
): Promise<object> {
    let command;
    try {
        command = normalizeNativeCommandRun(input);
    } catch (ex) {
        return {
            outcome: 'invalid-input',
            message: ex instanceof Error ? ex.message : 'Invalid native command request',
        };
    }
    const resultBlock = nativeResultBlock(command.command, command.nativeArgs);
    if (resultBlock) return { outcome: 'blocked', message: resultBlock };
    let root: string;
    try {
        root = projectIdentity(command.workspaceRoot);
        const selection = validateProjectSelections(root, command.command, command.nativeArgs);
        if (command.nativeChoices) {
            validateNativeSharedSelection(
                command.nativeChoices.fixShared,
                selection.credentialNames,
                selection.config
            );
        }
    } catch {
        return {
            outcome: 'blocked',
            message:
                'A readable regular bounded .mcdevrc.json with valid configured credential/BU selections and bulk destinations is required. No command was launched.',
        };
    }
    if (!guard.tryAcquire(root)) {
        return {
            outcome: 'project-busy',
            reconciliationRequired: guard.isBlocked(root),
            message:
                'Another operation is running or termination requires operator reconciliation.',
        };
    }
    const diagnostics = createNativeDiagnostics();
    const results = createNativeCommandResults(command.command);
    const started = Date.now();
    const progress = setInterval(() => {
        try {
            lifetime.progress?.(Math.floor((Date.now() - started) / 1000));
        } catch {
            // A disconnected progress observer must not crash the server or native operation.
        }
    }, 5000);
    progress.unref();
    try {
        const process = await runNativeProcess(
            {
                projectRoot: root,
                args: [
                    command.command,
                    ...(command.nativeChoices ? ['--skipInteraction=true'] : []),
                    ...command.nativeArgs,
                ],
            },
            {
                signal: lifetime.signal,
                timeoutMs: command.timeoutMs,
                nativeCommandMode: true,
                onOutput: (stream, chunk) => {
                    diagnostics.write(stream, chunk);
                    results.write(stream, chunk);
                },
            },
            runtime
        );
        if (
            process.outcome === 'termination-unconfirmed' ||
            (process.started && process.stopReason !== null && !process.descendantsStopped)
        )
            guard.block(root);
        return {
            command: command.command,
            runtimeVersion: runtime ? 'synthetic-test-runtime' : getBundledMcdevVersion(),
            outcome: process.outcome,
            process,
            diagnostics: diagnostics.finish(),
            result: results.finish(process.outcome === 'exited' && process.exitCode === 0),
            effects: command.effects,
            reconciliationRequired: guard.isBlocked(root),
            remoteCompletenessVerified: false,
            message:
                'Process completion is native evidence only, not independent verification of remote state. Failures and cancellation do not roll back effects.',
        };
    } catch {
        guard.block(root);
        return {
            outcome: 'termination-unconfirmed',
            reconciliationRequired: true,
            message:
                'Operation settlement is unknown. Reconcile processes and local/remote effects before another attempt.',
        };
    } finally {
        clearInterval(progress);
        guard.release(root);
    }
}

/**
 * Release only an uncertain-operation latch after the host reports operator reconciliation.
 * It does not kill processes, inspect account state or authorize another command.
 * @param workspaceRoot - Original project identity.
 * @returns {object} Whether the blocked latch was released.
 */
export function reconcileNativeCommand(workspaceRoot: string): object {
    try {
        const root = projectIdentity(workspaceRoot);
        return { released: guard.acknowledgeExternalReconciliation(root) };
    } catch {
        return { released: false };
    }
}
