import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DayHours, HelpdeskEvent, HelpdeskRequest, Row, Site, Weekday } from '../src/types.ts';
import { computeRow, computeRowWith, deadlineMs, targetMinutes, validEvents } from '../src/rules.ts';
import { parseIsoUtc, wallToUtc } from '../src/time.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WEEKDAY_9_TO_6: Partial<Record<Weekday, DayHours>> = {
  mon: { open: '08:00', close: '18:00' },
  tue: { open: '08:00', close: '18:00' },
  wed: { open: '08:00', close: '18:00' },
  thu: { open: '08:00', close: '18:00' },
  fri: { open: '08:00', close: '18:00' },
  sat: null,
  sun: null,
};

function makeSite(id: number, timezone: string, holidays: string[] = []): Site {
  return { id, name: `site ${id}`, timezone, business_hours: WEEKDAY_9_TO_6, holidays: new Set(holidays) };
}

const SG = makeSite(11, 'Asia/Singapore'); // UTC+8, no DST
const SYD = makeSite(12, 'Australia/Sydney'); // +10 / +11 (DST from 2026-10-04)

// 2026-10-03 is a Saturday, 2026-10-05 a Monday.

/** Site-local wall clock -> Unix seconds. */
function at(site: Site, date: string, hhmm: string, plusSeconds = 0): number {
  return wallToUtc(date, hhmm, site.timezone) / 1000 + plusSeconds;
}

/** Site-local wall clock -> ISO UTC string (for created_at). */
function isoAt(site: Site, date: string, hhmm: string, plusSeconds = 0): string {
  return new Date(at(site, date, hhmm, plusSeconds) * 1000).toISOString().replace('.000Z', 'Z');
}

function req(over: Partial<HelpdeskRequest> = {}): HelpdeskRequest {
  return {
    id: 1,
    site_id: SG.id,
    status: 'processing',
    priority: 'High',
    created_at: isoAt(SG, '2026-10-05', '09:00'), // Monday 09:00 SGT
    deleted_at: null,
    merged_into_id: null,
    ...over,
  };
}

let nextId = 1000;
function ev(over: Partial<HelpdeskEvent> = {}): HelpdeskEvent {
  return {
    id: nextId++,
    status: 'processing',
    at: at(SG, '2026-10-05', '09:30'),
    actor_id: 304,
    actor_name: 'Benjamin Tan',
    due_at: null,
    reverts_id: null,
    ...over,
  };
}

function row(r: HelpdeskRequest, events: HelpdeskEvent[], site: Site = SG): Row {
  return computeRow(r, events, site);
}

