import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const versionPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;

/**
 * Copy registry metadata with the owning package's release version.
 * @param packageManifest - Authoritative owning package manifest.
 * @param serverManifest - Registry metadata to synchronize.
 * @returns {object} Updated metadata without modifying either input.
 */
export function syncServerVersions(packageManifest, serverManifest) {
    if (
        !object(packageManifest) ||
        packageManifest.name !== 'mcp-server-mcdev' ||
        typeof packageManifest.version !== 'string' ||
        !versionPattern.test(packageManifest.version) ||
        typeof packageManifest.mcpName !== 'string' ||
        !packageManifest.mcpName.trim() ||
        !object(serverManifest) ||
        typeof serverManifest.version !== 'string' ||
        !versionPattern.test(serverManifest.version) ||
        serverManifest.name !== packageManifest.mcpName ||
        !Array.isArray(serverManifest.packages)
    ) {
        throw new Error('Invalid owning package or server manifest.');
    }
    let owners = 0;
    const packages = serverManifest.packages.map((entry) => {
        if (!object(entry)) throw new Error('Invalid registry package entry.');
        if (entry.identifier !== packageManifest.name) return entry;
        if (
            entry.registryType !== 'npm' ||
            typeof entry.version !== 'string' ||
            !versionPattern.test(entry.version) ||
            !object(entry.transport) ||
            entry.transport.type !== 'stdio'
        ) {
            throw new Error('Invalid owning npm package entry.');
        }
        owners++;
        return { ...entry, version: packageManifest.version };
    });
    if (!owners) throw new Error('Missing owning npm package entry.');
    return { ...serverManifest, version: packageManifest.version, packages };
}

/**
 * Synchronize and stage only the registry manifest after npm updates its files.
 * @returns {void} Nothing.
 */
function main() {
    if (process.argv.length !== 2) throw new Error('No arguments are accepted.');
    const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
    const git = (args) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr.trim()}`);
        return result.stdout.trim();
    };
    if (fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== root) {
        throw new Error('Owning package must be the Git toplevel.');
    }
    for (const name of ['package.json', 'server.json']) {
        const filename = path.join(root, name);
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename) {
            throw new Error(`Manifest must be a regular non-link file: ${name}`);
        }
    }
    if (git(['diff', '--cached', '--name-only'])) throw new Error('Index must be empty.');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const server = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
    const output = JSON.stringify(syncServerVersions(pkg, server), null, 2) + '\n';
    fs.writeFileSync(path.join(root, 'server.json'), output, 'utf8');
    git(['add', '--', 'server.json']);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try {
        main();
    } catch (ex) {
        process.stderr.write(`Server version synchronization failed: ${ex.message}\n`);
        process.exitCode = 1;
    }
}
