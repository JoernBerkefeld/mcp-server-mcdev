// The maintainer's Windows machine requires its temp directory on F:\Temp (workspace policy).
// CI runners and other contributors have their own temp directory, so that pin only applies locally.
// MCDEV_EXPECTED_TEMP overrides it explicitly; any CI environment (CI=true) disables the pin.
const localWindowsTemp = String.raw`f:\temp`;

/**
 * @param {Record<string, string | undefined>} [env] environment to read
 * @param {string} [platform] native platform name
 * @returns {string | false} lower-cased expected temp directory, or false when it is not pinned
 */
export function expectedTempRoot(env = process.env, platform = process.platform) {
    if (env.MCDEV_EXPECTED_TEMP) {
        return env.MCDEV_EXPECTED_TEMP.replace(/[\\/]+$/u, '').toLowerCase();
    }
    return !env.CI && platform === 'win32' && localWindowsTemp;
}
