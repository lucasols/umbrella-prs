import { readFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { isRecord } from '../utils.typeGuards';
import { defaultExec, type Exec } from '../exec';
import { parseBranchStrict } from '../naming';
import { renderSyncDiffComment } from '../syncDiff';
import { renderSyncDiffHtml } from '../syncDiffHtml';
import type { VerifyResult } from '../verify';
import {
  createUmbrellaPrs,
  type OpError,
  type OpErrorCode,
  type UmbrellaPrs,
} from '../umbrella';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from './loadConfig';
import {
  createReadlinePrompter,
  PromptCancelledError,
  type Prompter,
} from './prompts';

/** `123`, `#123` or a PR URL */
const prTargetRegex =
  /^(?:#?(\d+)|https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?.*)$/;

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  conflicts: 3,
  config: 4,
  precondition: 5,
} as const;

class CliError extends Error {
  readonly code: string;
  readonly fix: string | undefined;
  readonly exitCode: number;

  constructor({
    code,
    message,
    fix,
    exitCode,
  }: {
    code: string;
    message: string;
    fix?: string;
    exitCode: number;
  }) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.fix = fix;
    this.exitCode = exitCode;
  }
}

function usageError(message: string, fix?: string): CliError {
  return new CliError({ code: 'usage', message, fix, exitCode: EXIT.usage });
}

const opErrorExitCodes: Record<OpErrorCode, number> = {
  'not-umbrella-branch': EXIT.precondition,
  'umbrella-not-found': EXIT.precondition,
  'child-exists': EXIT.precondition,
  'umbrella-exists': EXIT.precondition,
  'invalid-name': EXIT.usage,
  'dirty-worktree': EXIT.precondition,
  'detached-head': EXIT.precondition,
  'from-current-not-in-umbrella': EXIT.precondition,
  'unknown-type': EXIT.usage,
  'parent-pr-not-found': EXIT.precondition,
  'invalid-dependency': EXIT.precondition,
  'merge-conflicts': EXIT.conflicts,
  'no-merges-found': EXIT.precondition,
  'git-too-old': EXIT.precondition,
  'git-failed': EXIT.failed,
  'gh-failed': EXIT.failed,
};

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: OpError },
): T {
  if (result.ok) return result.value;

  throw new CliError({
    code: result.error.code,
    message: result.error.message,
    fix: result.error.fix,
    exitCode: opErrorExitCodes[result.error.code],
  });
}

type OptionDef = {
  type: 'string' | 'boolean';
  multiple?: boolean;
  description: string;
};

const globalOptions: Record<string, OptionDef> = {
  json: { type: 'boolean', description: 'Print JSON to stdout' },
  yes: {
    type: 'boolean',
    description: 'Never prompt, confirmations are accepted',
  },
  'non-interactive': { type: 'boolean', description: 'Alias of --yes' },
  config: { type: 'string', description: 'Path of the config file' },
  cwd: { type: 'string', description: 'Run in this directory' },
  help: { type: 'boolean', description: 'Show help' },
};

type CommandContext = {
  positionals: string[];
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  umbrella: () => UmbrellaPrs;
  interactive: boolean;
  yes: boolean;
  prompter: Prompter;
  env: Record<string, string | undefined>;
  cwd: string;
  log: (text: string) => void;
  /** Opens a file in the default app, a no-op when not attached to a terminal */
  openFile: (filePath: string) => Promise<void>;
};

function getString(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.values[name];

  return typeof value === 'string' ? value : undefined;
}

function getBoolean(ctx: CommandContext, name: string): boolean {
  return ctx.values[name] === true;
}

function getStrings(ctx: CommandContext, name: string): string[] {
  const value = ctx.values[name];

  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string');
  }

  return typeof value === 'string' ? [value] : [];
}

function getChoice<T extends string>(
  ctx: CommandContext,
  name: string,
  choices: readonly T[],
): T | undefined {
  const value = getString(ctx, name);

  if (value === undefined) return undefined;

  const choice = choices.find((item) => item === value);

  if (choice === undefined) {
    throw usageError(
      `Invalid --${name} "${value}"`,
      `Use one of: ${choices.join(', ')}`,
    );
  }

  return choice;
}

/** Prompts when interactive, otherwise fails with the flag to pass */
async function requireValue(
  ctx: CommandContext,
  value: string | undefined,
  { flag, prompt }: { flag: string; prompt: () => Promise<string> },
): Promise<string> {
  if (value !== undefined) return value;

  if (!ctx.interactive) throw usageError(`Missing ${flag}`, `Pass ${flag}`);

  return prompt();
}

async function confirmOrFail(
  ctx: CommandContext,
  message: string,
): Promise<void> {
  if (ctx.yes) return;

  if (!ctx.interactive) {
    throw usageError(`${message} Confirmation required`, 'Pass --yes');
  }

  if (!(await ctx.prompter.confirm(message))) {
    throw new CliError({
      code: 'cancelled',
      message: 'Cancelled',
      exitCode: EXIT.failed,
    });
  }
}

async function selectUmbrella(
  ctx: CommandContext,
  { allowNew }: { allowNew: boolean },
): Promise<string> {
  const branches = await ctx.umbrella().listBranches();
  const names = [
    ...new Set(
      branches.flatMap((branch) =>
        branch.kind === 'umbrella' ? [branch.name] : [],
      ),
    ),
  ];

  const newValue = '\u0000new';

  if (names.length === 0 && !allowNew) {
    throw new CliError({
      code: 'umbrella-not-found',
      message: 'No umbrella branches found',
      fix: 'Create one with `umbrella-prs create umbrella <name>`',
      exitCode: EXIT.precondition,
    });
  }

  return ctx.prompter.select('Select the umbrella', [
    ...(allowNew ? [{ value: newValue, label: '+ Create new umbrella' }] : []),
    ...names.map((name) => ({ value: name, label: name })),
  ]);
}

