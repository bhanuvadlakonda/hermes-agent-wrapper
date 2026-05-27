#!/usr/bin/env bash
set -euo pipefail

export HERMES_HOME="${HERMES_HOME:-/opt/data}"
export HERMES_DASHBOARD_URL="${HERMES_DASHBOARD_URL:-http://127.0.0.1:${HERMES_DASHBOARD_PORT:-9119}}"

if [ "${MIGRATION_MODE:-0}" = "1" ]; then
  echo "[migration] MIGRATION_MODE=1; holding container open without starting gateway or dashboard."
  trap 'exit 0' INT TERM
  while true; do
    sleep 3600 &
    wait "$!"
  done
fi

gateway_pid=""
proxy_pid=""

shutdown() {
  if [ -n "$proxy_pid" ] && kill -0 "$proxy_pid" 2>/dev/null; then
    kill "$proxy_pid" 2>/dev/null || true
  fi
  if [ -n "$gateway_pid" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
  fi
}

trap shutdown INT TERM EXIT

hermes gateway run &
gateway_pid="$!"

node /opt/hermes-railway/dashboard-proxy.mjs &
proxy_pid="$!"

wait -n "$gateway_pid" "$proxy_pid"
exit_code="$?"
shutdown
exit "$exit_code"
