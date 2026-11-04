import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DayHours, Site, Weekday } from '../src/types.ts';
import {
  addDays,
  businessSeconds,
  isValidYmd,
  localDate,
  parseDmy,
  parseDueAt,
  parseIsoUtc,
  wallToUtc,
  weekdayOf,
} from '../src/time.ts';

const SG = 'Asia/Singapore'; // UTC+8, no DST
const SYD = 'Australia/Sydney'; // UTC+10 / +11 (DST)
const JKT = 'Asia/Jakarta'; // UTC+7, no DST

const HOUR = 3600;
const MIN = 60;

/** ISO string -> epoch ms, failing loudly on a typo in a test fixture. */
function utc(s: string): number {
  const ms = parseIsoUtc(s);
  assert.notEqual(ms, null, `bad fixture ${s}`);
  return ms!;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

type SiteTime = Pick<Site, 'timezone' | 'business_hours' | 'holidays'>;

function site(
  timezone: string,
  hours: Partial<Record<Weekday, DayHours>>,
  holidays: string[] = [],
): SiteTime {
  return { timezone, business_hours: hours, holidays: new Set(holidays) };
}

const EIGHT_TO_SIX = { open: '08:00', close: '18:00' }; // 10 h
const WEEKDAYS_8_18: Partial<Record<Weekday, DayHours>> = {
  mon: EIGHT_TO_SIX,
  tue: EIGHT_TO_SIX,
  wed: EIGHT_TO_SIX,
  thu: EIGHT_TO_SIX,
  fri: EIGHT_TO_SIX,
  sat: null,
  sun: null,
};
const EVERY_DAY = (h: DayHours): Partial<Record<Weekday, DayHours>> => ({
  mon: h, tue: h, wed: h, thu: h, fri: h, sat: h, sun: h,
});

// ---------------------------------------------------------------------------

describe('parseIsoUtc', () => {
  test('Z designator', () => {
    assert.equal(parseIsoUtc('2026-10-06T02:15:07Z'), Date.UTC(2026, 9, 6, 2, 15, 7));
  });

  test('numeric offsets', () => {
    assert.equal(parseIsoUtc('2026-10-06T10:15:07+08:00'), Date.UTC(2026, 9, 6, 2, 15, 7));
    assert.equal(parseIsoUtc('2026-10-05T21:15:07-05:00'), Date.UTC(2026, 9, 6, 2, 15, 7));
    assert.equal(parseIsoUtc('2026-10-06T02:15:07+00:00'), Date.UTC(2026, 9, 6, 2, 15, 7));
  });

  test('fractional seconds (truncated to ms) and optional seconds', () => {
    assert.equal(parseIsoUtc('2026-10-06T02:15:07.5Z'), Date.UTC(2026, 9, 6, 2, 15, 7, 500));
    assert.equal(parseIsoUtc('2026-10-06T02:15:07.123456Z'), Date.UTC(2026, 9, 6, 2, 15, 7, 123));
    assert.equal(parseIsoUtc('2026-10-06T02:15Z'), Date.UTC(2026, 9, 6, 2, 15));
  });

  test('offset crossing a date / year boundary', () => {
    assert.equal(parseIsoUtc('2027-01-01T05:00:00+08:00'), Date.UTC(2026, 11, 31, 21));
  });

  test('rejects malformed or out-of-range input', () => {
    for (const bad of [
      '',
      '2026-10-06',
      '2026-10-06T02:15:07', // no designator: ambiguous, refuse
      '2026-10-06 02:15:07Z',
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-10-06T24:00:00Z',
      '2026-10-06T23:60:00Z',
      '2026-10-06T23:59:60Z',
      '2026-10-06T02:15:07+0800',
      '2026-10-06T02:15:07+24:00',
      ' 2026-10-06T02:15:07Z',
      '2026-10-06T02:15:07Zjunk',
      'Tue, 06 Oct 2026 02:15:07 GMT',
    ]) {
      assert.equal(parseIsoUtc(bad), null, bad);
    }
    assert.equal(parseIsoUtc(null as unknown as string), null);
    assert.equal(parseIsoUtc(1791874530 as unknown as string), null);
  });
});

describe('isValidYmd', () => {
  test('accepts real dates incl. leap days', () => {
    for (const ok of ['2026-01-01', '2026-12-31', '2028-02-29', '2000-02-29', '2026-04-30']) {
      assert.equal(isValidYmd(ok), true, ok);
    }
  });

  test('rejects impossible dates and bad shapes', () => {
    for (const bad of [
      '2026-02-29', // 2026 is not a leap year
      '1900-02-29', // century, not divisible by 400
      '2026-02-30',
      '2026-04-31',
      '2026-00-10',
      '2026-13-01',
      '2026-01-00',
      '2026-01-32',
      '2026-1-01',
      '2026-01-1',
      '26-01-01',
      '2026/01/01',
      '2026-01-01T00:00:00Z',
      ' 2026-01-01',
      '2026-01-01\n',
      '',
    ]) {
      assert.equal(isValidYmd(bad), false, JSON.stringify(bad));
    }
    assert.equal(isValidYmd(undefined as unknown as string), false);
  });
});

describe('parseDmy', () => {
  test('converts DD/MM/YYYY to YYYY-MM-DD', () => {
    assert.equal(parseDmy('10/08/2026'), '2026-08-10');
    assert.equal(parseDmy('01/01/2026'), '2026-01-01');
    assert.equal(parseDmy('31/12/2026'), '2026-12-31');
    assert.equal(parseDmy('29/02/2028'), '2028-02-29');
  });

  test('rejects invalid dates and loose formats', () => {
    for (const bad of [
      '29/02/2026',
      '31/04/2026',
      '32/01/2026',
      '00/01/2026',
      '10/13/2026',
      '1/08/2026',
      '10/8/2026',
      '10/08/26',
      '2026-08-10',
      '10-08-2026',
      '10/08/2026 00:00',
      '',
    ]) {
      assert.equal(parseDmy(bad), null, bad);
    }
  });
});

describe('weekdayOf / addDays (calendar, timezone independent)', () => {
  test('weekdayOf', () => {
    assert.equal(weekdayOf('2026-10-02'), 'fri');
    assert.equal(weekdayOf('2026-10-03'), 'sat');
    assert.equal(weekdayOf('2026-10-04'), 'sun');
    assert.equal(weekdayOf('2026-10-05'), 'mon');
    assert.equal(weekdayOf('2026-10-06'), 'tue');
    assert.equal(weekdayOf('2026-10-07'), 'wed');
    assert.equal(weekdayOf('2026-10-08'), 'thu');
    assert.equal(weekdayOf('2028-02-29'), 'tue');
    assert.equal(weekdayOf('2000-01-01'), 'sat');
  });

  test('weekdayOf rejects invalid dates', () => {
    assert.throws(() => weekdayOf('2026-02-30'), RangeError);
    assert.throws(() => weekdayOf('garbage'), RangeError);
  });

  test('addDays across month, year and leap boundaries', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-02-28', 1), '2026-03-01');
    assert.equal(addDays('2026-10-04', 0), '2026-10-04');
    assert.equal(addDays('2026-01-01', 365), '2027-01-01');
    assert.equal(addDays('2028-01-01', 366), '2029-01-01');
    // DST days are ordinary calendar days here.
    assert.equal(addDays('2026-10-03', 1), '2026-10-04');
    assert.equal(addDays('2026-04-05', 1), '2026-04-06');
  });

  test('addDays rejects bad input', () => {
    assert.throws(() => addDays('2026-02-30', 1), RangeError);
    assert.throws(() => addDays('2026-02-01', 1.5), RangeError);
  });
});

