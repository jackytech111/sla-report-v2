# Node.js + Express starter

Node 22, Express 5, tests with the built-in `node --test` runner.

## Use it

Copy this folder to `app/` at the kit root, then from the kit root:

```sh
docker compose up                      # app on http://localhost:8080
docker compose run --rm app test       # run the tests (exit 0 = pass)
```

Adding a package? Run npm inside Docker (no Node needed on your machine), then rebuild:

```sh
docker run --rm -v "$PWD/app":/w -w /w node:22-slim npm install <package>@<version>
docker compose build app
```

## Where things are

| File | What |
| --- | --- |
| `src/app.js` | Routes. **`GET /api/sla-report` is a stub — implement the report there.** |
| `src/helpdesk.js` | Minimal API client (`HELPDESK_URL`, `HELPDESK_TOKEN`, Bearer auth, throws on non-2xx). |
| `src/server.js` | Starts the server on `0.0.0.0:$PORT` (default 8080). |
| `public/index.html` | The page served at `/`. |
| `test/` | Tests (`*.test.js`), run with `node --test`. |
| `entrypoint.sh` | `start` (default) runs the server, `test` runs the tests, anything else is executed as-is. |
