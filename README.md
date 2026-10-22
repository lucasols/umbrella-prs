# @ls-stack/umbrella-prs

Library and CLI for the umbrella PR branch workflow:

- An **umbrella** branch is a long-lived branch with one PR into its base branch (e.g. `beta`).
- **Children** are created from the umbrella, and each child PR targets the umbrella. Children don't depend on each other.
- A **sync** child merges a branch (usually the base) into the umbrella through a PR, so conflict resolutions get reviewed and run CI.
- An umbrella can **depend on** another open branch: its PR targets that branch until it's merged, then GitHub retargets it to the base.

Needs `git` (>= 2.38 locally, >= 2.40 in CI) and an authenticated [`gh`](https://cli.github.com). The CLI has no runtime dependencies, so CI can run it with `npx`/`pnpm dlx` before installing the project's dependencies.

## Branch names

| branch           | default name                | with `branchNames: { umbrella: 'stacked', child: 'stack' }` |
| ---------------- | --------------------------- | ----------------------------------------------------------- |
| umbrella         | `<type>/umbrella/<name>`    | `<type>/stacked/<name>`                                     |
| child            | `under/<name>/<child>`      | `stack/<name>/<child>`                                      |
| base sync        | `under/<name>/sync[-N]`     | `stack/<name>/sync[-N]`                                     |
| sync of a branch | `under/<name>/sync-<label>` | `stack/<name>/sync-<label>`                                 |

New branches always use `branchNames`. Branches that use one of the `aliases` (e.g. an old naming) are parsed but never created, and lookups work across both, so an alias umbrella can have children with the configured names. Base syncs (`sync`, `sync-N`) can be auto-approved, `sync-<label>` syncs can't.

## Config

`umbrella-prs.config.json` at the repo root (or the `umbrellaPrs` key in package.json, or `--config <path>`). It must exist in every base branch.

```json
{
  "types": { "feature": "beta", "bug": "beta", "hotfix": "master" },
  "branchNames": { "umbrella": "umbrella", "child": "under" },
  "aliases": [{ "umbrella": "stacked", "child": "stack" }],
  "defaultType": "feature",
  "remote": "origin",
  "repo": "acme/app",
  "autoApprove": { "users": ["lucasols"], "syncBranches": true },
  "diff": { "exclude": ["pnpm-lock.yaml"] },
  "docsLink": "https://github.com/acme/app#branches",
  "syncDiff": {
    "maxCommentChars": 60000,
    "commentMarker": "UMBRELLA_SYNC_DIFF"
  }
}
```

`types` maps each branch type to its base branch. Everything else is optional. `branchNames` and `aliases` must be single branch segments that don't collide with the types.

## CLI

```sh
umbrella-prs create umbrella new-billing --type feature   # branch + empty commit + push + PR
umbrella-prs create umbrella billing-v2 --on feature/umbrella/new-billing
umbrella-prs create child adjust-ui                       # from the umbrella of the current branch
umbrella-prs create sync --pr                             # exits 3 on conflicts, merge left in progress
umbrella-prs create sync --from feature/other             # under/<name>/sync-feature-other
umbrella-prs convert my-work --umbrella new-billing       # child + merge the current branch
umbrella-prs sync [--stash]                               # child <- umbrella, umbrella <- base
umbrella-prs tree
umbrella-prs diff sync --out sync.diff                    # conflict resolutions of a sync branch
umbrella-prs diff child --exclude '**/pt.json' --ignore-imports --out pr.diff
umbrella-prs pr create
umbrella-prs parse feature/umbrella/plans --json
umbrella-prs find-umbrella plans --json
```

Run `umbrella-prs --help` or `umbrella-prs <command> --help` for every flag.

For agents:

- Every command is non-interactive with flags. It prompts only when stdin is a TTY and a value is missing, and never with `--yes`, `--json` or a non-TTY stdin.
- `--json` prints `{ "ok": true, ... }`, or `{ "ok": false, "error": { "code", "message", "fix" } }`, to stdout. Progress goes to stderr.
- Exit codes: `0` ok, `1` failed, `2` usage error, `3` merge conflicts left in progress, `4` config error, `5` precondition failed (dirty tree, not found).

## CI

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 60
- run: npx --yes @ls-stack/umbrella-prs@<version> ci run --json
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    HEAD_REF: ${{ github.head_ref }}
    BASE_REF: ${{ github.base_ref }}
    PR: ${{ github.event.pull_request.number }}
```

`ci run` does nothing for PRs outside the workflow. For umbrella-workflow PRs it:

1. Verifies the PR. It exits 1 with the errors, most important first. Warnings never fail.
2. For children: lists the child in the umbrella PR's `Children PRs` section, and adds `## Parent PR` / `- #N` to the child description when it's missing.
3. For syncs: posts the sync diff comment, replacing the previous one.

Each step is also a command of its own: `ci verify`, `ci update-parent`, `ci sync-diff [--right <branch>] [--post]` and `ci auto-approve [--approve]`. Inputs come from flags or env: `HEAD_REF`/`GITHUB_HEAD_REF`, `BASE_REF`/`GITHUB_BASE_REF`, `PR`, `PR_AUTHOR` and `GITHUB_EVENT_PATH`. See [examples/auto-approve.yml](examples/auto-approve.yml).

### Sync diff

The sync diff shows what a sync PR changed on top of the automatic merge: conflict resolutions, including ones that kept one side, plus manual edits. It works like this:

1. The merged branch comes from the merge commits on the PR head's first-parent history, or from `--right`.
2. The merge commits and their merge base come from the GitHub compare API, since merge bases can be silently wrong in a shallow checkout. Missing commits are fetched with `--depth=1`.
3. The merge is redone with `git merge-tree --write-tree --merge-base`.
4. The result is diffed against the PR head (`HEAD^2` in the PR merge checkout), and the conflict markers are relabeled with branch names.

When the PR merged more than one branch, each merge commit gets its own section.

## Library

```ts
import {
  createUmbrellaPrs,
  parseBranch,
  buildTree,
} from '@ls-stack/umbrella-prs';

const umbrella = createUmbrellaPrs({
  config: { types: { feature: 'beta', hotfix: 'master' } },
  hooks: {
    // e.g. an AI description, return null for the default template
    generateChildPr: async ({ branch, parentPr }) => null,
    log: (message) => console.info(message),
  },
});

const result = await umbrella.createSync({ umbrella: 'billing' });

if (!result.ok)
  throw new Error(`${result.error.message}\n${result.error.fix ?? ''}`);
```

Operations return `{ ok: true, value } | { ok: false, error: { code, message, fix? } }` and never prompt or exit the process.

Pure helpers:

- Naming: `parseBranch`, `parseBranchStrict`, `formatUmbrellaBranch`, `formatChildBranch`, `getNextSyncBranchName`, `validateChildName`, `findUmbrellaBranch` and `getChildrenOf`. They take the resolved config (`resolveConfig(config)`) for the types and branch names. `createUmbrellaPrs` also returns `parseBranch`, `formatUmbrellaBranch`, `formatChildBranch` and `buildTree` bound to its config.
- Trees and dependencies: `buildTree(prs, config)` and `getDependencyChain`.
- PR bodies: `addChildToUmbrellaBody`, `addParentLinkToChildBody` and `findParentPr`.
- Other: `getAutoApproveEligibility`, `renderSyncDiffComment` and `removeImportOnlyChanges`.

`buildTree` accepts any PR type with `number`, `title` and `headRefName`.
