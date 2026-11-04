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
- _Practice-data findings (change types seen, `seq` behaviour, hours format, feed size, rate limits) will be added after the live run._

## How I used AI

- Claude (Anthropic) as a pair: it read the kit, wrote a discovery checklist and a spec with every rule turned into precise definitions, then a plan with file ownership. Four sub-agents implemented time, sync (+ a fake helpdesk), query/cursor and rules in parallel; I reviewed and integrated, wrote the HTTP layer and the end-to-end test.
- The e2e test's expected rows were computed by hand from `rules.md`, not by the engine, so the pipeline is checked against an independent oracle.
- What I corrected or decided myself: the zero-dependency choice when the sandbox could not reach npm; snapshot paging (plain keyset breaks when a row's sort key changes mid-walk); not falling back to an older `due_at`; the literal revert-chain reading.

## Trade-offs and what I would do next

- **In-memory store.** Fast and simple, but a restart resyncs from the feed (well inside the 8-minute budget). Next: persist the feed cursor and rows in SQLite to restart instantly.
- **No build step, zero dependencies.** TypeScript runs through Node 22 type stripping, so only erasable syntax is used. `npm run typecheck` runs `tsc --noEmit` when a registry is reachable.
- **Polling every 10 s.** Comfortably inside the 60 s budget with few calls. Next: adaptive polling and metrics (`/metrics` with feed lag, 429 count).
- **Page is plain HTML.** Polish is not scored. Next: per-site charts of response time and lateness.
