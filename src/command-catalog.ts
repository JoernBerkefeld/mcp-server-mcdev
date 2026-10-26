import { BUILD_EFFECTS } from './build-effects.js';

/** Factual declaration inventory; never imports or executes the mcdev CLI. */
export const REVIEWED_MCDEV_VERSION = '10.1.0' as const;
export const COMMAND_CATALOG_SOURCE = 'mcdev/lib/cli.js' as const;

/** Static host routing guidance, not executable tools or connected-server availability. */
export interface CapabilityRoute {
    readonly intent:
        | 'query-metadata-retrieve'
        | 'script-metadata-retrieve'
        | 'metadata-source-change'
        | 'language-validation'
        | 'sql-text-validation'
        | 'data-extension-rows'
        | 'transactional-definition'
        | 'message-send';
    readonly backend: 'mcdev' | 'sfmc-language' | 'vendor-mce' | 'manual';
    readonly requiredCapability: string;
    readonly standaloneFallback: string;
}

export const CAPABILITY_ROUTES: readonly CapabilityRoute[] = Object.freeze(
    [
        {
            intent: 'query-metadata-retrieve',
            backend: 'mcdev',
            requiredCapability:
                'run_mcdev_command with retrieve: native query metadata selectors and flags, with explicit target and choices; never SQL execution.',
            standaloneFallback:
                'Use the general native runner for supported noninteractive retrieval without requiring companion MCPs; report missing checks and any blocked prompt-dependent invocation honestly.',
        },
        {
            intent: 'script-metadata-retrieve',
            backend: 'mcdev',
            requiredCapability:
                'run_mcdev_command with retrieve: native Script Activity metadata selectors and flags, with explicit target and choices; never SSJS or automation execution.',
            standaloneFallback:
                'Use the general native runner for supported noninteractive retrieval without requiring companion MCPs; report missing checks and any blocked prompt-dependent invocation honestly.',
        },
        {
            intent: 'metadata-source-change',
            backend: 'mcdev',
            requiredCapability:
                'Qualified local metadata and editable-source inspection, followed by run_mcdev_command for supported native build/deploy workflows. Prefer local-source changes when both routes satisfy the task; deploy requires explicit authorization, never an implicit follow-on.',
            standaloneFallback:
                'Use supported native retrieve/build/deploy without requiring companion MCPs; report missing language checks and distinguish useful native results from independently verified synchronization or success.',
        },
        {
            intent: 'language-validation',
            backend: 'sfmc-language',
            requiredCapability:
                'Host-discovered platform detection, identifier lookups and full-document language validation for the established source kind, respecting caveats and required polyfills.',
            standaloneFallback:
                'Retain native metadata and documentation capabilities, but mark companion lookups/validation unperformed; stop only work that requires the missing language capability.',
        },
        {
            intent: 'sql-text-validation',
            backend: 'vendor-mce',
            requiredCapability:
                'Optional host-discovered SQL-text validation with its actual schema and verified matching account/BU; a capability candidate, not an established check or SQL execution.',
            standaloneFallback:
                'Provide query metadata/source inspection and documentation only; SQL validation remains unperformed and SQL execution is not supported.',
        },
        {
            intent: 'data-extension-rows',
            backend: 'vendor-mce',
            requiredCapability:
                'Host-discovered row-data operation matching the requested read or write and verified account/BU; DE schema metadata retrieval is not row access.',
            standaloneFallback:
                'Explain the row-operation limitation; mcdev metadata retrieval cannot substitute for row access. No row read or write is performed.',
        },
        {
            intent: 'transactional-definition',
            backend: 'vendor-mce',
            requiredCapability:
                'Host-discovered transactional-definition management for the requested operation and verified account/BU; creating or updating a definition is not sending a message.',
            standaloneFallback:
                'Provide documentation only and mark definition management unperformed; never substitute an actual send or claim local synchronization.',
        },
        {
            intent: 'message-send',
            backend: 'manual',
            requiredCapability:
                'Manual/unsupported unless the host independently discovers a suitable actual-send capability, verifies account/BU and establishes operation-specific authorization; definition management does not establish send support.',
            standaloneFallback:
                'Explain that actual sending is unsupported here and leave it unperformed; no metadata, validation or diagnostic request authorizes a send.',
        },
    ].map((route) => Object.freeze(route as CapabilityRoute))
);

