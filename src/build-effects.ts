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

const bulkSourceReferences = Object.freeze([
    ...sourceReferences,
    ...[
        ['mcdev/lib/cli.js', 699, "['buildDefinitionBulk <LISTNAME> [TYPE] [FILENAME]', 'bdb'],"],
        [
            'mcdev/lib/index.js',
            1569,
            'static async buildDefinitionBulk(listName, selectedTypes, nameArr) {',
        ],
        [
            'mcdev/lib/Builder.js',
            243,
            'static async buildDefinitionBulk(listName, type, nameArr) {',
        ],
        ['mcdev/lib/Builder.js', 303, 'static async purgeDeployFolderList(listName) {'],
        ['mcdev/lib/util/util.js', 184, 'verifyMarketList(mlName, properties) {'],
        [
            'mcdev/lib/util/util.js',
            229,
            'checkAndPrepareTypeKeyCombo(selectedTypes, keyArr, commandName) {',
        ],
    ].map(([file, line, anchor]) =>
        Object.freeze({ file: String(file), line: Number(line), anchor: String(anchor) })
    ),
]);

const templateSourceReferences = Object.freeze([
    ...sourceReferences,
    ...[
        [
            'mcdev/lib/index.js',
            1004,
            'static async addDependentCbReferences(businessUnit, typeKeyList) {',
        ],
        ['mcdev/lib/index.js', 1101, 'static async addDependencies(businessUnit, typeKeyList) {'],
        [
            'mcdev/lib/index.js',
            516,
            'static async #retrieveBU(cred, bu, selectedTypesArr, keys, changelogOnly) {',
        ],
        [
            'mcdev/lib/util/replaceContentBlockReference.js',
            233,
            'static async createCache(properties, buObject, retrieveSharedOnly = false) {',
        ],
        [
            'mcdev/lib/util/replaceContentBlockReference.js',
            283,
            'static async _retrieveCache(buObject, properties, retrieveSharedOnly = false) {',
        ],
        [
            'mcdev/lib/metadataTypes/MetadataType.js',
            554,
            'static async getCbReferenceKeys(keyArr, retrieveDir, findAssetKeys) {',
        ],
        [
            'mcdev/lib/metadataTypes/MetadataType.js',
            576,
            'static async replaceCbReferenceLoop(metadataMap, retrieveDir, findAssetKeys) {',
        ],
        ['mcdev/lib/metadataTypes/MetadataType.js', 2659, 'static async getDependentFiles('],
        [
            'mcdev/lib/metadataTypes/Asset.js',
            371,
            "const uri = '/asset/v1/content/assets/query' + (loadShared ? '?scope=shared' : '');",
        ],
        [
            'mcdev/lib/metadataTypes/Asset.js',
            3155,
            'static async replaceCbReference(item, retrieveDir, findAssetKeys) {',
        ],
        [
            'mcdev/lib/metadataTypes/Asset.js',
            3345,
            'static async getCbReferenceKeys(keyArr, retrieveDir, findAssetKeys) {',
        ],
        [
            'mcdev/lib/metadataTypes/Script.js',
            410,
            'static async replaceCbReference(item, retrieveDir, findAssetKeys) {',
        ],
        [
            'mcdev/lib/metadataTypes/DataExtension.js',
            1579,
            'static async handleNotFoundDependencies(notFound) {',
        ],
    ].map(([file, line, anchor]) =>
        Object.freeze({ file: String(file), line: Number(line), anchor: String(anchor) })
    ),
]);

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
            'The standalone template wrapper/base method has no direct purge or template-tree cleanup and writes to the configured persistent template root, unlike compound build. Optional re-retrieve can nevertheless delete configured retrieve type/subtype outputs (no keys/no like, or truthy purge), or the BU retrieve root when no types remain. Keyed zero-saved REST retrieval can also invoke post-delete cleanup. No no-purge, run-owned/no-link cleanup or rollback guarantee follows; retrieval writes metadata and extracted companions. Normal logger output can also write outside retrieve/template.',
        retrieval:
            'Without dependencies, _reRetrieve uses alwaysAsk false and selected keys: truthy retrieve runs retrieval without its optional prompt. Both dependency helpers return when dependencies is disabled. With dependencies, addDependencies calls _reRetrieve with alwaysAsk true: only interaction enabled plus retrieve undefined allows the default-false prompt; confirmation or truthy retrieve runs retrieval of configured metaDataTypes.retrieve collapsed to base types plus initially selected types, not just selected keys. False retrieve, or skipInteraction with undefined retrieve, suppresses this re-retrieve but not dependency cache reads. Local JSON dependency graphs and extracted code/ContentBlockByKey/Name/Id references are traversed recursively, expanding/deduplicating selection after initial filtering; dynamic references are not comprehensively resolved. Missing child-BU DataExtension dependencies can read configured retrieve/credential/_ParentBU_/dataExtension JSON for warnings, not automatically include parent DEs in the child package. Once dependencies is enabled and properties exist, addDependentCbReferences always calls createCache: SDK-backed remote folder and shared-asset reads occur even with retrieve false; local asset JSON and shared results populate memory. The shared asset endpoint uses REST POST /asset/v1/content/assets/query?scope=shared as a query, not asset creation. Discovery Sets guard saveToDisk and Asset extract/JSON persistence in the reviewed reference-scanning branches; this is not a blanket no-write claim. Reference options change in memory and the asset JSON cache resets on normal completion, not guaranteed after errors. Optional re-retrieve can run enabled retrieve validation, dynamically importing project .mcdev-validations.js and invoking its factory and rule passed/fix functions; skipValidation is not a no-hook-execution promise. Exact type overrides/companions, formatter/plugins, transitive helpers, SDK authentication/session persistence and arbitrary hook effects remain unknown. This partial source review is not an exhaustive transitive audit or local-only, dry-run or unattended-safety guarantee. CLI exposes dependencies, retrieve and shareAsset.',
        sourceReferences: templateSourceReferences,
    }),
    buildDefinition: Object.freeze({
        ...shared,
        inputs: 'Uses current template files, not remote snapshots. CLI requires positional MARKET or --market and prepares selected types/template names. Builder converts %20 in template names to spaces and rejects subtype-qualified types.',
        localRemoval:
            'Standalone definition does not ask the compound build purge question: only truthy purge removes configured deploy/credential/BU before building. Omitted purge skips removal; --no-purge also skips it. Native removal retries on failure and is not established as run-owned/no-link safe. Purge does not test whether deploy is a templateBuilds destination. No template-tree cleanup is present in this wrapper.',
        retrieval:
            'No explicit retrieve or deploy call occurs in the reviewed standalone wrapper or base definition body. Delegated type methods and executable validation hooks remain unreviewed for remote effects; do not infer local-only behavior. CLI exposes skipValidation, purge and fix.',
    }),
    buildDefinitionBulk: Object.freeze({
        ...shared,
        inputs: 'LISTNAME selects configured marketList entries; current configured template files supply content, not remote snapshots. CLI --metadata combos replace positional TYPE/FILENAME; otherwise FILENAME is split as CSV. Native preparation requires valid types and nonempty name arrays, sorts names, then processes types in sorted order. Each BU/market group delegates to Builder.buildDefinition, inheriting %20 decoding, subtype rejection, SDK-client provision and base validation/hooks. Result entries are indexed by BU and joined market names; duplicate group labels can overwrite response entries after repeated writes.',
        markets:
            'Bulk has no positional MARKET or command-specific --market option: the named marketList supplies markets. A string is one build group; a flat string array is separate builds, not one merged overlay. Builder also implements nested arrays as ordered overlay groups, with later market values winning in delegated buildDefinition. However verifyMarketList first checks each outer element via properties.markets[market], coercing array keys, so nested groups are not reliably accepted. The verifier requires at least one BU, not exactly one BU/market; it does not require a nonempty market array. It skips description and filter, whereas bulk build and purge loops skip only description. A filter entry can therefore be treated as a BU or fail; do not promise filter support or general nested-list compatibility.',
        localRemoval:
            'Only truthy purge calls purgeDeployFolderList before any types are built; omitted purge and --no-purge skip removal, with no compound-build confirmation in this wrapper. The purge helper walks list entries, validates each BU and delegates removal of configured deploy/credential/BU with retry, independently of templateBuilds destinations. A later invalid entry or failed build can follow earlier removals; no rollback is established. These removals are not established as run-owned/no-link safe. No temporary template redirection or template-tree cleanup occurs in the reviewed bulk wrapper/Builder bulk body.',
        retrieval:
            'No explicit retrieve or deploy call occurs in the reviewed bulk wrapper/Builder bulk body. It awaits delegated definition builds for each group despite a source comment suggesting otherwise. Type-specific methods, SDK helpers, executable validation hooks, implicit deployment and asset sharing remain unknown for remote scope; this is not an exhaustive transitive audit or a local-only, dry-run or unattended-safety guarantee. CLI exposes skipValidation, purge and fix.',
        sourceReferences: bulkSourceReferences,
    }),
});