/** Umbrella name from the flag, the current branch, or a prompt */
async function resolveUmbrellaOption(
  ctx: CommandContext,
): Promise<string | undefined> {
  const option = getString(ctx, 'umbrella');

  if (option !== undefined) return option;

  const current = await ctx.umbrella().git.currentBranch();
  const parsed = current ? ctx.umbrella().parseBranch(current) : null;

  if (parsed) return undefined;

  if (!ctx.interactive) {
    throw usageError(
      `The current branch "${current ?? 'HEAD'}" is not part of an umbrella`,
      'Pass --umbrella <name>',
    );
  }

  return selectUmbrella(ctx, { allowNew: false });
}

function formatPr(
  pr: { number: number; url: string; alreadyExisted: boolean } | null,
) {
  if (!pr) return [];

  return [`${pr.alreadyExisted ? 'PR already open' : 'Opened PR'}: ${pr.url}`];
}

function conflictText(branch: string, merged: string, files: string[]) {
  return [
    `Merging "${merged}" into "${branch}" has conflicts, the merge is still in progress.`,
    'Conflicted files:',
    ...files.map((file) => `- ${file}`),
    'Resolve the conflicts, stage the files with `git add` and finish with `git commit --no-edit`.',
  ];
}

async function promptType(ctx: CommandContext): Promise<string | undefined> {
  const type = getString(ctx, 'type');
  const { types, defaultType } = ctx.umbrella().config;

  if (type !== undefined || !ctx.interactive) return type;

  if (Object.keys(types).length === 1) return defaultType;

  return ctx.prompter.select(
    'Select the umbrella type',
    Object.entries(types).map(([value, base]) => ({
      value,
      label: value,
      hint: `targets ${base}`,
    })),
  );
}

type CommandOutput = {
  exitCode?: number;
  /** Printed with `--json`, merged with `ok: true` */
  data: Record<string, unknown>;
  /** Printed without `--json` */
  text: string[];
};

async function createUmbrellaCmd(ctx: CommandContext): Promise<CommandOutput> {
  const name = await requireValue(ctx, ctx.positionals[0], {
    flag: '<name>',
    prompt: () =>
      ctx.prompter.text('Umbrella name (e.g. new-billing)', {
        validate: (value) => (value.trim() ? true : 'Name cannot be empty'),
      }),
  });

  const result = unwrap(
    await ctx.umbrella().createUmbrella({
      name,
      type: await promptType(ctx),
      openPr: !getBoolean(ctx, 'no-pr'),
      draft: getBoolean(ctx, 'draft'),
      on: getString(ctx, 'on'),
    }),
  );

  return {
    data: { branch: result.branch, pr: result.pr, dependsOn: result.dependsOn },
    text: [
      `Created umbrella ${result.branch.fullName}`,
      ...(result.dependsOn ?
        [
          `It targets ${result.dependsOn.branch} (#${result.dependsOn.pr}) until it is merged into ${result.branch.base}`,
        ]
      : []),
      ...formatPr(result.pr),
    ],
  };
}

async function createChildCmd(ctx: CommandContext): Promise<CommandOutput> {
  const from = getChoice(ctx, 'from', ['umbrella', 'current'] as const);
  const umbrellaName = await resolveUmbrellaOption(ctx);
  const name = await requireValue(ctx, ctx.positionals[0], {
    flag: '<name>',
    prompt: () =>
      ctx.prompter.text('Child branch name (e.g. adjust-ui)', {
        validate: (value) => (value.trim() ? true : 'Name cannot be empty'),
      }),
  });

  const result = unwrap(
    await ctx.umbrella().createChild({ name, umbrella: umbrellaName, from }),
  );

  return {
    data: { branch: result.branch, umbrella: result.umbrella },
    text: [`Created child ${result.branch.fullName}`],
  };
}

async function createSyncCmd(ctx: CommandContext): Promise<CommandOutput> {
  const result = unwrap(
    await ctx.umbrella().createSync({
      umbrella: await resolveUmbrellaOption(ctx),
      from: getString(ctx, 'from'),
      push: getBoolean(ctx, 'push'),
      pr: getBoolean(ctx, 'pr'),
    }),
  );

  const hasConflicts = result.conflictedFiles.length > 0;

  return {
    exitCode: hasConflicts ? EXIT.conflicts : EXIT.ok,
    data: { ...result, hasConflicts },
    text:
      hasConflicts ?
        [
          ...result.warnings.map((warning) => `warning: ${warning}`),
          `Created ${result.branch}`,
          ...conflictText(result.branch, result.source, result.conflictedFiles),
          'Then run `umbrella-prs pr create` to push and open the sync PR.',
        ]
      : [
          ...result.warnings.map((warning) => `warning: ${warning}`),
          `Created ${result.branch} with ${result.source} merged`,
          ...(result.pushed ? ['Pushed'] : []),
          ...formatPr(result.pr),
        ],
  };
}

async function createCmd(ctx: CommandContext): Promise<CommandOutput> {
  if (!ctx.interactive) {
    throw usageError(
      'Missing what to create',
      'Use `umbrella-prs create umbrella|child|sync`',
    );
  }

  const { branchNames } = ctx.umbrella().config;
  const kind = await ctx.prompter.select('What do you want to create?', [
    {
      value: 'child',
      label: 'Child branch',
      hint: `${branchNames.child}/<umbrella>/<name>`,
    },
    {
      value: 'sync',
      label: 'Sync with base',
      hint: `${branchNames.child}/<umbrella>/sync-N`,
    },
    {
      value: 'umbrella',
      label: 'Umbrella branch',
      hint: `<type>/${branchNames.umbrella}/<name>`,
    },
  ]);

  if (kind === 'umbrella') return createUmbrellaCmd(ctx);
  if (kind === 'sync') return createSyncCmd(ctx);
  return createChildCmd(ctx);
}