export interface CommandSourceReference {
    readonly package: 'mcdev';
    readonly file: typeof COMMAND_CATALOG_SOURCE;
    /** One-based line containing the command declaration array in the reviewed package. */
    readonly line: number;
}

// Partial source review, not a preview evaluator or an execution contract.
const deltaEffects = Object.freeze({
    status: 'partial-source-review' as const,
    reviewedVersion: REVIEWED_MCDEV_VERSION,
    range: 'The positional commitrange takes precedence over the range option (aliases branch, commit, R). A value containing .. is passed to Git diffSummary unchanged; a single ref becomes ref..HEAD. Omission prompts for a historical base commit (excluding HEAD), then compares base..HEAD. commitHistory controls the offered history, not an automatic base choice.',
    inputs: 'Git selects changed paths, not package contents. Existence checks, metadata-name lookup, companion discovery and copy/template inputs use the current filesystem. An explicit endpoint does not check out or materialize its blobs. Asset-regrouping suppression additionally compares Git blob identities. Review that current files match the intended snapshot before any native run.',
    mapping:
        'Only templated mode resolves deployment mappings: branchSourceTargetMapping[range] uses the original effective range value before single-ref expansion or interactive selection; otherwise a nonempty sourceTargetMapping is used. A missing mapping logs an error and returns. Source market lists require one BU and one string market; targets resolve through the mapped market list. This is not inferred from Git ancestry or branch roles.',
    filteredCopy:
        'A truthy filter bypasses templating and prefixes comma-separated paths with the configured retrieve directory. Non-deleted, non-folder entries seed getFilesToCommit companion discovery. Copy destinations replace the configured retrieve prefix with deploy. The copy loop still attempts delta entries including missing/deleted paths; copying is not remote deletion.',
    localRemoval:
        'Filtered copy asks to empty selected deploy BU directories, default yes; skipInteraction removes them without that question. This branch does not consult purge, so no-purge is not a copy-mode cleanup guarantee. Templated build prompts for purge when unset, default yes, and purges target deploy BU directories when enabled; multiple mappings with explicit purge are purged up front. Native File.remove calls are not established as run-owned or no-link safe.',
    build: 'Templated mode excludes delete entries and entries without a name, applies metaDataTypes.createDeltaPkg when it is an array, and delegates to mcdev.build with source market, target market list and source-list filters. Build uses .mcdev/template/, builds definitions into configured templateBuilds BU directories, and removes that temporary template tree afterward. Purge acts on deploy BU directories, which need not equal configured build destinations.',
    reportsAndDeletions:
        'getDeltaList writes JSON and Markdown delta reports under logs when relevant changes exist. Missing current paths are labelled delete; these are not authoritative remote deletion requests. Templated mode generates warning text proposing mcdev delete commands (asset deletions limited to JSON owners); it does not execute those commands. Review deletion/key-change intent separately.',
    remoteAndHooks:
        'Templated build can re-retrieve remote metadata through _reRetrieve when retrieve is enabled, modifying local inputs. CLI also exposes dependencies, skipValidation, fix and shareAsset to delegated build. Executable validation hooks, type-specific dependency/retrieval behavior, implicit deployments or asset sharing, and their precise remote scope remain unknown in this partial review; do not classify this command as local-only or authorize it from this record.',
    sourceReferences: Object.freeze([
        Object.freeze({
            file: 'mcdev/lib/cli.js',
            line: 774,
            anchor: "['createDeltaPkg [commitrange]', 'cdp'],",
        }),
        Object.freeze({
            file: 'mcdev/lib/index.js',
            line: 174,
            anchor: 'const range = argv.commitrange || Util.OPTIONS.range;',
        }),
        Object.freeze({
            file: 'mcdev/lib/util/devops.js',
            line: 133,
            anchor: 'async getDeltaList(properties, range, saveToDeployDir, filterPathsCSV, commitHistory) {',
        }),
        Object.freeze({
            file: 'mcdev/lib/util/devops.js',
            line: 35,
            anchor: 'export async function filterAssetRegroupingChanges(files, range, gitClient = getGit()) {',
        }),
        Object.freeze({
            file: 'mcdev/lib/util/devops.js',
            line: 514,
            anchor: 'async buildDeltaDefinitions(properties, range, diffArr, commitHistory) {',
        }),
        Object.freeze({
            file: 'mcdev/lib/util/devops.js',
            line: 747,
            anchor: '_generateDeleteInstructions(delta, sourceMarket, properties, targetMlName) {',
        }),
        Object.freeze({ file: 'mcdev/lib/index.js', line: 1203, anchor: 'static async build(' }),
        Object.freeze({
            file: 'mcdev/lib/index.js',
            line: 1475,
            anchor: 'static async _reRetrieve(',
        }),
        Object.freeze({
            file: 'mcdev/lib/index.js',
            line: 1569,
            anchor: 'static async buildDefinitionBulk(listName, selectedTypes, nameArr) {',
        }),
        Object.freeze({
            file: 'mcdev/lib/Builder.js',
            line: 47,
            anchor: 'const templateBuildsArr = Array.isArray(properties.directories.templateBuilds)',
        }),
        Object.freeze({
            file: 'mcdev/lib/Builder.js',
            line: 303,
            anchor: 'static async purgeDeployFolderList(listName) {',
        }),
        Object.freeze({
            file: 'mcdev/lib/Builder.js',
            line: 325,
            anchor: 'static async purgeDeployFolder(businessUnit) {',
        }),
    ]),
});

