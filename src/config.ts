import { err, ok, type Result } from './result';

export type UmbrellaConfig = {
  /**
   * Branch type -> base branch, e.g. `{ feature: 'beta', hotfix: 'master' }`.
   * Umbrella branches are `<type>/umbrella/<name>`
   */
  types: Record<string, string>;
  /** Type used when none is given, defaults to the first key of `types` */
  defaultType?: string;
  /** Defaults to `origin` */
  remote?: string;
  /** `owner/name`, defaults to `GITHUB_REPOSITORY`, then `gh repo view` */
  repo?: string;
  autoApprove?: {
    /** Child PRs authored by these users are approved */
    users?: string[];
    /** Sync child PRs are approved, defaults to `true` */
    syncBranches?: boolean;
  };
  diff?: {
    /** Paths excluded from diffs, e.g. `pnpm-lock.yaml` */
    exclude?: string[];
  };
  /** Appended to verification error messages */
  docsLink?: string;
  syncDiff?: {
    /** Above it the comment shows a repro command instead, defaults to 60000 */
    maxCommentChars?: number;
    /** Hidden marker used to find and replace the comment */
    commentMarker?: string;
  };
};

export type ResolvedConfig = {
  types: Record<string, string>;
  defaultType: string;
  remote: string;
  repo: string | undefined;
  autoApprove: { users: string[]; syncBranches: boolean };
  diff: { exclude: string[] };
  docsLink: string | undefined;
  syncDiff: { maxCommentChars: number; commentMarker: string };
};

export type ConfigError = { code: 'invalid-config'; message: string };

const typeRegex = /^[a-z0-9][a-z0-9-]*$/;
const reservedTypes = new Set(['stack', 'uchild', 'stacked', 'umbrella']);

export function resolveConfig(
  config: UmbrellaConfig,
): Result<ResolvedConfig, ConfigError> {
  const typeNames = Object.keys(config.types);

  if (typeNames.length === 0) {
    return configError('`types` must have at least one branch type');
  }

  for (const [type, base] of Object.entries(config.types)) {
    if (!typeRegex.test(type)) {
      return configError(
        `Invalid branch type "${type}", use lowercase letters, numbers and dashes`,
      );
    }

    if (reservedTypes.has(type)) {
      return configError(`Branch type "${type}" is reserved`);
    }

    if (!base.trim()) {
      return configError(`Branch type "${type}" has an empty base branch`);
    }
  }

  const defaultType = config.defaultType ?? typeNames[0];

  if (defaultType === undefined || !(defaultType in config.types)) {
    return configError(
      `\`defaultType\` "${String(config.defaultType)}" is not one of the types: ${typeNames.join(', ')}`,
    );
  }

  return ok({
    types: config.types,
    defaultType,
    remote: config.remote ?? 'origin',
    repo: config.repo,
    autoApprove: {
      users: config.autoApprove?.users ?? [],
      syncBranches: config.autoApprove?.syncBranches ?? true,
    },
    diff: { exclude: config.diff?.exclude ?? [] },
    docsLink: config.docsLink,
    syncDiff: {
      maxCommentChars: config.syncDiff?.maxCommentChars ?? 60_000,
      commentMarker: config.syncDiff?.commentMarker ?? 'UMBRELLA_SYNC_DIFF',
    },
  });
}

function configError(message: string) {
  return err<ConfigError>({ code: 'invalid-config', message });
}

/** Validates an unknown value, e.g. a parsed JSON config file */
export function parseConfig(value: unknown): Result<UmbrellaConfig, ConfigError> {
  if (!isRecord(value)) return configError('Config must be an object');

  const { types } = value;

  if (!isRecord(types)) {
    return configError('`types` must be an object of type -> base branch');
  }

  const parsedTypes: Record<string, string> = {};

  for (const [type, base] of Object.entries(types)) {
    if (typeof base !== 'string') {
      return configError(`Base branch of type "${type}" must be a string`);
    }

    parsedTypes[type] = base;
  }

  const config: UmbrellaConfig = { types: parsedTypes };

  const defaultType = getOptional(value, 'defaultType', isString);
  const remote = getOptional(value, 'remote', isString);
  const repo = getOptional(value, 'repo', isString);
  const docsLink = getOptional(value, 'docsLink', isString);

  for (const [key, field] of Object.entries({
    defaultType,
    remote,
    repo,
    docsLink,
  })) {
    if (!field.ok) return configError(`\`${key}\` must be a string`);
  }

  config.defaultType = defaultType.value;
  config.remote = remote.value;
  config.repo = repo.value;
  config.docsLink = docsLink.value;

  if (value.autoApprove !== undefined) {
    const { autoApprove } = value;

    if (!isRecord(autoApprove)) {
      return configError('`autoApprove` must be an object');
    }

    const users = getOptional(autoApprove, 'users', isStringArray);
    const syncBranches = getOptional(autoApprove, 'syncBranches', isBoolean);

    if (!users.ok) {
      return configError('`autoApprove.users` must be an array of strings');
    }

    if (!syncBranches.ok) {
      return configError('`autoApprove.syncBranches` must be a boolean');
    }

    config.autoApprove = {
      users: users.value,
      syncBranches: syncBranches.value,
    };
  }

  if (value.diff !== undefined) {
    const { diff } = value;

    if (!isRecord(diff)) return configError('`diff` must be an object');

    const exclude = getOptional(diff, 'exclude', isStringArray);

    if (!exclude.ok) {
      return configError('`diff.exclude` must be an array of strings');
    }

    config.diff = { exclude: exclude.value };
  }

  if (value.syncDiff !== undefined) {
    const { syncDiff } = value;

    if (!isRecord(syncDiff)) return configError('`syncDiff` must be an object');

    const maxCommentChars = getOptional(syncDiff, 'maxCommentChars', isNumber);
    const commentMarker = getOptional(syncDiff, 'commentMarker', isString);

    if (!maxCommentChars.ok) {
      return configError('`syncDiff.maxCommentChars` must be a number');
    }

    if (!commentMarker.ok) {
      return configError('`syncDiff.commentMarker` must be a string');
    }

    config.syncDiff = {
      maxCommentChars: maxCommentChars.value,
      commentMarker: commentMarker.value,
    };
  }

  const resolved = resolveConfig(config);

  return resolved.ok ? ok(config) : resolved;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function getOptional<T>(
  obj: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
): Result<T | undefined, null> {
  const value = obj[key];

  if (value === undefined) return ok(undefined);

  return guard(value) ? ok(value) : err(null);
}
