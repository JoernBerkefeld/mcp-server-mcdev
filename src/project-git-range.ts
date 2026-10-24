import { spawnSync } from 'node:child_process';
import { readProjectConfig } from './project-inspection.js';

export interface ProjectGitRange {
    projectRoot: string;
    source: { ref: string; commit: string | null };
    target: { ref: string; commit: string | null };
    ancestry: 'equal' | 'source-ahead' | 'target-ahead' | 'diverged' | 'unknown';
    snapshot: 'local';
    freshness: 'unknown';
    remoteBuSynchronization: 'unknown';
    findings: string[];
    limitations: string[];
    promotionAssessment?: {
        declaredEdge: 'promotion' | 'back-promotion';
        direction: 'source-to-target';
        basis: 'exact-source-commit-ancestry';
        status: 'contained' | 'not-contained' | 'unknown';
        policySource: 'caller-declared';
    };
}

// Deliberately narrower than Git: ASCII branch components or fully qualified refs only.
function safeRef(value: string): boolean {
    return (
        typeof value === 'string' &&
        value.length <= 256 &&
        /^(?:refs\/)?[\w-][\w./-]*$/u.test(value) &&
        !value.includes('..') &&
        value
            .split('/')
            .every(
                (part) =>
                    part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')
            ) &&
        !value.startsWith('-') &&
        (!value.startsWith('refs/') || value.split('/').length >= 3)
    );
}

/**
 * Resolve two explicit refs and compare local ancestry without reading commit content.
 * Callers must prevent concurrent project/Git mutation; this is not an atomic snapshot.
 * @param projectRoot - Explicit canonical absolute project root accepted by readProjectConfig.
 * @param sourceRef - Safe branch name or exact full ref, never a revision expression.
 * @param targetRef - Safe branch name or exact full ref, never a revision expression.
 * @param declaredEdge - Optional caller intent; both kinds use the same source-to-target direction.
 * @returns {ProjectGitRange} Immutable endpoints and bounded local evidence, not deployment policy.
 */
export function inspectProjectGitRange(
    projectRoot: string,
    sourceRef: string,
    targetRef: string,
    declaredEdge?: 'promotion' | 'back-promotion'
): ProjectGitRange {
    if (
        declaredEdge !== undefined &&
        declaredEdge !== 'promotion' &&
        declaredEdge !== 'back-promotion'
    )
        throw new TypeError('Invalid declared edge.');
    const canonical = readProjectConfig(projectRoot).projectRoot;
    const valid = safeRef(sourceRef) && safeRef(targetRef);
    const result: ProjectGitRange = {
        projectRoot: canonical,
        source: { ref: safeRef(sourceRef) ? sourceRef : '', commit: null },
        target: { ref: safeRef(targetRef) ? targetRef : '', commit: null },
        ancestry: 'unknown',
        snapshot: 'local',
        freshness: 'unknown',
        remoteBuSynchronization: 'unknown',
        findings: [],
        limitations: [
            'Local metadata only; refs may change during inspection and remote freshness is unknown.',
            'No branch roles or missing backpromotions can be inferred without confirmed policy.',
            'Dirty and detached status are not checked or prerequisites for read-only evidence.',
        ],
    };
    const finish = (): ProjectGitRange => {
        if (declaredEdge !== undefined) {
            result.promotionAssessment = {
                declaredEdge,
                direction: 'source-to-target',
                basis: 'exact-source-commit-ancestry',
                status:
                    result.ancestry === 'equal' || result.ancestry === 'target-ahead'
                        ? 'contained'
                        : result.ancestry === 'source-ahead' || result.ancestry === 'diverged'
                          ? 'not-contained'
                          : 'unknown',
                policySource: 'caller-declared',
            };
        }
        return result;
    };
    if (!valid) {
        result.findings.push('invalid-ref');
        return finish();
    }
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))
    );
    const run = (args: string[]) =>
        spawnSync(
            'git',
            [
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.hooksPath=/dev/null',
                '-c',
                'core.warnAmbiguousRefs=true',
                ...args,
            ],
            {
                cwd: canonical,
                env: {
                    ...env,
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_OPTIONAL_LOCKS: '0',
                    GIT_NO_LAZY_FETCH: '1',
                    GIT_NO_REPLACE_OBJECTS: '1',
                },
                shell: false,
                encoding: 'utf8',
                timeout: 5000,
                maxBuffer: 64 * 1024,
                windowsHide: true,
            }
        );
    const resolve = (ref: string): string | null => {
        // Symbolic verification rejects pseudo-refs, object IDs, and ambiguous DWIM names.
        const symbolic = run([
            'rev-parse',
            '--verify',
            '--symbolic-full-name',
            '--end-of-options',
            ref,
        ]);
        if (
            symbolic.error ||
            symbolic.status !== 0 ||
            symbolic.stderr ||
            !/^refs\/[^\r\n]+\n$/u.test(symbolic.stdout)
        )
            return null;
        const full = symbolic.stdout.slice(0, -1);
        if (
            !safeRef(full) ||
            (ref.startsWith('refs/')
                ? full !== ref
                : full !== `refs/heads/${ref}` && full !== `refs/remotes/${ref}`)
        )
            return null;
        const endpoint = run(['rev-parse', '--verify', '--end-of-options', `${full}^{commit}`]);
        return !endpoint.error &&
            endpoint.status === 0 &&
            !endpoint.stderr &&
            /^(?:[\da-f]{40}|[\da-f]{64})\n$/u.test(endpoint.stdout)
            ? endpoint.stdout.slice(0, -1)
            : null;
    };
    result.source.commit = resolve(sourceRef);
    result.target.commit = resolve(targetRef);
    const source = result.source.commit;
    const target = result.target.commit;
    if (!source || !target) {
        result.findings.push('endpoint-unverified');
        return finish();
    }
    if (source === target) {
        result.ancestry = 'equal';
        return finish();
    }
    const sourceContainsTarget = run(['merge-base', '--is-ancestor', target, source]);
    const targetContainsSource = run(['merge-base', '--is-ancestor', source, target]);
    const answers = [sourceContainsTarget, targetContainsSource];
    if (
        answers.some(
            (answer) =>
                answer.error ||
                ![0, 1].includes(answer.status ?? -1) ||
                answer.stdout ||
                answer.stderr
        )
    ) {
        result.findings.push('ancestry-unverified');
    } else if (sourceContainsTarget.status === 0 && targetContainsSource.status === 1) {
        result.ancestry = 'source-ahead';
    } else if (targetContainsSource.status === 0 && sourceContainsTarget.status === 1) {
        result.ancestry = 'target-ahead';
    } else if (answers.every((answer) => answer.status === 1)) {
        // Shallow boundaries cannot establish divergence from two negative answers.
        const shallow = run(['rev-parse', '--is-shallow-repository']);
        if (
            !shallow.error &&
            shallow.status === 0 &&
            !shallow.stderr &&
            shallow.stdout === 'false\n'
        ) {
            result.ancestry = 'diverged';
        } else result.findings.push('ancestry-unverified');
    } else result.findings.push('ancestry-unverified');
    return finish();
}
