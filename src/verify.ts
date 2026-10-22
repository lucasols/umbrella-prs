import type { ResolvedConfig } from './config';
import { getDependencyChain } from './dependency';
import type { Git } from './git';
import { splitLines } from './git';
import type { FullPrInfo } from './github';
import {
  formatChildBranch,
  parseBranch,
  parseBranchStrict,
  type ParsedBranch,
} from './naming';
import { findParentPr } from './prTemplates';

export type VerifyErrorCode =
  | 'invalid-branch-name'
  | 'child-base-not-umbrella'
  | 'child-base-mismatch'
  | 'head-not-child'
  | 'umbrella-base-mismatch'
  | 'umbrella-base-merged'
  | 'parent-pr-not-found'
  | 'umbrella-unreviewed-commits';

export type VerifyError = {
  code: VerifyErrorCode;
  message: string;
  fix: string;
};

export type VerifyWarningCode = 'umbrella-depends-on-open-pr';

export type VerifyWarning = {
  code: VerifyWarningCode;
  message: string;
  fix?: string;
  dependsOn?: { branch: string; pr: number };
};

export type VerifyResult = {
  /** `null` when neither the head nor the base is an umbrella-workflow branch */
  kind: 'umbrella' | 'child' | 'sync' | null;
  head: ParsedBranch | null;
  base: ParsedBranch | null;
  /** Set for umbrella PRs that target another open branch, which lands first */
  dependsOn: { branch: string; pr: number } | null;
  /** Open PR of the child's umbrella */
  parentPr: { number: number; headRefName: string } | null;
  /** Most important first */
  errors: VerifyError[];
  /** Non-failing findings */
  warnings: VerifyWarning[];
};

const errorOrder: VerifyErrorCode[] = [
  'invalid-branch-name',
  'child-base-not-umbrella',
  'child-base-mismatch',
  'head-not-child',
  'umbrella-base-mismatch',
  'umbrella-base-merged',
  'parent-pr-not-found',
  'umbrella-unreviewed-commits',
];

export type VerifyInput = {
  head: string;
  base: string;
  prNumber?: number;
  /** Skips the git history checks, e.g. in tests or without a checkout */
  skipHistoryChecks?: boolean;
};

