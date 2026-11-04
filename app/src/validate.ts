// Query-string validation for /api/sla-report and /api/requests (SPEC section 5).
// Every failure throws BadRequest (status 400) with a human-readable message.

export class BadRequest extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export type SortKey = 'id' | '-id' | 'response_business_minutes' | '-response_business_minutes';
export const SORTS: readonly SortKey[] = ['id', '-id', 'response_business_minutes', '-response_business_minutes'];

export interface ReportParams {
  from: string;
  to: string;
}

export interface BrowseParams extends ReportParams {
  site_id?: number;
  responder_id?: number;
  late?: boolean;
  within_target?: boolean;
  sort: SortKey;
  limit: number;
  cursor?: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INT_RE = /^[1-9]\d*$/;
const LIMIT_RE = /^\d+$/;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Strict YYYY-MM-DD that is a real proleptic-Gregorian calendar date. */
export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= dim;
}

/** Returns the single value of `name`, undefined when absent; 400 when repeated. */
function single(q: URLSearchParams, name: string): string | undefined {
  const all = q.getAll(name);
  if (all.length > 1) throw new BadRequest(`parameter ${name} given more than once`);
  return all.length === 1 ? all[0] : undefined;
}

function requiredDate(q: URLSearchParams, name: string): string {
  const v = single(q, name);
  if (v === undefined || v === '') throw new BadRequest(`missing ${name} (expected YYYY-MM-DD)`);
  if (!isValidDate(v)) throw new BadRequest(`invalid ${name}: expected a real date as YYYY-MM-DD`);
  return v;
}

export function parseReportParams(q: URLSearchParams): ReportParams {
  const from = requiredDate(q, 'from');
  const to = requiredDate(q, 'to');
  if (from > to) throw new BadRequest('from must not be after to');
  return { from, to };
}

function optionalInt(q: URLSearchParams, name: string): number | undefined {
  const v = single(q, name);
  if (v === undefined) return undefined;
  if (!INT_RE.test(v)) throw new BadRequest(`invalid ${name}: expected a positive integer`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new BadRequest(`invalid ${name}: out of range`);
  return n;
}

function optionalBool(q: URLSearchParams, name: string): boolean | undefined {
  const v = single(q, name);
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new BadRequest(`invalid ${name}: expected true or false`);
}

export function parseBrowseParams(q: URLSearchParams): BrowseParams {
  const { from, to } = parseReportParams(q);
  const out: BrowseParams = { from, to, sort: 'id', limit: DEFAULT_LIMIT };

  const site_id = optionalInt(q, 'site_id');
  if (site_id !== undefined) out.site_id = site_id;
  const responder_id = optionalInt(q, 'responder_id');
  if (responder_id !== undefined) out.responder_id = responder_id;
  const late = optionalBool(q, 'late');
  if (late !== undefined) out.late = late;
  const within_target = optionalBool(q, 'within_target');
  if (within_target !== undefined) out.within_target = within_target;

  const sort = single(q, 'sort');
  if (sort !== undefined) {
    if (!(SORTS as readonly string[]).includes(sort)) {
      throw new BadRequest(`invalid sort: expected one of ${SORTS.join(', ')}`);
    }
    out.sort = sort as SortKey;
  }

  const limit = single(q, 'limit');
  if (limit !== undefined) {
    if (!LIMIT_RE.test(limit)) throw new BadRequest(`invalid limit: expected an integer ${1}..${MAX_LIMIT}`);
    const n = Number(limit);
    if (n < 1 || n > MAX_LIMIT) throw new BadRequest(`invalid limit: expected an integer 1..${MAX_LIMIT}`);
    out.limit = n;
  }

  const cursor = single(q, 'cursor');
  if (cursor !== undefined) {
    if (cursor === '') throw new BadRequest('invalid cursor');
    out.cursor = cursor;
  }
  return out;
}
