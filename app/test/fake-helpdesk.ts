// A fake helpdesk server implementing docs/api.md, for tests (sync tests and the e2e test).
//
//   const fake = await startFakeHelpdesk();            // seeded with seedData()
//   const client = new HelpdeskClient({ baseUrl: fake.url, token: fake.token });
//   fake.addEvent(41212, { status: 'processing', at: ..., actor_id: 301 });  // appends to the feed
//   await fake.close();
//
// What it implements
// - Auth: `Authorization: Bearer <token>` required on every endpoint, else 401 {"error"}.
// - GET /v1/sites, /v1/sites/{id}/holidays (dates 'DD/MM/YYYY'), /v1/staff, /v1/statuses
//   -> {"data": [...]} (no paging, as in the docs).
// - GET /v1/requests?page&per_page(default 20, max 100)&created_from&created_to(DD/MM/YYYY,
//   compared to created_at as a SITE-LOCAL date)&status(JSON array) -> newest first, paged.
// - GET /v1/requests/{id}, GET /v1/requests/{id}/events?page (newest first, 50 a page, has_more).
// - GET /v1/changes?cursor&limit (default 100, max 500): every change in seq order. `request`
//   items carry the request AS IT IS NOW (read at response time). Cursor is opaque base64url of
//   {"s": last seq delivered, "e": cursor epoch, "t": issued ms}. expireCursors() (or cursorTtlMs)
//   makes older cursors answer 410. A malformed cursor answers 400.
// - duplicateEvery: N -> within each page every Nth item is delivered twice, and when has_more is
//   true the next cursor overlaps the page by one item (so the last item is re-delivered too).
// - rateLimit: fixed window PER ENDPOINT (path template, e.g. '/v1/sites/:id/holidays'); over the
//   limit -> 429 with `Retry-After: retryAfterS` (fractions such as 0.05 allowed, for fast tests).
// - failNext({count, status, path}): the next `count` matching requests answer `status` (5xx etc.).
// - `calls` records every request (path incl. query, status) for assertions.
//
// Mutators (addRequest, updateRequest, addEvent, renameStaff, addRawChange) append change items
// exactly like the real feed would. addEvent does NOT change the request's status by itself;
// pass `requestPatch` (or call updateRequest) for that.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface FakeSite {
  id: number;
  name: string;
  timezone: string;
  business_hours: Record<Weekday, { open: string; close: string } | null>;
}
export interface FakeRequest {
  id: number;
  ref: string;
  title: string;
  location: string;
  site_id: number;
  status: string;
  priority: string | null;
  created_at: string;
  updated_at: string;
  due_on: string | null;
  assignee: { id: number; name: string } | null;
  deleted_at: string | null;
  merged_into_id: number | null;
  [k: string]: unknown;
}
export interface FakeEvent {
  id: number;
  status: string | null;
  at: number;
  actor_id: number | null;
  actor_name: string | null;
  assignee_name: string | null;
  due_at: string | null;
  note: string | null;
  reverts_id: number | null;
  [k: string]: unknown;
}
type ChangeRec =
  | { seq: number; type: string; at: string; kind: 'request'; requestId: number }
  | { seq: number; type: string; at: string; kind: 'event'; requestId: number; event: FakeEvent }
  | { seq: number; type: string; at: string; kind: 'staff'; staff: { id: number; name: string } }
  | { seq: number; type: string; at: string; kind: 'raw'; item: Record<string, unknown> };

export interface FakeState {
  sites: FakeSite[];
  holidays: Map<number, { date: string; name: string }[]>;
  staff: Map<number, string>;
  requests: Map<number, FakeRequest>;
  events: Map<number, FakeEvent[]>;
  changes: ChangeRec[];
  seq: number;
  nextEventId: number;
  nextRequestId: number;
  cursorEpoch: number;
}

export interface FakeOptions {
  token?: string;
  rateLimit?: { maxPerWindow: number; windowMs: number; retryAfterS: number };
  duplicateEvery?: number;
  /** Default page size of /v1/changes when no `limit` is given (docs: 100). */
  perPage?: number;
  /** Cursors older than this answer 410 (docs: 15 min). Default: never by age. */
  cursorTtlMs?: number;
  /** Start empty instead of with seedData(). */
  empty?: boolean;
}

