import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EXIT, runCli } from '../src/cli/run';
import type { Prompter } from '../src/cli/prompts';
import { isRecord } from '../src/utils.typeGuards';
import { createTestRepo, lines, testConfig, type TestRepo } from './helpers';

let repo: TestRepo;

beforeEach(() => {
  repo = createTestRepo();

  // the config must exist in every base branch
  repo.git('checkout', '--quiet', 'master');
  writeFileSync(
    path.join(repo.dir, 'umbrella-prs.config.json'),
    JSON.stringify(testConfig),
  );
  repo.git('add', '-A');
  repo.git('commit', '--quiet', '-m', 'config');
  repo.git('push', '--quiet');
  repo.git('checkout', '--quiet', 'beta');
  repo.git('merge', '--quiet', '--no-edit', 'master');
  repo.git('push', '--quiet');
});

const stopServers: (() => Promise<number>)[] = [];

afterEach(async () => {
  for (const stop of stopServers.splice(0)) await stop();

  repo.cleanup();
});

async function cli(
  argv: string[],
  {
    isTTY = false,
    env = {},
    prompter,
    stdin = '',
  }: {
    isTTY?: boolean;
    env?: Record<string, string>;
    prompter?: Prompter;
    stdin?: string;
  } = {},
) {
  let stdout = '';
  let stderr = '';

  const exitCode = await runCli({
    argv,
    cwd: repo.dir,
    env,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    isTTY,
    exec: repo.exec,
    prompter,
    readStdin: () => Promise.resolve(stdin),
  });

  return { exitCode, stdout, stderr };
}

const viewerDataRegex =
  /<script type="application\/json" id="sync-diff-data">(.*?)<\/script>/s;

/** The data embedded in a viewer page */
function viewerData(file: string): Record<string, unknown> {
  const match = viewerDataRegex.exec(
    readFileSync(path.join(repo.dir, file), 'utf8'),
  );

  return parseJson(match?.[1] ?? '');
}

const viewerLiveRegex =
  /<script type="application\/json" id="viewer-live">(.*?)<\/script>/s;
const viewerUrlRegex = /http:\/\/localhost:\d+/;

/** Runs a command that serves a viewer, it is stopped after the test */
async function serve(argv: string[], { stdin = '' }: { stdin?: string } = {}) {
  const controller = new AbortController();
  let stderr = '';

  const exit = runCli({
    argv: [...argv, '--port', '0'],
    cwd: repo.dir,
    // the viewer state is saved next to the test repo
    env: { XDG_STATE_HOME: path.join(repo.dir, '..', 'state') },
    stdout: () => {},
    stderr: (text) => (stderr += text),
    isTTY: false,
    exec: repo.exec,
    signal: controller.signal,
    readStdin: () => Promise.resolve(stdin),
  });

  function stop() {
    controller.abort();

    return exit;
  }

  stopServers.push(stop);

  const url = await Promise.race([
    vi.waitFor(
      () => {
        const match = viewerUrlRegex.exec(stderr);

        if (!match) throw new Error('The viewer did not start');

        return match[0];
      },
      { timeout: 10_000 },
    ),
    exit.then(() => {
      throw new Error(`The command exited: ${stderr}`);
    }),
  ]);

  async function json(
    pathname: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(
      `${url}${pathname}`,
      body === undefined ?
        {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
    );

    return parseJson(await response.text());
  }

  return {
    url,
    stop,
    json,
    /** The data of the page, as the open pages get it when it changes */
    data: () => json('/data'),
    /** The state the server embeds in the page */
    live: async () => {
      const html = await (await fetch(url)).text();

      return parseJson(viewerLiveRegex.exec(html)?.[1] ?? '');
    },
  };
}

const untrackedDiffRegex =
  /\+uncommitted[\s\S]*\+\+\+ b\/src\/new file\.ts[\s\S]*\+untracked/;

/** The next message of a server-sent events response */
async function readEvent(
  reader: ReadableStreamDefaultReader<unknown> | undefined,
): Promise<string> {
  const chunk = await reader?.read();

  return chunk?.value instanceof Uint8Array ?
      new TextDecoder().decode(chunk.value)
    : '';
}

/** Status of a request made with the `Host` of another site */
function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request(url, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

function parseJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);

  if (!isRecord(value)) throw new Error('Expected an object');

  return value;
}

