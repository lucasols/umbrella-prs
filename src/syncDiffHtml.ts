import {
  getDiffFilePath,
  isImportOnlyChange,
  splitFileDiffs,
} from './childDiff';
import type {
  SyncBaseDiff,
  SyncDiffContents,
  SyncDiffResult,
} from './syncDiff';

const diffsModuleUrl = 'https://esm.sh/@pierre/diffs@1.6.1';
const themingColorModuleUrl = 'https://esm.sh/@pierre/theming@1.0.2/color';
const treesModuleUrl =
  'https://esm.sh/@pierre/trees@1.0.0-beta.6?exports=createFileTreeIconResolver,getBuiltInSpriteSheet';
const fontsUrl =
  'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap';

/** Storage keys of the viewer preferences, shared by every diff */
export const viewerPrefKeys = [
  'umbrella-prs:sync-diff-style',
  'umbrella-prs:sync-diff-mode',
  'umbrella-prs:sync-diff-hide-imports',
  'umbrella-prs:sync-diff-wrap',
  'umbrella-prs:sync-diff-sidebar-width',
  'umbrella-prs:sync-diff-theme',
  'umbrella-prs:sync-diff-github-sync',
] as const;

export type ViewerGitHub = {
  pr: number;
  /** The PR head commit on GitHub, as known locally */
  head: string;
  /** Files of the diff that differ from the PR head on GitHub, they are not synced */
  unpushed: string[];
};

type ViewerSection = {
  leftLabel: string;
  rightLabel: string;
  compareTo: string;
  conflictedFiles: string[];
  diff: string;
  contents: SyncDiffContents | null;
  importOnlyFiles: string[];
};

type ViewerData = {
  kind: 'sync' | 'patch';
  head: string;
  /** Storage keys of the viewed files and of the selected file */
  storage: { viewed: string; current: string };
  github: ViewerGitHub | null;
  base: ViewerSection | null;
  sections: ViewerSection[];
};

/** A viewer page, rendered with `renderViewerPage` */
export type ViewerPage = {
  title: string;
  heading: string;
  /** html of the view switcher */
  views: string[];
  /** html */
  subtitle: string;
  data: ViewerData;
};

/** The sync diff as a viewer page */
export function buildSyncDiffPage(
  result: SyncDiffResult,
  { base }: { base?: SyncBaseDiff } = {},
): ViewerPage {
  const labels = [
    ...new Set(
      result.sections.map(
        (section) => `${section.leftLabel} + ${section.rightLabel}`,
      ),
    ),
  ].join(', ');

  return {
    title: `Sync diff ${result.head.slice(0, 12)}`,
    heading: 'Sync diff',
    views:
      base ?
        [
          '<nav class="views">',
          '<a href="#" data-view="sync">Sync changes</a>',
          `<a href="#base" data-view="base">${escapeHtml(base.branchLabel)} vs ${escapeHtml(base.label)}</a>`,
          '</nav>',
        ]
      : [],
    subtitle: `${escapeHtml(labels)} → <code>${escapeHtml(result.head.slice(0, 12))}</code>`,
    data: {
      kind: 'sync',
      head: result.head,
      storage: {
        // shared by both views and keyed by the merged branches, so it is
        // kept when the sync PR is updated
        viewed: `umbrella-prs:sync-diff-viewed-files:${JSON.stringify(
          result.sections.map((section) => [
            section.leftLabel,
            section.rightLabel,
          ]),
        )}`,
        current: `umbrella-prs:sync-diff-current:${result.head}`,
      },
      github: null,
      base:
        base ?
          viewerSection({
            leftLabel: base.label,
            rightLabel: base.branchLabel,
            compareTo: base.to,
            diff: base.diff,
            contents: base.contents,
          })
        : null,
      sections: result.sections.map((section) => viewerSection(section)),
    },
  };
}

/**
 * Standalone page that renders the sync diff with `@pierre/diffs`. Files can be
 * marked as viewed, saved in the browser per sync PR (the merged branches)
 * until the file diff changes
 */
export function renderSyncDiffHtml(
  result: SyncDiffResult,
  options: { base?: SyncBaseDiff } = {},
): string {
  return renderViewerPage(buildSyncDiffPage(result, options));
}

const mboxCommitRegex = /^From ([0-9a-f]{40}) /m;
const patchSubjectRegex = /^Subject: (?:\[[^\]]*\] *)?(.*)$/m;

export type PatchPageOptions = {
  name: string;
  /** Identifies the diff in the saved viewer state, defaults to `name` */
  id?: string;
  diff: string;
  /** Shown after the name, e.g. what the diff is following */
  note?: string;
  /** PR whose viewed files are synced with GitHub, only when the page is served */
  github?: ViewerGitHub;
};

/**
 * A `.diff` or `.patch` file as a viewer page, one section per commit for
 * `git format-patch` series. Viewed files are saved per `id`
 */
export function buildPatchPage({
  name,
  id = name,
  diff,
  note,
  github,
}: PatchPageOptions): ViewerPage {
  const commits = diff
    .split(new RegExp(`(?=${mboxCommitRegex.source})`, 'm'))
    .filter((part) => mboxCommitRegex.test(part));
  const sections =
    commits.length > 1 ?
      commits.map((commit) =>
        viewerSection({
          leftLabel: '',
          rightLabel: patchSubjectRegex.exec(commit)?.[1] ?? 'Commit',
          compareTo: mboxCommitRegex.exec(commit)?.[1] ?? '',
          diff: commit,
        }),
      )
    : [viewerSection({ leftLabel: '', rightLabel: name, compareTo: '', diff })];

  return {
    title: `Diff ${name}`,
    heading: 'Diff',
    views: [],
    subtitle: `<code>${escapeHtml(name)}</code>${note ? ` ${escapeHtml(note)}` : ''}`,
    data: {
      kind: 'patch',
      head: id,
      storage: {
        viewed: `umbrella-prs:diff-viewed-files:${id}`,
        current: `umbrella-prs:diff-current:${id}`,
      },
      github: github ?? null,
      base: null,
      sections,
    },
  };
}

/** Standalone viewer of a `.diff` or `.patch` file, see `buildPatchPage` */
export function renderPatchHtml(options: PatchPageOptions): string {
  return renderViewerPage(buildPatchPage(options));
}

