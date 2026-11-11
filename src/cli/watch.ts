import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { Git } from '../git';

const pollIntervalMs = 2000;

function isInside(dir: string, target: string) {
  const relative = path.relative(dir, target);

  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

/** Git writes that move branches: commits, checkouts, fetches and pushes */
function isRefChange(relative: string) {
  if (relative.endsWith('.lock')) return false;

  const [first] = relative.split(path.sep);

  return first === 'HEAD' || first === 'packed-refs' || first === 'refs';
}

/**
 * Calls `onChange`, debounced, when the files in `roots` change. `isRelevant`
 * gets the absolute path of the changed file. Polls when the platform can't
 * watch folders recursively
 */
export function watchPaths({
  roots,
  recursive = true,
  isRelevant = () => true,
  onChange,
  debounceMs = 150,
}: {
  roots: readonly string[];
  /** `false` only watches the files directly in `roots` */
  recursive?: boolean;
  isRelevant?: (filePath: string) => boolean;
  onChange: () => void;
  debounceMs?: number;
}): { close: () => void } {
  const watchers: FSWatcher[] = [];
  let debounce: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;

  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(onChange, debounceMs);
  }

  try {
    for (const root of roots) {
      const watcher = watch(root, { recursive }, (_event, filename) => {
        if (filename === null || isRelevant(path.join(root, filename))) {
          schedule();
        }
      });

      // e.g. a watched folder that was removed, the other roots keep working
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    }
  } catch {
    for (const watcher of watchers) watcher.close();

    poll = setInterval(onChange, pollIntervalMs);
  }

  return {
    close() {
      clearTimeout(debounce);
      clearInterval(poll);

      for (const watcher of watchers) watcher.close();
    },
  };
}

/**
 * Calls `onChange` when the repo changes: branches that move, and with
 * `worktree` also the files of the working tree. Writes that can't change a
 * diff are ignored, like the git index and objects or `node_modules`
 */
export async function watchRepo({
  git,
  worktree,
  onChange,
}: {
  git: Git;
  /** Also watches the files of the working tree */
  worktree: boolean;
  onChange: () => void;
}): Promise<{ close: () => void }> {
  const [root = '', gitDir = '', commonDir = ''] = (
    await git.runOk([
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
    ])
  )
    .split('\n')
    .map((line) => line.trim());

  // the git dir of a worktree is outside of it, and its branches are in the
  // common dir
  const gitDirs = [...new Set([gitDir, commonDir])];
  const roots = worktree ? [root] : [];

  for (const dir of gitDirs) {
    if (!roots.some((watched) => watched === dir || isInside(watched, dir))) {
      roots.push(dir);
    }
  }

  return watchPaths({
    roots,
    onChange,
    isRelevant: (filePath) => {
      for (const dir of gitDirs) {
        if (isInside(dir, filePath)) {
          return isRefChange(path.relative(dir, filePath));
        }
      }

      return (
        worktree &&
        !path.relative(root, filePath).split(path.sep).includes('node_modules')
      );
    },
  });
}
