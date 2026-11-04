# The rules

These seven rules are all of them; nothing is hidden. They use the field names from `docs/api.md`. Times
are local to the request's site (`/v1/sites` gives each site's timezone, business hours and
holidays).

1. **Which requests count.** `created_at`, converted to the site's local date, is from `from` to
   `to` inclusive. Skip requests with status `canceled`, with `deleted_at` set, or with
   `merged_into_id` set.
2. **Undone events.** An event with `reverts_id` undoes the event it points at. Ignore both the
   reverted event and the reverting event in every rule below.
3. **First response and responder.** The earliest event (by `at`) with status `processing` and an
   `actor_id` (System events have `actor_id: null`). Its `actor_id` is the responder; show the
   current name from `/v1/staff`, not `actor_name` on the event.
4. **Response minutes.** Business-hours time from `created_at` to the first response's `at`, using
   the site's `business_hours` and `/v1/sites/{id}/holidays`, summed in seconds, then floored to
   minutes. 0 if the response is earlier than `created_at`.
5. **Within target.** `response_business_minutes` ≤ 60 for `High`, 240 for `Medium`, 480 for `Low`
   or `null` priority.
6. **Completed late.** The last event with status `complete` (even if later events reopened the
   request) has `at` strictly after the deadline. The deadline is the `due_at` of the latest event
   that has one, read as site-local wall-clock time.
7. **Nulls.** No first response: `responder_id`, `responder`, `response_business_minutes` and
   `within_target` are `null`. Never completed, or no deadline: `completed_late` is `null`.