/** Collecting warn sink. */
function sink(): { warn: (msg: string, data?: Record<string, unknown>) => void; msgs: string[] } {
  const msgs: string[] = [];
  return { warn: (m) => void msgs.push(m), msgs };
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('row shape', () => {
  test('returns exactly the Row fields', () => {
    const r = row(req({ extra_field: 'x', due_on: '2026-10-07' }), [ev()]);
    assert.deepEqual(Object.keys(r).sort(), [
      'completed_late',
      'id',
      'included',
      'local_date',
      'responder_id',
      'response_business_minutes',
      'site_id',
      'within_target',
    ]);
    assert.equal(r.id, 1);
    assert.equal(r.site_id, 11);
  });

  test('accepts any iterable of events (e.g. Map.values())', () => {
    const m = new Map<number, HelpdeskEvent>([[1, ev({ id: 1 })]]);
    assert.equal(row(req(), [...m.values()]).responder_id, 304);
    assert.equal(computeRow(req(), m.values(), SG).responder_id, 304);
  });

  test('does not mutate its inputs', () => {
    const events = [ev({ id: 2, at: at(SG, '2026-10-05', '10:00') }), ev({ id: 1 })];
    const snapshot = JSON.stringify(events);
    const r = req();
    const rs = JSON.stringify(r);
    row(r, events);
    assert.equal(JSON.stringify(events), snapshot);
    assert.equal(JSON.stringify(r), rs);
  });
});

// ---------------------------------------------------------------------------
// Rule 1
// ---------------------------------------------------------------------------

describe('rule 1: which requests count', () => {
  test('ordinary request is included', () => {
    assert.equal(row(req(), []).included, true);
  });

  for (const status of ['pending', 'processing', 'complete']) {
    test(`status ${status} is included`, () => {
      assert.equal(row(req({ status }), []).included, true);
    });
  }

  test('canceled -> excluded', () => {
    assert.equal(row(req({ status: 'canceled' }), []).included, false);
  });

  test('deleted_at set -> excluded', () => {
    assert.equal(row(req({ deleted_at: '2026-10-06T00:00:00Z' }), []).included, false);
  });

  test('merged_into_id set -> excluded', () => {
    assert.equal(row(req({ merged_into_id: 41999 }), []).included, false);
  });

  test('deleted_at / merged_into_id undefined count as not set', () => {
    const r = req();
    delete (r as Partial<HelpdeskRequest>).deleted_at;
    delete (r as Partial<HelpdeskRequest>).merged_into_id;
    assert.equal(row(r, []).included, true);
  });

  test('excluded rows still compute their fields', () => {
    const r = row(req({ status: 'canceled' }), [ev()]);
    assert.equal(r.responder_id, 304);
    assert.equal(r.response_business_minutes, 30);
  });

  test('local_date is the site-local date of created_at (Singapore)', () => {
    // 2026-10-05T16:30Z = 2026-10-06 00:30 SGT
    assert.equal(row(req({ created_at: '2026-10-05T16:30:00Z' }), []).local_date, '2026-10-06');
    assert.equal(row(req({ created_at: '2026-10-05T15:59:59Z' }), []).local_date, '2026-10-05');
  });

  test('local_date near midnight in Sydney (DST, +11)', () => {
    const s = { site_id: SYD.id };
    // 12:59:59Z = 23:59:59 AEDT on the 15th; 13:00:00Z = 00:00 on the 16th
    assert.equal(row(req({ ...s, created_at: '2026-10-15T12:59:59Z' }), [], SYD).local_date, '2026-10-15');
    assert.equal(row(req({ ...s, created_at: '2026-10-15T13:00:00Z' }), [], SYD).local_date, '2026-10-16');
    // Before DST (+10): 2026-09-30T14:00Z = 2026-10-01 00:00 AEST
    assert.equal(row(req({ ...s, created_at: '2026-09-30T13:59:59Z' }), [], SYD).local_date, '2026-09-30');
    assert.equal(row(req({ ...s, created_at: '2026-09-30T14:00:00Z' }), [], SYD).local_date, '2026-10-01');
  });

  test('created_at with an offset designator is honoured', () => {
    assert.equal(row(req({ created_at: '2026-10-06T00:30:00+08:00' }), []).local_date, '2026-10-06');
  });

  test('unparseable created_at -> excluded, warned, no response minutes', () => {
    const w = sink();
    const r = computeRowWith(req({ created_at: 'yesterday' }), [ev()], SG, w.warn);
    assert.equal(r.included, false);
    assert.equal(r.local_date, '');
    assert.equal(r.response_business_minutes, null);
    assert.equal(r.within_target, null);
    assert.ok(w.msgs.some((m) => m.includes('created_at')));
  });
});

// ---------------------------------------------------------------------------
// Rule 2
// ---------------------------------------------------------------------------

describe('rule 2: undone events', () => {
  test('revert pair: both the reverted and the reverting event are ignored', () => {
    const a = ev({ id: 1, at: at(SG, '2026-10-05', '09:10'), actor_id: 1 });
    const b = ev({ id: 2, at: at(SG, '2026-10-05', '09:20'), actor_id: 2, reverts_id: 1 });
    const c = ev({ id: 3, at: at(SG, '2026-10-05', '09:40'), actor_id: 3 });
    assert.deepEqual(validEvents([a, b, c]).map((v) => v.ev.id), [3]);
    const r = row(req(), [a, b, c]);
    assert.equal(r.responder_id, 3);
    assert.equal(r.response_business_minutes, 40);
  });

  test('revert chain C->B->A ignores all three', () => {
    const a = ev({ id: 1, at: at(SG, '2026-10-05', '09:10'), actor_id: 1 });
    const b = ev({ id: 2, at: at(SG, '2026-10-05', '09:20'), actor_id: 2, reverts_id: 1 });
    const c = ev({ id: 3, at: at(SG, '2026-10-05', '09:30'), actor_id: 3, reverts_id: 2 });
    assert.deepEqual(validEvents([a, b, c]), []);
    assert.equal(row(req(), [a, b, c]).responder_id, null);
  });

  test('revert pointing at an unknown id removes only the reverting event', () => {
    const a = ev({ id: 1, at: at(SG, '2026-10-05', '09:10'), actor_id: 1 });
    const b = ev({ id: 2, at: at(SG, '2026-10-05', '09:05'), actor_id: 2, reverts_id: 999 });
    assert.deepEqual(validEvents([a, b]).map((v) => v.ev.id), [1]);
    assert.equal(row(req(), [a, b]).responder_id, 1);
  });

  test('revert of the would-be first response falls back to the next processing event', () => {
    const first = ev({ id: 10, at: at(SG, '2026-10-05', '09:15'), actor_id: 1 });
    const second = ev({ id: 11, at: at(SG, '2026-10-05', '10:00'), actor_id: 2 });
    const undo = ev({ id: 12, at: at(SG, '2026-10-05', '10:30'), status: 'pending', actor_id: 9, reverts_id: 10 });
    const r = row(req(), [undo, second, first]);
    assert.equal(r.responder_id, 2);
    assert.equal(r.response_business_minutes, 60);
  });

  test('reverting event that itself looks like a response is not a response', () => {
    const target = ev({ id: 20, status: 'pending', at: at(SG, '2026-10-05', '09:01'), actor_id: null });
    const undo = ev({ id: 21, status: 'processing', at: at(SG, '2026-10-05', '09:05'), actor_id: 7, reverts_id: 20 });
    assert.equal(row(req(), [target, undo]).responder_id, null);
  });

  test('reverted complete is ignored: earlier complete becomes the last one', () => {
    const r0 = req({ created_at: isoAt(SG, '2026-10-05', '09:00') });
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:10'), due_at: '06/10/2026 12:00' }),
      ev({ id: 2, status: 'complete', at: at(SG, '2026-10-06', '11:00') }),
      ev({ id: 3, status: 'complete', at: at(SG, '2026-10-06', '13:00') }),
      ev({ id: 4, status: 'complete', at: at(SG, '2026-10-06', '13:05'), reverts_id: 3 }),
    ];
    assert.equal(row(r0, events).completed_late, false);
  });

  test('ids arriving as strings still match reverts', () => {
    const a = ev({ id: '1' as unknown as number, actor_id: 1, at: at(SG, '2026-10-05', '09:10') });
    const b = ev({ id: 2, reverts_id: 1, status: 'pending', at: at(SG, '2026-10-05', '09:20') });
    const c = ev({ id: 3, actor_id: 3, at: at(SG, '2026-10-05', '09:40') });
    assert.equal(row(req(), [a, b, c]).responder_id, 3);
  });
});

