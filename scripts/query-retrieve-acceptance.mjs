#!/usr/bin/env node
/**
 * Development-only, fixed-selection acceptance adapter; never imported by production.
 * Before connecting/invoking, the host MUST establish and hold a quiescent interval
 * excluding all project/path mutation through collection, confirmation, launch and
 * settlement. This script cannot enforce filesystem exclusion. No flag, watcher or
 * advisory lock establishes it. Manual connection and that interval are separate gates.
 */
import fs from 'node:fs';
import { z } from 'zod';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    prepareQueryRetrieve,
    runConfirmedQueryRetrieve,
} from '../dist/query-retrieve-integration.js';

export const ACCEPTANCE_SELECTION = Object.freeze({
    projectRoot: String.raw`F:\Git\ide-root\mcdev-ssjs-validation`,
    credential: 'ssjs',
    businessUnit: 'MCDEV_Training_QA',
    key: 'ssjsg_is_q_1785491597439',
});
const MID = '518005426';
const DE_KEY = 'ssjsg_is_de_1785491597439';

/**
 * Read only bounded, regular local metadata, rejecting links and identity changes.
 * Host exclusion is still required; these checks are not filesystem exclusion.
 * @param file - Exact metadata path derived from the prepared retrieve destination.
 * @returns {object} Decoded metadata only; never authentication or session contents.
 */
function readMetadata(file) {
    const inspect = () => {
        let current = file;
        for (;;) {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || fs.realpathSync.native(current) !== current)
                throw new Error('Unsafe metadata');
            if (current !== file && !stat.isDirectory()) throw new Error('Unsafe ancestor');
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
            throw new Error('Unsafe metadata');
        return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    };
    const before = inspect();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const stat = fs.fstatSync(fd);
        if (JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]) !== before)
            throw new Error('Metadata changed');
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
            if (!count) break;
            length += count;
        }
        if (length !== stat.size || inspect() !== before) throw new Error('Metadata changed');
        return JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
        );
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Resolve the fixed query dependency from fresh same-BU local metadata only.
 * @param prepared - Fresh default coordinator preparation.
 * @returns {boolean} Whether actual local keys match the fixed dependency.
 */
export function checkAcceptanceDependency(prepared) {
    const query = readMetadata(prepared.destinations.json);
    if (query?.key !== ACCEPTANCE_SELECTION.key || query.r__dataExtension_key !== DE_KEY)
        return false;
    const buRoot = path.dirname(path.dirname(prepared.destinations.json));
    const de = readMetadata(
        path.join(buRoot, 'dataExtension', `${DE_KEY}.dataExtension-meta.json`)
    );
    return de?.CustomerKey === DE_KEY;
}

const terminal = (outcome) => ({
    outcome,
    processOutcome: 'not-started',
    artifactClassification: 'unverified',
    remoteCompletenessVerified: false,
    retryAllowed: false,
});
const outcomes = new Set([
    'project-busy',
    'decline',
    'cancel',
    'timeout',
    'invalid',
    'failed',
    'unsupported',
    'blocked',
    'invalid-input',
    'exited',
    'spawn-failed',
    'cancelled',
    'timed-out',
    'output-limit',
    'termination-unconfirmed',
]);
const artifacts = new Set([
    'local-materialization',
    'unchanged-unverified',
    'partial',
    'unverified',
]);

/**
 * Create an unconnected SDK server. Seams are synthetic-test-only, never tool arguments.
 * The executable entrypoint always uses the genuine SDK and default coordinator.
 * @param seams - Trusted synthetic test substitutes only.
 * @param seams.prepare - Preparation substitute.
 * @param seams.checkDependency - Local metadata check substitute.
 * @param seams.run - Coordinator substitute.
 * @returns {McpServer} Standalone development server with no import-time transport.
 */
export function createQueryRetrieveAcceptanceServer({
    prepare = prepareQueryRetrieve,
    checkDependency = checkAcceptanceDependency,
    run = runConfirmedQueryRetrieve,
} = {}) {
    const server = new McpServer({
        name: 'mcdev-development-query-retrieve-acceptance',
        version: '0.0.0',
    });
    let stopped = false;
    let busy = false;
    server.registerTool(
        'accept_fixed_query_retrieve',
        {
            description:
                'Development only. Host MUST hold project/path mutation exclusion from before invocation through settlement. Fixed query retrieval; client confirmation is not independent human attestation. No retries after a process attempt; remote completeness is never verified.',
            inputSchema: z.strictObject({}),
        },
        async (args, extra) => {
            let value;
            if (Object.keys(args).length) value = terminal('invalid');
            else if (stopped || busy) value = terminal('acceptance-stopped');
            else {
                busy = true;
                try {
                    if (extra.signal.aborted) value = terminal('cancel');
                    else {
                        const prepared = await prepare(ACCEPTANCE_SELECTION);
                        if (
                            Object.entries(ACCEPTANCE_SELECTION).some(
                                ([key, expected]) => prepared[key] !== expected
                            ) ||
                            prepared.mid !== MID
                        )
                            value = terminal('selection-rejected');
                        else if (await checkDependency(prepared)) {
                            const result = await run(prepared, {
                                server: server.server,
                                extra,
                                signal: extra.signal,
                            });
                            // One process attempt per manually connected server; no automatic reconciliation/retry.
                            stopped = result.process !== null || result.projectBlocked === true;
                            value = {
                                outcome: outcomes.has(result.outcome) ? result.outcome : 'failed',
                                processOutcome:
                                    result.process === null
                                        ? 'not-started'
                                        : outcomes.has(result.process?.outcome)
                                          ? result.process.outcome
                                          : 'unverified',
                                artifactClassification: artifacts.has(result.materialization)
                                    ? result.materialization
                                    : 'unverified',
                                remoteCompletenessVerified: false,
                                retryAllowed: false,
                            };
                        } else {
                            value = terminal('dependency-rejected');
                        }
                    }
                } catch {
                    stopped = true;
                    value = terminal('acceptance-failed');
                } finally {
                    busy = false;
                }
            }
            return { content: [{ type: 'text', text: JSON.stringify(value) }] };
        }
    );
    return server;
}

// Manual-only startup: host exclusion must already exist; no native operation on startup.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await createQueryRetrieveAcceptanceServer().connect(new StdioServerTransport());
}
