import { describe, expect, test } from 'vitest';
import { getAutoApproveEligibility } from '../src/autoApprove';
import { removeImportOnlyChanges } from '../src/childDiff';
import { parseConfig, resolveConfig } from '../src/config';
import { getDependencyChain, resolveCurrentBase } from '../src/dependency';
import {
  findUmbrellaBranch,
  formatChildBranch,
  formatSyncBranch,
  getChildrenOf,
  getNextSyncBranchName,
  normalizeBranchSegment,
  parseBranch,
  parseBranchStrict,
  validateChildName,
  validateUmbrellaName,
} from '../src/naming';
import {
  addChildToUmbrellaBody,
  addParentLinkToChildBody,
  bodyLinksPr,
  findParentPr,
  umbrellaPrTemplate,
} from '../src/prTemplates';
import { parseMergedBranch } from '../src/syncDiff';
import { buildTree } from '../src/tree';

const resolvedConfig = resolveConfig({
  types: {
    feature: 'beta',
    bug: 'beta',
    'prod-feature': 'master',
    hotfix: 'master',
  },
  autoApprove: { users: ['lucasols'] },
});

if (!resolvedConfig.ok) throw new Error(resolvedConfig.error.message);

const config = resolvedConfig.value;

function pr(number: number, headRefName: string, baseRefName = 'beta') {
  return { number, title: `PR ${number}`, headRefName, baseRefName };
}

describe('parseBranch', () => {
  test('parses both formats of umbrellas and children', () => {
    expect(parseBranch('feature/umbrella/billing', config)).toEqual({
      kind: 'umbrella',
      format: 'umbrella',
      type: 'feature',
      base: 'beta',
      name: 'billing',
      fullName: 'feature/umbrella/billing',
    });

    expect(parseBranch('hotfix/stacked/billing', config)).toMatchObject({
      kind: 'umbrella',
      format: 'legacy',
      base: 'master',
    });

    expect(parseBranch('under/billing/adjust-ui', config)).toEqual({
      kind: 'child',
      format: 'umbrella',
      umbrella: 'billing',
      name: 'adjust-ui',
      sync: null,
      fullName: 'under/billing/adjust-ui',
    });

    expect(parseBranch('stack/billing/adjust-ui', config)).toMatchObject({
      kind: 'child',
      format: 'legacy',
      umbrella: 'billing',
    });
  });

  test('detects base and labeled syncs', () => {
    expect(parseBranch('under/x/sync', config)).toMatchObject({
      sync: { index: 1, label: null },
    });
    expect(parseBranch('stack/x/sync-3', config)).toMatchObject({
      sync: { index: 3, label: null },
    });
    expect(
      parseBranch('stack/x/sync-remove-legacy-blocks', config),
    ).toMatchObject({
      sync: { index: null, label: 'remove-legacy-blocks' },
    });
    expect(parseBranch('under/x/synchronize', config)).toMatchObject({
      sync: null,
    });
  });

  test('returns null for branches outside the workflow', () => {
    expect(parseBranch('feature/billing', config)).toBeNull();
    expect(parseBranch('beta', config)).toBeNull();
    expect(parseBranch('deploy-stack-in-beta/x', config)).toBeNull();
  });

  test('explains invalid workflow branches', () => {
    expect(parseBranchStrict('chore/umbrella/x', config)).toMatchObject({
      ok: false,
      error: { code: 'unknown-type' },
    });
    expect(parseBranchStrict('under/x', config)).toMatchObject({
      ok: false,
      error: { code: 'invalid-segments' },
    });
    expect(parseBranchStrict('feature/umbrella/x/y', config)).toMatchObject({
      ok: false,
      error: { code: 'invalid-segments' },
    });
    expect(parseBranchStrict('feature/x', config)).toMatchObject({
      ok: false,
      error: { code: 'not-umbrella-workflow' },
    });
  });

  test('does not match inherited object keys as types', () => {
    expect(parseBranch('constructor/umbrella/x', config)).toBeNull();
  });
});