// Clone delegates to compound build; retain its reviewed effects without duplicating the audit.
const cloneEffects = Object.freeze({
    ...BUILD_EFFECTS.build,
    inputs: 'CLI requires --metadata (-m, string array) and --buFrom (-bf). --buTo (-bt) is not CLI-demanded, but clone calls non-bulk build, which rejects an absent target. Clone has no command aliases and no command-specific bulk, market, fix or shareAsset options. Native metadataToTypeKey accepts key/id/name identifiers, but downstream support is not established for every identifier/type; build requires valid types and nonempty key arrays. Template name: selectors resolve against current retrieved JSON, not a remote snapshot.',
    markets:
        'clone forwards source BU, target BU and parsed type/key selections to build with both market arrays fixed to [__clone__], without bulk or filter arguments. Native market checks and both Builder stages bypass market substitutions for this sentinel. This is a template/definition pipeline, not a byte-for-byte local copy or a promise that names and keys stay unchanged: base template processing prunes fields and delegates nested content; definition output filenames use the resulting metadata key after validation. Type-specific key/name rewriting remains unknown.',
    interaction:
        'Missing or unknown credential/BU selectors can reach Cli._selectBU prompts. Unknown explicit credential/BU values throw when skipInteraction is set, but missing BU selection has no equivalent guard before _selectBU. Compound build also asks default-yes purge when purge is not boolean, without a skipInteraction guard. --no-purge avoids that removal/question, not validation hooks, retrieval or every possible delegated prompt. Unattended prerequisites remain unverified.',
    retrieval:
        'CLI exposes dependencies (-D), retrieve (-r), skipValidation (-sv) and purge. Template stage calls _reRetrieve with alwaysAsk false when dependencies is not enabled; truthy retrieve performs remote retrieval and can replace local inputs. addDependencies and addDependentCbReferences are also invoked. The reviewed clone/build wrappers contain no explicit deploy call, but type-specific methods, dependency helpers, executable validations, implicit deployments and remote writes remain unknown; do not classify clone as local-only.',
    sourceReferences: Object.freeze([
        ...BUILD_EFFECTS.build.sourceReferences,
        ...[
            ['mcdev/lib/cli.js', 381, "['clone'],"],
            [
                'mcdev/lib/index.js',
                1181,
                'static async clone(businessUnitTemplate, businessUnitDefinition, typeKeyCombo) {',
            ],
            ['mcdev/lib/index.js', 2462, 'static metadataToTypeKey('],
            [
                'mcdev/lib/util/cli.js',
                156,
                'async getCredentialObject(properties, target, isCredentialOnly, allowAll) {',
            ],
            [
                'mcdev/lib/util/cli.js',
                236,
                'async _selectBU(properties, credential, isCredentialOnly, allowAll) {',
            ],
            ['mcdev/lib/util/util.js', 166, 'checkMarketList(marketArr, properties) {'],
        ].map(([file, line, anchor]) =>
            Object.freeze({ file: String(file), line: Number(line), anchor: String(anchor) })
        ),
    ]),
});

