# Ruby on Rails starter

Ruby 3.3, Rails 8.0 (API-only, no database), Puma, Minitest.

## Use it

Copy this folder to `app/` at the kit root, then from the kit root:

```sh
docker compose up                      # app on http://localhost:8080
docker compose run --rm app test       # run the tests (exit 0 = pass)
```

The container runs with `RAILS_ENV=production`; code changes need `docker compose up --build`.
Adding a gem? Add it to the `Gemfile` with an exact version, update the lockfile inside Docker, then rebuild:

```sh
docker run --rm -v "$PWD/app":/w -w /w ruby:3.3-slim bundle lock
docker compose build app
```

## Where things are

| File | What |
| --- | --- |
| `app/controllers/sla_reports_controller.rb` | **`GET /api/sla-report` is a stub — implement the report there.** |
| `app/services/helpdesk_client.rb` | Minimal API client (`HELPDESK_URL`, `HELPDESK_TOKEN`, Bearer auth, raises on non-2xx). |
| `config/routes.rb` | Routes. |
| `public/index.html` | The page served at `/`. |
| `test/` | Minitest tests, run with `bin/rails test`. |
| `config/application.rb` | App config, including a dummy `secret_key_base` so no credentials are needed. |
| `entrypoint.sh` | `start` (default) runs Puma on `0.0.0.0:$PORT` (default 8080), `test` runs `bin/rails test`, anything else is executed as-is. |
