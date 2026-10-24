import { splitLines, type Git } from './git';

const fileSectionStartRegex = /(?=^diff --(?:git|cc))/m;
const hunkHeaderRegex = /^(@+) /;
const changeMarkerRegex = /[+-]/;
const importBracesRegex = /^import\s*{/;
const exportBracesRegex = /^export\s*{/;
const importBlockStartRegex =
  /^(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?{$/;
const importBlockEndRegex = /^}\s*from\s/;
const importListItemRegex = /^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?,?$/;
const conflictMarkerRegex = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/;

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
type SideLine = { content: string; changed: boolean } | null;

/**
 * Whether all changed lines of a file section are imports/exports. Items of
 * multi-line import lists and conflict markers around imports count as imports
 */
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

  // the old and new versions of the hunks, `null` separates hunks
  const oldSide: SideLine[] = [];
  const newSide: SideLine[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (hunkHeaderRegex.test(line)) {
      inHunk = true;
      oldSide.push(null);
      newSide.push(null);
      continue;
    }

    if (!inHunk || line.startsWith('\\')) continue;

    const prefix = line.slice(0, prefixLength);
    const content = line.slice(prefixLength).trim();
    const changed = changeMarkerRegex.test(prefix);

    if (!prefix.includes('+')) oldSide.push({ content, changed });
    if (!prefix.includes('-')) newSide.push({ content, changed });
  }

  let hasChanges = false;

  for (const side of [oldSide, newSide]) {
    for (const [index, line] of side.entries()) {
      if (!line?.changed) continue;

      hasChanges = true;

      if (!isImportLine(side, index)) return false;
    }
  }

  return hasChanges;
}

function isImportLine(side: SideLine[], index: number): boolean {
  const content = side[index]?.content ?? '';

  if (isImportOrExportLine(content)) return true;

  if (conflictMarkerRegex.test(content)) {
    return isImportConflictMarker(side, index, content);
  }

  return importListItemRegex.test(content) && isInImportBlock(side, index);
}

/** Whether the lines of the conflict sides around the marker are all imports */
function isImportConflictMarker(
  side: SideLine[],
  index: number,
  marker: string,
): boolean {
  const steps =
    marker.startsWith('<') ? [1]
    : marker.startsWith('>') ? [-1]
    : [-1, 1];

  for (const step of steps) {
    for (
      let current = index + step;
      current >= 0 && current < side.length;
      current += step
    ) {
      const line = side[current];

      if (!line || conflictMarkerRegex.test(line.content)) break;

      if (!isImportLine(side, current)) return false;
    }
  }

  return true;
}

/** Whether the line is between `import {` and `} from`, within its hunk */
function isInImportBlock(side: SideLine[], index: number): boolean {
  for (const step of [-1, 1]) {
    for (
      let current = index + step;
      current >= 0 && current < side.length;
      current += step
    ) {
      const line = side[current];

      if (!line) break;

      const boundary = step < 0 ? importBlockStartRegex : importBlockEndRegex;

      if (boundary.test(line.content)) return true;

      const isListLine =
        !line.content ||
        importListItemRegex.test(line.content) ||
        conflictMarkerRegex.test(line.content);

      if (!isListLine) break;
    }
  }

  return false;
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