describe('naming helpers', () => {
  const branches = [
    'feature/stacked/billing',
    'stack/billing/sync',
    'under/billing/sync-2',
    'stack/billing/sync-big-refactor',
    'stack/billing/adjust-ui',
    'under/billing/new-api',
    'under/other/sync-7',
  ];

  test('formats new branches in the umbrella format by default', () => {
    expect(formatChildBranch({ umbrella: 'x', name: 'y' })).toBe('under/x/y');
    expect(
      formatChildBranch({ umbrella: 'x', name: 'y', format: 'legacy' }),
    ).toBe('stack/x/y');
    expect(formatSyncBranch({ umbrella: 'x', index: 1 })).toBe('under/x/sync');
    expect(formatSyncBranch({ umbrella: 'x', index: 4 })).toBe(
      'under/x/sync-4',
    );
  });

  test('next sync index uses the numeric syncs of both formats', () => {
    expect(
      getNextSyncBranchName({
        umbrella: 'billing',
        existingBranches: branches,
        config,
      }),
    ).toBe('under/billing/sync-3');

    expect(
      getNextSyncBranchName({
        umbrella: 'new',
        existingBranches: branches,
        config,
      }),
    ).toBe('under/new/sync');
  });

  test('lists children of both formats', () => {
    expect(
      getChildrenOf('billing', branches, config).map((child) => child.fullName),
    ).toEqual([
      'stack/billing/sync',
      'under/billing/sync-2',
      'stack/billing/sync-big-refactor',
      'stack/billing/adjust-ui',
      'under/billing/new-api',
    ]);
  });

  test('finds the umbrella across formats, preferring the new one', () => {
    expect(findUmbrellaBranch('billing', branches, config)?.fullName).toBe(
      'feature/stacked/billing',
    );
    expect(
      findUmbrellaBranch(
        'billing',
        [...branches, 'feature/umbrella/billing'],
        config,
      )?.fullName,
    ).toBe('feature/umbrella/billing');
  });

  test('validates child names across formats', () => {
    expect(
      validateChildName({
        umbrella: 'billing',
        name: 'Adjust UI',
        existingBranches: branches,
        config,
      }),
    ).toMatchObject({ ok: false, error: { code: 'already-exists' } });

    expect(
      validateChildName({
        umbrella: 'billing',
        name: 'sync-4',
        existingBranches: branches,
        config,
      }),
    ).toMatchObject({ ok: false, error: { code: 'reserved-name' } });

    expect(
      validateChildName({
        umbrella: 'billing',
        name: 'New Thing!',
        existingBranches: branches,
        config,
      }),
    ).toEqual({ ok: true, value: 'new-thing-' });

    expect(
      validateChildName({
        umbrella: 'billing',
        name: ' - ',
        existingBranches: branches,
        config,
      }),
    ).toMatchObject({ ok: false, error: { code: 'empty-name' } });
  });

  test('validates umbrella names across formats and types', () => {
    expect(
      validateUmbrellaName({
        name: 'billing',
        existingBranches: branches,
        config,
      }),
    ).toMatchObject({ ok: false, error: { code: 'already-exists' } });
    expect(
      validateUmbrellaName({
        name: 'Plans',
        existingBranches: branches,
        config,
      }),
    ).toEqual({ ok: true, value: 'plans' });
  });

  test('normalizes segments', () => {
    expect(normalizeBranchSegment(' My Feature/x ')).toBe('my-feature-x');
  });
});