describe('cli', () => {
  test('creates an umbrella and a child with json output', async () => {
    const umbrella = await cli(['create', 'umbrella', 'billing', '--json']);

    expect(umbrella.exitCode).toBe(EXIT.ok);
    expect(parseJson(umbrella.stdout)).toMatchObject({
      ok: true,
      branch: { fullName: 'feature/umbrella/billing' },
      pr: { number: 101, alreadyExisted: false },
    });

    const child = await cli(['create', 'child', 'adjust-ui']);

    expect(child.exitCode).toBe(EXIT.ok);
    expect(child.stdout).toBe('Created child under/billing/adjust-ui\n');
  });

  test('missing args are a usage error when not interactive', async () => {
    const result = await cli(['create', 'umbrella', '--yes']);

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toBe('error: Missing <name>\nfix: Pass <name>\n');

    const json = await cli(['create', 'child', '--json']);

    expect(json.exitCode).toBe(EXIT.usage);
    expect(parseJson(json.stdout)).toEqual({
      ok: false,
      error: {
        code: 'usage',
        message: 'The current branch "beta" is not part of an umbrella',
        fix: 'Pass --umbrella <name>',
      },
    });
  });

  test('prompts for missing args when interactive', async () => {
    const prompter: Prompter = {
      text: () => Promise.resolve('from-prompt'),
      select: (_message, options) => {
        const option = options.find((item) => item.value === 'prod-feature');

        if (!option) throw new Error('missing option');

        return Promise.resolve(option.value);
      },
      confirm: () => Promise.resolve(true),
    };

    const result = await cli(['create', 'umbrella'], { isTTY: true, prompter });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(repo.git('branch', '--show-current')).toBe(
      'prod-feature/umbrella/from-prompt',
    );
  });

  test('rejects unknown flags and commands', async () => {
    expect((await cli(['create', 'child', 'x', '--nope'])).exitCode).toBe(
      EXIT.usage,
    );
    expect((await cli(['nope'])).exitCode).toBe(EXIT.usage);
    expect(
      (await cli(['create', 'umbrella', 'x', '--type', 'nope'])).exitCode,
    ).toBe(EXIT.usage);
  });

  test('exits 3 when create sync has conflicts', async () => {
    await cli(['create', 'umbrella', 'billing']);
    repo.commit('umbrella change', { 'app.ts': lines(10, { 2: 'umbrella' }) });
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', 'beta');
    repo.commit('beta change', { 'app.ts': lines(10, { 2: 'beta' }) });
    repo.git('push', '--quiet');

    const result = await cli([
      'create',
      'sync',
      '--umbrella',
      'billing',
      '--pr',
      '--json',
    ]);

    expect(result.exitCode).toBe(EXIT.conflicts);
    expect(parseJson(result.stdout)).toMatchObject({
      ok: false,
      exitCode: EXIT.conflicts,
      branch: 'under/billing/sync',
      conflictedFiles: ['app.ts'],
      hasConflicts: true,
    });
  });

  test('diff sync writes the html viewer', async () => {
    await cli(['create', 'umbrella', 'billing']);
    repo.commit('umbrella change', { 'app.ts': lines(10, { 2: 'umbrella' }) });
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', 'beta');
    repo.commit('beta change', { 'app.ts': lines(10, { 2: 'beta' }) });
    repo.git('push', '--quiet');
    await cli(['create', 'sync', '--umbrella', 'billing']);
    repo.write('app.ts', lines(10, { 2: 'umbrella' }));
    repo.git('add', 'app.ts');
    repo.git('commit', '--quiet', '--no-edit');
    repo.git('push', '--quiet', '-u', 'origin', 'under/billing/sync');

    const result = await cli([
      'diff',
      'sync',
      '--out',
      'viewer.html',
      '--json',
    ]);

    expect(result.exitCode).toBe(EXIT.ok);

    const output = parseJson(result.stdout);

    expect(output.file).toBe(path.join(repo.dir, 'viewer.html'));
    expect(readFileSync(path.join(repo.dir, 'viewer.html'), 'utf8')).toContain(
      'parsePatchFiles',
    );
  });

  test('diff pr shows the open PR of the current branch, also outside umbrellas', async () => {
    repo.git('checkout', '--quiet', '-b', 'fix-typo', 'master');
    repo.commit('fix typo', { 'app.ts': lines(10, { 2: 'fixed' }) });
    repo.git('push', '--quiet', '-u', 'origin', 'fix-typo');
    const pr = repo.addPr({ headRefName: 'fix-typo', baseRefName: 'master' });

    // changes of the base after the branch point are not part of the PR
    repo.git('checkout', '--quiet', 'master');
    repo.commit('master change', { 'other.ts': 'other\n' });
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', 'fix-typo');

    const result = await cli(['diff', 'pr', '--out', 'viewer.html', '--json']);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(parseJson(result.stdout)).toMatchObject({
      pr: pr.number,
      base: 'master',
      head: 'fix-typo',
      files: ['app.ts'],
      file: path.join(repo.dir, 'viewer.html'),
    });
    expect(viewerData('viewer.html')).toMatchObject({
      kind: 'patch',
      head: `pr:${pr.number}`,
      sections: [{ rightLabel: `#${pr.number} master...fix-typo` }],
    });

    repo.git('checkout', '--quiet', 'master');

    // nothing is served when the diff is printed
    const printed = await cli(['diff', 'pr', String(pr.number), '--print']);

    expect(printed.exitCode).toBe(EXIT.ok);
    expect(printed.stdout).toContain('+fixed');

    const written = await cli([
      'diff',
      'pr',
      String(pr.number),
      '--out',
      'out/pr.diff',
    ]);

    expect(written.stdout).toContain('diff written to');
    expect(readFileSync(path.join(repo.dir, 'out/pr.diff'), 'utf8')).toBe(
      printed.stdout.slice(0, -1),
    );

    const byNumber = await cli(['diff', 'pr', `#${pr.number}`, '--json']);

    expect(parseJson(byNumber.stdout)).toMatchObject({
      pr: pr.number,
      files: ['app.ts'],
    });
  });

  test('diff pr serves the diff of the working tree and follows it', async () => {
    repo.git('checkout', '--quiet', '-b', 'fix-typo', 'master');
    repo.commit('fix typo', { 'app.ts': lines(10, { 2: 'fixed' }) });
    repo.git('push', '--quiet', '-u', 'origin', 'fix-typo');
    const pr = repo.addPr({ headRefName: 'fix-typo', baseRefName: 'master' });

    const viewer = await serve(['diff', 'pr']);
    const first = await viewer.data();

    expect(first).toMatchObject({
      title: `Diff #${pr.number} master...fix-typo`,
      subtitle: `<code>#${pr.number} master...fix-typo</code> following the working tree`,
      data: {
        kind: 'patch',
        head: `pr:${pr.number}`,
        github: { pr: pr.number, unpushed: [] },
        sections: [{ diff: expect.stringContaining('+fixed') }],
      },
    });
    expect(await viewer.live()).toMatchObject({
      revision: first.revision,
      shell: first.shell,
    });

    // open pages are told about the changes
    const events = await fetch(`${viewer.url}/events`);
    const reader = events.body?.getReader();

    expect(await readEvent(reader)).toBe(
      `data: ${JSON.stringify({ revision: first.revision })}\n\n`,
    );

    // uncommitted changes and untracked files are part of the diff
    repo.write('app.ts', lines(10, { 2: 'fixed', 5: 'uncommitted' }));
    repo.write('src/new file.ts', 'untracked\n');
    repo.write('node_modules/dep/index.js', 'ignored\n');
    repo.write('.gitignore', 'node_modules\n');

    await vi.waitFor(
      async () => {
        expect(await viewer.data()).toMatchObject({
          shell: first.shell,
          data: {
            github: { unpushed: ['app.ts', '.gitignore', 'src/new file.ts'] },
            sections: [
              {
                diff: expect.stringMatching(untrackedDiffRegex),
              },
            ],
          },
        });
      },
      { timeout: 10_000 },
    );

    const updated = await viewer.data();

    expect(updated.revision).not.toBe(first.revision);
    expect(await readEvent(reader)).toContain('data: ');

    await reader?.cancel();

    // another branch is checked out: the local branch, without the working tree
    repo.git('stash', '--quiet', '--include-untracked');
    repo.git('checkout', '--quiet', 'master');

    await vi.waitFor(
      async () => {
        const data = await viewer.data();

        expect(data.subtitle).toBe(
          `<code>#${pr.number} master...fix-typo</code> following the local branch`,
        );
        expect(data).toMatchObject({
          data: {
            github: { unpushed: [] },
            sections: [{ diff: expect.not.stringContaining('untracked') }],
          },
        });
      },
      { timeout: 10_000 },
    );

    expect(await viewer.stop()).toBe(EXIT.ok);
  });

  test('the served viewer saves its state and syncs the viewed files with GitHub', async () => {
    repo.git('checkout', '--quiet', '-b', 'fix-typo', 'master');
    repo.commit('fix typo', {
      'app.ts': lines(10, { 2: 'fixed' }),
      'a.ts': 'a\n',
      'b.ts': 'b\n',
    });
    repo.git('push', '--quiet', '-u', 'origin', 'fix-typo');
    const pr = repo.addPr({ headRefName: 'fix-typo', baseRefName: 'master' });
    repo.viewedFiles[pr.number] = { 'a.ts': 'VIEWED', 'b.ts': 'DISMISSED' };

    const viewer = await serve(['diff', 'pr']);
    const viewedKey = `umbrella-prs:diff-viewed-files:pr:${pr.number}`;

    expect(await viewer.live()).toMatchObject({ storage: {} });

    await viewer.json('/storage', {
      entries: {
        'umbrella-prs:sync-diff-theme': 'pierre-dark',
        [viewedKey]: { 'app.ts': { sync: 'abc' } },
        'umbrella-prs:diff-viewed-files:pr:999': { 'other.ts': {} },
      },
    });

    // only the state of this diff and the preferences
    expect((await viewer.live()).storage).toEqual({
      'umbrella-prs:sync-diff-theme': 'pierre-dark',
      [viewedKey]: { 'app.ts': { sync: 'abc' } },
    });

    expect(await viewer.json('/github/viewed')).toEqual({
      files: { 'a.ts': 'VIEWED', 'app.ts': 'UNVIEWED', 'b.ts': 'DISMISSED' },
    });

    await viewer.json('/github/viewed', {
      paths: ['app.ts', 'b.ts'],
      viewed: true,
    });
    await viewer.json('/github/viewed', { paths: ['a.ts'], viewed: false });

    expect(repo.viewedFiles[pr.number]).toEqual({
      'a.ts': 'UNVIEWED',
      'app.ts': 'VIEWED',
      'b.ts': 'VIEWED',
    });

    // only the viewer page itself can read the diff or change the state
    expect(await statusWithHost(`${viewer.url}/data`, 'other.example')).toBe(
      403,
    );

    const formPost = await fetch(`${viewer.url}/storage`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        entries: { 'umbrella-prs:sync-diff-theme': 'x' },
      }),
    });

    expect(formPost.status).toBe(404);
  });

  test('diff sync serves the sync diff and follows the branch', async () => {
    await cli(['create', 'umbrella', 'billing']);
    repo.commit('umbrella change', { 'app.ts': lines(10, { 2: 'umbrella' }) });
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', 'beta');
    repo.commit('beta change', { 'app.ts': lines(10, { 2: 'beta' }) });
    repo.git('push', '--quiet');
    await cli(['create', 'sync', '--umbrella', 'billing']);
    repo.write('app.ts', lines(10, { 2: 'umbrella' }));
    repo.git('add', 'app.ts');
    repo.git('commit', '--quiet', '--no-edit');

    const viewer = await serve(['diff', 'sync']);
    const first = await viewer.data();

    expect(first).toMatchObject({
      data: { kind: 'sync', github: null, head: repo.git('rev-parse', 'HEAD') },
    });

    const head = repo.commit('manual edit', {
      'app.ts': lines(10, { 2: 'umbrella', 8: 'edited' }),
    });

    await vi.waitFor(
      async () => {
        expect(await viewer.data()).toMatchObject({
          shell: first.shell,
          data: {
            head,
            sections: [{ diff: expect.stringContaining('+edited') }],
          },
        });
      },
      { timeout: 10_000 },
    );
  });

  test('diff view serves the file and follows it', async () => {
    const patch = (text: string) =>
      [
        '--- a/app.ts',
        '+++ b/app.ts',
        '@@ -1 +1 @@',
        '-old',
        `+${text}`,
        '',
      ].join('\n');

    writeFileSync(path.join(repo.dir, 'changes.diff'), patch('first'));

    const viewer = await serve(['diff', 'view', 'changes.diff']);

    expect(await viewer.data()).toMatchObject({
      data: { kind: 'patch', sections: [{ diff: patch('first') }] },
    });

    writeFileSync(path.join(repo.dir, 'changes.diff'), patch('second'));

    await vi.waitFor(
      async () => {
        expect(await viewer.data()).toMatchObject({
          data: { sections: [{ diff: patch('second') }] },
        });
      },
      { timeout: 10_000 },
    );

    // stdin can't change, but is served too
    const stdin = await serve(['diff', 'view', '-'], { stdin: patch('stdin') });

    expect(await stdin.data()).toMatchObject({
      data: { head: 'stdin', sections: [{ diff: patch('stdin') }] },
    });

    const port = new URL(viewer.url).port;
    const samePort = await cli([
      'diff',
      'view',
      'changes.diff',
      '--port',
      port,
    ]);

    expect(samePort.exitCode).toBe(EXIT.failed);
    expect(samePort.stderr).toContain(`error: Port ${port} is in use`);

    // a file is written instead of serving with --out
    const written = await cli([
      'diff',
      'view',
      'changes.diff',
      '--out',
      'v.html',
    ]);

    expect(written.stdout).toContain('Diff viewer written to');
    expect(readFileSync(path.join(repo.dir, 'v.html'), 'utf8')).not.toContain(
      'id="viewer-live"',
    );
  });

  test('diff pr fails when the branch has no open PR', async () => {
    const result = await cli(['diff', 'pr']);

    expect(result.exitCode).toBe(EXIT.precondition);
    expect(result.stderr).toContain('No open PR found for the branch beta');
  });

  test('diff view opens a format-patch series with a section per commit', async () => {
    repo.commit('first change', { 'app.ts': lines(10, { 2: 'first' }) });
    repo.commit('second change', { 'other.ts': 'other\n' });
    writeFileSync(
      path.join(repo.dir, 'changes.patch'),
      repo.git('format-patch', '-2', '--stdout'),
    );

    const result = await cli([
      'diff',
      'view',
      'changes.patch',
      '--out',
      'viewer.html',
      '--json',
    ]);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(parseJson(result.stdout).file).toBe(
      path.join(repo.dir, 'viewer.html'),
    );
    expect(viewerData('viewer.html')).toMatchObject({
      kind: 'patch',
      head: path.join(repo.dir, 'changes.patch'),
      sections: [
        { rightLabel: 'first change', conflictedFiles: [] },
        { rightLabel: 'second change', conflictedFiles: [] },
      ],
    });
  });

  test('diff view reads a diff from stdin', async () => {
    const diff = [
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -1 +1 @@',
      '-import { a } from "./a";',
      '+import { b } from "./b";',
      '',
    ].join('\n');

    const result = await cli(
      ['diff', 'view', '-', '--out', 'viewer.html', '--json'],
      { stdin: diff },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(viewerData('viewer.html')).toMatchObject({
      kind: 'patch',
      head: 'stdin',
      sections: [{ rightLabel: 'stdin', diff }],
    });
  });

  test('diff view rejects files that are not diffs', async () => {
    writeFileSync(path.join(repo.dir, 'notes.txt'), 'just notes\n');

    const result = await cli(['diff', 'view', 'notes.txt']);

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('notes.txt is not a diff');
  });

  test('exits 5 on a dirty worktree with the fix', async () => {
    repo.write('README.md', 'dirty\n');

    const result = await cli(['create', 'umbrella', 'billing']);

    expect(result.exitCode).toBe(EXIT.precondition);
    expect(result.stderr).toContain('fix: Commit or stash the changes first');
  });

  test('exits 4 without a config', async () => {
    repo.git('rm', '--quiet', 'umbrella-prs.config.json');
    repo.git('commit', '--quiet', '-m', 'remove config');

    const result = await cli(['parse', 'feature/x']);

    expect(result.exitCode).toBe(EXIT.config);
    expect(result.stderr).toContain('No umbrella-prs.config.json found');
  });

  test('diff pr works in repos without a config', async () => {
    repo.git('checkout', '--quiet', 'master');
    repo.git('rm', '--quiet', 'umbrella-prs.config.json');
    repo.git('commit', '--quiet', '-m', 'remove config');
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', '-b', 'fix-typo');
    repo.commit('fix typo', { 'app.ts': lines(10, { 2: 'fixed' }) });
    repo.git('push', '--quiet', '-u', 'origin', 'fix-typo');
    const pr = repo.addPr({ headRefName: 'fix-typo', baseRefName: 'master' });

    const printed = await cli(['diff', 'pr', pr.url, '--print']);

    expect(printed.exitCode).toBe(EXIT.ok);
    expect(printed.stdout).toContain('+fixed');

    const viewer = await serve(['diff', 'pr']);

    expect(await viewer.data()).toMatchObject({
      data: { github: { pr: pr.number } },
    });

    // an invalid config is still an error
    repo.write('umbrella-prs.config.json', '{ "types": {} }');

    const invalid = await cli(['diff', 'pr', '--print']);

    expect(invalid.exitCode).toBe(EXIT.config);
    expect(invalid.stderr).toContain('Invalid config');
  });

  test('parse reports branches outside the workflow without failing', async () => {
    const outside = await cli(['parse', 'feature/x', '--json']);

    expect(outside.exitCode).toBe(EXIT.ok);
    expect(parseJson(outside.stdout)).toMatchObject({
      branch: null,
      error: null,
    });

    const invalid = await cli(['parse', 'chore/umbrella/x', '--json']);

    expect(invalid.exitCode).toBe(EXIT.failed);

    const child = await cli(['parse', 'stack/billing/sync-2', '--json']);

    expect(parseJson(child.stdout)).toMatchObject({
      branch: { kind: 'child', alias: true, sync: { index: 2 } },
    });
  });

  test('find-umbrella accepts a bare name', async () => {
    await cli(['create', 'umbrella', 'billing', '--type', 'prod-feature']);

    const result = await cli(['find-umbrella', 'billing', '--json']);

    expect(parseJson(result.stdout)).toMatchObject({
      umbrella: { fullName: 'prod-feature/umbrella/billing', base: 'master' },
    });
  });

  test('ci run links a child PR and reads the inputs from env', async () => {
    await cli(['create', 'umbrella', 'billing']);
    await cli(['create', 'child', 'a']);

    const child = repo.addPr({
      headRefName: 'under/billing/a',
      baseRefName: 'feature/umbrella/billing',
      body: 'Motivation',
    });

    const result = await cli(['ci', 'run', '--json'], {
      env: {
        HEAD_REF: 'under/billing/a',
        BASE_REF: 'feature/umbrella/billing',
        PR: String(child.number),
      },
    });

    expect(result.exitCode).toBe(EXIT.ok);
    expect(parseJson(result.stdout)).toMatchObject({
      verify: { kind: 'child', errors: [] },
      updateParent: { parentPr: 101, parentChanged: true, childChanged: true },
    });
    expect(repo.prs[0]?.body).toContain(`- #${child.number}`);
    expect(child.body).toBe('## Parent PR\n\n- #101\n\nMotivation');
  });

  test('ci verify exits 1 with the errors', async () => {
    await cli(['create', 'umbrella', 'billing']);

    const result = await cli([
      'ci',
      'verify',
      '--head',
      'under/billing/a',
      '--base',
      'beta',
      '--pr',
      '7',
    ]);

    expect(result.exitCode).toBe(EXIT.failed);
    expect(result.stdout).toContain(
      'error: Child branch "under/billing/a" must target',
    );
    expect(result.stdout).toContain(
      'fix: Change the PR base: `gh pr edit 7 --base feature/umbrella/billing`',
    );
  });

  test('ci run is a no-op outside the workflow', async () => {
    const result = await cli([
      'ci',
      'run',
      '--head',
      'feature/x',
      '--base',
      'beta',
      '--pr',
      '3',
    ]);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toBe('Not an umbrella workflow PR, nothing to do\n');
  });

  test('ci auto-approve approves base syncs', async () => {
    const result = await cli([
      'ci',
      'auto-approve',
      '--head',
      'under/billing/sync',
      '--base',
      'feature/umbrella/billing',
      '--author',
      'someone',
      '--pr',
      '9',
      '--approve',
    ]);

    expect(result.stdout).toBe('Approved: Base sync child PR\n');
    expect(repo.approvals).toEqual([9]);
  });

  test('shows help', async () => {
    const result = await cli(['--help']);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain('create umbrella <name>');

    const command = await cli(['create', 'sync', '--help']);

    expect(command.stdout).toContain('--from <value>');
  });
});
