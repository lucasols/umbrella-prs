import { err, ok, type Result } from './result';
import {
  isBoolean,
  isNumber,
  isRecord,
  isString,
  isStringArray,
} from './utils.typeGuards';

export type BranchNames = {
  /** Middle segment of umbrella branches: `<type>/<umbrella>/<name>` */
  umbrella: string;
  /** Prefix of child branches: `<child>/<umbrella-name>/<name>` */
  child: string;
};

export type UmbrellaConfig = {
  /**
   * Branch type -> base branch, e.g. `{ feature: 'beta', hotfix: 'master' }`.
   * Umbrella branches are `<type>/umbrella/<name>`
   */
  types: Record<string, string>;
  /**
   * Identifiers of the branches the lib creates and parses, defaults to
   * `{ umbrella: 'umbrella', child: 'under' }`
   */
  branchNames?: Partial<BranchNames>;
  /** Other identifiers that are parsed but never created, e.g. an old naming */
  aliases?: BranchNames[];
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
  branchNames: BranchNames;
  aliases: BranchNames[];
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
const branchNameRegex = /^[a-z0-9][\w.-]*$/i;

export const defaultBranchNames: BranchNames = {
  umbrella: 'umbrella',
  child: 'under',
};

export function resolveConfig(
  config: UmbrellaConfig,
): Result<ResolvedConfig, ConfigError> {
  const typeNames = Object.keys(config.types);

  if (typeNames.length === 0) {
    return configError('`types` must have at least one branch type');
  }

  const branchNames: BranchNames = {
    umbrella: config.branchNames?.umbrella ?? defaultBranchNames.umbrella,
    child: config.branchNames?.child ?? defaultBranchNames.child,
  };
  const aliases = config.aliases ?? [];
  const identifiers = new Map<string, string>();

  for (const [index, names] of [branchNames, ...aliases].entries()) {
    const key = index === 0 ? 'branchNames' : `aliases[${index - 1}]`;

    for (const [field, value] of Object.entries(names)) {
      if (!branchNameRegex.test(value)) {
        return configError(
          `Invalid \`${key}.${field}\` "${value}", use a single branch segment without "/"`,
        );
      }

      identifiers.set(value, `\`${key}.${field}\``);
    }
  }

  for (const [type, base] of Object.entries(config.types)) {
    if (!typeRegex.test(type)) {
      return configError(
        `Invalid branch type "${type}", use lowercase letters, numbers and dashes`,
      );
    }

    const collision = identifiers.get(type);

    if (collision !== undefined) {
      return configError(
        `Branch type "${type}" collides with ${collision}, rename one of them`,
      );
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
    branchNames,
    aliases,
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
export function parseConfig(
  value: unknown,
): Result<UmbrellaConfig, ConfigError> {
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

  if (value.branchNames !== undefined) {
    const { branchNames } = value;

    if (!isRecord(branchNames)) {
      return configError('`branchNames` must be an object');
    }

    const umbrella = getOptional(branchNames, 'umbrella', isString);
    const child = getOptional(branchNames, 'child', isString);

    if (!umbrella.ok || !child.ok) {
      return configError(
        '`branchNames.umbrella` and `branchNames.child` must be strings',
      );
    }

    config.branchNames = { umbrella: umbrella.value, child: child.value };
  }

  if (value.aliases !== undefined) {
    const { aliases } = value;

    if (!Array.isArray(aliases)) {
      return configError('`aliases` must be an array');
    }

    const parsedAliases: BranchNames[] = [];

    for (const alias of aliases) {
      if (
        !isRecord(alias) ||
        !isString(alias.umbrella) ||
        !isString(alias.child)
      ) {
        return configError(
          'Each of `aliases` must be `{ "umbrella": string, "child": string }`',
        );
      }

      parsedAliases.push({ umbrella: alias.umbrella, child: alias.child });
    }

    config.aliases = parsedAliases;
  }

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

function getOptional<T>(
  obj: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
): Result<T | undefined, null> {
  const value = obj[key];

  if (value === undefined) return ok(undefined);

  return guard(value) ? ok(value) : err(null);
}
