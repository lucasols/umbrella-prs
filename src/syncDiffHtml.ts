import {
  getDiffFilePath,
  isImportOnlyChange,
  splitFileDiffs,
} from './childDiff';
import type { SyncBaseDiff, SyncDiffResult } from './syncDiff';

const diffsModuleUrl = 'https://esm.sh/@pierre/diffs@1.6.1';
const themingColorModuleUrl = 'https://esm.sh/@pierre/theming@1.0.2/color';
const fontsUrl =
  'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap';

/**
 * Standalone page that renders the sync diff with `@pierre/diffs`. Files can be
 * marked as viewed, saved in the browser per sync PR (the merged branches)
 * until the file diff changes
 */
export function renderSyncDiffHtml(
  result: SyncDiffResult,
  { base }: { base?: SyncBaseDiff } = {},
): string {
  const data = {
    head: result.head,
    strategy: result.strategy,
    base:
      base ?
        {
          leftLabel: base.label,
          rightLabel: base.branchLabel,
          compareTo: base.to,
          conflictedFiles: [],
          diff: base.diff,
          contents: base.contents ?? null,
          importOnlyFiles: getImportOnlyFiles(base.diff),
        }
      : null,
    sections: result.sections.map((section) => ({
      leftLabel: section.leftLabel,
      rightLabel: section.rightLabel,
      compareTo: section.compareTo,
      conflictedFiles: section.conflictedFiles,
      diff: section.diff,
      contents: section.contents ?? null,
      importOnlyFiles: getImportOnlyFiles(section.diff),
    })),
  };

  const labels = [
    ...new Set(
      result.sections.map(
        (section) => `${section.leftLabel} + ${section.rightLabel}`,
      ),
    ),
  ].join(', ');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Sync diff ${escapeHtml(result.head.slice(0, 12))}</title>`,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="${fontsUrl}">`,
    `<style>${styles}</style>`,
    '<style id="theme-chrome"></style>',
    '</head>',
    '<body>',
    '<header class="top">',
    '<div class="title">',
    '<strong>Sync diff</strong>',
    ...(base ?
      [
        '<nav class="views">',
        '<a href="#" data-view="sync">Sync changes</a>',
        `<a href="#base" data-view="base">${escapeHtml(base.branchLabel)} vs ${escapeHtml(base.label)}</a>`,
        '</nav>',
      ]
    : []),
    `<span class="muted">${escapeHtml(labels)} → <code>${escapeHtml(result.head.slice(0, 12))}</code></span>`,
    '</div>',
    '<div class="actions">',
    '<span id="progress" class="muted"></span>',
    '<span id="nav" class="nav">',
    '<button type="button" id="prev" title="Previous file (p)">← Prev</button>',
    '<span id="position" class="muted"></span>',
    '<button type="button" id="next" title="Next file (n)">Next →</button>',
    '</span>',
    '<label id="imports" class="check"><input type="checkbox" id="hide-imports"> <span id="imports-label"></span></label>',
    '<button type="button" id="mode"></button>',
    '<button type="button" id="diff-style"></button>',
    '<button type="button" id="wrap" title="Wrap long lines">Wrap</button>',
    '<select id="theme" title="Theme"></select>',
    '</div>',
    '</header>',
    '<div class="layout">',
    '<aside id="files"></aside>',
    '<main id="review"></main>',
    '</div>',
    `<script type="application/json" id="sync-diff-data">${serializeJson(data)}</script>`,
    `<script type="module">import { CodeView, parsePatchFiles, resolveTheme } from '${diffsModuleUrl}';\nimport { colorUtils, normalizeThemeColors } from '${themingColorModuleUrl}';\n${script}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Files whose changed lines are all imports/exports */
function getImportOnlyFiles(diff: string): string[] {
  const files: string[] = [];

  for (const fileDiff of splitFileDiffs(diff)) {
    const filePath = getDiffFilePath(fileDiff);

    if (filePath !== null && isImportOnlyChange(fileDiff)) files.push(filePath);
  }

  return files;
}

function escapeHtml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** JSON safe to embed in a script tag */
function serializeJson(value: unknown) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

const styles = String.raw`
/* github-dark-default chrome until the selected theme loads */
:root {
  color-scheme: dark;
  --bg: #010409;
  --text: #e6edf3;
  --muted: #7d8590;
  --border: color-mix(in srgb, var(--text) 20%, transparent);
  --border-opaque: color-mix(in srgb, var(--text) 22%, var(--bg));
  --surface: color-mix(in srgb, var(--text) 7%, var(--bg));
  --surface-hover: color-mix(in srgb, var(--text) 14%, var(--bg));
  --surface-selected: color-mix(in srgb, var(--text) 20%, var(--bg));
  --accent: #1f6feb;
  --addition: #34d399;
  --deletion: #fb7185;
  --conflict: #d29922;
  --diffs-font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.5 Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
code { font-family: var(--diffs-font-family); font-size: 95%; font-weight: 500; letter-spacing: -0.025em; }
button, select {
  font: inherit;
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border-opaque);
  border-radius: 6px;
  padding: 2px 10px;
  cursor: pointer;
}
select { background: var(--bg); }
button:hover:not(:disabled), select:hover { background: var(--surface-hover); }
button:disabled { opacity: 0.5; cursor: default; }
button[aria-pressed='true'] { background: var(--surface-selected); }
input[type='checkbox'] { accent-color: var(--accent); }
.muted { color: var(--muted); }
.top {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-opaque);
}
.title { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; min-width: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.layout { flex: 1; display: flex; min-height: 0; }
#files {
  width: 300px;
  flex-shrink: 0;
  overflow: auto;
  padding: 8px 0;
  border-right: 1px solid var(--border-opaque);
}
#review { flex: 1; min-width: 0; height: 100%; overflow: auto; }
.section-title {
  padding: 8px 12px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 1px 12px 1px 4px;
}
.row:hover { background: var(--surface-hover); }
.row .name {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row .name:hover { background: none; }
.folder .name { color: var(--muted); }
.row.viewed .name { color: var(--muted); text-decoration: line-through; }
.caret {
  width: 14px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 11px;
}
.caret:hover { background: none; }
.hidden { display: none !important; }
.views { display: inline-flex; border: 1px solid var(--border-opaque); border-radius: 6px; overflow: hidden; }
.views a { padding: 2px 10px; color: var(--muted); text-decoration: none; }
.views a:hover { background: var(--surface-hover); }
.views a.active { background: var(--surface-selected); color: var(--text); }
.row.current { background: var(--surface-selected); box-shadow: inset 2px 0 var(--accent); }
.nav { display: inline-flex; gap: 6px; align-items: center; }
.check { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; user-select: none; }
.badge { font-size: 11px; color: var(--conflict); flex-shrink: 0; }
.viewed-toggle {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.viewed-toggle:has(input:checked) { color: var(--addition); }
.summary { padding: 12px 16px 0; }
.summary p { margin: 0 0 8px; }
.empty { padding: 24px 16px; color: var(--muted); }
@media (max-width: 720px) {
  .layout { flex-direction: column; }
  #files { width: auto; max-height: 30vh; border-right: 0; border-bottom: 1px solid var(--border-opaque); }
}
`;

const script = String.raw`
const data = JSON.parse(document.getElementById('sync-diff-data').textContent);
// the umbrella diff on top of the base after the sync, or the sync changes
const baseView = location.hash === '#base' && data.base !== null;
const sections = baseView ? [data.base] : data.sections;

for (const link of document.querySelectorAll('.views a')) {
  link.classList.toggle('active', link.dataset.view === (baseView ? 'base' : 'sync'));
}

window.addEventListener('hashchange', () => location.reload());
const viewName = baseView ? 'base' : 'sync';
// shared by both views and keyed by the merged branches, so it is kept when
// the sync PR is updated
const viewedKey = 'umbrella-prs:sync-diff-viewed-files:' + JSON.stringify(
  data.sections.map((section) => [section.leftLabel, section.rightLabel]),
);
const styleKey = 'umbrella-prs:sync-diff-style';
const modeKey = 'umbrella-prs:sync-diff-mode';
// the selected file, kept across modes and views
const currentKey = 'umbrella-prs:sync-diff-current:' + data.head;
const importsKey = 'umbrella-prs:sync-diff-hide-imports';
const wrapKey = 'umbrella-prs:sync-diff-wrap';
const themeKey = 'umbrella-prs:sync-diff-theme';

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked, viewed state lasts until the page is closed
  }
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16);
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children ?? []) node.append(child);
  return node;
}

