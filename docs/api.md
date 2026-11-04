# Helpdesk API

Made-up data that changes while you work. Base URL and token are on your invitation page; send
`Authorization: Bearer <token>`. Errors are `{"error": "..."}`. Each endpoint is rate limited; a
`429` has `Retry-After` (seconds). Each site has its own timezone, hours and holidays.

## Endpoints

| Endpoint | What it returns |
| --- | --- |
| `GET /v1/requests` | Requests, newest first, paged |
| `GET /v1/requests/{id}` | One request |
| `GET /v1/requests/{id}/events` | A request's events, newest first, 50 a page |
| `GET /v1/changes` | Every change since the start, in order |
| `GET /v1/sites` | Sites with timezone and business hours |
| `GET /v1/sites/{id}/holidays` | A site's holidays (closed all day) |
| `GET /v1/staff` | Staff with their current names |
| `GET /v1/statuses` | Status values and labels |

## Requests

`GET /v1/requests?page=1&per_page=100&created_from=01/10/2026&created_to=31/10/2026&status=["pending","processing"]`

| Parameter | Notes |
| --- | --- |
| `page` | Starts at 1 |
| `per_page` | Default 20, max 100 |
| `created_from`, `created_to` | Created on or after / on or before this date, `DD/MM/YYYY` |
| `status` | JSON array of status values |

```json
{
  "data": [
    {
      "id": 41210,
      "ref": "WO-41210",
      "title": "Room too warm",
      "location": "North Wing / Lobby",
      "site_id": 11,
      "status": "processing",
      "priority": "High",
      "created_at": "2026-10-06T02:15:07Z",
      "updated_at": "2026-10-06T03:40:00Z",
      "due_on": "2026-10-07",
      "assignee": {"id": 304, "name": "Benjamin Tan"},
      "deleted_at": null,
      "merged_into_id": null
    }
  ],
  "page": 1, "per_page": 20, "total_pages": 12, "total": 231
}
```

`status` is `pending`, `processing`, `complete` or `canceled`. `priority` is `Low`, `Medium`,
`High` or `null`. `due_on` is the current due date (site local). `deleted_at` is set when deleted;
`merged_into_id` when merged into another request as a duplicate.

## Events

`GET /v1/requests/{id}/events?page=1`: every status change, assignment and note, newest first.

```json
{
  "data": [
    {
      "id": 300912,
      "status": "processing",
      "at": 1791874530,
      "actor_id": 304,
      "actor_name": "Benjamin Tan",
      "assignee_name": null,
      "due_at": "07/10/2026 10:00",
      "note": null,
      "reverts_id": null
    }
  ],
  "page": 1, "per_page": 50, "has_more": false
}
```

`status` is the request's status after the event; `at` is Unix seconds. `actor_name` is the name
at the time; automatic events have `actor_id: null` and `actor_name: "System"`. `due_at` is a
deadline set by this event, site local time. `reverts_id` means this event undoes that event.

## Change feed

`GET /v1/changes?cursor=...&limit=500`: use it to keep your own copy of the data up to date.

| Parameter | Notes |
| --- | --- |
| `cursor` | `next_cursor` from the last response. Leave out to start from the beginning |
| `limit` | Default 100, max 500 |

```json
{
  "data": [
    {"seq": 101, "type": "request.created", "at": "2026-05-01T01:00:00Z", "request": {"id": 41210, "...": "..."}},
    {"seq": 102, "type": "event.created", "at": "2026-05-01T01:00:00Z", "request_id": 41210, "event": {"id": 300912, "...": "..."}},
    {"seq": 103, "type": "request.updated", "at": "2026-05-01T02:10:00Z", "request": {"id": 41210, "...": "..."}},
    {"seq": 104, "type": "staff.updated", "at": "2026-05-01T03:00:00Z", "staff": {"id": 304, "name": "Benjamin Tan"}}
  ],
  "next_cursor": "eyJzIjoxMDQsInQiOjE3OTE...",
  "has_more": true
}
```

- `request` is the request **as it is now**, not at that change.
- An item may arrive more than once.
- `has_more: false` means you're up to date; keep calling with the latest `next_cursor` for new
  changes.
- Cursors expire after 15 minutes (`410`); start again without one.

## Sites, holidays, staff, statuses

```json
GET /v1/sites
{"data": [{
  "id": 11,
  "name": "Robusttechhouse Tower Singapore",
  "timezone": "Asia/Singapore",
  "business_hours": {"mon": {"open": "08:00", "close": "18:00"}, "...": "...", "sun": null}
}]}

GET /v1/sites/11/holidays
{"data": [{"date": "10/08/2026", "name": "National Day (observed)"}]}

GET /v1/staff
{"data": [{"id": 304, "name": "Benjamin Tan"}]}

GET /v1/statuses
{"data": [{"value": "pending", "label": "Pending"}]}
```

`timezone` is an IANA name. Hours are local wall-clock times; `null` means closed all day.
