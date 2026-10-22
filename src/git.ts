import { CommandError, formatCommand, type Exec } from './exec';

export type Git = ReturnType<typeof createGit>;

export function createGit({
  exec,
  cwd,
  remote,
}: {
  exec: Exec;
  cwd: string | undefined;
  remote: string;
}) {
  async function run(args: string[], input?: string) {
    return exec('git', args, { cwd, input });
  }

  async function runOk(args: string[]): Promise<string> {
    const result = await run(args);

    if (result.code !== 0) {
      throw new CommandError(formatCommand('git', args), result);
    }

    return result.stdout;
  }

  async function refExists(ref: string) {
    const result = await run([
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]);

    return result.code === 0;
  }

  async function localBranchExists(branch: string) {
    return refExists(`refs/heads/${branch}`);
  }

  async function remoteBranchExists(branch: string) {
    return refExists(`refs/remotes/${remote}/${branch}`);
  }

  async function getConflictedFiles() {
    const out = await runOk(['diff', '--name-only', '--diff-filter=U']);

    return splitLines(out);
  }

  return {
    remote,
    run,
    runOk,
    refExists,
    localBranchExists,
    remoteBranchExists,

    /** Asks the remote, so it's accurate without fetching */
    async remoteHasBranch(branch: string): Promise<boolean> {
      const result = await run([
        'ls-remote',
        '--exit-code',
        '--heads',
        remote,
        `refs/heads/${branch}`,
      ]);

      return result.code === 0;
    },

    async version(): Promise<[number, number] | null> {
      const result = await run(['--version']);
      const match = /(\d+)\.(\d+)/.exec(result.stdout);

      if (!match) return null;

      return [Number(match[1]), Number(match[2])];
    },

    async currentBranch(): Promise<string | null> {
      const result = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);

      if (result.code !== 0) return null;

      return result.stdout.trim() || null;
    },

    async fetch(...refs: string[]) {
      await runOk(['fetch', '--quiet', remote, ...refs]);
    },

    async tryFetch(...refs: string[]) {
      const result = await run(['fetch', '--quiet', remote, ...refs]);

      return result.code === 0;
    },

    /** Local and remote branches, without the remote prefix and deduped */
    async listBranches(): Promise<string[]> {
      const out = await runOk([
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
        `refs/remotes/${remote}`,
      ]);

      const branches = new Set<string>();
      const remotePrefix = `refs/remotes/${remote}/`;

      for (const ref of splitLines(out)) {
        if (ref.startsWith('refs/heads/')) {
          branches.add(ref.slice('refs/heads/'.length));
        } else if (ref.startsWith(remotePrefix)) {
          const branch = ref.slice(remotePrefix.length);

          if (branch !== 'HEAD') branches.add(branch);
        }
      }

      return [...branches];
    },

    async hasUncommittedChanges() {
      const out = await runOk(['status', '--porcelain', '--untracked-files=no']);

      return out.trim().length > 0;
    },

    async isMergeInProgress() {
      return refExists('MERGE_HEAD');
    },

    /**
     * Checks out the branch, creating it from the remote when it only exists
     * there, and fast-forwards it to the remote
     */
    async checkoutUpdated(branch: string) {
      const hasLocal = await localBranchExists(branch);
      const hasRemote = await remoteBranchExists(branch);

      if (!hasLocal && hasRemote) {
        await runOk([
          'checkout',
          '--quiet',
          '-b',
          branch,
          '--track',
          `${remote}/${branch}`,
        ]);
        return;
      }

      await runOk(['checkout', '--quiet', branch]);

      if (hasRemote) {
        await run(['merge', '--ff-only', '--quiet', `${remote}/${branch}`]);
      }
    },

    async checkout(branch: string) {
      await runOk(['checkout', '--quiet', branch]);
    },

    async createBranch(branch: string, startPoint?: string) {
      await runOk([
        'checkout',
        '--quiet',
        '-b',
        branch,
        ...(startPoint ? [startPoint] : []),
      ]);
    },

    async commitEmpty(message: string) {
      await runOk(['commit', '--quiet', '--allow-empty', '-m', message]);
    },

    async push(branch: string) {
      await runOk(['push', '--quiet', '-u', remote, branch]);
    },

    /** Leaves the merge in progress when there are conflicts */
    async mergeAllowingConflicts(
      ref: string,
      message: string,
    ): Promise<{ conflictedFiles: string[] }> {
      const args = ['merge', '--no-ff', '--no-edit', '-m', message, ref];
      const result = await run(args);

      if (result.code === 0) return { conflictedFiles: [] };

      const conflictedFiles = await getConflictedFiles();

      if (conflictedFiles.length === 0) {
        throw new CommandError(formatCommand('git', args), result);
      }

      return { conflictedFiles };
    },

    /** Leaves the rebase in progress when there are conflicts */
    async rebaseAllowingConflicts(
      ref: string,
    ): Promise<{ conflictedFiles: string[] }> {
      const args = ['rebase', ref];
      const result = await run(args);

      if (result.code === 0) return { conflictedFiles: [] };

      const conflictedFiles = await getConflictedFiles();

      if (conflictedFiles.length === 0) {
        throw new CommandError(formatCommand('git', args), result);
      }

      return { conflictedFiles };
    },

    async stash(message: string) {
      await runOk(['stash', 'push', '--quiet', '-m', message]);
    },

    async stashPop() {
      await runOk(['stash', 'pop', '--quiet']);
    },

    async revParse(ref: string) {
      return (await runOk(['rev-parse', ref])).trim();
    },

    /** `null` when the commit has no second parent */
    async secondParent(ref: string) {
      const result = await run(['rev-parse', '--verify', '--quiet', `${ref}^2`]);

      return result.code === 0 ? result.stdout.trim() : null;
    },

    async commitExists(sha: string) {
      const result = await run(['cat-file', '-e', `${sha}^{commit}`]);

      return result.code === 0;
    },

    async mergeBase(a: string, b: string) {
      const result = await run(['merge-base', a, b]);

      return result.code === 0 ? result.stdout.trim() || null : null;
    },
  };
}

export function splitLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