// ---------------------------------------------------------------------------
// Rule 3
// ---------------------------------------------------------------------------

describe('rule 3: first response and responder', () => {
  test('earliest processing event with an actor is the first response', () => {
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '11:00'), actor_id: 2 }),
      ev({ id: 2, at: at(SG, '2026-10-05', '10:00'), actor_id: 1 }),
    ];
    assert.equal(row(req(), events).responder_id, 1);
  });

  test('System processing event (actor_id null) is ignored', () => {
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:05'), actor_id: null, actor_name: 'System' }),
      ev({ id: 2, at: at(SG, '2026-10-05', '09:45'), actor_id: 5 }),
    ];
    const r = row(req(), events);
    assert.equal(r.responder_id, 5);
    assert.equal(r.response_business_minutes, 45);
  });

  test('only System processing events -> no first response', () => {
    const r = row(req(), [ev({ actor_id: null, actor_name: 'System' })]);
    assert.equal(r.responder_id, null);
    assert.equal(r.response_business_minutes, null);
    assert.equal(r.within_target, null);
  });

  test('processing event without actor_id field ignored, later one counts', () => {
    const noActor = ev({ id: 1, at: at(SG, '2026-10-05', '09:05') });
    delete (noActor as Partial<HelpdeskEvent>).actor_id;
    const later = ev({ id: 2, at: at(SG, '2026-10-05', '09:50'), actor_id: 8 });
    assert.equal(row(req(), [noActor, later]).responder_id, 8);
  });

  test('non-processing events with actors are not responses', () => {
    const events = [
      ev({ id: 1, status: 'pending', at: at(SG, '2026-10-05', '09:05'), actor_id: 1 }),
      ev({ id: 2, status: 'complete', at: at(SG, '2026-10-05', '09:10'), actor_id: 2 }),
      ev({ id: 3, status: null, at: at(SG, '2026-10-05', '09:15'), actor_id: 3 }),
      ev({ id: 4, status: 'Processing', at: at(SG, '2026-10-05', '09:20'), actor_id: 4 }),
      ev({ id: 5, status: 'processing', at: at(SG, '2026-10-05', '09:25'), actor_id: 5 }),
    ];
    assert.equal(row(req(), events).responder_id, 5);
  });

  test('a later processing event does not replace the first', () => {
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:10'), actor_id: 1 }),
      ev({ id: 2, status: 'pending', at: at(SG, '2026-10-05', '09:20'), actor_id: 1 }),
      ev({ id: 3, at: at(SG, '2026-10-05', '09:30'), actor_id: 2 }),
    ];
    assert.equal(row(req(), events).responder_id, 1);
  });

  test('tie on `at` is broken by id ascending', () => {
    const t = at(SG, '2026-10-05', '09:30');
    const events = [ev({ id: 51, at: t, actor_id: 51 }), ev({ id: 50, at: t, actor_id: 50 })];
    assert.equal(row(req(), events).responder_id, 50);
    assert.equal(row(req(), [...events].reverse()).responder_id, 50);
  });

  test('events given newest-first (as the API returns them)', () => {
    const events = [
      ev({ id: 4, status: 'complete', at: at(SG, '2026-10-05', '12:00'), actor_id: 3 }),
      ev({ id: 3, at: at(SG, '2026-10-05', '11:00'), actor_id: 2 }),
      ev({ id: 2, at: at(SG, '2026-10-05', '10:00'), actor_id: 1 }),
      ev({ id: 1, status: 'pending', at: at(SG, '2026-10-05', '09:00'), actor_id: null }),
    ];
    const r = row(req(), events);
    assert.equal(r.responder_id, 1);
    assert.equal(r.response_business_minutes, 60);
  });

  test('`at` arriving as a numeric string is ordered numerically', () => {
    const events = [
      ev({ id: 1, at: String(at(SG, '2026-10-05', '10:00')) as unknown as number, actor_id: 10 }),
      ev({ id: 2, at: String(at(SG, '2026-10-05', '09:40')) as unknown as number, actor_id: 9 }),
    ];
    const r = row(req(), events);
    assert.equal(r.responder_id, 9);
    assert.equal(r.response_business_minutes, 40);
  });

  test('event with unreadable `at` is skipped (and warned)', () => {
    const w = sink();
    const events = [
      ev({ id: 1, at: 'soon' as unknown as number, actor_id: 1 }),
      ev({ id: 2, at: at(SG, '2026-10-05', '09:40'), actor_id: 2 }),
    ];
    assert.equal(computeRowWith(req(), events, SG, w.warn).responder_id, 2);
    assert.ok(w.msgs.length > 0);
  });

  test('responder is the actor id, not the actor_name', () => {
    const r = row(req(), [ev({ actor_id: 777, actor_name: 'Old Name' })]);
    assert.equal(r.responder_id, 777);
    assert.equal('responder' in r, false);
  });
});