describe('localDate', () => {
  test('Singapore (UTC+8) midnight boundary', () => {
    assert.equal(localDate(utc('2026-09-30T15:59:59Z'), SG), '2026-09-30');
    assert.equal(localDate(utc('2026-09-30T16:00:00Z'), SG), '2026-10-01');
    assert.equal(localDate(utc('2026-09-30T15:30:00Z'), SG), '2026-09-30');
  });

  test('Jakarta (UTC+7) midnight boundary', () => {
    assert.equal(localDate(utc('2026-09-30T16:59:59Z'), JKT), '2026-09-30');
    assert.equal(localDate(utc('2026-09-30T17:00:00Z'), JKT), '2026-10-01');
    assert.equal(localDate(utc('2026-09-30T15:30:00Z'), JKT), '2026-09-30');
  });

  test('Sydney midnight boundary, standard time (UTC+10)', () => {
    assert.equal(localDate(utc('2026-09-30T13:59:59Z'), SYD), '2026-09-30');
    assert.equal(localDate(utc('2026-09-30T14:00:00Z'), SYD), '2026-10-01');
    assert.equal(localDate(utc('2026-09-30T15:30:00Z'), SYD), '2026-10-01');
  });

  test('Sydney midnight boundary, daylight time (UTC+11)', () => {
    assert.equal(localDate(utc('2026-10-31T12:59:59Z'), SYD), '2026-10-31');
    assert.equal(localDate(utc('2026-10-31T13:00:00Z'), SYD), '2026-11-01');
  });

  test('same instant gives different dates per site', () => {
    const t = utc('2026-10-31T16:30:00Z');
    assert.equal(localDate(t, SYD), '2026-11-01');
    assert.equal(localDate(t, SG), '2026-11-01');
    assert.equal(localDate(t, JKT), '2026-10-31');
  });

  test('year boundary', () => {
    assert.equal(localDate(utc('2026-12-31T16:00:00Z'), SG), '2027-01-01');
    assert.equal(localDate(utc('2026-12-31T15:59:59Z'), SG), '2026-12-31');
  });

  test('unknown timezone throws', () => {
    assert.throws(() => localDate(0, 'Mars/Olympus_Mons'), RangeError);
  });

  test('performance: 100k calls well under 1.5 s', () => {
    const base = utc('2026-05-01T00:00:00Z');
    const zones = [SG, SYD, JKT];
    const t0 = performance.now();
    let sink = 0;
    for (let i = 0; i < 100_000; i++) {
      sink += localDate(base + i * 157_000, zones[i % 3]!).length;
    }
    const elapsed = performance.now() - t0;
    assert.equal(sink, 1_000_000);
    assert.ok(elapsed < 1500, `100k localDate calls took ${elapsed.toFixed(0)} ms`);
  });
});

