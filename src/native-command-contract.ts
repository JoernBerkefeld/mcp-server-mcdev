import { createRequire } from 'node:module';
import path from 'node:path';
import {
    lookupCommand,
    NATIVE_RUNNER_COMMANDS,
    type CommandCatalogEntry,
} from './command-catalog.js';

/** Execution coverage, not a replacement for the native command/option catalog. */
export const CORE_ALLOWED_COMMANDS = Object.freeze([
    'retrieve',
    'deploy',
    'build',
    'buildTemplate',
    'buildDefinition',
    'buildDefinitionBulk',
    'clone',
] as const);

/** Canonical execution coverage, sharing the catalog's advertised native runner set. */
export const SUPPORTED_NATIVE_COMMANDS = NATIVE_RUNNER_COMMANDS;

export type NativeCommand = (typeof SUPPORTED_NATIVE_COMMANDS)[number];

export interface NativeCommandRunInput {
    readonly workspaceRoot: string;
    readonly command: NativeCommand;
    readonly args: readonly string[];
    readonly timeoutMs?: number;
}

export interface NormalizedNativeCommandRun extends NativeCommandRunInput {
    readonly catalogEntry: CommandCatalogEntry;
    readonly effects: readonly string[];
    readonly nativeArgs: readonly string[];
    readonly nativeChoices?: Readonly<{ fixShared: string }>;
}

// Resolve the parser owned by mcdev's yargs, without importing the CLI or mcdev runtime.
const mcdevRequire = createRequire(createRequire(import.meta.url).resolve('mcdev'));
const yargsRequire = createRequire(mcdevRequire.resolve('yargs'));
const parse = yargsRequire('yargs-parser') as (
    args: readonly string[],
    options: Record<string, unknown>
) => Record<string, unknown> & { _: unknown[] };

const effects = Object.freeze({
    retrieve: Object.freeze([
        'Reads remote metadata and writes configured local retrieve outputs; options may purge or replace local files.',
    ]),
    deploy: Object.freeze([
        'Creates or updates remote metadata from local files; native options may execute, schedule, publish or refresh it.',
    ]),
    build: Object.freeze([
        'Builds templates and definitions, may retrieve dependencies, and removes its temporary template tree; purge can delete configured deploy outputs.',
    ]),
    buildTemplate: Object.freeze([
        'Writes templates from retrieved metadata and may retrieve dependencies or invoke type-specific effects.',
    ]),
    buildDefinition: Object.freeze([
        'Writes configured templateBuilds outputs and can purge configured deploy outputs; hooks and type-specific effects may apply.',
    ]),
    buildDefinitionBulk: Object.freeze([
        'Builds definitions for the configured market-list targets; can purge deploy outputs for those targets.',
    ]),
    clone: Object.freeze([
        'Delegates to compound build across BUs with clone markets; may retrieve, overwrite outputs and remove temporary templates.',
    ]),
    explainTypes: Object.freeze([
        'Prints the installed native metadata type catalog; native logging options may write local logs.',
    ]),
    badKeys: Object.freeze([
        'Reads local retrieved metadata, creates configured retrieve/docs directories and replaces the BU bad-key report.',
    ]),
    document: Object.freeze([
        'Reads retrieved metadata and writes or replaces type-specific documentation in configured local outputs; parent-only types select the parent BU.',
    ]),
    resolveId: Object.freeze([
        'Authenticates and reads remote metadata to resolve an ID; type-specific lookup and native logging effects apply.',
    ]),
    getFilesToCommit: Object.freeze([
        'Discovers local metadata companion paths through native type-specific logic; does not stage or commit files.',
    ]),
});

/**
 * Require a supplied selector, without imposing a second grammar on native values.
 * @param value - Parsed native positional or option value.
 * @param label - Missing prerequisite to identify.
 */
function requireValue(value: unknown, label: string): void {
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new Error(`An explicit ${label} is required for noninteractive execution`);
    }
}

/**
 * Require both credential and BU, retaining native wildcard and punctuation semantics.
 * @param value - Native BU selector.
 * @param label - Prerequisite name.
 */
function requireBU(value: unknown, label: string): void {
    requireValue(value, label);
    const values = Array.isArray(value) ? value : [value];
    if (
        values.some((item) => {
            const [credential, bu] = String(item).split('/');
            return !credential || !bu;
        })
    ) {
        throw new Error(`An explicit credential/BU is required for ${label}`);
    }
}

/**
 * Check only known prompt prerequisites using yargs-parser's native token semantics.
 * Unrecognized flags and metadata selectors remain native CLI concerns, not an allowlist.
 * @param command - Canonical supported command.
 * @param args - Original argument tokens, never rewritten.
 */