export interface FakeHelpdesk {
  url: string;
  token: string;
  state: FakeState;
  calls: { path: string; status: number }[];
  close(): Promise<void>;
  addRequest(r: Partial<FakeRequest> & { site_id: number; created_at: string }): FakeRequest;
  updateRequest(id: number, patch: Partial<FakeRequest>): FakeRequest;
  addEvent(requestId: number, e: Partial<FakeEvent> & { at: number }, requestPatch?: Partial<FakeRequest>): FakeEvent;
  renameStaff(id: number, name: string): void;
  /** Append an arbitrary item (e.g. an unknown type); `seq` is assigned. */
  addRawChange(item: Record<string, unknown>): void;
  /** Every cursor issued so far answers 410 from now on. */
  expireCursors(): void;
  failNext(opts: { count: number; status?: number; path?: string }): void;
  updateSite(id: number, patch: Partial<FakeSite>): void;
  setHolidays(siteId: number, holidays: { date: string; name: string }[]): void;
}

export const unix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const weekdays = (open: string, close: string, sat: { open: string; close: string } | null = null) => ({
  mon: { open, close },
  tue: { open, close },
  wed: { open, close },
  thu: { open, close },
  fri: { open, close },
  sat,
  sun: null,
});

/**
 * The seed data set: 3 sites (Singapore / Sydney / Jakarta), 4 staff, 6 requests.
 * - 41210 SG High: System event, first response by 304 after 42 min, due_at met.
 * - 41211 SYD Medium: response by 301 reverted (revert pair), real response by 302, completed late.
 * - 41212 JKT Low: only a System event -> no responder.
 * - 41213 SG priority null, canceled.  41214 SYD merged into 41211.
 * - 41215 JKT High: responder 303 whose event actor_name is an old name ('Chloe N.').
 */
export function seedData(): Omit<FakeState, 'changes' | 'seq'> & { feed: (s: FakeState) => void } {
  const sites: FakeSite[] = [
    { id: 11, name: 'Robusttechhouse Tower Singapore', timezone: 'Asia/Singapore', business_hours: weekdays('08:00', '18:00') },
    { id: 12, name: 'Harbour Point Sydney', timezone: 'Australia/Sydney', business_hours: weekdays('08:00', '18:00', { open: '09:00', close: '13:00' }) },
    { id: 13, name: 'Menara Jakarta', timezone: 'Asia/Jakarta', business_hours: weekdays('08:30', '17:30') },
  ];
  const holidays = new Map<number, { date: string; name: string }[]>([
    [11, [{ date: '10/08/2026', name: 'National Day (observed)' }, { date: '25/12/2026', name: 'Christmas Day' }]],
    [12, [{ date: '05/10/2026', name: 'Labour Day' }, { date: '25/12/2026', name: 'Christmas Day' }]],
    [13, [{ date: '17/08/2026', name: 'Independence Day' }]],
  ]);
  const staff = new Map<number, string>([
    [301, 'Aisha Rahman'],
    [302, 'Budi Santoso'],
    [303, 'Chloe Nguyen'],
    [304, 'Benjamin Tan'],
  ]);
  const requests = new Map<number, FakeRequest>();
  const events = new Map<number, FakeEvent[]>();
  const req = (r: Partial<FakeRequest> & { id: number; site_id: number; created_at: string }): FakeRequest => ({
    ref: `WO-${r.id}`,
    title: 'Seed request',
    location: 'Lobby',
    status: 'pending',
    priority: 'Low',
    updated_at: r.created_at,
    due_on: null,
    assignee: null,
    deleted_at: null,
    merged_into_id: null,
    ...r,
  });
  let eid = 300900;
  const ev = (e: Partial<FakeEvent> & { at: number }): FakeEvent => ({
    id: ++eid,
    status: null,
    actor_id: null,
    actor_name: e.actor_id == null ? 'System' : (staff.get(e.actor_id) ?? null),
    assignee_name: null,
    due_at: null,
    note: null,
    reverts_id: null,
    ...e,
  });
  const add = (r: FakeRequest, evs: FakeEvent[]) => {
    requests.set(r.id, r);
    events.set(r.id, evs);
  };

  const c0 = '2026-10-06T02:15:07Z'; // Tue 10:15 Singapore
  add(req({ id: 41210, site_id: 11, priority: 'High', created_at: c0, status: 'complete', due_on: '2026-10-07' }), [
    ev({ at: unix(c0) + 30, status: 'pending', note: 'auto-assigned' }),
    ev({ at: unix(c0) + 42 * 60, status: 'processing', actor_id: 304, due_at: '07/10/2026 10:00' }),
    ev({ at: unix('2026-10-07T01:00:00Z'), status: 'complete', actor_id: 304 }),
  ]);
  const c1 = '2026-10-05T23:00:00Z'; // Tue 10:00 Sydney (AEDT)
  const a = ev({ at: unix(c1) + 10 * 60, status: 'processing', actor_id: 301 });
  add(req({ id: 41211, site_id: 12, priority: 'Medium', created_at: c1, status: 'complete' }), [
    a,
    ev({ at: unix(c1) + 20 * 60, status: 'pending', actor_id: 301, reverts_id: a.id, note: 'wrong ticket' }),
    ev({ at: unix(c1) + 3 * 3600, status: 'processing', actor_id: 302, due_at: '07/10/2026 09:00' }),
    ev({ at: unix('2026-10-07T01:00:00Z'), status: 'complete', actor_id: 302 }),
  ]);
  const c2 = '2026-10-12T03:00:00Z';
  add(req({ id: 41212, site_id: 13, priority: 'Low', created_at: c2 }), [ev({ at: unix(c2) + 5, status: 'pending' })]);
  const c3 = '2026-10-13T04:00:00Z';
  add(req({ id: 41213, site_id: 11, priority: null, created_at: c3, status: 'canceled' }), [
    ev({ at: unix(c3) + 600, status: 'canceled', actor_id: 304 }),
  ]);
  const c4 = '2026-10-14T00:30:00Z';
  add(req({ id: 41214, site_id: 12, priority: 'High', created_at: c4, merged_into_id: 41211 }), []);
  const c5 = '2026-10-15T02:00:00Z';
  add(req({ id: 41215, site_id: 13, priority: 'High', created_at: c5, status: 'processing' }), [
    ev({ at: unix(c5) + 15 * 60, status: 'processing', actor_id: 303, actor_name: 'Chloe N.' }),
  ]);

  const feed = (s: FakeState) => {
    for (const r of requests.values()) {
      pushChange(s, { type: 'request.created', at: r.created_at, kind: 'request', requestId: r.id });
      for (const e of [...(events.get(r.id) ?? [])].sort((x, y) => x.at - y.at || x.id - y.id)) {
        pushChange(s, { type: 'event.created', at: new Date(e.at * 1000).toISOString(), kind: 'event', requestId: r.id, event: e });
      }
    }
    pushChange(s, { type: 'staff.updated', at: '2026-10-16T00:00:00Z', kind: 'staff', staff: { id: 303, name: 'Chloe Nguyen' } });
  };
  return { sites, holidays, staff, requests, events, nextEventId: eid + 1, nextRequestId: 41300, cursorEpoch: 0, feed };
}