async function convertCmd(ctx: CommandContext): Promise<CommandOutput> {
  const u = ctx.umbrella();
  const current = await u.git.currentBranch();

  if (current && u.parseBranch(current)) {
    await confirmOrFail(
      ctx,
      `"${current}" is already an umbrella workflow branch, convert it anyway?`,
    );
  }

  let umbrella = getString(ctx, 'umbrella');
  let newUmbrella = getString(ctx, 'new-umbrella');

  if (umbrella !== undefined && newUmbrella !== undefined) {
    throw usageError('Pass either --umbrella or --new-umbrella, not both');
  }

  if (umbrella === undefined && newUmbrella === undefined) {
    if (!ctx.interactive) {
      throw usageError(
        'Missing the umbrella',
        'Pass --umbrella <name> or --new-umbrella <name> [--type <type>]',
      );
    }

    const selected = await selectUmbrella(ctx, { allowNew: true });

    if (selected === '\u0000new') {
      newUmbrella = await ctx.prompter.text('New umbrella name', {
        initial: current ? current.split('/').at(-1) : undefined,
        validate: (value) => (value.trim() ? true : 'Name cannot be empty'),
      });
    } else {
      umbrella = selected;
    }
  }

  const childName = await requireValue(ctx, ctx.positionals[0], {
    flag: '<child-name>',
    prompt: () =>
      ctx.prompter.text('Child branch name', {
        initial: current ? current.split('/').at(-1) : undefined,
        validate: (value) => (value.trim() ? true : 'Name cannot be empty'),
      }),
  });

  const result = unwrap(
    newUmbrella !== undefined ?
      await u.convertToChild({
        childName,
        newUmbrella: {
          name: newUmbrella,
          type: await promptType(ctx),
          openPr: !getBoolean(ctx, 'no-pr'),
        },
      })
    : await u.convertToChild({ childName, umbrella: umbrella ?? '' }),
  );

  const hasConflicts = result.conflictedFiles.length > 0;

  return {
    exitCode: hasConflicts ? EXIT.conflicts : EXIT.ok,
    data: { ...result, hasConflicts },
    text: [
      ...(result.umbrellaPr ?
        [
          `Created umbrella ${result.umbrella.fullName}`,
          ...formatPr(result.umbrellaPr),
        ]
      : []),
      `Created child ${result.branch.fullName}`,
      ...(hasConflicts ?
        conflictText(
          result.branch.fullName,
          current ?? 'the branch',
          result.conflictedFiles,
        )
      : []),
    ],
  };
}

async function parseCmd(ctx: CommandContext): Promise<CommandOutput> {
  const branch =
    ctx.positionals[0] ?? (await ctx.umbrella().git.currentBranch());

  if (!branch) {
    throw usageError('HEAD is detached', 'Pass the branch name');
  }

  const result = parseBranchStrict(branch, ctx.umbrella().config);

  if (result.ok) {
    return {
      data: { branch: result.value, error: null },
      text: Object.entries(result.value).map(
        ([key, value]) => `${key}: ${JSON.stringify(value)}`,
      ),
    };
  }

  // a branch outside the workflow is a valid answer, not a failure
  const isOutside = result.error.code === 'not-umbrella-workflow';

  return {
    exitCode: isOutside ? EXIT.ok : EXIT.failed,
    data: { branch: null, error: isOutside ? null : result.error },
    text: [result.error.message],
  };
}

async function findUmbrellaCmd(ctx: CommandContext): Promise<CommandOutput> {
  const umbrella = unwrap(
    await ctx.umbrella().findUmbrella(ctx.positionals[0], {
      fetch: getBoolean(ctx, 'fetch'),
    }),
  );

  return { data: { umbrella }, text: [umbrella.fullName] };
}

async function treeCmd(ctx: CommandContext): Promise<CommandOutput> {
  const source = getChoice(ctx, 'source', ['prs', 'branches'] as const);
  const tree = unwrap(await ctx.umbrella().getTree({ source }));

  const prLabel = (pr: { number: number; title: string } | null) =>
    pr ? ` #${pr.number} ${pr.title}` : '';

  const text: string[] = [];

  for (const node of tree.umbrellas) {
    text.push(`${node.branch.fullName}${prLabel(node.pr)}`);

    for (const child of node.children) {
      text.push(`  ${child.branch.fullName}${prLabel(child.pr)}`);
    }
  }

  if (tree.orphans.length > 0) {
    text.push('Children without an open umbrella:');

    for (const orphan of tree.orphans) {
      text.push(`  ${orphan.branch.fullName}${prLabel(orphan.pr)}`);
    }
  }

  if (text.length === 0) text.push('No umbrellas found');

  return { data: { ...tree }, text };
}

