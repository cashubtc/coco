#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.yml"
COMPOSE_PROJECT="${COCO_FAULT_LAB_COMPOSE_PROJECT:-coco-cashu-fault-lab}"
ADAPTER_PORT="${COCO_FAULT_LAB_ADAPTER_PORT:-4103}"
GATEWAY_PORT="${COCO_FAULT_LAB_GATEWAY_PORT:-4300}"
ADAPTER_URL="http://127.0.0.1:${ADAPTER_PORT}"
GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
ADAPTER_TOKEN="${COCO_FAULT_LAB_CONTROL_TOKEN:-coco-fault-lab-local-adapter}"
GATEWAY_TOKEN="${CFL_HTTP_FAULT_GATEWAY_TOKEN:-coco-fault-lab-local-gateway}"
FAULT_LAB_VERSION="0.2.0"
SEED="wallet-lifecycle-v1:mint-response-lost"
TEMPORARY_DIRECTORY="$(mktemp -d)"
DATABASE_PATH="$TEMPORARY_DIRECTORY/coco.sqlite"
ADAPTER_LOG="$TEMPORARY_DIRECTORY/adapter.log"
REPORT_PATH="${COCO_FAULT_LAB_REPORT:-$TEMPORARY_DIRECTORY/mint-response-lost.json}"
ADAPTER_PID=''

compose() {
  CFL_HTTP_FAULT_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
    COCO_FAULT_LAB_GATEWAY_PORT="$GATEWAY_PORT" \
    docker compose --project-name "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [ -n "$ADAPTER_PID" ]; then
    kill "$ADAPTER_PID" 2>/dev/null || true
    wait "$ADAPTER_PID" 2>/dev/null || true
  fi
  if [ "$result" -ne 0 ]; then
    if [ -f "$ADAPTER_LOG" ]; then
      echo 'Coco Fault Lab adapter log:' >&2
      sed -n '1,240p' "$ADAPTER_LOG" >&2
    fi
    compose logs --no-color >&2 2>/dev/null || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TEMPORARY_DIRECTORY"
  exit "$result"
}

trap cleanup EXIT INT TERM

for command in bun curl docker node npx; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 1
  fi
done

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -ne 24 ]; then
  echo "cashu-fault-lab@${FAULT_LAB_VERSION} requires Node.js 24; found $(node --version)" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo 'Docker is installed but its daemon is unavailable' >&2
  exit 1
fi

mkdir -p "$(dirname "$REPORT_PATH")"

cd "$PROJECT_ROOT"
bun run build:fault-lab

compose up --detach --wait

COCO_FAULT_LAB_CONTROL_TOKEN="$ADAPTER_TOKEN" \
COCO_FAULT_LAB_DATABASE="$DATABASE_PATH" \
COCO_FAULT_LAB_HOST='127.0.0.1' \
COCO_FAULT_LAB_MINT_ID='mintd-local' \
COCO_FAULT_LAB_MINT_IMPLEMENTATION='mintd' \
COCO_FAULT_LAB_MINT_VERSION='0.17.3' \
COCO_FAULT_LAB_MINT_URL="$GATEWAY_URL" \
COCO_FAULT_LAB_PORT="$ADAPTER_PORT" \
COCO_FAULT_LAB_UNIT='sat' \
bun run test/fault-lab/adapter.ts >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID=$!

for attempt in $(seq 1 30); do
  if curl --fail --silent \
    --header "Authorization: Bearer $ADAPTER_TOKEN" \
    "$ADAPTER_URL/v1/lifecycle/capabilities" >/dev/null; then
    break
  fi
  if ! kill -0 "$ADAPTER_PID" 2>/dev/null; then
    echo 'Coco Fault Lab adapter exited before becoming ready' >&2
    exit 1
  fi
  if [ "$attempt" -eq 30 ]; then
    echo 'Coco Fault Lab adapter did not become ready' >&2
    exit 1
  fi
  sleep 1
done

CFL_HTTP_FAULT_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
CFL_HTTP_FAULT_GATEWAY_URL="$GATEWAY_URL" \
CFL_LIFECYCLE_COCO_TOKEN="$ADAPTER_TOKEN" \
CFL_LIFECYCLE_COCO_URL="$ADAPTER_URL" \
npx --yes "cashu-fault-lab@${FAULT_LAB_VERSION}" lifecycle run mint-response-lost \
  --adapter coco \
  --mint mintd-local \
  --mint-url "$GATEWAY_URL" \
  --seed "$SEED" \
  --format json \
  --output "$REPORT_PATH"

if [ -n "${COCO_FAULT_LAB_REPORT:-}" ]; then
  echo "Cashu Fault Lab mint-response-lost passed. Report: $REPORT_PATH"
else
  echo 'Cashu Fault Lab mint-response-lost passed.'
fi
