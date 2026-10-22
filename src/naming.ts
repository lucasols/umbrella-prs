import type { ResolvedConfig } from './config';
import { err, ok, type Result } from './result';

const digitsRegex = /^\d+$/;

export type NamingConfig = Pick<
  ResolvedConfig,
  'types' | 'branchNames' | 'aliases'
>;

export type ParsedUmbrella = {
  kind: 'umbrella';
  /** `true` when the branch uses one of the config `aliases` */
  alias: boolean;
  type: string;
  base: string;
  name: string;
  fullName: string;
};

export type SyncInfo =
  { index: number; label: null } | { index: null; label: string };

export type ParsedChild = {
  kind: 'child';
  /** `true` when the branch uses one of the config `aliases` */
  alias: boolean;
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
  config: NamingConfig,
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
  config: NamingConfig,
): Result<ParsedBranch, NamingError> {
  const segments = branch.split('/');
  const [first, second, third] = segments;
  const allNames = [config.branchNames, ...config.aliases];

  const childIndex = allNames.findIndex((names) => names.child === first);

  if (childIndex !== -1) {
    if (segments.length !== 3 || !second || !third) {
      return err({
        code: 'invalid-segments',
        message: `Child branch "${branch}" must be "${first}/<umbrella>/<child>"`,
      });
    }

    return ok({
      kind: 'child',
      alias: childIndex > 0,
      umbrella: second,
      name: third,
      sync: parseSyncName(third),
      fullName: branch,
    });
  }

  const umbrellaIndex = allNames.findIndex(
    (names) => names.umbrella === second,
  );

  if (umbrellaIndex === -1) {
    return err({
      code: 'not-umbrella-workflow',
      message: `Branch "${branch}" is not an umbrella or umbrella child branch`,
    });
  }

  if (segments.length !== 3 || !first || !third) {
    return err({
      code: 'invalid-segments',
      message: `Umbrella branch "${branch}" must be "<type>/${second}/<name>"`,
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
    alias: umbrellaIndex > 0,
    type: first,
    base,
    name: third,
    fullName: branch,
  });
}

function getOwn(record: Record<string, string>, key: string) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

type BranchNamesConfig = Pick<ResolvedConfig, 'branchNames'>;

export function formatUmbrellaBranch(
  { type, name }: { type: string; name: string },
  config: BranchNamesConfig,
): string {
  return `${type}/${config.branchNames.umbrella}/${name}`;
}

export function formatChildBranch(
  { umbrella, name }: { umbrella: string; name: string },
  config: BranchNamesConfig,
): string {
  return `${config.branchNames.child}/${umbrella}/${name}`;
}

export function formatSyncName(index: number): string {
  return index <= 1 ? 'sync' : `sync-${index}`;
}

export function formatSyncBranch(
  { umbrella, index }: { umbrella: string; index: number },
  config: BranchNamesConfig,
): string {
  return formatChildBranch({ umbrella, name: formatSyncName(index) }, config);
}

/** Lowercases and replaces anything other than `a-z`, `0-9` and `-` with `-` */
export function normalizeBranchSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}

type BranchList = readonly (string | ParsedBranch)[];

function parseAll(branches: BranchList, config: NamingConfig): ParsedBranch[] {
  const parsed: ParsedBranch[] = [];

  for (const branch of branches) {
    const parsedBranch =
      typeof branch === 'string' ? parseBranch(branch, config) : branch;

    if (parsedBranch) parsed.push(parsedBranch);
  }

  return parsed;
}

/** Children of the umbrella, including the ones using aliases */
export function getChildrenOf(
  umbrella: string,
  branches: BranchList,
  config: NamingConfig,
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
 * Finds the umbrella branch by name, including aliases. When both exist the
 * configured `branchNames` win
 */
export function findUmbrellaBranch(
  umbrella: string,
  branches: BranchList,
  config: NamingConfig,
): ParsedUmbrella | null {
  let found: ParsedUmbrella | null = null;

  for (const branch of parseAll(branches, config)) {
    if (branch.kind !== 'umbrella' || branch.name !== umbrella) continue;

    if (!found || (found.alias && !branch.alias)) {
      found = branch;
    }
  }

  return found;
}

/**
 * Next sync branch, using the highest sync index, including aliases. Labeled
 * syncs (`sync-<label>`) are ignored
 */
export function getNextSyncBranchName({
  umbrella,
  existingBranches,
  config,
}: {
  umbrella: string;
  existingBranches: BranchList;
  config: NamingConfig;
}): string {
  let maxIndex = 0;

  for (const child of getChildrenOf(umbrella, existingBranches, config)) {
    const index = child.sync?.index;

    if (index != null && index > maxIndex) maxIndex = index;
  }

  return formatSyncBranch({ umbrella, index: maxIndex + 1 }, config);
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
  config: NamingConfig;
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
  config: NamingConfig;
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
