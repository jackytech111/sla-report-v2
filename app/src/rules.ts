// Rules engine: one helpdesk request + its events + its site -> one Row.
// Source of truth: docs/rules.md (rules 1-7). Interpretation: notes/SPEC.md section 3.
// Pure: no I/O. The only side channel is an optional injected `warn`.

import type { ComputeRow, HelpdeskEvent, HelpdeskRequest, Row, Site } from './types.ts';
import { businessSeconds, localDate, parseDueAt, parseIsoUtc } from './time.ts';

export type Warn = (msg: string, data?: Record<string, unknown>) => void;

/** An event that survived rule 2, with `at` normalised to Unix seconds. */
export interface ValidEvent {
  ev: HelpdeskEvent;
  at: number; // Unix seconds (finite)
}

/** Response targets per priority (rule 5). Case-sensitive, as documented in docs/api.md. */
const TARGETS: Readonly<Record<string, number>> = { High: 60, Medium: 240, Low: 480 };
const DEFAULT_TARGET = 480; // `null` priority (and, defensively, any unknown value)

/** Rule 5: target in minutes. 'High' 60, 'Medium' 240, 'Low' / null / anything else 480. */
export function targetMinutes(priority: unknown): number {
  return typeof priority === 'string' && Object.hasOwn(TARGETS, priority)
    ? TARGETS[priority]!
    : DEFAULT_TARGET;
}

function isSet(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/** Identity key for an event id (tolerates ids arriving as numeric strings). */
function idKey(id: unknown): string {
  return typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : String(id);
}

/** `at` as Unix seconds: a number, a numeric string, or (defensively) an ISO string. */
function atSeconds(at: unknown): number | null {
  if (typeof at === 'number') return Number.isFinite(at) ? at : null;
  if (typeof at === 'string') {
    const s = at.trim();
    if (s === '') return null;
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    const ms = parseIsoUtc(s);
    return ms === null ? null : ms / 1000;
  }
  return null;
}

function compareIds(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const sa = idKey(a);
  const sb = idKey(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Ordering used by every rule: `at` ascending, then `id` ascending. */
function compareEvents(a: ValidEvent, b: ValidEvent): number {
  return a.at - b.at || compareIds(a.ev.id, b.ev.id);
}

/**
 * Rule 2: drop undone events, then sort by (at, id) ascending.
 *
 * Ignored = every event with a non-null `reverts_id` (the reverting event) plus every event whose
 * id is the target of some `reverts_id` (the reverted event). Literal reading of "ignore both":
 * in a chain C reverts B reverts A, all three are ignored (SPEC D-7). A `reverts_id` pointing at
 * an id not among this request's events only removes the reverting event itself.
 *
 * Events whose `at` cannot be read as a time are also dropped (they cannot be ordered).
 */
export function validEvents(events: Iterable<HelpdeskEvent>, warn?: Warn): ValidEvent[] {
  const all: HelpdeskEvent[] = [];
  const reverted = new Set<string>();
  for (const ev of events) {
    if (ev == null || typeof ev !== 'object') continue;
    all.push(ev);
    if (isSet(ev.reverts_id)) reverted.add(idKey(ev.reverts_id));
  }
  const out: ValidEvent[] = [];
  for (const ev of all) {
    if (isSet(ev.reverts_id)) continue;
    if (reverted.has(idKey(ev.id))) continue;
    const at = atSeconds(ev.at);
    if (at === null) {
      warn?.('event has unreadable `at`; ignored', { event_id: ev.id, at: ev.at });
      continue;
    }
    out.push({ ev, at });
  }
  out.sort(compareEvents);
  return out;
}

function hasDueAt(ev: HelpdeskEvent): ev is HelpdeskEvent & { due_at: string } {
  return typeof ev.due_at === 'string' && ev.due_at.trim() !== '';
}

/**
 * Rule 6 deadline (epoch ms) from the valid, sorted events, or null for "no deadline".
 *
 * "The deadline is the `due_at` of the latest event that has one": the latest valid event with a
 * non-empty `due_at` string decides, alone. If that value cannot be parsed, the request has no
 * deadline (completed_late = null); we do NOT fall back to an earlier, parseable `due_at`. The
 * latest event did set a deadline (it "has one"); an older value was superseded by it, so using
 * the older one would assert a deadline the helpdesk no longer holds. (SPEC D-9.)
 * null / '' / whitespace-only `due_at` means the event sets no deadline and is skipped.
 */
export function deadlineMs(valid: readonly ValidEvent[], tz: string, warn?: Warn): number | null {
  for (let i = valid.length - 1; i >= 0; i--) {
    const ev = valid[i]!.ev;
    if (!hasDueAt(ev)) continue;
    const ms = parseDueAt(ev.due_at.trim(), tz);
    if (ms === null) warn?.('unparseable due_at; treated as no deadline', { event_id: ev.id, due_at: ev.due_at });
    return ms;
  }
  return null;
}

/** Rules 1-7 with an optional warning sink. */
export function computeRowWith(
  req: HelpdeskRequest,
  events: Iterable<HelpdeskEvent>,
  site: Site,
  warn?: Warn,
): Row {
  // Rule 1. Date-range filtering happens at query time on `local_date`.
  const createdMs = parseIsoUtc(req.created_at);
  let included = req.status !== 'canceled' && !isSet(req.deleted_at) && !isSet(req.merged_into_id);
  let local_date = '';
  if (createdMs === null) {
    warn?.('unparseable created_at; request excluded', { request_id: req.id, created_at: req.created_at });
    included = false;
  } else {
    local_date = localDate(createdMs, site.timezone);
  }

  // Rule 2.
  const valid = validEvents(events, warn);

  // Rule 3: earliest valid `processing` event with an actor (System events have actor_id null).
  let first: ValidEvent | undefined;
  for (const v of valid) {
    if (v.ev.status === 'processing' && isSet(v.ev.actor_id)) {
      first = v;
      break;
    }
  }

  // Rules 4, 5, 7.
  let responder_id: number | null = null;
  let response_business_minutes: number | null = null;
  let within_target: boolean | null = null;
  if (first) {
    responder_id = first.ev.actor_id;
    if (createdMs !== null) {
      const respMs = first.at * 1000;
      response_business_minutes =
        respMs < createdMs ? 0 : Math.floor(businessSeconds(createdMs, respMs, site) / 60);
      if (
        warn &&
        req.priority !== null &&
        req.priority !== undefined &&
        !(typeof req.priority === 'string' && Object.hasOwn(TARGETS, req.priority))
      ) {
        warn('unknown priority; using the 480-minute target', { request_id: req.id, priority: req.priority });
      }
      within_target = response_business_minutes <= targetMinutes(req.priority);
    }
  }

  // Rules 6, 7. `due_on` on the request is deliberately not used.
  let completed_late: boolean | null = null;
  let lastComplete: ValidEvent | undefined;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i]!.ev.status === 'complete') {
      lastComplete = valid[i];
      break;
    }
  }
  if (lastComplete) {
    const deadline = deadlineMs(valid, site.timezone, warn);
    if (deadline !== null) completed_late = lastComplete.at * 1000 > deadline;
  }

  return {
    id: req.id,
    site_id: req.site_id,
    local_date,
    included,
    responder_id,
    response_business_minutes,
    within_target,
    completed_late,
  };
}

/** The engine used by the store (src/store.ts recompute). */
export const computeRow: ComputeRow = (req, events, site) => computeRowWith(req, events, site);
