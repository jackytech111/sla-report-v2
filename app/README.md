# SLA report app (Node 22 + TypeScript, zero dependencies)

```sh
docker compose up --build            # from the kit root; app on http://localhost:8080
docker compose run --rm app test     # all tests (unit + end-to-end against a fake helpdesk)
```

Without Docker (Node >= 22.18): `HELPDESK_URL=... HELPDESK_TOKEN=... node src/server.ts`, tests with `npm test`.

| File | What |
| --- | --- |
| `src/server.ts` | Wiring: HTTP server up at once, sync in the background |
| `src/helpdesk.ts` | API client: Bearer auth, one call at a time, `Retry-After` on 429, backoff on 5xx, `GoneError` on 410 |
| `src/sync.ts` | Bootstrap (sites, holidays, staff, full change feed) then poll the feed every 10 s |
| `src/store.ts` | In-memory requests/events/staff/sites, immutable rows, versioned snapshots |
| `src/rules.ts` | The seven rules of `docs/rules.md` as one pure function |
| `src/time.ts` | Site-local dates, DST-aware wall clock, business-hours arithmetic |
| `src/query.ts` | Report building, filters, sorting, snapshot-stable keyset paging |
| `src/validate.ts`, `src/cursor.ts` | Parameter validation (400s), HMAC-signed cursors |
| `src/http.ts` | Routes and JSON errors per `docs/contract.md` |
| `test/fake-helpdesk.ts` | A fake helpdesk implementing `docs/api.md` (429, duplicates, 410, renames) |

Env: `HELPDESK_URL`, `HELPDESK_TOKEN`, `PORT` (8080), `POLL_MS` (10000), `LOG_LEVEL` (`info` / `debug`).
