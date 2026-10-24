import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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

afterEach(() => {
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
      '--html',
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