describe('wallToUtc', () => {
  test('fixed-offset zones', () => {
    assert.equal(iso(wallToUtc('2026-10-07', '10:00', SG)), '2026-10-07T02:00:00.000Z');
    assert.equal(iso(wallToUtc('2026-10-07', '10:00', JKT)), '2026-10-07T03:00:00.000Z');
    assert.equal(iso(wallToUtc('2026-10-07', '00:00', SG)), '2026-10-06T16:00:00.000Z');
  });

  test("'24:00' is 00:00 of the next day", () => {
    assert.equal(wallToUtc('2026-10-07', '24:00', SG), wallToUtc('2026-10-08', '00:00', SG));
    assert.equal(wallToUtc('2026-12-31', '24:00', SG), wallToUtc('2027-01-01', '00:00', SG));
    // Next day after Sydney DST start: midnight is already +11.
    assert.equal(iso(wallToUtc('2026-10-04', '24:00', SYD)), '2026-10-04T13:00:00.000Z');
  });

  test('rejects malformed wall times', () => {
    for (const bad of ['24:01', '25:00', '12:60', '8:00', '0800', '08:00:00', '']) {
      assert.throws(() => wallToUtc('2026-10-07', bad, SG), RangeError, bad);
    }
    assert.throws(() => wallToUtc('2026-02-30', '08:00', SG), RangeError);
  });

  test('Sydney normal times either side of DST start (2026-10-04)', () => {
    assert.equal(iso(wallToUtc('2026-10-03', '10:00', SYD)), '2026-10-03T00:00:00.000Z'); // +10
    assert.equal(iso(wallToUtc('2026-10-04', '01:59', SYD)), '2026-10-03T15:59:00.000Z'); // +10
    assert.equal(iso(wallToUtc('2026-10-04', '03:00', SYD)), '2026-10-03T16:00:00.000Z'); // +11
    assert.equal(iso(wallToUtc('2026-10-04', '08:00', SYD)), '2026-10-03T21:00:00.000Z'); // +11
    assert.equal(iso(wallToUtc('2026-10-05', '10:00', SYD)), '2026-10-04T23:00:00.000Z'); // +11
  });

  test('Sydney DST gap: nonexistent time shifts forward by the gap', () => {
    // 02:30 does not exist; result equals 03:30 +11.
    assert.equal(iso(wallToUtc('2026-10-04', '02:30', SYD)), '2026-10-03T16:30:00.000Z');
    assert.equal(wallToUtc('2026-10-04', '02:30', SYD), wallToUtc('2026-10-04', '03:30', SYD));
    // 02:00 (first nonexistent minute) == 03:00.
    assert.equal(wallToUtc('2026-10-04', '02:00', SYD), wallToUtc('2026-10-04', '03:00', SYD));
    assert.equal(iso(wallToUtc('2026-10-04', '02:59', SYD)), '2026-10-03T16:59:00.000Z');
  });

  test('Sydney normal times either side of DST end (2026-04-05)', () => {
    assert.equal(iso(wallToUtc('2026-04-04', '10:00', SYD)), '2026-04-03T23:00:00.000Z'); // +11
    assert.equal(iso(wallToUtc('2026-04-05', '01:59', SYD)), '2026-04-04T14:59:00.000Z'); // +11
    assert.equal(iso(wallToUtc('2026-04-05', '03:00', SYD)), '2026-04-04T17:00:00.000Z'); // +10
    assert.equal(iso(wallToUtc('2026-04-06', '10:00', SYD)), '2026-04-06T00:00:00.000Z'); // +10
  });

  test('Sydney DST overlap: ambiguous time resolves to the earlier instant', () => {
    // 02:30 happens at +11 (15:30Z) and again at +10 (16:30Z).
    assert.equal(iso(wallToUtc('2026-04-05', '02:30', SYD)), '2026-04-04T15:30:00.000Z');
    assert.equal(iso(wallToUtc('2026-04-05', '02:00', SYD)), '2026-04-04T15:00:00.000Z');
    assert.equal(iso(wallToUtc('2026-04-05', '02:59', SYD)), '2026-04-04T15:59:00.000Z');
  });

  test('round-trip: local date of the result is the input date', () => {
    for (const tz of [SG, SYD, JKT]) {
      for (let d = '2026-03-28'; d <= '2026-04-12'; d = addDays(d, 1)) {
        for (const hhmm of ['00:00', '01:30', '08:00', '12:00', '18:00', '23:59']) {
          assert.equal(localDate(wallToUtc(d, hhmm, tz), tz), d, `${tz} ${d} ${hhmm}`);
        }
      }
      for (let d = '2026-09-28'; d <= '2026-10-10'; d = addDays(d, 1)) {
        assert.equal(localDate(wallToUtc(d, '12:00', tz), tz), d, `${tz} ${d}`);
      }
    }
  });

  test('other DST rules (New York, 30-min Lord Howe gap)', () => {
    assert.equal(iso(wallToUtc('2026-03-08', '02:30', 'America/New_York')), '2026-03-08T07:30:00.000Z');
    assert.equal(iso(wallToUtc('2026-11-01', '01:30', 'America/New_York')), '2026-11-01T05:30:00.000Z');
    // Lord Howe jumps 02:00 -> 02:30 (+10:30 -> +11); 02:15 -> 02:45 +11.
    assert.equal(iso(wallToUtc('2026-10-04', '02:15', 'Australia/Lord_Howe')), '2026-10-03T15:45:00.000Z');
  });

  test('cached results are stable', () => {
    const a = wallToUtc('2026-10-04', '02:30', SYD);
    const b = wallToUtc('2026-10-04', '02:30', SYD);
    assert.equal(a, b);
  });
});