type NewChange = ChangeRec extends infer C ? (C extends ChangeRec ? Omit<C, 'seq'> : never) : never;
function pushChange(s: FakeState, c: NewChange): void {
  s.changes.push({ ...c, seq: ++s.seq } as ChangeRec);
}

const clone = <T>(v: T): T => structuredClone(v);

function dmyToIso(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
}

export async function startFakeHelpdesk(opts: FakeOptions = {}): Promise<FakeHelpdesk> {
  const token = opts.token ?? 'test-token';
  const perPage = opts.perPage ?? 100;
  const state: FakeState = {
    sites: [],
    holidays: new Map(),
    staff: new Map(),
    requests: new Map(),
    events: new Map(),
    changes: [],
    seq: 100,
    nextEventId: 1,
    nextRequestId: 1,
    cursorEpoch: 0,
  };
  if (!opts.empty) {
    const { feed, ...seed } = seedData();
    Object.assign(state, seed);
    feed(state);
  }
  const calls: { path: string; status: number }[] = [];
  const windows = new Map<string, { start: number; count: number }>();
  const faults: { count: number; status: number; path?: string }[] = [];

  const encodeCursor = (s: number) =>
    Buffer.from(JSON.stringify({ s, e: state.cursorEpoch, t: Date.now() })).toString('base64url');
  const decodeCursor = (c: string): { s: number; e: number; t: number } | null => {
    try {
      const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
      if (typeof v?.s === 'number' && typeof v?.e === 'number' && typeof v?.t === 'number') return v;
    } catch {
      /* fallthrough */
    }
    return null;
  };

  const materialize = (c: ChangeRec): Record<string, unknown> => {
    switch (c.kind) {
      case 'request':
        return { seq: c.seq, type: c.type, at: c.at, request: clone(state.requests.get(c.requestId)) };
      case 'event':
        return { seq: c.seq, type: c.type, at: c.at, request_id: c.requestId, event: clone(c.event) };
      case 'staff':
        return { seq: c.seq, type: c.type, at: c.at, staff: clone(c.staff) };
      case 'raw':
        return { ...clone(c.item), seq: c.seq };
    }
  };

  type Reply = { status: number; body: unknown; headers?: Record<string, string> };
  const err = (status: number, error: string): Reply => ({ status, body: { error } });

  const intParam = (v: string | null, def: number, min: number, max: number): number | null => {
    if (v == null) return def;
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return n < min ? null : Math.min(n, max);
  };

  function route(u: URL): { key: string; handle: () => Reply } {
    const p = u.pathname.replace(/\/+$/, '');
    const q = u.searchParams;
    let m: RegExpExecArray | null;
    if (p === '/v1/sites') return { key: p, handle: () => ({ status: 200, body: { data: clone(state.sites) } }) };
    if ((m = /^\/v1\/sites\/(\d+)\/holidays$/.exec(p))) {
      const id = Number(m[1]);
      return {
        key: '/v1/sites/:id/holidays',
        handle: () =>
          state.sites.some((s) => s.id === id)
            ? { status: 200, body: { data: clone(state.holidays.get(id) ?? []) } }
            : err(404, 'site not found'),
      };
    }
    if (p === '/v1/staff')
      return {
        key: p,
        handle: () => ({ status: 200, body: { data: [...state.staff].map(([id, name]) => ({ id, name })) } }),
      };
    if (p === '/v1/statuses')
      return {
        key: p,
        handle: () => ({
          status: 200,
          body: {
            data: [
              { value: 'pending', label: 'Pending' },
              { value: 'processing', label: 'Processing' },
              { value: 'complete', label: 'Complete' },
              { value: 'canceled', label: 'Canceled' },
            ],
          },
        }),
      };
    if (p === '/v1/requests')
      return {
        key: p,
        handle: () => {
          const page = intParam(q.get('page'), 1, 1, 1e9);
          const per = intParam(q.get('per_page'), 20, 1, 100);
          if (page == null || per == null) return err(400, 'invalid page/per_page');
          let from: string | null = null;
          let to: string | null = null;
          if (q.has('created_from') && !(from = dmyToIso(q.get('created_from')!))) return err(400, 'invalid created_from');
          if (q.has('created_to') && !(to = dmyToIso(q.get('created_to')!))) return err(400, 'invalid created_to');
          let statuses: string[] | null = null;
          if (q.has('status')) {
            try {
              statuses = JSON.parse(q.get('status')!);
            } catch {
              return err(400, 'invalid status');
            }
            if (!Array.isArray(statuses)) return err(400, 'invalid status');
          }
          const tzOf = new Map(state.sites.map((s) => [s.id, s.timezone]));
          const all = [...state.requests.values()]
            .filter((r) => {
              if (statuses && !statuses.includes(r.status)) return false;
              if (from || to) {
                const d = localDate(r.created_at, tzOf.get(r.site_id) ?? 'UTC');
                if (from && d < from) return false;
                if (to && d > to) return false;
              }
              return true;
            })
            .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
          const total_pages = Math.max(1, Math.ceil(all.length / per));
          return {
            status: 200,
            body: { data: clone(all.slice((page - 1) * per, page * per)), page, per_page: per, total_pages, total: all.length },
          };
        },
      };
    if ((m = /^\/v1\/requests\/(\d+)$/.exec(p))) {
      const r = state.requests.get(Number(m[1]));
      return { key: '/v1/requests/:id', handle: () => (r ? { status: 200, body: clone(r) } : err(404, 'request not found')) };
    }
    if ((m = /^\/v1\/requests\/(\d+)\/events$/.exec(p))) {
      const id = Number(m[1]);
      return {
        key: '/v1/requests/:id/events',
        handle: () => {
          if (!state.requests.has(id)) return err(404, 'request not found');
          const page = intParam(q.get('page'), 1, 1, 1e9);
          if (page == null) return err(400, 'invalid page');
          const all = [...(state.events.get(id) ?? [])].sort((a, b) => b.at - a.at || b.id - a.id);
          const data = all.slice((page - 1) * 50, page * 50);
          return { status: 200, body: { data: clone(data), page, per_page: 50, has_more: page * 50 < all.length } };
        },
      };
    }
    if (p === '/v1/changes')
      return {
        key: p,
        handle: () => {
          const limit = intParam(q.get('limit'), perPage, 1, 500);
          if (limit == null) return err(400, 'invalid limit');
          let after = 0;
          const c = q.get('cursor');
          if (c) {
            const cur = decodeCursor(c);
            if (!cur) return err(400, 'invalid cursor');
            if (cur.e < state.cursorEpoch || (opts.cursorTtlMs != null && Date.now() - cur.t > opts.cursorTtlMs))
              return err(410, 'cursor expired');
            after = cur.s;
          }
          const start = state.changes.findIndex((x) => x.seq > after);
          const slice = start < 0 ? [] : state.changes.slice(start, start + limit);
          const has_more = start >= 0 && start + limit < state.changes.length;
          const data: Record<string, unknown>[] = [];
          slice.forEach((ch, i) => {
            const item = materialize(ch);
            data.push(item);
            if (opts.duplicateEvery && (i + 1) % opts.duplicateEvery === 0) data.push(materialize(ch));
          });
          let lastSeq = slice.length ? slice[slice.length - 1].seq : after;
          if (opts.duplicateEvery && has_more && slice.length >= 2) lastSeq = slice[slice.length - 2].seq;
          return { status: 200, body: { data, next_cursor: encodeCursor(lastSeq), has_more } };
        },
      };
    return { key: 'other', handle: () => err(404, 'not found') };
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://fake');
    const send = (r: Reply) => {
      calls.push({ path: u.pathname + u.search, status: r.status });
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.body));
    };
    if (req.method !== 'GET') return send(err(405, 'method not allowed'));
    if (req.headers.authorization !== `Bearer ${token}`) return send(err(401, 'unauthorized'));
    const { key, handle } = route(u);
    if (opts.rateLimit) {
      const now = Date.now();
      let w = windows.get(key);
      if (!w || now - w.start >= opts.rateLimit.windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      if (++w.count > opts.rateLimit.maxPerWindow)
        return send({ ...err(429, 'rate limited'), headers: { 'retry-after': String(opts.rateLimit.retryAfterS) } });
    }
    const fi = faults.findIndex((f) => f.count > 0 && (!f.path || u.pathname.startsWith(f.path)));
    if (fi >= 0) {
      const f = faults[fi];
      if (--f.count <= 0) faults.splice(fi, 1);
      return send(err(f.status, 'injected failure'));
    }
    send(handle());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const now = () => new Date().toISOString();

  const fake: FakeHelpdesk = {
    url: `http://127.0.0.1:${port}`,
    token,
    state,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    addRequest(r) {
      const id = r.id ?? state.nextRequestId++;
      const full: FakeRequest = {
        ref: `WO-${id}`,
        title: 'Request',
        location: 'Lobby',
        status: 'pending',
        priority: 'Low',
        updated_at: r.created_at,
        due_on: null,
        assignee: null,
        deleted_at: null,
        merged_into_id: null,
        ...r,
        id,
      };
      state.requests.set(id, full);
      if (!state.events.has(id)) state.events.set(id, []);
      pushChange(state, { type: 'request.created', at: now(), kind: 'request', requestId: id });
      return clone(full);
    },
    updateRequest(id, patch) {
      const r = state.requests.get(id);
      if (!r) throw new Error(`fake: no request ${id}`);
      Object.assign(r, patch, { id, updated_at: patch.updated_at ?? now() });
      pushChange(state, { type: 'request.updated', at: now(), kind: 'request', requestId: id });
      return clone(r);
    },
    addEvent(requestId, e, requestPatch) {
      if (!state.requests.has(requestId)) throw new Error(`fake: no request ${requestId}`);
      const actor = e.actor_id ?? null;
      const full: FakeEvent = {
        status: null,
        actor_id: actor,
        actor_name: actor == null ? 'System' : (state.staff.get(actor) ?? null),
        assignee_name: null,
        due_at: null,
        note: null,
        reverts_id: null,
        ...e,
        id: e.id ?? state.nextEventId++,
      };
      const list = state.events.get(requestId) ?? [];
      list.push(full);
      state.events.set(requestId, list);
      pushChange(state, { type: 'event.created', at: now(), kind: 'event', requestId, event: clone(full) });
      if (requestPatch) fake.updateRequest(requestId, requestPatch);
      return clone(full);
    },
    renameStaff(id, name) {
      state.staff.set(id, name);
      pushChange(state, { type: 'staff.updated', at: now(), kind: 'staff', staff: { id, name } });
    },
    addRawChange(item) {
      pushChange(state, { type: String(item.type ?? ''), at: now(), kind: 'raw', item });
    },
    expireCursors() {
      state.cursorEpoch++;
    },
    failNext({ count, status = 503, path }) {
      faults.push({ count, status, path });
    },
    updateSite(id, patch) {
      const s = state.sites.find((x) => x.id === id);
      if (!s) throw new Error(`fake: no site ${id}`);
      Object.assign(s, patch, { id });
    },
    setHolidays(siteId, holidays) {
      state.holidays.set(siteId, clone(holidays));
    },
  };
  return fake;
}
