import { REVIEWED_MCDEV_VERSION } from './command-catalog.js';

export type EffectCommand = 'retrieve' | 'deploy';
export interface EffectSource {
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
}
export interface CommandEffects {
    readonly command: EffectCommand;
    readonly reviewedVersion: typeof REVIEWED_MCDEV_VERSION;
    readonly status: 'guidance-only';
    readonly selectors: string;
    readonly prerequisites: readonly string[];
    readonly localEffects: readonly string[];
    readonly remoteEffects: readonly string[];
    readonly validation: string;
    readonly interaction: string;
    readonly declaredOptions: readonly string[];
    readonly sourceReferences: readonly EffectSource[];
}

const prerequisites = Object.freeze([
    'Native execution needs a valid mcdev project configuration, configured credential/BU mapping, authentication and API permissions; none are checked by this preview.',
    'Local paths, selected item existence, dependencies, configured validation rules and remote state remain unverified.',
]);
const validation =
    'Native metadata validation and type-specific hooks may reject, filter or transform items. skipValidation still runs configured rule passed() checks, downgrades false failures to warnings, suppresses rule fix() calls and returns the original item; it does not bypass all type-specific checks or API validation.';
const interaction =
    'Native missing selectors can prompt, including BU selection despite skipInteraction when selectors are absent; unknown explicit credentials/BUs with skipInteraction fail. Wildcards can widen to many BUs. Explicit syntax here does not prove that a BU exists or eliminate native prompts.';
const selectors =
    'Native BU is credential/BU (also omitted, *, credential/*); TYPE and KEY accept CSV. metadata accepts type, type:key, type:i:id, type:n:name and overrides positionals. This preview accepts only one explicit qualified BU, one reviewed type and one literal key; no CSV, metadata, ID/name selectors or wildcards.';

/**
 * Static reviewed source ranges, relative to the installed mcdev package.
 * @param ranges - Reviewed package-relative source ranges.
 * @returns {readonly EffectSource[]} Immutable evidence references.
 */
const sources = (ranges: readonly (readonly [string, number, number])[]): readonly EffectSource[] =>
    Object.freeze(
        ranges.map(([file, startLine, endLine]) => Object.freeze({ file, startLine, endLine }))
    );

