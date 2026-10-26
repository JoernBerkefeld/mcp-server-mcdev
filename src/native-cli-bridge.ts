import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Seed API-only choices in the installed CLI's own singleton, then run its unchanged parser.
 * The supervised parent validates the installed package, paths and selection before launch.
 * @param cliEntry - Validated absolute installed lib/cli.js path.
 * @param fixShared - Nonempty shared-folder selection removed from CLI argv by the contract.
 * @param args - Original CLI arguments, without bridge transport arguments.
 */
export async function runNativeCliBridge(
    cliEntry: string,
    fixShared: string,
    args: readonly string[]
): Promise<void> {
    const { default: Mcdev } = await import(
        pathToFileURL(path.join(path.dirname(cliEntry), 'index.js')).href
    );
    Mcdev.setOptions({ fixShared, skipInteraction: true });
    process.argv = [process.execPath, cliEntry, ...args];
    await import(pathToFileURL(cliEntry).href);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const [cliEntry, fixShared, ...args] = process.argv.slice(2);
    await runNativeCliBridge(cliEntry, fixShared, args);
}