// ---------------------------------------------------------------------------
// Rule 4
// ---------------------------------------------------------------------------

describe('rule 4: response business minutes', () => {
  test('within one business day', () => {
    assert.equal(row(req(), [ev({ at: at(SG, '2026-10-05', '09:42') })]).response_business_minutes, 42);
  });

  test('floored: 59 m 59 s -> 59', () => {
    const r = row(req(), [ev({ at: at(SG, '2026-10-05', '09:59', 59) })]);
    assert.equal(r.response_business_minutes, 59);
  });

  test('seconds in created_at are summed before flooring', () => {
    // created 09:00:30, response 10:00:29 -> 59 m 59 s -> 59
    const r = row(req({ created_at: isoAt(SG, '2026-10-05', '09:00', 30) }), [
      ev({ at: at(SG, '2026-10-05', '10:00', 29) }),
    ]);
    assert.equal(r.response_business_minutes, 59);
  });

  test('response at exactly created_at -> 0', () => {
    const r = row(req(), [ev({ at: at(SG, '2026-10-05', '09:00') })]);
    assert.equal(r.response_business_minutes, 0);
    assert.equal(r.within_target, true);
  });

  test('response earlier than created_at -> 0', () => {
    const r = row(req(), [ev({ at: at(SG, '2026-10-05', '08:00') })]);
    assert.equal(r.response_business_minutes, 0);
    assert.equal(r.within_target, true);
  });

  test('created on a Saturday, first response Monday 09:00 -> 60', () => {
    const r = row(req({ created_at: isoAt(SG, '2026-10-03', '10:00') }), [
      ev({ at: at(SG, '2026-10-05', '09:00') }),
    ]);
    assert.equal(r.response_business_minutes, 60);
  });

  test('after hours created, next-day response', () => {
    // Mon 17:30 -> Tue 08:45 = 30 + 45
    const r = row(req({ created_at: isoAt(SG, '2026-10-05', '17:30') }), [
      ev({ at: at(SG, '2026-10-06', '08:45') }),
    ]);
    assert.equal(r.response_business_minutes, 75);
  });

  test('holidays are closed all day', () => {
    const site = makeSite(11, 'Asia/Singapore', ['2026-10-06']);
    // Mon 17:00 -> Wed 09:00, Tue is a holiday: 60 + 60
    const r = row(req({ created_at: isoAt(site, '2026-10-05', '17:00') }), [
      ev({ at: at(site, '2026-10-07', '09:00') }),
    ], site);
    assert.equal(r.response_business_minutes, 120);
  });

  test('Sydney hours across the DST start weekend', () => {
    // Fri 2026-10-02 17:00 AEST -> Mon 2026-10-05 09:00 AEDT: 60 + 60
    const r = row(req({ site_id: SYD.id, created_at: isoAt(SYD, '2026-10-02', '17:00') }), [
      ev({ at: at(SYD, '2026-10-05', '09:00') }),
    ], SYD);
    assert.equal(r.response_business_minutes, 120);
  });
});

