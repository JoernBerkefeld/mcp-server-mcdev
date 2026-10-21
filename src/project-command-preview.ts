/** Pure project-selector adapter; never reads files, loads hooks or invokes native mcdev. */
import type { ProjectConfig } from './project-inspection.js';
import { previewRetrieveDeploy, type EffectsPreview } from './retrieve-deploy-effects.js';

export interface ProjectCommandPreview extends EffectsPreview {
    readonly selectorVerification: 'verified-config-mapping';
    readonly projectSelectors: Readonly<{ credential: string; businessUnit: string }>;
    readonly executionReadiness: 'unknown';
    readonly configuredPaths: 'unknown';
    readonly limitations: readonly string[];
}

const literal = /^[A-Za-z0-9][A-Za-z0-9_. -]*$/;
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string') &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => 'value' in entry);
const owns = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);
const selector = (value: unknown): value is string =>
    typeof value === 'string' &&
    literal.test(value) &&
    value.trim() === value &&
    !value.includes('..');

/**
 * Verify explicit project selectors and compose narrow, non-executing native guidance.
 * Customized relevant roots are unsupported rather than interpreted as default paths.
 * @param project - Already inspected project config; no file or authentication access occurs.
 * @param input - Canonical command, credential, businessUnit, type, key and optional options.
 * @returns {ProjectCommandPreview} Static effects with verified mappings, not execution readiness.
 */
export function previewProjectCommand(
    project: ProjectConfig,
    input: unknown
): ProjectCommandPreview {
    if (
        !record(input) ||
        Reflect.ownKeys(input).some(
            (key) =>
                !['command', 'credential', 'businessUnit', 'type', 'key', 'options'].includes(
                    key as string
                )
        )
    ) {
        throw new Error('Expected a plain project preview request with canonical fields');
    }
    const { command, credential, businessUnit, type, key, options } = input;
    if (!selector(credential) || !selector(businessUnit)) {
        throw new Error('One explicit literal credential and businessUnit are required');
    }
    const config = project.config;
    if (!record(config) || !owns(config, 'credentials') || !record(config.credentials)) {
        throw new Error('Project credential mappings are unavailable');
    }
    const credentials = config.credentials;
    if (!owns(credentials, credential) || !record(credentials[credential])) {
        throw new Error('Credential is not an exact project mapping');
    }
    const entry = credentials[credential];
    if (!owns(entry, 'businessUnits') || !record(entry.businessUnits)) {
        throw new Error('Project businessUnit mappings are unavailable');
    }
    const units = entry.businessUnits;
    if (!owns(units, businessUnit)) {
        throw new Error('BusinessUnit is not an exact mapping in this credential');
    }
    const mid = units[businessUnit];
    if (!(
        (typeof mid === 'number' && Number.isSafeInteger(mid) && mid > 0) ||
        (typeof mid === 'string' && /^\d+$/u.test(mid) && /[1-9]/u.test(mid))
    )) {
        throw new Error('Selected businessUnit requires a non-placeholder positive MID mapping');
    }
    if (owns(config, 'directories')) {
        if (!record(config.directories)) {
            throw new Error('Project directories are invalid');
        }
        for (const name of ['retrieve', 'deploy', 'docs']) {
            if (
                owns(config.directories, name) &&
                config.directories[name] !== name &&
                config.directories[name] !== `${name}/`
            ) {
                throw new Error('Customized or invalid retrieve/deploy/docs roots are unsupported');
            }
        }
    }
    const preview = previewRetrieveDeploy({
        command,
        bu: `${credential}/${businessUnit}`,
        type,
        key,
        options,
    });
    return Object.freeze({
        ...preview,
        selectorVerification: 'verified-config-mapping',
        projectSelectors: Object.freeze({ credential, businessUnit }),
        executionReadiness: 'unknown',
        configuredPaths: 'unknown',
        limitations: Object.freeze([
            'Only the exact own credential/BU mapping and a non-placeholder MID were checked; authentication, permissions, native configuration validity and remote identity remain unknown.',
            'Configured paths and project-specific filesystem effects are unknown: no paths, files, containment, links, artifacts or hooks were inspected. Generic native effects are not proven project effects, even with default directory spellings.',
            'Native retrieve/deploy use configured roots (mcdev/lib/index.js:389-620, lib/Retriever.js:55-196, lib/Deployer.js:69-379; defaults: boilerplate/config.json). Custom retrieve/deploy/docs roots are not supported by this adapter.',
            'mcdev has no dry-run mode. Execution remains disabled: host-consent guarantees and native cleanup safety are unresolved; this preview cannot authorize an operation.',
        ]),
    });
}
