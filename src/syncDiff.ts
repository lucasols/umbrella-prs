import { getDiffFilePath, splitFileDiffs, toPathspec } from './childDiff';
import { formatCommand } from './exec';
import type { Git } from './git';
import type { GitHub } from './github';

const shaRegex = /^[\da-f]{40,64}$/;
const remoteTrackingMergeRegex = /^Merge remote-tracking branch '([^']+)'/;
const branchMergeRegex = /^Merge branch '([^']+)'/;
const githubPrMergeRegex = /^Merge pull request #\d+ from /;
const pullRequestMergeRegex = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/;
const trailingNewlinesRegex = /\n+$/;

export type SyncDiffContents = {
  /** Automatic merge, by path */
  before: Record<string, string>;
  /** `compareTo`, by path */
  after: Record<string, string>;
};

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
  /** Plain git command that prints the diff */
  reproCommand: string;
  /** Contents of the changed files, used to expand the context in the HTML viewer */
  contents?: SyncDiffContents;
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
  /** CLI command that opens the diff in the browser */
  reviewCommand: string;
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

export type SyncDiffMode = 'ci' | 'local';

export type GetSyncDiffOptions = {
  mode: SyncDiffMode;
  /** The PR head commit */
  head: string;
  /** Branch the PR targets, e.g. the umbrella */
  left: string;
  /** Name of the left side, defaults to `left` */
  leftLabel?: string;
  /** PR number, used in the `reviewCommand` instead of the head and left */
  pr?: number;
  /** Explicit merged branch, skips detecting it from the merge commits */
  right?: string;
  /** Globs excluded from the diff, also passed to the `reviewCommand` */
  exclude: readonly string[];
  /** Globs excluded from the diff that the CLI already applies, e.g. from the config */
  defaultExclude?: readonly string[];
  /** Includes the contents of the changed files */
  includeContents?: boolean;
  /** Runs the CLI in the `reviewCommand`, e.g. `pnpm exec umbrella-prs` */
  cliCommand?: string;
  git: Git;
  github: GitHub;
  /** Max first-parent commits walked looking for merges */
  maxCommits?: number;
};

const maxContentBytes = 1_000_000;

export async function getSyncDiff({
  mode,
  head,
  left,
  leftLabel: leftName = left,
  pr,
  right,
  exclude,
  defaultExclude = [],
  includeContents = false,
  cliCommand = 'umbrella-prs',
  git,
  github,
  maxCommits = 100,
}: GetSyncDiffOptions): Promise<
  { ok: true; value: SyncDiffResult } | { ok: false; error: SyncDiffError }