async function syncCmd(ctx: CommandContext): Promise<CommandOutput> {
  const strategy = getChoice(ctx, 'strategy', [
    'auto',
    'merge',
    'rebase',
  ] as const);
  const u = ctx.umbrella();
  let stash = getBoolean(ctx, 'stash');

  if (!stash && ctx.interactive && (await u.git.hasUncommittedChanges())) {
    stash = await ctx.prompter.confirm(
      'You have uncommitted changes, stash them before syncing?',
    );
  }

  const result = unwrap(
    await u.syncWithParent({ branch: ctx.positionals[0], strategy, stash }),
  );

  const hasConflicts = result.conflictedFiles.length > 0;

  return {
    exitCode: hasConflicts ? EXIT.conflicts : EXIT.ok,
    data: { ...result, hasConflicts },
    text:
      hasConflicts ?
        [
          ...(result.strategy === 'merge' ?
            conflictText(result.branch, result.parent, result.conflictedFiles)
          : [
              `Rebasing onto "${result.parent}" has conflicts:`,
              ...result.conflictedFiles.map((file) => `- ${file}`),
              'Resolve them and run `git rebase --continue`.',
            ]),
          ...(result.stashed ?
            [
              'Your changes are still stashed, run `git stash pop` after finishing.',
            ]
          : []),
        ]
      : [`Synced ${result.branch} with ${result.parent} (${result.strategy})`],
  };
}

function writeOutput(ctx: CommandContext, file: string, content: string) {
  const filePath = path.resolve(ctx.cwd, file);

  writeFileSync(filePath, content);

  return filePath;
}

async function diffSyncCmd(ctx: CommandContext): Promise<CommandOutput> {
  const html = getBoolean(ctx, 'html');
  const target = ctx.positionals[0];
  const prMatch = target === undefined ? null : prTargetRegex.exec(target);
  const pr = prMatch?.[1] ?? prMatch?.[2];
  const result = unwrap(
    await ctx.umbrella().syncDiff({
      mode: 'local',
      ...(pr !== undefined ? { pr: Number(pr) } : { branch: target }),
      left: getString(ctx, 'left'),
      right: getString(ctx, 'right'),
      exclude: getStrings(ctx, 'exclude'),
      includeContents: html,
      includeBaseDiff: html,
    }),
  );

  if (html) {
    const out = getString(ctx, 'out');
    const filePath =
      out !== undefined ?
        path.resolve(ctx.cwd, out)
      : path.join(
          tmpdir(),
          'umbrella-prs',
          `sync-diff-${result.head.slice(0, 12)}.html`,
        );

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, renderSyncDiffHtml(result, { base: result.base }));

    if (!getBoolean(ctx, 'no-open')) await ctx.openFile(filePath);

    return {
      data: { ...result, file: filePath },
      text: [`Sync diff viewer written to ${filePath}`],
    };
  }

  const content = result.sections
    .map((section) =>
      [
        `# ${section.leftLabel} + ${section.rightLabel} -> ${section.compareTo.slice(0, 12)}`,
        `# conflicted files: ${section.conflictedFiles.join(', ') || 'none'}`,
        section.diff || '# no conflict resolutions or manual edits',
      ].join('\n'),
    )
    .join('\n\n');

  const out = getString(ctx, 'out');

  if (out !== undefined) {
    const filePath = writeOutput(ctx, out, `${content}\n`);

    return {
      data: { ...result, file: filePath },
      text: [`Sync diff written to ${filePath}`],
    };
  }

  return { data: { ...result }, text: [content] };
}

async function diffChildCmd(ctx: CommandContext): Promise<CommandOutput> {
  const result = unwrap(
    await ctx.umbrella().childDiff({
      branch: ctx.positionals[0],
      include: getStrings(ctx, 'include'),
      exclude: getStrings(ctx, 'exclude'),
      ignoreImportOnly: getBoolean(ctx, 'ignore-imports'),
    }),
  );

  const out = getString(ctx, 'out');

  if (out !== undefined) {
    const filePath = writeOutput(ctx, out, result.diff);

    return {
      data: { parent: result.parent, files: result.files, file: filePath },
      text: [
        `Diff vs ${result.parent} written to ${filePath} (${result.files.length} files)`,
      ],
    };
  }

  return { data: { ...result }, text: [result.diff] };
}

async function prTemplateCmd(ctx: CommandContext): Promise<CommandOutput> {
  const template = unwrap(
    await ctx.umbrella().getPrTemplate(ctx.positionals[0]),
  );

  return {
    data: { ...template },
    text: [
      `base: ${template.base}`,
      `title: ${template.title}`,
      '',
      template.body,
    ],
  };
}

async function prCreateCmd(ctx: CommandContext): Promise<CommandOutput> {
  const pr = unwrap(
    await ctx.umbrella().openPr({
      branch: ctx.positionals[0],
      draft: getBoolean(ctx, 'draft'),
    }),
  );

  return { data: { pr }, text: formatPr(pr) };
}

type GitHubEvent = {
  number: number | undefined;
  author: string | undefined;
  draft: boolean | undefined;
};

function readGitHubEvent(env: CommandContext['env']): GitHubEvent {
  const eventPath = env.GITHUB_EVENT_PATH;
  const empty = { number: undefined, author: undefined, draft: undefined };

  if (!eventPath) return empty;

  try {
    const event: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));

    if (!isRecord(event) || !isRecord(event.pull_request)) return empty;

    const pr = event.pull_request;
    const user = isRecord(pr.user) ? pr.user : {};

    return {
      number: typeof pr.number === 'number' ? pr.number : undefined,
      author: typeof user.login === 'string' ? user.login : undefined,
      draft: typeof pr.draft === 'boolean' ? pr.draft : undefined,
    };
  } catch {
    return empty;
  }
}

