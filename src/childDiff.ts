import { splitLines, type Git } from './git';

export function toPathspec({
  include = [],
  exclude = [],
}: {
  include?: readonly string[];
  exclude?: readonly string[];
}): string[] {
  return [
    '--',
    ...(include.length > 0 ? include.map((glob) => `:(glob)${glob}`) : ['.']),
    ...exclude.map((glob) => `:(exclude,glob)${glob}`),
  ];
}

/** Diff of the branch against the merge base with its parent (`parent...branch`) */
export async function getBranchDiff({
  git,
  parentRef,
  branchRef,
  include,
  exclude,
  ignoreImportOnly,
}: {
  git: Git;
  parentRef: string;
  branchRef: string;
  include?: readonly string[];
  exclude?: readonly string[];
  ignoreImportOnly?: boolean;
}): Promise<{ diff: string; files: string[] }> {
  const pathspec = toPathspec({ include, exclude });
  const range = `${parentRef}...${branchRef}`;

  const files = splitLines(
    await git.runOk(['diff', '--name-only', range, ...pathspec]),
  );

  let diff = await git.runOk(['diff', '--no-color', range, ...pathspec]);

  if (ignoreImportOnly) diff = removeImportOnlyChanges(diff);

  return { diff, files };
}

/** Removes file sections whose changed lines are all imports/exports */
export function removeImportOnlyChanges(diff: string): string {
  const fileSections = diff.split(/(?=^diff --(?:git|cc))/m).filter(Boolean);
  const keptSections: string[] = [];

  for (const section of fileSections) {
    if (!section.startsWith('diff --git') && !section.startsWith('diff --cc')) {
      continue;
    }

    const lines = section.split('\n');

    // combined diffs use one prefix column per parent, the hunk header reveals
    // the width: `@@ ... @@` -> 1 col, `@@@ ... @@@` -> 2 cols
    let prefixLength = 1;

    for (const line of lines) {
      const hunkMatch = /^(@+) /.exec(line);

      if (hunkMatch?.[1]) {
        prefixLength = hunkMatch[1].length - 1;
        break;
      }
    }

    const changedLines = lines.filter((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return false;

      return /[+-]/.test(line.slice(0, prefixLength));
    });

    if (changedLines.length === 0) {
      keptSections.push(section);
      continue;
    }

    const hasNonImportChanges = changedLines.some(
      (line) => !isImportOrExportLine(line.slice(prefixLength).trim()),
    );

    if (hasNonImportChanges) keptSections.push(section);
  }

  return keptSections.join('');
}

function isImportOrExportLine(content: string): boolean {
  if (!content) return true;

  return (
    content.startsWith('import ')
    || content.startsWith('export ')
    || content.startsWith('} from ')
    || content.includes('= require(')
    || content.includes('import(')
    || /^import\s*{/.test(content)
    || /^export\s*{/.test(content)
  );
}