// viewed files by path, with the hash of their diff in each view, so files
// whose diff changed show up again
const viewed = readStorage(viewedKey, {});
let diffStyle = readStorage(styleKey, 'split');
// 'all' shows every file, 'single' one file at a time
let mode = readStorage(modeKey, 'all');
let hideImportOnly = readStorage(importsKey, false);
let wrap = readStorage(wrapKey, false);
const themes = [
  { id: 'github-dark-default', label: 'GitHub Dark' },
  { id: 'github-light-default', label: 'GitHub Light' },
  { id: 'github-system', label: 'GitHub (system)', light: 'github-light-default', dark: 'github-dark-default' },
  { id: 'pierre-dark-soft', label: 'Pierre Dark Soft' },
  { id: 'pierre-light-soft', label: 'Pierre Light Soft' },
  { id: 'pierre-soft-system', label: 'Pierre Soft (system)', light: 'pierre-light-soft', dark: 'pierre-dark-soft' },
  { id: 'pierre-dark', label: 'Pierre Dark' },
  { id: 'pierre-light', label: 'Pierre Light' },
];
let theme = themes.find((option) => option.id === readStorage(themeKey, null)) ?? themes[0];
// light or dark, by theme name, known once the theme loads
const themeTypes = new Map();
let current = null;
const multipleSections = sections.length > 1;