describe('parseDueAt', () => {
  test('site-local DD/MM/YYYY HH:mm', () => {
    assert.equal(iso(parseDueAt('07/10/2026 10:00', SG)!), '2026-10-07T02:00:00.000Z');
    assert.equal(iso(parseDueAt('07/10/2026 10:00', JKT)!), '2026-10-07T03:00:00.000Z');
    assert.equal(iso(parseDueAt('07/10/2026 10:00', SYD)!), '2026-10-06T23:00:00.000Z');
    assert.equal(iso(parseDueAt('01/07/2026 10:00', SYD)!), '2026-07-01T00:00:00.000Z');
    assert.equal(iso(parseDueAt('29/02/2028 23:59', SG)!), '2028-02-29T15:59:00.000Z');
    assert.equal(iso(parseDueAt('07/10/2026 00:00', SG)!), '2026-10-06T16:00:00.000Z');
  });

  test('DST gap / overlap follow wallToUtc', () => {
    assert.equal(iso(parseDueAt('04/10/2026 02:30', SYD)!), '2026-10-03T16:30:00.000Z');
    assert.equal(iso(parseDueAt('05/04/2026 02:30', SYD)!), '2026-04-04T15:30:00.000Z');
  });

  test('strict: rejects anything else', () => {
    for (const bad of [
      '2026-10-07 10:00',
      '7/10/2026 10:00',
      '07/1/2026 10:00',
      '32/10/2026 10:00',
      '31/09/2026 10:00',
      '29/02/2026 10:00',
      '07/13/2026 10:00',
      '07/10/2026 25:00',
      '07/10/2026 24:00',
      '07/10/2026 10:60',
      '07/10/2026 9:00',
      '07/10/2026 10:00:00',
      '07/10/2026T10:00',
      '07/10/2026  10:00',
      ' 07/10/2026 10:00',
      '07/10/2026 10:00 ',
      '07/10/2026',
      '2026-10-07T02:00:00Z',
      '',
    ]) {
      assert.equal(parseDueAt(bad, SG), null, JSON.stringify(bad));
    }
    assert.equal(parseDueAt(null as unknown as string, SG), null);
  });
});