export interface CommandCatalogEntry {
    readonly name: string;
    /** Exact first declaration string, including positional argument notation. */
    readonly signature: string;
    /** Command aliases only; option aliases are outside this inventory. */
    readonly aliases: readonly string[];
    readonly reviewedVersion: typeof REVIEWED_MCDEV_VERSION;
    readonly sourceReferences: readonly CommandSourceReference[];
    readonly reviewedEffects?:
        | typeof deltaEffects
        | typeof cloneEffects
        | (typeof BUILD_EFFECTS)[keyof typeof BUILD_EFFECTS];
    readonly execution: {
        readonly status: 'guidance-only' | 'partially-executable';
        readonly reason: string;
        /** Native execution availability is conditional, not a second CLI parser or authorization. */
        readonly nativeRunner?: {
            readonly tool: 'run_mcdev_command';
            readonly availability: 'noninteractive-cases';
            readonly prerequisites: string;
            readonly blockedCases: string;
        };
        readonly remainingGuidanceOnlyScope?: string;
    };
}

const execution = Object.freeze({
    status: 'guidance-only' as const,
    reason: 'Declaration inventory only. No execution adapter exists; effects, prerequisites, and interactive prompts have not been reviewed.',
});

/** Descriptive coverage only; the execution adapter owns admission and native CLI parsing. */
export const NATIVE_RUNNER_COMMANDS = Object.freeze([
    'retrieve',
    'deploy',
    'build',
    'buildTemplate',
    'buildDefinition',
    'buildDefinitionBulk',
    'clone',
    'explainTypes',
    'badKeys',
    'document',
    'resolveId',
    'getFilesToCommit',
] as const);

const nativeRunner = Object.freeze({
    tool: 'run_mcdev_command' as const,
    availability: 'noninteractive-cases' as const,
    prerequisites:
        'Ordinary host approval, an explicit project/credential/BU target where applicable, and explicit native choices sufficient for noninteractive execution. Use native selectors and flags; this catalog is not an argv allowlist or a second CLI parser.',
    blockedCases:
        'Prompt-dependent cases without explicit choices are blocked; do not promise every invocation, metadata type or flag combination. Output results require explainTypes --json or resolveId BU asset ID --json with supported logging options. getFilesToCommit execution is blocked because the installed CLI discards its result; use the local programmatic API. Native authentication, cleanup, validation hooks and type-specific effects still apply.',
});

const nativeExecution = Object.freeze({
    status: 'partially-executable' as const,
    reason: 'Native noninteractive cases are available through run_mcdev_command; partial reviewed effects do not establish all transitive behavior or guarantee success.',
    nativeRunner,
    remainingGuidanceOnlyScope: nativeRunner.blockedCases,
});

