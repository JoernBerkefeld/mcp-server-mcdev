/** Factual declaration inventory; never imports or executes the mcdev CLI. */
export const REVIEWED_MCDEV_VERSION = '10.1.0' as const;
export const COMMAND_CATALOG_SOURCE = 'mcdev/lib/cli.js' as const;

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

export interface CommandCatalogEntry {
    readonly name: string;
    /** Exact first declaration string, including positional argument notation. */
    readonly signature: string;
    /** Command aliases only; option aliases are outside this inventory. */
    readonly aliases: readonly string[];
    readonly reviewedVersion: typeof REVIEWED_MCDEV_VERSION;
    readonly sourceReferences: readonly CommandSourceReference[];
    readonly reviewedEffects?: typeof deltaEffects;
    readonly execution: {
        readonly status: 'guidance-only';
        readonly reason: string;
    };
}

const execution = Object.freeze({
    status: 'guidance-only' as const,
    reason: 'Declaration inventory only. No execution adapter exists; effects, prerequisites, and interactive prompts have not been reviewed.',
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
                : { execution }),
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
