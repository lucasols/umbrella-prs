import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UmbrellaConfig } from '../src/config';
import { defaultExec, type Exec, type ExecResult } from '../src/exec';
import { createUmbrellaPrs } from '../src/umbrella';

const versionRegex = /(\d+)\.(\d+)/;
const shaRegex = /^[\da-f]{40}$/;
const compareEndpointRegex = /compare\/(.+)\.\.\.(.+)\?per_page=1$/;
const issueCommentsEndpointRegex = /issues\/(\d+)\/comments$/;
const commentEndpointRegex = /issues\/comments\/(\d+)$/;

export const testConfig: UmbrellaConfig = {
  types: { feature: 'beta', 'prod-feature': 'master' },
  aliases: [{ umbrella: 'stacked', child: 'stack' }],
  repo: 'acme/app',
  autoApprove: { users: ['lucasols'] },
  diff: { exclude: ['pnpm-lock.yaml'] },
};

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** First git >= 2.40 found, so the CI mode (`merge-tree --merge-base`) can be tested */
export const gitBin = findGit();

function findGit() {
  for (const candidate of ['git', '/usr/bin/git', '/opt/homebrew/bin/git']) {
    try {
      const out = execFileSync(candidate, ['--version'], { encoding: 'utf8' });
      const match = versionRegex.exec(out);

      if (match && (Number(match[1]) > 2 || Number(match[2]) >= 40)) {
        return candidate;
      }
    } catch {
      // not installed
    }
  }

  return 'git';
}

export type FakePr = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
  isDraft: boolean;
  body: string;
  state: 'open' | 'merged' | 'closed';
};

export type TestRepo = {
  dir: string;
  remoteDir: string;
  git: (...args: string[]) => string;
  write: (file: string, content: string) => void;
  commit: (message: string, files?: Record<string, string>) => string;
  prs: FakePr[];
  comments: { id: number; pr: number; body: string }[];
  approvals: number[];
  addPr: (
    pr: Partial<FakePr> & { headRefName: string; baseRefName: string },
  ) => FakePr;
  exec: Exec;
  /** Commands run by the lib */
  calls: string[][];
  cleanup: () => void;
};

