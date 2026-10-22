import { toPathspec } from './childDiff';
import type { Git } from './git';
import type { GitHub } from './github';

export type SyncDiffMode = 'ci' | 'local';

export type SyncDiffSection = {
  /** Branch merged into the PR, from the merge commit message or `--right` */
  rightLabel: string;
  leftLabel: string;
  left: string;
  right: string;
  mergeBase: string | null;
  /** The commit the automatic merge is compared to */
  compareTo: string;
  conflictedFiles: string[];
  diff: string;
  reproCommand: string;
};

export type SyncDiffResult = {
  /**
   * - `combined`: one merged branch, compares the automatic merge with the PR
   *   head, so it includes edits made after the merge
   * - `per-merge`: more than one merged branch, compares each merge commit with
   *   its automatic merge
   */
  strategy: 'combined' | 'per-merge';
  head: string;
  sections: SyncDiffSection[];
};

export type SyncDiffError = {
  code: 'git-too-old' | 'no-merges-found' | 'merge-tree-failed';
  message: string;
  fix?: string;
};

type MergeCommit = {
  sha: string;
  firstParent: string;
  secondParent: string;
  label: string | null;
};

export type GetSyncDiffOptions = {
  mode: SyncDiffMode;
  /** The PR head commit */
  head: string;
  /** Branch the PR targets, e.g. the umbrella */
  left: string;
  /** Explicit merged branch, skips detecting it from the merge commits */
  right?: string;
  exclude: readonly string[];
  git: Git;
  github: GitHub;
  /** Max first-parent commits walked looking for merges */
  maxCommits?: number;
};

export async function getSyncDiff({
  mode,
  head,
  left,
  right,
  exclude,
  git,
  github,
  maxCommits = 100,
}: GetSyncDiffOptions): Promise<
  { ok: true; value: SyncDiffResult } | { ok: false; error: SyncDiffError }
