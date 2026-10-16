/**
 * Refreshes offline wiki Markdown only from an explicitly selected source.
 * Ordinary builds retain the committed bundle; --refresh opts into the sibling checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const outDir = path.join(packageRoot, 'bundled', 'wiki');
const sourceDir =
    process.env.SFMC_DEVTOOLS_WIKI ||
    (process.argv.includes('--refresh')
        ? path.join(packageRoot, '..', 'sfmc-devtools.wiki')
        : undefined);

if (sourceDir) {
    const names = fs.readdirSync(sourceDir).filter((name) => name.endsWith('.md'));
    if (names.length === 0) {
        throw new Error(`bundle-wiki: no Markdown files in selected source ${sourceDir}`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of names) {
        fs.copyFileSync(path.join(sourceDir, name), path.join(outDir, name));
    }
    process.stderr.write(`bundle-wiki: copied ${names.length} files from ${sourceDir}\n`);
} else if (fs.existsSync(outDir) && fs.readdirSync(outDir).some((name) => name.endsWith('.md'))) {
    process.stderr.write(
        'bundle-wiki: keeping committed bundled/wiki (set SFMC_DEVTOOLS_WIKI or use --refresh to update)\n'
    );
} else {
    throw new Error('bundle-wiki: no committed wiki; set SFMC_DEVTOOLS_WIKI or use --refresh');
}
