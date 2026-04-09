/**
 * Short teaching notes for `.mcdevrc.json` concepts (paraphrased; see bundled wiki for full detail).
 */
export const CONFIG_TOPICS: Record<
    string,
    { title: string; summary: string; relatedWikiFiles: string[] }
> = {
    markets: {
        title: 'markets',
        summary:
            'Named maps of template variables per logical market (e.g. MID, BU name, suffix for keys). ' +
            'Used when building definitions from templates so one repo can target multiple BUs without duplicating folders. ' +
            'Pair with `marketList` when running bulk or chained builds.',
        relatedWikiFiles: ['07.-Advanced-Configuration.md', '06.c-~-Templating-Commands.md'],
    },
    marketList: {
        title: 'marketList',
        summary:
            'Named lists that map credential/BU paths to market keys for deployment flows. ' +
            'Often used with `mcdev build --bulk`, parent/child BU patterns, and createDeltaPkg when promoting across stages.',
        relatedWikiFiles: [
            '07.-Advanced-Configuration.md',
            '06.d-~-Git-based-deployments-and-CICD.md',
        ],
    },
    createDeltaPkg: {
        title: 'createDeltaPkg (cdp)',
        summary:
            'Git-driven packaging: diff a commit range, optionally filter paths, run templating/build steps for changed metadata, ' +
            'and prepare deployable output. Controlled by `metaDataTypes.createDeltaPkg`, deployment branch mappings, and filters.',
        relatedWikiFiles: [
            '06.d-~-Git-based-deployments-and-CICD.md',
            '07.-Advanced-Configuration.md',
        ],
    },
    deployment: {
        title: 'options.deployment',
        summary:
            'Deployment automation settings: commit history depth, source/target mapping between branches and BUs, ' +
            'and branch-specific overrides. Feeds CI/CD and delta workflows.',
        relatedWikiFiles: [
            '07.-Advanced-Configuration.md',
            '06.d-~-Git-based-deployments-and-CICD.md',
        ],
    },
    validations: {
        title: 'Validations (.mcdev-validations.js)',
        summary:
            'Projects can export custom validation rules merged with built-in checks. ' +
            'Severity can be influenced by CLI flags such as `--skipValidation` where supported.',
        relatedWikiFiles: ['07.-Advanced-Configuration.md'],
    },
    metaDataTypes: {
        title: 'metaDataTypes',
        summary:
            'Restrict or tune which metadata types participate in retrieve, createDeltaPkg, and related flows. ' +
            'Often used to speed up iterations or exclude types your pipeline manages elsewhere.',
        relatedWikiFiles: ['07.-Advanced-Configuration.md', '03.-Updating-mcdev.md'],
    },
    build: {
        title: 'build / templating pipeline',
        summary:
            '`build` runs template substitution and definition compilation for selected markets. ' +
            'Flags like `--bulk`, `--bf`, `--mf`, and `--mt` route folder and market selection; see Templating Commands wiki.',
        relatedWikiFiles: ['06.c-~-Templating-Commands.md', '07.-Advanced-Configuration.md'],
    },
    directories: {
        title: 'directories',
        summary:
            'Folder layout for retrieve, deploy, templates, and build outputs. Keeping paths stable matters for git diffs and CDP.',
        relatedWikiFiles: ['07.-Advanced-Configuration.md', '02.-Getting-Started.md'],
    },
    credentials: {
        title: 'credentials',
        summary:
            'Business unit entries in `.mcdevrc.json` reference names used on the CLI. Secrets belong in `.mcdev-auth.json` (do not commit).',
        relatedWikiFiles: ['07.-Advanced-Configuration.md', '02.-Getting-Started.md'],
    },
};

export function listConfigTopicKeys(): string[] {
    return Object.keys(CONFIG_TOPICS).toSorted();
}

export function resolveTopicKey(input: string): string | undefined {
    const lower = input.trim().toLowerCase();
    if (CONFIG_TOPICS[lower]) return lower;
    for (const key of Object.keys(CONFIG_TOPICS)) {
        if (key.toLowerCase() === lower) return key;
    }
    return undefined;
}