// These are declarations, not executable command lines or an argv allowlist.
const declarations: readonly (readonly [signature: string, line: number, ...aliases: string[]])[] =
    [
        ['retrieve [BU] [TYPE] [KEY]', 21, 'r'],
        ['deploy [BU] [TYPE] [KEY]', 94, 'd'],
        ['init [credentialsName]', 252],
        ['join', 264],
        ['reloadBUs [credentialsName]', 269, 'rb', 'refreshBUs'],
        ['badKeys [BU]', 282],
        ['document <BU> <TYPE>', 295, 'doc'],
        ['delete <BU> [TYPE] [KEY]', 315, 'del'],
        ['resolveId <BU> <TYPE> <ID>', 352, 'rid'],
        ['clone', 381],
        ['build', 441],
        ['buildTemplate <BU> [TYPE] [KEY] [MARKET]', 538, 'bt'],
        ['buildDefinition <BU> [TYPE] [FILENAME] [MARKET]', 619, 'bd'],
        ['buildDefinitionBulk <LISTNAME> [TYPE] [FILENAME]', 699, 'bdb'],
        ['selectTypes', 751, 'st'],
        ['explainTypes', 760, 'et'],
        ['createDeltaPkg [commitrange]', 774, 'cdp'],
        ['getFilesToCommit <BU> <TYPE> <KEY>', 841, 'fc'],
        ['refresh <BU> [TYPE] [KEY]', 865, 're'],
        ['execute <BU> [TYPE] [KEY]', 899, 'exec', 'start', 'resume'],
        ['publish <BU> [TYPE] [KEY]', 953, 'activate'],
        ['validate <BU> [TYPE] [KEY]', 1000],
        ['schedule <BU> [TYPE] [KEY]', 1041, 'sched'],
        ['pause <BU> [TYPE] [KEY]', 1089, 'p'],
        ['stop <BU> [TYPE] [KEY]', 1137],
        ['audit <BU>', 1185],
        ['fixKeys <BU> [TYPE] [KEY]', 1214, 'fx'],
        ['replaceContentBlock', 1283, 'rcb'],
        ['describeSoap <TYPE>', 1355, 'describe', 'soap'],
        ['migrate [BU]', 1379],
        ['upgrade', 1393, 'up'],
    ];

const catalog: readonly CommandCatalogEntry[] = Object.freeze(
    declarations.map(([signature, line, ...aliases]) =>
        Object.freeze({
            name: signature.split(' ')[0],
            signature,
            aliases: Object.freeze(aliases),
            reviewedVersion: REVIEWED_MCDEV_VERSION,
            sourceReferences: Object.freeze([
                Object.freeze({ package: 'mcdev' as const, file: COMMAND_CATALOG_SOURCE, line }),
            ]),
            ...(signature.startsWith('createDeltaPkg ')
                ? {
                      reviewedEffects: deltaEffects,
                      execution: Object.freeze({
                          status: 'guidance-only' as const,
                          reason: 'No execution adapter exists. Only partial createDeltaPkg effects have been reviewed; transitive effects and unattended prerequisites remain unverified.',
                      }),
                  }
                : signature === 'clone'
                  ? {
                        reviewedEffects: cloneEffects,
                        execution: nativeExecution,
                    }
                  : signature.split(' ')[0] in BUILD_EFFECTS
                    ? {
                          reviewedEffects:
                              BUILD_EFFECTS[signature.split(' ')[0] as keyof typeof BUILD_EFFECTS],
                          execution: nativeExecution,
                      }
                    : {
                          execution: (NATIVE_RUNNER_COMMANDS as readonly string[]).includes(
                              signature.split(' ')[0]
                          )
                              ? nativeExecution
                              : execution,
                      }),
        })
    )
);

/**
 * Returns every canonical command in reviewed CLI declaration order.
 * @returns {readonly CommandCatalogEntry[]} Immutable reviewed declaration inventory.
 */
export function listCommands(): readonly CommandCatalogEntry[] {
    return catalog;
}

/**
 * Resolves an exact, case-sensitive canonical name or command alias, never an argv string.
 * @param nameOrAlias - Exact canonical command name or alias.
 * @returns {CommandCatalogEntry | undefined} Matching declaration, or undefined for an unknown input.
 */
export function lookupCommand(nameOrAlias: string): CommandCatalogEntry | undefined {
    return catalog.find(
        (command) => command.name === nameOrAlias || command.aliases.includes(nameOrAlias)
    );
}
