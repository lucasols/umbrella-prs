import type { ResolvedConfig } from './config';
import { err, ok, type Result } from './result';

const digitsRegex = /^\d+$/;

/**
 * - `umbrella`: `<type>/umbrella/<name>` and `under/<name>/<child>`
 * - `legacy`: `<type>/stacked/<name>` and `stack/<name>/<child>`
 */
export type BranchFormat = 'umbrella' | 'legacy';

export type ParsedUmbrella = {
  kind: 'umbrella';
  format: BranchFormat;
  type: string;
  base: string;
  name: string;
  fullName: string;
};

export type SyncInfo =
  { index: number; label: null } | { index: null; label: string };

export type ParsedChild = {
  kind: 'child';
  format: BranchFormat;
  /** Name of the umbrella, not its full branch name */
  umbrella: string;
  name: string;
  /**
   * Set for sync children: `sync` is index 1, `sync-N` is index N, and
   * `sync-<label>` (a sync of another branch) has a `label` and no index
   */
  sync: SyncInfo | null;
  fullName: string;
};

const umbrellaMarker: Record<BranchFormat, string> = {
  umbrella: 'umbrella',
  legacy: 'stacked',
};

const childPrefix: Record<BranchFormat, string> = {
  umbrella: 'under',
  legacy: 'stack',
};

const syncRegex = /^sync(?:-(.+))?$/;

export function parseSyncName(name: string): SyncInfo | null {
  const match = syncRegex.exec(name);

  if (!match) return null;

  const suffix = match[1];

  if (suffix === undefined) return { index: 1, label: null };

  if (digitsRegex.test(suffix)) return { index: Number(suffix), label: null };

  return { index: null, label: suffix };
}

export type ParsedBranch = ParsedUmbrella | ParsedChild;

/** Returns `null` when the branch is not part of the umbrella workflow */
export function parseBranch(
  branch: string,
  config: Pick<ResolvedConfig, 'types'>,
): ParsedBranch | null {
  const result = parseBranchStrict(branch, config);

  return result.ok ? result.value : null;
}

export type NamingError = {
  code:
    | 'not-umbrella-workflow'
    | 'invalid-segments'
    | 'unknown-type'
    | 'empty-name'
    | 'reserved-name'
    | 'already-exists';
  message: string;
  fix?: string;
};

export function parseBranchStrict(
  branch: string,
  config: Pick<ResolvedConfig, 'types'>,
): Result<ParsedBranch, NamingError> {
  const segments = branch.split('/');
  const [first, second, third] = segments;

  const childFormat = getFormatByChildPrefix(first);

  if (childFormat) {
    if (segments.length !== 3 || !second || !third) {
      return err({
        code: 'invalid-segments',
        message: `Child branch "${branch}" must be "${childPrefix[childFormat]}/<umbrella>/<child>"`,
      });
    }

    return ok({
      kind: 'child',
      format: childFormat,
      umbrella: second,
      name: third,
      sync: parseSyncName(third),
      fullName: branch,
    });
  }

  const umbrellaFormat = getFormatByUmbrellaMarker(second);

  if (!umbrellaFormat) {
    return err({
      code: 'not-umbrella-workflow',
      message: `Branch "${branch}" is not an umbrella or umbrella child branch`,
    });
  }

  if (segments.length !== 3 || !first || !third) {
    return err({
      code: 'invalid-segments',
      message: `Umbrella branch "${branch}" must be "<type>/${umbrellaMarker[umbrellaFormat]}/<name>"`,
    });
  }

  const base = getOwn(config.types, first);

  if (base === undefined) {
    return err({
      code: 'unknown-type',
      message: `Umbrella branch "${branch}" has an unknown type "${first}", expected one of: ${Object.keys(config.types).join(', ')}`,
    });
  }

  return ok({
    kind: 'umbrella',
    format: umbrellaFormat,
    type: first,
    base,
    name: third,
    fullName: branch,
  });
}

function getFormatByChildPrefix(
  segment: string | undefined,
): BranchFormat | null {
  if (segment === childPrefix.umbrella) return 'umbrella';
  if (segment === childPrefix.legacy) return 'legacy';
  return null;
}

function getFormatByUmbrellaMarker(
  segment: string | undefined,
): BranchFormat | null {
  if (segment === umbrellaMarker.umbrella) return 'umbrella';
  if (segment === umbrellaMarker.legacy) return 'legacy';
  return null;
}

function getOwn(record: Record<string, string>, key: string) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function formatUmbrellaBranch({
  type,
  name,
  format = 'umbrella',
}: {
  type: string;
  name: string;
  format?: BranchFormat;
}): string {
  return `${type}/${umbrellaMarker[format]}/${name}`;
}

export function formatChildBranch({
  umbrella,
  name,
  format = 'umbrella',
}: {
  umbrella: string;
  name: string;
  format?: BranchFormat;
}): string {
  return `${childPrefix[format]}/${umbrella}/${name}`;
}

