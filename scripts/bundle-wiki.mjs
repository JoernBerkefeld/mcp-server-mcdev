/**
 * Copies Markdown from the sfmc-devtools.wiki checkout into bundled/wiki for offline MCP search.
 * Set SFMC_DEVTOOLS_WIKI to override the source directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const outDir = path.join(packageRoot, 'bundled', 'wiki');

const candidates = [
    process.env.SFMC_DEVTOOLS_WIKI,
    path.join(packageRoot, '..', 'sfmc-devtools.wiki'),
].filter(Boolean);

function copyWiki(sourceDir) {
    if (!fs.existsSync(sourceDir)) return false;
    fs.mkdirSync(outDir, { recursive: true });
    const names = fs.readdirSync(sourceDir).filter((n) => n.endsWith('.md'));
    if (names.length === 0) return false;
    for (const name of names) {
        fs.copyFileSync(path.join(sourceDir, name), path.join(outDir, name));
    }
    process.stderr.write(`bundle-wiki: copied ${names.length} files from ${sourceDir}\n`);
    return true;
}

let ok = false;
for (const dir of candidates) {
    if (copyWiki(dir)) {
        ok = true;
        break;
    }
}

if (!ok) {
    fs.mkdirSync(outDir, { recursive: true });
    const stub = path.join(outDir, 'README.md');
    if (fs.existsSync(stub)) {
        process.stderr.write('bundle-wiki: no wiki source found; keeping existing bundled/wiki\n');
    } else {
        fs.writeFileSync(
            stub,
            '# Wiki bundle placeholder\n\nRun `npm run bundle-wiki` with `../sfmc-devtools.wiki` present, or set `SFMC_DEVTOOLS_WIKI`.\n'
        );
        process.stderr.write('bundle-wiki: no wiki source found; wrote stub README.md\n');
    }
}