> {
  const version = await git.version();

  if (version && (version[0] < 2 || (version[0] === 2 && version[1] < 38))) {
    return {
      ok: false,
      error: {
        code: 'git-too-old',
        message: `git >= 2.38 is required for \`git merge-tree --write-tree\`, found ${version.join('.')}`,
        fix: 'Update git, e.g. `brew upgrade git`',
      },
    };
  }

  const leftRef = await resolveRef(git, left);
  const headSha = await git.revParse(head);

  async function getMergeBase(a: string, b: string): Promise<string | null> {
    if (mode === 'ci') return github.getMergeBase(a, b);

    return git.mergeBase(a, b);
  }

  async function ensureCommits(shas: (string | null)[]) {
    if (mode !== 'ci') return;

    const missing: string[] = [];

    for (const sha of new Set(shas)) {
      if (sha && !(await git.commitExists(sha))) missing.push(sha);
    }

    if (missing.length > 0) {
      await git.runOk(['fetch', '--quiet', '--depth=1', git.remote, ...missing]);
    }
  }

  // the left side merged by the PR, changes that landed in it after the sync
  // don't show up in the diff
  const mergedLeft = await getMergeBase(leftRef.forApi, headSha);

  if (!mergedLeft) {
    return noMerges(`"${left}" and the PR head have no common ancestor`);
  }

  if (right !== undefined) {
    const rightRef = await resolveRef(git, right);
    const mergedRight = await getMergeBase(rightRef.forApi, headSha);

    if (!mergedRight) {
      return noMerges(`"${right}" and the PR head have no common ancestor`);
    }

    const section = await diffAgainstAutoMerge({
      left: mergedLeft,
      right: mergedRight,
      leftLabel: left,
      rightLabel: right,
      compareTo: headSha,
    });

    return section.ok ?
        { ok: true, value: { strategy: 'combined', head: headSha, sections: [section.value] } }
      : section;
  }

  const merges = await findMergedBranches();

  if (merges.length === 0) {
    return noMerges(
      `No merge of another branch found in the first-parent history of ${headSha.slice(0, 12)}`,
      'Merge the branch you are syncing into the PR branch, or pass `--right <branch>`',
    );
  }

  const groups = new Map<string, MergeCommit[]>();

  for (const merge of merges) {
    const key = merge.label ?? merge.secondParent;
    const group = groups.get(key);

    if (group) group.push(merge);
    else groups.set(key, [merge]);
  }

  if (groups.size === 1) {
    // merges are newest first, so the latest merged commit of the branch
    const latest = merges[0];

    if (!latest) return noMerges('No merges found');

    const section = await diffAgainstAutoMerge({
      left: mergedLeft,
      right: latest.secondParent,
      leftLabel: left,
      rightLabel: latest.label ?? latest.secondParent.slice(0, 12),
      compareTo: headSha,
    });

    return section.ok ?
        { ok: true, value: { strategy: 'combined', head: headSha, sections: [section.value] } }
      : section;
  }

  const sections: SyncDiffSection[] = [];

  for (const merge of [...merges].reverse()) {
    const section = await diffAgainstAutoMerge({
      left: merge.firstParent,
      right: merge.secondParent,
      leftLabel: left,
      rightLabel: merge.label ?? merge.secondParent.slice(0, 12),
      compareTo: merge.sha,
    });

    if (!section.ok) return section;

    sections.push(section.value);
  }

  return {
    ok: true,
    value: { strategy: 'per-merge', head: headSha, sections },
  };

  /**
   * Merge commits on the PR head first-parent chain, newest first, excluding
   * merges of the left branch itself (syncs with the parent)
   */
  async function findMergedBranches(): Promise<MergeCommit[]> {
    const out = await git.runOk([
      'rev-list',
      '--first-parent',
      '--parents',
      `--max-count=${maxCommits}`,
      headSha,
    ]);

    const result: MergeCommit[] = [];

    for (const line of out.split('\n')) {
      const [sha, firstParent, secondParent] = line.trim().split(' ');

      if (!sha) continue;

      if (await isAncestorOfLeft(sha)) break;

      if (!firstParent || !secondParent) continue;

      if (await isAncestorOfLeft(secondParent)) continue;

      const message = await git.runOk(['log', '-1', '--format=%B', sha]);

      result.push({
        sha,
        firstParent,
        secondParent,
        label: parseMergedBranch(message, git.remote),
      });
    }

    return result;
  }

  async function isAncestorOfLeft(sha: string): Promise<boolean> {
    if (mode === 'ci') {
      return (await github.getMergeBase(leftRef.forApi, sha)) === sha;
    }

    const result = await git.run([
      'merge-base',
      '--is-ancestor',
      sha,
      leftRef.local,
    ]);

    return result.code === 0;
  }

  async function diffAgainstAutoMerge({
    left: leftCommit,
    right: rightCommit,
    leftLabel,
    rightLabel,
    compareTo,
  }: {
    left: string;
    right: string;
    leftLabel: string;
    rightLabel: string;
    compareTo: string;
  }): Promise<
    { ok: true; value: SyncDiffSection } | { ok: false; error: SyncDiffError }
  > {
    // the checkout is shallow in CI, where merge bases can be silently wrong,
    // so they come from the GitHub API. Locally merge-tree computes it, which
    // also works with git < 2.40 (no `--merge-base`)
    const mergeBase =
      mode === 'ci' ? await github.getMergeBase(leftCommit, rightCommit) : null;

    await ensureCommits([leftCommit, rightCommit, mergeBase, compareTo]);

    const mergeTreeArgs = [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      ...(mergeBase ? [`--merge-base=${mergeBase}`] : []),
      leftCommit,
      rightCommit,
    ];

    // redo the merge without resolving conflicts, the diff between it and the
    // PR is what was changed by hand: conflict resolutions and edits
    const mergeTree = await git.run(mergeTreeArgs);
    const [autoMergeTree, ...conflictedFiles] = mergeTree.stdout
      .trim()
      .split('\n');

    // exits with 1 when there are conflicts, so check the output instead
    if (!autoMergeTree || !/^[\da-f]{40,64}$/.test(autoMergeTree)) {
      return {
        ok: false,
        error: {
          code: 'merge-tree-failed',
          message: `Failed to redo the merge of ${leftLabel} and ${rightLabel}: ${mergeTree.stderr.trim()}`,
          fix:
            mode === 'ci' ?
              'Check that git >= 2.40 is installed in CI'
            : undefined,
        },
      };
    }

    const pathspec = toPathspec({ exclude });

    const diffOut = await git.runOk([
      'diff',
      '--no-color',
      autoMergeTree,
      compareTo,
      '-w',
      ...pathspec,
    ]);

    // conflict markers are labeled with the commits passed to merge-tree
    const diff = diffOut
      .replaceAll(leftCommit, leftLabel)
      .replaceAll(rightCommit, rightLabel)
      .trim();

    const quotedPathspec = pathspec
      .map((part) => (part.startsWith(':(') ? `'${part}'` : part))
      .join(' ');

    return {
      ok: true,
      value: {
        leftLabel,
        rightLabel,
        left: leftCommit,
        right: rightCommit,
        mergeBase,
        compareTo,
        conflictedFiles: conflictedFiles.filter((file) => file.length > 0),
        diff,
        reproCommand: `git diff $(git merge-tree --write-tree${mergeBase ? ` --merge-base=${mergeBase}` : ''} ${leftCommit} ${rightCommit} | head -1) ${compareTo} -w ${quotedPathspec}`,
      },
    };
  }
}

