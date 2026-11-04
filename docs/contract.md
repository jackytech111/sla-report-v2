# Your app's contract

We grade your app by calling these endpoints, so keep the shapes exactly as shown. Key order
doesn't matter; names and types do. `from`/`to` are `YYYY-MM-DD` local dates of each request's
site, inclusive.

## GET /health

`200 {"ok": true}` as soon as the app is up.

## GET /ready

`200 {"ready": true}` once the app can answer reports for the last six months, `503` until then.
Other endpoints may answer `503` before that too.

## GET /api/sla-report?from=YYYY-MM-DD&to=YYYY-MM-DD

```json
{
  "from": "2026-10-01",
  "to": "2026-10-31",
  "requests": [
    {
      "id": 41210,
      "site_id": 11,
      "responder_id": 304,
      "responder": "Benjamin Tan",
      "response_business_minutes": 42,
      "within_target": true,
      "completed_late": false
    },
    {
      "id": 41214,
      "site_id": 12,
      "responder_id": null,
      "responder": null,
      "response_business_minutes": null,
      "within_target": null,
      "completed_late": null
    }
  ],
  "responders": [
    {"id": 304, "name": "Benjamin Tan", "requests": 17, "within_target": 12, "completed_late": 3}
  ]
}
```

- `requests`: one row per request in range (rule 1 in `docs/rules.md`), any order. Fields follow rules 3 to 7.
- `responders`: one row per responder in `requests`: current name, request count, and how many
  of those were within target and completed late.
- Missing or invalid `from`/`to`, or `from` after `to`: `400`.

## GET /api/requests (level 4)

The same rows as `requests` above, filtered, sorted and paged:
`{"data": [{"id": 41210, "...": "..."}], "next_cursor": "opaque-string-or-null"}`.

| Parameter | Notes |
| --- | --- |
| `from`, `to` | Required, as above |
| `site_id` | Only this site |
| `responder_id` | Only this responder |
| `late` | `true`/`false`: only rows whose `completed_late` is that value |
| `within_target` | `true`/`false`: only rows whose `within_target` is that value |
| `sort` | `id` (default), `-id`, `response_business_minutes`, `-response_business_minutes`. Nulls last; ties by `id` ascending |
| `limit` | 1 to 200, default 50 |
| `cursor` | `next_cursor` from the previous page |

- `next_cursor` is `null` on the last page.
- Data may change mid-walk. A row that exists and matches for the whole walk appears **exactly
  once**; rows added or removed meanwhile may or may not appear.
- Any invalid value, including a cursor you didn't issue: `400`. Unknown parameters are ignored.

## How we score it

We run your app against the same API with **different data**. Each level is scored on its own:

| Level | Weight | What we check |
| --- | --- | --- |
| 1. Report | 40% | Every row of October and of 12–18 October, against the rules |
| 2. Fast | 25% | `/ready` within 8 minutes; 1 May–31 Oct correct in under 10 s; October in under 5 s; not flooding the API into `429`s |
| 3. Live | 20% | We change the data; your report shows it within 60 s |
| 4. Browse | 15% | `/api/requests`: every filter, sort and page, also while the data changes |

Go through the levels in order. Numbers copied from the practice data won't match.
