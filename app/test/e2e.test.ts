// End to end: fake helpdesk -> HelpdeskClient -> Sync -> Store -> rules -> HTTP.
// Expected values are worked out BY HAND from docs/rules.md (not by calling the engine), so this
// test is an independent oracle for the whole pipeline.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFakeHelpdesk, unix, type FakeHelpdesk } from './fake-helpdesk.ts';
import { HelpdeskClient } from '../src/helpdesk.ts';
import { Store } from '../src/store.ts';
import { Sync } from '../src/sync.ts';
import { computeRow } from '../src/rules.ts';
import { createHandler } from '../src/http.ts';
import { memoryLogger } from '../src/log.ts';

const OCT = 'from=2026-10-01&to=2026-10-31';

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('e2e against a fake helpdesk', () => {
  let fake: FakeHelpdesk;
  let sync: Sync;
  let server: http.Server;
  let base = '';
  const get = async (p: string) => {
    const res = await fetch(base + p);
    return { status: res.status, body: (await res.json()) as any };
  };

  before(async () => {
    // Rate limited and re-delivering items, like the real API.
    fake = await startFakeHelpdesk({ rateLimit: { maxPerWindow: 5, windowMs: 200, retryAfterS: 0.05 }, duplicateEvery: 3, perPage: 2 });
    const log = memoryLogger();
    const store = new Store({ log });
    const client = new HelpdeskClient({ baseUrl: fake.url, token: fake.token, log, baseBackoffMs: 10, jitterMs: 0 });
    sync = new Sync({ client, store, computeRow, log, pollMs: 50, feedLimit: 2 });
    server = http.createServer(createHandler({ store, log }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    void sync.start();
  });
  after(async () => {
    sync.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await fake.close();
  });

  test('becomes ready and the October report matches the rules (hand-computed)', async () => {
    await waitFor(async () => ((await get('/ready')).status === 200 ? true : undefined));
    const { status, body } = await get(`/api/sla-report?${OCT}`);
    assert.equal(status, 200);
    const byId = Object.fromEntries(body.requests.map((r: any) => [r.id, r]));
    // 41213 canceled and 41214 merged are excluded (rule 1).
    assert.deepEqual(Object.keys(byId).map(Number).sort(), [41210, 41211, 41212, 41215]);
    // SG High, created Tue 10:15 local, first response +42 min by 304, completed 09:00 before the 10:00 deadline.
    assert.deepEqual(byId[41210], { id: 41210, site_id: 11, responder_id: 304, responder: 'Benjamin Tan', response_business_minutes: 42, within_target: true, completed_late: false });
    // SYD Medium (AEDT, after the 4 Oct DST start): 301's response is reverted (rule 2), so 302 at 13:00 = 180 min;
    // completed 12:00 local on 7 Oct, after the 09:00 deadline -> late.
    assert.deepEqual(byId[41211], { id: 41211, site_id: 12, responder_id: 302, responder: 'Budi Santoso', response_business_minutes: 180, within_target: true, completed_late: true });
    // Only a System event: no responder, never completed (rule 7).
    assert.deepEqual(byId[41212], { id: 41212, site_id: 13, responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: null });
    // Event carries the old name 'Chloe N.'; the current staff name wins (rule 3).
    assert.deepEqual(byId[41215], { id: 41215, site_id: 13, responder_id: 303, responder: 'Chloe Nguyen', response_business_minutes: 15, within_target: true, completed_late: null });
    assert.deepEqual(body.responders, [
      { id: 302, name: 'Budi Santoso', requests: 1, within_target: 1, completed_late: 1 },
      { id: 303, name: 'Chloe Nguyen', requests: 1, within_target: 1, completed_late: 0 },
      { id: 304, name: 'Benjamin Tan', requests: 1, within_target: 1, completed_late: 0 },
    ]);
  });

  test('a one-week range (12–18 Oct) only has the requests created that week', async () => {
    const { body } = await get('/api/sla-report?from=2026-10-12&to=2026-10-18');
    assert.deepEqual(body.requests.map((r: any) => r.id).sort(), [41212, 41215]);
  });

  test('live: a helpdesk change shows in the report within a few polls', async () => {
    // Jakarta Mon 12 Oct 10:00 local creation; 301 responds at 11:30 local (90 min, Low -> within 480).
    fake.addEvent(41212, { at: unix('2026-10-12T04:30:00Z'), status: 'processing', actor_id: 301 }, { status: 'processing' });
    fake.renameStaff(301, 'Aisha R. Rahman');
    const row = await waitFor(async () => {
      const r = (await get(`/api/sla-report?${OCT}`)).body.requests.find((x: any) => x.id === 41212);
      return r.responder_id === 301 ? r : undefined;
    });
    assert.deepEqual(row, { id: 41212, site_id: 13, responder_id: 301, responder: 'Aisha R. Rahman', response_business_minutes: 90, within_target: true, completed_late: null });
  });

  test('browse: a walk sees every stable row exactly once while data changes', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const q: string = `/api/requests?${OCT}&sort=-response_business_minutes&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { status, body } = await get(q);
      assert.equal(status, 200);
      seen.push(...body.data.map((l: any) => l.id));
      cursor = body.next_cursor;
      if (page++ === 1) {
        // Mid-walk: undo 41210's first response so its sort key moves; and add a new request.
        const first = fake.state.events.get(41210)!.find((e) => e.status === 'processing')!;
        fake.addEvent(41210, { at: first.at + 60, status: 'pending', actor_id: 304, reverts_id: first.id });
        fake.addRequest({ site_id: 11, created_at: '2026-10-20T02:00:00Z', priority: 'High' });
        await new Promise((r) => setTimeout(r, 300)); // let the poller apply it
      }
    } while (cursor);
    for (const id of [41210, 41211, 41212, 41215]) assert.equal(seen.filter((x) => x === id).length, 1, `id ${id}`);
  });

  test('filters on /api/requests', async () => {
    const late = await get(`/api/requests?${OCT}&late=true`);
    assert.deepEqual(late.body.data.map((l: any) => l.id), [41211]);
    const site = await get(`/api/requests?${OCT}&site_id=13`);
    assert.deepEqual(site.body.data.map((l: any) => l.id), [41212, 41215]);
    const resp = await get(`/api/requests?${OCT}&responder_id=302&within_target=true`);
    assert.deepEqual(resp.body.data.map((l: any) => l.id), [41211]);
  });

  test('the API was not flooded: 429s were honoured, not hammered', () => {
    const c429 = fake.calls.filter((c) => c.status === 429).length;
    const total = fake.calls.length;
    assert.ok(total > 0);
    assert.ok(c429 <= total / 2, `${c429} of ${total} calls were 429`);
  });
});
