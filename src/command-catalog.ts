/** Factual declaration inventory; never imports or executes the mcdev CLI. */
export const REVIEWED_MCDEV_VERSION = '10.1.0' as const;
export const COMMAND_CATALOG_SOURCE = 'mcdev/lib/cli.js' as const;

export interface CommandSourceReference {
    readonly package: 'mcdev';
    readonly file: typeof COMMAND_CATALOG_SOURCE;
    /** One-based line containing the command declaration array in the reviewed package. */
    readonly line: number;
}

export interface CommandCatalogEntry {
    readonly name: string;
    /** Exact first declaration string, including positional argument notation. */
    readonly signature: string;
    /** Command aliases only; option aliases are outside this inventory. */
    readonly aliases: readonly string[];
    readonly reviewedVersion: typeof REVIEWED_MCDEV_VERSION;
    readonly sourceReferences: readonly CommandSourceReference[];
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
            execution,
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
