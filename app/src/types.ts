// Shared types. Field names follow docs/api.md (helpdesk) and docs/contract.md (our API).

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type DayHours = { open: string; close: string } | null; // 'HH:MM' site-local wall clock

/** A site as we keep it: hours + holidays already parsed. */
export interface Site {
  id: number;
  name: string;
  timezone: string; // IANA name, e.g. 'Australia/Sydney'
  business_hours: Partial<Record<Weekday, DayHours>>;
  holidays: Set<string>; // 'YYYY-MM-DD' site-local dates, closed all day
}

/** Helpdesk request (GET /v1/requests item, or `request` in a change item). */
export interface HelpdeskRequest {
  id: number;
  site_id: number;
  status: string; // pending | processing | complete | canceled
  priority: string | null; // Low | Medium | High | null
  created_at: string; // ISO 8601 UTC
  deleted_at: string | null;
  merged_into_id: number | null;
  [extra: string]: unknown;
}

/** Helpdesk event (GET /v1/requests/{id}/events item, or `event` in a change item). */
export interface HelpdeskEvent {
  id: number;
  status: string | null; // request status after the event
  at: number; // Unix seconds
  actor_id: number | null; // null = System
  actor_name: string | null;
  due_at: string | null; // 'DD/MM/YYYY HH:mm' site-local
  reverts_id: number | null;
  [extra: string]: unknown;
}

/** Derived per-request result. `responder` (name) is resolved at read time. */
export interface Row {
  id: number;
  site_id: number;
  local_date: string; // created_at as site-local 'YYYY-MM-DD'
  included: boolean; // rule 1 status/deleted/merged filter (date range applied at query time)
  responder_id: number | null;
  response_business_minutes: number | null;
  within_target: boolean | null;
  completed_late: boolean | null;
}

/** One line of `requests` in /api/sla-report and /api/requests (contract.md). */
export interface ReportLine {
  id: number;
  site_id: number;
  responder_id: number | null;
  responder: string | null;
  response_business_minutes: number | null;
  within_target: boolean | null;
  completed_late: boolean | null;
}

export interface ResponderSummary {
  id: number;
  name: string | null;
  requests: number;
  within_target: number;
  completed_late: number;
}

/** Rules engine signature (src/rules.ts). Pure. */
export type ComputeRow = (req: HelpdeskRequest, events: Iterable<HelpdeskEvent>, site: Site) => Row;

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}
