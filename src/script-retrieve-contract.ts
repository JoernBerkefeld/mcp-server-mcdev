/** Reviewed source facts only; importing this record never loads native metadata classes. */
export const SCRIPT_RETRIEVE_CONTRACT = Object.freeze({
    reviewedVersion: '10.1.0' as const,
    status: 'reviewed-source-contract' as const,
    executionEnabled: false as const,
    executesProcess: false as const,
    scope: Object.freeze({
        command: 'retrieve' as const,
        type: 'script' as const,
        selectors:
            'One credential-qualified BU and one literal external key; no broad selectors, name/ID lookup or fallback.',
        purge: false as const,
    }),
    remoteEffects: Object.freeze([
        'Script retrieval reads the paginated REST collection /automation/v1/scripts/ even for a literal key, then filters the returned map locally by exact key. This is a broad remote collection read, not a single-object API lookup or Query SOAP lookup.',
        'The folder-ssjsactivity dependency is cached through Retriever without a save directory. Dependency, parent/shared and SDK reads are not a single-key-only remote-read guarantee.',
        'Native mcdev/SDK may privately consume and persist authentication/session state; assistant inspection, search, hashing, copying or return of its contents is forbidden.',
    ]),
    localEffects: Object.freeze([
        'Persistence extracts one SSJS or HTML companion, removes inline script from JSON and writes the selected key under the configured retrieve/credential/BU/script directory. Existing JSON and the selected companion may be overwritten; the other companion is not automatically removed on success.',
        'Zero-saved REST persistence, including filtering, calls postDeleteTasks for the key and can delete JSON plus both SSJS and HTML companion candidates, even with no-purge. There is no Query-style early SOAP key-not-found branch.',
        'Explicit key and no-purge suppress selected-type wrapper cleanup only, not native per-key deletion. Caller-managed filesystem quiescence and bounded no-link destination inspection remain required.',
    ]),
    artifactPolicy: Object.freeze({
        candidates: Object.freeze(['script-meta.json', 'script-meta.ssjs', 'script-meta.html']),
        localMaterialization:
            'Changed valid JSON with the exact key and no inline script, plus exactly one nonempty UTF-8/non-NUL companion. Both companions are ambiguous; missing, unchanged, malformed, wrong-key or drifted output is not verified success.',
        remoteCompletenessVerified: false as const,
        languageValidationPerformed: false as const,
        executesSource: false as const,
    }),
    restrictions: Object.freeze([
        'Require installed mcdev 10.1.0, exact canonical selectors, protected Git auth paths and an absent project validation hook. skipValidation does not prevent loading the validation factory or executing enabled checks.',
        'Fixed no-format suppresses the formatter-enabled predicate before project Prettier configuration/plugins load. Disable script documentOnRetrieve; fixed noLogFile, no-purge and skipInteraction remain required. Native diagnostics remain private.',
        'This is metadata retrieval, not SSJS execution, automation execution, rendering or language validation. The record neither launches a process nor authorizes an adapter; ordinary host approval and documented native effects are not custom forms or system locks.',
    ]),
    sourceReferences: Object.freeze([
        Object.freeze({
            file: 'lib/metadataTypes/Script.js',
            line: 44,
            anchor: "await File.initPrettier('ssjs');",
        }),
        Object.freeze({
            file: 'lib/metadataTypes/Script.js',
            line: 45,
            anchor: "return super.retrieveREST(retrieveDir, '/automation/v1/scripts/', key);",
        }),
        Object.freeze({
            file: 'lib/metadataTypes/definitions/Script.definition.js',
            line: 3,
            anchor: "dependencies: ['folder-ssjsactivity'],",
        }),
        Object.freeze({
            file: 'lib/metadataTypes/definitions/Script.definition.js',
            line: 16,
            anchor: 'restPagination: true,',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/definitions/Script.definition.js',
            line: 17,
            anchor: 'restPaginationForKey: true,',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/MetadataType.js',
            line: 1472,
            anchor: '? await this.client.rest.getBulk(uri, this.definition.restPageSize || 500)',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/MetadataType.js',
            line: 1717,
            anchor: 'const single = { [singleRetrieve]: metadataStructure[singleRetrieve] };',
        }),
        Object.freeze({
            file: 'lib/Retriever.js',
            line: 101,
            anchor: 'result = await MetadataTypeInfo[type].retrieveForCache(null, subTypeArr);',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/Script.js',
            line: 293,
            anchor: 'delete metadata.script;',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/Script.js',
            line: 317,
            anchor: "fileExt = 'ssjs';",
        }),
        Object.freeze({
            file: 'lib/metadataTypes/Script.js',
            line: 320,
            anchor: "fileExt = 'html';",
        }),
        Object.freeze({
            file: 'lib/metadataTypes/Script.js',
            line: 398,
            anchor: '`${this.definition.type}-meta.ssjs`,',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/Script.js',
            line: 399,
            anchor: '`${this.definition.type}-meta.html`,',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/MetadataType.js',
            line: 1522,
            anchor: 'await this.postDeleteTasks(singleRetrieve);',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/MetadataType.js',
            line: 2515,
            anchor: 'await File.remove(jsonFile);',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/MetadataType.js',
            line: 2085,
            anchor: 'results[originalKey] = await this.validation(',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/MetadataType.js',
            line: 2158,
            anchor: 'return File.writePrettyToFile(',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/MetadataType.js',
            line: 2184,
            anchor: 'await File.writeJSONToFile(',
        }),
        Object.freeze({
            file: 'lib/metadataTypes/MetadataType.js',
            line: 1652,
            anchor: 'this.properties.metaDataTypes.documentOnRetrieve.includes(this.definition.type)',
        }),
        Object.freeze({
            file: 'lib/util/file.js',
            line: 590,
            anchor: 'if (!this._isFormattingEnabled(properties)) {',
        }),
        Object.freeze({
            file: 'lib/util/validations.js',
            line: 31,
            anchor: 'customRuleImport = await import(rulesUrl);',
        }),
    ]),
});
