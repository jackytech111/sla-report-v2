import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Row } from '../src/types.ts';
import { BadRequest, parseBrowseParams, parseReportParams, isValidDate } from '../src/validate.ts';
import type { BrowseParams, SortKey } from '../src/validate.ts';
import { createCursorCodec } from '../src/cursor.ts';
import { browse, buildReport, inRange, toLine, SnapshotCache, queryHash } from '../src/query.ts';

const SORTS: SortKey[] = ['id', '-id', 'response_business_minutes', '-response_business_minutes'];
const LINE_KEYS = ['completed_late', 'id', 'responder', 'responder_id', 'response_business_minutes', 'site_id', 'within_target'];
const RESP_KEYS = ['completed_late', 'id', 'name', 'requests', 'within_target'];

const qs = (s: string) => new URLSearchParams(s);
const is400 = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof BadRequest, `expected BadRequest, got ${String(e)}`);
    assert.equal(e.status, 400);
    assert.ok(e.message.length > 0);
    if (re) assert.match(e.message, re);
    return true;
  });

const names = new Map<number, string>([
  [301, 'Ana'],
  [302, 'Bo'],
  [303, 'Cy'],
]);
const nameOf = (id: number) => names.get(id) ?? null;

function row(id: number, over: Partial<Row> = {}): Row {
  return {
    id,
    site_id: 11,
    local_date: '2026-10-10',
    included: true,
    responder_id: 301,
    response_business_minutes: 10,
    within_target: true,
    completed_late: false,
    ...over,
  };
}

