from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Response-time report")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/ready")
def ready():
    # TODO: answer 200 {"ready": true} once your app can serve six-month reports (level 2).
    return JSONResponse(status_code=503, content={"ready": False})


@app.get("/api/requests")
def browse(request: Request):
    # TODO (level 4): filters, sorting and cursor pagination, see docs/contract.md.
    return JSONResponse(status_code=501, content={"error": "not implemented"})


@app.get("/api/sla-report")
def sla_report(request: Request):
    # TODO: implement the response-time report here.
    # Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, e.g. request.query_params.get("from")
    # (`from` is a Python keyword; Query(alias="from") also works).
    # Use HelpdeskClient from app/helpdesk.py to call the helpdesk API.
    return JSONResponse(status_code=501, content={"error": "not implemented"})