// ---------------------------------------------------------------------------
// Rule 5
// ---------------------------------------------------------------------------

describe('rule 5: within target', () => {
  test('targetMinutes', () => {
    assert.equal(targetMinutes('High'), 60);
    assert.equal(targetMinutes('Medium'), 240);
    assert.equal(targetMinutes('Low'), 480);
    assert.equal(targetMinutes(null), 480);
    assert.equal(targetMinutes(undefined), 480);
    assert.equal(targetMinutes('Urgent'), 480);
    assert.equal(targetMinutes('high'), 480); // case-sensitive per docs
    assert.equal(targetMinutes('toString'), 480); // no prototype leaks
  });

  // Monday from 08:00: minutes m after creation stays within the 10-hour business day.
  const cases: Array<[string | null, number, boolean]> = [
    ['High', 60, true],
    ['High', 61, false],
    ['Medium', 240, true],
    ['Medium', 241, false],
    ['Low', 480, true],
    ['Low', 481, false],
    [null, 480, true],
    [null, 481, false],
    ['Urgent', 480, true],
    ['Urgent', 481, false],
  ];
  for (const [priority, minutes, expected] of cases) {
    test(`${String(priority)} at ${minutes} min -> ${expected}`, () => {
      const r = row(req({ priority, created_at: isoAt(SG, '2026-10-05', '08:00') }), [
        ev({ at: at(SG, '2026-10-05', '08:00', minutes * 60) }),
      ]);
      assert.equal(r.response_business_minutes, minutes);
      assert.equal(r.within_target, expected);
    });
  }

  test('High at 60 m 59 s floors to 60 -> within target', () => {
    const r = row(req({ created_at: isoAt(SG, '2026-10-05', '08:00') }), [
      ev({ at: at(SG, '2026-10-05', '09:00', 59) }),
    ]);
    assert.equal(r.response_business_minutes, 60);
    assert.equal(r.within_target, true);
  });

  test('unknown priority is warned', () => {
    const w = sink();
    computeRowWith(req({ priority: 'Urgent' }), [ev()], SG, w.warn);
    assert.ok(w.msgs.some((m) => m.includes('priority')));
  });
});

// ---------------------------------------------------------------------------
// Rule 6
// ---------------------------------------------------------------------------

