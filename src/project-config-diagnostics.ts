/** Pure, partial diagnosis: no native mcdev imports, hooks, filesystem access or mutations. */
import type { ProjectConfig } from './project-inspection.js';

export interface ConfigFinding {
    code: string;
    severity: 'error' | 'warning';
    path: string;
    message: string;
    evidence: string;
}

export interface ProjectConfigDiagnosis {
    findings: ConfigFinding[];
    recommendation: { firstStep: string; url: string; guidance: string };
    limitations: string[];
}

const DEFAULTS = 'mcdev/boilerplate/config.json';
const UTIL = 'mcdev/lib/util/util.js: verifyMarketList, isValidBU';
const DEVOPS = 'mcdev/lib/util/devops.js: buildDeltaDefinitions';
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (base: string, key: string): string => `${base}[${JSON.stringify(key)}]`;
const owns = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);
const stringList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Diagnose the already safely read config without loading any project code.
 * Evidence is pinned to the installed mcdev defaults and native implementation reviewed here.
 * Missing optional sections and template placeholders are not classified as structural errors.
 * @param project - Complete result of readProjectConfig; retained untouched.
 * @returns {ProjectConfigDiagnosis} Partial static findings, builder guidance and explicit limits.
 */
export function diagnoseProjectConfig(project: ProjectConfig): ProjectConfigDiagnosis {
    const { config } = project;
    const findings: ConfigFinding[] = [];
    const add = (
        code: string,
        path: string,
        message: string,
        evidence = DEFAULTS,
        severity: ConfigFinding['severity'] = 'error'
    ): void => {
        findings.push({ code, severity, path, message, evidence });
    };
    const object = (value: unknown, location: string): Record<string, unknown> => {
        if (record(value)) return value;
        if (value !== undefined) add('invalid-object', location, 'Expected an object.');
        return {};
    };
    const credentials = object(config.credentials, '$.credentials');
    const markets = object(config.markets, '$.markets');
    const lists = object(config.marketList, '$.marketList');
    const options = object(config.options, '$.options');
    const directories = object(config.directories, '$.directories');
    const types = object(config.metaDataTypes, '$.metaDataTypes');
    const deployment = object(options.deployment, '$.options.deployment');
    for (const key of ['businessUnits', 'deploy', 'docs', 'retrieve', 'template']) {
        if (owns(directories, key) && typeof directories[key] !== 'string') {
            add('invalid-directory', at('$.directories', key), 'Expected a directory string.');
        }
    }
    if (
        owns(directories, 'templateBuilds') &&
        typeof directories.templateBuilds !== 'string' &&
        !stringList(directories.templateBuilds)
    ) {
        add(
            'invalid-template-builds',
            '$.directories.templateBuilds',
            'Expected a string or string array.'
        );
    }
    for (const key of ['retrieve', 'createDeltaPkg', 'documentOnRetrieve']) {
        if (owns(types, key) && !stringList(types[key])) {
            add('invalid-type-list', at('$.metaDataTypes', key), 'Expected a string array.');
        }
    }
    for (const [name, credential] of Object.entries(credentials)) {
        const location = at('$.credentials', name);
        const entry = object(credential, location);
        if (/[\\/]/u.test(name))
            add(
                'invalid-alias',
                location,
                'Credential aliases cannot contain slashes.',
                'mcdev/lib/util/config.js: checkProperties'
            );
        const units = object(entry.businessUnits, `${location}.businessUnits`);
        for (const [alias, mid] of Object.entries(units)) {
            const unitPath = at(`${location}.businessUnits`, alias);
            if (/[\\/]/u.test(alias))
                add(
                    'invalid-alias',
                    unitPath,
                    'BU aliases cannot contain slashes.',
                    'mcdev/lib/util/config.js: checkProperties'
                );
            // Zero is an intentional placeholder in native defaults; do not reject it here.
            if (typeof mid !== 'string' && typeof mid !== 'number') {
                add('invalid-mid', unitPath, 'Expected a string or numeric MID.');
            }
        }
    }
    const checkBu = (value: string, location: string): void => {
        const [credential, alias, extra] = value.split('/');
        if (!credential || !alias || extra !== undefined) {
            add(
                'invalid-bu-reference',
                location,
                'Expected credential/BU, not an unqualified BU alias.',
                UTIL
            );
            return;
        }
        const entry = credentials[credential];
        if (!record(entry) || !record(entry.businessUnits)) return;
        if (!owns(entry.businessUnits, alias) || !entry.businessUnits[alias]) {
            add(
                'unresolved-bu',
                location,
                'BU is absent or has a placeholder MID in this credential.',
                UTIL,
                'warning'
            );
        }
    };
    for (const [name, value] of Object.entries(lists)) {
        const location = at('$.marketList', name);
        const list = object(value, location);
        for (const [bu, market] of Object.entries(list)) {
            if (bu === 'description' || bu === 'filter') continue;
            const referencePath = at(location, bu);
            const credential = bu.split('/')[0];
            if (!owns(credentials, credential)) {
                add(
                    'unresolved-credential',
                    referencePath,
                    'Credential alias is not defined.',
                    UTIL,
                    'warning'
                );
            }
            checkBu(bu, referencePath);
            const refs = typeof market === 'string' ? [market] : market;
            if (!stringList(refs)) {
                add(
                    'unsupported-market-shape',
                    referencePath,
                    'Only string and flat string-array market references are diagnosed; other shapes are not validated.',
                    UTIL,
                    'warning'
                );
                continue;
            }
            for (const reference of refs as string[]) {
                if (!owns(markets, reference)) {
                    add(
                        'unresolved-market',
                        referencePath,
                        `Market ${JSON.stringify(reference)} is not defined.`,
                        UTIL,
                        'warning'
                    );
                }
            }
        }
    }
    const checkMapping = (value: unknown, location: string): void => {
        const mapping = object(value, location);
        for (const [source, target] of Object.entries(mapping)) {
            const mappingPath = at(location, source);
            if (typeof target !== 'string') {
                add(
                    'invalid-mapping-target',
                    mappingPath,
                    'Expected one target market-list name; arrays are not supported.',
                    DEVOPS
                );
                continue;
            }
            for (const name of [source, target]) {
                if (!owns(lists, name)) {
                    add(
                        'unresolved-market-list',
                        mappingPath,
                        `Market list ${JSON.stringify(name)} is not defined.`,
                        DEVOPS,
                        'warning'
                    );
                }
            }
            const list = lists[source];
            if (record(list)) {
                const units = Object.keys(list).filter(
                    (key) => key !== 'description' && key !== 'filter'
                );
                // Native defaults include description-only placeholders, not deployable sources.
                if (units.length === 0) {
                    add(
                        'placeholder-source',
                        mappingPath,
                        'Source market list has no BU mapping yet.',
                        DEVOPS,
                        'warning'
                    );
                } else if (units.length !== 1 || typeof list[units[0]] !== 'string') {
                    add(
                        'invalid-source-list',
                        at('$.marketList', source),
                        'A deployment source must have exactly one BU with one string market name.',
                        DEVOPS
                    );
                }
            }
        }
    };
    checkMapping(deployment.sourceTargetMapping, '$.options.deployment.sourceTargetMapping');
    const branches = object(
        deployment.branchSourceTargetMapping,
        '$.options.deployment.branchSourceTargetMapping'
    );
    for (const [branch, mapping] of Object.entries(branches)) {
        checkMapping(mapping, at('$.options.deployment.branchSourceTargetMapping', branch));
    }
    return {
        findings,
        recommendation: {
            firstStep:
                'Before editing pipeline configuration, use the visual MCDev Pipeline Builder.',
            // Verified against sfmc.guide _config.yml url/baseurl and page frontmatter permalink.
            url: 'https://sfmc.guide/tools/mcdev-pipeline-builder/',
            guidance:
                'Load your existing .mcdevrc.json, review environments, credential-qualified BU mappings and market variables, then review the export before replacing anything. Never load .mcdev-auth.json. Read-only diagnosis can proceed without the builder.',
        },
        limitations: [
            'Partial static diagnosis, not native mcdev validation or proof that deployment will succeed. Missing sections are not upgrade errors here.',
            'No auth, hooks, files, native CLI or live account checks. Unknown and user-owned fields remain untouched.',
            'Market variable contents, filters, nested market composition, targetBranchBuMapping, metadata-type names, version compatibility and other options are not validated.',
            'Reference warnings may describe intentional native example placeholders; they are not structural errors.',
        ],
    };
}
