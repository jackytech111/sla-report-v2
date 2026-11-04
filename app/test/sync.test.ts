import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HelpdeskClient, GoneError, HttpError, parseRetryAfter } from '../src/helpdesk.ts';
import { Store } from '../src/store.ts';
import { Sync, parseDmyDate } from '../src/sync.ts';
import { memoryLogger } from '../src/log.ts';
import type { ComputeRow, HelpdeskEvent, HelpdeskRequest, Site } from '../src/types.ts';
import { startFakeHelpdesk, unix } from './fake-helpdesk.ts';
import type { FakeOptions } from './fake-helpdesk.ts';

// Stub rules engine: response_business_minutes = number of events, responder = first actor.
let computeCalls = 0;
const stubCompute: ComputeRow = (req, events, site) => {
  computeCalls++;
  const evs = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
  const first = evs.find((e) => e.actor_id != null);
  return {
    id: req.id,
    site_id: req.site_id,
    local_date: req.created_at.slice(0, 10),
    included: req.status !== 'canceled' && req.deleted_at == null && req.merged_into_id == null,
    responder_id: first?.actor_id ?? null,
    response_business_minutes: evs.length,
    within_target: site.holidays.size > 1,
    completed_late: null,
  };
};

async function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function setup(fakeOpts: FakeOptions = {}, syncOpts: { pollMs?: number; refreshMetaMs?: number; feedLimit?: number } = {}) {
  const fake = await startFakeHelpdesk(fakeOpts);
  const log = memoryLogger();
  const client = new HelpdeskClient({ baseUrl: fake.url, token: fake.token, log, jitterMs: 1, baseBackoffMs: 5, maxBackoffMs: 20 });
  const store = new Store({ log });
  const sync = new Sync({
    client,
    store,
    computeRow: stubCompute,
    log,
    pollMs: syncOpts.pollMs ?? 20,
    refreshMetaMs: syncOpts.refreshMetaMs ?? 60_000,
    feedLimit: syncOpts.feedLimit ?? 500,
  });
  const done = sync.start();
  const teardown = async () => {
    sync.stop();
    await done;
    await fake.close();
  };
  return { fake, log, client, store, sync, teardown };
}

const polled = (sync: Sync, after: number) => () => sync.stats.polls > after;

