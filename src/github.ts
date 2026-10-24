import { isRecord } from './utils.typeGuards';
import { CommandError, formatCommand, type Exec } from './exec';

const trailingNewlineRegex = /\n$/;
const prUrlNumberRegex = /\/pull\/(\d+)/;
const shaRegex = /^[\da-f]{40,64}$/;

const prFields = 'number,title,url,headRefName,baseRefName,author,isDraft';

/** Only `number`, `title` and `headRefName` are required, so PR types of projects are assignable */
export type PrInfo = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName?: string;
  url?: string;
  author?: { login: string };
  isDraft?: boolean;
  body?: string;
};

export type FullPrInfo = Required<Omit<PrInfo, 'body'>> & { body?: string };

export type PrRefs = {
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  /** Base branch commit when the PR was last updated, kept after it is merged */
  baseRefOid: string;
  isOpen: boolean;
};

export function createGitHub({
  exec,
  cwd,
  repo: repoOption,
}: {
  exec: Exec;
  cwd: string | undefined;
  repo: string | undefined;
}) {
  let resolvedRepo: string | undefined =
    repoOption ?? (process.env.GITHUB_REPOSITORY || undefined);

  async function runOk(args: string[], input?: string): Promise<string> {
    const result = await exec('gh', args, { cwd, input });

    if (result.code !== 0) {
      throw new CommandError(formatCommand('gh', args), result);
    }

    return result.stdout;
  }

  async function getRepo(): Promise<string> {
    if (resolvedRepo) return resolvedRepo;

    const out = await runOk([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ]);

    resolvedRepo = out.trim();

    return resolvedRepo;
  }

  async function listPrs(extraArgs: string[]): Promise<FullPrInfo[]> {
    const out = await runOk([
      'pr',
      'list',
      '--repo',
      await getRepo(),
      '--json',
      prFields,
      '--limit',
      '1000',
      ...extraArgs,
    ]);

    return parsePrList(out);
  }

  async function listComments(
    prNumber: number,
  ): Promise<{ id: number; body: string }[]> {
    const out = await runOk([
      'api',
      '--paginate',
      `repos/${await getRepo()}/issues/${prNumber}/comments`,
      '--jq',
      '.[] | {id, body}',
    ]);

    const comments: { id: number; body: string }[] = [];

    for (const line of out.split('\n')) {
      if (!line.trim()) continue;

      const value: unknown = JSON.parse(line);

      if (
        isRecord(value) &&
        typeof value.id === 'number' &&
        typeof value.body === 'string'
      ) {
        comments.push({ id: value.id, body: value.body });
      }
    }

    return comments;
  }

  async function deleteMarkedComments(
    prNumber: number,
    marker: string,
  ): Promise<number> {
    const repo = await getRepo();
    const markerTag = `<!-- ${marker} -->`;
    let deleted = 0;

    for (const comment of await listComments(prNumber)) {
      if (!comment.body.includes(markerTag)) continue;

      await runOk([
        'api',
        '--method',
        'DELETE',
        `repos/${repo}/issues/comments/${comment.id}`,
      ]);

      deleted++;
    }

    return deleted;
  }

  return {
    getRepo,

    async listOpenPrs(): Promise<FullPrInfo[]> {
      return listPrs(['--state', 'open']);
    },

    async findOpenPrByHead(head: string): Promise<FullPrInfo | null> {
      const prs = await listPrs(['--state', 'open', '--head', head]);

      return prs.find((pr) => pr.headRefName === head) ?? null;
    },

    async findMergedPrByHead(head: string): Promise<FullPrInfo | null> {
      const prs = await listPrs(['--state', 'merged', '--head', head]);

      return prs.find((pr) => pr.headRefName === head) ?? null;
    },

    async editPrBase(prNumber: number, base: string) {
      await runOk([
        'pr',
        'edit',
        String(prNumber),
        '--repo',
        await getRepo(),
        '--base',
        base,
      ]);
    },

    async getPrRefs(prNumber: number): Promise<PrRefs> {
      const out = await runOk([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        await getRepo(),
        '--json',
        'headRefName,headRefOid,baseRefName,baseRefOid,state',
      ]);

      const value: unknown = JSON.parse(out);

      if (
        !isRecord(value) ||
        typeof value.headRefName !== 'string' ||
        typeof value.headRefOid !== 'string' ||
        typeof value.baseRefName !== 'string' ||
        typeof value.baseRefOid !== 'string' ||
        typeof value.state !== 'string'
      ) {
        throw new Error(`Unexpected \`gh pr view ${prNumber}\` output`);
      }

      return {
        headRefName: value.headRefName,
        headRefOid: value.headRefOid,
        baseRefName: value.baseRefName,
        baseRefOid: value.baseRefOid,
        isOpen: value.state === 'OPEN',
      };
    },

    async getPrBody(prNumber: number): Promise<string> {
      const out = await runOk([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        await getRepo(),
        '--json',
        'body',
        '--jq',
        '.body',
      ]);

      return out.replace(trailingNewlineRegex, '');
    },

    async editPrBody(prNumber: number, body: string) {
      await runOk(
        [
          'pr',
          'edit',
          String(prNumber),
          '--repo',
          await getRepo(),
          '--body-file',
          '-',
        ],
        body,
      );
    },

    async createPr({
      head,
      base,
      title,
      body,
      draft,
    }: {
      head: string;
      base: string;
      title: string;
      body: string;
      draft?: boolean;
    }): Promise<{ number: number; url: string }> {
      const out = await runOk(
        [
          'pr',
          'create',
          '--repo',
          await getRepo(),
          '--head',
          head,
          '--base',
          base,
          '--title',
          title,
          '--body-file',
          '-',
          ...(draft ? ['--draft'] : []),
        ],
        body,
      );

      const url = out.trim().split('\n').at(-1) ?? '';
      const number = Number(prUrlNumberRegex.exec(url)?.[1]);

      if (!Number.isInteger(number)) {
        throw new Error(`Could not read the PR number from: ${out}`);
      }

      return { number, url };
    },

    /**
     * Merge base from the compare API, used in shallow checkouts where the
     * local merge base can be silently wrong
     */
    async getMergeBase(base: string, head: string): Promise<string> {
      const out = await runOk([
        'api',
        `repos/${await getRepo()}/compare/${encodeRef(base)}...${encodeRef(head)}?per_page=1`,
        '--jq',
        '.merge_base_commit.sha',
      ]);

      const sha = out.trim();

      if (!shaRegex.test(sha)) {
        throw new Error(
          `Could not get the merge base of ${base} and ${head}: ${out}`,
        );
      }

      return sha;
    },

    deleteMarkedComments,

    /** Deletes the previous comments with the marker and creates a new one */
    async replaceMarkedComment(
      prNumber: number,
      marker: string,
      body: string,
    ): Promise<void> {
      await deleteMarkedComments(prNumber, marker);

      await runOk(
        [
          'pr',
          'comment',
          String(prNumber),
          '--repo',
          await getRepo(),
          '--body-file',
          '-',
        ],
        `<!-- ${marker} -->\n\n${body}`,
      );
    },

    async approvePr(prNumber: number, body: string) {
      await runOk([
        'pr',
        'review',
        String(prNumber),
        '--repo',
        await getRepo(),
        '--approve',
        '--body',
        body,
      ]);
    },
  };
}

export type GitHub = ReturnType<typeof createGitHub>;

function encodeRef(ref: string) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

export function parsePrList(json: string): FullPrInfo[] {
  const value: unknown = JSON.parse(json);

  if (!Array.isArray(value)) throw new Error('Expected a list of PRs');

  const prs: FullPrInfo[] = [];

  for (const item of value) {
    const pr = parsePr(item);

    if (pr) prs.push(pr);
  }

  return prs;
}

function parsePr(value: unknown): FullPrInfo | null {
  if (!isRecord(value)) return null;

  const { number, title, url, headRefName, baseRefName, author, isDraft } =
    value;

  if (
    typeof number !== 'number' ||
    typeof title !== 'string' ||
    typeof headRefName !== 'string' ||
    typeof baseRefName !== 'string'
  ) {
    return null;
  }

  return {
    number,
    title,
    url: typeof url === 'string' ? url : '',
    headRefName,
    baseRefName,
    author: {
      login:
        isRecord(author) && typeof author.login === 'string' ?
          author.login
        : '',
    },
    isDraft: isDraft === true,
  };
}
