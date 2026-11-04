// In-memory copy of the helpdesk data plus derived rows.
//
// Raw data (requests, events, staff, sites) is upserted idempotently from the change feed.
// Upserts mark requests dirty; recompute() turns dirty requests into Row objects.
// Rows are immutable (frozen) and replaced, never mutated, so a snapshot() array taken at
// version N keeps describing version N while newer versions are built (structural sharing).
// `version` only moves when at least one row actually changed.
import type { ComputeRow, HelpdeskEvent, HelpdeskRequest, Logger, Row, Site } from './types.ts';
import { log as defaultLog } from './log.ts';

const ROW_FIELDS: readonly (keyof Row)[] = [
  'id',
  'site_id',
  'local_date',
  'included',
  'responder_id',
  'response_business_minutes',
  'within_target',
  'completed_late',
];

export function sameRow(a: Row, b: Row): boolean {
  for (const k of ROW_FIELDS) if (a[k] !== b[k]) return false;
  return true;
}

function sameSite(a: Site, b: Site): boolean {
  if (a.name !== b.name || a.timezone !== b.timezone) return false;
  if (JSON.stringify(a.business_hours) !== JSON.stringify(b.business_hours)) return false;
  if (a.holidays.size !== b.holidays.size) return false;
  for (const d of a.holidays) if (!b.holidays.has(d)) return false;
  return true;
}

export interface Snapshot {
  version: number;
  rows: readonly Row[];
}

export class Store {
  requests: Map<number, HelpdeskRequest>;
  events: Map<number, Map<number, HelpdeskEvent>>;
  staff: Map<number, string>;
  lastActorName: Map<number, { name: string; at: number }>;
  sites: Map<number, Site>;
  rows: Map<number, Row>;
  /** Bumped when (and only when) at least one row changed in a recompute. */
  version: number;
  /** Bumped when a staff/actor name changes (names are resolved at read time, not in rows). */
  namesVersion: number;
  ready: boolean;
  private dirty: Set<number>;
  private log: Logger;
  private warnedSites: Set<number>;
  private snap: Snapshot | null;

  constructor(opts: { log?: Logger } = {}) {
    this.requests = new Map();
    this.events = new Map();
    this.staff = new Map();
    this.lastActorName = new Map();
    this.sites = new Map();
    this.rows = new Map();
    this.version = 0;
    this.namesVersion = 0;
    this.ready = false;
    this.dirty = new Set();
    this.log = opts.log ?? defaultLog;
    this.warnedSites = new Set();
    this.snap = null;
  }

  /** Distinct site ids seen on requests but missing from the site list (triggers a site reload). */
  get unknownSiteCount(): number {
    return this.warnedSites.size;
  }

  get dirtyCount(): number {
    return this.dirty.size;
  }

  /** Store the request's current state. Returns true if anything changed. */
  upsertRequest(r: HelpdeskRequest): boolean {
    const prev = this.requests.get(r.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(r)) return false;
    this.requests.set(r.id, r);
    this.dirty.add(r.id);
    return true;
  }

  /** Store an event under its request. Returns true if anything changed. */
  upsertEvent(requestId: number, e: HelpdeskEvent): boolean {
    if (e.actor_id != null && typeof e.actor_name === 'string' && e.actor_name !== '') {
      const seen = this.lastActorName.get(e.actor_id);
      if (!seen || e.at >= seen.at) {
        if (!seen || seen.name !== e.actor_name) this.namesVersion++;
        this.lastActorName.set(e.actor_id, { name: e.actor_name, at: e.at });
      }
    }
    let evs = this.events.get(requestId);
    if (!evs) {
      evs = new Map();
      this.events.set(requestId, evs);
    }
    const prev = evs.get(e.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(e)) return false;
    evs.set(e.id, e);
    this.dirty.add(requestId);
    return true;
  }

  /** Current staff name. No recompute: rows hold ids, names resolve at read time. */
  setStaff(id: number, name: string): void {
    if (this.staff.get(id) === name) return;
    this.staff.set(id, name);
    this.namesVersion++;
  }

  /**
   * Replace the site list. Returns ids of sites that were added, changed or removed; the
   * requests of those sites are marked dirty.
   */
  setSites(sites: Site[]): number[] {
    const changed: number[] = [];
    const next = new Map<number, Site>();
    for (const s of sites) next.set(s.id, s);
    for (const [id, s] of next) {
      const prev = this.sites.get(id);
      if (!prev || !sameSite(prev, s)) changed.push(id);
    }
    for (const id of this.sites.keys()) if (!next.has(id)) changed.push(id);
    this.sites = next;
    if (changed.length) {
      const set = new Set(changed);
      for (const r of this.requests.values()) if (set.has(r.site_id)) this.dirty.add(r.id);
      for (const id of set) if (next.has(id)) this.warnedSites.delete(id);
    }
    return changed;
  }

  markDirty(id: number): void {
    this.dirty.add(id);
  }

  /** Recompute dirty requests. Returns how many rows changed (added, replaced or removed). */
  recompute(computeRow: ComputeRow): number {
    if (this.dirty.size === 0) return 0;
    let changed = 0;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const req = this.requests.get(id);
      if (!req) {
        if (this.rows.delete(id)) changed++;
        continue;
      }
      const site = this.sites.get(req.site_id);
      if (!site) {
        if (!this.warnedSites.has(req.site_id)) {
          this.warnedSites.add(req.site_id);
          this.log.warn('request has unknown site_id; excluded from report', { request_id: id, site_id: req.site_id });
        }
        if (this.rows.delete(id)) changed++;
        continue;
      }
      let row: Row;
      try {
        const evs = this.events.get(id);
        row = computeRow(req, evs ? evs.values() : [], site);
      } catch (err) {
        this.log.warn('computeRow failed; row dropped', { request_id: id, error: String((err as Error)?.message ?? err) });
        if (this.rows.delete(id)) changed++;
        continue;
      }
      const prev = this.rows.get(id);
      if (prev && sameRow(prev, row)) continue;
      this.rows.set(id, Object.isFrozen(row) ? row : Object.freeze({ ...row }));
      changed++;
    }
    if (changed > 0) this.version++;
    return changed;
  }

  /** Mark every known request (and every orphan row) dirty, then recompute. */
  recomputeAll(computeRow: ComputeRow): number {
    for (const id of this.requests.keys()) this.dirty.add(id);
    for (const id of this.rows.keys()) this.dirty.add(id);
    return this.recompute(computeRow);
  }

  /** Current staff name ?? latest actor_name seen for that id ?? null. */
  nameOf(responderId: number): string | null {
    return this.staff.get(responderId) ?? this.lastActorName.get(responderId)?.name ?? null;
  }

  /** Frozen array of current rows; the same instance is returned until `version` changes. */
  snapshot(): Snapshot {
    if (!this.snap || this.snap.version !== this.version) {
      this.snap = Object.freeze({ version: this.version, rows: Object.freeze([...this.rows.values()]) });
    }
    return this.snap;
  }
}
