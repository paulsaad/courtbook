#!/usr/bin/env bash
# Stops the local API started by start.sh and drops its scratch database.
for f in /tmp/courtbook-api/pgrst.pid /tmp/courtbook-api/proxy.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
${PSQL:-psql} -q -d postgres -c "drop database if exists courtbook_api" >/dev/null 2>&1 || true
