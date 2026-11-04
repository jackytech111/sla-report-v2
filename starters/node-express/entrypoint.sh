#!/bin/sh
set -e
case "$1" in
  start) exec node src/server.js ;;
  test)  exec npm test ;;
  *)     exec "$@" ;;
esac
