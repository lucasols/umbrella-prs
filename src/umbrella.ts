import {
  getAutoApproveEligibility,
  type AutoApproveEligibility,
  type AutoApproveInput,
} from './autoApprove';
import { getBranchDiff } from './childDiff';
import {
  resolveConfig,
  type ResolvedConfig,
  type UmbrellaConfig,
} from './config';
import { CommandError, defaultExec, type Exec } from './exec';
import { createGit } from './git';
import { createGitHub, type FullPrInfo, type PrInfo } from './github';
import {
  findUmbrellaBranch,
  formatChildBranch,
  formatUmbrellaBranch,
  getChildrenOf,
  getNextSyncBranchName,
  inferTitleFromName,
  normalizeBranchSegment,
  parseBranch,
  validateChildName,
  validateUmbrellaName,
  type ParsedBranch,
  type ParsedChild,
  type ParsedUmbrella,
} from './naming';
import {
  addChildToUmbrellaBody,
  addParentLinkToChildBody,
  childPrTemplate,
  findParentPr,
  syncPrTemplate,
  umbrellaPrTemplate,
  type PrTemplate,
} from './prTemplates';
import { err, ok, type Result } from './result';
import {
  getSyncDiff,
  renderSyncDiffComment,
  type SyncDiffMode,
  type SyncDiffResult,
} from './syncDiff';
import {
  resolveCurrentBase,
  getDependencyChain,
  type CurrentBase,
} from './dependency';
import { buildTree } from './tree';
import { verifyPr, type VerifyInput, type VerifyResult } from './verify';

export type OpErrorCode =
  | 'not-umbrella-branch'
  | 'umbrella-not-found'
  | 'child-exists'
  | 'umbrella-exists'
  | 'invalid-name'
  | 'dirty-worktree'
  | 'detached-head'
  | 'from-current-not-in-umbrella'
  | 'unknown-type'
  | 'parent-pr-not-found'
  | 'invalid-dependency'
  | 'merge-conflicts'
  | 'no-merges-found'
  | 'git-too-old'
  | 'git-failed'
  | 'gh-failed';

export type OpError = { code: OpErrorCode; message: string; fix?: string };

export type OpResult<T> = Result<T, OpError>;

export type CreatedPr = {
  number: number;
  url: string;
  alreadyExisted: boolean;
};

export type TreeNode = {
  branch: ParsedUmbrella;
  pr: FullPrInfo | null;
  /** Branch this umbrella lands into before the configured base */
  dependsOn: { branch: string; pr: number | null } | null;
  children: { branch: ParsedChild; pr: FullPrInfo | null }[];
};

export type Tree = {
  umbrellas: TreeNode[];
  orphans: { branch: ParsedChild; pr: FullPrInfo | null }[];
};

export type UmbrellaHooks = {
  /** Child PR title and body, e.g. an AI description. Return `null` to use the default template */
  generateChildPr?: (ctx: {
    branch: ParsedChild;
    parentPr: FullPrInfo;
    baseBranch: string;
  }) => Promise<PrTemplate | null>;
  /** Umbrella PR title and body. Return `null` to use the default template */
  generateUmbrellaPr?: (ctx: {
    branch: ParsedUmbrella;
  }) => Promise<PrTemplate | null>;
  /** Replaces `gh pr create` */
  createPr?: (ctx: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }) => Promise<{ number: number; url: string }>;
  /** Progress messages */
  log?: (message: string) => void;
};

export type CreateUmbrellaPrsOptions = {
  config: UmbrellaConfig;
  hooks?: UmbrellaHooks;
  /** Defaults to `process.cwd()` */
  cwd?: string;
  /** Runs `git` and `gh`, replaceable in tests */
  exec?: Exec;
};

export type UmbrellaPrs = ReturnType<typeof createUmbrellaPrs>;

