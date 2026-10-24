import assert from 'node:assert/strict';
import { validateTempEnvironment } from '../dist/temp-environment.js';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const expectedVersion = json(path.join(repo, 'package.json')).version;

/**
 * Run npm without a shell, preserving the explicit wiki source.
 * @param args - npm command arguments.
 * @param cwd - Isolated command working directory.
 * @returns {string} Captured standard output.
 */
function npm(args, cwd) {
    assert.ok(process.env.npm_execpath, 'Run acceptance via npm test');
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
        cwd,
        env: process.env,
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 10_000_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
}

/**
 * Read a JSON manifest from the isolated installed tree.
 * @param filename - Manifest absolute path.
 * @returns {object} Parsed manifest data.
 */
function json(filename) {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

test(
    'packed package acceptance without checkout module resolution',
    { timeout: 240_000 },
    async (t) => {
        validateTempEnvironment();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-packed-acceptance-'));
        const archive = path.join(root, 'archive');
        const fixture = path.join(root, 'consumer');
        const owner = randomUUID();
        const registered = [archive, fixture];
        fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ owner, registered }));
        for (const directory of registered) {
            const relative = path.relative(root, directory);
            assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
            fs.mkdirSync(directory);
            for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
                assert.equal(fs.lstatSync(ancestor).isSymbolicLink(), false);
                assert.equal(
                    fs.realpathSync(ancestor).toLowerCase(),
                    path.resolve(ancestor).toLowerCase()
                );
                if (path.dirname(ancestor) === ancestor) break;
            }
        }
        t.diagnostic(
            `Retained owned fixture ${root}; owner ${owner}; registered ${registered.join(', ')}; no deletion attempted`
        );
        const packed = JSON.parse(
            npm(['pack', '--json', '--no-workspaces', '--pack-destination', archive], repo)
        );
        const files = packed[0].files.map((entry) => entry.path);
        await t.test('pack includes runtime, 16 frozen wiki pages, data and manifest', () => {
            for (const filename of [
                'dist/index.js',
                'dist/mcdev-safe.js',
                'data/metadata-checklists.json',
                'server.json',
                'package.json',
            ]) {
                assert.ok(files.includes(filename), filename);
            }
            assert.equal(
                files.filter(
                    (filename) => filename.startsWith('bundled/wiki/') && filename.endsWith('.md')
                ).length,
                16
            );
            assert.ok(!files.some((filename) => filename.startsWith('node_modules/')));
            assert.ok(!files.some((filename) => /^(?:scripts|tests)\//u.test(filename)));
            assert.ok(files.includes('dist/query-retrieve-preview.js'));
            assert.ok(files.includes('dist/query-retrieve-execution.js'));
            assert.ok(files.includes('dist/script-retrieve-execution.js'));
            assert.ok(files.includes('dist/retrieve-log-diagnostics.js'));
        });
        fs.writeFileSync(
            path.join(fixture, 'package.json'),
            JSON.stringify({ name: 'isolated-mcdev-acceptance', version: '1.0.0', private: true })
        );
        npm(
            [
                'install',
                path.join(archive, packed[0].filename),
                '--no-workspaces',
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
            ],
            fixture
        );
        const installed = path.join(fixture, 'node_modules', 'mcp-server-mcdev');
        assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
        assert.equal(fs.realpathSync(installed).toLowerCase(), installed.toLowerCase());
        const configText =
            '  {\n' +
            ' "markets": {"acceptance": {}},\n' +
            ' "credentials": {"secret": "acceptance-secret-return-verbatim"},\n' +
            ' "custom": {"nested": [true, null, "preserve spacing"]}\n' +
            '}\n';
        fs.writeFileSync(path.join(fixture, '.mcdevrc.json'), configText);
        fs.writeFileSync(path.join(fixture, '.mcdev-auth.json'), 'acceptance-auth-never-read');
        await t.test('installed versions, Node floors and wiki content match release', () => {
            const pkg = json(path.join(installed, 'package.json'));
            const manifest = json(path.join(installed, 'server.json'));
            const mcdev = json(path.join(fixture, 'node_modules', 'mcdev', 'package.json'));
            const sdk = json(path.join(fixture, 'node_modules', 'sfmc-sdk', 'package.json'));
            assert.equal(pkg.version, expectedVersion);
            assert.equal(manifest.version, pkg.version);
            assert.equal(manifest.name, pkg.mcpName);
            for (const entry of manifest.packages) {
                assert.equal(entry.version, pkg.version);
                assert.equal(entry.identifier, pkg.name);
                assert.equal(entry.transport.type, 'stdio');
            }
            assert.equal(mcdev.version, '10.1.0');
            assert.equal(sdk.version, '4.0.2');
            assert.equal(pkg.engines.node, '^22.22.2 || >=24.15.0');
            assert.equal(mcdev.engines.node, pkg.engines.node);
            for (const filename of files.filter((filename) =>
                filename.startsWith('bundled/wiki/')
            )) {
                assert.deepEqual(
                    fs.readFileSync(path.join(installed, filename)),
                    fs.readFileSync(path.join(repo, filename))
                );
            }
        });
        await t.test('installed getBundledMcdevVersion resolves hoisted dependency', () => {
            const result = spawnSync(
                process.execPath,
                [
                    '--input-type=module',
                    '-e',
                    `import {getBundledMcdevVersion} from './node_modules/mcp-server-mcdev/dist/mcdev-safe.js'; process.stdout.write(getBundledMcdevVersion());`,
                ],
                { cwd: fixture, encoding: 'utf8', timeout: 30_000 }
            );
            assert.ifError(result.error);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, '10.1.0');
        });
        const child = spawn(process.execPath, [path.join(installed, 'dist', 'index.js')], {
            cwd: fixture,
            env: { ...process.env, NODE_PATH: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        const lines = [];
        const pending = new Map();
        let sequence = 0;
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        const reader = createInterface({ input: child.stdout });
        reader.on('line', (line) => {
            lines.push(line);
            try {
                const message = JSON.parse(line);
                pending.get(message.id)?.(message);
            } catch {
                /* Validated explicitly after process shutdown. */
            }
        });
        const exited = new Promise((resolve) => child.on('exit', resolve));
        t.after(async () => {
            child.stdin.end();
            const timer = globalThis.setTimeout(() => child.kill(), 2000);
            await exited;
            clearTimeout(timer);
            reader.close();
            assert.ok(lines.length > 0);
            for (const line of lines) {
                const message = JSON.parse(line);
                assert.equal(message.jsonrpc, '2.0', line);
                assert.ok(message.id !== undefined || typeof message.method === 'string', line);
            }
            assert.match(stderr, /mcp-server-mcdev running on stdio/);
            t.diagnostic(
                `stdout: ${lines.length} JSON-RPC-only lines; startup stdout empty; stderr startup banner present`
            );
        });
        /**
         * Send one MCP JSON-RPC request and reject protocol-level errors.
         * @param method - JSON-RPC method name.
         * @param params - Request parameters.
         * @returns {Promise<object>} The protocol response result.
         */
        async function request(method, params = {}) {
            const id = ++sequence;
            let timer;
            const response = new Promise((resolve, reject) => {
                timer = globalThis.setTimeout(
                    () => reject(new Error(`Timeout: ${method}; stderr: ${stderr}`)),
                    15_000
                );
                pending.set(id, resolve);
            });
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            try {
                const message = await response;
                assert.equal(message.error, undefined, JSON.stringify(message));
                return message.result;
            } finally {
                clearTimeout(timer);
                pending.delete(id);
            }
        }
        /**
         * Return text from a successful tool call.
         * @param name - Registered tool name.
         * @param args - Tool input arguments.
         * @returns {Promise<string>} Combined text content.
         */
        async function tool(name, args = {}) {
            const result = await request('tools/call', { name, arguments: args });
            assert.notEqual(result.isError, true, JSON.stringify(result));
            return result.content.map((entry) => entry.text).join('\n');
        }
        const callLogDiagnosis = (arguments_) =>
            request('tools/call', {
                name: 'diagnose_mcdev_retrieve_logs',
                arguments: arguments_,
            });
        await t.test(
            'stdio starts quietly and initializes with the owning release version',
            async () => {
                await delay(500);
                assert.deepEqual(lines, []);
                const result = await request('initialize', {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'packed-acceptance', version: '1.0.0' },
                });
                assert.deepEqual(result.serverInfo, {
                    name: 'mcp-server-mcdev',
                    version: expectedVersion,
                });
                child.stdin.write(
                    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
                );
            }
        );
        await t.test(
            'preserves existing tools, adds section retrieval and filters metadata',
            async () => {
                const result = await request('tools/list');
                assert.deepEqual(
                    result.tools.map((entry) => entry.name).toSorted(),
                    [
                        'mcdev_search_docs',
                        'mcdev_get_doc_section',
                        'mcdev_explain_config_key',
                        'mcdev_component_checklist',
                        'mcdev_list_metadata_types',
                        'mcdev_list_commands',
                        'mcdev_get_command',
                        'read_mcdev_project_config',
                        'diagnose_mcdev_project_config',
                        'inspect_mcdev_git_policy',
                        'inspect_mcdev_git_range',
                        'inspect_mcdev_project',
                        'inventory_mcdev_project_artifacts',
                        'resolve_mcdev_project_artifact',
                        'read_mcdev_artifact_source',
                        'preview_mcdev_project_command',
                        'prepare_mcdev_query_retrieve',
                        'retrieve_mcdev_query',
                        'retrieve_mcdev_script',
                        'render_mcdev_query_definition',
                        'diagnose_mcdev_retrieve_logs',
                        'preview_mcdev_project_config',
                    ].toSorted()
                );
                const all = await tool('mcdev_list_metadata_types');
                assert.match(all, /^mcdev 10\.1\.0 — \d+ type\(s\)/);
                assert.match(all, /\*\*journey\*\*/);
                const matching = await tool('mcdev_list_metadata_types', { filter: 'JoUrNeY' });
                assert.match(matching, /mcdev 10\.1\.0 — 2 type\(s\)/);
                assert.match(matching, /\*\*event\*\*/);
                assert.match(matching, /\*\*journey\*\*/);
                assert.match(
                    await tool('mcdev_list_metadata_types', { filter: 'no-such-type-acceptance' }),
                    /0 type\(s\)[\s\S]*No types match the filter/
                );
            }
        );
        await t.test(
            'installed Git range intent is additive, directional and strictly sanitized',
            async () => {
                const input = {
                    workspaceRoot: fixture,
                    sourceRef: 'main',
                    targetRef: 'refs/heads/main',
                };
                const baseline = JSON.parse(await tool('inspect_mcdev_git_range', input));
                assert.equal(Object.hasOwn(baseline, 'promotionAssessment'), false);
                assert.equal(baseline.ancestry, 'unknown');
                for (const declaredEdge of ['promotion', 'back-promotion']) {
                    const report = JSON.parse(
                        await tool('inspect_mcdev_git_range', { ...input, declaredEdge })
                    );
                    assert.deepEqual(report, {
                        ...baseline,
                        promotionAssessment: {
                            declaredEdge,
                            direction: 'source-to-target',
                            basis: 'exact-source-commit-ancestry',
                            status: 'unknown',
                            policySource: 'caller-declared',
                        },
                    });
                }
                for (const extra of [
                    { declaredEdge: 'acceptance-secret-invalid' },
                    { declaredEdge: null },
                    { 'acceptance-secret-property': true },
                ]) {
                    const result = await request('tools/call', {
                        name: 'inspect_mcdev_git_range',
                        arguments: { ...input, ...extra },
                    });
                    assert.equal(result.isError, true);
                    assert.match(
                        result.content[0].text,
                        /Project Git range inspection unavailable\./u
                    );
                    assert.doesNotMatch(
                        JSON.stringify(result),
                        /acceptance-secret|acceptance-auth/u
                    );
                }
            }
        );
        await t.test(
            'installed query preparation is non-executing and safely blocked',
            async () => {
                const result = await request('tools/call', {
                    name: 'prepare_mcdev_query_retrieve',
                    arguments: {
                        workspaceRoot: fixture,
                        credential: 'synthetic',
                        businessUnit: 'QA',
                        key: 'Example_1',
                    },
                });
                assert.equal(result.isError, true);
                assert.equal(result.content[0].text, 'Query retrieve preparation unavailable.');
                assert.doesNotMatch(JSON.stringify(result), /acceptance-secret|acceptance-auth/u);
            }
        );
        await t.test(
            'installed production query executor fails safely before native launch',
            async () => {
                const result = await request('tools/call', {
                    name: 'retrieve_mcdev_query',
                    arguments: {
                        workspaceRoot: fixture,
                        credential: 'synthetic',
                        businessUnit: 'QA',
                        key: 'Example_1',
                    },
                });
                assert.equal(result.isError, true);
                assert.equal(result.content[0].text, 'Query retrieve unavailable.');
                assert.doesNotMatch(JSON.stringify(result), /acceptance-secret|acceptance-auth/u);
                assert.equal(fs.existsSync(path.join(fixture, 'retrieve')), false);
            }
        );
        await t.test(
            'installed Script metadata executor rejects unsupported scope safely',
            async () => {
                for (const extra of [{}, { key: '*' }, { metadataType: 'query' }]) {
                    const result = await request('tools/call', {
                        name: 'retrieve_mcdev_script',
                        arguments: {
                            workspaceRoot: fixture,
                            credential: 'synthetic',
                            businessUnit: 'QA',
                            key: 'Example_1',
                            ...extra,
                        },
                    });
                    assert.equal(result.isError, true);
                    assert.match(result.content[0].text, /Script retrieve unavailable\./u);
                    assert.doesNotMatch(
                        JSON.stringify(result),
                        /acceptance-secret|acceptance-auth/u
                    );
                    assert.equal(fs.existsSync(path.join(fixture, 'retrieve')), false);
                }
            }
        );
        await t.test(
            'installed render schema and unavailable selectors are bounded and non-executing',
            async () => {
                const listed = await request('tools/list');
                const render = listed.tools.find(
                    (entry) => entry.name === 'render_mcdev_query_definition'
                );
                const selection = {
                    workspaceRoot: fixture,
                    credential: 'synthetic',
                    businessUnit: 'QA',
                    templateName: 'Source_1',
                    market: 'qa',
                };
                assert.equal(listed.tools.length, 22);
                assert.deepEqual(render.inputSchema.required, Object.keys(selection));
                assert.deepEqual(
                    Object.keys(render.inputSchema.properties),
                    Object.keys(selection)
                );
                assert.equal(render.inputSchema.additionalProperties, false);
                for (const property of Object.values(render.inputSchema.properties))
                    assert.deepEqual(property, { type: 'string' });
                assert.deepEqual(render.annotations, {
                    readOnlyHint: false,
                    destructiveHint: true,
                    idempotentHint: false,
                    openWorldHint: true,
                });
                const before = fs.readdirSync(fixture);
                const configBefore = fs.readFileSync(path.join(fixture, '.mcdevrc.json'));
                for (const args of [
                    {},
                    { ...selection, 'acceptance-secret-extra': true },
                    ...Object.keys(selection).map((key) => ({
                        ...selection,
                        [key]: ['acceptance-secret-invalid'],
                    })),
                ]) {
                    const result = await request('tools/call', {
                        name: render.name,
                        arguments: args,
                    });
                    assert.equal(result.isError, true);
                    assert.match(result.content[0].text, /Query definition render unavailable\./u);
                    assert.doesNotMatch(
                        JSON.stringify(result),
                        /acceptance-secret|acceptance-auth|ZodError|ENOENT/u
                    );
                }
                for (const extra of [
                    {},
                    { templateName: '*' },
                    { market: 'one,two' },
                    { credential: 'acceptance-secret-invalid' },
                    { workspaceRoot: 'relative-private-root' },
                ]) {
                    const result = await request('tools/call', {
                        name: render.name,
                        arguments: { ...selection, ...extra },
                    });
                    assert.notEqual(result.isError, true);
                    assert.deepEqual(JSON.parse(result.content[0].text), {
                        outcome: 'unavailable',
                        processOutcome: null,
                        projectBlocked: false,
                        destinations: [],
                        artifactCompletenessVerified: false,
                        remoteCompletenessVerified: false,
                        languageValidationPerformed: false,
                    });
                    assert.doesNotMatch(
                        JSON.stringify(result),
                        /acceptance-secret|acceptance-auth|relative-private-root|stdout|stderr/u
                    );
                }
                assert.deepEqual(fs.readdirSync(fixture), before);
                assert.deepEqual(
                    fs.readFileSync(path.join(fixture, '.mcdevrc.json')),
                    configBefore
                );
            }
        );
        await t.test(
            'installed historical-log diagnosis is strict and returns only finite observations',
            async () => {
                const configFile = path.join(fixture, '.mcdevrc.json');
                const file = '2026-10-22T12.00.00.000Z.log';
                const input = {
                    workspaceRoot: fixture,
                    credential: 'sample',
                    businessUnit: 'Training',
                    metadataType: 'query',
                    key: 'Example_1',
                    startedAfter: '2026-10-22T11:00:00.000Z',
                    startedBefore: '2026-10-22T13:00:00.000Z',
                };
                try {
                    fs.writeFileSync(
                        configFile,
                        JSON.stringify({
                            credentials: { sample: { businessUnits: { Training: '1001' } } },
                        })
                    );
                    const absent = await callLogDiagnosis(input);
                    assert.deepEqual(JSON.parse(absent.content[0].text), {
                        status: 'no-match',
                        remoteCompletenessVerified: false,
                        logs: [],
                    });
                    fs.mkdirSync(path.join(fixture, 'logs'));
                    fs.writeFileSync(
                        path.join(fixture, 'logs', file),
                        [
                            '14:00:00.000 debug: :: mcdev 10.1.0 :: ⚡ mcdev retrieve sample/Training query Example_1',
                            '14:00:00.001 info: mcdev:: Retrieve',
                            '14:00:00.002 info: :: Retrieving sample/Training',
                            '14:00:00.003 info: Retrieving: query - Key: Example_1',
                            '14:00:00.004 error: acceptance-secret-log-never-return',
                        ].join('\n')
                    );
                    fs.writeFileSync(
                        path.join(fixture, 'logs', file.replace('.log', '-errors.log')),
                        'acceptance-secret-companion'
                    );
                    const result = await callLogDiagnosis(input);
                    assert.deepEqual(JSON.parse(result.content[0].text), {
                        status: 'matched',
                        remoteCompletenessVerified: false,
                        logs: [
                            {
                                file,
                                invocationStartedAt: '2026-10-22T12:00:00.000Z',
                                findings: [
                                    { code: 'retrieve-start-observed', occurrences: 1 },
                                    { code: 'type-key-observed', occurrences: 1 },
                                ],
                                suppressedRecordCount: 1,
                            },
                        ],
                    });
                    assert.doesNotMatch(
                        JSON.stringify(result),
                        /acceptance-secret|acceptance-auth/u
                    );
                    assert.ok(!JSON.stringify(result).includes(fixture));
                    const malformed = await callLogDiagnosis({
                        ...input,
                        'acceptance-secret-property': true,
                    });
                    assert.equal(malformed.isError, true);
                    assert.doesNotMatch(
                        JSON.stringify(malformed),
                        /acceptance-secret|acceptance-auth/u
                    );
                    assert.equal(fs.existsSync(path.join(fixture, 'retrieve')), false);
                } finally {
                    fs.writeFileSync(configFile, configText);
                }
            }
        );
        await t.test('search source IDs resolve to complete bounded section pages', async () => {
            const { getChunks, getDocExcerpt } = await import(
                pathToFileURL(path.join(installed, 'dist', 'doc-search.js')).href
            );
            const search = await tool('mcdev_search_docs', { query: 'marketList', limit: 3 });
            const ids = [...search.matchAll(/\*\*Source ID:\*\* (.+)/g)].map((match) => match[1]);
            assert.ok(ids.length > 0);
            for (const id of ids) {
                const chunk = getChunks().find((entry) => entry.id === id);
                assert.ok(chunk, id);
                const excerpt = getDocExcerpt(chunk, 'marketList');
                assert.ok(search.includes(excerpt.text));
                assert.ok(
                    search.includes(`${excerpt.start}-${excerpt.end}/${excerpt.totalLength}`)
                );
                let offset = 0;
                let complete = '';
                do {
                    const page = JSON.parse(
                        await tool('mcdev_get_doc_section', { id, offset, limit: 137 })
                    );
                    assert.equal(page.id, id);
                    assert.equal(page.file, chunk.file);
                    assert.equal(page.heading, chunk.heading);
                    assert.equal(page.start, offset);
                    assert.ok(page.text.length <= 137);
                    assert.equal(page.end, offset + page.text.length);
                    assert.equal(page.totalLength, chunk.body.length);
                    assert.equal(page.text, chunk.body.slice(page.start, page.end));
                    complete += page.text;
                    offset = page.nextOffset;
                    assert.equal(offset, page.end < page.totalLength ? page.end : null);
                } while (offset !== null);
                assert.equal(complete, chunk.body);
                const end = JSON.parse(
                    await tool('mcdev_get_doc_section', { id, offset: chunk.body.length + 1 })
                );
                assert.equal(end.text, '');
                assert.equal(end.nextOffset, null);
            }
            const missing = await request('tools/call', {
                name: 'mcdev_get_doc_section',
                arguments: { id: 'missing-private-section' },
            });
            assert.equal(missing.isError, true);
            assert.equal(missing.content[0].text, 'Documentation section unavailable.');
            for (const args of [{ offset: -1 }, { limit: 0 }, { limit: 12001 }]) {
                const invalid = await request('tools/call', {
                    name: 'mcdev_get_doc_section',
                    arguments: { id: ids[0], ...args },
                });
                assert.equal(invalid.isError, true);
                assert.doesNotMatch(JSON.stringify(invalid), /RangeError|node:fs|ENOENT/);
            }
        });
        await t.test(
            'config failures expose only safe codes, never paths or auth content',
            async () => {
                for (const [workspaceRoot, code] of [
                    [archive, 'missing-config'],
                    ['relative-private-path', 'unsafe-path'],
                    [path.join(fixture, '.mcdev-auth.json'), 'unsafe-path'],
                ]) {
                    const result = await request('tools/call', {
                        name: 'read_mcdev_project_config',
                        arguments: { workspaceRoot },
                    });
                    assert.equal(result.isError, true);
                    assert.equal(
                        result.content[0].text,
                        `Project configuration unavailable: ${code}.`
                    );
                    assert.doesNotMatch(
                        JSON.stringify(result),
                        /acceptance-auth-never-read|ENOENT/
                    );
                }
            }
        );
        await t.test(
            'project inspection preserves full config and reports unverified Git safely',
            async () => {
                const result = await request('tools/call', {
                    name: 'inspect_mcdev_project',
                    arguments: { workspaceRoot: fixture },
                });
                assert.notEqual(result.isError, true);
                const report = JSON.parse(result.content[1].text);
                assert.equal(report.rawText, configText);
                assert.deepEqual(report.config, JSON.parse(configText));
                assert.equal(report.gitSecurity.status, 'unverified');
                assert.deepEqual(report.gitSecurity.tracking, { verified: false, tracked: null });
                assert.equal(report.gitSecurity.ignore.verified, false);
                assert.match(
                    result.content[0].text,
                    /CRITICAL[\s\S]*Do not treat this project as protected/
                );
                assert.match(result.content[0].text, /Request explicit user approval/);
                assert.doesNotMatch(
                    JSON.stringify(result),
                    /fatal:|not a git repository|acceptance-auth-never-read/
                );
                const invalid = await request('tools/call', {
                    name: 'inspect_mcdev_project',
                    arguments: { workspaceRoot: 'private-relative-project' },
                });
                assert.equal(invalid.isError, true);
                assert.equal(
                    invalid.content[0].text,
                    'Project inspection unavailable: unsafe-path.'
                );
            }
        );
        await t.test(
            'project inspection distinguishes missing policy from effective project ignore',
            async () => {
                /**
                 * Execute fixture-only Git setup without reading auth or history.
                 * @param args - Synthetic repository setup arguments.
                 * @returns {void} Nothing.
                 */
                function fixtureGit(args) {
                    const result = spawnSync('git', args, {
                        cwd: fixture,
                        encoding: 'utf8',
                        timeout: 5000,
                    });
                    assert.ifError(result.error);
                    assert.equal(result.status, 0, result.stderr);
                }
                fixtureGit(['init']);
                fixtureGit(['config', '--local', 'user.name', 'Jörn Berkefeld']);
                fixtureGit(['config', '--local', 'user.email', 'joern.berkefeld@gmail.com']);
                const excludes = path.join(fixture, 'empty-excludes');
                fs.writeFileSync(excludes, '');
                fixtureGit(['config', '--local', 'core.excludesFile', excludes]);
                const missing = await request('tools/call', {
                    name: 'inspect_mcdev_project',
                    arguments: { workspaceRoot: fixture },
                });
                const missingReport = JSON.parse(missing.content[1].text);
                assert.equal(missingReport.rawText, configText);
                assert.equal(missingReport.gitSecurity.status, 'critical');
                assert.equal(missingReport.gitSecurity.ignore.verified, true);
                assert.equal(missingReport.gitSecurity.ignore.portableProjectProtection, false);
                assert.deepEqual(missingReport.gitSecurity.tracking, {
                    verified: true,
                    tracked: false,
                });
                assert.match(
                    missing.content[0].text,
                    /CRITICAL[\s\S]*Request explicit user approval/
                );
                assert.equal(fs.existsSync(path.join(fixture, '.gitignore')), false);
                fs.writeFileSync(path.join(fixture, '.gitignore'), '.mcdev-auth.json\n');
                const protectedResult = await request('tools/call', {
                    name: 'inspect_mcdev_project',
                    arguments: { workspaceRoot: fixture },
                });
                const protectedReport = JSON.parse(protectedResult.content[1].text);
                assert.equal(protectedReport.rawText, configText);
                assert.deepEqual(protectedReport.config, JSON.parse(configText));
                assert.equal(protectedReport.gitSecurity.status, 'protected');
                assert.equal(protectedReport.gitSecurity.ignore.source, 'project');
                assert.equal(protectedReport.gitSecurity.ignore.portableProjectProtection, true);
                assert.deepEqual(protectedReport.gitSecurity.tracking, {
                    verified: true,
                    tracked: false,
                });
                assert.deepEqual(protectedReport.gitSecurity.findings, []);
                assert.doesNotMatch(JSON.stringify(protectedResult), /acceptance-auth-never-read/);
                assert.equal(
                    await tool('read_mcdev_project_config', { workspaceRoot: fixture }),
                    configText
                );
                assert.equal(
                    fs.readFileSync(path.join(fixture, '.gitignore'), 'utf8'),
                    '.mcdev-auth.json\n'
                );
            }
        );
        await t.test('reads bundled wiki, searches docs and returns planning prompt', async () => {
            const resource = await request('resources/read', { uri: 'mcdev://wiki/index' });
            assert.match(resource.contents[0].text, /Bundled wiki files \(16\)/);
            assert.match(resource.contents[0].text, /Migrating-to-v10/);
            assert.match(await tool('mcdev_search_docs', { query: 'marketList' }), /marketList/i);
            assert.match(await tool('mcdev_explain_config_key', { topic: 'markets' }), /markets/i);
            assert.match(
                await tool('mcdev_component_checklist', { component: 'journey' }),
                /asset-email/
            );
            const prompt = await request('prompts/get', {
                name: 'plan_mcdev_change',
                arguments: { goal: 'acceptance journey deployment' },
            });
            assert.match(prompt.messages[0].content.text, /acceptance journey deployment/);
            assert.match(prompt.messages[0].content.text, /mcdev_search_docs/);
            const config = await tool('read_mcdev_project_config', { workspaceRoot: fixture });
            assert.equal(config, configText);
            assert.deepEqual(JSON.parse(config), JSON.parse(configText));
            assert.doesNotMatch(config, /acceptance-auth-never-read/);
            assert.match(
                prompt.messages[0].content.text,
                /do not claim those operations were performed/
            );
        });
    }
);