> {
  const version = await git.version();
  // CI needs `--merge-base` (2.40), locally merge-tree computes it (2.38)
  const minMinor = mode === 'ci' ? 40 : 38;

  if (
    version &&
    (version[0] < 2 || (version[0] === 2 && version[1] < minMinor))
  ) {
    return {
      ok: false,
      error: {
        code: 'git-too-old',
        message: `git >= 2.${minMinor} is required for \`git merge-tree --write-tree${mode === 'ci' ? ' --merge-base' : ''}\`, found ${version.join('.')}`,
        fix:
          mode === 'ci' ?
            'Use a runner with git >= 2.40 (ubuntu-latest has it)'
          : 'Update git, e.g. `brew upgrade git`',
      },
    };
  }

  const leftRef = await resolveRef(git, left);
  const headSha = await git.revParse(head);

  const reviewCommand = formatCommand(cliCommand, [
    'diff',
    'sync',
    ...(pr !== undefined ? [String(pr)] : [headSha, '--left', left]),
    ...(right !== undefined ? ['--right', right] : []),
    ...exclude.flatMap((glob) => ['--exclude', glob]),
    '--html',
  ]);

  async function getMergeBase(a: string, b: string): Promise<string | null> {
    if (mode === 'ci') return github.getMergeBase(a, b);

    return git.mergeBase(a, b);
  }

  /** CI uses the GitHub API, which takes branch names, locally the remote ref is used */
  function modeRef(ref: { local: string; forApi: string }) {
    return mode === 'ci' ? ref.forApi : ref.local;
  }

  async function ensureCommits(shas: (string | null)[]) {
    if (mode !== 'ci') return;

    const missing: string[] = [];

    for (const sha of new Set(shas)) {
      if (sha && !(await git.commitExists(sha))) missing.push(sha);
    }

    if (missing.length > 0) {
      await git.runOk([
        'fetch',
        '--quiet',
        '--depth=1',
        git.remote,
        ...missing,
      ]);
    }
  }

  // the left side merged by the PR, changes that landed in it after the sync
  // don't show up in the diff
  const mergedLeft = await getMergeBase(modeRef(leftRef), headSha);

  if (!mergedLeft) {
    return noMerges(`"${leftName}" and the PR head have no common ancestor`);
  }

  if (right !== undefined) {
    const rightRef = await resolveRef(git, right);
    const mergedRight = await getMergeBase(modeRef(rightRef), headSha);

    if (!mergedRight) {
      return noMerges(`"${right}" and the PR head have no common ancestor`);
    }

    const section = await diffAgainstAutoMerge({
      left: mergedLeft,
      right: mergedRight,
      leftLabel: leftName,
      rightLabel: right,
      compareTo: headSha,
    });

    return section.ok ?
        {
          ok: true,
          value: {
            strategy: 'combined',
            head: headSha,
            sections: [section.value],
            reviewCommand,
          },
        }
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
      leftLabel: leftName,
      rightLabel: latest.label ?? latest.secondParent.slice(0, 12),
      compareTo: headSha,
    });

    return section.ok ?
        {
          ok: true,
          value: {
            strategy: 'combined',
            head: headSha,
            sections: [section.value],
            reviewCommand,
          },
        }
      : section;
  }

  const sections: SyncDiffSection[] = [];

  for (const merge of [...merges].reverse()) {
    const section = await diffAgainstAutoMerge({
      left: merge.firstParent,
      right: merge.secondParent,
      leftLabel: leftName,
      rightLabel: merge.label ?? merge.secondParent.slice(0, 12),
      compareTo: merge.sha,
    });

    if (!section.ok) return section;

    sections.push(section.value);
  }

  return {
    ok: true,
    value: { strategy: 'per-merge', head: headSha, sections, reviewCommand },
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

      // PRs merged into a base on GitHub, part of the history the branch was
      // created from, never a sync merge
      if (githubPrMergeRegex.test(message)) continue;

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
    if (!autoMergeTree || !shaRegex.test(autoMergeTree)) {
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

    const pathspec = toPathspec({ exclude: [...defaultExclude, ...exclude] });

    const diffOut = await git.runOk([
      'diff',
      '--no-color',
      autoMergeTree,
      compareTo,
      '-w',
      ...pathspec,
    ]);

    // conflict markers are labeled with the commits passed to merge-tree
    function labelMarkers(text: string) {
      return text
        .replaceAll(leftCommit, leftLabel)
        .replaceAll(rightCommit, rightLabel);
    }

    // `trim` would also remove a trailing empty context line (` `)
    const diff = labelMarkers(diffOut).replace(trailingNewlinesRegex, '');

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
        ...(includeContents && diff ?
          {
            contents: await getChangedContents({
              git,
              before: autoMergeTree,
              after: compareTo,
              pathspec,
              mapBefore: labelMarkers,
            }),
          }
        : {}),
      },
    };
  }
}

/** What the umbrella PR shows after the sync, see `getSyncBaseDiff` */
export type SyncBaseDiff = {
  /** The merged base branch, e.g. `beta` */
  label: string;
  /** The branch being synced, e.g. the umbrella */
  branchLabel: string;
  from: string;
  to: string;
  diff: string;
  contents?: SyncDiffContents;
};

/**
 * Diff from the merged base commit to the PR head of the files changed by the
 * sync, how they differ from the base once the sync PR is merged. Uses the
 * newest merged branch as the base
 */
