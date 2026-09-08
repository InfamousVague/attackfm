/**
 * A static server that honours Range requests.
 *
 * Python's `http.server` - the reflex reach for "serve this folder" - answers
 * no byte ranges at all, and Chrome cannot seek inside a media file served
 * without 206s: every seek the app made landed on 0, which reads in a test log
 * exactly like a broken scrubber. This is the fix, carried over from the
 * scratch rig where it was first written, and committed so nobody has to
 * rediscover it a third time.
 *
 * It serves the BUILT bundle (`dist/`), not the dev server. That is what
 * ships, it is what the OTA bundle is made of, and it is what every other
 * harness in this repo verifies against - a dev-server-only pass has already
 * proved nothing about the artifact on anybody's phone.
 *
 * Runnable on its own (`node e2e/serve.ts <dir>`), which prints the port it
 * chose, for the same hand-driven poking the scratch rigs are used for.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticServer {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Serves `root` on an ephemeral loopback port.
 *
 * The port is never fixed: two suites will run concurrently one day, and a
 * harness that assumes 8080 is a harness that fails on a machine where
 * something else already has it. Bind 0, ask the socket what it got.
 */
export function startStatic(root: string): Promise<StaticServer> {
  const base = resolve(root);

  const server: Server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400);
      return res.end('bad request');
    }

    let path = normalize(join(base, decodeURIComponent(url.pathname)));
    // Directory traversal, in a server that is pointed at a build output on a
    // developer's laptop. Cheap to refuse, expensive to explain later.
    if (path !== base && !path.startsWith(`${base}/`)) {
      res.writeHead(403);
      return res.end('forbidden');
    }

    let stat: ReturnType<typeof statSync> | null;
    try {
      stat = statSync(path);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) {
      path = join(path, 'index.html');
      try {
        stat = statSync(path);
      } catch {
        stat = null;
      }
    }
    // An app shell, so a path with no file behind it and no extension is a
    // route, not a 404. Anything WITH an extension that is missing stays a
    // 404, or a mistyped asset silently becomes the index and the failure
    // surfaces three layers away as "unexpected token <".
    if (!stat && !extname(path)) {
      path = join(base, 'index.html');
      try {
        stat = statSync(path);
      } catch {
        stat = null;
      }
    }
    if (!stat?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }

    const size = stat.size;
    const headers: Record<string, string | number> = {
      'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      // Never cached. A run that reuses the previous run's bundle is a run
      // that proves nothing about the change under test.
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    };

    const asked = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (asked) {
      const [, from, to] = asked;
      // `bytes=-500` is the LAST 500 bytes, not the first. Getting this
      // backwards serves the head of the file for a tail request, which a
      // media element reads as a corrupt container.
      const start = from ? Number(from) : Math.max(0, size - Number(to || size));
      const end = from ? (to ? Math.min(Number(to), size - 1) : size - 1) : size - 1;
      if (!Number.isFinite(start) || start >= size || start > end) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(path, { start, end }).pipe(res);
    }

    res.writeHead(200, { ...headers, 'content-length': size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).pipe(res);
  });

  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        return fail(new Error('static server: no port'));
      }
      done({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      });
    });
  });
}

// Hand-driven use: `node e2e/serve.ts dist` prints the port and stays up.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startStatic(process.argv[2] ?? 'dist').then((s) => {
    process.stdout.write(`${s.port}\n`);
  });
}
