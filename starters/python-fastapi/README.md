# Python + FastAPI starter

Python 3.12, FastAPI, uvicorn, httpx, pytest.

## Use it

Copy this folder to `app/` at the kit root, then from the kit root:

```sh
docker compose up                      # app on http://localhost:8080
docker compose run --rm app test       # run the tests (exit 0 = pass)
```

Adding a package? Add it to `requirements.txt` with an exact version (`name==x.y.z`), then `docker compose build app`.

## Where things are

| File | What |
| --- | --- |
| `app/main.py` | Routes. **`GET /api/sla-report` is a stub — implement the report there.** |
| `app/helpdesk.py` | Minimal API client (`HELPDESK_URL`, `HELPDESK_TOKEN`, Bearer auth, raises on non-2xx). |
| `static/index.html` | The page served at `/`. |
| `tests/` | pytest tests (`test_*.py`). |
| `entrypoint.sh` | `start` (default) runs uvicorn on `0.0.0.0:$PORT` (default 8080), `test` runs pytest, anything else is executed as-is. |
