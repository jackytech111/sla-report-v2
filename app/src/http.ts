// HTTP layer: routing, error mapping and JSON responses (docs/contract.md). No framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from './types.ts';
import type { Store } from './store.ts';
import { BadRequest, parseBrowseParams, parseReportParams } from './validate.ts';
import { browse, buildReport, SnapshotCache } from './query.ts';
import { createCursorCodec } from './cursor.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(here, '..', 'public', 'index.html'));

export interface AppDeps {
  store: Store;
  log: Logger;
  cache?: SnapshotCache;
  codec?: ReturnType<typeof createCursorCodec>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

export function createHandler(deps: AppDeps): http.RequestListener {
  const { store, log } = deps;
  const cache = deps.cache ?? new SnapshotCache();
  const codec = deps.codec ?? createCursorCodec();
  const nameOf = (id: number) => store.nameOf(id);

  return (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });

      switch (url.pathname) {
        case '/health':
          return send(res, 200, { ok: true });
        case '/ready':
          return store.ready ? send(res, 200, { ready: true }) : send(res, 503, { ready: false });
        case '/':
        case '/index.html':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': indexHtml.length });
          return res.end(indexHtml);
        case '/api/sla-report': {
          const { from, to } = parseReportParams(url.searchParams); // 400 before 503: bad input is bad either way
          if (!store.ready) return send(res, 503, { error: 'not ready: initial sync in progress' });
          return send(res, 200, buildReport(store.snapshot().rows, from, to, nameOf));
        }
        case '/api/requests': {
          const params = parseBrowseParams(url.searchParams);
          if (!store.ready) return send(res, 503, { error: 'not ready: initial sync in progress' });
          return send(res, 200, browse({ params, current: store.snapshot(), cache, codec, nameOf }));
        }
        default:
          return send(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (err instanceof BadRequest) return send(res, 400, { error: err.message });
      log.warn('request failed', { path: url.pathname, error: String((err as Error)?.stack ?? err) });
      return send(res, 500, { error: 'internal error' });
    } finally {
      log.debug('http', { path: url.pathname, ms: Math.round(performance.now() - started) });
    }
  };
}