describe('rule 6: completed late', () => {
  const resp = () => ev({ at: at(SG, '2026-10-05', '09:30') });

  test('complete exactly at the deadline -> false (strict)', () => {
    const events = [
      ev({ id: 1, status: 'pending', actor_id: null, at: at(SG, '2026-10-05', '09:00'), due_at: '07/10/2026 10:00' }),
      ev({ id: 2, status: 'complete', at: at(SG, '2026-10-07', '10:00') }),
    ];
    assert.equal(row(req(), events).completed_late, false);
  });

  test('complete one second after the deadline -> true', () => {
    const events = [
      ev({ id: 1, status: 'pending', actor_id: null, at: at(SG, '2026-10-05', '09:00'), due_at: '07/10/2026 10:00' }),
      ev({ id: 2, status: 'complete', at: at(SG, '2026-10-07', '10:00', 1) }),
    ];
    assert.equal(row(req(), events).completed_late, true);
  });

  test('reopened after complete still uses the last complete', () => {
    const events = [
      resp(),
      ev({ id: 1, at: at(SG, '2026-10-05', '09:40'), due_at: '07/10/2026 10:00' }),
      ev({ id: 2, status: 'complete', at: at(SG, '2026-10-06', '10:00') }),
      ev({ id: 3, status: 'processing', at: at(SG, '2026-10-06', '11:00') }), // reopened
    ];
    assert.equal(row(req(), events).completed_late, false);
  });

  test('completed twice: the last complete decides', () => {
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:40'), due_at: '07/10/2026 10:00' }),
      ev({ id: 2, status: 'complete', at: at(SG, '2026-10-06', '10:00') }),
      ev({ id: 3, status: 'processing', at: at(SG, '2026-10-06', '11:00') }),
      ev({ id: 4, status: 'complete', at: at(SG, '2026-10-08', '10:00') }),
      ev({ id: 5, status: 'processing', at: at(SG, '2026-10-09', '10:00') }),
    ];
    assert.equal(row(req(), events).completed_late, true);
  });

  test('deadline changed by a later event: latest due_at wins (both directions)', () => {
    const base = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:40'), due_at: '06/10/2026 10:00' }),
      ev({ id: 3, status: 'complete', at: at(SG, '2026-10-07', '09:00') }),
    ];
    // Extended to 08/10 -> on time.
    const extended = [...base, ev({ id: 2, status: 'processing', at: at(SG, '2026-10-05', '12:00'), due_at: '08/10/2026 10:00' })];
    assert.equal(row(req(), extended).completed_late, false);
    // Pulled in, set after completion, to 07/10 08:00 -> late.
    const pulled = [...base, ev({ id: 4, status: 'complete', at: at(SG, '2026-10-07', '09:00'), due_at: '07/10/2026 08:00' })];
    assert.equal(row(req(), pulled).completed_late, true);
  });

  test('latest due_at chosen by (at, id), not by array order', () => {
    const t = at(SG, '2026-10-05', '09:40');
    const events = [
      ev({ id: 6, at: t, due_at: '09/10/2026 10:00' }),
      ev({ id: 5, at: t, due_at: '06/10/2026 10:00' }),
      ev({ id: 7, status: 'complete', at: at(SG, '2026-10-08', '10:00') }),
    ];
    assert.equal(row(req(), events).completed_late, false); // id 6 wins -> 09/10
  });

  test('a reverted due_at change is ignored', () => {
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:40'), due_at: '06/10/2026 10:00' }),
      ev({ id: 2, at: at(SG, '2026-10-05', '10:00'), due_at: '09/10/2026 10:00' }),
      ev({ id: 3, at: at(SG, '2026-10-05', '10:05'), reverts_id: 2 }),
      ev({ id: 4, status: 'complete', at: at(SG, '2026-10-07', '10:00') }),
    ];
    assert.equal(row(req(), events).completed_late, true);
  });

  test('events without due_at (null, empty) do not clear the deadline', () => {
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:40'), due_at: '06/10/2026 10:00' }),
      ev({ id: 2, at: at(SG, '2026-10-05', '10:00'), due_at: null }),
      ev({ id: 3, at: at(SG, '2026-10-05', '10:10'), due_at: '' }),
      ev({ id: 4, status: 'complete', at: at(SG, '2026-10-07', '10:00') }),
    ];
    assert.equal(row(req(), events).completed_late, true);
  });

  test('due_on on the request is ignored', () => {
    const r0 = req({ due_on: '2026-10-30' });
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:40'), due_at: '06/10/2026 10:00' }),
      ev({ id: 2, status: 'complete', at: at(SG, '2026-10-07', '10:00') }),
    ];
    assert.equal(row(r0, events).completed_late, true);
    // And due_on alone gives no deadline.
    const noDue = [ev({ id: 3, status: 'complete', at: at(SG, '2026-10-07', '10:00') })];
    assert.equal(row(req({ due_on: '2026-10-01' }), noDue).completed_late, null);
  });

  test('due_at in Sydney during DST is read as AEDT (+11) wall clock', () => {
    // 07/10/2026 10:00 AEDT = 2026-10-06T23:00:00Z (AEST would be 00:00Z)
    const r0 = req({ site_id: SYD.id, created_at: '2026-10-05T22:00:00Z' });
    const due = ev({ id: 1, at: Date.parse('2026-10-05T22:30:00Z') / 1000, due_at: '07/10/2026 10:00' });
    const done = (iso: string) => ev({ id: 2, status: 'complete', at: Date.parse(iso) / 1000 });
    assert.equal(row(r0, [due, done('2026-10-06T23:00:00Z')], SYD).completed_late, false);
    assert.equal(row(r0, [due, done('2026-10-06T23:00:01Z')], SYD).completed_late, true);
    assert.equal(row(r0, [due, done('2026-10-06T23:30:00Z')], SYD).completed_late, true);
  });

  test('due_at in Singapore is +08:00', () => {
    assert.equal(deadlineMs(validEvents([ev({ due_at: '07/10/2026 10:00' })]), 'Asia/Singapore'), parseIsoUtc('2026-10-07T02:00:00Z'));
  });

  test('unparseable latest due_at -> no deadline (no fallback to an earlier one), warned', () => {
    const w = sink();
    const events = [
      ev({ id: 1, at: at(SG, '2026-10-05', '09:40'), due_at: '06/10/2026 10:00' }),
      ev({ id: 2, at: at(SG, '2026-10-05', '10:00'), due_at: '2026-10-09 10:00' }),
      ev({ id: 3, status: 'complete', at: at(SG, '2026-10-07', '10:00') }),
    ];
    assert.equal(computeRowWith(req(), events, SG, w.warn).completed_late, null);
    assert.ok(w.msgs.some((m) => m.includes('due_at')));
  });

  test('complete status event with due_at on itself counts as deadline source', () => {
    const events = [ev({ id: 1, status: 'complete', at: at(SG, '2026-10-07', '10:00'), due_at: '07/10/2026 09:59' })];
    assert.equal(row(req(), events).completed_late, true);
  });
});

