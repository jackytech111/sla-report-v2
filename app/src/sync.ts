// Helpdesk -> Store synchronisation (SPEC section 4).
//
// Bootstrap: sites (+ holidays) and staff, then the whole change feed, then recomputeAll and
// store.ready = true. Live loop: every pollMs drain the feed from the latest cursor and
// recompute dirty rows; every refreshMetaMs reload sites/holidays/staff.
//
// Change items are applied idempotently (upserts keyed by id; the feed carries the CURRENT
// request state), so duplicates are harmless and a 410 (expired cursor) is handled by simply
// replaying the feed from the beginning.
import type { ComputeRow, DayHours, HelpdeskEvent, HelpdeskRequest, Logger, Site, Weekday } from './types.ts';
import { HelpdeskClient, ClosedError, GoneError, HttpError } from './helpdesk.ts';

const STAFF_REFRESH_MS = 60_000;
const UNKNOWN_SITE_RELOAD_MS = 60_000;
const RECOMPUTE_EVERY_PAGES = 20;
import { Store } from './store.ts';
import { log as defaultLog } from './log.ts';

/** Strict 'DD/MM/YYYY' -> 'YYYY-MM-DD' (real calendar date) or null. Also accepts 'YYYY-MM-DD'. */
export function parseDmyDate(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  let y: number, m: number, d: number;
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim()); // 1-digit day/month tolerated
  if (match) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
  } else {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!match) return null;
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  }
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

interface ApiSite {
  id: number;
  name: string;
  timezone: string;
  business_hours: Partial<Record<Weekday, DayHours>>;
}

interface ChangeItem {
  seq?: number;
  type?: string;
  at?: string;
  request_id?: number;
  request?: HelpdeskRequest;
  event?: HelpdeskEvent & { request_id?: number };
  staff?: { id: number; name: string };
  [k: string]: unknown;
}

interface ChangesPage {
  data: ChangeItem[];
  next_cursor?: string | null;
  has_more?: boolean;
}

interface ListPage<T> {
  data: T[];
  has_more?: boolean;
  page?: number;
  total_pages?: number;
}

export interface SyncStats {
  feedPages: number;
  items: number;
  dupItems: number; // items whose seq was already seen (also counts replays after a 410)
  seqMin: number | null;
  seqMax: number | null;
  seqOutOfOrder: number; // new (unseen) seq lower than the max seen so far
  itemsWithoutSeq: number;
  types: Record<string, number>;
  unknownTypes: Record<string, number>;
  badItems: number;
  polls: number;
  pollErrors: number;
  lastPollAt: number | null; // ms epoch of the last successful drain
  lastChangeAt: number | null; // ms epoch when the last non-empty batch was applied
  cursorRestarts: number;
  metaRefreshes: number;
  rowsChanged: number;
  bootstrapMs: number | null;
}

export interface SyncOptions {
  client: HelpdeskClient;
  store: Store;
  computeRow: ComputeRow;
  log?: Logger;
  pollMs?: number;
  refreshMetaMs?: number;
  feedLimit?: number;
  /** Wait before retrying a failed bootstrap step (non-transient error). Default pollMs. */
  retryMs?: number;
}

export class Sync {
  stats: SyncStats;
  bootstrapped: Promise<void>;
  private client: HelpdeskClient;
  private store: Store;
  private computeRow: ComputeRow;
  private log: Logger;
  private pollMs: number;
  private refreshMetaMs: number;
  private feedLimit: number;
  private retryMs: number;
  private cursor: string | null;
  private seenSeq: Set<number>;
  private warnedTypes: Set<string>;
  private stopped: boolean;
  private wake: (() => void) | null;
  private resolveBootstrapped: () => void;
  private lastMetaAt: number;
  private lastStaffAt: number;
  private running: Promise<void> | null;

  constructor(opts: SyncOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.computeRow = opts.computeRow;
    this.log = opts.log ?? defaultLog;
    this.pollMs = opts.pollMs ?? 10_000;
    this.refreshMetaMs = opts.refreshMetaMs ?? 300_000;
    this.feedLimit = opts.feedLimit ?? 500;
    this.retryMs = opts.retryMs ?? this.pollMs;
    this.cursor = null;
    this.seenSeq = new Set();
    this.warnedTypes = new Set();
    this.stopped = false;
    this.wake = null;
    this.lastMetaAt = 0;
    this.lastStaffAt = 0;
    this.running = null;
    this.resolveBootstrapped = () => {};
    this.bootstrapped = new Promise<void>((resolve) => {
      this.resolveBootstrapped = resolve;
    });
    this.stats = {
      feedPages: 0,
      items: 0,
      dupItems: 0,
      seqMin: null,
      seqMax: null,
      seqOutOfOrder: 0,
      itemsWithoutSeq: 0,
      types: {},
      unknownTypes: {},
      badItems: 0,
      polls: 0,
      pollErrors: 0,
      lastPollAt: null,
      lastChangeAt: null,
      cursorRestarts: 0,
      metaRefreshes: 0,
      rowsChanged: 0,
      bootstrapMs: null,
    };
  }

