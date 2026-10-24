import { splitLines, type Git } from './git';

const fileSectionStartRegex = /(?=^diff --(?:git|cc))/m;
const hunkHeaderRegex = /^(@+) /;
const changeMarkerRegex = /[+-]/;
const importBracesRegex = /^import\s*{/;
const exportBracesRegex = /^export\s*{/;

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

/** Splits a diff into one section per file */
export function splitFileDiffs(diff: string): string[] {
  return diff
    .split(fileSectionStartRegex)
    .filter(
      (section) =>
        section.startsWith('diff --git') || section.startsWith('diff --cc'),
    );
}

/** Path of a file section, the old path for deleted files */
export function getDiffFilePath(fileDiff: string): string | null {
  const lines = fileDiff.split('\n');
  const newPath = lines.find((line) => line.startsWith('+++ '));
  const oldPath = lines.find((line) => line.startsWith('--- '));
  const header =
    newPath && newPath !== '+++ /dev/null' ? newPath
    : oldPath && oldPath !== '--- /dev/null' ? oldPath
    : null;

  if (!header) return null;

  const raw = header.slice(4);
  // paths with special characters are quoted
  const unquoted =
    raw.startsWith('"') && raw.endsWith('"') ?
      raw.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
    : raw;

  return unquoted.slice(2);
}

/** Removes file sections whose changed lines are all imports/exports */
export function removeImportOnlyChanges(diff: string): string {
  return splitFileDiffs(diff)
    .filter((section) => !isImportOnlyChange(section))
    .join('');
}

/** Whether all changed lines of a file section are imports/exports */
export function isImportOnlyChange(fileDiff: string): boolean {
  const lines = fileDiff.split('\n');

  // combined diffs use one prefix column per parent, the hunk header reveals
  // the width: `@@ ... @@` -> 1 col, `@@@ ... @@@` -> 2 cols
  let prefixLength = 1;

  for (const line of lines) {
    const hunkMatch = hunkHeaderRegex.exec(line);

    if (hunkMatch?.[1]) {
      prefixLength = hunkMatch[1].length - 1;
      break;
    }
  }

  const changedLines = lines.filter((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return false;

    return changeMarkerRegex.test(line.slice(0, prefixLength));
  });

  if (changedLines.length === 0) return false;

  return changedLines.every((line) =>
    isImportOrExportLine(line.slice(prefixLength).trim()),
  );
}

function isImportOrExportLine(content: string): boolean {
  if (!content) return true;

  return (
    content.startsWith('import ') ||
    content.startsWith('export ') ||
    content.startsWith('} from ') ||
    content.includes('= require(') ||
    content.includes('import(') ||
    importBracesRegex.test(content) ||
    exportBracesRegex.test(content)
  );
}
