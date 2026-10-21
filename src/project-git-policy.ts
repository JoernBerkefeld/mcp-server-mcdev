import { spawnSync } from 'node:child_process';
import { readProjectConfig } from './project-inspection.js';

export interface ProjectGitPolicy {
    projectRoot: string;
    verified: boolean;
    branch: { name: string | null; detached: boolean | null; unborn: boolean | null };
    tracking: {
        upstream: string | null;
        ahead: number | null;
        behind: number | null;
        ancestry: 'equal' | 'ahead' | 'behind' | 'diverged' | 'unknown';
    };
    status: { dirty: boolean | null; conflicted: boolean | null };
    refs: { names: string[]; truncated: boolean; verified: boolean };
    findings: string[];
    policy: {
        verified: false;
        branchRoles: null;
        ticketConvention: null;
        commitPrefix: null;
        questions: string[];
    };
    remoteBuSynchronization: 'unknown';
    excludedPaths: string[];
}

/**
 * Inspect local Git metadata only, not policy inferred from branch names or remote BU state.
 * Callers must prevent concurrent project/Git mutation; results are not an atomic snapshot.
 * @param projectRoot - Explicit canonical absolute project directory accepted by readProjectConfig.
 * @returns {ProjectGitPolicy} Bounded evidence with unknown values for failed or unavailable checks.
 */
export function inspectProjectGitPolicy(projectRoot: string): ProjectGitPolicy {
    const canonical = readProjectConfig(projectRoot).projectRoot;
    const result: ProjectGitPolicy = {
        projectRoot: canonical,
        verified: false,
        branch: { name: null, detached: null, unborn: null },
        tracking: { upstream: null, ahead: null, behind: null, ancestry: 'unknown' },
        status: { dirty: null, conflicted: null },
        refs: { names: [], truncated: false, verified: false },
        findings: [],
        policy: {
            verified: false,
            branchRoles: null,
            ticketConvention: null,
            commitPrefix: null,
            questions: [
                'Which branches have which roles, and which base branch should be used?',
                'Is a ticket identifier required, and what is its format?',
                'Is a commit-message prefix required, and what is its format?',
            ],
        },
        remoteBuSynchronization: 'unknown',
        // No paths or proposed file selections are returned, including rename source paths.
        excludedPaths: ['.mcdev-auth.json'],
    };
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))
    );
    const run = (args: string[]) =>
        spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
            cwd: canonical,
            env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
            shell: false,
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
        });
    const status = run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal']);
    if (!status.error && status.status === 0 && status.stdout.endsWith('\0')) {
        const fields = status.stdout.slice(0, -1).split('\0');
        let head: string | undefined;
        let oid: string | undefined;
        let valid = true;
        let dirty = false;
        let conflicted = false;
        let upstream: string | null = null;
        let counts: RegExpExecArray | null = null;
        for (let index = 0; index < fields.length; index++) {
            const field = fields[index];
            if (field.startsWith('# branch.head ')) head = field.slice(14);
            else if (field.startsWith('# branch.oid ')) oid = field.slice(13);
            else if (field.startsWith('# branch.upstream ')) upstream = field.slice(18);
            else if (field.startsWith('# branch.ab ')) {
                counts = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(field);
                if (!counts) valid = false;
            } else if (/^[12u] /u.test(field)) {
                // Validate metadata field counts without ever returning pathnames.
                const pattern = field.startsWith('u ')
                    ? /^u [A-Z.?!]{2} [NRSCTMU.]{4}(?: \d{6}){4}(?: [\da-f]{40,64}){3} .+$/u
                    : /^[12] [A-Z.?!]{2} [NRSCTMU.]{4}(?: \d{6}){3}(?: [\da-f]{40,64}){2} (?:[RC]\d+ )?.+$/u;
                if (!pattern.test(field)) valid = false;
                dirty = true;
                conflicted ||= field.startsWith('u ');
                if (field.startsWith('2 ') && !fields[++index]) valid = false;
            } else if (field.startsWith('? ') && field.length > 2) dirty = true;
            else valid = false;
        }
        if (
            valid &&
            head &&
            oid &&
            (oid === '(initial)' || /^[\da-f]{40,64}$/u.test(oid)) &&
            (!counts || upstream !== null) &&
            (!counts || counts.slice(1).every((value) => Number.isSafeInteger(Number(value))))
        ) {
            result.verified = true;
            result.branch = {
                name: head === '(detached)' ? null : head,
                detached: head === '(detached)',
                unborn: oid === '(initial)',
            };
            result.status = { dirty, conflicted };
            result.tracking.upstream = upstream;
            if (counts) {
                const ahead = Number(counts[1]);
                const behind = Number(counts[2]);
                result.tracking = {
                    upstream,
                    ahead,
                    behind,
                    ancestry: ahead ? (behind ? 'diverged' : 'ahead') : behind ? 'behind' : 'equal',
                };
            }
        }
    }
    const refs = run([
        'for-each-ref',
        '--count=101',
        '--format=%(refname)',
        'refs/heads/',
        'refs/remotes/',
    ]);
    if (!refs.error && refs.status === 0) {
        const names = refs.stdout.trimEnd().split('\n').filter(Boolean);
        if (
            names.length <= 101 &&
            names.every((name) => /^refs\/(heads|remotes)\/[^\s]+$/u.test(name))
        ) {
            result.refs = {
                names: names.slice(0, 100),
                truncated: names.length > 100,
                verified: true,
            };
        }
    }
    if (!result.verified) result.findings.push('git-status-unverified');
    if (!result.refs.verified) result.findings.push('git-refs-unverified');
    if (result.status.dirty) result.findings.push('dirty');
    if (result.status.conflicted) result.findings.push('conflicted');
    if (result.branch.detached) result.findings.push('detached');
    if (result.branch.unborn) result.findings.push('unborn');
    if (result.verified && !result.branch.detached && !result.tracking.upstream)
        result.findings.push('missing-upstream');
    if (result.tracking.behind) result.findings.push('behind');
    if (result.tracking.upstream && result.tracking.ancestry === 'unknown')
        result.findings.push('ancestry-unverified');
    return result;
}
