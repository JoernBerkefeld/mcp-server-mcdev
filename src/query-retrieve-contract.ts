const sourceReferences = Object.freeze(
    [
        ['lib/cli.js', 84, 'Mcdev.setOptions(argv);'],
        [
            'lib/index.js',
            389,
            'static async retrieve(businessUnit, selectedTypesArr, keys, changelogOnly) {',
        ],
        ['lib/index.js', 561, 'if ((!areKeySet && !Util.OPTIONS.like) || Util.OPTIONS.purge) {'],
        [
            'lib/index.js',
            591,
            'await File.remove(File.normalizePath([properties.directories.retrieve, cred, bu]));',
        ],
        ['lib/Retriever.js', 38, 'this.properties = properties;'],
        [
            'lib/Retriever.js',
            101,
            'result = await MetadataTypeInfo[type].retrieveForCache(null, subTypeArr);',
        ],
        [
            'lib/metadataTypes/definitions/Query.definition.js',
            3,
            "dependencies: ['folder-queryactivity', 'dataExtension'],",
        ],
        ['lib/metadataTypes/Query.js', 42, "await File.initPrettier('sql');"],
        [
            'lib/metadataTypes/Query.js',
            55,
            "return super.retrieveREST(retrieveDir, '/automation/v1/queries/' + (objectId || ''), key);",
        ],
        [
            'lib/metadataTypes/Query.js',
            95,
            "const response = await this.client.soap.retrieve('QueryDefinition', ['ObjectID'], {",
        ],
        [
            'lib/metadataTypes/Query.js',
            465,
            'await super.postDeleteTasks(customerKey, [`${this.definition.type}-meta.sql`]);',
        ],
        ['lib/metadataTypes/MetadataType.js', 1522, 'await this.postDeleteTasks(singleRetrieve);'],
        [
            'lib/metadataTypes/MetadataType.js',
            2085,
            'results[originalKey] = await this.validation(',
        ],
        ['lib/metadataTypes/MetadataType.js', 2158, 'return File.writePrettyToFile('],
        ['lib/metadataTypes/MetadataType.js', 2184, 'await File.writeJSONToFile('],
        ['lib/metadataTypes/MetadataType.js', 2515, 'await File.remove(jsonFile);'],
        [
            'lib/metadataTypes/MetadataType.js',
            2985,
            'const validationRules = await validationsRules(',
        ],
        ['lib/util/validations.js', 31, 'customRuleImport = await import(rulesUrl);'],
        ['lib/util/validations.js', 59, '? await customRuleImport.validation('],
        ['lib/util/file.js', 604, 'const resolvedConfig = await prettier.resolveConfig('],
        ['lib/util/file.js', 340, 'formatted = await prettier.format(content, formatOptions);'],
        ['lib/util/config.js', 56, 'auth = await File.readJSON(Util.authFileName);'],
        ['lib/util/config.js', 138, 'if (Util.skipInteraction) {'],
        [
            'lib/util/cli.js',
            209,
            'const response = await this._selectBU(properties, credential, null, allowAll);',
        ],
        ['lib/util/util.js', 638, 'const processArgv = process.argv.slice(2);'],
    ].map(([file, line, anchor]) =>
        Object.freeze({ file: String(file), line: Number(line), anchor: String(anchor) })
    )
);

