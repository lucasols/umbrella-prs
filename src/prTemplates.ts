import type { PrInfo } from './github';
import {
  formatChildBranch,
  inferTitleFromName,
  parseBranch,
  type NamingConfig,
  type ParsedChild,
} from './naming';
import { err, ok, type Result } from './result';

const parentPrHeadingRegex = /^#+\s*Parent PR/i;

export const CHILDREN_PRS_HEADING = '## Children PRs';

export type PrTemplate = { title: string; body: string };

export function umbrellaPrTemplate({
  name,
  title = inferTitleFromName(name),
}: {
  name: string;
  title?: string;
}): PrTemplate {
  return {
    title,
    body: [
      '## PR motivations',
      '',
      title,
      '',
      CHILDREN_PRS_HEADING,
      '',
      '<!-- The PRs references will be automatically added here -->',
      '',
      '## Check list',
      '',
      '- [ ] Feature is tested',
      '  <!-- Add the general feature tests here if needed -->',
    ].join('\n'),
  };
}

export function childPrTemplate({
  parentPr,
  title,
  description,
  checklist,
}: {
  parentPr: Pick<PrInfo, 'number' | 'title'>;
  title?: string;
  description?: string;
  checklist?: string;
}): PrTemplate {
  return {
    title: `${parentPr.title} - ${title ?? '???'}`,
    body: [
      '## Parent PR',
      '',
      `- #${parentPr.number}`,
      '',
      '## PR motivations',
      '',
      description ?? '',
      ...(checklist ? ['', checklist] : []),
    ].join('\n'),
  };
}

export function syncPrTemplate({
  parentPr,
}: {
  parentPr: Pick<PrInfo, 'number' | 'title'>;
}): PrTemplate {
  return {
    title: `${parentPr.title} - Sync with base`,
    body: [
      '## Parent PR',
      '',
      `- #${parentPr.number}`,
      '',
      '## PR motivations',
      '',
      'Sync umbrella PR with base branch',
    ].join('\n'),
  };
}

/**
 * Adds `- #N` at the end of the `Children PRs` section, or appends the section
 * when it's missing
 */
export function addChildToUmbrellaBody(
  body: string,
  prNumber: number,
): { body: string; changed: boolean } {
  if (new RegExp(`#${prNumber}(?!\\d)`).test(body)) {
    return { body, changed: false };
  }

  const lines = body.split('\n');
  const headingIndex = lines.findIndex((line) => line.includes('Children PRs'));

  if (headingIndex === -1) {
    const separator = body.trim() ? '\n\n' : '';

    return {
      body: `${body.trimEnd()}${separator}${CHILDREN_PRS_HEADING}\n\n- #${prNumber}\n`,
      changed: true,
    };
  }

  let insertAfter = headingIndex;

  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.trimStart().startsWith('#')) break;

    if (line.trim().length > 0) insertAfter = i;
  }

  lines.splice(insertAfter + 1, 0, `- #${prNumber}`);

  return { body: lines.join('\n'), changed: true };
}

/** Whether the description links the PR, as `#N` or its URL */
export function bodyLinksPr(body: string, prNumber: number): boolean {
  return new RegExp(`(?:#|/pull/)${prNumber}(?!\\d)`).test(body);
}

/**
 * Adds `- #N` under the `Parent PR` heading, or prepends the section when it's
 * missing. Unchanged when the description already links the parent
 */
export function addParentLinkToChildBody(
  body: string,
  parentPrNumber: number,
): { body: string; changed: boolean } {
  if (bodyLinksPr(body, parentPrNumber)) return { body, changed: false };

  const lines = body.split('\n');
  const headingIndex = lines.findIndex((line) =>
    parentPrHeadingRegex.test(line.trim()),
  );

  if (headingIndex === -1) {
    const section = `## Parent PR\n\n- #${parentPrNumber}`;

    return {
      body: body.trim() ? `${section}\n\n${body}` : `${section}\n`,
      changed: true,
    };
  }

  lines.splice(headingIndex + 1, 0, '', `- #${parentPrNumber}`);

  return { body: lines.join('\n'), changed: true };
}

export type FindParentPrError = {
  code: 'parent-pr-not-found';
  message: string;
  /** Closest child branch name, for a "did you mean" message */
  suggestion: string | null;
  fix: string;
};

/**
 * Finds the open PR of the child's umbrella, preferring the configured
 * `branchNames` over aliases
 */
export function findParentPr<T extends PrInfo>(
  child: ParsedChild,
  openPrs: readonly T[],
  config: NamingConfig,
): Result<T, FindParentPrError> {
  const umbrellaPrs: { pr: T; name: string; alias: boolean }[] = [];

  for (const pr of openPrs) {
    const parsed = parseBranch(pr.headRefName, config);

    if (parsed?.kind === 'umbrella') {
      umbrellaPrs.push({
        pr,
        name: parsed.name,
        alias: parsed.alias,
      });
    }
  }

  const matches = umbrellaPrs
    .filter((item) => item.name === child.umbrella)
    .sort((a, b) => Number(a.alias) - Number(b.alias));

  const match = matches[0];

  if (match) return ok(match.pr);

  const closest = getClosestString(
    child.umbrella,
    umbrellaPrs.map((item) => item.name),
  );

  const suggestion =
    closest ?
      formatChildBranch({ umbrella: closest, name: child.name }, config)
    : null;

  return err({
    code: 'parent-pr-not-found',
    message: `No open umbrella PR found for "${child.umbrella}" (branch ${child.fullName})${suggestion ? `. Did you mean ${suggestion}?` : ''}`,
    suggestion,
    fix:
      suggestion ?
        `Rename the branch to ${suggestion}, or open the umbrella PR of "${child.umbrella}"`
      : `Open the umbrella PR of "${child.umbrella}" first`,
  });
}

function getClosestString(target: string, options: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;

  for (const option of options) {
    const distance = levenshtein(target, option);

    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }

  if (best === null) return null;

  // too different to be a typo
  if (bestDistance > Math.max(3, Math.floor(target.length / 2))) return null;

  return best;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      current.push(
        Math.min(
          (prev[j] ?? 0) + 1,
          (current[j - 1] ?? 0) + 1,
          (prev[j - 1] ?? 0) + cost,
        ),
      );
    }

    prev = current;
  }

  return prev[b.length] ?? 0;
}