describe('HelpdeskClient', () => {
  test('sends bearer auth, parses JSON, 401 -> HttpError without leaking token', async () => {
    const fake = await startFakeHelpdesk({ token: 's3cret' });
    const log = memoryLogger();
    try {
      const ok = new HelpdeskClient({ baseUrl: fake.url, token: 's3cret', log });
      const body = await ok.get<{ data: unknown[] }>('/v1/sites');
      assert.equal(body.data.length, 3);
      const bad = new HelpdeskClient({ baseUrl: fake.url, token: 'nope', log });
      await assert.rejects(bad.get('/v1/sites'), (e: unknown) => e instanceof HttpError && e.status === 401);
      assert.ok(!JSON.stringify(log.lines).includes('s3cret'));
    } finally {
      await fake.close();
    }
  });

  test('429 honours Retry-After and is counted', async () => {
    const fake = await startFakeHelpdesk({ rateLimit: { maxPerWindow: 2, windowMs: 80, retryAfterS: 0.1 } });
    try {
      const waits: number[] = [];
      const client = new HelpdeskClient({
        baseUrl: fake.url,
        token: fake.token,
        log: memoryLogger(),
        jitterMs: 1,
        sleep: (ms) => {
          waits.push(ms);
          return new Promise((r) => setTimeout(r, ms));
        },
      });
      for (let i = 0; i < 3; i++) await client.get('/v1/staff');
      assert.ok(client.stats.http429 >= 1);
      assert.ok(waits.length >= 1 && waits.every((w) => w >= 100), `waits ${waits}`);
      assert.equal(fake.calls.filter((c) => c.status === 200).length, 3);
      assert.equal(fake.calls.filter((c) => c.status === 429).length, client.stats.http429);
    } finally {
      await fake.close();
    }
  });

  test('5xx retried with exponential backoff', async () => {
    const fake = await startFakeHelpdesk();
    try {
      fake.failNext({ count: 3, status: 503 });
      const waits: number[] = [];
      const client = new HelpdeskClient({
        baseUrl: fake.url,
        token: fake.token,
        log: memoryLogger(),
        maxBackoffMs: 3000,
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      const body = await client.get<{ data: unknown[] }>('/v1/staff');
      assert.equal(body.data.length, 4);
      assert.deepEqual(waits, [1000, 2000, 3000]);
      assert.equal(client.stats.retries, 3);
    } finally {
      await fake.close();
    }
  });

  test('network error retried; 410 -> GoneError; requests serialized', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let n = 0;
    const fetchImpl = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return new Response('{"error":"gone"}', { status: 410 });
      return new Response('{"ok":1}', { status: 200 });
    }) as unknown as typeof fetch;
    const client = new HelpdeskClient({ baseUrl: 'http://x', token: 't', log: memoryLogger(), fetchImpl, sleep: async () => {} });
    const a = client.get('/a');
    const b = client.get('/b');
    const c = client.get('/c');
    await assert.rejects(a, (e: unknown) => e instanceof GoneError && e.status === 410);
    assert.deepEqual(await b, { ok: 1 });
    assert.deepEqual(await c, { ok: 1 });
    assert.equal(maxInFlight, 1);
    assert.equal(client.stats.networkErrors, 1);
  });

  test('parseRetryAfter', () => {
    assert.equal(parseRetryAfter('3'), 3000);
    assert.equal(parseRetryAfter('0.05'), 50);
    assert.equal(parseRetryAfter(null), 1000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
  });

  test('close() aborts a retry loop', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const client = new HelpdeskClient({ baseUrl: 'http://x', token: 't', log: memoryLogger(), fetchImpl, baseBackoffMs: 10_000 });
    const p = client.get('/a');
    setTimeout(() => client.close(), 10);
    await assert.rejects(p, { name: 'ClosedError' });
  });
});

