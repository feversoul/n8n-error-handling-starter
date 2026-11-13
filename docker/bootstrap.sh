#!/bin/sh
# Entrypoint of the n8n container in docker-compose.yml.
# First start only: import and publish the workflows, then call the setup
# webhook once n8n is up so the two data tables exist. Later starts leave
# your edits alone.
set -eu

MARK=/home/node/.n8n/.error-starter-imported

if [ -f "$MARK" ]; then
  exec n8n start
fi

STAGE=$(mktemp -d)
node /bootstrap/prepare.mjs /bootstrap/workflows "$STAGE"
n8n import:workflow --separate --input="$STAGE"
for id in esSetup000000001 esErrors00000001 esSync0000000001 esLab00000000001; do
  n8n publish:workflow --id="$id"
done
rm -rf "$STAGE"

n8n start &
N8N=$!
trap 'kill -TERM "$N8N" 2>/dev/null' TERM INT

# Data tables can only be created by a running n8n, so the tables are made
# through the setup workflow's webhook.
tries=0
until wget -q -O /dev/null --header="Content-Type: application/json" --post-data='{}' \
  http://127.0.0.1:5678/webhook/error-starter/setup 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 90 ] || ! kill -0 "$N8N" 2>/dev/null; then
    echo "error-starter: could not create the data tables" >&2
    kill -TERM "$N8N" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done
touch "$MARK"
echo "error-starter: workflows published and data tables created"

wait "$N8N"