function getCiInput(ctx: CommandContext) {
  const event = readGitHubEvent(ctx.env);

  function required(name: string, value: string | undefined, envNames: string) {
    if (!value) {
      throw usageError(
        `Missing --${name}`,
        `Pass --${name} or set ${envNames}`,
      );
    }

    return value;
  }

  const prValue =
    getString(ctx, 'pr') ?? ctx.env.PR ?? event.number?.toString();

  function parsePr(value: string) {
    const number = Number(value);

    if (!Number.isInteger(number) || number <= 0) {
      throw usageError(`Invalid --pr "${value}"`, 'Pass the PR number');
    }

    return number;
  }

  return {
    optionalPr: () => (prValue ? parsePr(prValue) : undefined),
    head: () =>
      required(
        'head',
        getString(ctx, 'head') ?? (ctx.env.HEAD_REF || ctx.env.GITHUB_HEAD_REF),
        'HEAD_REF or GITHUB_HEAD_REF',
      ),
    base: () =>
      required(
        'base',
        getString(ctx, 'base') ?? (ctx.env.BASE_REF || ctx.env.GITHUB_BASE_REF),
        'BASE_REF or GITHUB_BASE_REF',
      ),
    pr: () => parsePr(required('pr', prValue, 'PR or GITHUB_EVENT_PATH')),
    author: () =>
      required(
        'author',
        getString(ctx, 'author') ?? (ctx.env.PR_AUTHOR || event.author),
        'PR_AUTHOR or GITHUB_EVENT_PATH',
      ),
    draft: () => getBoolean(ctx, 'draft') || event.draft === true,
  };
}

const VERIFY_COMMENT_MARKER = 'UMBRELLA_PRS_VERIFY';

async function ciVerify(ctx: CommandContext) {
  const input = getCiInput(ctx);
  const u = ctx.umbrella();
  const prNumber = input.optionalPr();

  const result = unwrap(
    await u.verify({
      head: input.head(),
      base: input.base(),
      prNumber,
      skipHistoryChecks: getBoolean(ctx, 'skip-history'),
    }),
  );

  if (getBoolean(ctx, 'comment') && prNumber !== undefined) {
    if (result.errors.length > 0) {
      await u.github.replaceMarkedComment(
        prNumber,
        VERIFY_COMMENT_MARKER,
        [
          '## Umbrella PR checks failed',
          '',
          ...result.errors.map(
            (error) => `- ${error.message}\n  - Fix: ${error.fix}`,
          ),
        ].join('\n'),
      );
    } else {
      await u.github.deleteMarkedComments(prNumber, VERIFY_COMMENT_MARKER);
    }
  }

  return result;
}

function formatVerifyText(result: VerifyResult): string[] {
  if (result.kind === null)
    return ['Not an umbrella workflow PR, nothing to check'];

  return [
    ...(result.errors.length === 0 ? [`Umbrella ${result.kind} PR: ok`] : []),
    ...result.errors.flatMap((error) => [
      `error: ${error.message}`,
      `fix: ${error.fix}`,
    ]),
    ...result.warnings.flatMap((warning) => [
      `warning: ${warning.message}`,
      ...(warning.fix ? [`fix: ${warning.fix}`] : []),
    ]),
  ];
}

async function ciVerifyCmd(ctx: CommandContext): Promise<CommandOutput> {
  const result = await ciVerify(ctx);

  return {
    exitCode: result.errors.length > 0 ? EXIT.failed : EXIT.ok,
    data: { ...result },
    text: formatVerifyText(result),
  };
}

/**
 * Lists the child in the umbrella PR's Children PRs and adds the umbrella PR
 * link to the child PR description when it's missing
 */
async function linkChildAndUmbrella(ctx: CommandContext) {
  const input = getCiInput(ctx);
  const childPr = input.pr();
  const u = ctx.umbrella();

  const parent = unwrap(
    await u.updateParentPrDescription({ childPr, parentBranch: input.base() }),
  );
  const child = unwrap(
    await u.addParentLinkToChildPr({ childPr, parentPr: parent.parentPr }),
  );

  const result = {
    parentPr: parent.parentPr,
    parentChanged: parent.changed,
    childChanged: child.changed,
  };

  const text = [
    result.parentChanged ?
      `Added the PR to #${result.parentPr} children`
    : `#${result.parentPr} already lists the PR`,
    ...(result.childChanged ?
      [`Added the #${result.parentPr} link to the PR description`]
    : []),
  ];

  return { result, text };
}

async function ciUpdateParentCmd(ctx: CommandContext): Promise<CommandOutput> {
  const { result, text } = await linkChildAndUmbrella(ctx);

  return { data: { ...result }, text };
}

async function ciSyncDiff(ctx: CommandContext, base: string) {
  const u = ctx.umbrella();
  const result = unwrap(
    await u.syncDiff({
      mode: 'ci',
      base,
      pr: getCiInput(ctx).optionalPr(),
      right: getString(ctx, 'right'),
      headCommit: getString(ctx, 'head-commit'),
      exclude: getStrings(ctx, 'exclude'),
    }),
  );

  const body = renderSyncDiffComment(result, {
    maxChars: u.config.syncDiff.maxCommentChars,
  });

  return { result, body };
}

async function ciSyncDiffCmd(ctx: CommandContext): Promise<CommandOutput> {
  const input = getCiInput(ctx);
  const { result, body } = await ciSyncDiff(ctx, input.base());

  if (getBoolean(ctx, 'post')) {
    unwrap(
      await ctx
        .umbrella()
        .postSyncDiffComment({ prNumber: input.pr(), result }),
    );
  }

  return { data: { ...result, comment: body }, text: [body] };
}

async function ciAutoApproveCmd(ctx: CommandContext): Promise<CommandOutput> {
  const input = getCiInput(ctx);
  const approve = getBoolean(ctx, 'approve');

  const result = unwrap(
    await ctx.umbrella().autoApprove({
      head: input.head(),
      base: input.base(),
      author: input.author(),
      draft: input.draft(),
      prNumber: approve ? input.pr() : 0,
      approve,
    }),
  );

  return {
    data: { ...result },
    text: [
      `${
        result.approved ? 'Approved'
        : result.eligible ? 'Eligible'
        : 'Not eligible'
      }: ${result.reason}`,
    ],
  };
}

