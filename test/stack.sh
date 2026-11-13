#!/bin/sh
# test/stack.sh up|down|logs   the test stack by hand
cd "$(dirname "$0")/.."
files="-f docker-compose.yml -f test/docker-compose.yml"
case "$1" in
  up) docker compose --env-file test/test.env $files -p errstarter-test up -d ;;
  down) docker compose --env-file test/test.env $files -p errstarter-test down -v ;;
  logs) docker compose --env-file test/test.env $files -p errstarter-test logs --tail "${TAIL:-40}" n8n ;;
  *) docker compose --env-file test/test.env $files -p errstarter-test "$@" ;;
esac