export function createUmbrellaPrs({
  config: configInput,
  hooks = {},
  cwd,
  exec = defaultExec,
}: CreateUmbrellaPrsOptions) {
  const resolvedConfig = resolveConfig(configInput);

  if (!resolvedConfig.ok) throw new Error(resolvedConfig.error.message);

  const config: ResolvedConfig = resolvedConfig.value;

  const git = createGit({ exec, cwd, remote: config.remote });
  const github = createGitHub({ exec, cwd, repo: config.repo });
  const log = hooks.log ?? (() => {});

  let openPrsCache: Promise<FullPrInfo[]> | null = null;

  function getOpenPrs(): Promise<FullPrInfo[]> {
    openPrsCache ??= github.listOpenPrs();

    return openPrsCache;
  }

  async function attempt<T>(
    fn: () => Promise<NoInfer<OpResult<T>>>,
  ): Promise<OpResult<T>> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CommandError) {
        return err({
          code: error.command.startsWith('gh ') ? 'gh-failed' : 'git-failed',
          message: error.message,
        });
      }

      throw error;
    }
  }

  async function listBranches(): Promise<ParsedBranch[]> {
    const parsed: ParsedBranch[] = [];

    for (const branch of await git.listBranches()) {
      const parsedBranch = parseBranch(branch, config);

      if (parsedBranch) parsed.push(parsedBranch);
    }

    return parsed;
  }

  async function requireCurrentBranch(): Promise<OpResult<string>> {
    const current = await git.currentBranch();

    if (!current) {
      return err({
        code: 'detached-head',
        message: 'HEAD is detached',
        fix: 'Checkout a branch first',
      });
    }

    return ok(current);
  }

  async function requireCleanWorktree(): Promise<OpResult<null>> {
    if (await git.hasUncommittedChanges()) {
      return err({
        code: 'dirty-worktree',
        message: 'There are uncommitted changes',
        fix: 'Commit or stash the changes first',
      });
    }

    return ok(null);
  }

  /** The umbrella name of a branch, or the value itself when it's a bare name */
  function getUmbrellaName(nameOrBranch: string): string {
    const parsed = parseBranch(nameOrBranch, config);

    if (!parsed) return nameOrBranch;

    return parsed.kind === 'umbrella' ? parsed.name : parsed.umbrella;
  }

  async function resolveUmbrellaName(
    nameOrBranch: string | undefined,
  ): Promise<OpResult<string>> {
    if (nameOrBranch !== undefined) return ok(getUmbrellaName(nameOrBranch));

    const current = await requireCurrentBranch();

    if (!current.ok) return current;

    const parsed = parseBranch(current.value, config);

    if (!parsed) {
      return err({
        code: 'not-umbrella-branch',
        message: `"${current.value}" is not an umbrella or umbrella child branch`,
        fix: 'Pass the umbrella with `--umbrella <name>`, or checkout an umbrella branch',
      });
    }

    return ok(parsed.kind === 'umbrella' ? parsed.name : parsed.umbrella);
  }

  async function findUmbrella(
    nameOrBranch?: string,
    { fetch = false }: { fetch?: boolean } = {},
  ): Promise<OpResult<ParsedUmbrella>> {
    return attempt(async () => {
      const name = await resolveUmbrellaName(nameOrBranch);

      if (!name.ok) return name;

      if (fetch) await git.tryFetch('--prune');

      const umbrella = findUmbrellaBranch(
        name.value,
        await listBranches(),
        config,
      );

      if (!umbrella) {
        return err({
          code: 'umbrella-not-found',
          message: `Umbrella "${name.value}" not found in the local or remote branches`,
          fix: `Run \`git fetch\`, or create it with \`umbrella-prs create umbrella ${name.value}\``,
        });
      }

      return ok(umbrella);
    });
  }

  /** Child -> umbrella branch, umbrella -> base branch */
  async function resolveParent(
    branch?: string,
  ): Promise<OpResult<{ branch: ParsedBranch; parent: string }>> {
    return attempt(async () => {
      let branchName = branch;

      if (branchName === undefined) {
        const current = await requireCurrentBranch();

        if (!current.ok) return current;

        branchName = current.value;
      }

      const parsed = parseBranch(branchName, config);

      if (!parsed) {
        return err({
          code: 'not-umbrella-branch',
          message: `"${branchName}" is not an umbrella or umbrella child branch`,
        });
      }

      if (parsed.kind === 'umbrella') {
        const currentBase = await getCurrentBase(parsed);

        return ok({ branch: parsed, parent: currentBase.base });
      }

      const umbrella = await findUmbrella(parsed.umbrella);

      if (!umbrella.ok) return umbrella;

      return ok({ branch: parsed, parent: umbrella.value.fullName });
    });
  }

  async function isBranchGone(branch: string): Promise<boolean> {
    if (!(await git.remoteHasBranch(branch))) return true;

    return (await github.findMergedPrByHead(branch)) !== null;
  }

  /**
   * The branch the umbrella currently lands into: its PR base when it depends
   * on another open branch, otherwise the configured base
   */
  async function getCurrentBase(
    umbrella: ParsedUmbrella,
  ): Promise<CurrentBase<FullPrInfo>> {
    return resolveCurrentBase({
      umbrellaBranch: umbrella.fullName,
      rootBase: umbrella.base,
      openPrs: await getOpenPrs(),
      isBranchGone,
    });
  }

  /** Retargets the umbrella PR when its base was merged or deleted */
  async function retargetIfStale(
    currentBase: CurrentBase<FullPrInfo>,
  ): Promise<{ from: string; to: string } | null> {
    if (!currentBase.staleBase || !currentBase.pr) return null;

    log(
      `#${currentBase.pr.number} targets ${currentBase.staleBase}, which was merged or deleted, retargeting it to ${currentBase.rootBase}`,
    );

    await github.editPrBase(currentBase.pr.number, currentBase.rootBase);
    openPrsCache = null;

    return { from: currentBase.staleBase, to: currentBase.rootBase };
  }

  async function remoteOrLocal(branch: string) {
    return (await git.remoteBranchExists(branch)) ?
        `${git.remote}/${branch}`
      : branch;
  }

  async function createPrForBranch(
    head: string,
    {
      draft = false,
      base: baseOverride,
    }: { draft?: boolean; base?: string } = {},
  ): Promise<OpResult<CreatedPr>> {
    const existing = await github.findOpenPrByHead(head);

    if (existing) {
      return ok({
        number: existing.number,
        url: existing.url,
        alreadyExisted: true,
      });
    }

    const template = await getPrTemplate(head);

    if (!template.ok) return template;

    const { title, body } = template.value;
    const base = baseOverride ?? template.value.base;

    log(`Opening PR ${head} -> ${base}`);

    const created =
      hooks.createPr ?
        await hooks.createPr({ head, base, title, body, draft })
      : await github.createPr({ head, base, title, body, draft });

    openPrsCache = null;

    return ok({ ...created, alreadyExisted: false });
  }

  async function getPrTemplate(
    branch?: string,
  ): Promise<OpResult<PrTemplate & { base: string }>> {
    return attempt(async () => {
      let branchName = branch;

      if (branchName === undefined) {
        const current = await requireCurrentBranch();

        if (!current.ok) return current;

        branchName = current.value;
      }

      const parsed = parseBranch(branchName, config);

      if (!parsed) {
        return err({
          code: 'not-umbrella-branch',
          message: `"${branchName}" is not an umbrella or umbrella child branch`,
        });
      }

      if (parsed.kind === 'umbrella') {
        const template =
          (await hooks.generateUmbrellaPr?.({ branch: parsed })) ??
          umbrellaPrTemplate({ name: parsed.name });
        const currentBase = await getCurrentBase(parsed);

        return ok({ ...template, base: currentBase.base });
      }

      const parentPr = findParentPr(parsed, await getOpenPrs(), config);

      if (!parentPr.ok) return err(parentPr.error);

      const baseBranch = parentPr.value.headRefName;

      if (parsed.sync) {
        return ok({
          ...syncPrTemplate({ parentPr: parentPr.value }),
          base: baseBranch,
        });
      }

      const template =
        (await hooks.generateChildPr?.({
          branch: parsed,
          parentPr: parentPr.value,
          baseBranch,
        })) ??
        childPrTemplate({
          parentPr: parentPr.value,
          title: inferTitleFromName(parsed.name),
        });

      return ok({ ...template, base: baseBranch });
    });
  }

  async function createUmbrella({
    type: typeOption,
    name,
    openPr: shouldOpenPr = true,
    draft = false,
    on,
  }: {
    type?: string;
    name: string;
    openPr?: boolean;
    draft?: boolean;
    /**
     * Open branch the umbrella depends on: it's created from it and its PR
     * targets it until it's merged into the base
     */
    on?: string;
  }): Promise<
    OpResult<{
      branch: ParsedUmbrella;
      pr: CreatedPr | null;
      dependsOn: { branch: string; pr: number } | null;
    }>
  > {
    return attempt(async () => {
      const type = typeOption ?? config.defaultType;
      const base =
        Object.hasOwn(config.types, type) ? config.types[type] : undefined;

      if (base === undefined) {
        return err({
          code: 'unknown-type',
          message: `Unknown branch type "${type}"`,
          fix: `Use one of: ${Object.keys(config.types).join(', ')}`,
        });
      }

      const clean = await requireCleanWorktree();

      if (!clean.ok) return clean;

      await git.tryFetch('--prune');

      const validName = validateUmbrellaName({
        name,
        existingBranches: await listBranches(),
        config,
      });

      if (!validName.ok) {
        return err({
          code:
            validName.error.code === 'already-exists' ?
              'umbrella-exists'
            : 'invalid-name',
          message: validName.error.message,
          fix: validName.error.fix,
        });
      }

      let dependsOn: { branch: string; pr: number } | null = null;

      if (on !== undefined && on !== base) {
        if (!(await git.remoteBranchExists(on))) {
          return err({
            code: 'invalid-dependency',
            message: `Branch "${on}" was not found in ${git.remote}`,
            fix: `Push "${on}" and open its PR first`,
          });
        }

        const chain = getDependencyChain(on, base, await getOpenPrs());
        const dependency = chain.ok ? chain.chain[0] : undefined;

        if (!dependency) {
          return err({
            code: 'invalid-dependency',
            message:
              chain.ok || chain.reason === 'no-open-pr' ?
                `"${on}" must lead to "${base}": "${chain.ok ? on : chain.branch}" has no open PR`
              : `"${on}" must lead to "${base}", but its PR chain has a ${chain.reason === 'cycle' ? 'cycle' : 'depth over 10'} at "${chain.branch}"`,
            fix: `Open the PR of "${on}" targeting "${base}" (or another branch that leads to it)`,
          });
        }

        dependsOn = { branch: on, pr: dependency.number };
      }

      const fullName = formatUmbrellaBranch(
        { type, name: validName.value },
        config,
      );

      const startBranch = dependsOn?.branch ?? base;

      log(`Creating ${fullName} from ${startBranch}`);

      await git.checkoutUpdated(startBranch);
      await git.createBranch(fullName);
      await git.commitEmpty(`Create umbrella PR for ${validName.value}`);
      await git.push(fullName);

      const branch: ParsedUmbrella = {
        kind: 'umbrella',
        alias: false,
        type,
        base,
        name: validName.value,
        fullName,
      };

      if (!shouldOpenPr) return ok({ branch, pr: null, dependsOn });

      const pr = await createPrForBranch(fullName, {
        draft,
        base: startBranch,
      });

      if (!pr.ok) return pr;

      return ok({ branch, pr: pr.value, dependsOn });
    });
  }

  async function createChild({
    name,
    umbrella: umbrellaOption,
    from = 'umbrella',
  }: {
    name: string;
    umbrella?: string;
    from?: 'umbrella' | 'current';
  }): Promise<OpResult<{ branch: ParsedChild; umbrella: ParsedUmbrella }>> {
    return attempt(async () => {
      const umbrella = await findUmbrella(umbrellaOption, { fetch: true });

      if (!umbrella.ok) return umbrella;

      const validName = validateChildName({
        umbrella: umbrella.value.name,
        name,
        existingBranches: await listBranches(),
        config,
      });

      if (!validName.ok) {
        return err({
          code:
            validName.error.code === 'already-exists' ?
              'child-exists'
            : 'invalid-name',
          message: validName.error.message,
          fix: validName.error.fix,
        });
      }

      if (from === 'current') {
        const current = await requireCurrentBranch();

        if (!current.ok) return current;

        const parsedCurrent = parseBranch(current.value, config);
        const isInUmbrella =
          parsedCurrent !== null &&
          (parsedCurrent.kind === 'umbrella' ?
            parsedCurrent.name === umbrella.value.name
          : parsedCurrent.umbrella === umbrella.value.name);

        if (!isInUmbrella) {
          return err({
            code: 'from-current-not-in-umbrella',
            message: `Cannot create a child of "${umbrella.value.name}" from "${current.value}", as it is not part of the umbrella`,
            fix: 'Use `--from umbrella`, or checkout a branch of the umbrella',
          });
        }
      } else {
        await git.checkoutUpdated(umbrella.value.fullName);
      }

      const fullName = formatChildBranch(
        { umbrella: umbrella.value.name, name: validName.value },
        config,
      );

      log(`Creating ${fullName}`);

      await git.createBranch(fullName);

      const branch = parseBranch(fullName, config);

      if (branch?.kind !== 'child') {
        throw new Error(`Unexpected child branch name ${fullName}`);
      }

      return ok({ branch, umbrella: umbrella.value });
    });
  }

  async function createSync({
    umbrella: umbrellaOption,
    from,
    push = false,
    pr: shouldOpenPr = false,
  }: {
    umbrella?: string;
    /**
     * Branch to merge, defaults to the umbrella's current base. Other branches
     * than the current or configured base create a `sync-<label>` child
     */
    from?: string;
    /** Pushes the branch when the merge has no conflicts */
    push?: boolean;
    /** Opens the sync PR when the merge has no conflicts, implies `push` */
    pr?: boolean;
  } = {}): Promise<
    OpResult<{
      branch: string;
      umbrella: ParsedUmbrella;
      /** Merged branch */
      source: string;
      conflictedFiles: string[];
      pushed: boolean;
      pr: CreatedPr | null;
      retargeted: { from: string; to: string } | null;
      warnings: string[];
    }>
  > {
    return attempt(async () => {
      const clean = await requireCleanWorktree();

      if (!clean.ok) return clean;

      const umbrella = await findUmbrella(umbrellaOption, { fetch: true });

      if (!umbrella.ok) return umbrella;

      const currentBase = await getCurrentBase(umbrella.value);
      const retargeted = await retargetIfStale(currentBase);
      const source = from ?? currentBase.base;
      const existingBranches = await listBranches();
      const warnings: string[] = [];

      if (
        from !== undefined &&
        !(await git.refExists(await remoteOrLocal(from)))
      ) {
        return err({
          code: 'invalid-name',
          message: `Branch "${from}" not found`,
          fix: 'Check the `--from` branch name',
        });
      }

      const isBaseSync =
        source === currentBase.base || source === currentBase.rootBase;

      const branch =
        isBaseSync ?
          getNextSyncBranchName({
            umbrella: umbrella.value.name,
            existingBranches,
            config,
          })
        : getLabeledSyncBranchName(
            umbrella.value.name,
            source,
            existingBranches,
            config,
          );

      if (currentBase.dependsOn && source !== currentBase.dependsOn.branch) {
        warnings.push(
          `The umbrella PR targets "${currentBase.dependsOn.branch}" (#${currentBase.dependsOn.pr}), so its diff will show the "${source}" changes until "${currentBase.dependsOn.branch}" has them too. Prefer syncing "${currentBase.dependsOn.branch}" with its base first, then \`umbrella-prs create sync\` to sync the umbrella from it`,
        );
      }

      for (const warning of warnings) log(`warning: ${warning}`);

      log(`Creating ${branch} and merging ${source}`);

      await git.checkoutUpdated(umbrella.value.fullName);
      await git.createBranch(branch);

      const { conflictedFiles } = await git.mergeAllowingConflicts(
        await remoteOrLocal(source),
        `Merge branch '${source}' into ${branch}`,
      );

      const result = {
        branch,
        umbrella: umbrella.value,
        source,
        conflictedFiles,
        pushed: false,
        pr: null,
        retargeted,
        warnings,
      };

      if (conflictedFiles.length > 0 || (!push && !shouldOpenPr)) {
        return ok(result);
      }

      await git.push(branch);

      if (!shouldOpenPr) return ok({ ...result, pushed: true });

      const pr = await createPrForBranch(branch);

      if (!pr.ok) return pr;

      return ok({ ...result, pushed: true, pr: pr.value });
    });
  }

  async function convertToChild(
    options: { childName: string; branch?: string } & (
      | { umbrella: string; newUmbrella?: undefined }
      | {
          umbrella?: undefined;
          newUmbrella: { type?: string; name: string; openPr?: boolean };
        }
    ),
  ): Promise<
    OpResult<{
      branch: ParsedChild;
      umbrella: ParsedUmbrella;
      umbrellaPr: CreatedPr | null;
      conflictedFiles: string[];
    }>
  > {
    return attempt(async () => {
      const clean = await requireCleanWorktree();

      if (!clean.ok) return clean;

      let source = options.branch;

      if (source === undefined) {
        const current = await requireCurrentBranch();

        if (!current.ok) return current;

        source = current.value;
      }

      let umbrellaName: string;
      let umbrellaPr: CreatedPr | null = null;

      if (options.newUmbrella) {
        const created = await createUmbrella({
          type: options.newUmbrella.type,
          name: options.newUmbrella.name,
          openPr: options.newUmbrella.openPr,
        });

        if (!created.ok) return created;

        umbrellaName = created.value.branch.name;
        umbrellaPr = created.value.pr;
      } else {
        umbrellaName = getUmbrellaName(options.umbrella);
      }

      const child = await createChild({
        name: options.childName,
        umbrella: umbrellaName,
        from: 'umbrella',
      });

      if (!child.ok) return child;

      log(`Merging ${source} into ${child.value.branch.fullName}`);

      const { conflictedFiles } = await git.mergeAllowingConflicts(
        source,
        `Merge branch '${source}' into ${child.value.branch.fullName}`,
      );

      return ok({
        branch: child.value.branch,
        umbrella: child.value.umbrella,
        umbrellaPr,
        conflictedFiles,
      });
    });
  }

  async function syncWithParent({
    branch,
    strategy = 'auto',
    stash = false,
  }: {
    branch?: string;
    /** `auto` merges when the branch is published, otherwise rebases */
    strategy?: 'auto' | 'merge' | 'rebase';
    /** Stashes uncommitted changes before syncing and pops them after */
    stash?: boolean;
  } = {}): Promise<
    OpResult<{
      branch: string;
      parent: string;
      strategy: 'merge' | 'rebase';
      conflictedFiles: string[];
      /** `true` when the changes are still stashed because of conflicts */
      stashed: boolean;
      /** Set when the umbrella PR targeted a merged branch and was retargeted */
      retargeted: { from: string; to: string } | null;
    }>
  > {
    return attempt(async () => {
      const resolved = await resolveParent(branch);

      if (!resolved.ok) return resolved;

      const branchName = resolved.value.branch.fullName;
      const { parent } = resolved.value;

      const retargeted =
        resolved.value.branch.kind === 'umbrella' ?
          await retargetIfStale(await getCurrentBase(resolved.value.branch))
        : null;

      let stashed = false;

      if (await git.hasUncommittedChanges()) {
        if (!stash) {
          return err({
            code: 'dirty-worktree',
            message: 'There are uncommitted changes',
            fix: 'Commit the changes, or pass `--stash`',
          });
        }

        await git.stash(`umbrella-prs: before syncing ${branchName}`);
        stashed = true;
      }

      if ((await git.currentBranch()) !== branchName) {
        await git.checkoutUpdated(branchName);
      }

      await git.tryFetch(parent, branchName);

      const isPublished = await git.remoteBranchExists(branchName);
      const finalStrategy =
        strategy === 'auto' ?
          isPublished ? 'merge'
          : 'rebase'
        : strategy;
      const parentRef = await remoteOrLocal(parent);

      log(
        `${finalStrategy === 'merge' ? 'Merging' : 'Rebasing onto'} ${parent}`,
      );

      const { conflictedFiles } =
        finalStrategy === 'merge' ?
          await git.mergeAllowingConflicts(
            parentRef,
            `Merge branch '${parent}' into ${branchName}`,
          )
        : await git.rebaseAllowingConflicts(parentRef);

      if (conflictedFiles.length === 0 && stashed) {
        await git.stashPop();
        stashed = false;
      }

      return ok({
        branch: branchName,
        parent,
        strategy: finalStrategy,
        conflictedFiles,
        stashed,
        retargeted,
      });
    });
  }

  async function getTree({
    source = 'prs',
  }: { source?: 'prs' | 'branches' } = {}): Promise<OpResult<Tree>> {
    return attempt(async () => {
      const prs = await getOpenPrs();

      if (source === 'prs') {
        const tree = buildTree(prs, config);

        return ok({ umbrellas: tree.umbrellas, orphans: tree.orphans });
      }

      const prsByHead = new Map(prs.map((pr) => [pr.headRefName, pr]));
      const branches = await listBranches();
      const umbrellas: TreeNode[] = [];
      const umbrellaNames = new Set<string>();

      for (const branch of branches) {
        if (branch.kind !== 'umbrella') continue;

        const preferred = findUmbrellaBranch(branch.name, branches, config);

        if (preferred?.fullName !== branch.fullName) continue;

        umbrellaNames.add(branch.name);
        const pr = prsByHead.get(branch.fullName) ?? null;

        umbrellas.push({
          branch,
          pr,
          dependsOn:
            pr && pr.baseRefName !== branch.base ?
              {
                branch: pr.baseRefName,
                pr: prsByHead.get(pr.baseRefName)?.number ?? null,
              }
            : null,
          children: getChildrenOf(branch.name, branches, config).map(
            (child) => ({
              branch: child,
              pr: prsByHead.get(child.fullName) ?? null,
            }),
          ),
        });
      }

      const orphans: Tree['orphans'] = [];

      for (const branch of branches) {
        if (branch.kind === 'child' && !umbrellaNames.has(branch.umbrella)) {
          orphans.push({
            branch,
            pr: prsByHead.get(branch.fullName) ?? null,
          });
        }
      }

      return ok({ umbrellas, orphans });
    });
  }

  async function openPr({
    branch,
    draft = false,
  }: { branch?: string; draft?: boolean } = {}): Promise<OpResult<CreatedPr>> {
    return attempt(async () => {
      let branchName = branch;

      if (branchName === undefined) {
        const current = await requireCurrentBranch();

        if (!current.ok) return current;

        branchName = current.value;
      }

      await git.push(branchName);

      return createPrForBranch(branchName, { draft });
    });
  }

  /** Adds the umbrella PR link to the child PR description when it's missing */
  async function addParentLinkToChildPr({
    childPr,
    parentPr,
  }: {
    childPr: number;
    parentPr: number;
  }): Promise<OpResult<{ changed: boolean }>> {
    return attempt(async () => {
      const body = await github.getPrBody(childPr);
      const updated = addParentLinkToChildBody(body, parentPr);

      if (updated.changed) await github.editPrBody(childPr, updated.body);

      return ok({ changed: updated.changed });
    });
  }

  async function updateParentPrDescription({
    childPr,
    parentBranch,
  }: {
    childPr: number;
    parentBranch: string;
  }): Promise<OpResult<{ parentPr: number; changed: boolean }>> {
    return attempt(async () => {
      const parentPr = await github.findOpenPrByHead(parentBranch);

      if (!parentPr) {
        return err({
          code: 'parent-pr-not-found',
          message: `No open PR found for the umbrella branch ${parentBranch}`,
          fix: `Open the umbrella PR first: \`umbrella-prs pr create ${parentBranch}\``,
        });
      }

      const body = await github.getPrBody(parentPr.number);
      const updated = addChildToUmbrellaBody(body, childPr);

      if (updated.changed) {
        await github.editPrBody(parentPr.number, updated.body);
      }

      return ok({ parentPr: parentPr.number, changed: updated.changed });
    });
  }

  async function syncDiff(
    options: (
      | {
          mode: 'local';
          /** Sync child branch, defaults to the current branch */
          branch?: string;
        }
      | {
          mode: 'ci';
          /** Branch the PR targets */
          base: string;
          /** PR head commit, defaults to `HEAD^2` (HEAD is GitHub's merge commit), then `HEAD` */
          headCommit?: string;
        }
    ) & {
      /** Explicit merged branch, skips detecting it from the merge commits */
      right?: string;
      /** Explicit left branch in local mode, skips resolving the umbrella */
      left?: string;
      exclude?: string[];
    },
  ): Promise<OpResult<SyncDiffResult>> {
    return attempt(async () => {
      let mode: SyncDiffMode;
      let head: string;
      let left: string;

      if (options.mode === 'ci') {
        mode = 'ci';
        left = options.base;
        head = options.headCommit ?? (await git.secondParent('HEAD')) ?? 'HEAD';
      } else {
        mode = 'local';

        let branchName = options.branch;

        if (branchName === undefined) {
          const current = await requireCurrentBranch();

          if (!current.ok) return current;

          branchName = current.value;
        }

        await git.tryFetch();

        if (options.left !== undefined) {
          left = options.left;
        } else {
          const resolved = await resolveParent(branchName);

          if (!resolved.ok) return resolved;

          left = resolved.value.parent;
        }

        head =
          (await git.localBranchExists(branchName)) ? branchName
          : (await git.remoteBranchExists(branchName)) ?
            `${git.remote}/${branchName}`
            // any other ref, e.g. the head commit of a merged sync PR
          : branchName;
      }

      const result = await getSyncDiff({
        mode,
        head,
        left,
        right: options.right,
        exclude: [...config.diff.exclude, ...(options.exclude ?? [])],
        git,
        github,
      });

      if (!result.ok) {
        return err({
          code:
            result.error.code === 'merge-tree-failed' ?
              'git-failed'
            : result.error.code,
          message: result.error.message,
          fix: result.error.fix,
        });
      }

      return ok(result.value);
    });
  }

  async function postSyncDiffComment({
    prNumber,
    result,
  }: {
    prNumber: number;
    result: SyncDiffResult;
  }): Promise<OpResult<{ body: string }>> {
    return attempt(async () => {
      const body = renderSyncDiffComment(result, {
        maxChars: config.syncDiff.maxCommentChars,
      });

      await github.replaceMarkedComment(
        prNumber,
        config.syncDiff.commentMarker,
        body,
      );

      return ok({ body });
    });
  }

  async function childDiff({
    branch,
    include,
    exclude = [],
    ignoreImportOnly = false,
  }: {
    branch?: string;
    include?: string[];
    exclude?: string[];
    ignoreImportOnly?: boolean;
  } = {}): Promise<
    OpResult<{ diff: string; files: string[]; parent: string }>
  > {
    return attempt(async () => {
      const resolved = await resolveParent(branch);

      if (!resolved.ok) return resolved;

      const branchName = resolved.value.branch.fullName;
      const { parent } = resolved.value;

      await git.tryFetch();

      const diff = await getBranchDiff({
        git,
        parentRef: await remoteOrLocal(parent),
        branchRef:
          (await git.localBranchExists(branchName)) ?
            branchName
          : `${git.remote}/${branchName}`,
        include,
        exclude: [...config.diff.exclude, ...exclude],
        ignoreImportOnly,
      });

      return ok({ ...diff, parent });
    });
  }

  async function verify(input: VerifyInput): Promise<OpResult<VerifyResult>> {
    return attempt(async () =>
      ok(
        await verifyPr(input, {
          config,
          git,
          getOpenPrs,
          isBranchGone,
        }),
      ),
    );
  }

  async function autoApprove(
    input: AutoApproveInput & { prNumber: number; approve?: boolean },
  ): Promise<OpResult<AutoApproveEligibility & { approved: boolean }>> {
    return attempt(async () => {
      const eligibility = getAutoApproveEligibility(input, config);

      if (!eligibility.eligible || !input.approve) {
        return ok({ ...eligibility, approved: false });
      }

      await github.approvePr(
        input.prNumber,
        `Auto-approved: ${eligibility.reason}`,
      );

      return ok({ ...eligibility, approved: true });
    });
  }

  return {
    config,
    git,
    github,
    getOpenPrs,
    listBranches,
    findUmbrella,
    resolveParent,
    getCurrentBase,
    getPrTemplate,
    createUmbrella,
    createChild,
    createSync,
    convertToChild,
    syncWithParent,
    getTree,
    openPr,
    updateParentPrDescription,
    addParentLinkToChildPr,
    syncDiff,
    postSyncDiffComment,
    childDiff,
    verify,
    autoApprove,
    /** Pure helpers bound to this config */
    parseBranch: (branch: string) => parseBranch(branch, config),
    formatUmbrellaBranch: (branch: { type: string; name: string }) =>
      formatUmbrellaBranch(branch, config),
    formatChildBranch: (branch: { umbrella: string; name: string }) =>
      formatChildBranch(branch, config),
    buildTree: <T extends PrInfo>(prs: readonly T[]) => buildTree(prs, config),
  };
}

function getLabeledSyncBranchName(
  umbrella: string,
  source: string,
  existingBranches: ParsedBranch[],
  config: ResolvedConfig,
): string {
  const label = normalizeBranchSegment(source.replaceAll('/', '-'));
  const existing = new Set(
    existingBranches.flatMap((branch) =>
      branch.kind === 'child' && branch.umbrella === umbrella ?
        [branch.name]
      : [],
    ),
  );

  let name = `sync-${label}`;

  for (let attempt = 2; existing.has(name); attempt++) {
    name = `sync-${label}-${attempt}`;
  }

  return formatChildBranch({ umbrella, name }, config);
}