async function ciRunCmd(ctx: CommandContext): Promise<CommandOutput> {
  const input = getCiInput(ctx);
  const verify = await ciVerify(ctx);

  if (verify.kind === null) {
    return {
      data: { verify, updateParent: null, syncDiff: null },
      text: ['Not an umbrella workflow PR, nothing to do'],
    };
  }

  if (verify.errors.length > 0) {
    return {
      exitCode: EXIT.failed,
      data: { verify, updateParent: null, syncDiff: null },
      text: formatVerifyText(verify),
    };
  }

  const text = formatVerifyText(verify);
  let updateParent: unknown = null;
  let syncDiff: unknown = null;

  if (verify.kind === 'child' || verify.kind === 'sync') {
    const linked = await linkChildAndUmbrella(ctx);

    updateParent = linked.result;
    text.push(...linked.text);
  }

  if (verify.kind === 'sync') {
    const { result } = await ciSyncDiff(ctx, input.base());

    unwrap(
      await ctx
        .umbrella()
        .postSyncDiffComment({ prNumber: input.pr(), result }),
    );

    syncDiff = result;
    text.push('Posted the sync diff comment');
  }

  return { data: { verify, updateParent, syncDiff }, text };
}

const ciInputOptions: Record<string, OptionDef> = {
  head: {
    type: 'string',
    description: 'PR head branch (env HEAD_REF, GITHUB_HEAD_REF)',
  },
  base: {
    type: 'string',
    description: 'PR base branch (env BASE_REF, GITHUB_BASE_REF)',
  },
  pr: { type: 'string', description: 'PR number (env PR, GITHUB_EVENT_PATH)' },
};

const syncDiffOptions: Record<string, OptionDef> = {
  right: {
    type: 'string',
    description: 'Merged branch, skips detecting it from the merge commits',
  },
  exclude: {
    type: 'string',
    multiple: true,
    description: 'Glob excluded from the diff, repeatable',
  },
};

type CommandDef = {
  path: string[];
  args?: string;
  description: string;
  options?: Record<string, OptionDef>;
  examples?: string[];
  run: (ctx: CommandContext) => Promise<CommandOutput>;
};

