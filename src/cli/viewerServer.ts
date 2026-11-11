import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FileViewedState } from '../github';
import {
  getViewerShell,
  renderViewerPage,
  viewerPrefKeys,
  type ViewerPage,
} from '../syncDiffHtml';
import { isRecord } from '../utils.typeGuards';

export const defaultViewerPort = 4783;

/** Ports tried after the default one, when other viewers are running */
const portAttempts = 20;
const maxBodyBytes = 10_000_000;
const heartbeatMs = 25_000;

export class PortInUseError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(`Port ${port} is in use`);
    this.name = 'PortInUseError';
    this.port = port;
  }
}

/** Reads and changes the files the user marked as viewed in a PR on GitHub */
export type ViewerGitHubSync = {
  getViewed: () => Promise<Record<string, FileViewedState>>;
  setViewed: (paths: string[], viewed: boolean) => Promise<void>;
};

export type ViewerServer = {
  url: string;
  /** Shows another version of the page, open pages update in place */
  setPage: (page: ViewerPage) => void;
  close: () => Promise<void>;
};

/**
 * File with the viewer state: preferences and viewed files. It is kept by the
 * server and not by the browser, so it doesn't depend on the port
 */
export function getViewerStoragePath(
  env: Record<string, string | undefined>,
): string {
  return path.join(
    env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'),
    'umbrella-prs',
    'viewer.json',
  );
}

function readStorage(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));

    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function writeStorage(file: string, entries: Record<string, unknown>) {
  // read again, other viewers write to the same file
  const storage = { ...readStorage(file), ...entries };
  const temp = `${file}.${process.pid}.tmp`;

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temp, JSON.stringify(storage));
  renameSync(temp, file);
}

/** The port the server listens on, `null` when the port is in use */
function listen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    function onError(error: NodeJS.ErrnoException) {
      server.off('listening', onListening);

      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    }

    function onListening() {
      server.off('error', onError);

      const address = server.address();

      resolve(typeof address === 'object' && address ? address.port : port);
    }

    server.once('error', onError);
    server.once('listening', onListening);
    // not reachable from other machines
    server.listen(port, '127.0.0.1');
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) continue;

    size += chunk.length;

    if (size > maxBodyBytes) throw new Error('The request is too big');

    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

/**
 * Serves a viewer page on localhost. The page gets the changes of `setPage`
 * through server-sent events, saves its state in `storagePath` and syncs the
 * viewed files with `github`
 */
export async function startViewerServer({
  page: initialPage,
  port,
  storagePath,
  github,
}: {
  page: ViewerPage;
  /** `undefined` uses the default port, or the next free one. `0` any free port */
  port: number | undefined;
  storagePath: string;
  github?: ViewerGitHubSync;
}): Promise<ViewerServer> {
  let page = initialPage;
  let pageJson = JSON.stringify(page);
  // pages of a previous server on the same port see a new revision
  const instance = Date.now().toString(36);
  let revisionCount = 0;
  let allowedHosts = new Set<string>();
  const clients = new Set<ServerResponse>();

  function revision() {
    return `${instance}-${revisionCount}`;
  }

  function event() {
    return `data: ${JSON.stringify({ revision: revision() })}\n\n`;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // requests of other sites made to look local (DNS rebinding) have their host
    if (!allowedHosts.has(req.headers.host ?? '')) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const isJsonPost =
      req.method === 'POST' &&
      // not a content type other sites can post without a CORS preflight
      (req.headers['content-type'] ?? '').startsWith('application/json');

    if (req.method === 'GET' && pathname === '/') {
      const storage = readStorage(storagePath);
      const saved: Record<string, unknown> = {};

      for (const key of [
        ...viewerPrefKeys,
        page.data.storage.viewed,
        page.data.storage.current,
      ]) {
        if (key in storage) saved[key] = storage[key];
      }

      send(
        res,
        200,
        'text/html; charset=utf-8',
        renderViewerPage(page, {
          live: { revision: revision(), storage: saved },
        }),
      );
      return;
    }

    if (req.method === 'GET' && pathname === '/data') {
      sendJson(res, 200, {
        revision: revision(),
        shell: getViewerShell(page),
        title: page.title,
        subtitle: page.subtitle,
        data: page.data,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(event());
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (isJsonPost && pathname === '/storage') {
      const body = await readJsonBody(req);

      if (!isRecord(body) || !isRecord(body.entries)) {
        sendJson(res, 400, { error: 'Expected { entries }' });
        return;
      }

      writeStorage(storagePath, body.entries);
      sendJson(res, 200, {});
      return;
    }

    if (github && req.method === 'GET' && pathname === '/github/viewed') {
      sendJson(res, 200, { files: await github.getViewed() });
      return;
    }

    if (github && isJsonPost && pathname === '/github/viewed') {
      const body = await readJsonBody(req);

      if (
        !isRecord(body) ||
        !Array.isArray(body.paths) ||
        typeof body.viewed !== 'boolean'
      ) {
        sendJson(res, 400, { error: 'Expected { paths, viewed }' });
        return;
      }

      await github.setViewed(
        body.paths.filter((item) => typeof item === 'string'),
        body.viewed,
      );
      sendJson(res, 200, {});
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }

      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  let listeningPort: number | null = null;
  const firstPort = port ?? defaultViewerPort;

  for (
    let attempt = 0;
    listeningPort === null && attempt < (port === undefined ? portAttempts : 1);
    attempt++
  ) {
    listeningPort = await listen(server, firstPort + attempt);
  }

  if (listeningPort === null) throw new PortInUseError(firstPort);

  allowedHosts = new Set([
    `localhost:${listeningPort}`,
    `127.0.0.1:${listeningPort}`,
  ]);

  // keeps the connections open through proxies and lets closed ones be noticed
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, heartbeatMs);

  heartbeat.unref();

  return {
    url: `http://localhost:${listeningPort}`,

    setPage(next) {
      const json = JSON.stringify(next);

      if (json === pageJson) return;

      page = next;
      pageJson = json;
      revisionCount++;

      for (const client of clients) client.write(event());
    },

    close() {
      clearInterval(heartbeat);

      for (const client of clients) client.end();

      clients.clear();

      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