describe('businessSeconds', () => {
  const sg = site(SG, WEEKDAYS_8_18);

  test('same-day span inside hours', () => {
    // Tue 2026-10-06 09:00 -> 10:30 SG
    const s = wallToUtc('2026-10-06', '09:00', SG);
    const e = wallToUtc('2026-10-06', '10:30', SG);
    assert.equal(businessSeconds(s, e, sg), 90 * MIN);
  });

  test('start before open counts from open', () => {
    const s = wallToUtc('2026-10-06', '06:15', SG);
    const e = wallToUtc('2026-10-06', '08:20', SG);
    assert.equal(businessSeconds(s, e, sg), 20 * MIN);
  });

  test('end after close counts until close', () => {
    const s = wallToUtc('2026-10-06', '17:00', SG);
    const e = wallToUtc('2026-10-06', '21:00', SG);
    assert.equal(businessSeconds(s, e, sg), 1 * HOUR);
  });

  test('entirely outside hours is 0', () => {
    const s = wallToUtc('2026-10-06', '18:00', SG);
    const e = wallToUtc('2026-10-07', '08:00', SG);
    assert.equal(businessSeconds(s, e, sg), 0);
  });

  test('across a weekend: Fri 17:30 -> Mon 08:45 = 75 min', () => {
    const s = wallToUtc('2026-10-02', '17:30', SG); // Friday
    const e = wallToUtc('2026-10-05', '08:45', SG); // Monday
    assert.equal(businessSeconds(s, e, sg), 75 * MIN);
  });

  test('second precision, floored', () => {
    const s = wallToUtc('2026-10-06', '09:00', SG);
    assert.equal(businessSeconds(s, s + 59_000, sg), 59);
    assert.equal(businessSeconds(s, s + 90_500, sg), 90);
  });

  test('holiday is skipped', () => {
    // Mon 2026-10-05 is a holiday: Fri 17:30 -> Tue 08:45 = 30 + 45 min.
    const withHoliday = site(SG, WEEKDAYS_8_18, ['2026-10-05']);
    const s = wallToUtc('2026-10-02', '17:30', SG);
    const e = wallToUtc('2026-10-06', '08:45', SG);
    assert.equal(businessSeconds(s, e, withHoliday), 75 * MIN);
    assert.equal(businessSeconds(s, e, sg), 75 * MIN + 10 * HOUR);
  });

  test('span entirely within a holiday is 0', () => {
    const withHoliday = site(SG, WEEKDAYS_8_18, ['2026-10-06']);
    const s = wallToUtc('2026-10-06', '09:00', SG);
    const e = wallToUtc('2026-10-06', '17:00', SG);
    assert.equal(businessSeconds(s, e, withHoliday), 0);
  });

  test('Saturday-only hours', () => {
    const satOnly = site(JKT, { sat: { open: '09:00', close: '13:00' } });
    const s = wallToUtc('2026-10-05', '00:00', JKT); // Mon
    const e = wallToUtc('2026-10-12', '00:00', JKT); // next Mon
    assert.equal(businessSeconds(s, e, satOnly), 4 * HOUR);
    // Within the Saturday window.
    assert.equal(
      businessSeconds(wallToUtc('2026-10-10', '12:00', JKT), wallToUtc('2026-10-10', '15:00', JKT), satOnly),
      1 * HOUR,
    );
  });

  test('null and missing weekdays are closed', () => {
    const tueNull = site(SG, { ...WEEKDAYS_8_18, tue: null });
    const s = wallToUtc('2026-10-06', '00:00', SG); // Tue
    const e = wallToUtc('2026-10-07', '00:00', SG);
    assert.equal(businessSeconds(s, e, tueNull), 0);
    const noTue = site(SG, { mon: EIGHT_TO_SIX, wed: EIGHT_TO_SIX });
    assert.equal(businessSeconds(s, e, noTue), 0);
    assert.equal(businessSeconds(s, e, site(SG, {})), 0);
  });

  test("'24:00' close runs to midnight", () => {
    const late = site(SG, EVERY_DAY({ open: '20:00', close: '24:00' }));
    const s = wallToUtc('2026-10-06', '21:00', SG);
    const e = wallToUtc('2026-10-07', '01:00', SG);
    assert.equal(businessSeconds(s, e, late), 3 * HOUR);
    const allDay = site(SG, EVERY_DAY({ open: '00:00', close: '24:00' }));
    assert.equal(businessSeconds(s, e, allDay), 4 * HOUR);
  });

  describe('overnight window (22:00 -> 06:00)', () => {
    const night = site(SG, EVERY_DAY({ open: '22:00', close: '06:00' }));

    test('span covering one night', () => {
      const s = wallToUtc('2026-10-05', '20:00', SG);
      const e = wallToUtc('2026-10-06', '07:00', SG);
      assert.equal(businessSeconds(s, e, night), 8 * HOUR);
    });

    test("start inside the previous day's tail is counted", () => {
      // Tue 03:00 -> Tue 23:00: 03:00-06:00 (Mon's window) + 22:00-23:00 (Tue's).
      const s = wallToUtc('2026-10-06', '03:00', SG);
      const e = wallToUtc('2026-10-06', '23:00', SG);
      assert.equal(businessSeconds(s, e, night), 4 * HOUR);
    });

    test('holiday removes the window that starts that day', () => {
      const nightHol = site(SG, EVERY_DAY({ open: '22:00', close: '06:00' }), ['2026-10-05']);
      const s = wallToUtc('2026-10-05', '20:00', SG);
      const e = wallToUtc('2026-10-06', '07:00', SG);
      assert.equal(businessSeconds(s, e, nightHol), 0);
    });

    test('overnight window overlapping the next opening is not double counted', () => {
      const overlap = site(SG, {
        mon: { open: '22:00', close: '10:00' },
        tue: { open: '08:00', close: '18:00' },
      });
      const s = wallToUtc('2026-10-05', '21:00', SG); // Mon
      const e = wallToUtc('2026-10-06', '19:00', SG); // Tue
      assert.equal(businessSeconds(s, e, overlap), 20 * HOUR); // 22:00 Mon -> 18:00 Tue
    });
  });

  describe('Sydney DST', () => {
    test('DST start day (Sun 2026-10-04): 08:00-18:00 is still 10 h', () => {
      const syd = site(SYD, EVERY_DAY(EIGHT_TO_SIX));
      const s = wallToUtc('2026-10-03', '12:00', SYD); // Sat, +10
      const e = wallToUtc('2026-10-05', '12:00', SYD); // Mon, +11
      // Sat 6 h + Sun 10 h + Mon 4 h
      assert.equal(businessSeconds(s, e, syd), 20 * HOUR);
      const sunOnly = site(SYD, { sun: EIGHT_TO_SIX });
      assert.equal(businessSeconds(s, e, sunOnly), 10 * HOUR);
    });

    test('DST start day is 23 h long, DST end day is 25 h long', () => {
      const allDay = site(SYD, EVERY_DAY({ open: '00:00', close: '24:00' }));
      const startDay = [wallToUtc('2026-10-04', '00:00', SYD), wallToUtc('2026-10-05', '00:00', SYD)] as const;
      const endDay = [wallToUtc('2026-04-05', '00:00', SYD), wallToUtc('2026-04-06', '00:00', SYD)] as const;
      assert.equal(businessSeconds(startDay[0], startDay[1], allDay), 23 * HOUR);
      assert.equal(businessSeconds(endDay[0], endDay[1], allDay), 25 * HOUR);
    });

    test('DST end day (Sun 2026-04-05): 08:00-18:00 is still 10 h', () => {
      const sunOnly = site(SYD, { sun: EIGHT_TO_SIX });
      const s = utc('2026-04-01T00:00:00Z');
      const e = utc('2026-04-10T00:00:00Z');
      assert.equal(businessSeconds(s, e, sunOnly), 10 * HOUR);
    });

    test('window spanning the gap loses the skipped hour', () => {
      const early = site(SYD, { sun: { open: '01:00', close: '04:00' } });
      const s = utc('2026-10-03T00:00:00Z');
      const e = utc('2026-10-05T00:00:00Z');
      assert.equal(businessSeconds(s, e, early), 2 * HOUR);
    });
  });

  test('end <= start returns 0', () => {
    const t = wallToUtc('2026-10-06', '09:00', SG);
    assert.equal(businessSeconds(t, t, sg), 0);
    assert.equal(businessSeconds(t + HOUR * 1000, t, sg), 0);
  });

  test('multi-week span sums correctly', () => {
    // Mon 2026-10-05 00:00 -> Mon 2026-10-26 00:00: 3 weeks x 5 days x 10 h.
    const s = wallToUtc('2026-10-05', '00:00', SG);
    const e = wallToUtc('2026-10-26', '00:00', SG);
    assert.equal(businessSeconds(s, e, sg), 150 * HOUR);
    const withHolidays = site(SG, WEEKDAYS_8_18, ['2026-10-07', '2026-10-20', '2026-10-24']);
    // 2026-10-24 is a Saturday: already closed, no change.
    assert.equal(businessSeconds(s, e, withHolidays), 130 * HOUR);
    // Partial first and last day.
    const s2 = wallToUtc('2026-10-05', '17:00', SG);
    const e2 = wallToUtc('2026-10-23', '09:30', SG);
    // Mon 1 h + Tue..Fri wk1 (4 days) + wk2 (5 days) + Mon..Thu wk3 (4 days) = 13 days x 10 h + Fri 1.5 h
    assert.equal(businessSeconds(s2, e2, sg), 1 * HOUR + 130 * HOUR + 90 * MIN);
  });

  test('Sydney multi-week span across DST start sums whole days', () => {
    const syd = site(SYD, WEEKDAYS_8_18);
    const s = wallToUtc('2026-09-28', '00:00', SYD); // Mon, +10
    const e = wallToUtc('2026-10-12', '00:00', SYD); // Mon, +11
    assert.equal(businessSeconds(s, e, syd), 100 * HOUR);
  });

  test('additivity: splitting a span does not change the total', () => {
    const syd = site(SYD, EVERY_DAY({ open: '07:30', close: '19:15' }), ['2026-10-06']);
    const s = utc('2026-09-30T05:17:00Z');
    const e = utc('2026-10-09T11:43:00Z');
    const total = businessSeconds(s, e, syd);
    for (let m = s; m < e; m += 7 * 3_600_000 + 13_000) {
      assert.equal(businessSeconds(s, m, syd) + businessSeconds(m, e, syd), total, iso(m));
    }
  });
});
