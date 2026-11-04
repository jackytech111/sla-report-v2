// HTTP layer: routes, status codes and exact contract shapes, over a store filled by hand.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/http.ts';
import { Store } from '../src/store.ts';
import { memoryLogger } from '../src/log.ts';
import type { Row } from '../src/types.ts';

function row(id: number, over: Partial<Row> = {}): Row {
  return Object.freeze({
    id,
    site_id: 11,
    local_date: '2026-10-10',
    included: true,
    responder_id: 304,
    response_business_minutes: 42,
    within_target: true,
    completed_late: false,
    ...over,
  });
}

describe('http', () => {
  const store = new Store({ log: memoryLogger() });
  let server: http.Server;
  let base = '';
  const get = async (p: string) => {
    const res = await fetch(base + p);
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() };
  };

  before(async () => {
    server = http.createServer(createHandler({ store, log: memoryLogger() }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test('/health is up before the data is ready; /ready is 503', async () => {
    assert.deepEqual(await get('/health'), { status: 200, type: 'application/json; charset=utf-8', body: { ok: true } });
    const r = await get('/ready');
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { ready: false });
  });

  test('reports answer 503 until ready, but bad input is 400 first', async () => {
    assert.equal((await get('/api/sla-report?from=2026-10-01&to=2026-10-31')).status, 503);
    assert.equal((await get('/api/requests?from=2026-10-01&to=2026-10-31')).status, 503);
    assert.equal((await get('/api/sla-report?from=2026-10-31&to=2026-10-01')).status, 400);
  });

  test('once ready: /ready 200 and the report has the exact contract shape', async () => {
    store.staff.set(304, 'Benjamin Tan');
    store.rows.set(41210, row(41210));
    store.rows.set(41214, row(41214, { site_id: 12, responder_id: null, response_business_minutes: null, within_target: null, completed_late: null }));
    store.rows.set(41300, row(41300, { local_date: '2026-11-01' })); // out of range
    store.rows.set(41301, row(41301, { included: false })); // canceled etc.
    store.version++;
    store.ready = true;

    assert.deepEqual((await get('/ready')).body, { ready: true });
    const r = await get('/api/sla-report?from=2026-10-01&to=2026-10-31');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      from: '2026-10-01',
      to: '2026-10-31',
      requests: [
        { id: 41210, site_id: 11, responder_id: 304, responder: 'Benjamin Tan', response_business_minutes: 42, within_target: true, completed_late: false },
        { id: 41214, site_id: 12, responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: null },
      ],
      responders: [{ id: 304, name: 'Benjamin Tan', requests: 1, within_target: 1, completed_late: 0 }],
    });
  });

  test('a staff rename shows on the next read without recompute', async () => {
    store.staff.set(304, 'Ben Tan');
    const r = await get('/api/sla-report?from=2026-10-10&to=2026-10-10');
    assert.equal((r.body as any).requests[0].responder, 'Ben Tan');
    assert.equal((r.body as any).responders[0].name, 'Ben Tan');
  });

  test('/api/requests pages with a cursor and rejects a forged one', async () => {
    const p1 = await get('/api/requests?from=2026-10-01&to=2026-10-31&limit=1');
    assert.equal(p1.status, 200);
    const b1 = p1.body as any;
    assert.deepEqual(Object.keys(b1).sort(), ['data', 'next_cursor']);
    assert.equal(b1.data.length, 1);
    assert.equal(b1.data[0].id, 41210);
    const p2 = await get(`/api/requests?from=2026-10-01&to=2026-10-31&limit=1&cursor=${encodeURIComponent(b1.next_cursor)}`);
    assert.deepEqual((p2.body as any).data.map((l: any) => l.id), [41214]);
    assert.equal((p2.body as any).next_cursor, null);
    const bad = await get('/api/requests?from=2026-10-01&to=2026-10-31&cursor=abc.def');
    assert.equal(bad.status, 400);
    assert.ok(typeof (bad.body as any).error === 'string');
  });

  test('errors are JSON {"error"}: 400 validation, 404 unknown route, 405 method', async () => {
    for (const p of ['/api/sla-report', '/api/sla-report?from=2026-10-01', '/api/sla-report?from=2026-13-01&to=2026-13-02', '/api/requests?from=2026-10-01&to=2026-10-31&limit=0']) {
      const r = await get(p);
      assert.equal(r.status, 400, p);
      assert.ok(typeof (r.body as any).error === 'string', p);
    }
    assert.equal((await get('/nope')).status, 404);
    const res = await fetch(base + '/health', { method: 'POST' });
    assert.equal(res.status, 405);
  });

  test('the page is served at /', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(String(r.body), /Response-time report/);
  });
});