export const commands: CommandDef[] = [
  {
    path: ['parse'],
    args: '[branch]',
    description: 'Parse a branch name (defaults to the current branch)',
    examples: ['umbrella-prs parse under/billing/adjust-ui --json'],
    run: parseCmd,
  },
  {
    path: ['create'],
    description: 'Interactively choose what to create',
    run: createCmd,
  },
  {
    path: ['create', 'umbrella'],
    args: '<name>',
    description:
      'Create <type>/umbrella/<name> from its base with an empty commit, push it and open its PR',
    options: {
      type: {
        type: 'string',
        description: 'Branch type from the config, defaults to `defaultType`',
      },
      on: {
        type: 'string',
        description:
          'Open branch this umbrella depends on: created from it, and the PR targets it until it is merged',
      },
      'no-pr': { type: 'boolean', description: 'Do not open the PR' },
      draft: { type: 'boolean', description: 'Open the PR as a draft' },
    },
    examples: [
      'umbrella-prs create umbrella new-billing --type feature',
      'umbrella-prs create umbrella billing-v2 --on feature/umbrella/new-billing',
    ],
    run: createUmbrellaCmd,
  },
  {
    path: ['create', 'child'],
    args: '<name>',
    description: 'Create under/<umbrella>/<name>',
    options: {
      umbrella: {
        type: 'string',
        description:
          'Umbrella name, defaults to the umbrella of the current branch',
      },
      from: { type: 'string', description: 'umbrella (default) or current' },
    },
    examples: ['umbrella-prs create child adjust-ui --umbrella new-billing'],
    run: createChildCmd,
  },
  {
    path: ['create', 'sync'],
    description:
      "Create under/<umbrella>/sync[-N] and merge the umbrella's current base into it (the branch it depends on, or its configured base). Exits 3 when the merge has conflicts, leaving it in progress",
    options: {
      from: {
        type: 'string',
        description:
          'Merge this branch instead, other branches than the bases create sync-<label>',
      },
      umbrella: {
        type: 'string',
        description:
          'Umbrella name, defaults to the umbrella of the current branch',
      },
      push: {
        type: 'boolean',
        description: 'Push when there are no conflicts',
      },
      pr: {
        type: 'boolean',
        description: 'Push and open the sync PR when there are no conflicts',
      },
    },
    examples: [
      'umbrella-prs create sync --umbrella new-billing --pr || (resolve, git commit --no-edit, umbrella-prs pr create)',
    ],
    run: createSyncCmd,
  },
  {
    path: ['convert'],
    args: '<child-name>',
    description:
      'Create a child of an umbrella and merge the current branch into it',
    options: {
      umbrella: { type: 'string', description: 'Existing umbrella name' },
      'new-umbrella': {
        type: 'string',
        description: 'Create a new umbrella with this name',
      },
      type: { type: 'string', description: 'Type of the new umbrella' },
      'no-pr': {
        type: 'boolean',
        description: 'Do not open the new umbrella PR',
      },
    },
    examples: ['umbrella-prs convert adjust-ui --umbrella new-billing'],
    run: convertCmd,
  },
  {
    path: ['find-umbrella'],
    args: '[name-or-branch]',
    description:
      'Find the umbrella branch of a name, umbrella branch or child branch (defaults to the current branch)',
    options: {
      fetch: { type: 'boolean', description: 'Fetch before searching' },
    },
    examples: ['umbrella-prs find-umbrella new-billing --json'],
    run: findUmbrellaCmd,
  },
  {
    path: ['tree'],
    description: 'Show umbrellas and their children',
    options: {
      source: {
        type: 'string',
        description: 'prs (default, open PRs) or branches',
      },
    },
    run: treeCmd,
  },
  {
    path: ['sync'],
    args: '[branch]',
    description:
      'Sync a child with its umbrella, or an umbrella with its base. Exits 3 on conflicts',
    options: {
      strategy: {
        type: 'string',
        description:
          'auto (default: merge when published, else rebase), merge or rebase',
      },
      stash: {
        type: 'boolean',
        description: 'Stash uncommitted changes and pop them after',
      },
    },
    run: syncCmd,
  },
  {
    path: ['diff', 'sync'],
    args: '[branch|pr]',
    description:
      'Conflict resolutions and manual edits of a sync branch or PR (number, #number or URL), compared with the automatic merge',
    options: {
      left: {
        type: 'string',
        description: 'Left branch, defaults to the umbrella',
      },
      ...syncDiffOptions,
      out: { type: 'string', description: 'Write the diff to this file' },
      html: {
        type: 'boolean',
        description:
          'Write an HTML viewer, where files can be marked as viewed, and open it',
      },
      'no-open': {
        type: 'boolean',
        description: 'Do not open the HTML viewer',
      },
    },
    run: diffSyncCmd,
  },
  {
    path: ['diff', 'child'],
    args: '[branch]',
    description:
      'Diff of a child against its umbrella (or an umbrella against its base)',
    options: {
      include: {
        type: 'string',
        multiple: true,
        description: 'Glob to include, repeatable',
      },
      exclude: {
        type: 'string',
        multiple: true,
        description: 'Glob to exclude, repeatable',
      },
      'ignore-imports': {
        type: 'boolean',
        description: 'Drop files whose changes are only imports/exports',
      },
      out: { type: 'string', description: 'Write the diff to this file' },
    },
    run: diffChildCmd,
  },
  {
    path: ['pr', 'template'],
    args: '[branch]',
    description: 'PR title, body and base of a branch',
    run: prTemplateCmd,
  },
  {
    path: ['pr', 'create'],
    args: '[branch]',
    description: 'Push the branch and open its PR with the template',
    options: { draft: { type: 'boolean', description: 'Open as a draft' } },
    run: prCreateCmd,
  },
  {
    path: ['ci', 'verify'],
    description:
      'Check the umbrella workflow rules of a PR. Exits 1 with the errors, warnings never fail',
    options: {
      ...ciInputOptions,
      comment: {
        type: 'boolean',
        description: 'Post the errors as a PR comment',
      },
      'skip-history': {
        type: 'boolean',
        description: 'Skip the git history checks',
      },
    },
    examples: [
      'umbrella-prs ci verify --head "$HEAD_REF" --base "$BASE_REF" --pr "$PR" --json',
    ],
    run: ciVerifyCmd,
  },
  {
    path: ['ci', 'update-parent'],
    description:
      "Add the child PR to its umbrella PR's Children PRs section, and the umbrella PR link to the child PR description when it's missing",
    options: ciInputOptions,
    run: ciUpdateParentCmd,
  },
  {
    path: ['ci', 'sync-diff'],
    description:
      'Render the sync diff of a PR, from the PR merge commit checkout (HEAD^2 is the PR head)',
    options: {
      ...ciInputOptions,
      ...syncDiffOptions,
      'head-commit': {
        type: 'string',
        description: 'PR head commit, defaults to HEAD^2, then HEAD',
      },
      post: {
        type: 'boolean',
        description: 'Post it as a PR comment, replacing the previous one',
      },
    },
    examples: [
      'umbrella-prs ci sync-diff --base beta --right master --pr 123 --post',
    ],
    run: ciSyncDiffCmd,
  },
  {
    path: ['ci', 'auto-approve'],
    description:
      'Check if a child PR can be auto-approved, and approve it with --approve',
    options: {
      ...ciInputOptions,
      author: {
        type: 'string',
        description: 'PR author (env PR_AUTHOR, GITHUB_EVENT_PATH)',
      },
      draft: { type: 'boolean', description: 'The PR is a draft' },
      approve: { type: 'boolean', description: 'Approve when eligible' },
    },
    run: ciAutoApproveCmd,
  },
  {
    path: ['ci', 'run'],
    description:
      'verify, then update-parent for children (both PRs get linked) and sync-diff --post for syncs. No-op for PRs outside the workflow',
    options: {
      ...ciInputOptions,
      ...syncDiffOptions,
      'head-commit': {
        type: 'string',
        description: 'PR head commit, defaults to HEAD^2, then HEAD',
      },
      comment: {
        type: 'boolean',
        description: 'Post verification errors as a PR comment',
      },
      'skip-history': {
        type: 'boolean',
        description: 'Skip the git history checks',
      },
    },
    examples: ['umbrella-prs ci run --json'],
    run: ciRunCmd,
  },
];

function findCommand(argv: string[]): {
  command: CommandDef | null;
  rest: string[];
} {
  let best: CommandDef | null = null;

  for (const command of commands) {
    const matches = command.path.every((part, index) => argv[index] === part);

    if (matches && (!best || command.path.length > best.path.length)) {
      best = command;
    }
  }

  return { command: best, rest: best ? argv.slice(best.path.length) : argv };
}

