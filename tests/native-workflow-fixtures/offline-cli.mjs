import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

for (const [name, value] of Object.entries({
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    node: os.tmpdir(),
})) {
    if (!value && name !== 'node' && (name !== 'TEMP' || process.platform !== 'win32')) continue;
    assert.ok(value && path.isAbsolute(value), name);
    if (process.platform === 'win32') {
        assert.equal(
            path
                .resolve(value)
                .replaceAll(/[\\/]+$/gu, '')
                .toLowerCase(),
            String.raw`f:\temp`,
            name
        );
    }
}
const deny = () => {
    throw new Error('Offline workflow forbids network/auth access');
};
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
const nativeRoot = fs.readFileSync(new URL('native-root.txt', import.meta.url), 'utf8');
const load = (relative) => import(pathToFileURL(path.join(nativeRoot, relative)).href);
const { default: Mcdev } = await load('index.js');
const { default: auth } = await load('util/auth.js');
const { default: config } = await load('util/config.js');
const { default: File } = await load('util/file.js');
const runRoot = fs.realpathSync.native(process.cwd());
assert.ok(fs.readFileSync(path.join(runRoot, '.owner'), 'utf8'));
const registeredRemovals = new Set(
    ['retrieve/cred/Source/query', '.mcdev/template', 'deploy/cred/Target/folder'].map((entry) =>
        path.resolve(entry)
    )
);
const nativeRemove = File.remove.bind(File);
// These exact native generated-output removals are part of this explicit fixture operation.
File.remove = async (target) => {
    const resolved = path.resolve(target);
    assert.ok(registeredRemovals.has(resolved), `Unregistered native cleanup: ${resolved}`);
    const relative = path.relative(runRoot, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    let current = resolved;
    while (current !== runRoot) {
        if (fs.existsSync(current)) {
            assert.equal(fs.lstatSync(current).isSymbolicLink(), false);
            assert.equal(fs.realpathSync.native(current), current);
        }
        current = path.dirname(current);
    }
    const pending = fs.existsSync(resolved) ? [resolved] : [];
    while (pending.length) {
        const entry = pending.pop();
        const stat = fs.lstatSync(entry);
        assert.equal(stat.isSymbolicLink(), false);
        assert.equal(fs.realpathSync.native(entry), entry);
        if (stat.isDirectory()) {
            pending.push(...fs.readdirSync(entry).map((name) => path.join(entry, name)));
        }
    }
    return nativeRemove(target);
};
const originalRead = File.readJSON.bind(File);
File.readJSON = (file, ...args) => {
    if (String(file).includes('.mcdev-auth')) deny();
    return originalRead(file, ...args);
};
File.readJsonSync = deny;
// Seed the native config cache at the auth-validation boundary, not a coordination method.
config.properties = JSON.parse(fs.readFileSync('.mcdevrc.json', 'utf8'));
// Native validation demands an auth file; bypass only that auth-bearing validation boundary.
config.checkProperties = async (properties) => {
    assert.equal(properties, config.properties);
    return true;
};
const observations = [];
const preserved = [
    'retrieve',
    'deploy',
    'build',
    'buildTemplate',
    'buildDefinition',
    'buildDefinitionBulk',
    'clone',
];
const originals = preserved.map((method) => Mcdev[method]);
const remote = JSON.parse(fs.readFileSync('remote.json', 'utf8'));
const record = (bu, operation, args) => observations.push({ bu, operation, args });
auth.saveCredential = deny;
auth.clearSessions = deny;
auth.getSDK = (bu) => {
    const unit = bu.businessUnit;
    const folders = [
        {
            ID: 10,
            CustomerKey: 'query-folder',
            Name: 'Query',
            ParentFolder: { ID: 0 },
            ContentType: 'queryactivity',
            Client: { ID: bu.mid },
        },
        {
            ID: 20,
            CustomerKey: 'de-folder',
            Name: 'Data Extensions',
            ParentFolder: { ID: 0 },
            ContentType: 'dataextension',
            Client: { ID: bu.mid },
        },
    ];
    const soap = async (type, fields, options) => {
        record(unit, 'soap.retrieveBulk', [type, fields, options]);
        if (type === 'DataFolder') return { Results: folders };
        if (type === 'DataExtension')
            return {
                Results: [
                    {
                        CustomerKey: 'target',
                        Name: 'Target',
                        ObjectID: 'target-id',
                        CategoryID: 20,
                    },
                ],
            };
        if (type === 'DataExtensionField') return { Results: [] };
        throw new Error(`Unexpected SOAP type: ${type}`);
    };
    const get = async (uri) => {
        record(unit, 'rest.get', [uri]);
        assert.ok(uri.startsWith('/automation/v1/queries/'), uri);
        return { items: unit === 'Source' ? structuredClone(remote) : [] };
    };
    const write = async (uri, payload) => {
        record(unit, 'rest.post', [uri, payload]);
        assert.equal(uri, '/automation/v1/queries/');
        if (payload.key === 'reject_me') throw new Error('Synthetic remote rejected query');
        return { ...payload, queryDefinitionId: `created-${payload.key}` };
    };
    return {
        soap: {
            retrieveBulk: soap,
            retrieve: async () => {
                throw new Error('Unexpected keyed SOAP request');
            },
        },
        rest: { getBulk: get, get, post: write },
    };
};
process.on('exit', () => {
    assert.deepEqual(
        preserved.map((method) => Mcdev[method]),
        originals
    );
    fs.writeFileSync('observations.json', JSON.stringify(observations));
});
process.argv[1] = path.join(nativeRoot, 'cli.js');
await load('cli.js');