export function formatSyncName(index: number): string {
  return index <= 1 ? 'sync' : `sync-${index}`;
}

export function formatSyncBranch({
  umbrella,
  index,
  format = 'umbrella',
}: {
  umbrella: string;
  index: number;
  format?: BranchFormat;
}): string {
  return formatChildBranch({ umbrella, name: formatSyncName(index), format });
}

/** Lowercases and replaces anything other than `a-z`, `0-9` and `-` with `-` */
export function normalizeBranchSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}

type BranchList = readonly (string | ParsedBranch)[];

function parseAll(
  branches: BranchList,
  config: Pick<ResolvedConfig, 'types'>,
): ParsedBranch[] {
  const parsed: ParsedBranch[] = [];

  for (const branch of branches) {
    const parsedBranch =
      typeof branch === 'string' ? parseBranch(branch, config) : branch;

    if (parsedBranch) parsed.push(parsedBranch);
  }

  return parsed;
}

/** Children of the umbrella in any format */
export function getChildrenOf(
  umbrella: string,
  branches: BranchList,
  config: Pick<ResolvedConfig, 'types'>,
): ParsedChild[] {
  const children = new Map<string, ParsedChild>();

  for (const branch of parseAll(branches, config)) {
    if (branch.kind === 'child' && branch.umbrella === umbrella) {
      children.set(branch.fullName, branch);
    }
  }

  return [...children.values()];
}

/**
 * Finds the umbrella branch by name in any format. When both formats exist the
 * new format wins
 */
export function findUmbrellaBranch(
  umbrella: string,
  branches: BranchList,
  config: Pick<ResolvedConfig, 'types'>,
): ParsedUmbrella | null {
  let found: ParsedUmbrella | null = null;

  for (const branch of parseAll(branches, config)) {
    if (branch.kind !== 'umbrella' || branch.name !== umbrella) continue;

    if (!found || (found.format === 'legacy' && branch.format === 'umbrella')) {
      found = branch;
    }
  }

  return found;
}

/**
 * Next sync branch, using the highest sync index of both formats. Labeled syncs
 * (`sync-<label>`) are ignored
 */
export function getNextSyncBranchName({
  umbrella,
  existingBranches,
  format = 'umbrella',
  config,
}: {
  umbrella: string;
  existingBranches: BranchList;
  format?: BranchFormat;
  config: Pick<ResolvedConfig, 'types'>;
}): string {
  let maxIndex = 0;

  for (const child of getChildrenOf(umbrella, existingBranches, config)) {
    const index = child.sync?.index;

    if (index != null && index > maxIndex) maxIndex = index;
  }

  return formatSyncBranch({ umbrella, index: maxIndex + 1, format });
}

/** Returns the normalized child name */
export function validateChildName({
  umbrella,
  name,
  existingBranches,
  config,
}: {
  umbrella: string;
  name: string;
  existingBranches: BranchList;
  config: Pick<ResolvedConfig, 'types'>;
}): Result<string, NamingError> {
  const normalized = normalizeBranchSegment(name);

  if (!normalized.replaceAll('-', '')) {
    return err({ code: 'empty-name', message: 'Branch name cannot be empty' });
  }

  if (parseSyncName(normalized)?.index != null) {
    return err({
      code: 'reserved-name',
      message: `"${normalized}" is reserved for base sync children`,
      fix: 'Use `umbrella-prs create sync` to create a base sync child, or pick another name',
    });
  }

  const existing = getChildrenOf(umbrella, existingBranches, config).find(
    (child) => child.name === normalized,
  );

  if (existing) {
    return err({
      code: 'already-exists',
      message: `Branch "${existing.fullName}" already exists`,
      fix: 'Pick another name',
    });
  }

  return ok(normalized);
}

/** Returns the normalized umbrella name */
export function validateUmbrellaName({
  name,
  existingBranches,
  config,
}: {
  name: string;
  existingBranches: BranchList;
  config: Pick<ResolvedConfig, 'types'>;
}): Result<string, NamingError> {
  const normalized = normalizeBranchSegment(name);

  if (!normalized.replaceAll('-', '')) {
    return err({ code: 'empty-name', message: 'Branch name cannot be empty' });
  }

  const existing = findUmbrellaBranch(normalized, existingBranches, config);

  if (existing) {
    return err({
      code: 'already-exists',
      message: `Umbrella "${normalized}" already exists: ${existing.fullName}`,
      fix: 'Pick another name',
    });
  }

  return ok(normalized);
}

export function isChildOf(child: ParsedChild, umbrella: ParsedUmbrella) {
  return child.umbrella === umbrella.name;
}

export function inferTitleFromName(name: string): string {
  const words = name.replaceAll('-', ' ').replaceAll('_', ' ').trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}
