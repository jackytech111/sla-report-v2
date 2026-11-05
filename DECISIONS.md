# DECISIONS

## What I assumed

- **Ingest from the change feed, not per-request events.** Six months is ~12k requests and events come 50 a page per request, which means more than 12k calls, 429s, and a `/ready` far beyond 8 minutes. `/v1/changes` replays everything from the start (500 items a call), so one walk builds a local copy and the same cursor keeps it live. A synthetic 12k-request / 54k-item feed bootstraps in 114 calls.
- **Revert chains (rule 2).** "Ignore both" read literally: every event with `reverts_id` and every event pointed at are ignored, so C→B→A drops all three (an "undo of undo restores A" reading was rejected as not what the rule says). A `reverts_id` to an unknown event only drops the reverting event.
- **Event order.** "Earliest/latest by `at`" ties are broken by event `id`, ascending.
- **Deadline (rule 6).** The latest valid event with a non-empty `due_at` decides alone. If that value does not parse, the request has no deadline (`completed_late: null`, warning logged); we do not fall back to an older `due_at` it superseded. Request `due_on` is never used.
- **Site-local wall clock and DST.** `due_at` and business hours are site-local wall clock, converted with the IANA zone. A time inside a DST gap (Sydney 2026-10-04 02:00–03:00) moves forward by the gap; an ambiguous time (2026-04-05 02:00–03:00) takes the earlier instant. Business hours on a DST day are counted in real elapsed time.
- **Business hours shape.** `close` of `24:00` = midnight; `close <= open` = closes the next day (overnight). A holiday removes the window that starts that day.
- **Priority.** Case-sensitive per the docs; `Low`, `null` and any unknown value get the 480-minute target (unknown values are logged).
- **Responder name.** Current name from `/v1/staff` (kept fresh through `staff.updated`); if the id is missing from staff, the latest `actor_name` seen for that id; else `null`.
- **Unknown site or unparseable `created_at`.** Row excluded and logged once, rather than guessing a timezone.
- **Validation.** A known parameter given twice is `400`; an empty value for a known parameter is `400`; unknown parameters are ignored, as the contract says.
- **Paging while data changes.** The first page pins a snapshot (store version); later pages read that snapshot for 15 minutes, so a row present for the whole walk appears exactly once even if its sort key (`response_business_minutes`) changes mid-walk. Cursors are HMAC-signed and bound to the query, so a forged cursor or a cursor reused with other filters is `400`. If a snapshot expired, paging falls back to keyset on live data.

## What I found in the API or data

- Four time formats in one API: ISO UTC (`created_at`), Unix seconds (`at`), `DD/MM/YYYY HH:mm` site-local (`due_at`), `DD/MM/YYYY` (holidays, `created_from`). All parsed with strict regexes; never `new Date(string)` (it reads `07/10/2026` as July).
- `created_from`/`created_to` do not say which timezone they use, so they are not relied on; rule 1 is applied on our side.
- The feed's `request` is the current state and items can repeat, so every write is an idempotent upsert; a replay after `410` changes nothing that did not change.
- Sites and holidays are not in the feed: loaded at start and refreshed every 5 minutes.
- Practice API, measured on a full walk of the feed:
  - 79k unique feed items (12k `request.created`, 46k `event.created`, 21.5k `request.updated`, 2 `staff.updated`), 160 pages of 500. No other change types appeared.
  - Items do repeat: 318 duplicate `seq`s, and 12,049 `request.created` for 12,001 requests. Page boundaries overlap, so `seq` is not strictly increasing across pages (…500, 499…). Nothing relies on `seq` order; upserts by id absorb all of it.
  - Spot check: feed events are byte-identical to `/v1/requests/{id}/events` for the same request, so the feed is a sufficient source of events.
  - Formats match the docs (`HH:MM` hours, `DD/MM/YYYY HH:mm` due dates, ISO `Z` timestamps, integer `at`). Jakarta opens on Saturday morning; Singapore and Sydney are weekdays only.
  - Present in the data: System events with status `processing` (31 in the first 1,000 items; correctly not a first response), reverts with the note "Status changed in error", `null` priority (about a quarter of requests), deleted and merged requests.
- Two different staff share the name "Marcus Lee" (ids 368 and 371), and two staff were renamed during the period. `responders` is therefore grouped by `responder_id`, never by name, and always shows the current name.
- `/ready` on the practice API: 39.7 s, 165 calls, **0** 429s (a back-to-back discovery script that did not pace calls got 2 429s, which the client handles with `Retry-After`).
- Report timings over HTTP on the practice data: 1 May–31 Oct (11,044 rows) 84 ms, October (1,910 rows) 17 ms. A full October browse walk at `limit=200` returned 1,910 rows with no duplicates.
- Parsers stay tolerant of small variations anyway (`H:MM`, `:SS`, 1-digit day/month, `+HHMM`), because grading uses different data: a format surprise should cost one field, not a whole site.

## How I used AI

- Claude (Anthropic) as a pair: it read the kit, wrote a discovery checklist and a spec with every rule turned into precise definitions, then a plan with file ownership. Four sub-agents implemented time, sync (+ a fake helpdesk), query/cursor and rules in parallel; I reviewed and integrated, wrote the HTTP layer and the end-to-end test.
- The e2e test's expected rows were computed by hand from `rules.md`, not by the engine, so the pipeline is checked against an independent oracle.
- A separate reviewer agent, which had not seen the implementation, checked the code against the docs. It found no wrong rows. It did find that over-strict parsers could silently drop rows, and that a failing metadata refresh stopped the change feed (reproduced, then fixed with a regression test).
- What I corrected or decided myself: the zero-dependency choice when the sandbox could not reach npm; snapshot paging (plain keyset breaks when a row's sort key changes mid-walk); not falling back to an older `due_at`; the literal revert-chain reading.

## Trade-offs and what I would do next

- **In-memory store.** Fast and simple, but a restart resyncs from the feed (well inside the 8-minute budget). Next: persist the feed cursor and rows in SQLite to restart instantly.
- **No build step, zero dependencies.** TypeScript runs through Node 22 type stripping, so only erasable syntax is used. `npm run typecheck` runs `tsc --noEmit` when a registry is reachable.
- **Polling every 10 s.** Comfortably inside the 60 s budget with few calls. Next: adaptive polling and metrics (`/metrics` with feed lag, 429 count).
- **Page is plain HTML.** Polish is not scored. Next: per-site charts of response time and lateness.
