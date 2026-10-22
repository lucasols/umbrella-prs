import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createTestRepo,
  createTestUmbrella,
  lines,
  testConfig,
  type TestRepo,
} from './helpers';

const shaRegex = /[\da-f]{40}/;

let repo: TestRepo;

beforeEach(() => {
  repo = createTestRepo();
});

afterEach(() => {
  repo.cleanup();
});

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);

  return result.value;
}

async function setupUmbrella(name = 'billing') {
  const u = createTestUmbrella(repo);
  const created = unwrap(await u.createUmbrella({ name }));

  return { u, created };
}

describe('createUmbrella', () => {
  test('creates the branch from the base with an empty commit, pushes it and opens the PR', async () => {
    repo.commit('beta change', { 'beta.ts': 'beta\n' });
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', 'master');

    const { created } = await setupUmbrella('New Billing');

    expect(created.branch.fullName).toBe('feature/umbrella/new-billing');
    expect(repo.git('branch', '--show-current')).toBe(
      'feature/umbrella/new-billing',
    );
    expect(repo.git('log', '-1', '--format=%s')).toBe(
      'Create umbrella PR for new-billing',
    );
    expect(repo.git('diff', 'beta', 'HEAD')).toBe('');
    expect(repo.git('rev-parse', 'origin/feature/umbrella/new-billing')).toBe(
      repo.git('rev-parse', 'HEAD'),
    );

    expect(repo.prs).toMatchObject([
      {
        headRefName: 'feature/umbrella/new-billing',
        baseRefName: 'beta',
        title: 'New billing',
      },
    ]);
    expect(repo.prs[0]?.body).toContain('## Children PRs');
  });

  test('creates umbrella, child and sync branches with custom branch names', async () => {
    const u = createTestUmbrella(repo, {
      ...testConfig,
      aliases: [],
      branchNames: { umbrella: 'stacked', child: 'stack' },
    });

    const created = unwrap(await u.createUmbrella({ name: 'billing' }));

    expect(created.branch.fullName).toBe('feature/stacked/billing');

    const child = unwrap(await u.createChild({ name: 'adjust-ui' }));

    expect(child.branch.fullName).toBe('stack/billing/adjust-ui');

    repo.git('checkout', '--quiet', 'beta');
    repo.commit('beta change', { 'beta.ts': 'beta\n' });
    repo.git('push', '--quiet');

    const sync = unwrap(await u.createSync({ umbrella: 'billing' }));

    expect(sync.branch).toBe('stack/billing/sync');
  });

  test('fails when the umbrella already exists with an alias', async () => {
    repo.git('checkout', '--quiet', '-b', 'feature/stacked/billing');
    repo.git('push', '--quiet', '-u', 'origin', 'feature/stacked/billing');

    const u = createTestUmbrella(repo);

    expect(await u.createUmbrella({ name: 'billing' })).toMatchObject({
      ok: false,
      error: { code: 'umbrella-exists' },
    });
  });

  test('creates a dependent umbrella on another open branch', async () => {
    const { u } = await setupUmbrella('a');

    repo.commit('a change', { 'a.ts': 'a\n' });
    repo.git('push', '--quiet');

    const b = unwrap(
      await u.createUmbrella({ name: 'b', on: 'feature/umbrella/a' }),
    );

    expect(b.dependsOn).toEqual({ branch: 'feature/umbrella/a', pr: 101 });
    expect(repo.prs[1]).toMatchObject({
      headRefName: 'feature/umbrella/b',
      baseRefName: 'feature/umbrella/a',
    });
    expect(repo.git('show', 'HEAD~1:a.ts')).toBe('a');

    expect(
      await u.createUmbrella({ name: 'c', on: 'feature/no-pr' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-dependency' },
    });
  });
});

describe('children', () => {
  test('creates children with the configured names, also for alias umbrellas', async () => {
    repo.git('checkout', '--quiet', '-b', 'feature/stacked/legacy');
    repo.commit('Create stacked PR');
    repo.git('push', '--quiet', '-u', 'origin', 'feature/stacked/legacy');
    repo.git('checkout', '--quiet', 'beta');

    const u = createTestUmbrella(repo);
    const child = unwrap(
      await u.createChild({ name: 'adjust-ui', umbrella: 'legacy' }),
    );

    expect(child.branch.fullName).toBe('under/legacy/adjust-ui');
    expect(repo.git('rev-parse', 'HEAD')).toBe(
      repo.git('rev-parse', 'feature/stacked/legacy'),
    );

    expect(await u.createChild({ name: 'adjust-ui' })).toMatchObject({
      ok: false,
      error: { code: 'child-exists' },
    });

    repo.git('checkout', '--quiet', 'beta');

    expect(
      await u.createChild({ name: 'x', umbrella: 'legacy', from: 'current' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'from-current-not-in-umbrella' },
    });

    expect(await u.createChild({ name: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not-umbrella-branch' },
    });
  });

  test('converts a branch into a child', async () => {
    repo.git('checkout', '--quiet', '-b', 'feature/my-work');
    repo.commit('work', { 'work.ts': 'work\n' });

    const u = createTestUmbrella(repo);
    const result = unwrap(
      await u.convertToChild({
        childName: 'my-work',
        newUmbrella: { name: 'billing' },
      }),
    );

    expect(result.branch.fullName).toBe('under/billing/my-work');
    expect(result.umbrellaPr).toMatchObject({ number: 101 });
    expect(repo.git('show', 'HEAD:work.ts')).toBe('work');
    expect(repo.git('rev-parse', 'HEAD^1')).toBe(
      repo.git('rev-parse', 'feature/umbrella/billing'),
    );
  });
});

describe('syncs', () => {
  test('creates the next sync, merges the base and opens the PR', async () => {
    const { u } = await setupUmbrella();

    repo.git('push', '--quiet', 'origin', 'HEAD:refs/heads/stack/billing/sync');
    repo.git('checkout', '--quiet', 'beta');
    repo.commit('beta change', { 'beta.ts': 'beta\n' });
    repo.git('push', '--quiet');

    const sync = unwrap(await u.createSync({ umbrella: 'billing', pr: true }));

    expect(sync).toMatchObject({
      branch: 'under/billing/sync-2',
      source: 'beta',
      conflictedFiles: [],
      pushed: true,
      pr: { number: 102 },
    });
    expect(repo.git('log', '-1', '--format=%s')).toBe(
      "Merge branch 'beta' into under/billing/sync-2",
    );
    expect(repo.prs[1]).toMatchObject({
      baseRefName: 'feature/umbrella/billing',
      title: 'Billing - Sync with base',
    });
    expect(repo.prs[1]?.body).toContain('- #101');
  });

  test('leaves the merge in progress on conflicts', async () => {
    const { u } = await setupUmbrella();

    repo.commit('umbrella change', { 'app.ts': lines(10, { 5: 'umbrella' }) });
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', 'beta');
    repo.commit('beta change', { 'app.ts': lines(10, { 5: 'beta' }) });
    repo.git('push', '--quiet');

    const sync = unwrap(await u.createSync({ umbrella: 'billing', pr: true }));

    expect(sync).toMatchObject({
      branch: 'under/billing/sync',
      conflictedFiles: ['app.ts'],
      pushed: false,
      pr: null,
    });
    expect(repo.git('rev-parse', '--verify', 'MERGE_HEAD')).toBeTruthy();
  });

  test('syncs from another branch as a labeled sync', async () => {
    const { u } = await setupUmbrella();

    repo.git('checkout', '--quiet', '-b', 'feature/other', 'beta');
    repo.commit('other', { 'other.ts': 'other\n' });
    repo.git('push', '--quiet', '-u', 'origin', 'feature/other');

    const sync = unwrap(
      await u.createSync({ umbrella: 'billing', from: 'feature/other' }),
    );

    expect(sync.branch).toBe('under/billing/sync-feature-other');
  });

  test('syncs a dependent umbrella from the branch it depends on, and warns when syncing from the root base', async () => {
    const { u } = await setupUmbrella('a');

    unwrap(await u.createUmbrella({ name: 'b', on: 'feature/umbrella/a' }));

    repo.git('checkout', '--quiet', 'feature/umbrella/a');
    repo.commit('a change', { 'a.ts': 'a\n' });
    repo.git('push', '--quiet');

    const fromA = unwrap(await u.createSync({ umbrella: 'b' }));

    expect(fromA).toMatchObject({
      branch: 'under/b/sync',
      source: 'feature/umbrella/a',
      warnings: [],
    });

    repo.git('checkout', '--quiet', 'feature/umbrella/b');

    const fromBeta = unwrap(
      await u.createSync({ umbrella: 'b', from: 'beta' }),
    );

    expect(fromBeta.branch).toBe('under/b/sync-2');
    expect(fromBeta.warnings).toHaveLength(1);
  });

  test('retargets a dependent umbrella whose base was merged', async () => {
    const { u } = await setupUmbrella('a');

    unwrap(await u.createUmbrella({ name: 'b', on: 'feature/umbrella/a' }));

    const prA = repo.prs[0];

    if (!prA) throw new Error('missing PR');

    prA.state = 'merged';
    repo.git('push', '--quiet', 'origin', '--delete', 'feature/umbrella/a');

    const synced = unwrap(
      await u.syncWithParent({ branch: 'feature/umbrella/b' }),
    );

    expect(synced).toMatchObject({
      parent: 'beta',
      retargeted: { from: 'feature/umbrella/a', to: 'beta' },
    });
    expect(repo.prs[1]?.baseRefName).toBe('beta');
  });
});

describe('sync diff', () => {
  async function createConflictedSync() {
    const { u } = await setupUmbrella();

    repo.commit('umbrella change', { 'app.ts': lines(10, { 5: 'umbrella' }) });
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', 'beta');
    repo.commit('beta change', { 'app.ts': lines(10, { 5: 'beta' }) });
    repo.git('push', '--quiet');

    unwrap(await u.createSync({ umbrella: 'billing' }));

    // resolves the conflict keeping one side, which a combined diff would hide
    repo.write('app.ts', lines(10, { 5: 'umbrella' }));
    repo.git('add', 'app.ts');
    repo.git('commit', '--quiet', '--no-edit');
    repo.commit('manual edit', { 'README.md': 'edited\n' });
    repo.git('push', '--quiet', '-u', 'origin', 'under/billing/sync');

    return u;
  }

  test('shows conflict resolutions and manual edits locally', async () => {
    const u = await createConflictedSync();
    const result = unwrap(await u.syncDiff({ mode: 'local' }));

    expect(result.strategy).toBe('combined');
    expect(result.sections).toHaveLength(1);

    const [section] = result.sections;

    expect(section).toMatchObject({
      leftLabel: 'feature/umbrella/billing',
      rightLabel: 'beta',
      conflictedFiles: ['app.ts'],
    });
    expect(section?.diff).toContain('-<<<<<<< feature/umbrella/billing');
    expect(section?.diff).toContain('->>>>>>> beta');
    expect(section?.diff).toContain('+edited');
    expect(section?.diff).not.toMatch(shaRegex);
  });

  test('uses HEAD^2 and the compare API in CI mode', async () => {
    await createConflictedSync();

    // GitHub checks out a merge of the PR head into the base
    repo.git(
      'checkout',
      '--quiet',
      '--detach',
      'origin/feature/umbrella/billing',
    );
    repo.git(
      'merge',
      '--quiet',
      '--no-ff',
      '--no-edit',
      'origin/under/billing/sync',
    );

    const u = createTestUmbrella(repo);
    const result = unwrap(
      await u.syncDiff({ mode: 'ci', base: 'feature/umbrella/billing' }),
    );

    expect(result.head).toBe(
      repo.git('rev-parse', 'origin/under/billing/sync'),
    );
    expect(result.sections[0]?.mergeBase).toBeTruthy();
    expect(result.sections[0]?.conflictedFiles).toEqual(['app.ts']);
    expect(result.sections[0]?.diff).toContain('+edited');

    const posted = unwrap(
      await u.postSyncDiffComment({ prNumber: 102, result }),
    );

    expect(posted.body).toContain('## Sync diff');
    expect(repo.comments).toHaveLength(1);

    unwrap(await u.postSyncDiffComment({ prNumber: 102, result }));

    expect(repo.comments).toHaveLength(1);
  });

  test('accepts an explicit right branch', async () => {
    await createConflictedSync();

    const u = createTestUmbrella(repo);
    const result = unwrap(await u.syncDiff({ mode: 'local', right: 'beta' }));

    expect(result.sections[0]?.rightLabel).toBe('beta');
    expect(result.sections[0]?.conflictedFiles).toEqual(['app.ts']);
  });

  test('shows one section per merge when the PR merged more than one branch', async () => {
    const { u } = await setupUmbrella();

    repo.git('checkout', '--quiet', '-b', 'feature/one', 'beta');
    repo.commit('one', { 'one.ts': 'one\n' });
    repo.git('checkout', '--quiet', '-b', 'feature/two', 'beta');
    repo.commit('two', { 'two.ts': 'two\n' });
    repo.git(
      'checkout',
      '--quiet',
      '-b',
      'under/billing/sync-many',
      'feature/umbrella/billing',
    );
    repo.git('merge', '--quiet', '--no-ff', '--no-edit', 'feature/one');
    repo.git('merge', '--quiet', '--no-ff', '--no-edit', 'feature/two');

    const result = unwrap(await u.syncDiff({ mode: 'local' }));

    expect(result.strategy).toBe('per-merge');
    expect(result.sections.map((section) => section.rightLabel)).toEqual([
      'feature/one',
      'feature/two',
    ]);
    expect(result.sections.every((section) => section.diff === '')).toBe(true);
  });

  test('does not mistake PR merges of the base history for sync merges', async () => {
    const { u } = await setupUmbrella();

    repo.git('checkout', '--quiet', '-b', 'feature/merged-pr', 'beta');
    repo.commit('pr work', { 'pr.ts': 'pr\n' });
    repo.git('checkout', '--quiet', 'beta');
    repo.git(
      'merge',
      '--quiet',
      '--no-ff',
      '-m',
      'Merge pull request #5 from acme/feature/merged-pr',
      'feature/merged-pr',
    );

    // created from the newer base instead of the umbrella
    repo.git('checkout', '--quiet', '-b', 'under/billing/sync');
    repo.commit('wrong start');

    expect(await u.syncDiff({ mode: 'local' })).toMatchObject({
      ok: false,
      error: { code: 'no-merges-found' },
    });
  });

  test('ignores merges of the umbrella itself', async () => {
    const u = await createConflictedSync();

    repo.git('checkout', '--quiet', 'feature/umbrella/billing');
    repo.commit('umbrella moved', { 'umbrella.ts': 'u\n' });
    repo.git('push', '--quiet');
    repo.git('checkout', '--quiet', 'under/billing/sync');
    repo.git(
      'merge',
      '--quiet',
      '--no-ff',
      '--no-edit',
      'feature/umbrella/billing',
    );
    repo.git('push', '--quiet');

    const result = unwrap(await u.syncDiff({ mode: 'local' }));

    expect(result.strategy).toBe('combined');
    expect(result.sections[0]?.rightLabel).toBe('beta');
  });
});

describe('child diff', () => {
  test('diffs a child against its umbrella with excludes', async () => {
    const { u } = await setupUmbrella();

    unwrap(await u.createChild({ name: 'work' }));
    repo.commit('work', {
      'src/a.ts': 'a\n',
      'pnpm-lock.yaml': 'lock\n',
      'locales/pt.json': '{}\n',
    });

    const result = unwrap(await u.childDiff({ exclude: ['**/pt.json'] }));

    expect(result.parent).toBe('feature/umbrella/billing');
    expect(result.files).toEqual(['src/a.ts']);
  });
});

describe('verify', () => {
  test('checks child bases and finds the parent PR', async () => {
    const { u } = await setupUmbrella();

    expect(
      unwrap(
        await u.verify({ head: 'under/billing/a', base: 'beta', prNumber: 5 }),
      ),
    ).toMatchObject({
      kind: 'child',
      errors: [
        {
          code: 'child-base-not-umbrella',
          fix: 'Change the PR base: `gh pr edit 5 --base feature/umbrella/billing`',
        },
      ],
    });

    expect(
      unwrap(
        await u.verify({
          head: 'under/billing/a',
          base: 'feature/stacked/other',
        }),
      ),
    ).toMatchObject({ errors: [{ code: 'child-base-mismatch' }] });

    expect(
      unwrap(
        await u.verify({
          head: 'under/billing/sync-2',
          base: 'feature/stacked/billing',
        }),
      ),
    ).toMatchObject({ kind: 'sync', errors: [], parentPr: { number: 101 } });

    expect(
      unwrap(
        await u.verify({ head: 'feature/x', base: 'feature/umbrella/billing' }),
      ),
    ).toMatchObject({ errors: [{ code: 'head-not-child' }] });

    expect(
      unwrap(await u.verify({ head: 'feature/x', base: 'beta' })),
    ).toMatchObject({
      kind: null,
      errors: [],
    });

    expect(
      unwrap(await u.verify({ head: 'chore/umbrella/x', base: 'beta' })),
    ).toMatchObject({
      errors: [{ code: 'invalid-branch-name' }],
    });
  });

  test('flags umbrellas created with unreviewed commits', async () => {
    await setupUmbrella();

    repo.git('checkout', '--quiet', '-b', 'feature/umbrella/dirty', 'beta');
    repo.commit('not empty', { 'x.ts': 'x\n' });
    repo.git('push', '--quiet', '-u', 'origin', 'feature/umbrella/dirty');

    const u = createTestUmbrella(repo);

    expect(
      unwrap(await u.verify({ head: 'feature/umbrella/dirty', base: 'beta' })),
    ).toMatchObject({ errors: [{ code: 'umbrella-unreviewed-commits' }] });

    expect(
      unwrap(
        await u.verify({ head: 'feature/umbrella/billing', base: 'beta' }),
      ),
    ).toMatchObject({ kind: 'umbrella', errors: [] });

    expect(
      unwrap(
        await u.verify({ head: 'feature/umbrella/billing', base: 'master' }),
      ),
    ).toMatchObject({ errors: [{ code: 'umbrella-base-mismatch' }] });
  });

  test('accepts dependent umbrellas with a warning and flags merged bases', async () => {
    const { u } = await setupUmbrella('a');

    repo.commit('a change', { 'a.ts': 'a\n' });
    repo.git('push', '--quiet');

    unwrap(await u.createUmbrella({ name: 'b', on: 'feature/umbrella/a' }));

    const result = unwrap(
      await u.verify({
        head: 'feature/umbrella/b',
        base: 'feature/umbrella/a',
      }),
    );

    expect(result).toMatchObject({
      kind: 'umbrella',
      errors: [],
      dependsOn: { branch: 'feature/umbrella/a', pr: 101 },
      warnings: [{ code: 'umbrella-depends-on-open-pr' }],
    });

    const prA = repo.prs[0];

    if (!prA) throw new Error('missing PR');

    prA.state = 'merged';

    const fresh = createTestUmbrella(repo);

    expect(
      unwrap(
        await fresh.verify({
          head: 'feature/umbrella/b',
          base: 'feature/umbrella/a',
        }),
      ),
    ).toMatchObject({ errors: [{ code: 'umbrella-base-merged' }] });
  });
});

describe('PR linking', () => {
  test('links the child in the umbrella PR and the umbrella in the child PR', async () => {
    const { u } = await setupUmbrella();
    const child = repo.addPr({
      headRefName: 'under/billing/a',
      baseRefName: 'feature/umbrella/billing',
      body: '## PR motivations\n\nStuff',
    });

    unwrap(
      await u.updateParentPrDescription({
        childPr: child.number,
        parentBranch: 'feature/umbrella/billing',
      }),
    );
    unwrap(
      await u.addParentLinkToChildPr({ childPr: child.number, parentPr: 101 }),
    );

    expect(repo.prs[0]?.body).toContain(`- #${child.number}`);
    expect(child.body).toBe(
      '## Parent PR\n\n- #101\n\n## PR motivations\n\nStuff',
    );

    expect(
      unwrap(
        await u.addParentLinkToChildPr({
          childPr: child.number,
          parentPr: 101,
        }),
      ),
    ).toEqual({ changed: false });
  });
});