const entries = [];
const entriesByDiff = new Map();

sections.forEach((section, sectionIndex) => {
  if (!section.diff) return;

  const patches = parsePatchFiles(section.diff + '\n', 'section-' + sectionIndex);

  for (const fileDiff of patches.flatMap((patch) => patch.files)) {
    const entry = {
      id: sectionIndex + ':' + fileDiff.name,
      section,
      fileDiff,
      conflicted: section.conflictedFiles.includes(fileDiff.name),
      importOnly: section.importOnlyFiles.includes(fileDiff.name),
      toggles: [],
      row: null,
    };
    entries.push(entry);
    entriesByDiff.set(fileDiff, entry);
  }
});

const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

function hashFileDiff(fileDiff) {
  return hash(fileDiff.deletionLines.join('\n') + '\0' + fileDiff.additionLines.join('\n'));
}

/** Hash of the diff of each file, by path */
function hashFiles(fileDiffs) {
  const hashes = new Map();
  for (const fileDiff of fileDiffs) {
    hashes.set(fileDiff.name, (hashes.get(fileDiff.name) ?? '') + hashFileDiff(fileDiff));
  }
  return hashes;
}

function parseViewFiles(viewSections, prefix) {
  return viewSections.flatMap((section, index) =>
    section.diff
      ? parsePatchFiles(section.diff + '\n', prefix + index).flatMap((patch) => patch.files)
      : [],
  );
}

// the hashes of the other view too, so marking a file marks it in both
const viewHashes = {
  [viewName]: hashFiles(entries.map((entry) => entry.fileDiff)),
};

if (baseView) viewHashes.sync = hashFiles(parseViewFiles(data.sections, 'hash-sync-'));
else if (data.base) viewHashes.base = hashFiles(parseViewFiles([data.base], 'hash-base-'));

function isViewed(entry) {
  const name = entry.fileDiff.name;
  return viewed[name]?.[viewName] === viewHashes[viewName].get(name);
}

function createToggle(entry) {
  const input = el('input', { type: 'checkbox', checked: isViewed(entry) });
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('change', () => setViewed([entry], input.checked));
  entry.toggles.push(input);
  return input;
}

const progress = document.getElementById('progress');

function isVisible(entry) {
  return !(hideImportOnly && entry.importOnly);
}

function visibleEntries() {
  return treeOrder.filter(isVisible);
}

