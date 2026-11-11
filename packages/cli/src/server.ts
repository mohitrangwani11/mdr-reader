import http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { watch } from 'chokidar';
import { createWorkspace, NotFound, type WatchFactory } from './workspace.ts';
import { Store } from './store.ts';

export interface ServerOptions {
  /** Absolute path to a file or folder. */
  target: string;
  port: number;
  showAll: boolean;
  publicDir: string;
  store?: Store;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** File watching for the CLI: chokidar on the root (or the single file). */
export const chokidarWatch: WatchFactory = (t) => {
  const w = watch(t.singleFile ?? t.root, { ignoreInitial: true, ignored: (p: string) => t.ignored(p) });
  w.on('add', (p) => t.onFs('add', p)).on('change', (p) => t.onFs('change', p)).on('unlink', (p) => t.onFs('unlink', p));
  w.on('error', () => {});
  return { add: (abs) => void w.add(abs), close: () => w.close() };
};

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const ws = await createWorkspace({ target: opts.target, store: opts.store, watch: chokidarWatch });
  const token = randomBytes(16).toString('hex');
  const clients = new Set<http.ServerResponse>();
  ws.onEvent((msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) c.write(line);
  });

  /* ---- http -------------------------------------------------------------------- */
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 403, 'Forbidden host');

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (url.searchParams.get('t') !== token) return send(res, 403, 'Missing or wrong token. Use the URL printed by mdr.');
        const html = await readFile(path.join(opts.publicDir, 'index.html'), 'utf8');
        const config = { token, mode: ws.mode, showAll: opts.showAll, root: path.basename(ws.root) };
        return send(res, 200, html.replace('/*MDR_CONFIG*/', `window.MDR_CONFIG=${JSON.stringify(config).replace(/</g, '\\u003c')};`), 'text/html; charset=utf-8');
      }
      if (url.pathname === '/app.js' || url.pathname === '/app.css') {
        const body = await readFile(path.join(opts.publicDir, url.pathname.slice(1)));
        return send(res, 200, body, url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found');

      const tok = req.headers['x-mdr-token'] ?? url.searchParams.get('t');
      if (tok !== token) return send(res, 403, 'Forbidden');
      const p = url.searchParams.get('p');

      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write('retry: 1000\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        case 'GET /api/files':
          return json(res, await ws.listFiles());
        case 'GET /api/file':
          return send(res, 200, await ws.readFile(p), 'text/plain; charset=utf-8');
        case 'GET /api/import':
          return json(res, await ws.resolveImport(url.searchParams.get('from'), url.searchParams.get('ref')));
        case 'GET /api/baseline':
          return json(res, { text: await ws.getBaseline(p) });
        case 'POST /api/read': {
          if (!(await ws.readable(p))) return send(res, 404, 'Not found');
          await ws.markRead(p, await body(req));
          return json(res, { ok: true });
        }
        case 'GET /api/state':
          return json(res, { value: (await ws.getState(url.searchParams.get('k') ?? '')) ?? null });
        case 'POST /api/state': {
          const k = url.searchParams.get('k');
          if (!k) return send(res, 400, 'Missing key');
          await ws.setState(k, JSON.parse(await body(req)));
          return json(res, { ok: true });
        }
        default:
          return send(res, 404, 'Not found');
      }
    } catch (e) {
      if (!res.headersSent) send(res, e instanceof NotFound ? 404 : 500, e instanceof NotFound ? 'Not found' : (e as Error).message);
    }
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);

  const port = await listen(server, opts.port);
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    token,
    async close() {
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      await ws.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && port !== 0) {
        server.off('error', onError);
        listen(server, 0).then(resolve, reject);
      } else reject(e);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as { port: number }).port);
    });
  });
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function json(res: http.ServerResponse, data: unknown) {
  send(res, 200, JSON.stringify(data), 'application/json');
}

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