export const RETRIEVE_DEPLOY_EFFECTS: readonly CommandEffects[] = Object.freeze([
    Object.freeze({
        command: 'retrieve' as const,
        reviewedVersion: REVIEWED_MCDEV_VERSION,
        status: 'guidance-only' as const,
        selectors,
        prerequisites,
        localEffects: Object.freeze([
            'Writes/overwrites retrieved metadata, extracted code, configured documentation and log files; formatting and validation may transform local output.',
            'Native purge deletes the entire selected type/subtype retrieve directory even with an explicit key. Without keys/like native retrieve cleans selected type directories; omitted types can clean the whole BU retrieve directory.',
        ]),
        remoteEffects: Object.freeze([
            'Reads selected metadata and dependency caches, potentially whole dependent types and shared metadata beyond the selected key. No general server-mutation guarantee is made for unreviewed type-specific hooks.',
            'fix concerns local validation output, not a server-side repair operation.',
        ]),
        validation,
        interaction,
        declaredOptions: Object.freeze([
            'metadata',
            'like',
            'skipValidation',
            'fix',
            'format',
            'purge',
            'onlyPublished',
        ]),
        sourceReferences: sources([
            ['lib/cli.js', 21, 91],
            ['lib/index.js', 412, 643],
            ['lib/Retriever.js', 55, 196],
            ['lib/metadataTypes/MetadataType.js', 2993, 3070],
            ['lib/metadataTypes/MetadataType.js', 1648, 1665],
            ['lib/cli.js', 1424, 1430],
            ['lib/util/cli.js', 156, 224],
        ]),
    }),
    Object.freeze({
        command: 'deploy' as const,
        reviewedVersion: REVIEWED_MCDEV_VERSION,
        status: 'guidance-only' as const,
        selectors,
        prerequisites: Object.freeze([
            ...prerequisites,
            'Native deploy needs local deploy metadata (or retrieve metadata with fromRetrieve); fromRetrieve requires explicit type and keys. Cached target dependencies and type-specific prerequisites can block deployment.',
        ]),
        localEffects: Object.freeze([
            'Reads deploy input, writes returned metadata/code/documentation into retrieve output and writes logs. fromRetrieve uses retrieve output as input, so output may overwrite input.',
            'Unless fromRetrieve or folder is explicitly selected, native deploy removes the deploy/credential/BU/folder directory; it can generate folder definitions and deploy missing remote folders. Explicit keys do not prevent this cleanup.',
        ]),
        remoteEffects: Object.freeze([
            'Reads target metadata/dependencies; creates or updates metadata and may create dependency folders. Hooks and validation can add effects beyond the selected item; this is not an exact remote change set.',
            'refresh on updated assets may refresh related active triggered sends; execute may run deployed automations; schedule may start automation schedules. Automation notification updates and post-deploy re-retrieval can occur without these flags.',
            'fixShared applies after parent-BU shared DataExtension updates: selects child BUs from native string choices or a prompt, reads attribute sets and temporarily adds/removes fields to repair child data models; scope can cross the selected BU.',
        ]),
        validation,
        interaction:
            interaction +
            ' fixShared is a native string option accepting comma-separated child BU names or *. With skipInteraction, invalid names or an empty child selection fail instead of prompting; without skipInteraction, native child selection can still prompt.',
        declaredOptions: Object.freeze([
            'metadata',
            'keySuffix',
            'autoMidSuffix',
            'changeKeyField',
            'changeKeyValue',
            'fromRetrieve',
            'refresh',
            'execute',
            'schedule',
            'fixShared',
            'noUpdate',
            'publish',
            'validate',
            'skipStatusCheck',
            'matchName',
            'skipValidation',
            'format',
            'ignoreFolder',
            'ignoreSfFields',
            'fix',
        ]),
        sourceReferences: sources([
            ['lib/cli.js', 94, 250],
            ['lib/Deployer.js', 69, 379],
            ['lib/metadataTypes/MetadataType.js', 149, 163],
            ['lib/metadataTypes/MetadataType.js', 790, 978],
            ['lib/metadataTypes/MetadataType.js', 2993, 3070],
            ['lib/metadataTypes/MetadataType.js', 1648, 1665],
            ['lib/cli.js', 1424, 1430],
            ['lib/util/cli.js', 156, 224],
            ['lib/metadataTypes/Asset.js', 823, 833],
            ['lib/metadataTypes/Asset.js', 976, 1013],
            ['lib/metadataTypes/Automation.js', 1134, 1205],
            ['lib/metadataTypes/DataExtension.js', 385, 672],
        ]),
    }),
]);

export interface EffectsPreview {
    readonly status: 'guidance-only';
    readonly command: EffectCommand;
    readonly scope: Readonly<{ bu: string; type: string; key: string }>;
    readonly options: Readonly<Record<string, boolean | 'log'>>;
    readonly effects: CommandEffects;
    readonly warnings: readonly string[];
    readonly blockedReasons: readonly string[];
    readonly remoteStateValidated: false;
    readonly executesProcess: false;
}

const reviewedTypes = new Set(['automation', 'asset-email', 'dataExtension', 'query', 'script']);
const commonOptions = new Set(['skipValidation', 'fix', 'format', 'skipInteraction']);
const retrieveOptions = new Set(['purge', 'onlyPublished']);
const deployOptions = new Set([
    'fromRetrieve',
    'refresh',
    'execute',
    'schedule',
    'fixShared',
    'noUpdate',
]);
const literal = /^[A-Za-z0-9][A-Za-z0-9_. -]*$/;

/**
 * Describes a narrow synthetic request without reading project files or invoking mcdev.
 * @param input - Plain request with command, bu, type, key and optional canonical options.
 * @returns {EffectsPreview} Static guidance, unresolved blockers and non-validation markers.
 */