  /**
   * Bootstrap, then run the live loop until stop(). Resolves once stopped; never rejects on
   * transient (or even persistent) API errors: they are logged and retried.
   */
  start(): Promise<void> {
    if (!this.running) this.running = this.run();
    return this.running;
  }

  /** Stop the loop and close the client (aborts in-flight calls and retry waits). */
  stop(): void {
    this.stopped = true;
    this.client.close();
    this.wake?.();
  }

  private async run(): Promise<void> {
    const t0 = Date.now();
    // Bootstrap: retry until it succeeds or we are stopped.
    while (!this.stopped) {
      try {
        await this.loadMeta();
        await this.drain();
        this.stats.rowsChanged += this.store.recomputeAll(this.computeRow);
        this.store.ready = true;
        this.stats.bootstrapMs = Date.now() - t0;
        this.log.info('bootstrap complete', {
          ms: this.stats.bootstrapMs,
          requests: this.store.requests.size,
          rows: this.store.rows.size,
          items: this.stats.items,
          dup_items: this.stats.dupItems,
          http429: this.client.stats.http429,
        });
        this.resolveBootstrapped();
        break;
      } catch (err) {
        if (this.stopped || err instanceof ClosedError) return;
        this.log.warn('bootstrap failed; retrying', { error: String((err as Error)?.message ?? err) });
        await this.pause(this.retryMs);
      }
    }
    while (!this.stopped) {
      await this.pause(this.pollMs);
      if (this.stopped) break;
      await this.pollOnce();
    }
  }

  /** One live cycle: maybe refresh metadata, drain the feed, recompute. Never throws. */
  async pollOnce(): Promise<void> {
    // Metadata refresh is isolated: a failing sites/holidays/staff call must never stop the feed (level 3).
    const now = Date.now();
    const unknownSites = this.store.unknownSiteCount > 0 && now - this.lastMetaAt >= UNKNOWN_SITE_RELOAD_MS;
    if (now - this.lastMetaAt >= this.refreshMetaMs || unknownSites) {
      try {
        await this.loadMeta();
      } catch (err) {
        if (this.stopped || err instanceof ClosedError) return;
        this.lastMetaAt = Date.now(); // back off until the next refresh period instead of retrying every poll
        this.stats.pollErrors++;
        this.log.warn('metadata refresh failed; keeping the previous sites/staff', { error: String((err as Error)?.message ?? err) });
      }
    } else if (now - this.lastStaffAt >= STAFF_REFRESH_MS) {
      try {
        await this.loadStaff();
      } catch (err) {
        if (this.stopped || err instanceof ClosedError) return;
        this.lastStaffAt = Date.now();
        this.log.warn('staff refresh failed', { error: String((err as Error)?.message ?? err) });
      }
    }
    try {
      await this.drain();
      const changed = this.store.recompute(this.computeRow);
      this.stats.rowsChanged += changed;
      this.stats.polls++;
      this.stats.lastPollAt = Date.now();
      if (changed) this.log.debug('rows recomputed', { changed, version: this.store.version });
    } catch (err) {
      if (this.stopped || err instanceof ClosedError) return;
      this.stats.pollErrors++;
      this.log.warn('poll failed', { error: String((err as Error)?.message ?? err) });
    }
  }