function updateProgress() {
  const visible = visibleEntries();
  progress.textContent = visible.filter(isViewed).length + ' / ' + visible.length + ' viewed';
}

function setViewed(targets, value) {
  for (const entry of targets) {
    const name = entry.fileDiff.name;

    if (value) {
      viewed[name] = { sync: viewHashes.sync?.get(name), base: viewHashes.base?.get(name) };
    } else {
      delete viewed[name];
    }

    for (const toggle of entry.toggles) toggle.checked = value;
    entry.row?.classList.toggle('viewed', value);
  }

  writeStorage(viewedKey, viewed);

  if (mode === 'single') {
    if (value && current && targets.includes(current)) setCurrent(nextUnviewed(current));
    render();
    return;
  }

  for (const entry of targets) {
    const item = viewer.getItem(entry.id);
    if (item && item.collapsed !== value) {
      viewer.updateItem({ ...item, collapsed: value, version: (item.version ?? 0) + 1 });
    }
  }

  updateProgress();
  updateFolders();
}

// the next unviewed file after the entry, wrapping around, or the entry itself
function nextUnviewed(entry) {
  const visible = visibleEntries();
  const index = visible.indexOf(entry);
  const ordered = [...visible.slice(index + 1), ...visible.slice(0, index)];
  return ordered.find((item) => !isViewed(item)) ?? entry;
}

function setCurrent(entry) {
  if (entry === current) return;

  current?.row?.classList.remove('current');
  current = entry;
  current?.row?.classList.add('current');
  writeStorage(currentKey, entry?.fileDiff.name ?? null);
}

function select(entry) {
  setCurrent(entry);

  if (mode === 'single') render();
  else viewer.scrollTo({ type: 'item', id: entry.id, align: 'start' });
}

// the file at the top of the scroll position in the all files mode
function topEntry() {
  let top = null;

  for (const entry of visibleEntries()) {
    const itemTop = viewer.getTopForItem(entry.id);
    if (itemTop === undefined || itemTop > root.scrollTop + 1) break;
    top = entry;
  }

  return top;
}

function move(offset) {
  const visible = visibleEntries();
  const index = visible.indexOf(current);
  const next = visible[index + offset];
  if (next) select(next);
}

const folders = [];
// files in the order of the tree, so the diffs follow it
const treeOrder = [];

// folder checkboxes are checked when all files are viewed, mixed when some are
function updateFolders() {
  for (const folder of folders) {
    const visible = folder.entries.filter(isVisible);
    const count = visible.filter(isViewed).length;
    folder.toggle.checked = visible.length > 0 && count === visible.length;
    folder.toggle.indeterminate = count > 0 && count < visible.length;
    folder.row.classList.toggle('viewed', folder.toggle.checked);
    folder.row.classList.toggle('hidden', visible.length === 0);
    folder.children.classList.toggle('filtered', visible.length === 0);
  }
}

function buildTree(sectionEntries) {
  const root = { name: '', folders: new Map(), files: [] };

  for (const entry of sectionEntries) {
    const parts = entry.fileDiff.name.split('/');
    let node = root;

    for (const part of parts.slice(0, -1)) {
      let child = node.folders.get(part);
      if (!child) {
        child = { name: part, folders: new Map(), files: [] };
        node.folders.set(part, child);
      }
      node = child;
    }

    node.files.push({ name: parts.at(-1), entry });
  }

  return root;
}

// folders with a single subfolder and no files are shown as one row, e.g. src/utils
function compactFolder(folder) {
  let current = folder;

  while (current.files.length === 0 && current.folders.size === 1) {
    const [only] = current.folders.values();
    current = { name: current.name + '/' + only.name, folders: only.folders, files: only.files };
  }

  return current;
}

function folderEntries(folder) {
  return [
    ...[...folder.folders.values()].flatMap(folderEntries),
    ...folder.files.map((file) => file.entry),
  ];
}

function byName(a, b) {
  return a.name.localeCompare(b.name);
}

