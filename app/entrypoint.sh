#!/bin/sh
set -e
case "$1" in
  start) exec node src/server.ts ;;
  test)  exec node --test --test-reporter=spec "test/**/*.test.ts" ;;
  *)     exec "$@" ;;
esac
