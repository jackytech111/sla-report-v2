// Entry point: HTTP server comes up immediately (/health), sync runs in the background (/ready flips when done).
import http from 'node:http';
import { log } from './log.ts';
import { HelpdeskClient } from './helpdesk.ts';
import { Store } from './store.ts';
import { Sync } from './sync.ts';
import { computeRow } from './rules.ts';
import { createHandler } from './http.ts';

const port = Number(process.env.PORT || 8080);
const baseUrl = process.env.HELPDESK_URL ?? '';
const token = process.env.HELPDESK_TOKEN ?? '';

const store = new Store();
const server = http.createServer(createHandler({ store, log }));
server.listen(port, '0.0.0.0', () => log.info('listening', { port }));

let stopSync = () => {};
const shutdown = () => {
  stopSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (!baseUrl || !token) {
  log.warn('HELPDESK_URL / HELPDESK_TOKEN not set: serving /health only, /ready stays 503');
} else {
  const client = new HelpdeskClient({ baseUrl, token, log });
  const sync = new Sync({
    client,
    store,
    computeRow,
    log,
    pollMs: Number(process.env.POLL_MS || 10_000),
  });
  sync.start().catch((err) => log.warn('sync stopped', { error: String(err) }));
  const t0 = Date.now();
  sync.bootstrapped.then(() => log.info('ready', { seconds: (Date.now() - t0) / 1000, ...client.stats }));
  stopSync = () => sync.stop();
}