function viewerSection({
  leftLabel,
  rightLabel,
  compareTo,
  diff,
  conflictedFiles = [],
  contents,
}: {
  leftLabel: string;
  rightLabel: string;
  compareTo: string;
  diff: string;
  conflictedFiles?: string[];
  contents?: SyncDiffContents;
}): ViewerSection {
  return {
    leftLabel,
    rightLabel,
    compareTo,
    conflictedFiles,
    diff,
    contents: contents ?? null,
    importOnlyFiles: getImportOnlyFiles(diff),
  };
}

/**
 * What a served page can't update in place, the page is reloaded when it
 * changes
 */
export function getViewerShell(page: ViewerPage): string {
  return JSON.stringify([
    page.heading,
    page.views,
    page.data.kind,
    page.data.storage.viewed,
    page.data.base !== null,
    page.data.github !== null,
  ]);
}

/** Set when the page is served: it follows the repo and the server saves its state */
export type ViewerLive = {
  /** Changes every time the page changes */
  revision: string;
  /** Saved viewer state, by storage key */
  storage: Record<string, unknown>;
};

/** The page as html, standalone unless `live` is set by the server */
export function renderViewerPage(
  { title, heading, views, subtitle, data }: ViewerPage,
  { live }: { live?: ViewerLive } = {},
): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="${fontsUrl}">`,
    `<style>${styles}${iconStyles}</style>`,
    '<style id="theme-chrome"></style>',
    '</head>',
    '<body>',
    customIconSprite,
    '<header class="top">',
    '<div class="title">',
    `<strong>${escapeHtml(heading)}</strong>`,
    ...views,
    `<span id="subtitle" class="muted">${subtitle}</span>`,
    '<span id="live" class="live hidden"></span>',
    '</div>',
    '<div class="actions">',
    '<span id="progress" class="muted"></span>',
    '<span id="github" class="github hidden">',
    '<button type="button" id="github-toggle">GitHub sync</button>',
    '<span id="github-status" class="muted"></span>',
    '</span>',
    '<span id="nav" class="nav">',
    '<button type="button" id="prev" title="Previous file">← Prev <kbd class="shortcut">p</kbd></button>',
    '<span id="position" class="muted"></span>',
    '<button type="button" id="next" title="Next file">Next → <kbd class="shortcut">n</kbd></button>',
    '<button type="button" id="undo" title="Unmark the last file marked as viewed and go back to it">Undo <kbd class="shortcut">u</kbd></button>',
    '</span>',
    '<label id="imports" class="check"><input type="checkbox" id="hide-imports"> <span id="imports-label"></span></label>',
    '<button type="button" id="mode"></button>',
    '<button type="button" id="diff-style"></button>',
    '<button type="button" id="wrap" title="Wrap long lines">Wrap</button>',
    '<select id="theme" title="Theme"></select>',
    '</div>',
    '</header>',
    '<div class="layout">',
    '<aside id="files">',
    '<div class="search" title="Space separated terms: text, a glob like *.ts or src/**/*.ts, or a /regex/">',
    '<input type="search" id="search" placeholder="Filter: text, *.ts, /regex/" aria-label="Filter files" autocomplete="off" spellcheck="false">',
    '<input type="search" id="exclude" placeholder="Exclude: text, *.test.ts, /regex/" aria-label="Exclude files" autocomplete="off" spellcheck="false">',
    '<div id="search-actions" class="search-actions hidden"><span id="match-count" class="muted"></span><button type="button" id="mark-matches"></button></div>',
    '</div>',
    '<div id="tree"></div>',
    '</aside>',
    '<div id="resizer" class="resizer" title="Drag to resize, double-click to reset"></div>',
    '<main id="review"></main>',
    '</div>',
    '<div id="toast" class="toast hidden" role="status"></div>',
    `<script type="application/json" id="sync-diff-data">${serializeJson(data)}</script>`,
    ...(live ?
      [
        `<script type="application/json" id="viewer-live">${serializeJson({ ...live, shell: getViewerShell({ title, heading, views, subtitle, data }) })}</script>`,
      ]
    : []),
    `<script type="module">import { CodeView, parsePatchFiles, resolveTheme } from '${diffsModuleUrl}';\nimport { colorUtils, normalizeThemeColors } from '${themingColorModuleUrl}';\nimport { createFileTreeIconResolver, getBuiltInSpriteSheet } from '${treesModuleUrl}';\n${script}</script>`,
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

/** File icon colors of `@pierre/trees`, by the icon tokens that use them */
const iconColors: { light: string; dark: string; tokens: string[] }[] = [
  {
    light: '#1a85d4',
    dark: '#69b1ff',
    tokens: [
      'biome',
      'c',
      'cpp',
      'docker',
      'python',
      'typescript',
      'vscode',
      'webpack',
    ],
  },
  {
    light: '#1ca1c7',
    dark: '#68cdf2',
    tokens: ['go', 'oxc', 'react', 'tailwind'],
  },
  {
    light: '#199f43',
    dark: '#5ecc71',
    tokens: ['bash', 'markdown', 'svgo', 'vue', 'test'],
  },
  {
    light: '#693acf',
    dark: '#9d6afb',
    tokens: ['bootstrap', 'css', 'eslint', 'terraform', 'wasm'],
  },
  { light: '#594c5b', dark: '#79697b', tokens: ['bun'] },
  {
    light: '#d47628',
    dark: '#ffa359',
    tokens: ['claude', 'html', 'json', 'rust', 'svg', 'swift', 'zig', 'zip'],
  },
  {
    light: '#d32a61',
    dark: '#ff678d',
    tokens: ['graphql', 'image', 'sass', 'stories'],
  },
  { light: '#a631be', dark: '#d568ea', tokens: ['astro', 'database', 'vite'] },
  {
    light: '#d52c36',
    dark: '#ff6762',
    tokens: ['npm', 'postcss', 'ruby', 'svelte', 'yml'],
  },
  { light: '#17a5af', dark: '#64d1db', tokens: ['mcp', 'prettier', 'table'] },
  {
    light: '#d5a910',
    dark: '#ffd452',
    tokens: ['babel', 'browserslist', 'javascript'],
  },
  { light: '#d5512f', dark: '#ff8c5b', tokens: ['git'] },
];

const iconStyles = iconColors
  .map(
    ({ light, dark, tokens }) =>
      `${tokens.map((token) => `.icon[data-icon-token='${token}']`).join(', ')} { color: light-dark(${light}, ${dark}); }`,
  )
  .join('\n');

/** Icons of test and stories files, which the built-in icons don't tell apart */
const customIconSprite = [
  '<svg aria-hidden="true" width="0" height="0" style="position: absolute">',
  '<symbol id="umbrella-icon-test" viewBox="0 0 16 16">',
  '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M5.5 1.75h5M6.5 1.75v4.5L2.9 12.4a1.2 1.2 0 0 0 1 1.85h8.2a1.2 1.2 0 0 0 1-1.85L9.5 6.25v-4.5"/>',
  '<path fill="currentColor" d="M4.7 9.25h6.6l1.75 3.05a.8.8 0 0 1-.7 1.2H3.65a.8.8 0 0 1-.7-1.2z"/>',
  '</symbol>',
  '<symbol id="umbrella-icon-stories" viewBox="0 0 16 16">',
  '<path fill="currentColor" fill-rule="evenodd" d="M3 2.6c0-.6.45-1.1 1.05-1.1L12.3 1c.4 0 .7.3.7.7v12.6c0 .4-.3.7-.7.7l-8.2-.4A1.15 1.15 0 0 1 3 13.45zM10 1.5v3l-.9-.7-.9.7v-3z"/>',
  '</symbol>',
  '</svg>',
].join('');

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
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width, 300px);
  max-width: 70vw;
  flex-shrink: 0;
  border-right: 1px solid var(--border-opaque);
}
.search { display: flex; flex-direction: column; gap: 4px; padding: 8px 8px 4px; }
.search input {
  width: 100%;
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-opaque);
  border-radius: 6px;
  padding: 2px 8px;
}
.search input:focus { outline: none; border-color: var(--accent); }
.search input.invalid { border-color: var(--deletion); }
.search-actions { display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 12px; }
.search-actions button { padding: 0 8px; }
#tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 8px; }
.resizer {
  position: relative;
  z-index: 1;
  width: 7px;
  margin: 0 -4px 0 -3px;
  flex-shrink: 0;
  cursor: col-resize;
}
.resizer:hover, .resizer.dragging { background: color-mix(in srgb, var(--accent) 50%, transparent); }
body.resizing { cursor: col-resize; user-select: none; }
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
.row .icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--muted); }
.row.viewed .icon { opacity: 0.5; }
.caret {
  width: 14px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 11px;
}
.caret:hover { background: none; }
/* the checkbox takes the full row height and part of the gaps around it */
.row .hit {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  padding: 1px 5px;
  margin: -1px -5px;
  cursor: pointer;
}
.row .hit input { margin: 0; cursor: pointer; }
.children.collapsed { display: none; }
/* collapsed folders open while searching so the matches show */
#tree.searching .children.collapsed { display: block; }
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
/* shortcuts only work in the one file mode */
.shortcut {
  display: none;
  padding: 0 4px;
  border: 1px solid var(--border-opaque);
  border-radius: 4px;
  color: var(--muted);
  font: 11px/1.4 var(--diffs-font-family);
}
body.single .shortcut { display: inline-block; }
.summary { padding: 12px 16px 0; }
.summary p { margin: 0 0 8px; }
.empty { padding: 24px 16px; color: var(--muted); }
.live, .github { display: inline-flex; gap: 6px; align-items: center; }
.live { font-size: 12px; }
.live::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--addition); }
.live.offline::before { background: var(--deletion); }
.github .failed { color: var(--deletion); }
.toast {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 10;
  max-width: calc(100vw - 32px);
  padding: 6px 12px;
  border: 1px solid var(--border-opaque);
  border-radius: 6px;
  background: var(--surface-hover);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.3);
  overflow-wrap: anywhere;
}
@media (max-width: 720px) {
  .layout { flex-direction: column; }
  #files { width: auto; max-height: 30vh; border-right: 0; border-bottom: 1px solid var(--border-opaque); }
  .resizer { display: none; }
}
`;