describe('PR helpers', () => {
  test('adds children to the Children PRs section', () => {
    const { body } = umbrellaPrTemplate({ name: 'billing' });

    const first = addChildToUmbrellaBody(body, 12);
    const second = addChildToUmbrellaBody(first.body, 13);

    expect(second.body).toMatchInlineSnapshot(`
      "## PR motivations

      Billing

      ## Children PRs

      <!-- The PRs references will be automatically added here -->
      - #12
      - #13

      ## Check list

      - [ ] Feature is tested
        <!-- Add the general feature tests here if needed -->"
    `);

    expect(addChildToUmbrellaBody(second.body, 13).changed).toBe(false);
    expect(addChildToUmbrellaBody(second.body, 1).changed).toBe(true);
  });

  test('appends the Children PRs section when missing', () => {
    expect(addChildToUmbrellaBody('Some text', 5).body).toBe(
      'Some text\n\n## Children PRs\n\n- #5\n',
    );
  });

  test('adds the parent link to child descriptions when missing', () => {
    expect(addParentLinkToChildBody('## PR motivations\n\nStuff', 7)).toEqual({
      body: '## Parent PR\n\n- #7\n\n## PR motivations\n\nStuff',
      changed: true,
    });

    expect(addParentLinkToChildBody('', 7).body).toBe('## Parent PR\n\n- #7\n');

    expect(addParentLinkToChildBody('## Parent PR\n\n## Other', 7).body).toBe(
      '## Parent PR\n\n- #7\n\n## Other',
    );

    expect(
      addParentLinkToChildBody('see https://github.com/a/b/pull/7', 7).changed,
    ).toBe(false);

    expect(bodyLinksPr('- #70', 7)).toBe(false);
  });

  test('finds the parent PR in any format with a did you mean', () => {
    const child = parseBranch('under/biling/x', config);

    if (child?.kind !== 'child') throw new Error('expected a child');

    const prs = [pr(1, 'feature/stacked/billing'), pr(2, 'feature/x')];

    expect(findParentPr(child, prs, config)).toMatchObject({
      ok: false,
      error: { suggestion: 'under/billing/x' },
    });

    const legacyChild = parseBranch('stack/billing/x', config);

    if (legacyChild?.kind !== 'child') throw new Error('expected a child');

    expect(findParentPr(legacyChild, prs, config)).toMatchObject({
      ok: true,
      value: { number: 1 },
    });
  });
});

describe('buildTree', () => {
  test('groups children under umbrellas and keeps orphans and others', () => {
    const tree = buildTree(
      [
        pr(1, 'feature/stacked/billing'),
        pr(2, 'stack/billing/a', 'feature/stacked/billing'),
        pr(3, 'under/billing/b', 'feature/stacked/billing'),
        pr(4, 'under/gone/c', 'feature/umbrella/gone'),
        pr(5, 'feature/plain'),
        pr(6, 'feature/umbrella/v2', 'feature/stacked/billing'),
      ],
      config,
    );

    expect(
      tree.umbrellas.map((node) => ({
        umbrella: node.pr.number,
        children: node.children.map((child) => child.pr.number),
        dependsOn: node.dependsOn,
      })),
    ).toEqual([
      { umbrella: 1, children: [2, 3], dependsOn: null },
      {
        umbrella: 6,
        children: [],
        dependsOn: { branch: 'feature/stacked/billing', pr: 1 },
      },
    ]);
    expect(tree.orphans.map((orphan) => orphan.pr.number)).toEqual([4]);
    expect(tree.others.map((item) => item.number)).toEqual([5]);
  });
});

describe('auto-approve', () => {
  const base = 'feature/umbrella/billing';

  test('approves base syncs and configured authors only', () => {
    expect(
      getAutoApproveEligibility(
        { head: 'under/billing/sync-2', base, author: 'x' },
        config,
      ),
    ).toMatchObject({ eligible: true });

    expect(
      getAutoApproveEligibility(
        {
          head: 'stack/billing/sync',
          base: 'feature/stacked/billing',
          author: 'x',
        },
        config,
      ),
    ).toMatchObject({ eligible: true });

    expect(
      getAutoApproveEligibility(
        { head: 'under/billing/sync-other', base, author: 'x' },
        config,
      ),
    ).toMatchObject({ eligible: false });

    expect(
      getAutoApproveEligibility(
        { head: 'under/billing/sync-other', base, author: 'lucasols' },
        config,
      ),
    ).toMatchObject({ eligible: true });

    expect(
      getAutoApproveEligibility(
        {
          head: 'under/billing/sync',
          base: 'feature/umbrella/other',
          author: 'lucasols',
        },
        config,
      ),
    ).toMatchObject({ eligible: false });

    expect(
      getAutoApproveEligibility(
        { head: 'under/billing/sync', base, author: 'x', draft: true },
        config,
      ),
    ).toMatchObject({ eligible: false });

    expect(
      getAutoApproveEligibility(
        { head: 'feature/x', base: 'beta', author: 'lucasols' },
        config,
      ),
    ).toMatchObject({ eligible: false });
  });
});