export async function getSyncBaseDiff({
  git,
  result,
  includeContents = false,
}: {
  git: Git;
  result: SyncDiffResult;
  includeContents?: boolean;
}): Promise<SyncBaseDiff | null> {
  const section = result.sections.at(-1);

  if (!section) return null;

  const paths = new Set<string>();

  for (const { diff } of result.sections) {
    for (const fileDiff of splitFileDiffs(diff)) {
      const filePath = getDiffFilePath(fileDiff);

      if (filePath !== null) paths.add(filePath);
    }
  }

  if (paths.size === 0) return null;

  // the paths come from the sync diff, so the excludes are already applied
  const pathspec = [
    '--',
    ...[...paths].map((filePath) => `:(literal)${filePath}`),
  ];
  const diffOut = await git.runOk([
    'diff',
    '--no-color',
    section.right,
    result.head,
    ...pathspec,
  ]);
  const diff = diffOut.replace(trailingNewlinesRegex, '');

  return {
    label: section.rightLabel,
    branchLabel: section.leftLabel,
    from: section.right,
    to: result.head,
    diff,
    ...(includeContents && diff ?
      {
        contents: await getChangedContents({
          git,
          before: section.right,
          after: result.head,
          pathspec,
        }),
      }
    : {}),
  };
}

async function getChangedContents({
  git,
  before,
  after,
  pathspec,
  mapBefore = (text) => text,
}: {
  git: Git;
  before: string;
  after: string;
  pathspec: string[];
  mapBefore?: (text: string) => string;
}): Promise<SyncDiffContents> {
  const out = await git.runOk([
    'diff',
    '--name-status',
    '-z',
    before,
    after,
    ...pathspec,
  ]);

  const contents: SyncDiffContents = { before: {}, after: {} };
  const fields = out.split('\0');

  for (let index = 0; index < fields.length;) {
    const status = fields[index] ?? '';
    const hasTwoPaths = status.startsWith('R') || status.startsWith('C');
    const beforePath = fields[index + 1];
    const afterPath = hasTwoPaths ? fields[index + 2] : beforePath;

    index += hasTwoPaths ? 3 : 2;

    if (!status || !beforePath || !afterPath) continue;

    if (!status.startsWith('A')) {
      const text = await readBlob(git, before, beforePath);

      if (text !== null) contents.before[beforePath] = mapBefore(text);
    }

    if (!status.startsWith('D')) {
      const text = await readBlob(git, after, afterPath);

      if (text !== null) contents.after[afterPath] = text;
    }
  }

  return contents;
}

/** `null` for binary and big files */
async function readBlob(git: Git, treeish: string, filePath: string) {
  const blob = `${treeish}:${filePath}`;
  const size = await git.run(['cat-file', '-s', blob]);

  if (size.code !== 0 || Number(size.stdout.trim()) > maxContentBytes) {
    return null;
  }

  const text = await git.runOk(['cat-file', 'blob', blob]);

  return text.includes('\0') ? null : text;
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

  const remoteTracking = remoteTrackingMergeRegex.exec(firstLine);

  if (remoteTracking?.[1]) {
    const branch = remoteTracking[1];

    return branch.startsWith(`${remote}/`) ?
        branch.slice(remote.length + 1)
      : branch;
  }

  const branch = branchMergeRegex.exec(firstLine);

  if (branch?.[1]) return branch[1];

  const pullRequest = pullRequestMergeRegex.exec(firstLine);

  if (pullRequest?.[1]) return pullRequest[1];

  return null;
}

export function renderSyncDiffComment(
  result: SyncDiffResult,
  { maxChars }: { maxChars: number },
): string {
  const sectionMaxChars = Math.floor(maxChars / result.sections.length);

  const parts = [
    '## Sync diff',
    '',
    'Review it in the browser, where files can be marked as viewed:',
    '',
    '~~~sh',
    result.reviewCommand,
    '~~~',
    '',
  ];

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
        'Diff is too big to be shown here, open it with the command above.',
        '',
        '<details><summary>Plain git command</summary>',
        '',
        '~~~sh',
        section.reproCommand,
        '~~~',
        '',
        '</details>',
      );
    } else {
      parts.push('~~~diff', section.diff.replaceAll('~~~', '\\~\\~\\~'), '~~~');
    }

    parts.push('');
  }

  return parts.join('\n');
}