function renderTree(node, depth) {
  const nodes = [];

  for (const child of [...node.folders.values()].sort(byName)) {
    const folder = compactFolder(child);
    const toggle = el('input', { type: 'checkbox' });
    const caret = el('button', { type: 'button', className: 'caret', textContent: '▾', title: 'Collapse' });
    const children = el('div', { className: 'children' }, renderTree(folder, depth + 1));
    const row = el('div', { className: 'row folder' }, [
      caret,
      toggle,
      el('span', { className: 'name', textContent: folder.name + '/', title: folder.name }),
    ]);
    row.style.paddingLeft = 4 + depth * 14 + 'px';

    const record = { toggle, row, children, entries: folderEntries(folder) };
    folders.push(record);

    toggle.addEventListener('change', () => {
      setViewed(record.entries.filter(isVisible), toggle.checked);
    });
    caret.addEventListener('click', () => {
      const collapsed = children.classList.toggle('hidden');
      caret.textContent = collapsed ? '▸' : '▾';
      caret.title = collapsed ? 'Expand' : 'Collapse';
    });

    nodes.push(row, children);
  }

  for (const file of [...node.files].sort(byName)) {
    const { entry } = file;
    treeOrder.push(entry);
    const name = el('button', { type: 'button', className: 'name', textContent: file.name, title: entry.fileDiff.name });
    name.addEventListener('click', () => select(entry));

    entry.row = el('div', { className: 'row file' + (isViewed(entry) ? ' viewed' : '') }, [
      createToggle(entry),
      name,
      ...(entry.conflicted ? [el('span', { className: 'badge', textContent: 'conflict' })] : []),
      ...(entry.importOnly ? [el('span', { className: 'badge muted', textContent: 'imports' })] : []),
    ]);
    entry.row.style.paddingLeft = 22 + depth * 14 + 'px';
    nodes.push(entry.row);
  }

  return nodes;
}

function renderSidebar() {
  const aside = document.getElementById('files');

  for (const section of sections) {
    const sectionEntries = entries.filter((entry) => entry.section === section);

    if (multipleSections) {
      aside.append(
        el('div', {
          className: 'section-title',
          textContent: section.rightLabel + ' (' + section.compareTo.slice(0, 12) + ')',
        }),
      );
    }

    if (sectionEntries.length === 0) {
      aside.append(el('div', { className: 'section-title', textContent: 'No changes' }));
    }

    aside.append(...renderTree(buildTree(sectionEntries), 0));
  }
}

const emptyNote = el('p', { className: 'empty hidden' });

function renderSummary() {
  const summary = el('div', { className: 'summary' });

  if (baseView) {
    summary.append(
      el('p', {
        textContent: 'The files changed by the sync compared with ' + data.base.leftLabel +
          ', as the ' + data.base.rightLabel + ' PR shows them once the sync PR is merged. ' + entries.length + ' files.',
      }),
      emptyNote,
    );

    return summary;
  }

  for (const section of sections) {
    const conflictCount = section.conflictedFiles.length;
    const conflicts = conflictCount === 0 ? 'No conflicts.'
      : conflictCount === 1 ? '1 conflicted file.'
      : conflictCount + ' conflicted files.';

    summary.append(
      el('p', {
        textContent: (multipleSections ? section.rightLabel + ': ' : '') +
          'changes made on top of the automatic merge of ' + section.leftLabel + ' and ' +
          section.rightLabel + '. Red lines are the automatic merge, with unresolved conflicts between markers, green lines are what the PR has instead. ' +
          conflicts,
      }),
    );
  }

  summary.append(emptyNote);

  return summary;
}

async function loadDiffFiles(fileDiff) {
  const entry = entriesByDiff.get(fileDiff);
  const contents = entry?.section.contents;
  const oldName = fileDiff.prevName ?? fileDiff.name;
  const before = fileDiff.type === 'new' ? '' : contents?.before[oldName];
  const after = fileDiff.type === 'deleted' ? '' : contents?.after[fileDiff.name];

  if (before === undefined || after === undefined) {
    throw new Error('The contents of ' + fileDiff.name + ' are not available (binary or too big)');
  }

  return {
    oldFile: { name: oldName, contents: before },
    newFile: { name: fileDiff.name, contents: after },
  };
}

const summary = renderSummary();