  private pause(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const body = await this.client.get<ListPage<T>>(path, page > 1 ? { page } : undefined);
      if (!body || !Array.isArray(body.data)) throw new Error(`unexpected body from ${path}`);
      out.push(...body.data);
      const more = body.has_more === true || (typeof body.total_pages === 'number' && page < body.total_pages);
      if (!more || body.data.length === 0) break;
    }
    return out;
  }

  /** Load sites + holidays + staff into the store. A changed site marks its requests dirty. */
  async loadMeta(): Promise<void> {
    const apiSites = await this.getAll<ApiSite>('/v1/sites');
    const sites: Site[] = [];
    for (const s of apiSites) {
      const hol = await this.getAll<{ date: string; name?: string }>(`/v1/sites/${s.id}/holidays`);
      const holidays = new Set<string>();
      for (const h of hol) {
        const d = parseDmyDate(h?.date);
        if (d) holidays.add(d);
        else this.log.warn('unparseable holiday date; ignored', { site_id: s.id, date: h?.date });
      }
      sites.push({ id: s.id, name: s.name, timezone: s.timezone, business_hours: s.business_hours ?? {}, holidays });
    }
    const staff = await this.getAll<{ id: number; name: string }>('/v1/staff');
    const changed = this.store.setSites(sites);
    for (const p of staff) if (p && typeof p.id === 'number' && typeof p.name === 'string') this.store.setStaff(p.id, p.name);
    this.lastStaffAt = Date.now();
    if (changed.length && this.lastMetaAt !== 0) this.log.info('sites changed', { site_ids: changed });
    this.lastMetaAt = Date.now();
    this.stats.metaRefreshes++;
  }

  /** Current staff names only (one call); renames usually also arrive as staff.updated in the feed. */
  async loadStaff(): Promise<void> {
    const staff = await this.getAll<{ id: number; name: string }>('/v1/staff');
    for (const p of staff) if (p && typeof p.id === 'number' && typeof p.name === 'string') this.store.setStaff(p.id, p.name);
    this.lastStaffAt = Date.now();
  }

  /** Read the change feed from the current cursor until has_more is false. */
  async drain(): Promise<number> {
    let applied = 0;
    for (;;) {
      if (this.stopped) throw new ClosedError();
      const params: Record<string, string | number> = { limit: this.feedLimit };
      if (this.cursor) params.cursor = this.cursor;
      let page: ChangesPage;
      try {
        page = await this.client.get<ChangesPage>('/v1/changes', params);
      } catch (err) {
        const rejected = err instanceof HttpError && err.status === 400 && this.cursor; // cursor no longer accepted
        if ((err instanceof GoneError || rejected) && this.cursor) {
          this.log.warn(`change-feed cursor ${err instanceof GoneError ? 'expired (410)' : 'rejected (400)'}; replaying from the start`);
          this.cursor = null;
          this.stats.cursorRestarts++;
          continue;
        }
        throw err;
      }
      if (!page || !Array.isArray(page.data)) throw new Error('unexpected /v1/changes body');
      this.stats.feedPages++;
      for (const item of page.data) this.apply(item);
      applied += page.data.length;
      // During a long drain (e.g. a replay after 410) publish progress every few pages so live
      // changes are not held back until the whole feed is read. Only once ready (bootstrap
      // recomputes everything at the end).
      if (this.store.ready && this.stats.feedPages % RECOMPUTE_EVERY_PAGES === 0) {
        this.stats.rowsChanged += this.store.recompute(this.computeRow);
      }
      if (page.data.length) this.stats.lastChangeAt = Date.now();
      const prevCursor = this.cursor;
      if (page.next_cursor) this.cursor = page.next_cursor;
      if (!page.has_more) break;
      if (page.data.length === 0 && this.cursor === prevCursor) break; // no progress possible
    }
    return applied;
  }

  /** Apply one change item (idempotent). */
  apply(item: ChangeItem): void {
    const s = this.stats;
    s.items++;
    if (!item || typeof item !== 'object') {
      s.badItems++;
      return;
    }
    if (typeof item.seq === 'number') {
      if (this.seenSeq.has(item.seq)) s.dupItems++;
      else {
        if (s.seqMax != null && item.seq < s.seqMax) s.seqOutOfOrder++;
        this.seenSeq.add(item.seq);
      }
      if (s.seqMin == null || item.seq < s.seqMin) s.seqMin = item.seq;
      if (s.seqMax == null || item.seq > s.seqMax) s.seqMax = item.seq;
    } else s.itemsWithoutSeq++;
    const type = typeof item.type === 'string' ? item.type : '(none)';
    s.types[type] = (s.types[type] ?? 0) + 1;

    let handled = false;
    if (item.request && typeof item.request === 'object' && typeof item.request.id === 'number') {
      this.store.upsertRequest(item.request);
      handled = true;
    }
    if (item.event && typeof item.event === 'object' && typeof item.event.id === 'number') {
      const rid = item.request_id ?? item.event.request_id;
      if (typeof rid === 'number') {
        this.store.upsertEvent(rid, item.event);
      } else {
        s.badItems++;
        this.log.warn('event change item without request_id; ignored', { seq: item.seq, event_id: item.event.id });
      }
      handled = true;
    }
    if (item.staff && typeof item.staff === 'object' && typeof item.staff.id === 'number' && typeof item.staff.name === 'string') {
      this.store.setStaff(item.staff.id, item.staff.name);
      handled = true;
    }
    if (!handled) {
      s.unknownTypes[type] = (s.unknownTypes[type] ?? 0) + 1;
      if (!this.warnedTypes.has(type)) {
        this.warnedTypes.add(type);
        this.log.warn('unknown change item type; ignored', { type, seq: item.seq, keys: Object.keys(item) });
      }
    }
  }
}