// ---------------------------------------------------------------------------
// Rule 7
// ---------------------------------------------------------------------------

describe('rule 7: nulls', () => {
  test('no events at all', () => {
    const r = row(req(), []);
    assert.deepEqual(
      [r.responder_id, r.response_business_minutes, r.within_target, r.completed_late],
      [null, null, null, null],
    );
    assert.equal(r.included, true);
  });

  test('no first response but completed late still computed', () => {
    const events = [
      ev({ id: 1, status: 'pending', actor_id: null, at: at(SG, '2026-10-05', '09:05'), due_at: '06/10/2026 10:00' }),
      ev({ id: 2, status: 'complete', actor_id: null, at: at(SG, '2026-10-07', '10:00') }),
    ];
    const r = row(req(), events);
    assert.equal(r.responder_id, null);
    assert.equal(r.response_business_minutes, null);
    assert.equal(r.within_target, null);
    assert.equal(r.completed_late, true);
  });

  test('never completed -> completed_late null', () => {
    const events = [ev({ id: 1, due_at: '06/10/2026 10:00' })];
    const r = row(req(), events);
    assert.equal(r.responder_id, 304);
    assert.equal(r.completed_late, null);
  });

  test('completed but no deadline -> completed_late null', () => {
    const events = [ev({ id: 1 }), ev({ id: 2, status: 'complete', at: at(SG, '2026-10-30', '10:00') })];
    assert.equal(row(req(), events).completed_late, null);
  });

  test('only complete was reverted -> completed_late null', () => {
    const events = [
      ev({ id: 1, due_at: '06/10/2026 10:00' }),
      ev({ id: 2, status: 'complete', at: at(SG, '2026-10-07', '10:00') }),
      ev({ id: 3, status: 'processing', at: at(SG, '2026-10-07', '10:05'), reverts_id: 2 }),
    ];
    assert.equal(row(req(), events).completed_late, null);
  });
});