function checkNoninteractive(command: NativeCommand, args: readonly string[]): void {
    const parsed = parse(args, {
        string: [
            'buFrom',
            'buTo',
            'bf',
            'bt',
            'metadata',
            'm',
            'marketFrom',
            'mf',
            'marketTo',
            'mt',
            'market',
            // Scalar options must retain native string values, including numeric ones.
            ...(command === 'retrieve' ? ['like'] : []),
            ...(command === 'deploy'
                ? ['keySuffix', 'ks', 'changeKeyField', 'ckf', 'changeKeyValue', 'ckv']
                : []),
        ],
        array: [
            { key: 'metadata', string: true },
            { key: 'marketFrom', string: true },
            { key: 'marketTo', string: true },
            { key: 'market', string: true },
        ],
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
                      'fixShared',
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
            ...(['build', 'buildTemplate'].includes(command) ? ['shareAsset'] : []),
            ...(command === 'clone' ? ['skipValidation', 'sv'] : []),
            ...(['buildDefinition', 'buildDefinitionBulk'].includes(command)
                ? ['skipValidation', 'sv', 'purge', 'fix']
                : []),
            // build/clone purge and build skipValidation/fix are deliberately untyped
            // in the installed CLI: do not coerce their string values to booleans.
        ],
        key: Object.fromEntries(
            ['metadata', 'buFrom', 'buTo', 'marketFrom', 'marketTo', 'market'].map((key) => [
                key,
                true,
            ])
        ),
        alias: {
            metadata: ['m'],
            buFrom: ['bf'],
            buTo: ['bt'],
            marketFrom: ['mf'],
            marketTo: ['mt'],
        },
        // Native yargs gives every declared positional type:string, even numeric names.
        configuration: { 'parse-positional-numbers': false },
    });
    if (command === 'deploy' && parsed.fixShared) {
        throw new Error(
            'deploy --fixShared requires interactive child-BU selection. Omit it or use --no-fixShared; explicit child-BU choices require --fixShared=ChildA,ChildB.'
        );
    }
    if (command === 'explainTypes') return;
    if (command === 'build' || command === 'clone') {
        requireValue(parsed.metadata, 'metadata option');
        requireBU(parsed.buFrom, 'source BU (--buFrom/--bf)');
        if (command === 'clone' || !parsed.bulk) {
            requireBU(parsed.buTo, 'target BU (--buTo/--bt)');
        }
        if (command === 'build') {
            requireValue(parsed.marketFrom, 'source market (--marketFrom/--mf)');
            requireValue(parsed.marketTo, 'target market/list (--marketTo/--mt)');
        }
        // The compound native implementation prompts unless purge is actually boolean.
        if (typeof parsed.purge !== 'boolean') {
            throw new TypeError(
                'Compound build/clone requires an explicit boolean purge choice (--purge or --no-purge)'
            );
        }
        return;
    }
    if (command === 'buildDefinitionBulk') {
        requireValue(parsed._[0], 'market list');
    } else if (!(['retrieve', 'deploy'].includes(command) && parsed._[0] === '*')) {
        requireBU(parsed._[0], 'BU');
    }
    if (['document', 'resolveId', 'getFilesToCommit'].includes(command)) {
        requireValue(parsed._[1], 'metadata type');
    }
    if (command === 'resolveId' || command === 'getFilesToCommit') {
        requireValue(parsed._[2], command === 'resolveId' ? 'metadata ID' : 'metadata key');
    }
    if (command === 'buildTemplate' || command === 'buildDefinition') {
        requireValue(parsed._[3] || parsed.market, 'market (positional MARKET or --market)');
    }
}

/** Reject ambiguous shared-child CLI tokens. */
function invalidSharedChoice(): never {
    throw new Error(
        'deploy --fixShared requires explicit child-BU selection; use --fixShared=ChildA,ChildB or --no-fixShared'
    );
}

/**
 * Split the explicit shared-child choice from native CLI tokens, without rewriting other tokens.
 * @param command - Canonical native command.
 * @param args - Original native tokens.
 * @returns {object} Native tokens and, when explicitly supplied, the API-only shared-child choice.
 */
