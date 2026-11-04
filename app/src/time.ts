// Time module: pure, dependency-free date/time helpers (Intl + Date only).
//
// Conventions
// - Instants are epoch milliseconds (number).
// - Calendar dates are 'YYYY-MM-DD' strings. Calendar arithmetic is done on the
//   proleptic Gregorian calendar via Date.UTC, so it never depends on a timezone.
// - Wall-clock times are 'HH:MM' strings in a site's IANA timezone.
// - Nothing here ever calls `new Date(string)`: parsing is done by strict regexes.

import type { Site, Weekday } from './types.ts';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Calendar helpers (timezone independent)
// ---------------------------------------------------------------------------

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
// Lenient on purpose (hidden data may differ slightly): 'H:MM', 'HH:MM', optional ':SS' (ignored).
const HHMM_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
// 'DD/MM/YYYY HH:mm' as documented; also tolerates 1-digit day/month/hour, 'T' separator and ':SS'.
const DUE_AT_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
// ISO 8601; also tolerates a space for 'T', '+HHMM' / '+HH' offsets, and no zone (= UTC, as documented).
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isRealDate(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Splits a 'YYYY-MM-DD' string; throws RangeError if it is not a real date. */
function splitYmd(date: string): [number, number, number] {
  const m = YMD_RE.exec(date);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isRealDate(y, mo, d)) return [y, mo, d];
  }
  throw new RangeError(`invalid date: ${JSON.stringify(date)}`);
}

/** Date.UTC with years 0..99 treated literally (Date.UTC maps them to 19xx). */
/** Out-of-range fields roll over like Date.UTC (e.g. hour 24 -> next day 00:00). */
function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  if (y >= 100) return Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, ms);
  return dt.getTime();
}