describe('Store', () => {
  const site: Site = { id: 1, name: 's', timezone: 'UTC', business_hours: {}, holidays: new Set() };
  const req = (id: number, extra: Partial<HelpdeskRequest> = {}): HelpdeskRequest => ({
    id,
    site_id: 1,
    status: 'pending',
    priority: 'Low',
    created_at: '2026-10-01T00:00:00Z',
    deleted_at: null,
    merged_into_id: null,
    ...extra,
  });
  const ev = (id: number, extra: Partial<HelpdeskEvent> = {}): HelpdeskEvent => ({
    id,
    status: 'processing',
    at: 100,
    actor_id: 7,
    actor_name: 'Seven',
    due_at: null,
    reverts_id: null,
    ...extra,
  });

  test('snapshot is the same instance while nothing changes; no-op upsert keeps version', () => {
    const s = new Store({ log: memoryLogger() });
    s.setSites([site]);
    s.upsertRequest(req(1));
    s.upsertEvent(1, ev(10));
    assert.equal(s.recompute(stubCompute), 1);
    const v = s.version;
    const snap = s.snapshot();
    assert.equal(s.snapshot(), snap);
    assert.ok(Object.isFrozen(snap.rows) && Object.isFrozen(snap.rows[0]));

    // identical re-delivery: not dirty, no version bump
    assert.equal(s.upsertRequest(req(1)), false);
    assert.equal(s.upsertEvent(1, ev(10)), false);
    assert.equal(s.recompute(stubCompute), 0);
    // dirty but row content identical (updated_at-like noise): still no bump
    s.upsertRequest(req(1, { updated_at: 'x' }));
    assert.equal(s.recompute(stubCompute), 0);
    assert.equal(s.version, v);
    assert.equal(s.snapshot(), snap);

    // real change: new version, new array, old snapshot untouched
    s.upsertEvent(1, ev(11, { at: 200 }));
    assert.equal(s.recompute(stubCompute), 1);
    assert.equal(s.version, v + 1);
    const snap2 = s.snapshot();
    assert.notEqual(snap2, snap);
    assert.equal(snap.rows[0].response_business_minutes, 1);
    assert.equal(snap2.rows[0].response_business_minutes, 2);
  });

  test('unknown site: row removed and warned once; site added later restores it', () => {
    const log = memoryLogger();
    const s = new Store({ log });
    s.setSites([site]);
    s.upsertRequest(req(1));
    s.upsertRequest(req(2));
    s.recompute(stubCompute);
    assert.equal(s.rows.size, 2);
    s.upsertRequest(req(1, { site_id: 99 }));
    s.upsertRequest(req(2, { site_id: 99 }));
    assert.equal(s.recompute(stubCompute), 2);
    assert.equal(s.rows.size, 0);
    assert.equal(log.lines.filter((l) => l.lvl === 'warn' && l.msg.includes('unknown site')).length, 1);
    const changed = s.setSites([site, { ...site, id: 99 }]);
    assert.deepEqual(changed, [99]);
    s.recompute(stubCompute);
    assert.equal(s.rows.size, 2);
  });

  test('nameOf: staff name, else latest actor_name by at, else null', () => {
    const s = new Store({ log: memoryLogger() });
    s.upsertEvent(1, ev(1, { actor_id: 5, actor_name: 'New', at: 200 }));
    s.upsertEvent(1, ev(2, { actor_id: 5, actor_name: 'Old', at: 100 }));
    assert.equal(s.nameOf(5), 'New');
    s.setStaff(5, 'Staff');
    assert.equal(s.nameOf(5), 'Staff');
    assert.equal(s.nameOf(6), null);
  });

  test('setSites returns only changed sites and marks their requests dirty', () => {
    const s = new Store({ log: memoryLogger() });
    const b: Site = { ...site, id: 2, holidays: new Set(['2026-10-01']) };
    assert.deepEqual(s.setSites([site, b]), [1, 2]);
    s.upsertRequest(req(1));
    s.upsertRequest(req(2, { site_id: 2 }));
    s.recompute(stubCompute);
    assert.deepEqual(s.setSites([{ ...site, holidays: new Set() }, { ...b, holidays: new Set(['2026-10-01']) }]), []);
    assert.equal(s.dirtyCount, 0);
    assert.deepEqual(s.setSites([site, { ...b, holidays: new Set(['2026-10-02']) }]), [2]);
    assert.equal(s.dirtyCount, 1);
  });
});