function noMerges(message: string, fix?: string) {
  return {
    ok: false as const,
    error: { code: 'no-merges-found' as const, message, fix },
  };
}

/**
 * Resolves a branch name to a local ref (preferring the remote branch, which is
 * what was pushed) and the name used in the GitHub API
 */
async function resolveRef(git: Git, ref: string) {
  if (await git.remoteBranchExists(ref)) {
    return { local: `${git.remote}/${ref}`, forApi: ref };
  }

  return { local: ref, forApi: ref };
}

/** Branch name from a merge commit message */
export function parseMergedBranch(
  message: string,
  remote = 'origin',
): string | null {
  const firstLine = message.split('\n')[0]?.trim() ?? '';

  const remoteTracking = /^Merge remote-tracking branch '([^']+)'/.exec(
    firstLine,
  );

  if (remoteTracking?.[1]) {
    const branch = remoteTracking[1];

    return branch.startsWith(`${remote}/`) ?
        branch.slice(remote.length + 1)
      : branch;
  }

  const branch = /^Merge branch '([^']+)'/.exec(firstLine);

  if (branch?.[1]) return branch[1];

  const pullRequest = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(
    firstLine,
  );

  if (pullRequest?.[1]) return pullRequest[1];

  return null;
}

export function renderSyncDiffComment(
  result: SyncDiffResult,
  { maxChars }: { maxChars: number },
): string {
  const sectionMaxChars = Math.floor(maxChars / result.sections.length);

  const parts = ['## Sync diff', ''];

  if (result.strategy === 'per-merge') {
    parts.push(
      `This PR merged ${result.sections.length} branches, so each merge commit is compared with its automatic merge. Edits made outside the merge commits are not shown here.`,
      '',
    );
  }

  for (const section of result.sections) {
    if (result.strategy === 'per-merge') {
      parts.push(
        `### \`${section.rightLabel}\` (${section.compareTo.slice(0, 12)})`,
        '',
      );
    }

    parts.push(
      `Changes made on top of the automatic merge of \`${section.leftLabel}\` and \`${section.rightLabel}\`: conflict resolutions and manual edits. \`-\` lines are the automatic merge, with unresolved conflicts between markers, \`+\` lines are what the PR has instead.`,
      '',
      section.conflictedFiles.length > 0 ?
        `Conflicted files: ${section.conflictedFiles.map((file) => `\`${file}\``).join(', ')}`
      : 'No conflicts.',
      '',
    );

    if (!section.diff) {
      parts.push(
        'The PR matches the automatic merge, there are no conflict resolutions or manual edits.',
      );
    } else if (section.diff.length > sectionMaxChars) {
      parts.push(
        'Diff is too big to be shown here, run this to see it:',
        '',
        '~~~sh',
        section.reproCommand,
        '~~~',
      );
    } else {
      parts.push(
        '~~~diff',
        section.diff.replaceAll('~~~', '\\~\\~\\~'),
        '~~~',
      );
    }

    parts.push('');
  }

  return parts.join('\n');
}
