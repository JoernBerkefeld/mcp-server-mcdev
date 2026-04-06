/**
 * Configures mcdev for programmatic use without writing to stdout (MCP uses stdio for JSON-RPC).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Mcdev from 'mcdev';

let optionsApplied = false;

export function packageRootDir(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Call before Mcdev.explainTypes() or any API that may print tables or version banners. */
export function ensureMcdevSilentJson(): void {
    if (optionsApplied) return;
    Mcdev.setOptions({ json: true, silent: true });
    optionsApplied = true;
}

export function getBundledMcdevVersion(): string {
    const p = path.join(packageRootDir(), 'node_modules', 'mcdev', 'package.json');
    const raw = fs.readFileSync(p, 'utf8');
    return (JSON.parse(raw) as { version: string }).version;
}