describe('Sync against the fake helpdesk', () => {
  test('parseDmyDate is strict', () => {
    assert.equal(parseDmyDate('10/08/2026'), '2026-08-10');
    assert.equal(parseDmyDate('2026-08-10'), '2026-08-10');
    assert.equal(parseDmyDate('31/02/2026'), null);
    assert.equal(parseDmyDate('1/8/2026'), null);
    assert.equal(parseDmyDate('29/02/2028'), '2028-02-29');
    assert.equal(parseDmyDate(null), null);
  });

  test('bootstrap loads everything and reaches ready', async () => {
    const { fake, store, sync, client, teardown } = await setup({ perPage: 3 }, { feedLimit: 4 });
    try {
      assert.equal(store.ready, false);
      await sync.bootstrapped;
      assert.equal(store.ready, true);
      assert.equal(store.sites.size, 3);
      assert.equal(store.sites.get(11)?.timezone, 'Asia/Singapore');
      assert.deepEqual([...store.sites.get(11)!.holidays].sort(), ['2026-08-10', '2026-12-25']);
      assert.deepEqual(store.sites.get(12)?.business_hours.sat, { open: '09:00', close: '13:00' });
      assert.equal(store.staff.size, 4);
      assert.equal(store.requests.size, fake.state.requests.size);
      for (const [id, evs] of fake.state.events) {
        assert.equal(store.events.get(id)?.size ?? 0, evs.length, `events of ${id}`);
        assert.equal(store.rows.get(id)?.response_business_minutes, evs.length);
      }
      assert.equal(store.rows.get(41213)?.included, false);
      assert.equal(store.rows.get(41214)?.included, false);
      assert.equal(store.nameOf(303), 'Chloe Nguyen');
      assert.equal(sync.stats.items, fake.state.changes.length);
      assert.ok(sync.stats.feedPages >= Math.ceil(fake.state.changes.length / 4));
      assert.ok(fake.calls.some((c) => c.path.startsWith('/v1/changes?limit=4')));
      assert.equal(client.stats.http429, 0);
    } finally {
      await teardown();
    }
  });

  test('duplicate deliveries do not double count', async () => {
    const { fake, store, sync, teardown } = await setup({ duplicateEvery: 2 }, { feedLimit: 3 });
    try {
      await sync.bootstrapped;
      assert.ok(sync.stats.dupItems > 0);
      assert.ok(sync.stats.items > fake.state.changes.length);
      for (const [id, evs] of fake.state.events) assert.equal(store.rows.get(id)?.response_business_minutes, evs.length);
      assert.equal(sync.stats.seqMin, 101);
      assert.equal(sync.stats.seqMax, fake.state.seq);
    } finally {
      await teardown();
    }
  });

  test('bootstrap under rate limiting honours 429 and still completes', async () => {
    const { store, sync, client, teardown } = await setup(
      { rateLimit: { maxPerWindow: 2, windowMs: 40, retryAfterS: 0.05 } },
      { feedLimit: 2 },
    );
    try {
      await sync.bootstrapped;
      assert.ok(client.stats.http429 > 0);
      assert.equal(store.rows.size, 6);
    } finally {
      await teardown();
    }
  });

  test('5xx during the feed walk is retried', async () => {
    const fake = await startFakeHelpdesk();
    fake.failNext({ count: 2, status: 502, path: '/v1/changes' });
    const client = new HelpdeskClient({ baseUrl: fake.url, token: fake.token, log: memoryLogger(), baseBackoffMs: 5 });
    const store = new Store({ log: memoryLogger() });
    const sync = new Sync({ client, store, computeRow: stubCompute, log: memoryLogger(), pollMs: 20 });
    const done = sync.start();
    try {
      await sync.bootstrapped;
      assert.equal(client.stats.errors5xx, 2);
      assert.equal(store.rows.size, 6);
    } finally {
      sync.stop();
      await done;
      await fake.close();
    }
  });

  test('live change appears after one poll; no-op polls keep version and snapshot', async () => {
    const { fake, store, sync, teardown } = await setup();
    try {
      await sync.bootstrapped;
      const v = store.version;
      const snap = store.snapshot();
      const p0 = sync.stats.polls;
      await waitFor(polled(sync, p0 + 1), 3000, 'two idle polls');
      assert.equal(store.version, v);
      assert.equal(store.snapshot(), snap);

      fake.addEvent(41212, { at: unix('2026-10-12T05:00:00Z'), status: 'processing', actor_id: 301 }, { status: 'processing' });
      const r = fake.addRequest({ site_id: 11, created_at: '2026-10-20T01:00:00Z', priority: 'High' });
      const p1 = sync.stats.polls;
      await waitFor(polled(sync, p1 + 1), 3000, 'poll after change');
      assert.equal(store.rows.get(41212)?.responder_id, 301);
      assert.equal(store.rows.get(41212)?.response_business_minutes, 2);
      assert.equal(store.requests.get(41212)?.status, 'processing');
      assert.ok(store.rows.has(r.id));
      assert.ok(store.version > v);
      assert.notEqual(store.snapshot(), snap);
      assert.ok(sync.stats.lastChangeAt != null && sync.stats.lastPollAt != null);
    } finally {
      await teardown();
    }
  });

  test('410 restarts the feed from the beginning; state stays correct', async () => {
    const { fake, store, sync, teardown } = await setup({}, { feedLimit: 5 });
    try {
      await sync.bootstrapped;
      const v = store.version;
      fake.expireCursors();
      await waitFor(() => sync.stats.cursorRestarts === 1, 3000, 'restart after expiry');
      await waitFor(polled(sync, sync.stats.polls), 3000, 'replay poll finished');
      assert.equal(store.version, v, 'replay of identical data must not bump version');
      fake.addEvent(41215, { at: unix('2026-10-15T09:00:00Z'), status: 'complete', actor_id: 303 });
      fake.expireCursors();
      await waitFor(() => store.rows.get(41215)?.response_business_minutes === 2, 3000, 'new event');
      for (const [id, evs] of fake.state.events) assert.equal(store.rows.get(id)?.response_business_minutes, evs.length);
      assert.equal(sync.stats.cursorRestarts, 2);
    } finally {
      await teardown();
    }
  });

  test('staff rename updates nameOf without recompute or version bump', async () => {
    const { fake, store, sync, teardown } = await setup();
    try {
      await sync.bootstrapped;
      const v = store.version;
      const calls = computeCalls;
      fake.renameStaff(304, 'Ben Tan');
      await waitFor(() => store.nameOf(304) === 'Ben Tan', 3000, 'rename');
      assert.equal(store.version, v);
      assert.equal(computeCalls, calls);
    } finally {
      await teardown();
    }
  });

  test('unknown change types are counted and warned once per type', async () => {
    const { fake, log, sync, teardown } = await setup();
    try {
      await sync.bootstrapped;
      fake.addRawChange({ type: 'request.exploded', foo: 1 });
      fake.addRawChange({ type: 'request.exploded', foo: 2 });
      fake.addRawChange({ type: 'site.updated', site: { id: 11 } });
      await waitFor(() => sync.stats.unknownTypes['site.updated'] === 1, 3000, 'unknown types');
      assert.equal(sync.stats.unknownTypes['request.exploded'], 2);
      assert.equal(log.lines.filter((l) => l.msg.startsWith('unknown change item type')).length, 2);
    } finally {
      await teardown();
    }
  });

  test('request moved to an unknown site loses its row', async () => {
    const { fake, store, sync, log, teardown } = await setup();
    try {
      await sync.bootstrapped;
      assert.ok(store.rows.has(41210));
      fake.updateRequest(41210, { site_id: 99 });
      await waitFor(() => !store.rows.has(41210), 3000, 'row removal');
      assert.ok(log.lines.some((l) => l.lvl === 'warn' && l.data?.site_id === 99));
    } finally {
      await teardown();
    }
  });

  test('metadata refresh: changed holidays recompute only that site', async () => {
    const { fake, store, sync, teardown } = await setup({}, { refreshMetaMs: 30 });
    try {
      await sync.bootstrapped;
      assert.equal(store.rows.get(41212)?.within_target, false); // Jakarta has 1 holiday
      const before = computeCalls;
      fake.setHolidays(13, [
        { date: '17/08/2026', name: 'Independence Day' },
        { date: '25/12/2026', name: 'Christmas Day' },
      ]);
      await waitFor(() => store.rows.get(41212)?.within_target === true, 3000, 'holiday refresh');
      assert.ok(store.sites.get(13)!.holidays.has('2026-12-25'));
      assert.equal(computeCalls - before, 2, 'only the 2 Jakarta requests recomputed');
      assert.ok(sync.stats.metaRefreshes >= 2);
    } finally {
      await teardown();
    }
  });

  test('stop() during bootstrap resolves start() promptly', async () => {
    const fake = await startFakeHelpdesk();
    fake.failNext({ count: 1000, status: 500 });
    const client = new HelpdeskClient({ baseUrl: fake.url, token: fake.token, log: memoryLogger(), baseBackoffMs: 10_000 });
    const sync = new Sync({ client, store: new Store({ log: memoryLogger() }), computeRow: stubCompute, log: memoryLogger() });
    const done = sync.start();
    await waitFor(() => fake.calls.length > 0, 3000, 'first call');
    sync.stop();
    await done;
    await fake.close();
  });
});