/** Deterministic pseudo-random rows with many duplicate and null keys. */
function genRows(n: number, seed = 7): Row[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const id = 1000 + i * 3 + Math.floor(rnd() * 3);
    const hasResp = rnd() < 0.8;
    const m = hasResp ? Math.floor(rnd() * 8) : null; // few distinct values -> many ties
    const lateR = rnd();
    out.push({
      id,
      site_id: rnd() < 0.5 ? 11 : 12,
      local_date: `2026-10-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
      included: rnd() < 0.9,
      responder_id: hasResp ? 301 + Math.floor(rnd() * 3) : null,
      response_business_minutes: m,
      within_target: m === null ? null : m <= 4,
      completed_late: lateR < 0.3 ? null : lateR < 0.6,
    });
  }
  return out;
}

function params(extra = ''): BrowseParams {
  return parseBrowseParams(qs(`from=2026-10-01&to=2026-10-31${extra ? '&' + extra : ''}`));
}

function expectedOrder(rows: readonly Row[], p: BrowseParams): number[] {
  const key = (r: Row) => (p.sort === 'id' || p.sort === '-id' ? r.id : r.response_business_minutes);
  const desc = p.sort.startsWith('-');
  return rows
    .filter((r) => inRange(r, p.from, p.to))
    .filter((r) => p.site_id === undefined || r.site_id === p.site_id)
    .filter((r) => p.responder_id === undefined || r.responder_id === p.responder_id)
    .filter((r) => p.late === undefined || r.completed_late === p.late)
    .filter((r) => p.within_target === undefined || r.within_target === p.within_target)
    .sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka === null && kb !== null) return 1;
      if (kb === null && ka !== null) return -1;
      if (ka !== null && kb !== null && ka !== kb) return desc ? kb - ka : ka - kb;
      return a.id - b.id;
    })
    .map((r) => r.id);
}

function env(rows: Row[], now = () => 0) {
  return {
    cache: new SnapshotCache({ now }),
    codec: createCursorCodec(),
    current: { version: 1, rows: Object.freeze(rows.slice()) as readonly Row[] },
  };
}

/** Walk all pages; `between(pageNo)` may mutate e.current between pages. */
function walk(
  e: ReturnType<typeof env>,
  extra: string,
  limit: number,
  between?: (page: number) => void,
): number[] {
  const ids: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100000; page++) {
    const p = params(`${extra}&limit=${limit}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    const res = browse({ params: p, current: e.current, cache: e.cache, codec: e.codec, nameOf });
    assert.ok(res.data.length <= limit);
    if (res.next_cursor !== null) assert.equal(res.data.length, limit);
    ids.push(...res.data.map((d) => d.id));
    cursor = res.next_cursor;
    if (cursor === null) return ids;
    between?.(page);
  }
  throw new Error('walk did not terminate');
}

// ---------------------------------------------------------------------------

describe('validate: report params', () => {
  test('accepts a valid range, including from == to', () => {
    assert.deepEqual(parseReportParams(qs('from=2026-10-01&to=2026-10-31')), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(parseReportParams(qs('from=2024-02-29&to=2024-02-29')), { from: '2024-02-29', to: '2024-02-29' });
  });
  test('400 on missing / empty', () => {
    is400(() => parseReportParams(qs('')), /from/);
    is400(() => parseReportParams(qs('from=2026-10-01')), /to/);
    is400(() => parseReportParams(qs('to=2026-10-01')), /from/);
    is400(() => parseReportParams(qs('from=&to=2026-10-01')));
  });
  test('400 on malformed dates', () => {
    for (const bad of ['2026-1-01', '2026-10-1', '26-10-01', '2026/10/01', '2026-10-01T00:00', ' 2026-10-01', '2026-10-01 ', 'abcd-ef-gh', '２０２６-10-01', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32', '2026-02-30', '2026-02-29', '1900-02-29', '2026-04-31']) {
      is400(() => parseReportParams(qs(`from=${encodeURIComponent(bad)}&to=2026-12-31`)), /from/);
      is400(() => parseReportParams(qs(`from=2000-01-01&to=${encodeURIComponent(bad)}`)), /to/);
    }
    assert.ok(isValidDate('2000-02-29'));
    assert.ok(isValidDate('2024-02-29'));
  });
  test('400 when from > to', () => {
    is400(() => parseReportParams(qs('from=2026-10-02&to=2026-10-01')), /after/);
  });
  test('400 on duplicate param', () => {
    is400(() => parseReportParams(qs('from=2026-10-01&from=2026-10-01&to=2026-10-31')), /more than once/);
    is400(() => parseReportParams(qs('from=2026-10-01&to=2026-10-31&to=2026-10-31')), /more than once/);
  });
  test('unknown params ignored', () => {
    assert.deepEqual(parseReportParams(qs('from=2026-10-01&to=2026-10-31&foo=bar&foo=baz&x=')), {
      from: '2026-10-01',
      to: '2026-10-31',
    });
  });
});

describe('validate: browse params', () => {
  const base = 'from=2026-10-01&to=2026-10-31';
  test('defaults', () => {
    assert.deepEqual(parseBrowseParams(qs(base)), { from: '2026-10-01', to: '2026-10-31', sort: 'id', limit: 50 });
  });
  test('all valid values', () => {
    const p = parseBrowseParams(qs(`${base}&site_id=11&responder_id=304&late=true&within_target=false&sort=-response_business_minutes&limit=200&cursor=abc.def&zzz=1`));
    assert.deepEqual(p, {
      from: '2026-10-01', to: '2026-10-31', site_id: 11, responder_id: 304, late: true, within_target: false,
      sort: '-response_business_minutes', limit: 200, cursor: 'abc.def',
    });
    for (const s of SORTS) assert.equal(parseBrowseParams(qs(`${base}&sort=${encodeURIComponent(s)}`)).sort, s);
    assert.equal(parseBrowseParams(qs(`${base}&limit=1`)).limit, 1);
    assert.equal(parseBrowseParams(qs(`${base}&late=false`)).late, false);
    assert.equal(parseBrowseParams(qs(`${base}&within_target=true`)).within_target, true);
  });
  test('inherits report validation', () => {
    is400(() => parseBrowseParams(qs('to=2026-10-31')));
    is400(() => parseBrowseParams(qs('from=2026-02-30&to=2026-10-31')));
    is400(() => parseBrowseParams(qs('from=2026-11-01&to=2026-10-31')));
  });
  test('400 on bad ints', () => {
    for (const k of ['site_id', 'responder_id']) {
      for (const v of ['', '0', '-1', '01', '1.5', '1e3', 'abc', ' 1', '+1', '0x10', '99999999999999999999']) {
        is400(() => parseBrowseParams(qs(`${base}&${k}=${encodeURIComponent(v)}`)), new RegExp(k));
      }
    }
  });
  test('400 on bad booleans', () => {
    for (const k of ['late', 'within_target']) {
      for (const v of ['', 'TRUE', 'True', 'FALSE', '1', '0', 'yes', 'null']) {
        is400(() => parseBrowseParams(qs(`${base}&${k}=${v}`)), new RegExp(k));
      }
    }
  });
  test('400 on bad limit', () => {
    for (const v of ['', '0', '201', '1.5', 'abc', '-1', '1e2', '00', ' 5']) {
      is400(() => parseBrowseParams(qs(`${base}&limit=${encodeURIComponent(v)}`)), /limit/);
    }
    assert.equal(parseBrowseParams(qs(`${base}&limit=007`)).limit, 7); // ^\d+$ allows leading zeros
  });
  test('400 on bad sort', () => {
    for (const v of ['', 'ID', 'minutes', '+id', 'response_business_minutes ', '--id', 'site_id']) {
      is400(() => parseBrowseParams(qs(`${base}&sort=${encodeURIComponent(v)}`)), /sort/);
    }
  });
  test('400 on empty cursor and on duplicates of any known param', () => {
    is400(() => parseBrowseParams(qs(`${base}&cursor=`)), /cursor/);
    for (const extra of ['site_id=1&site_id=1', 'responder_id=1&responder_id=2', 'late=true&late=true', 'within_target=true&within_target=false', 'sort=id&sort=id', 'limit=5&limit=5', 'cursor=a&cursor=a']) {
      is400(() => parseBrowseParams(qs(`${base}&${extra}`)), /more than once/);
    }
  });
});

describe('cursor codec', () => {
  const codec = createCursorCodec();
  const payload = { v: 1 as const, snap: 3, q: 'abcdef0123456789', k: [null, 42] as [number | null, number] };

  test('round trip, opaque format', () => {
    const c = codec.encode(payload);
    assert.match(c, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(codec.decode(c), payload);
    assert.deepEqual(codec.decode(codec.encode({ ...payload, k: [17, 42] })).k, [17, 42]);
  });
  test('different secret -> 400; fixed secret works across instances', () => {
    is400(() => createCursorCodec().decode(codec.encode(payload)), /cursor/);
    const s = Buffer.alloc(32, 9);
    assert.deepEqual(createCursorCodec(s).decode(createCursorCodec(s).encode(payload)), payload);
  });
  test('malformed / forged / tampered -> 400', () => {
    const c = codec.encode(payload);
    const [body, sig] = c.split('.') as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, snap: 4 })).toString('base64url');
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    for (const bad of [
      '', 'x', '.', 'a.', '.b', 'a.b.c', `${c}.x`, `${body}.`, `${body}!.${sig}`, `${body}.${sig}=`,
      `${forgedBody}.${sig}`, `${flip(body, 3)}.${sig}`, `${body}.${flip(sig, 5)}`, `${body}.${sig.slice(0, -2)}`,
      `${body}.${sig}AA`, 'not a cursor at all', `${body}`,
    ]) {
      is400(() => codec.decode(bad), /cursor/);
    }
  });
  test('wrong version / bad shape, even if correctly signed -> 400', () => {
    const s = Buffer.alloc(32, 1);
    const c2 = createCursorCodec(s);
    const signRaw = (obj: unknown) => {
      const b = Buffer.from(JSON.stringify(obj)).toString('base64url');
      return `${b}.${createHmac('sha256', s).update(b).digest('base64url')}`;
    };
    assert.deepEqual(c2.decode(signRaw(payload)), payload); // sanity: our raw signer matches
    for (const bad of [
      { ...payload, v: 2 }, { ...payload, v: '1' }, { ...payload, snap: 1.5 }, { ...payload, q: 5 },
      { ...payload, k: [1] }, { ...payload, k: [1, 2, 3] }, { ...payload, k: ['1', 2] }, { ...payload, k: [1, null] },
      { ...payload, k: 'x' }, [1, 2], null, 'str', 12,
    ]) {
      is400(() => c2.decode(signRaw(bad)), /cursor/);
    }
    const notJson = Buffer.from('{oops').toString('base64url');
    is400(() => c2.decode(`${notJson}.${createHmac('sha256', s).update(notJson).digest('base64url')}`));
  });
});

describe('report', () => {
  test('inRange', () => {
    assert.equal(inRange(row(1), '2026-10-10', '2026-10-10'), true);
    assert.equal(inRange(row(1), '2026-10-11', '2026-10-31'), false);
    assert.equal(inRange(row(1), '2026-10-01', '2026-10-09'), false);
    assert.equal(inRange(row(1, { included: false }), '2026-10-01', '2026-10-31'), false);
  });
  test('toLine has exactly the 7 contract keys, nulls preserved', () => {
    const l = toLine(row(5), nameOf);
    assert.deepEqual(Object.keys(l).sort(), LINE_KEYS);
    assert.deepEqual(l, { id: 5, site_id: 11, responder_id: 301, responder: 'Ana', response_business_minutes: 10, within_target: true, completed_late: false });
    const n = toLine(row(6, { responder_id: null, response_business_minutes: null, within_target: null, completed_late: null }), () => {
      throw new Error('nameOf must not be called for null responder');
    });
    assert.deepEqual(n, { id: 6, site_id: 11, responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: null });
    assert.equal(toLine(row(7, { responder_id: 999 }), nameOf).responder, null);
  });
  test('buildReport counts, shapes, ordering', () => {
    const rows = [
      row(9, { responder_id: 302, within_target: false, completed_late: true }),
      row(3, { responder_id: 301, within_target: true, completed_late: null }),
      row(4, { responder_id: 301, within_target: false, completed_late: true }),
      row(5, { responder_id: 301, within_target: true, completed_late: false }),
      row(2, { responder_id: null, response_business_minutes: null, within_target: null, completed_late: true }),
      row(7, { responder_id: 999, response_business_minutes: 0 }),
      row(8, { responder_id: 303, included: false }), // excluded: not included
      row(10, { responder_id: 303, local_date: '2026-11-01' }), // out of range
      row(1, { responder_id: 302, local_date: '2026-10-01', within_target: true, completed_late: false }),
    ];
    const r = buildReport(rows, '2026-10-01', '2026-10-31', nameOf);
    assert.deepEqual(Object.keys(r).sort(), ['from', 'requests', 'responders', 'to']);
    assert.equal(r.from, '2026-10-01');
    assert.equal(r.to, '2026-10-31');
    assert.deepEqual(r.requests.map((l) => l.id), [1, 2, 3, 4, 5, 7, 9]);
    for (const l of r.requests) assert.deepEqual(Object.keys(l).sort(), LINE_KEYS);
    assert.deepEqual(r.requests[1], { id: 2, site_id: 11, responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: true });
    assert.equal(r.requests[5]!.response_business_minutes, 0);
    for (const s of r.responders) assert.deepEqual(Object.keys(s).sort(), RESP_KEYS);
    assert.deepEqual(r.responders, [
      { id: 301, name: 'Ana', requests: 3, within_target: 2, completed_late: 1 },
      { id: 302, name: 'Bo', requests: 2, within_target: 1, completed_late: 1 },
      { id: 999, name: null, requests: 1, within_target: 1, completed_late: 0 },
    ]);
    assert.deepEqual(buildReport(rows, '2026-12-01', '2026-12-31', nameOf), { from: '2026-12-01', to: '2026-12-31', requests: [], responders: [] });
  });
  test('responder summaries agree with requests on random data', () => {
    const rows = genRows(2000);
    const r = buildReport(rows, '2026-10-05', '2026-10-20', nameOf);
    const ids = new Set(r.responders.map((s) => s.id));
    assert.deepEqual([...ids], [...new Set(r.requests.filter((l) => l.responder_id != null).map((l) => l.responder_id))].sort((a, b) => a! - b!));
    for (const s of r.responders) {
      const mine = r.requests.filter((l) => l.responder_id === s.id);
      assert.equal(s.requests, mine.length);
      assert.equal(s.within_target, mine.filter((l) => l.within_target === true).length);
      assert.equal(s.completed_late, mine.filter((l) => l.completed_late === true).length);
    }
  });
});

describe('SnapshotCache', () => {
  test('get / expiry / sliding ttl / cap', () => {
    let t = 0;
    const c = new SnapshotCache({ ttlMs: 1000, now: () => t });
    const rows: Row[] = [row(1)];
    c.remember({ version: 1, rows });
    assert.equal(c.get(1), rows);
    assert.equal(c.get(2), undefined);
    t = 900;
    assert.equal(c.get(1), rows); // refreshes
    t = 1800;
    assert.equal(c.get(1), rows);
    t = 2801;
    assert.equal(c.get(1), undefined);
    c.remember({ version: 2, rows });
    t = 5000;
    c.remember({ version: 3, rows }); // evicts expired v2
    assert.equal(c.size, 1);
    for (let v = 10; v < 400; v++) c.remember({ version: v, rows });
    assert.ok(c.size <= 200);
    assert.equal(c.get(399), rows);
    assert.equal(c.get(10), undefined);
  });
  test('defaults to 15 minutes', () => {
    let t = 0;
    const c = new SnapshotCache({ now: () => t });
    c.remember({ version: 1, rows: [] });
    t = 15 * 60 * 1000;
    assert.deepEqual(c.get(1), []);
    t = 30 * 60 * 1000 + 1;
    assert.equal(c.get(1), undefined);
  });
});

describe('browse', () => {
  test('sort orders: nulls last in both directions, id tiebreak', () => {
    const rows = [
      row(5, { response_business_minutes: 10 }),
      row(1, { response_business_minutes: null }),
      row(4, { response_business_minutes: 3 }),
      row(2, { response_business_minutes: 10 }),
      row(9, { response_business_minutes: null }),
      row(3, { response_business_minutes: 0 }),
      row(7, { response_business_minutes: 3 }),
    ];
    const e = env(rows);
    const ids = (sort: string) =>
      browse({ params: params(`sort=${sort}&limit=200`), current: e.current, cache: e.cache, codec: e.codec, nameOf }).data.map((d) => d.id);
    assert.deepEqual(ids('id'), [1, 2, 3, 4, 5, 7, 9]);
    assert.deepEqual(ids('-id'), [9, 7, 5, 4, 3, 2, 1]);
    assert.deepEqual(ids('response_business_minutes'), [3, 4, 7, 2, 5, 1, 9]);
    assert.deepEqual(ids('-response_business_minutes'), [2, 5, 4, 7, 3, 1, 9]);
  });

  test('data lines have contract shape; empty result', () => {
    const e = env([row(1), row(2, { responder_id: null, response_business_minutes: null, within_target: null, completed_late: null })]);
    const r = browse({ params: params(), current: e.current, cache: e.cache, codec: e.codec, nameOf });
    assert.deepEqual(Object.keys(r).sort(), ['data', 'next_cursor']);
    assert.equal(r.next_cursor, null);
    for (const l of r.data) assert.deepEqual(Object.keys(l).sort(), LINE_KEYS);
    assert.deepEqual(r.data[1], { id: 2, site_id: 11, responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: null });
    assert.deepEqual(browse({ params: params('site_id=99'), current: e.current, cache: e.cache, codec: e.codec, nameOf }), { data: [], next_cursor: null });
    const none = env([]);
    assert.deepEqual(browse({ params: params(), current: none.current, cache: none.cache, codec: none.codec, nameOf }), { data: [], next_cursor: null });
  });

  test('next_cursor null exactly on the last page (exact multiple of limit)', () => {
    const e = env([row(1), row(2), row(3), row(4)]);
    const p1 = browse({ params: params('limit=2'), current: e.current, cache: e.cache, codec: e.codec, nameOf });
    assert.deepEqual(p1.data.map((d) => d.id), [1, 2]);
    assert.ok(p1.next_cursor);
    const p2 = browse({ params: params(`limit=2&cursor=${p1.next_cursor}`), current: e.current, cache: e.cache, codec: e.codec, nameOf });
    assert.deepEqual(p2.data.map((d) => d.id), [3, 4]);
    assert.equal(p2.next_cursor, null);
    const all = browse({ params: params('limit=4'), current: e.current, cache: e.cache, codec: e.codec, nameOf });
    assert.equal(all.next_cursor, null);
  });

  test('filters: site, responder, late (null matches neither), within_target', () => {
    const rows = genRows(600);
    const e = env(rows);
    for (const f of ['site_id=11', 'site_id=12', 'responder_id=302', 'late=true', 'late=false', 'within_target=true', 'within_target=false', 'site_id=12&late=true&within_target=false&responder_id=301']) {
      const p = params(`${f}&limit=200`);
      const got = walk(e, f, 200);
      assert.deepEqual(got, expectedOrder(rows, p), f);
    }
    const lateT = walk(e, 'late=true', 200), lateF = walk(e, 'late=false', 200), all = walk(e, '', 200);
    const nullLate = rows.filter((r) => inRange(r, '2026-10-01', '2026-10-31') && r.completed_late === null).length;
    assert.ok(nullLate > 0);
    assert.equal(lateT.length + lateF.length + nullLate, all.length);
  });

  test('full walk with limit 1..7 returns every matching row exactly once, in order, for every sort', () => {
    const rows = genRows(300);
    const e = env(rows);
    for (const sort of SORTS) {
      for (const f of ['', 'site_id=11', 'late=false']) {
        const extra = `sort=${sort}${f ? '&' + f : ''}`;
        const expected = expectedOrder(rows, params(extra));
        assert.ok(expected.length > 20);
        for (let limit = 1; limit <= 7; limit++) {
          assert.deepEqual(walk(e, extra, limit), expected, `${extra} limit=${limit}`);
        }
      }
    }
  });

  test('cursor errors: forged, tampered, reused with a different filter/sort/range -> 400', () => {
    const e = env(genRows(50));
    const r = browse({ params: params('limit=2&site_id=11'), current: e.current, cache: e.cache, codec: e.codec, nameOf });
    const c = r.next_cursor!;
    assert.ok(c);
    // same query, different limit is fine
    browse({ params: params(`limit=5&site_id=11&cursor=${c}`), current: e.current, cache: e.cache, codec: e.codec, nameOf });
    // unknown params do not affect q
    browse({ params: params(`limit=5&site_id=11&junk=1&cursor=${c}`), current: e.current, cache: e.cache, codec: e.codec, nameOf });
    for (const other of ['site_id=12', '', 'site_id=11&late=true', 'site_id=11&sort=-id', 'site_id=11&within_target=false', 'site_id=11&responder_id=301']) {
      is400(() => browse({ params: params(`${other}&cursor=${c}`), current: e.current, cache: e.cache, codec: e.codec, nameOf }), /cursor/);
    }
    is400(() => browse({ params: parseBrowseParams(qs(`from=2026-10-02&to=2026-10-31&site_id=11&cursor=${c}`)), current: e.current, cache: e.cache, codec: e.codec, nameOf }), /cursor/);
    // other process' cursor (different secret)
    is400(() => browse({ params: params(`site_id=11&cursor=${c}`), current: e.current, cache: e.cache, codec: createCursorCodec(), nameOf }), /cursor/);
    // tampered payload re-encoded with the original signature
    const [, sig] = c.split('.');
    const decoded = e.codec.decode(c);
    const forged = Buffer.from(JSON.stringify({ ...decoded, k: [0, 0] })).toString('base64url');
    is400(() => browse({ params: params(`site_id=11&cursor=${forged}.${sig}`), current: e.current, cache: e.cache, codec: e.codec, nameOf }), /cursor/);
    is400(() => browse({ params: params('site_id=11&cursor=garbage'), current: e.current, cache: e.cache, codec: e.codec, nameOf }), /cursor/);
    // q is stable: explicit default sort == implicit
    assert.equal(queryHash(params('sort=id')), queryHash(params('')));
    assert.notEqual(queryHash(params('late=true')), queryHash(params('late=false')));
    assert.match(queryHash(params()), /^[0-9a-f]{16}$/);
  });

  // --- stability under change ------------------------------------------------

  /** Mutations applied over a walk: each returns new frozen rows (old arrays untouched). */
  function mutator(e: ReturnType<typeof env>, base: Row[]) {
    let rows = base.slice();
    let nextId = 100000;
    let step = 0;
    const touched = new Set<number>(); // ids whose existence changed
    const keyMoved = new Set<number>();
    return {
      touched,
      keyMoved,
      apply() {
        step++;
        // (a) insert a matching row that sorts early and late
        rows.push(row(nextId++, { response_business_minutes: step % 2 ? 0 : 7, local_date: '2026-10-05' }));
        touched.add(nextId - 1);
        // (b) delete a row
        const delIdx = (step * 37) % rows.length;
        touched.add(rows[delIdx]!.id);
        rows.splice(delIdx, 1);
        // (c) change a stable row's sort key
        const i = (step * 53) % rows.length;
        const r = rows[i]!;
        const cur = r.response_business_minutes;
        // within_target left as-is so filter membership is unchanged
        rows[i] = { ...r, response_business_minutes: cur === null ? 3 : cur >= 4 ? 0 : 7 };
        keyMoved.add(r.id);
        e.current = { version: e.current.version + 1, rows: Object.freeze(rows.slice()) };
      },
      rows: () => rows,
    };
  }

  test('stability with snapshot retained: stable rows exactly once despite insert/delete/key change', () => {
    for (const sort of SORTS) {
      for (const limit of [1, 3, 7, 50]) {
        const base = genRows(250, 11);
        const e = env(base);
        const m = mutator(e, base);
        const ids = walk(e, `sort=${sort}`, limit, () => m.apply());
        const p = params(`sort=${sort}`);
        // everything that existed and matched in the starting snapshot, appears exactly once
        // (served from the snapshot the walk started on)
        const expected = expectedOrder(base, p);
        assert.equal(new Set(ids).size, ids.length, 'no duplicates');
        assert.deepEqual(ids, expected, `${sort} limit=${limit}`);
        // and every row present+matching in all versions is among them
        const finalSet = new Set(expectedOrder(m.rows(), p));
        for (const id of finalSet) if (!m.touched.has(id)) assert.ok(ids.includes(id), `stable row ${id} missing`);
      }
    }
  });

  test('stability with snapshot expired (fallback to live data): unchanged-key rows exactly once', () => {
    for (const sort of SORTS) {
      for (const limit of [1, 4, 7]) {
        let t = 0;
        const base = genRows(200, 23);
        const e = env(base, () => t);
        const m = mutator(e, base);
        const ids = walk(e, `sort=${sort}`, limit, () => {
          m.apply();
          t += 16 * 60 * 1000; // every snapshot expires between pages
        });
        // Duplicates are only acceptable for rows whose key moved on live data.
        const seen = new Set<number>();
        for (const id of ids) {
          if (seen.has(id)) assert.ok(m.keyMoved.has(id), `${sort} limit=${limit}: unexpected duplicate ${id}`);
          seen.add(id);
        }
        const p = params(`sort=${sort}`);
        const finalSet = new Set(expectedOrder(m.rows(), p));
        const startSet = new Set(expectedOrder(base, p));
        // rows that exist+match throughout and never moved their key appear exactly once
        for (const id of startSet) {
          if (m.touched.has(id) || m.keyMoved.has(id) || !finalSet.has(id)) continue;
          assert.equal(ids.filter((x) => x === id).length, 1, `${sort} limit=${limit} row ${id}`);
        }
      }
    }
  });

  test('fallback walk on live data with no changes equals the plain walk', () => {
    let t = 0;
    const base = genRows(120, 5);
    const e = env(base, () => t);
    for (const sort of SORTS) {
      const ids = walk(e, `sort=${sort}`, 3, () => {
        t += 20 * 60 * 1000;
      });
      assert.deepEqual(ids, expectedOrder(base, params(`sort=${sort}`)));
    }
  });

  test('a key change mid-walk is invisible while the snapshot is alive', () => {
    const rows = [row(1, { response_business_minutes: 1 }), row(2, { response_business_minutes: 2 }), row(3, { response_business_minutes: 3 })];
    const e = env(rows);
    const ids = walk(e, 'sort=response_business_minutes', 1, (page) => {
      if (page === 0) {
        // move row 1 (already returned) to the end, and row 3 to the front
        const next = [row(1, { response_business_minutes: 9 }), row(2, { response_business_minutes: 2 }), row(3, { response_business_minutes: 0 })];
        e.current = { version: 2, rows: next };
      }
    });
    assert.deepEqual(ids, [1, 2, 3]);
  });

  test('performance: 12k rows, full first page per sort under budget', () => {
    const rows = genRows(12000, 99);
    const e = env(rows);
    for (const sort of SORTS) {
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) browse({ params: params(`sort=${sort}&limit=200`), current: e.current, cache: e.cache, codec: e.codec, nameOf });
      const per = (performance.now() - t0) / 5;
      assert.ok(per < 50, `${sort}: ${per.toFixed(1)} ms per call`);
    }
  });
});