function ymdFromUtcMs(t: number): string {
  const dt = new Date(t);
  return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Strict 'YYYY-MM-DD' that is also a real calendar date (2026-02-30 -> false). */
export function isValidYmd(s: string): boolean {
  if (typeof s !== 'string') return false;
  const m = YMD_RE.exec(s);
  return m !== null && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 'DD/MM/YYYY' -> 'YYYY-MM-DD'; null unless the input is exactly that shape and a real date. */
export function parseDmy(s: string): string | null {
  if (typeof s !== 'string') return null;
  const m = DMY_RE.exec(s);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  return isRealDate(y, mo, d) ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Weekday of a calendar date ('mon'..'sun'). Pure calendar maths: no timezone involved. */
export function weekdayOf(date: string): Weekday {
  const [y, mo, d] = splitYmd(date);
  return WEEKDAYS[new Date(utcMs(y, mo, d)).getUTCDay()]!;
}

/** Calendar arithmetic: 'YYYY-MM-DD' plus n days (n may be negative). */
export function addDays(date: string, n: number): string {
  if (!Number.isInteger(n)) throw new RangeError(`addDays: n must be an integer, got ${n}`);
  const [y, mo, d] = splitYmd(date);
  return ymdFromUtcMs(utcMs(y, mo, d) + n * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// ISO 8601 instants
// ---------------------------------------------------------------------------

/**
 * Strict ISO 8601 date-time with a 'Z' or '±HH:MM' designator -> epoch ms.
 * Seconds and fractional seconds are optional (fraction truncated to ms).
 * Anything else (no designator, out-of-range fields, 2026-02-30...) -> null.
 */
export function parseIsoUtc(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  if (!isRealDate(y, mo, d) || h > 23 || mi > 59 || sec > 59) return null;

  let offsetMin = 0;
  const tz = m[8] ?? 'Z';
  if (tz !== 'Z' && tz !== 'z') {
    const oh = Number(tz.slice(1, 3));
    const om = tz.length > 3 ? Number(tz.slice(-2)) : 0;
    if (oh > 23 || om > 59) return null;
    offsetMin = (tz[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return utcMs(y, mo, d, h, mi, sec, ms) - offsetMin * MS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Timezone conversion (Intl based, cached per timezone)
// ---------------------------------------------------------------------------

type TzFormatters = {
  /** Calendar date only: used by localDate (hot path). */
  date: Intl.DateTimeFormat;
  /** Full wall clock (h23): used to measure the UTC offset. */
  full: Intl.DateTimeFormat;
};

const formatters = new Map<string, TzFormatters>();

/** Cached formatters for a timezone. Throws RangeError for an unknown IANA name. */
function tzFormatters(tz: string): TzFormatters {
  let f = formatters.get(tz);
  if (!f) {
    f = {
      date: new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
      full: new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
    };
    formatters.set(tz, f);
  }
  return f;
}

/** Calendar date ('YYYY-MM-DD') of instant `ms` in timezone `tz`. */
export function localDate(ms: number, tz: string): string {
  const parts = tzFormatters(tz).date.formatToParts(ms);
  let y = '';
  let mo = '';
  let d = '';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') mo = p.value;
    else if (p.type === 'day') d = p.value;
  }
  return `${y.padStart(4, '0')}-${mo}-${d}`;
}

/**
 * UTC offset (ms, local minus UTC) of timezone `tz` at instant `ms`.
 * Second precision, which covers every offset IANA has ever used.
 */
function offsetAt(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  let y = 0;
  let mo = 0;
  let d = 0;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of tzFormatters(tz).full.formatToParts(whole)) {
    switch (p.type) {
      case 'year': y = Number(p.value); break;
      case 'month': mo = Number(p.value); break;
      case 'day': d = Number(p.value); break;
      case 'hour': h = Number(p.value); break;
      case 'minute': mi = Number(p.value); break;
      case 'second': s = Number(p.value); break;
    }
  }
  return utcMs(y, mo, d, h, mi, s) - whole;
}

// wallToUtc is pure, so memoise it: businessSeconds asks for the same
// (date, open/close, tz) triples over and over across ~12k requests.
const WALL_CACHE_MAX = 100_000;
const wallCache = new Map<string, number>();

/**
 * Site-local wall clock ('YYYY-MM-DD', 'HH:MM') in `tz` -> epoch ms.
 *
 * - 'HH' is 00..24; '24:00' means 00:00 of the next day (24:01+ is rejected).
 * - DST gap (the local time does not exist): the result is shifted forward by
 *   the gap length, i.e. the wall time is read with the offset in force before
 *   the transition (Temporal `disambiguation: 'compatible'`).
 *   Sydney 2026-10-04 02:30 -> 2026-10-03T16:30:00Z (= 03:30 +11:00).
 * - DST overlap (the local time occurs twice): the EARLIER instant.
 *   Sydney 2026-04-05 02:30 -> 2026-04-04T15:30:00Z (= 02:30 +11:00).
 *
 * Throws RangeError on a malformed date/time or unknown timezone.
 */
export function wallToUtc(date: string, hhmm: string, tz: string): number {
  const key = `${tz}|${date}|${hhmm}`;
  const hit = wallCache.get(key);
  if (hit !== undefined) return hit;

  const [y, mo, d] = splitYmd(date);
  const tm = HHMM_RE.exec(hhmm);
  const h = tm ? Number(tm[1]) : NaN;
  const mi = tm ? Number(tm[2]) : NaN;
  if (!tm || h > 24 || mi > 59 || (h === 24 && mi !== 0)) {
    throw new RangeError(`invalid wall time: ${JSON.stringify(hhmm)}`);
  }

  // The wall clock written as if it were UTC; Date.UTC rolls 24:00 to the next day.
  const local = utcMs(y, mo, d, h, mi);
  const result = resolveLocal(local, tz);

  if (wallCache.size >= WALL_CACHE_MAX) wallCache.clear();
  wallCache.set(key, result);
  return result;
}

/**
 * Finds the instant whose wall clock in `tz` equals `local` (wall clock encoded as UTC ms).
 *
 * The offsets one day before and one day after bracket any single transition
 * near `local` (real zones never have two transitions within 48 h):
 *   - both candidates valid and different -> overlap -> earlier instant;
 *   - exactly one valid                   -> that one (normal case near a transition);
 *   - none valid                          -> gap -> use the pre-transition offset.
 */
function resolveLocal(local: number, tz: string): number {
  const before = offsetAt(local - MS_PER_DAY, tz);
  const after = offsetAt(local + MS_PER_DAY, tz);

  const c1 = local - before;
  const c2 = local - after;
  const ok1 = offsetAt(c1, tz) === before;
  const ok2 = offsetAt(c2, tz) === after;

  if (ok1 && ok2) return Math.min(c1, c2);
  if (ok1) return c1;
  if (ok2) return c2;
  if (before !== after) return c1; // gap: shift forward by (after - before)

  // Same offset on both sides yet no candidate round-trips: two transitions
  // inside the 48 h window (never happens in tzdata for real zones). Fall back
  // to the classic fixed-point iteration so we still return something sane.
  const t1 = local - offsetAt(local, tz);
  const t2 = local - offsetAt(t1, tz);
  return Math.min(t1, t2);
}

/**
 * Helpdesk `due_at` ('DD/MM/YYYY HH:mm', site-local wall clock) -> epoch ms.
 * Strict: two-digit day/month/hour/minute, real date, hour 00..23. Invalid -> null.
 */
export function parseDueAt(s: string, tz: string): number | null {
  if (typeof s !== 'string') return null;
  const m = DUE_AT_RE.exec(s);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  if (!isRealDate(y, mo, d) || h > 23 || mi > 59 || sec > 59) return null;
  return wallToUtc(`${m[3]}-${pad2(mo)}-${pad2(d)}`, `${pad2(h)}:${pad2(mi)}`, tz) + sec * 1000;
}

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

/**
 * Seconds of [startMs, endMs) that fall inside the site's business hours.
 *
 * Each local calendar day d gets the window [wallToUtc(d, open), wallToUtc(d, close)],
 * unless d is a holiday or its weekday has no hours. close <= open means the window
 * ends on the next day (overnight); '24:00' is next-day midnight. A holiday removes
 * the window that *starts* on that day (including its overnight tail).
 *
 * Iteration starts one day before localDate(start) so the overnight tail of the
 * previous day's window is counted. Windows are merged before summing, so
 * overlapping windows (e.g. an overnight window running into the next day's
 * opening) are never double counted. Only whole seconds are returned.
 */
export function businessSeconds(
  startMs: number,
  endMs: number,
  site: Pick<Site, 'timezone' | 'business_hours' | 'holidays'>,
): number {
  // Rule 4 sums whole seconds: drop sub-second parts first so a .900 s created_at cannot cost a minute.
  startMs = Math.floor(startMs / 1000) * 1000;
  endMs = Math.floor(endMs / 1000) * 1000;
  if (!(endMs > startMs)) return 0;
  const tz = site.timezone;
  const last = localDate(endMs, tz);

  // Windows come out sorted by start (day order, each starting at its own open).
  const windows: Array<[number, number]> = [];
  for (let d = addDays(localDate(startMs, tz), -1); d <= last; d = addDays(d, 1)) {
    if (site.holidays.has(d)) continue;
    const hours = site.business_hours[weekdayOf(d)];
    if (!hours) continue;
    let open: number;
    let close: number;
    try {
      open = wallToUtc(d, hours.open, tz);
      close = wallToUtc(d, hours.close, tz);
      if (close <= open) close = wallToUtc(addDays(d, 1), hours.close, tz);
    } catch {
      continue; // unreadable hours for that weekday: treated as closed, never drops the whole row
    }
    windows.push([open, close]);
  }

  // Clip to [start, end) and sum the union.
  let totalMs = 0;
  let cursor = startMs; // everything before `cursor` is already counted (or excluded)
  for (const [open, close] of windows) {
    const from = Math.max(open, cursor);
    const to = Math.min(close, endMs);
    if (to > from) {
      totalMs += to - from;
      cursor = to;
    }
  }
  return Math.floor(totalMs / 1000);
}