export function createTestRepo(): TestRepo {
  const root = mkdtempSync(path.join(tmpdir(), 'umbrella-prs-'));
  const remoteDir = path.join(root, 'remote.git');
  const dir = path.join(root, 'work');

  mkdirSync(dir);

  function runGit(cwd: string, args: string[]) {
    return execFileSync(gitBin, args, {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  runGit(root, [
    'init',
    '--quiet',
    '--bare',
    '--initial-branch=master',
    remoteDir,
  ]);
  runGit(dir, ['init', '--quiet', '--initial-branch=master']);
  runGit(dir, ['config', 'user.name', 'Test']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'commit.gpgsign', 'false']);
  runGit(dir, ['remote', 'add', 'origin', remoteDir]);

  const git = (...args: string[]) => runGit(dir, args).trim();

  function write(file: string, content: string) {
    const filePath = path.join(dir, file);

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  function commit(message: string, files: Record<string, string> = {}) {
    for (const [file, content] of Object.entries(files)) write(file, content);

    git('add', '-A');
    git('commit', '--quiet', '--allow-empty', '-m', message);

    return git('rev-parse', 'HEAD');
  }

  commit('initial', { 'app.ts': lines(10), 'README.md': 'readme\n' });
  git('push', '--quiet', '-u', 'origin', 'master');
  git('checkout', '--quiet', '-b', 'beta');
  git('push', '--quiet', '-u', 'origin', 'beta');

  const prs: FakePr[] = [];
  const comments: { id: number; pr: number; body: string }[] = [];
  const approvals: number[] = [];
  const calls: string[][] = [];
  let nextComment = 1;

  function addPr(
    pr: Partial<FakePr> & { headRefName: string; baseRefName: string },
  ) {
    const number = 100 + prs.length + 1;
    const created: FakePr = {
      number,
      title: `PR ${pr.headRefName}`,
      url: `https://github.com/acme/app/pull/${number}`,
      author: { login: 'someone' },
      isDraft: false,
      body: '',
      state: 'open',
      ...pr,
    };

    prs.push(created);

    return created;
  }

  function ok(stdout: string): ExecResult {
    return { code: 0, stdout, stderr: '' };
  }

  function fail(stderr: string): ExecResult {
    return { code: 1, stdout: '', stderr };
  }

  function getFlag(args: readonly string[], flag: string) {
    const index = args.indexOf(flag);

    return index === -1 ? undefined : args[index + 1];
  }

  function resolveRemoteRef(ref: string) {
    if (shaRegex.test(ref)) return ref;

    return runGit(remoteDir, ['rev-parse', ref]).trim();
  }

  function fakeGh(
    args: readonly string[],
    input: string | undefined,
  ): ExecResult {
    const [cmd, sub] = args;

    if (cmd === 'repo' && sub === 'view') return ok('acme/app\n');

    if (cmd === 'pr' && sub === 'list') {
      const state = getFlag(args, '--state') ?? 'open';
      const head = getFlag(args, '--head');

      return ok(
        JSON.stringify(
          prs
            .filter((pr) => pr.state === state)
            .filter((pr) => head === undefined || pr.headRefName === head)
            .map(({ body: _body, state: _state, ...pr }) => pr),
        ),
      );
    }

    const prNumber = Number(sub === undefined ? NaN : args[2]);
    const pr = prs.find((item) => item.number === prNumber);

    if (cmd === 'pr' && sub === 'view') {
      return pr ? ok(`${pr.body}\n`) : fail('not found');
    }

    if (cmd === 'pr' && sub === 'edit') {
      if (!pr) return fail('not found');

      const base = getFlag(args, '--base');

      if (base !== undefined) pr.baseRefName = base;
      if (args.includes('--body-file')) pr.body = input ?? '';

      return ok('');
    }

    if (cmd === 'pr' && sub === 'create') {
      const head = getFlag(args, '--head') ?? '';
      const base = getFlag(args, '--base') ?? '';

      if (
        prs.some((item) => item.state === 'open' && item.headRefName === head)
      ) {
        return fail('a pull request already exists');
      }

      const created = addPr({
        headRefName: head,
        baseRefName: base,
        title: getFlag(args, '--title') ?? '',
        body: input ?? '',
        isDraft: args.includes('--draft'),
      });

      return ok(`${created.url}\n`);
    }

    if (cmd === 'pr' && sub === 'comment') {
      comments.push({ id: nextComment++, pr: prNumber, body: input ?? '' });
      return ok('');
    }

    if (cmd === 'pr' && sub === 'review') {
      approvals.push(prNumber);
      return ok('');
    }

    if (cmd === 'api') {
      const method = getFlag(args, '--method');
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';

      const compare = compareEndpointRegex.exec(endpoint);

      if (compare?.[1] && compare[2]) {
        const a = resolveRemoteRef(decodeURIComponent(compare[1]));
        const b = resolveRemoteRef(decodeURIComponent(compare[2]));

        return ok(`${runGit(remoteDir, ['merge-base', a, b]).trim()}\n`);
      }

      const issueComments = issueCommentsEndpointRegex.exec(endpoint);

      if (issueComments?.[1]) {
        const number = Number(issueComments[1]);

        return ok(
          comments
            .filter((comment) => comment.pr === number)
            .map(({ id, body }) => JSON.stringify({ id, body }))
            .join('\n'),
        );
      }

      const deleteComment = commentEndpointRegex.exec(endpoint);

      if (method === 'DELETE' && deleteComment?.[1]) {
        const id = Number(deleteComment[1]);
        const index = comments.findIndex((comment) => comment.id === id);

        if (index !== -1) comments.splice(index, 1);

        return ok('');
      }
    }

    return fail(`fake gh: unsupported command: gh ${args.join(' ')}`);
  }

  const exec: Exec = async (cmd, args, options) => {
    calls.push([cmd, ...args]);

    if (cmd === 'gh') return fakeGh(args, options?.input);

    return defaultExec(cmd === 'git' ? gitBin : cmd, args, {
      ...options,
      cwd: options?.cwd ?? dir,
    });
  };

  return {
    dir,
    remoteDir,
    git,
    write,
    commit,
    prs,
    comments,
    approvals,
    addPr,
    exec,
    calls,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function createTestUmbrella(repo: TestRepo, config = testConfig) {
  return createUmbrellaPrs({ config, cwd: repo.dir, exec: repo.exec });
}

/** `line 1\nline 2\n...` with optional replacements by line number */
export function lines(count: number, replace: Record<number, string> = {}) {
  return `${Array.from({ length: count }, (_, i) => replace[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;
}