export async function verifyPr(
  { head, base, prNumber, skipHistoryChecks }: VerifyInput,
  {
    config,
    git,
    getOpenPrs,
    isBranchGone,
  }: {
    config: ResolvedConfig;
    git: Git;
    getOpenPrs: () => Promise<FullPrInfo[]>;
    /** Whether the branch was merged or deleted */
    isBranchGone: (branch: string) => Promise<boolean>;
  },
): Promise<VerifyResult> {
  const errors: VerifyError[] = [];
  const warnings: VerifyWarning[] = [];
  const prRef = prNumber !== undefined ? String(prNumber) : '<pr>';
  let dependsOn: VerifyResult['dependsOn'] = null;
  let parentPrInfo: VerifyResult['parentPr'] = null;

  function withDocs(message: string) {
    return config.docsLink ? `${message}. Docs: ${config.docsLink}` : message;
  }

  function addError(code: VerifyErrorCode, message: string, fix: string) {
    errors.push({ code, message: withDocs(message), fix });
  }

  const strictHead = parseBranchStrict(head, config);
  const parsedHead = strictHead.ok ? strictHead.value : null;
  const parsedBase = parseBranch(base, config);

  if (!strictHead.ok && strictHead.error.code !== 'not-umbrella-workflow') {
    addError(
      'invalid-branch-name',
      strictHead.error.message,
      'Create a branch with a valid name with `umbrella-prs create` and open a new PR from it',
    );
  }

  if (!parsedHead && !parsedBase && errors.length === 0) {
    return {
      kind: null,
      head: null,
      base: null,
      dependsOn,
      parentPr: parentPrInfo,
      errors,
      warnings,
    };
  }

  let kind: VerifyResult['kind'] = null;

  if (parsedHead?.kind === 'child') {
    kind = parsedHead.sync ? 'sync' : 'child';

    const umbrellaPr = (await getOpenPrs()).find((pr) => {
      const parsed = parseBranch(pr.headRefName, config);

      return parsed?.kind === 'umbrella' && parsed.name === parsedHead.umbrella;
    });

    const editBaseFix =
      umbrellaPr ?
        `Change the PR base: \`gh pr edit ${prRef} --base ${umbrellaPr.headRefName}\``
      : `Change the PR base to the umbrella branch of "${parsedHead.umbrella}"`;

    if (parsedBase?.kind !== 'umbrella') {
      addError(
        'child-base-not-umbrella',
        `Child branch "${head}" must target its umbrella branch, but it targets "${base}"`,
        editBaseFix,
      );
    } else if (parsedBase.name !== parsedHead.umbrella) {
      addError(
        'child-base-mismatch',
        `Child branch "${head}" belongs to umbrella "${parsedHead.umbrella}", but it targets umbrella "${parsedBase.name}" (${base})`,
        `${editBaseFix}, or create the branch as ${formatChildBranch({ umbrella: parsedBase.name, name: parsedHead.name })}`,
      );
    } else {
      const parentPr = findParentPr(parsedHead, await getOpenPrs(), config);

      if (!parentPr.ok) {
        addError(
          'parent-pr-not-found',
          parentPr.error.message,
          parentPr.error.fix,
        );
      } else {
        parentPrInfo = {
          number: parentPr.value.number,
          headRefName: parentPr.value.headRefName,
        };
      }
    }
  } else if (parsedHead?.kind === 'umbrella') {
    kind = 'umbrella';

    let historyBase = parsedHead.base;

    if (base !== parsedHead.base) {
      const chain = getDependencyChain(
        base,
        parsedHead.base,
        await getOpenPrs(),
      );
      const dependency = chain.ok ? chain.chain[0] : undefined;

      if (dependency) {
        dependsOn = { branch: base, pr: dependency.number };
        historyBase = base;

        warnings.push({
          code: 'umbrella-depends-on-open-pr',
          message: `Merge #${dependency.number} (${base}) into ${parsedHead.base} first, this PR will be retargeted to ${parsedHead.base} automatically`,
          dependsOn,
        });
      } else if (await isBranchGone(base)) {
        addError(
          'umbrella-base-merged',
          `Umbrella PR targets "${base}", which was already merged or deleted`,
          `Run \`umbrella-prs sync\` on ${head} to retarget it, or \`gh pr edit ${prRef} --base ${parsedHead.base}\``,
        );
      } else {
        addError(
          'umbrella-base-mismatch',
          `Umbrella branch "${head}" of type "${parsedHead.type}" must target "${parsedHead.base}", or an open branch whose PR chain leads to it, but it targets "${base}"`,
          `Change the PR base: \`gh pr edit ${prRef} --base ${parsedHead.base}\`, or open the PR of "${base}" first`,
        );
      }
    }

    if (errors.length === 0 && !skipHistoryChecks) {
      const hasUnreviewedCommits = await checkUnreviewedCreationCommit(
        git,
        historyBase,
        head,
      );

      if (hasUnreviewedCommits) {
        addError(
          'umbrella-unreviewed-commits',
          `Umbrella branch "${head}" was created with unreviewed commits, its first commit must be an empty commit on top of "${historyBase}"`,
          `Recreate the umbrella with \`umbrella-prs create umbrella <name> --type ${parsedHead.type}\` and move the changes to a child branch`,
        );
      }
    }
  } else if (parsedBase?.kind === 'umbrella') {
    kind = 'child';

    addError(
      'head-not-child',
      `PRs into umbrella "${parsedBase.name}" must come from a child branch, but the head is "${head}"`,
      `Convert the branch with \`umbrella-prs convert <child-name> --umbrella ${parsedBase.name}\` and open the PR from the new branch`,
    );
  }

  errors.sort(
    (a, b) => errorOrder.indexOf(a.code) - errorOrder.indexOf(b.code),
  );

  return {
    kind,
    head: parsedHead,
    base: parsedBase,
    dependsOn,
    parentPr: parentPrInfo,
    errors,
    warnings,
  };
}

/**
 * The umbrella must start with an empty commit on top of its base, otherwise
 * the umbrella PR would carry commits that were never reviewed in a child PR
 */
async function checkUnreviewedCreationCommit(
  git: Git,
  base: string,
  head: string,
): Promise<boolean> {
  const remote = git.remote;

  await git.tryFetch(
    `+refs/heads/${base}:refs/remotes/${remote}/${base}`,
    `+refs/heads/${head}:refs/remotes/${remote}/${head}`,
  );

  const commits = await git.run([
    'log',
    '--no-merges',
    '--first-parent',
    '--format=%H',
    `${remote}/${base}..${remote}/${head}`,
  ]);

  if (commits.code !== 0) return false;

  const creationCommit = splitLines(commits.stdout).at(-1);

  if (!creationCommit) return false;

  const parent = await git.run([
    'rev-parse',
    '--verify',
    '--quiet',
    `${creationCommit}~`,
  ]);

  if (parent.code !== 0 || !parent.stdout.trim()) return false;

  const diff = await git.run([
    'diff',
    '--quiet',
    parent.stdout.trim(),
    creationCommit,
  ]);

  return diff.code === 1;
}
