import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readProjectConfig } from './project-inspection.js';

const AUTH_NAME = '.mcdev-auth.json';
const MAX_OUTPUT_BYTES = 64 * 1024;

type IgnoreSource = 'project' | 'other-gitignore' | 'external' | 'none' | 'unverified';

export interface GitSecurityFinding {
    severity: 'critical';
    code: 'missing-project-protection' | 'tracked-auth' | 'git-check-unverified';
    message: string;
}

export interface ProjectGitSecurity {
    projectRoot: string;
    status: 'critical' | 'unverified' | 'protected';
    ignore: {
        verified: boolean;
        ignored: boolean | null;
        portableProjectProtection: boolean | null;
        source: IgnoreSource;
        negated: boolean | null;
        line: number | null;
    };
    tracking: { verified: boolean; tracked: boolean | null };
    findings: GitSecurityFinding[];
}

/**
 * Run only fixed, bounded metadata commands; never expose subprocess diagnostics.
 * @param projectRoot - Guarded canonical project directory.
 * @param args - Fixed Git metadata command arguments.
 * @param input - Fixed NUL-delimited auth filename for check-ignore only.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Bounded subprocess result.
 */
function git(projectRoot: string, args: string[], input?: string) {
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))
    );
    return spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd: projectRoot,
        env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        shell: false,
        input,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
    });
}

/**
 * Inspect effective ignore policy and index metadata without accessing auth contents/history.
 * Callers must prevent concurrent filesystem or Git configuration mutation during inspection.
 * @param projectRoot - Canonical absolute project directory accepted by readProjectConfig.
 * @returns {ProjectGitSecurity} Structured critical findings; unverified checks never imply protection.
 */
export function inspectProjectGitSecurity(projectRoot: string): ProjectGitSecurity {
    const canonical = readProjectConfig(projectRoot).projectRoot;
    const result: ProjectGitSecurity = {
        projectRoot: canonical,
        status: 'unverified',
        ignore: {
            verified: false,
            ignored: null,
            portableProjectProtection: null,
            source: 'unverified',
            negated: null,
            line: null,
        },
        tracking: { verified: false, tracked: null },
        findings: [],
    };
    const root = git(canonical, ['rev-parse', '--show-toplevel']);
    const gitRoot = root.stdout?.trim();
    if (!root.error && root.status === 0 && gitRoot && path.isAbsolute(gitRoot)) {
        const ignored = git(
            canonical,
            ['check-ignore', '--no-index', '--verbose', '-z', '--stdin'],
            `${AUTH_NAME}\0`
        );
        if (!ignored.error && (ignored.status === 0 || ignored.status === 1)) {
            const fields = ignored.stdout.split('\0');
            if (ignored.status === 1 && ignored.stdout === '') {
                result.ignore = {
                    verified: true,
                    ignored: false,
                    portableProjectProtection: false,
                    source: 'none',
                    negated: false,
                    line: null,
                };
            } else if (
                fields.length === 5 &&
                fields[4] === '' &&
                fields[3] === AUTH_NAME &&
                /^[1-9]\d*$/u.test(fields[1]) &&
                fields[0] !== '' &&
                fields[2] !== ''
            ) {
                const source = path.resolve(gitRoot, fields[0]);
                const projectIgnore = path.join(canonical, '.gitignore');
                const sourceKind: IgnoreSource =
                    source === projectIgnore
                        ? 'project'
                        : path.basename(source) === '.gitignore'
                          ? 'other-gitignore'
                          : 'external';
                const negated = fields[2].startsWith('!');
                result.ignore = {
                    verified: true,
                    ignored: !negated,
                    portableProjectProtection: sourceKind === 'project' && !negated,
                    source: sourceKind,
                    negated,
                    line: Number(fields[1]),
                };
            }
        }
        const tracked = git(canonical, [
            'ls-files',
            '--stage',
            '-z',
            '--',
            `:(literal)${AUTH_NAME}`,
        ]);
        if (!tracked.error && tracked.status === 0) {
            const entries = tracked.stdout === '' ? [] : tracked.stdout.split('\0').slice(0, -1);
            if (
                (tracked.stdout === '' || tracked.stdout.endsWith('\0')) &&
                entries.every((entry) =>
                    /^\d{6} [\da-f]{40,64} [0-3]\t\.mcdev-auth\.json$/u.test(entry)
                )
            ) {
                result.tracking = { verified: true, tracked: entries.length > 0 };
            }
        }
    }
    if (result.ignore.portableProjectProtection === false) {
        result.findings.push({
            severity: 'critical',
            code: 'missing-project-protection',
            message:
                'CRITICAL: The project .gitignore does not effectively protect .mcdev-auth.json. External or ancestor-only exclusions are not portable project policy.',
        });
    }
    if (result.tracking.tracked) {
        result.findings.push({
            severity: 'critical',
            code: 'tracked-auth',
            message:
                'CRITICAL: .mcdev-auth.json is present in the Git index, even if an ignore rule matches. Credential exposure requires investigation; no auth contents or history were inspected.',
        });
    }
    if (!result.ignore.verified || !result.tracking.verified) {
        result.findings.push({
            severity: 'critical',
            code: 'git-check-unverified',
            message:
                'CRITICAL: Git security checks could not be verified. Do not treat this project as protected.',
        });
        result.status = 'unverified';
    } else {
        result.status = result.findings.length > 0 ? 'critical' : 'protected';
    }
    return result;
}