export function previewRetrieveDeploy(input: unknown): EffectsPreview {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Expected a plain preview request');
    }
    const request = input as Record<string, unknown>;
    if (
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).some(
            (key) =>
                typeof key !== 'string' ||
                !['command', 'bu', 'type', 'key', 'options'].includes(key)
        ) ||
        Object.values(Object.getOwnPropertyDescriptors(input)).some((value) => !('value' in value))
    ) {
        throw new Error('Unsupported request fields or accessors');
    }
    const { command, bu, type, key } = request;
    if (command !== 'retrieve' && command !== 'deploy') {
        throw new Error('Only canonical retrieve and deploy are reviewed');
    }
    const parts = typeof bu === 'string' ? bu.split('/') : [];
    if (
        parts.length !== 2 ||
        !parts.every((part) => literal.test(part) && part.trim() === part && !part.includes('..'))
    ) {
        throw new Error('An explicit literal credential/BU is required');
    }
    if (typeof type !== 'string' || !reviewedTypes.has(type)) {
        throw new Error('Type outside reviewed preview scope');
    }
    if (typeof key !== 'string' || !literal.test(key) || key.trim() !== key || key.includes('..')) {
        throw new Error('One explicit literal key is required');
    }
    const rawOptions = request.options === undefined ? {} : request.options;
    if (
        !rawOptions ||
        typeof rawOptions !== 'object' ||
        Object.getPrototypeOf(rawOptions) !== Object.prototype ||
        Reflect.ownKeys(rawOptions).some((name) => typeof name !== 'string') ||
        Object.values(Object.getOwnPropertyDescriptors(rawOptions)).some(
            (value) => !('value' in value)
        )
    ) {
        throw new Error('Expected plain canonical options');
    }
    const options: Record<string, boolean | 'log'> = {};
    for (const [name, value] of Object.entries(rawOptions)) {
        if (name === 'api') {
            if (value !== 'log') {
                throw new Error('Only diagnostic api: log is permitted; api: cli is forbidden');
            }
        } else if (
            !(
                commonOptions.has(name) ||
                (command === 'retrieve' ? retrieveOptions : deployOptions).has(name)
            ) ||
            typeof value !== 'boolean'
        ) {
            throw new Error(`Unsupported option or value: ${name}`);
        }
        options[name] = value;
    }
    for (const [flag, requiredType] of [
        ['refresh', 'asset-email'],
        ['execute', 'automation'],
        ['schedule', 'automation'],
        ['fixShared', 'dataExtension'],
    ]) {
        if (options[flag] && type !== requiredType) {
            throw new Error(`${flag} requires reviewed type ${requiredType}`);
        }
    }
    const effects = RETRIEVE_DEPLOY_EFFECTS.find((entry) => entry.command === command)!;
    const warnings = [
        'Static guidance only, not a dry run: no files, credentials, remote state, dependencies or validation hooks were evaluated.',
        'Selector syntax is intentionally narrower than mcdev; dependencies, hooks and related resources may widen effects.',
    ];
    if (options.api === 'log') {
        warnings.push(
            'Diagnostic --api log can write sensitive API payloads to native logs. --api cli is forbidden; neither is a standalone command family.'
        );
    }
    if (options.skipValidation) {
        warnings.push(validation);
    }
    if (options.purge) {
        warnings.push('purge removes the entire selected type directory, not just this key.');
    }
    if (options.fixShared) {
        warnings.push(
            'fixShared without explicit string child choices fails with skipInteraction; otherwise child selection can prompt, and repair mutates child-BU data models outside this BU.'
        );
    }
    if (options.refresh || options.execute || options.schedule) {
        warnings.push(
            'Requested post-deploy actions can change related remote resources or start live work; schedule and execute can both run if both are enabled.'
        );
    }
    return Object.freeze({
        status: 'guidance-only',
        command,
        scope: Object.freeze({ bu: bu as string, type, key }),
        options: Object.freeze(options),
        effects,
        warnings: Object.freeze(warnings),
        blockedReasons: Object.freeze([
            'No execution adapter exists; this preview cannot authorize or execute mcdev.',
            'Native cleanup and filesystem containment are unresolved: explicit keys do not make native recursive cleanup safe.',
            'Host approval for local writes/deletions and remote mutations is unresolved; preview is not approval.',
            'Project prerequisites, interactive selectors, type-specific hooks and remote state have not been validated.',
        ]),
        remoteStateValidated: false,
        executesProcess: false,
    });
}
