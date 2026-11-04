#!/bin/sh
set -e
case "$1" in
  start) exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8080}" ;;
  test)  exec python -m pytest -q ;;
  *)     exec "$@" ;;
esac