const script = String.raw`
let data = JSON.parse(document.getElementById('sync-diff-data').textContent);
// set when the page is served: it follows the repo and the server saves the state
const live = JSON.parse(document.getElementById('viewer-live')?.textContent ?? 'null');
// the umbrella diff on top of the base after the sync, or the sync changes
const baseView = location.hash === '#base' && data.base !== null;
let sections = [];

for (const link of document.querySelectorAll('.views a')) {
  link.classList.toggle('active', link.dataset.view === (baseView ? 'base' : 'sync'));
}

window.addEventListener('hashchange', () => void reloadPage());
const viewName = baseView ? 'base' : 'sync';
const viewedKey = data.storage.viewed;
const styleKey = 'umbrella-prs:sync-diff-style';
const modeKey = 'umbrella-prs:sync-diff-mode';
// the selected file, kept across modes and views
let currentKey = data.storage.current;
const importsKey = 'umbrella-prs:sync-diff-hide-imports';
const wrapKey = 'umbrella-prs:sync-diff-wrap';
const sidebarWidthKey = 'umbrella-prs:sync-diff-sidebar-width';
const themeKey = 'umbrella-prs:sync-diff-theme';
const githubSyncKey = 'umbrella-prs:sync-diff-github-sync';

// state changes waiting to be sent to the server
const pendingWrites = {};
let writeTimer = 0;

function flushStorage() {
  clearTimeout(writeTimer);
  writeTimer = 0;

  const keys = Object.keys(pendingWrites);
  if (keys.length === 0) return Promise.resolve();

  const body = JSON.stringify({ entries: pendingWrites });
  for (const key of keys) delete pendingWrites[key];

  // keepalive requests outlive the page, but have a size limit
  return fetch('/storage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: body.length < 60000,
  }).catch(() => {});
}

async function reloadPage() {
  await flushStorage();
  location.reload();
}

window.addEventListener('pagehide', () => void flushStorage());

function readStorage(key, fallback) {
  if (live) return Object.hasOwn(live.storage, key) ? live.storage[key] : fallback;

  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  if (live) {
    live.storage[key] = value;
    pendingWrites[key] = value;
    writeTimer ||= setTimeout(flushStorage, 200);
    return;
  }

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
let multipleSections = false;
let importOnlyCount = 0;

let entries = [];
let entriesByDiff = new Map();
let entriesById = new Map();
// the hash of the diff of each file by view, so marking a file marks it in both
let viewHashes = {};
// item versions, the viewer renders an item again when its version changes
let versionCount = 0;

// the files of the data. Files whose diff did not change keep their diff object
// and version, so the viewer keeps them as they are when the page updates
function loadEntries() {
  const previousById = entriesById;

  sections = baseView ? [data.base] : data.sections;
  multipleSections = sections.length > 1;
  entries = [];
  entriesByDiff = new Map();

  const usedIds = new Set();

  sections.forEach((section, sectionIndex) => {
    if (!section.diff) return;

    const patches = parsePatchFiles(section.diff + '\n', 'section-' + sectionIndex);

    for (const parsed of patches.flatMap((patch) => patch.files)) {
      // a plain diff can have the same file more than once
      let id = sectionIndex + ':' + parsed.name;
      for (let count = 2; usedIds.has(id); count++) id = sectionIndex + ':' + parsed.name + '#' + count;
      usedIds.add(id);

      const json = JSON.stringify({ ...parsed, cacheKey: undefined });
      const signature = hash(json) + ':' + json.length;
      const previous = previousById.get(id);
      const unchanged = previous !== undefined && previous.signature === signature;
      // the viewer renders a diff again when its cache key changes
      const fileDiff = unchanged ? previous.fileDiff : { ...parsed, cacheKey: id + ':' + signature };

      const entry = {
        id,
        section,
        fileDiff,
        signature,
        version: unchanged ? previous.version : ++versionCount,
        collapsed: unchanged ? previous.collapsed : null,
        conflicted: section.conflictedFiles.includes(fileDiff.name),
        importOnly: section.importOnlyFiles.includes(fileDiff.name),
        toggles: [],
        row: null,
      };
      entries.push(entry);
      entriesByDiff.set(fileDiff, entry);
    }
  });

  entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  importOnlyCount = entries.filter((entry) => entry.importOnly).length;

  viewHashes = { [viewName]: hashFiles(entries.map((entry) => entry.fileDiff)) };

  if (baseView) viewHashes.sync = hashFiles(parseViewFiles(data.sections, 'hash-sync-'));
  else if (data.base) viewHashes.base = hashFiles(parseViewFiles([data.base], 'hash-base-'));
}

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

loadEntries();

function isViewed(entry) {
  const name = entry.fileDiff.name;
  return viewed[name]?.[viewName] === viewHashes[viewName].get(name);
}

const iconResolver = createFileTreeIconResolver({ set: 'complete', colored: true });
document.body.insertAdjacentHTML('afterbegin', getBuiltInSpriteSheet('complete'));
const testFileRegex = /\.(test|spec)\.[^/]+$/i;
const storiesFileRegex = /\.(stories|story)\.[^/]+$/i;
const svgNamespace = 'http://www.w3.org/2000/svg';

function fileIcon(path) {
  const icon = testFileRegex.test(path) ? { name: 'umbrella-icon-test', token: 'test' }
    : storiesFileRegex.test(path) ? { name: 'umbrella-icon-stories', token: 'stories' }
    : iconResolver.resolveIcon('file-tree-icon-file', path);
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', icon.viewBox ?? '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  if (icon.token) svg.dataset.iconToken = icon.token;
  const use = document.createElementNS(svgNamespace, 'use');
  use.setAttribute('href', '#' + icon.name);
  svg.append(use);
  return svg;
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

const regexTermRegex = /^\/(.+)\/([a-z]*)$/;
const globCharsRegex = /[*?[\]{}]/;

// a glob as a regex: ** matches across folders, * and ? within a name
function globToRegex(glob) {
  let source = '';
  let braces = 0;

  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];

    if (char === '*' && glob[index + 1] === '*') {
      index++;
      // **/ also matches no folder
      if (glob[index + 1] === '/') {
        index++;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      braces++;
      source += '(?:';
    } else if (char === '}' && braces > 0) {
      braces--;
      source += ')';
    } else if (char === ',' && braces > 0) {
      source += '|';
    } else if (char === '[' && glob.indexOf(']', index + 2) !== -1) {
      const end = glob.indexOf(']', index + 2);
      source += '[' + glob.slice(index + 1, end).replace(/^!/, '^').replaceAll('\\', '\\\\') + ']';
      index = end;
    } else {
      source += char.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
    }
  }

  return new RegExp('^' + source + '$', 'i');
}

// a term of the search: a /regex/, a glob when it has *, ?, [] or {}, or text
// in the path, all ignoring the case. Throws when the regex is invalid
function parseTerm(term) {
  const regexMatch = regexTermRegex.exec(term);

  if (regexMatch) {
    // g and y make test() stateful
    const regex = new RegExp(regexMatch[1], 'i' + regexMatch[2].replace(/[giy]/g, ''));
    return (path) => regex.test(path);
  }

  if (globCharsRegex.test(term)) {
    const regex = globToRegex(term);
    // without a slash it matches the file name in any folder, like in .gitignore
    return term.includes('/') ? (path) => regex.test(path) : (path) => regex.test(path.slice(path.lastIndexOf('/') + 1));
  }

  const text = term.toLowerCase();
  return (path) => path.toLowerCase().includes(text);
}

// the terms of an input, invalid ones are skipped and flag the input
function parseSearchInput(input) {
  let invalid = false;
  const matchers = input.value.split(/\s+/).filter(Boolean).flatMap((term) => {
    try {
      return [parseTerm(term)];
    } catch {
      invalid = true;
      return [];
    }
  });

  input.classList.toggle('invalid', invalid);
  return matchers;
}

// files must match all the filter terms and none of the exclude terms
let includeMatchers = [];
let excludeMatchers = [];

function isSearching() {
  return includeMatchers.length > 0 || excludeMatchers.length > 0;
}

function matchesSearch(entry) {
  const name = entry.fileDiff.name;
  return includeMatchers.every((matches) => matches(name)) && !excludeMatchers.some((matches) => matches(name));
}

// files shown in the tree, the folder checkboxes only act on these
function inTree(entry) {
  return isVisible(entry) && matchesSearch(entry);
}

function visibleEntries() {
  return treeOrder.filter(isVisible);
}

function updateProgress() {
  const visible = visibleEntries();
  progress.textContent = visible.filter(isViewed).length + ' / ' + visible.length + ' viewed';
}

// files marked as viewed, by action, so the last marks can be undone
const viewedHistory = [];

// fromGithub: the files were marked or unmarked in the PR on GitHub
function setViewed(targets, value, { fromGithub = false } = {}) {
  if (value && !fromGithub) viewedHistory.push(targets);

  for (const entry of targets) {
    const name = entry.fileDiff.name;

    if (value) {
      viewed[name] = {
        sync: viewHashes.sync?.get(name),
        base: viewHashes.base?.get(name),
        ...(fromGithub ? { github: true } : {}),
      };
    } else {
      delete viewed[name];
    }

    for (const toggle of entry.toggles) toggle.checked = value;
    entry.row?.classList.toggle('viewed', value);
  }

  writeStorage(viewedKey, viewed);

  if (!fromGithub) {
    sendGithubViewed(
      githubPaths(targets).filter((name) => (githubStates.get(name) === 'VIEWED') !== value),
      value,
    );
  }

  if (mode === 'single') {
    if (fromGithub) {
      render({ anchor: { scrollTop: root.scrollTop } });
      return;
    }

    if (value && current && targets.includes(current)) setCurrent(nextUnviewed(current));
    render();
    return;
  }

  for (const entry of targets) {
    const item = viewer.getItem(entry.id);
    if (item && item.collapsed !== value) {
      entry.version = ++versionCount;
      entry.collapsed = value;
      viewer.updateItem({ ...item, collapsed: value, version: entry.version });
    }
  }

  updateProgress();
  updateTree();
}

// unmarks the last files marked as viewed that still are, and goes back to them
function undoViewed() {
  while (viewedHistory.length > 0) {
    const targets = viewedHistory.pop().filter(isViewed);
    if (targets.length === 0) continue;

    setCurrent(targets[0]);
    setViewed(targets, false);
    return;
  }
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
  current?.row?.scrollIntoView({ block: 'nearest' });
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
// folders collapsed in the tree, kept when the page updates
const collapsedFolders = new Set();
// section titles, hidden while searching when no file of the section matches
const sectionHeaders = [];
// files in the order of the tree, so the diffs follow it
const treeOrder = [];
const tree = document.getElementById('tree');
const noMatches = el('div', { className: 'empty hidden', textContent: 'No matching files' });
const searchActions = document.getElementById('search-actions');
const matchCount = document.getElementById('match-count');
const markMatchesButton = document.getElementById('mark-matches');

// folder checkboxes are checked when all files are viewed, mixed when some are
function updateTree() {
  const searching = isSearching();
  tree.classList.toggle('searching', searching);

  for (const entry of entries) entry.row?.classList.toggle('hidden', !inTree(entry));

  for (const folder of folders) {
    const shown = folder.entries.filter(inTree);
    const count = shown.filter(isViewed).length;
    folder.toggle.checked = shown.length > 0 && count === shown.length;
    folder.toggle.indeterminate = count > 0 && count < shown.length;
    folder.row.classList.toggle('viewed', folder.toggle.checked);
    folder.row.classList.toggle('hidden', shown.length === 0);
  }

  for (const header of sectionHeaders) {
    const hidden = searching && !header.entries.some(inTree);
    for (const node of header.nodes) node.classList.toggle('hidden', hidden);
  }

  const matches = entries.filter(inTree);
  const viewedCount = matches.filter(isViewed).length;
  noMatches.classList.toggle('hidden', !searching || matches.length > 0);
  searchActions.classList.toggle('hidden', !searching || matches.length === 0);
  matchCount.textContent = matches.length + (matches.length === 1 ? ' file, ' : ' files, ') + viewedCount + ' viewed';
  markMatchesButton.textContent = viewedCount === matches.length ? 'Unmark all' : 'Mark all as viewed';
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

function renderTree(node, depth, parentKey) {
  const nodes = [];

  for (const child of [...node.folders.values()].sort(byName)) {
    const folder = compactFolder(child);
    const key = parentKey + folder.name + '/';
    const startCollapsed = collapsedFolders.has(key);
    const toggle = el('input', { type: 'checkbox' });
    const caret = el('button', {
      type: 'button',
      className: 'caret',
      textContent: startCollapsed ? '▸' : '▾',
      title: startCollapsed ? 'Expand' : 'Collapse',
    });
    const children = el(
      'div',
      { className: 'children' + (startCollapsed ? ' collapsed' : '') },
      renderTree(folder, depth + 1, key),
    );
    const row = el('div', { className: 'row folder' }, [
      caret,
      el('label', { className: 'hit', title: 'Mark the folder as viewed' }, [toggle]),
      el('span', { className: 'name', textContent: folder.name + '/', title: folder.name }),
    ]);
    row.style.paddingLeft = 4 + depth * 14 + 'px';

    const record = { toggle, row, children, entries: folderEntries(folder) };
    folders.push(record);

    toggle.addEventListener('change', () => {
      setViewed(record.entries.filter(inTree), toggle.checked);
    });
    caret.addEventListener('click', () => {
      const collapsed = children.classList.toggle('collapsed');
      caret.textContent = collapsed ? '▸' : '▾';
      caret.title = collapsed ? 'Expand' : 'Collapse';
      if (collapsed) collapsedFolders.add(key);
      else collapsedFolders.delete(key);
    });

    nodes.push(row, children);
  }

  for (const file of [...node.files].sort(byName)) {
    const { entry } = file;
    treeOrder.push(entry);
    const name = el('button', { type: 'button', className: 'name', textContent: file.name, title: entry.fileDiff.name });
    name.addEventListener('click', () => select(entry));

    entry.row = el('div', { className: 'row file' + (isViewed(entry) ? ' viewed' : '') }, [
      el('label', { className: 'hit', title: 'Mark as viewed' }, [createToggle(entry)]),
      fileIcon(entry.fileDiff.name),
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
  folders.length = 0;
  sectionHeaders.length = 0;
  treeOrder.length = 0;
  tree.replaceChildren();

  for (const [sectionIndex, section] of sections.entries()) {
    const sectionEntries = entries.filter((entry) => entry.section === section);
    const nodes = [];

    if (multipleSections) {
      nodes.push(
        el('div', {
          className: 'section-title',
          textContent: section.rightLabel + (section.compareTo ? ' (' + section.compareTo.slice(0, 12) + ')' : ''),
        }),
      );
    }

    if (sectionEntries.length === 0) {
      nodes.push(el('div', { className: 'section-title', textContent: 'No changes' }));
    }

    sectionHeaders.push({ nodes, entries: sectionEntries });
    tree.append(...nodes, ...renderTree(buildTree(sectionEntries), 0, sectionIndex + ':'));
  }

  tree.append(noMatches);
}

const emptyNote = el('p', { className: 'empty hidden' });
const summary = el('div', { className: 'summary' });

function renderSummary() {
  summary.replaceChildren();

  if (baseView) {
    summary.append(
      el('p', {
        textContent: 'The files changed by the sync compared with ' + data.base.leftLabel +
          ', as the ' + data.base.rightLabel + ' PR shows them once the sync PR is merged. ' + entries.length + ' files.',
      }),
      emptyNote,
    );

    return;
  }

  if (data.kind === 'patch') {
    summary.append(
      el('p', {
        textContent: entries.length + (entries.length === 1 ? ' file' : ' files') + ' changed' +
          (multipleSections ? ' in ' + sections.length + ' commits.' : '.'),
      }),
      emptyNote,
    );

    return;
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

renderSummary();

// the options that depend on the data
function dataOptionsKey() {
  return sections.some((section) => section.contents) + ':' + multipleSections;
}

let optionsKey = dataOptionsKey();

function viewerOptions() {
  return {
    theme: theme.light ? { light: theme.light, dark: theme.dark } : theme.id,
    themeType: theme.light ? 'system' : themeTypes.get(theme.id) ?? 'dark',
    overflow: wrap ? 'wrap' : 'scroll',
    diffStyle,
    stickyHeaders: true,
    // lines are selected by clicking and dragging their numbers
    enableLineSelection: true,
    onSelectedLinesChange: (selection) => {
      const mention = selection ? selectionMention(selection) : null;
      if (mention) showToast('Press ' + mentionShortcut + ' to copy ' + mention.text);
    },
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
      return el('label', { className: 'viewed-toggle', title: 'Mark as viewed' }, [
        ...(entry.conflicted ? [el('span', { className: 'badge', textContent: 'conflict' })] : []),
        createToggle(entry),
        'Viewed',
        el('kbd', { className: 'shortcut', textContent: 'v' }),
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
const undoButton = document.getElementById('undo');
const position = document.getElementById('position');
const importsToggle = document.getElementById('hide-imports');

// the file at the top of the view and how far it is scrolled, restored when
// the page updates
function scrollAnchor() {
  const top = mode === 'all' ? topEntry() : null;
  const itemTop = top ? viewer.getTopForItem(top.id) : undefined;

  return itemTop === undefined
    ? { scrollTop: root.scrollTop }
    : { id: top.id, offset: root.scrollTop - itemTop, scrollTop: root.scrollTop };
}

function restoreScroll(anchor) {
  // after CodeView lays out the new items
  requestAnimationFrame(() => {
    const itemTop = anchor.id === undefined ? undefined : viewer.getTopForItem(anchor.id);
    root.scrollTop = itemTop === undefined ? anchor.scrollTop : itemTop + anchor.offset;
  });
}

// anchor: keeps the scroll position and the files that did not change as they are
function render({ anchor = null } = {}) {
  const visible = visibleEntries();

  if (mode === 'single' && (!current || !isVisible(current))) {
    setCurrent(visible.find((entry) => !isViewed(entry)) ?? visible[0] ?? null);
  }

  for (const entry of entries) entry.row?.classList.toggle('current', entry === current);

  const items = mode === 'single' ? (current ? [current] : []) : visible;

  viewer.setItems(items.map((entry) => {
    const collapsed = mode === 'all' && isViewed(entry);
    if (!anchor || entry.collapsed !== collapsed) entry.version = ++versionCount;
    entry.collapsed = collapsed;

    return { id: entry.id, type: 'diff', fileDiff: entry.fileDiff, collapsed, version: entry.version };
  }));

  if (anchor) restoreScroll(anchor);
  else if (mode === 'single') root.scrollTop = 0;
  else if (current && isVisible(current)) scrollToCurrent();

  emptyNote.textContent = entries.length > 0 ? 'All the changes are import-only.'
    : baseView ? 'There are no changes on top of ' + data.base.leftLabel + '.'
    : data.kind === 'patch' ? 'The diff has no file changes.'
    : 'The PR matches the automatic merge, there are no conflict resolutions or manual edits.';
  emptyNote.classList.toggle('hidden', visible.length > 0);

  const index = visible.indexOf(current);
  nav.classList.toggle('hidden', mode !== 'single' || visible.length === 0);
  position.textContent = index + 1 + ' / ' + visible.length;
  prevButton.disabled = index <= 0;
  nextButton.disabled = index >= visible.length - 1;
  undoButton.disabled = !viewedHistory.some((targets) => targets.some(isViewed));

  document.body.classList.toggle('single', mode === 'single');
  modeButton.textContent = mode === 'single' ? 'All files' : 'One file';
  modeButton.title = mode === 'single' ? 'Show all the files' : 'Review one file at a time';
  styleButton.textContent = diffStyle === 'split' ? 'Unified' : 'Split';
  wrapButton.setAttribute('aria-pressed', String(wrap));

  updateProgress();
  updateTree();
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
undoButton.addEventListener('click', undoViewed);

function updateImportsToggle() {
  document.getElementById('imports').classList.toggle('hidden', importOnlyCount === 0);
  document.getElementById('imports-label').textContent =
    'Hide import-only (' + importOnlyCount + ')';
}

updateImportsToggle();
importsToggle.checked = hideImportOnly;
importsToggle.addEventListener('change', () => {
  hideImportOnly = importsToggle.checked;
  writeStorage(importsKey, hideImportOnly);
  render();
});

const searchInput = document.getElementById('search');
const excludeInput = document.getElementById('exclude');

for (const input of [searchInput, excludeInput]) {
  input.addEventListener('input', () => {
    includeMatchers = parseSearchInput(searchInput);
    excludeMatchers = parseSearchInput(excludeInput);
    updateTree();
    current?.row?.scrollIntoView({ block: 'nearest' });
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    } else {
      input.blur();
    }
  });
}

// marks the files that match the search, or unmarks them when all are viewed
markMatchesButton.addEventListener('click', () => {
  const matches = entries.filter(inTree);
  setViewed(matches, !matches.every(isViewed));
});

const filesAside = document.getElementById('files');
const resizer = document.getElementById('resizer');

function setSidebarWidth(width) {
  if (width === null) {
    document.documentElement.style.removeProperty('--sidebar-width');
    return;
  }

  const clamped = Math.round(Math.max(160, Math.min(width, window.innerWidth * 0.7)));
  document.documentElement.style.setProperty('--sidebar-width', clamped + 'px');
}

setSidebarWidth(readStorage(sidebarWidthKey, null));

resizer.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();

  const startX = event.clientX;
  const startWidth = filesAside.getBoundingClientRect().width;
  resizer.setPointerCapture(event.pointerId);
  resizer.classList.add('dragging');
  document.body.classList.add('resizing');

  function onMove(moveEvent) {
    setSidebarWidth(startWidth + moveEvent.clientX - startX);
  }

  function onEnd() {
    resizer.removeEventListener('pointermove', onMove);
    resizer.removeEventListener('pointerup', onEnd);
    resizer.removeEventListener('pointercancel', onEnd);
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    writeStorage(sidebarWidthKey, Math.round(filesAside.getBoundingClientRect().width));
  }

  resizer.addEventListener('pointermove', onMove);
  resizer.addEventListener('pointerup', onEnd);
  resizer.addEventListener('pointercancel', onEnd);
});

resizer.addEventListener('dblclick', () => {
  setSidebarWidth(null);
  writeStorage(sidebarWidthKey, null);
});

const toast = document.getElementById('toast');
let toastTimer = 0;

function showToast(text) {
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

const mentionShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⇧M' : 'Ctrl+Shift+M';

// the selected lines as a mention for an agent: @path#L10-12
function selectionMention(selection) {
  const entry = entriesById.get(selection.id);
  if (!entry) return null;

  const { start, end, side, endSide } = selection.range;
  const first = Math.min(start, end);
  const last = Math.max(start, end);

  return {
    text: '@' + entry.fileDiff.name + '#L' + first + (last === first ? '' : '-' + last),
    // lines of the old version, when only removed lines are selected
    old: side === 'deletions' && (endSide ?? side) === 'deletions',
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // the clipboard API is not available, e.g. the page is not focused
    const field = el('textarea', { value: text });
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
}

// copies the mention of the selected lines, or of the current file without them
async function copyMention() {
  const selection = viewer.getSelectedLines();
  const mention = selection ? selectionMention(selection)
    : current ? { text: '@' + current.fileDiff.name, old: false }
    : null;

  if (!mention) {
    showToast('Select lines by clicking their numbers to copy a mention');
    return;
  }

  await copyText(mention.text);
  showToast('Copied: ' + mention.text + (mention.old ? ' (lines of the old version)' : ''));
}

document.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyM' || !event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey)) return;

  event.preventDefault();
  void copyMention();
});

document.addEventListener('keydown', (event) => {
  if (mode !== 'single' || event.metaKey || event.ctrlKey || event.altKey) return;
  // checkboxes keep the focus after a click, only typing fields take the keys
  if (event.target instanceof HTMLElement && event.target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]')) return;

  if (event.key === 'n') move(1);
  else if (event.key === 'p') move(-1);
  else if (event.key === 'v' && current) setViewed([current], !isViewed(current));
  else if (event.key === 'u') undoViewed();
});

const githubBox = document.getElementById('github');
const githubToggle = document.getElementById('github-toggle');
const githubStatus = document.getElementById('github-status');
let githubSync = readStorage(githubSyncKey, true);
// viewed state on GitHub of the PR files by path, null until it loads
let githubStates = null;
let githubError = null;
let githubLoadedAt = 0;
// requests run one at a time, so the marks reach GitHub in order
let githubQueue = Promise.resolve();
// marks sent to GitHub, a response from before a mark is outdated
let githubMarks = 0;

function githubEnabled() {
  return live !== null && data.github !== null && githubSync;
}

async function githubRequest(options) {
  const response = await fetch('/github/viewed', options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'The GitHub request failed');
  return body;
}

// files of the PR on GitHub whose local diff is what GitHub has, files with
// changes that were not pushed are not synced
function githubPaths(targets) {
  if (!githubEnabled() || githubStates === null) return [];

  const unpushed = new Set(data.github.unpushed);

  return [...new Set(targets.map((entry) => entry.fileDiff.name))].filter(
    (name) => githubStates.has(name) && !unpushed.has(name),
  );
}

function sendGithubViewed(paths, value) {
  if (paths.length === 0) return;

  githubMarks++;
  for (const path of paths) githubStates.set(path, value ? 'VIEWED' : 'UNVIEWED');

  githubQueue = githubQueue.then(async () => {
    try {
      await githubRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths, viewed: value }),
      });
      githubError = null;

      if (value) {
        for (const path of paths) {
          if (viewed[path]) viewed[path].github = true;
        }
        writeStorage(viewedKey, viewed);
      }
    } catch (error) {
      githubError = error.message;
      // unknown until the next load, which sends the marks again
      for (const path of paths) githubStates?.delete(path);
    }

    updateGithubStatus();
  });
}

// makes both sides match: files viewed on GitHub are marked here and files
// viewed here are marked on GitHub. Files marked on both sides and then
// unmarked on GitHub are unmarked here
function reconcileGithub() {
  if (!githubEnabled() || githubStates === null) return;

  const unpushed = new Set(data.github.unpushed);
  const mark = new Set();
  const marked = [];
  const unmarked = [];
  let confirmed = false;

  for (const entry of entries) {
    const name = entry.fileDiff.name;
    const state = githubStates.get(name);
    if (state === undefined || unpushed.has(name)) continue;

    if (!isViewed(entry)) {
      if (state === 'VIEWED') marked.push(entry);
    } else if (state === 'VIEWED') {
      if (!viewed[name].github) {
        viewed[name].github = true;
        confirmed = true;
      }
    } else if (state === 'UNVIEWED' && viewed[name].github) {
      unmarked.push(entry);
    } else {
      // not marked yet, or dismissed by a push with the changes viewed here
      mark.add(name);
    }
  }

  if (confirmed) writeStorage(viewedKey, viewed);
  if (marked.length > 0) setViewed(marked, true, { fromGithub: true });
  if (unmarked.length > 0) setViewed(unmarked, false, { fromGithub: true });
  sendGithubViewed([...mark], true);
  updateGithubStatus();
}

function loadGithubViewed() {
  if (!githubEnabled()) return;

  githubLoadedAt = Date.now();
  githubQueue = githubQueue.then(async () => {
    const marks = githubMarks;

    try {
      const body = await githubRequest();
      if (marks !== githubMarks || !githubEnabled()) return;

      githubStates = new Map(Object.entries(body.files));
      githubError = null;
      reconcileGithub();
    } catch (error) {
      githubError = error.message;
    }

    updateGithubStatus();
  });
}

function updateGithubStatus() {
  const available = live !== null && data.github !== null;
  githubBox.classList.toggle('hidden', !available);
  if (!available) return;

  githubToggle.setAttribute('aria-pressed', String(githubSync));
  githubToggle.title = githubSync
    ? 'Files marked as viewed here are marked as viewed in PR #' + data.github.pr + ' on GitHub, and the other way around. Click to stop'
    : 'Sync the viewed files with PR #' + data.github.pr + ' on GitHub';
  githubStatus.classList.toggle('failed', githubSync && githubError !== null);

  if (!githubSync) {
    githubStatus.textContent = 'off';
    githubStatus.title = '';
  } else if (githubError !== null) {
    githubStatus.textContent = 'failed';
    githubStatus.title = githubError;
  } else if (githubStates === null) {
    githubStatus.textContent = 'loading…';
    githubStatus.title = '';
  } else {
    const unpushed = new Set(data.github.unpushed);
    const names = [...new Set(entries.map((entry) => entry.fileDiff.name))];
    const synced = names.filter((name) => githubStates.has(name) && !unpushed.has(name));
    const notPushed = names.filter((name) => unpushed.has(name));
    githubStatus.textContent =
      synced.filter((name) => githubStates.get(name) === 'VIEWED').length + ' / ' + synced.length + ' viewed on GitHub' +
      (notPushed.length > 0 ? ', ' + notPushed.length + ' not pushed' : '');
    githubStatus.title = notPushed.length > 0
      ? 'Files with changes that were not pushed are synced after the push:\n' + notPushed.join('\n')
      : '';
  }
}

githubToggle.addEventListener('click', () => {
  githubSync = !githubSync;
  writeStorage(githubSyncKey, githubSync);
  githubError = null;
  updateGithubStatus();
  loadGithubViewed();
});

// picks up the files marked on GitHub meanwhile
window.addEventListener('focus', () => {
  if (Date.now() - githubLoadedAt > 15000) loadGithubViewed();
});

const liveBadge = document.getElementById('live');
const subtitle = document.getElementById('subtitle');

function setLiveStatus(connected) {
  liveBadge.classList.remove('hidden');
  liveBadge.classList.toggle('offline', !connected);
  liveBadge.textContent = connected ? 'Live' : 'Disconnected';
  liveBadge.title = connected
    ? 'The diff updates when the repo changes'
    : 'The viewer server stopped, run the command again to follow the repo';
}

// shows the new data in place, keeping the scroll position and the selected file
function applyData(next) {
  const anchor = scrollAnchor();
  const previous = current;
  const history = viewedHistory.map((targets) => targets.map((entry) => entry.id));
  const githubHead = data.github?.head;

  live.revision = next.revision;
  data = next.data;
  document.title = next.title;
  subtitle.innerHTML = next.subtitle;
  currentKey = data.storage.current;

  loadEntries();
  renderSidebar();
  renderSummary();
  updateImportsToggle();

  viewedHistory.splice(
    0,
    viewedHistory.length,
    ...history
      .map((ids) => ids.flatMap((id) => entriesById.get(id) ?? []))
      .filter((targets) => targets.length > 0),
  );
  current = previous === null ? null
    : entriesById.get(previous.id) ?? entries.find((entry) => entry.fileDiff.name === previous.fileDiff.name) ?? null;

  if (dataOptionsKey() !== optionsKey) {
    optionsKey = dataOptionsKey();
    viewer.setOptions(viewerOptions());
  }

  render({ anchor });

  // a push changes what GitHub has
  if (data.github?.head !== githubHead) loadGithubViewed();
  else reconcileGithub();
}

let updating = false;
let updateQueued = false;

async function loadUpdate() {
  if (updating) {
    updateQueued = true;
    return;
  }

  updating = true;

  try {
    const next = await (await fetch('/data')).json();

    if (next.shell !== live.shell) {
      await reloadPage();
      return;
    }

    if (next.revision !== live.revision) applyData(next);
  } catch {
    // the server stopped, the events reconnect when it is back
  } finally {
    updating = false;

    if (updateQueued) {
      updateQueued = false;
      void loadUpdate();
    }
  }
}

function followServer() {
  const events = new EventSource('/events');

  events.addEventListener('open', () => setLiveStatus(true));
  events.addEventListener('error', () => setLiveStatus(false));
  events.addEventListener('message', (event) => {
    setLiveStatus(true);
    if (JSON.parse(event.data).revision !== live.revision) void loadUpdate();
  });
}

renderSidebar();

const savedName = readStorage(currentKey, null);
setCurrent(entries.find((entry) => entry.fileDiff.name === savedName) ?? null);

viewer.setup(root);
render();
void applyTheme();
updateGithubStatus();
loadGithubViewed();
if (live) followServer();
`;