function viewerOptions() {
  return {
    theme: theme.light ? { light: theme.light, dark: theme.dark } : theme.id,
    themeType: theme.light ? 'system' : themeTypes.get(theme.id) ?? 'dark',
    overflow: wrap ? 'wrap' : 'scroll',
    diffStyle,
    stickyHeaders: true,
    // without contents, e.g. the base diff, unchanged lines can't be expanded
    loadDiffFiles: sections.some((section) => section.contents) ? loadDiffFiles : undefined,
    renderCodeViewHeader: () => summary,
    renderHeaderPrefix: multipleSections
      ? (fileDiff) => {
          const entry = entriesByDiff.get(fileDiff);
          return entry ? el('span', { className: 'muted', textContent: entry.section.rightLabel }) : null;
        }
      : undefined,
    renderHeaderMetadata: (fileDiff, context) => {
      const entry = entriesById.get(context?.item?.id) ?? entriesByDiff.get(fileDiff);
      if (!entry) return null;
      entry.toggles = entry.toggles.filter((toggle) => toggle.isConnected);
      return el('label', { className: 'viewed-toggle' }, [
        ...(entry.conflicted ? [el('span', { className: 'badge', textContent: 'conflict' })] : []),
        createToggle(entry),
        'Viewed',
      ]);
    },
  };
}

const root = document.getElementById('review');
const viewer = new CodeView(viewerOptions());

const styleButton = document.getElementById('diff-style');
const modeButton = document.getElementById('mode');
const nav = document.getElementById('nav');
const prevButton = document.getElementById('prev');
const nextButton = document.getElementById('next');
const position = document.getElementById('position');
const importsToggle = document.getElementById('hide-imports');
const importOnlyCount = entries.filter((entry) => entry.importOnly).length;

let itemVersion = 0;

function render() {
  const visible = visibleEntries();

  if (mode === 'single' && (!current || !isVisible(current))) {
    setCurrent(visible.find((entry) => !isViewed(entry)) ?? visible[0] ?? null);
  }

  for (const entry of entries) {
    entry.row?.classList.toggle('hidden', !isVisible(entry));
    entry.row?.classList.toggle('current', entry === current);
  }

  const items = mode === 'single' ? (current ? [current] : []) : visible;

  itemVersion++;
  viewer.setItems(items.map((entry) => ({
    id: entry.id,
    type: 'diff',
    fileDiff: entry.fileDiff,
    collapsed: mode === 'all' && isViewed(entry),
    version: itemVersion,
  })));

  if (mode === 'single') root.scrollTop = 0;
  else if (current && isVisible(current)) scrollToCurrent();

  emptyNote.textContent = entries.length > 0 ? 'All the changes are import-only.'
    : baseView ? 'There are no changes on top of ' + data.base.leftLabel + '.'
    : 'The PR matches the automatic merge, there are no conflict resolutions or manual edits.';
  emptyNote.classList.toggle('hidden', visible.length > 0);

  const index = visible.indexOf(current);
  nav.classList.toggle('hidden', mode !== 'single' || visible.length === 0);
  position.textContent = index + 1 + ' / ' + visible.length;
  prevButton.disabled = index <= 0;
  nextButton.disabled = index >= visible.length - 1;

  modeButton.textContent = mode === 'single' ? 'All files' : 'One file';
  modeButton.title = mode === 'single' ? 'Show all the files' : 'Review one file at a time';
  styleButton.textContent = diffStyle === 'split' ? 'Unified' : 'Split';
  wrapButton.setAttribute('aria-pressed', String(wrap));

  updateProgress();
  updateFolders();
}

// page colors derived from the theme like diffshub.com does
const chromeStyle = document.getElementById('theme-chrome');
const themeSelect = document.getElementById('theme');
const wrapButton = document.getElementById('wrap');

for (const option of themes) {
  themeSelect.append(el('option', { value: option.id, textContent: option.label }));
}

