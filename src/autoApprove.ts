import type { ResolvedConfig } from './config';
import { parseBranch, type NamingConfig } from './naming';

export type AutoApproveInput = {
  head: string;
  base: string;
  author: string;
  draft?: boolean;
};

export type AutoApproveEligibility = {
  eligible: boolean;
  reason: string;
};

/**
 * Child PRs into their umbrella are approved when they are a base sync
 * (`sync`, `sync-N`) and `autoApprove.syncBranches` is on, or when the author
 * is in `autoApprove.users`. Labeled syncs (`sync-<label>`) follow the author
 * rule only
 */
export function getAutoApproveEligibility(
  { head, base, author, draft }: AutoApproveInput,
  config: NamingConfig & Pick<ResolvedConfig, 'autoApprove'>,
): AutoApproveEligibility {
  if (draft) return { eligible: false, reason: 'PR is a draft' };

  const child = parseBranch(head, config);

  if (child?.kind !== 'child') {
    return { eligible: false, reason: `"${head}" is not an umbrella child` };
  }

  const umbrella = parseBranch(base, config);

  if (umbrella?.kind !== 'umbrella' || umbrella.name !== child.umbrella) {
    return {
      eligible: false,
      reason: `"${head}" does not target its umbrella "${child.umbrella}"`,
    };
  }

  if (config.autoApprove.syncBranches && child.sync?.index != null) {
    return { eligible: true, reason: 'Base sync child PR' };
  }

  if (config.autoApprove.users.includes(author)) {
    return { eligible: true, reason: `Child PR authored by ${author}` };
  }

  return {
    eligible: false,
    reason: `Author "${author}" is not in autoApprove.users${child.sync ? ' and labeled syncs are not auto-approved' : ''}`,
  };
}
