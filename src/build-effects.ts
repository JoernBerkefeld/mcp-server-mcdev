/** Partial mcdev 10.1.0 source review only; no native modules or hooks are loaded. */
const sourceReferences = Object.freeze(
    [
        ['mcdev/lib/cli.js', 441, "['build'],"],
        ['mcdev/lib/cli.js', 538, "['buildTemplate <BU> [TYPE] [KEY] [MARKET]', 'bt'],"],
        ['mcdev/lib/cli.js', 619, "['buildDefinition <BU> [TYPE] [FILENAME] [MARKET]', 'bd'],"],
        ['mcdev/lib/index.js', 1203, 'static async build('],
        [
            'mcdev/lib/index.js',
            1294,
            'static async buildTemplate(businessUnit, selectedTypes, keyArr, marketArr, filter) {',
        ],
        ['mcdev/lib/index.js', 1475, 'static async _reRetrieve('],
        [
            'mcdev/lib/index.js',
            1524,
            'static async buildDefinition(businessUnit, selectedTypes, nameArr, marketArr) {',
        ],
        [
            'mcdev/lib/Builder.js',
            47,
            'const templateBuildsArr = Array.isArray(properties.directories.templateBuilds)',
        ],
        [
            'mcdev/lib/Builder.js',
            113,
            'static async buildTemplate(businessUnit, selectedType, keyArr, marketArr) {',
        ],
        [
            'mcdev/lib/Builder.js',
            203,
            'static async buildDefinition(businessUnit, selectedType, nameArr, marketArr) {',
        ],
        ['mcdev/lib/Builder.js', 325, 'static async purgeDeployFolder(businessUnit) {'],
        [
            'mcdev/lib/metadataTypes/MetadataType.js',
            393,
            'static async buildTemplate(retrieveDir, templateDir, key, templateVariables) {',
        ],
        [
            'mcdev/lib/metadataTypes/MetadataType.js',
            2306,
            'static async buildDefinition(templateDir, targetDir, templateName, variables) {',
        ],
        [
            'mcdev/lib/metadataTypes/MetadataType.js',
            2953,
            'static async validation(method, originalItem, targetDir) {',
        ],
        [
            'mcdev/lib/util/validations.js',
            23,
            'export async function loadCustomRules(root = process.cwd()) {',
        ],
    ].map(([file, line, anchor]) =>
        Object.freeze({ file: String(file), line: Number(line), anchor: String(anchor) })
    )
);

const shared = {
    status: 'partial-source-review' as const,
    reviewedVersion: '10.1.0' as const,
    markets:
        'For standalone template/definition commands, positional MARKET wins over --market. Builder merges market objects in array order, with later values winning; first market __clone__ skips substitutions. CLI --metadata combos replace positional TYPE and KEY/FILENAME selection.',
    destinations:
        'Template reads use configured retrieve/credential/BU and write to configured template, without BU nesting at that root. Definition reads use configured template and write to every configured templateBuilds root under credential/BU, not necessarily deploy. Base MetadataType handles JSON and delegates nested/extracted content and secondary-folder lookup to type methods; exact type-specific files remain unknown.',
    validationAndRemote:
        'Base definition building validates before nested-content and JSON writes, passing only the first output root to validation. Configured options.validation.buildDefinition gates the base validation routine, which can dynamically import project .mcdev-validations.js and invoke its validation factory and rule passed/fix functions. skipValidation changes rule handling, not a promise to avoid loading/executing hooks. fix can alter/filter items. Builder supplies an SDK client to type-specific definition methods. Hook effects, type overrides, dependency helpers, implicit deployment and asset-sharing remote scope remain unknown; no local-only or unattended-safety guarantee follows.',
    interaction:
        'Credential/BU resolution is delegated to Cli.getCredentialObject; its interactive conditions are not reviewed here. Type/key preparation and market checks can reject selections. No native command, hook, or SDK is executed by this guidance record.',
    sourceReferences,
};

export const BUILD_EFFECTS = Object.freeze({
    build: Object.freeze({
        ...shared,
        inputs: 'CLI requires metadata, buFrom, marketFrom and marketTo; buTo is required by the implementation unless bulk is enabled. build requires valid types and nonempty key arrays, then builds templates before definitions. --bulk uses only marketTo[0] as a market-list name; bulk internals are deferred.',
        localRemoval:
            'Temporarily redirects configured template to fixed project-relative .mcdev/template/. When templates exist, unset/nonboolean purge prompts with default yes, without a skipInteraction guard in this block. True purge delegates removal of deploy BU folders, independently of templateBuilds destinations; --no-purge skips that removal. After definition returns, File.remove deletes the temporary template tree, retrying on error, and restores configuration. This is not a run-owned/no-link-safe scratch directory; early aborts/errors do not establish guaranteed cleanup.',
        retrieval:
            'Template stage calls _reRetrieve with alwaysAsk false when dependencies is not enabled; that helper retrieves only when retrieve is truthy, without its optional question on this path. Dependency and dependent-content-reference helpers are also called; their precise effects remain unknown. retrieve can replace local inputs from remote metadata. CLI exposes dependencies, retrieve, shareAsset, skipValidation and fix.',
    }),
    buildTemplate: Object.freeze({
        ...shared,
        inputs: 'Uses current retrieved files, including name: lookup from local JSON to resolve keys. CLI requires a positional MARKET or --market; metadata selection is prepared by native helpers. Builder rejects subtype-qualified types.',
        localRemoval:
            'The reviewed standalone template wrapper/base method has no purge or template-tree cleanup. It writes templates into the configured persistent template root; it does not perform build compound-command cleanup.',
        retrieval:
            'When dependencies is not enabled, calls _reRetrieve with alwaysAsk false: retrieve truthy enables remote retrieval and local input changes; omission does not ask through this helper. addDependencies and addDependentCbReferences are then invoked; their exact remote and filesystem effects remain unknown. CLI exposes dependencies, retrieve and shareAsset.',
    }),
    buildDefinition: Object.freeze({
        ...shared,
        inputs: 'Uses current template files, not remote snapshots. CLI requires positional MARKET or --market and prepares selected types/template names. Builder converts %20 in template names to spaces and rejects subtype-qualified types.',
        localRemoval:
            'Standalone definition does not ask the compound build purge question: only truthy purge removes configured deploy/credential/BU before building. Omitted purge skips removal; --no-purge also skips it. Native removal retries on failure and is not established as run-owned/no-link safe. Purge does not test whether deploy is a templateBuilds destination. No template-tree cleanup is present in this wrapper.',
        retrieval:
            'No explicit retrieve or deploy call occurs in the reviewed standalone wrapper or base definition body. Delegated type methods and executable validation hooks remain unreviewed for remote effects; do not infer local-only behavior. CLI exposes skipValidation, purge and fix.',
    }),
});
