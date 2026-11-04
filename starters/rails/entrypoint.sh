#!/bin/sh
set -e
case "$1" in
  start) exec bundle exec puma -C config/puma.rb ;;
  test)  RAILS_ENV=test exec bin/rails test ;;
  *)     exec "$@" ;;
esac
