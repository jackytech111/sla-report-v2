// Report building and filtered/sorted/keyset-paged browsing over precomputed rows.

import { createHash } from 'node:crypto';
import type { ReportLine, ResponderSummary, Row } from './types.ts';
import type { BrowseParams, SortKey } from './validate.ts';
import { BadRequest } from './validate.ts';
import type { CursorCodec } from './cursor.ts';

export type NameOf = (id: number) => string | null;

export function inRange(row: Row, from: string, to: string): boolean {
  return row.included && from <= row.local_date && row.local_date <= to;
}

export function toLine(row: Row, nameOf: NameOf): ReportLine {
  return {
    id: row.id,
    site_id: row.site_id,
    responder_id: row.responder_id,
    responder: row.responder_id != null ? nameOf(row.responder_id) : null,
    response_business_minutes: row.response_business_minutes,
    within_target: row.within_target,
    completed_late: row.completed_late,
  };
}

export interface Report {
  from: string;
  to: string;
  requests: ReportLine[];
  responders: ResponderSummary[];
}

export function buildReport(rows: readonly Row[], from: string, to: string, nameOf: NameOf): Report {
  const picked: Row[] = [];
  for (const r of rows) if (inRange(r, from, to)) picked.push(r);
  picked.sort((a, b) => a.id - b.id);

  const byResponder = new Map<number, ResponderSummary>();
  const requests: ReportLine[] = new Array(picked.length);
  for (let i = 0; i < picked.length; i++) {
    const r = picked[i]!;
    requests[i] = toLine(r, nameOf);
    if (r.responder_id == null) continue;
    let s = byResponder.get(r.responder_id);
    if (!s) {
      s = { id: r.responder_id, name: nameOf(r.responder_id), requests: 0, within_target: 0, completed_late: 0 };
      byResponder.set(r.responder_id, s);
    }
    s.requests++;
    if (r.within_target === true) s.within_target++;
    if (r.completed_late === true) s.completed_late++;
  }
  const responders = [...byResponder.values()].sort((a, b) => a.id - b.id);
  return { from, to, requests, responders };
}

// ---------------------------------------------------------------------------
// Snapshot cache

export interface Snapshot {
  version: number;
  rows: readonly Row[];
}

export const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
export const SNAPSHOT_MAX = 200;

/**
 * Keeps immutable row arrays by store version so a walk can be served from the
 * version it started on. TTL is sliding (refreshed by remember() and get()).
 * At most `max` versions are kept; least recently used go first.
 */
export class SnapshotCache {
  #ttl: number;
  #max: number;
  #now: () => number;
  #map = new Map<number, { rows: readonly Row[]; at: number }>();

  constructor(opts: { ttlMs?: number; now?: () => number; max?: number } = {}) {
    this.#ttl = opts.ttlMs ?? SNAPSHOT_TTL_MS;
    this.#max = opts.max ?? SNAPSHOT_MAX;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#map.size;
  }

  remember(snap: Snapshot): void {
    const now = this.#now();
    this.#map.delete(snap.version); // re-insert at the MRU end
    this.#map.set(snap.version, { rows: snap.rows, at: now });
    this.evict(now);
  }

  get(version: number): readonly Row[] | undefined {
    const now = this.#now();
    const e = this.#map.get(version);
    if (!e) return undefined;
    if (now - e.at > this.#ttl) {
      this.#map.delete(version);
      return undefined;
    }
    e.at = now;
    this.#map.delete(version);
    this.#map.set(version, e);
    return e.rows;
  }

  evict(now: number = this.#now()): void {
    for (const [v, e] of this.#map) if (now - e.at > this.#ttl) this.#map.delete(v);
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value as number;
      this.#map.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Ordering + browse

type Key = number | null;

function keyOf(row: Row, sort: SortKey): Key {
  return sort === 'id' || sort === '-id' ? row.id : row.response_business_minutes;
}

/**
 * Total order: by key (direction from sort), nulls LAST in both directions,
 * ties by id ascending. Returns <0 when (ka,ida) comes first.
 */
export function compareKeys(ka: Key, ida: number, kb: Key, idb: number, desc: boolean): number {
  if (ka !== kb) {
    if (ka === null) return 1;
    if (kb === null) return -1;
    return desc ? kb - ka : ka - kb;
  }
  return ida - idb;
}

export function comparator(sort: SortKey): (a: Row, b: Row) => number {
  const desc = sort.startsWith('-');
  return (a, b) => compareKeys(keyOf(a, sort), a.id, keyOf(b, sort), b.id, desc);
}

/** sha256 hex prefix of the normalized query (everything but limit and cursor). */
export function queryHash(p: BrowseParams): string {
  const norm = JSON.stringify([
    p.from,
    p.to,
    p.site_id ?? null,
    p.responder_id ?? null,
    p.late ?? null,
    p.within_target ?? null,
    p.sort,
  ]);
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function matches(row: Row, p: BrowseParams): boolean {
  if (!inRange(row, p.from, p.to)) return false;
  if (p.site_id !== undefined && row.site_id !== p.site_id) return false;
  if (p.responder_id !== undefined && row.responder_id !== p.responder_id) return false;
  if (p.late !== undefined && row.completed_late !== p.late) return false;
  if (p.within_target !== undefined && row.within_target !== p.within_target) return false;
  return true;
}

export interface BrowseResult {
  data: ReportLine[];
  next_cursor: string | null;
}

export function browse(opts: {
  params: BrowseParams;
  current: Snapshot;
  cache: SnapshotCache;
  codec: CursorCodec;
  nameOf: NameOf;
}): BrowseResult {
  const { params: p, current, cache, codec, nameOf } = opts;
  const q = queryHash(p);
  const desc = p.sort.startsWith('-');

  let snap: number;
  let rows: readonly Row[];
  let after: [Key, number] | null = null;

  if (p.cursor === undefined) {
    snap = current.version;
    rows = current.rows;
    cache.remember(current);
  } else {
    const c = codec.decode(p.cursor);
    if (c.q !== q) throw new BadRequest('cursor does not match this query');
    if ((p.sort === 'id' || p.sort === '-id') && c.k[0] !== c.k[1]) throw new BadRequest('invalid cursor');
    snap = c.snap;
    // Fallback to live data if the snapshot expired: keyset still makes progress.
    rows = cache.get(snap) ?? current.rows;
    after = c.k;
  }

  const picked: Row[] = [];
  for (const r of rows) {
    if (!matches(r, p)) continue;
    if (after && compareKeys(keyOf(r, p.sort), r.id, after[0], after[1], desc) <= 0) continue;
    picked.push(r);
  }
  picked.sort(comparator(p.sort));

  const page = picked.length > p.limit ? picked.slice(0, p.limit) : picked;
  const data = page.map((r) => toLine(r, nameOf));
  let next_cursor: string | null = null;
  if (picked.length > p.limit) {
    const last = page[page.length - 1]!;
    next_cursor = codec.encode({ v: 1, snap, q, k: [keyOf(last, p.sort), last.id] });
  }
  return { data, next_cursor };
}