function chromeVars(resolved) {
  const colors = resolved.colors ?? {};
  const surfaces = normalizeThemeColors(resolved).colors ?? {};
  const bg = surfaces['sideBar.background'] ?? surfaces['editor.background'] ?? resolved.bg;
  const fg = colorUtils.pickReadableForeground(bg, [colors['sideBar.foreground'], colors['editor.foreground'], resolved.fg]) ?? resolved.fg;
  const description = colors['descriptionForeground'];
  const descriptionLuminance = description ? colorUtils.relativeLuminance(colorUtils.compositeOverBg(description, bg) ?? description) : null;
  const bgLuminance = colorUtils.relativeLuminance(bg);
  const muted = description && (descriptionLuminance === null || bgLuminance === null || colorUtils.contrastRatio(bgLuminance, descriptionLuminance) >= 4.5)
    ? description
    : colorUtils.deriveMutedFg(fg, bg);
  const dark = colorUtils.isDarkSurface(bg, fg);

  return [
    'color-scheme: ' + (dark ? 'dark' : 'light'),
    '--bg: ' + bg,
    '--text: ' + fg,
    '--muted: ' + muted,
    '--accent: ' + (colors['focusBorder'] ?? colors['textLink.foreground'] ?? fg),
    '--addition: ' + (dark ? '#34d399' : '#047857'),
    '--deletion: ' + (dark ? '#fb7185' : '#be123c'),
    '--conflict: ' + (colors['editorWarning.foreground'] ?? (dark ? '#d29922' : '#9a6700')),
  ].join('; ');
}

async function applyTheme() {
  const names = theme.light ? [theme.light, theme.dark] : [theme.id];
  const resolved = await Promise.all(names.map((name) => resolveTheme(name)));
  for (const [index, name] of names.entries()) themeTypes.set(name, resolved[index].type);

  const [light, dark] = resolved.map(chromeVars);
  chromeStyle.textContent = theme.light
    ? ':root { ' + light + ' } @media (prefers-color-scheme: dark) { :root { ' + dark + ' } }'
    : ':root { ' + light + ' }';
  viewer.setOptions(viewerOptions());
}

themeSelect.value = theme.id;
themeSelect.addEventListener('change', () => {
  theme = themes.find((option) => option.id === themeSelect.value) ?? themes[0];
  writeStorage(themeKey, theme.id);
  void applyTheme();
});

wrapButton.addEventListener('click', () => {
  wrap = !wrap;
  writeStorage(wrapKey, wrap);
  viewer.setOptions(viewerOptions());
  render();
});

styleButton.addEventListener('click', () => {
  diffStyle = diffStyle === 'split' ? 'unified' : 'split';
  writeStorage(styleKey, diffStyle);
  viewer.setOptions(viewerOptions());
  render();
});

function scrollToCurrent() {
  const target = current;
  // after CodeView lays out the new items
  requestAnimationFrame(() => {
    if (target === current) viewer.scrollTo({ type: 'item', id: target.id, align: 'start' });
  });
}

let scrollFrame = 0;

root.addEventListener('scroll', () => {
  if (mode !== 'all') return;

  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    const top = topEntry();
    if (top) setCurrent(top);
  });
});

modeButton.addEventListener('click', () => {
  mode = mode === 'single' ? 'all' : 'single';
  writeStorage(modeKey, mode);
  render();
});

prevButton.addEventListener('click', () => move(-1));
nextButton.addEventListener('click', () => move(1));

document.getElementById('imports').classList.toggle('hidden', importOnlyCount === 0);
document.getElementById('imports-label').textContent =
  'Hide import-only (' + importOnlyCount + ')';
importsToggle.checked = hideImportOnly;
importsToggle.addEventListener('change', () => {
  hideImportOnly = importsToggle.checked;
  writeStorage(importsKey, hideImportOnly);
  render();
});

document.addEventListener('keydown', (event) => {
  if (mode !== 'single' || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable]')) return;

  if (event.key === 'n') move(1);
  else if (event.key === 'p') move(-1);
  else if (event.key === 'v' && current) setViewed([current], !isViewed(current));
});

renderSidebar();

const savedName = readStorage(currentKey, null);
setCurrent(entries.find((entry) => entry.fileDiff.name === savedName) ?? null);

viewer.setup(root);
render();
void applyTheme();
`;
