import type { ResolvedConfig } from './config';
import type { PrInfo } from './github';
import { parseBranch, type ParsedChild, type ParsedUmbrella } from './naming';

export type UmbrellaTreeNode<T> = {
  branch: ParsedUmbrella;
  pr: T;
  /**
   * Set when the umbrella PR targets another branch than its configured base,
   * which must land first. `pr` is the open PR of that branch
   */
  dependsOn: { branch: string; pr: number | null } | null;
  children: { branch: ParsedChild; pr: T }[];
};

export type UmbrellaTree<T> = {
  umbrellas: UmbrellaTreeNode<T>[];
  /** Child PRs whose umbrella has no open PR */
  orphans: { branch: ParsedChild; pr: T }[];
  /** PRs outside the umbrella workflow, in the original order */
  others: T[];
};

/** Groups PRs into umbrella -> children trees, keeping the PR order */
export function buildTree<T extends PrInfo>(
  prs: readonly T[],
  config: Pick<ResolvedConfig, 'types'>,
): UmbrellaTree<T> {
  const umbrellas: UmbrellaTreeNode<T>[] = [];
  const umbrellasByName = new Map<string, UmbrellaTreeNode<T>>();
  const children: { branch: ParsedChild; pr: T }[] = [];
  const others: T[] = [];

  for (const pr of prs) {
    const branch = parseBranch(pr.headRefName, config);

    if (!branch) {
      others.push(pr);
    } else if (branch.kind === 'umbrella') {
      const node: UmbrellaTreeNode<T> = {
        branch,
        pr,
        dependsOn:
          pr.baseRefName !== undefined && pr.baseRefName !== branch.base ?
            {
              branch: pr.baseRefName,
              pr:
                prs.find((item) => item.headRefName === pr.baseRefName)
                  ?.number ?? null,
            }
          : null,
        children: [],
      };

      umbrellas.push(node);

      const existing = umbrellasByName.get(branch.name);

      // the new format wins when both exist
      if (!existing || existing.branch.format === 'legacy') {
        umbrellasByName.set(branch.name, node);
      }
    } else {
      children.push({ branch, pr });
    }
  }

  const orphans: { branch: ParsedChild; pr: T }[] = [];

  for (const child of children) {
    const umbrella = umbrellasByName.get(child.branch.umbrella);

    if (umbrella) umbrella.children.push(child);
    else orphans.push(child);
  }

  return { umbrellas, orphans, others };
}