function formatHelp(command: CommandDef | null): string {
  if (!command) {
    const lines = [
      'umbrella-prs: umbrella PR branch workflow',
      '',
      'Usage: umbrella-prs <command> [options]',
      '',
      'Commands:',
      ...commands.map(
        (cmd) =>
          `  ${[...cmd.path, cmd.args ?? ''].join(' ').trim().padEnd(34)} ${cmd.description}`,
      ),
      '',
      'Global options:',
      ...formatOptions(globalOptions),
      '',
      'Branch names use the default `umbrella` and `under` identifiers, set `branchNames` in the config to change them',
      '',
      `Exit codes: ${EXIT.ok} ok, ${EXIT.failed} failed, ${EXIT.usage} usage error, ${EXIT.conflicts} merge conflicts left in progress, ${EXIT.config} config error, ${EXIT.precondition} precondition failed (dirty tree, not found)`,
    ];

    return lines.join('\n');
  }

  return [
    `Usage: umbrella-prs ${[...command.path, command.args ?? ''].join(' ').trim()} [options]`,
    '',
    command.description,
    '',
    'Options:',
    ...formatOptions({ ...command.options, ...globalOptions }),
    ...(command.examples ?
      ['', 'Examples:', ...command.examples.map((example) => `  ${example}`)]
    : []),
  ].join('\n');
}

function formatOptions(options: Record<string, OptionDef>) {
  return Object.entries(options).map(
    ([name, option]) =>
      `  --${`${name}${option.type === 'string' ? ' <value>' : ''}`.padEnd(24)} ${option.description}`,
  );
}

export type CliIo = {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
  exec?: Exec;
  prompter?: Prompter;
};

export async function runCli(io: CliIo): Promise<number> {
  const json = io.argv.includes('--json');

  function printError(error: CliError) {
    if (json) {
      io.stdout(
        `${JSON.stringify({ ok: false, error: { code: error.code, message: error.message, fix: error.fix ?? null } }, null, 2)}\n`,
      );
    } else {
      io.stderr(`error: ${error.message}\n`);

      if (error.fix) io.stderr(`fix: ${error.fix}\n`);
    }

    return error.exitCode;
  }

  const { command, rest } = findCommand(io.argv);

  if (!command || (rest.includes('--help') && !rest.includes('--'))) {
    if (!command && io.argv.length > 0 && !io.argv.includes('--help')) {
      printError(
        usageError(
          `Unknown command "${io.argv.filter((arg) => !arg.startsWith('-')).join(' ')}"`,
          'Run `umbrella-prs --help` to list the commands',
        ),
      );
      io.stderr(`\n${formatHelp(null)}\n`);
      return EXIT.usage;
    }

    io.stdout(`${formatHelp(command)}\n`);
    return EXIT.ok;
  }

  const options: NonNullable<ParseArgsConfig['options']> = {};

  for (const [name, option] of Object.entries({
    ...command.options,
    ...globalOptions,
  })) {
    options[name] =
      option.multiple ?
        { type: 'string', multiple: true }
      : { type: option.type };
  }

  let parsed: ReturnType<typeof parseArgs>;

  try {
    parsed = parseArgs({
      args: rest,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return printError(
      usageError(
        error instanceof Error ? error.message : String(error),
        `Run \`umbrella-prs ${command.path.join(' ')} --help\``,
      ),
    );
  }

  const values = parsed.values;
  const yes = values.yes === true || values['non-interactive'] === true;
  const interactive = !yes && !json && io.isTTY;
  const cwd =
    typeof values.cwd === 'string' ? path.resolve(io.cwd, values.cwd) : io.cwd;
  const configPath =
    typeof values.config === 'string' ? values.config : undefined;
  const log = (text: string) => io.stderr(`${text}\n`);

  let umbrellaInstance: UmbrellaPrs | null = null;

  const ctx: CommandContext = {
    positionals: parsed.positionals,
    values,
    interactive,
    yes,
    prompter: io.prompter ?? createReadlinePrompter(),
    env: io.env,
    cwd,
    log,
    openFile: async (filePath) => {
      if (!io.isTTY || json) return;

      const [cmd, ...args] =
        process.platform === 'darwin' ? ['open']
        : process.platform === 'win32' ? ['cmd', '/c', 'start', '""']
        : ['xdg-open'];

      if (cmd) await (io.exec ?? defaultExec)(cmd, [...args, filePath]);
    },
    umbrella: () => {
      if (umbrellaInstance) return umbrellaInstance;

      const config = loadConfig({ cwd, configPath });

      if (!config.ok) {
        throw new CliError({
          code: 'config',
          message: config.error.message,
          fix: config.error.fix,
          exitCode: EXIT.config,
        });
      }

      umbrellaInstance = createUmbrellaPrs({
        config: config.value.config,
        cwd,
        exec: io.exec ?? defaultExec,
        hooks: { log: json ? () => {} : log },
      });

      return umbrellaInstance;
    },
  };

  try {
    const output = await command.run(ctx);
    const exitCode = output.exitCode ?? EXIT.ok;

    if (json) {
      io.stdout(
        `${JSON.stringify({ ok: exitCode === EXIT.ok, exitCode, ...output.data }, null, 2)}\n`,
      );
    } else {
      io.stdout(`${output.text.join('\n')}\n`);
    }

    return exitCode;
  } catch (error) {
    if (error instanceof CliError) return printError(error);

    if (error instanceof PromptCancelledError) {
      return printError(
        new CliError({
          code: 'cancelled',
          message: 'Cancelled',
          exitCode: EXIT.failed,
        }),
      );
    }

    return printError(
      new CliError({
        code: 'unexpected',
        message: error instanceof Error ? error.message : String(error),
        exitCode: EXIT.failed,
      }),
    );
  }
}