function extractSharedChoice(
    command: NativeCommand,
    args: readonly string[]
): {
    nativeArgs: readonly string[];
    nativeChoices?: Readonly<{ fixShared: string }>;
} {
    const nativeArgs = [...args];
    if (command !== 'deploy') return { nativeArgs: Object.freeze(nativeArgs) };
    const end = args.indexOf('--');
    const tokens = args.slice(0, end === -1 ? args.length : end);
    const occurrences = tokens.flatMap((token, index) =>
        /^--(?:no-)?(?:fixShared|fix-shared)(?:[.=]|$)/u.test(token) ? [index] : []
    );
    if (!occurrences.length) return { nativeArgs: Object.freeze(nativeArgs) };
    const index = occurrences[0];
    const token = args[index];
    if (occurrences.length !== 1) invalidSharedChoice();
    if (token === '--no-fixShared' || token === '--fixShared=false') {
        return { nativeArgs: Object.freeze(nativeArgs) };
    }
    const separate = token === '--fixShared';
    const selection = separate
        ? args[index + 1]
        : token.startsWith('--fixShared=')
          ? token.slice('--fixShared='.length)
          : undefined;
    if (
        !selection ||
        selection.startsWith('-') ||
        ['true', 'false'].includes(selection) ||
        selection.includes('/') ||
        selection
            .split(',')
            .some((name) => !name.trim() || (name.trim() === '*' && selection !== '*'))
    )
        invalidSharedChoice();
    // A choice itself explicitly opts into noninteractive sharing. Do not let a
    // later CLI option overwrite the bridge's seeded skipInteraction=true.
    const interaction = parse(tokens, { alias: { skipInteraction: ['yes', 'y'] } });
    const choices = [interaction.skipInteraction].flat();
    if (
        choices.some(
            (value) =>
                value === false ||
                value === 'false' ||
                (typeof value === 'object' && value !== null)
        )
    ) {
        throw new Error(
            'Explicit shared-child selection conflicts with disabling skipInteraction/yes'
        );
    }
    nativeArgs.splice(index, separate ? 2 : 1);
    return {
        nativeArgs: Object.freeze(nativeArgs),
        nativeChoices: Object.freeze({ fixShared: selection as string }),
    };
}

/**
 * Validate an explicit child-BU selection against every already-expanded credential.
 * @param selection - Native comma-separated child names or wildcard.
 * @param credentialNames - Every targeted credential, expanded by the caller.
 * @param config - Loaded project configuration.
 */
export function validateNativeSharedSelection(
    selection: string,
    credentialNames: readonly string[],
    config: unknown
): void {
    const names =
        typeof selection === 'string' ? selection.split(',').map((name) => name.trim()) : [];
    if (
        !names.length ||
        names.some((name) => !name || (name === '*' && selection !== '*')) ||
        !credentialNames.length
    ) {
        throw new Error('Explicit shared-child selection and targeted credentials are required');
    }
    const credentials = (
        config as {
            credentials?: Record<string, { businessUnits?: Record<string, unknown> }>;
        } | null
    )?.credentials;
    for (const credential of credentialNames) {
        const units =
            credentials && Object.hasOwn(credentials, credential)
                ? credentials[credential]?.businessUnits
                : undefined;
        // Installed mcdev Util.parentBuName is _ParentBU_; it is never a child.
        const children =
            units && typeof units === 'object'
                ? Object.keys(units).filter((name) => name !== '_ParentBU_')
                : [];
        if (!children.length || names.some((name) => name !== '*' && !children.includes(name))) {
            throw new Error(`Invalid shared-child selection for credential ${credential}`);
        }
    }
}

/**
 * Validate the narrow server run envelope and preserve native argv tokens exactly.
 * This does not inspect project files, validate full CLI syntax, authorize effects or prove readiness.
 * Callers must still verify canonical project identity and use the trusted supervised transport.
 * @param input - Workspace, canonical command, native args and optional timeout only.
 * @returns {NormalizedNativeCommandRun} Frozen owned copy with catalog/effect integration metadata.
 */
export function normalizeNativeCommandRun(input: unknown): NormalizedNativeCommandRun {
    if (
        !input ||
        typeof input !== 'object' ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).some(
            (key) => !['workspaceRoot', 'command', 'args', 'timeoutMs'].includes(String(key))
        ) ||
        Object.values(Object.getOwnPropertyDescriptors(input)).some((entry) => !('value' in entry))
    ) {
        throw new Error('Expected only workspaceRoot, command, args and optional timeoutMs');
    }
    const { workspaceRoot, command, args, timeoutMs } = input as Record<string, unknown>;
    if (
        typeof workspaceRoot !== 'string' ||
        !workspaceRoot.trim() ||
        workspaceRoot.includes('\0') ||
        !path.isAbsolute(workspaceRoot)
    ) {
        throw new Error('workspaceRoot must be an explicit absolute project path');
    }
    const catalogEntry = typeof command === 'string' ? lookupCommand(command) : undefined;
    if (
        !catalogEntry ||
        catalogEntry.name !== command ||
        !SUPPORTED_NATIVE_COMMANDS.includes(command as NativeCommand)
    ) {
        throw new Error('command must be a supported canonical mcdev command');
    }
    if (
        !Array.isArray(args) ||
        Array.from(args).some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    ) {
        throw new Error('args must be an array of native argument strings without NUL');
    }
    if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    ) {
        throw new Error('timeoutMs must be a positive safe integer');
    }
    const native = extractSharedChoice(command as NativeCommand, args);
    checkNoninteractive(command as NativeCommand, native.nativeArgs);
    return Object.freeze({
        ...native,
        workspaceRoot,
        command: command as NativeCommand,
        args: Object.freeze([...args]),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        catalogEntry,
        effects: effects[command as NativeCommand],
    });
}