export const QUERY_RETRIEVE_CONTRACT = Object.freeze({
    reviewedVersion: '10.1.0' as const,
    status: 'blocked-source-contract' as const,
    executionEnabled: false as const,
    executesProcess: false as const,
    scope: Object.freeze({
        command: 'retrieve' as const,
        type: 'query' as const,
        selectors:
            'One explicit, exact project credential/businessUnit mapping and one literal external key; no CSV, wildcards, name/ID selectors, metadata override or fallback to whole-type/BU retrieval.',
        purge: false as const,
        options:
            'Explicit no-purge is the wrapper-cleanup condition, not an executable argv contract. No other option is authorized by this record.',
    }),
    wrapperCleanup: Object.freeze({
        status: 'suppressed-only-for-reviewed-wrapper-branch' as const,
        condition:
            'The CLI positional TYPE and KEY become arrays. For an explicit valid query type with a nonempty key array and purge false, the selected-type cleanup condition is false. Omitted/empty type fallback can remove the whole BU tree; purge true removes the type tree even with a key.',
        transitiveCleanupSafety: 'not-established' as const,
    }),
    localEffects: Object.freeze([
        'Retriever uses configured retrieve/credential/BU. Query post-retrieve extraction produces SQL and JSON; native persistence can overwrite both. Exact canonical destinations, companion existence and no-link containment are not checked here.',
        'If REST retrieval reaches persistence but saves zero records (including filtering), retrieveREST calls postDeleteTasks for the key. Query delegates removal of both query-meta.json and query-meta.sql paths to base File.remove. The early SOAP key-not-found return instead exits before retrieveREST; these are distinct cases.',
        'Configured documentOnRetrieve can delegate documentation after successful persistence. Native logging starts before config loading and records argv; formatting failures can write adjacent error logs. Full documentation/log destinations and third-party logger effects remain unverified.',
    ]),
    remoteEffects: Object.freeze([
        'Query resolves an active QueryDefinition ObjectID by SOAP CustomerKey lookup, then retrieves the REST query resource. Missing ObjectID returns zero metadata without the REST call.',
        'Declared query dependencies include folder-queryactivity and dataExtension; Retriever expands the metadata hierarchy and caches dependencies, not just the requested query. Dependency cache internals, shared/parent scope and SDK behavior are not exhaustively audited; no single-key-only remote-read guarantee is made.',
    ]),
    dynamicBoundaries: Object.freeze([
        'When options.validation.retrieve is truthy, saveResults enters native validation. Rules are loaded before individual enabled-rule checks: .mcdev-validations.js is dynamically imported and its validation factory can run. skipValidation does not prevent that import/factory or rule passed() calls. Stop at this arbitrary project-code boundary; no hook execution or transitive safety guarantee.',
        'Query initializes SQL formatting. Enabled formatting resolves project Prettier configuration and later passes configured plugins to prettier.format. Project configuration/plugin execution is an unresolved dynamic boundary; the audit does not load it. Explicit format false suppresses the reviewed formatting-enabled predicate, but is not a whole-operation safety clearance.',
    ]),
    prerequisites: Object.freeze([
        'Native config checking and credential/BU selection must succeed. Invalid explicit selectors fail with skipInteraction, whereas omitted selectors can still prompt. A newer project config version can offer global npm installation unless the reviewed skipInteraction branch refuses it. No unattended-readiness claim.',
        'Native config loading privately consumes authentication and can log parser messages or auth-derived EID mismatch values. This contract never opens auth or native logs; future subprocess output must fail closed rather than forward raw diagnostics.',
        'Operation-bound trusted Cursor confirmation, config/source drift checks, verified executable/version, isolated subprocess lifecycle, safe output and artifact/result verification remain unimplemented. Manual harmless-probe accept/cancel evidence does not implement those boundaries.',
    ]),
    deletionPolicy: Object.freeze({
        nativeSafety: 'not-established' as const,
        taskException:
            'The current user explicitly excepts deletions performed by native mcdev CLI from workspace cleanup restrictions. This changes task policy authorization, not native behavior, operation consent, approved destinations or remote scope; it excludes agent-authored cleanup and does not waive TEMP placement.',
        portableAuthorization: false as const,
    }),
    blockers: Object.freeze([
        'Arbitrary project validation and enabled formatter configuration/plugins prevent a bounded transitive effects conclusion. Dependency, documentation and logging internals are not fully audited beyond these stop boundaries.',
    ]),
    conclusion:
        'Do not enable execution from this record. Native deletion facts remain despite the task-specific policy exception; no portable/default authorization follows. Resolve dynamic-code, dependency, documentation/logging and output boundaries before a real adapter; confirmation or a readiness recheck cannot override executionEnabled false.',
    sourceReferences,
});