describe('dependencies', () => {
  const prs = [
    pr(1, 'feature/umbrella/a', 'beta'),
    pr(2, 'feature/umbrella/b', 'feature/umbrella/a'),
    pr(3, 'feature/umbrella/c', 'feature/umbrella/b'),
    pr(4, 'feature/loop-1', 'feature/loop-2'),
    pr(5, 'feature/loop-2', 'feature/loop-1'),
  ];

  test('follows the PR chain to the base', () => {
    const chain = getDependencyChain('feature/umbrella/b', 'beta', prs);

    expect(chain.ok && chain.chain.map((item) => item.number)).toEqual([2, 1]);
    expect(getDependencyChain('feature/nope', 'beta', prs)).toMatchObject({
      ok: false,
      reason: 'no-open-pr',
    });
    expect(getDependencyChain('feature/loop-1', 'beta', prs)).toMatchObject({
      ok: false,
      reason: 'cycle',
    });
  });

  test('resolves the current base of an umbrella', async () => {
    function isBranchGone(branch: string) {
      return Promise.resolve(branch === 'feature/merged');
    }

    expect(
      await resolveCurrentBase({
        umbrellaBranch: 'feature/umbrella/c',
        rootBase: 'beta',
        openPrs: prs,
        isBranchGone,
      }),
    ).toMatchObject({
      base: 'feature/umbrella/b',
      dependsOn: { branch: 'feature/umbrella/b', pr: 2 },
    });

    expect(
      await resolveCurrentBase({
        umbrellaBranch: 'feature/umbrella/d',
        rootBase: 'beta',
        openPrs: [...prs, pr(6, 'feature/umbrella/d', 'feature/merged')],
        isBranchGone,
      }),
    ).toMatchObject({ base: 'beta', staleBase: 'feature/merged' });

    expect(
      await resolveCurrentBase({
        umbrellaBranch: 'feature/umbrella/d',
        rootBase: 'beta',
        openPrs: [...prs, pr(6, 'feature/umbrella/d', 'feature/random')],
        isBranchGone,
      }),
    ).toMatchObject({ base: 'beta', invalidBase: 'feature/random' });
  });
});

describe('misc', () => {
  test('parses merged branches from merge commit messages', () => {
    expect(parseMergedBranch("Merge branch 'beta' into under/x/sync")).toBe(
      'beta',
    );
    expect(
      parseMergedBranch("Merge remote-tracking branch 'origin/master' into x"),
    ).toBe('master');
    expect(
      parseMergedBranch('Merge pull request #12 from acme/feature/x'),
    ).toBe('feature/x');
    expect(parseMergedBranch('Fix stuff')).toBeNull();
  });

  test('removes import only changes', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      "-import { a } from './a';",
      "+import { a } from './b';",
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');

    expect(removeImportOnlyChanges(diff)).toBe(
      [
        'diff --git a/b.ts b/b.ts',
        '--- a/b.ts',
        '+++ b/b.ts',
        '@@ -1 +1 @@',
        '-const a = 1;',
        '+const a = 2;',
        '',
      ].join('\n'),
    );
  });

  test('validates config files', () => {
    expect(parseConfig({ types: { feature: 'beta' } }).ok).toBe(true);
    expect(parseConfig({ types: {} })).toMatchObject({ ok: false });
    expect(parseConfig({ types: { stack: 'beta' } })).toMatchObject({
      ok: false,
    });
    expect(
      parseConfig({ types: { feature: 'beta' }, defaultType: 'bug' }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      parseConfig({ types: { feature: 'beta' }, autoApprove: { users: 'x' } }),
    ).toMatchObject({
      ok: false,
    });
  });
});
