import type { PrInfo } from './github';

export type DependencyChainResult<T> =
  | {
      ok: true;
      /** Open PRs from `branch` until the one targeting the base */
      chain: T[];
    }
  | {
      ok: false;
      reason: 'no-open-pr' | 'cycle' | 'too-deep';
      /** Branch where the chain broke */
      branch: string;
    };

/**
 * Follows the open PRs from `branch` (head -> base) until one targets
 * `targetBase`. A dependent umbrella is valid when its PR base has such a chain
 */
export function getDependencyChain<T extends PrInfo>(
  branch: string,
  targetBase: string,
  openPrs: readonly T[],
  maxDepth = 10,
): DependencyChainResult<T> {
  const chain: T[] = [];
  const visited = new Set<string>();
  let current = branch;

  for (;;) {
    if (visited.has(current))
      return { ok: false, reason: 'cycle', branch: current };

    if (chain.length >= maxDepth) {
      return { ok: false, reason: 'too-deep', branch: current };
    }

    visited.add(current);

    const pr = openPrs.find((item) => item.headRefName === current);

    if (!pr?.baseRefName) {
      return { ok: false, reason: 'no-open-pr', branch: current };
    }

    chain.push(pr);

    if (pr.baseRefName === targetBase) return { ok: true, chain };

    current = pr.baseRefName;
  }
}

export type CurrentBase<T> = {
  /** Branch the umbrella currently lands into */
  base: string;
  /** Configured base of the umbrella type */
  rootBase: string;
  /** Set when the umbrella PR targets another open branch that lands first */
  dependsOn: { branch: string; pr: number } | null;
  /** PR base that was merged or deleted, the PR must be retargeted to `rootBase` */
  staleBase: string | null;
  /** PR base that is neither `rootBase` nor a valid dependency */
  invalidBase: string | null;
  /** Open PR of the umbrella */
  pr: T | null;
};

/**
 * The umbrella's open PR base when it's a valid dependency (an open branch whose
 * PR chain ends at `rootBase`), otherwise `rootBase`
 */
export async function resolveCurrentBase<T extends PrInfo>({
  umbrellaBranch,
  rootBase,
  openPrs,
  isBranchGone,
}: {
  umbrellaBranch: string;
  rootBase: string;
  openPrs: readonly T[];
  /** Whether the branch was merged or deleted */
  isBranchGone: (branch: string) => Promise<boolean>;
}): Promise<CurrentBase<T>> {
  const pr =
    openPrs.find((item) => item.headRefName === umbrellaBranch) ?? null;
  const result: CurrentBase<T> = {
    base: rootBase,
    rootBase,
    dependsOn: null,
    staleBase: null,
    invalidBase: null,
    pr,
  };

  const prBase = pr?.baseRefName;

  if (!prBase || prBase === rootBase) return result;

  const chain = getDependencyChain(prBase, rootBase, openPrs);
  const dependency = chain.ok ? chain.chain[0] : undefined;

  if (dependency) {
    return {
      ...result,
      base: prBase,
      dependsOn: { branch: prBase, pr: dependency.number },
    };
  }

  if (await isBranchGone(prBase)) return { ...result, staleBase: prBase };

  return { ...result, invalidBase: prBase };
}
