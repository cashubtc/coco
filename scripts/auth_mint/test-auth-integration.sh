#!/bin/bash
#
# Auth integration tests for NUT-21/22.
#
# Fully automated via Keycloak password grant — no browser needed.
#   ./scripts/auth_mint/test-auth-integration.sh
#
# Prerequisites: docker, curl

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MINT_PORT=3339
MINT_URL="http://localhost:${MINT_PORT}"
KEYCLOAK_URL="http://localhost:8080"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_test()  { echo -e "${BLUE}[TEST]${NC} $1"; }

cleanup() {
    log_info "Stopping auth mint containers..."
    cd "$SCRIPT_DIR"
    docker compose down --remove-orphans 2>/dev/null || true
}

trap cleanup EXIT

wait_for_service() {
    local url=$1
    local name=$2
    local max_attempts=${3:-60}
    local attempt=0

    log_info "Waiting for $name..."
    while [ $attempt -lt $max_attempts ]; do
        if curl -f -s "$url" > /dev/null 2>&1; then
            log_info "$name is ready!"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    log_error "$name failed to start after $max_attempts attempts"
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" logs
    return 1
}

# Parse args
LOG_LEVEL=""
TEST_PATTERN=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -l|--log-level) LOG_LEVEL="$2"; shift 2 ;;
        -t|--test-name-pattern) TEST_PATTERN="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [-l LEVEL] [-t PATTERN]"
            echo ""
            echo "  -l LEVEL    Log level: error, warn, info, debug"
            echo "  -t PATTERN  Filter tests by name"
            exit 0
            ;;
        *) log_error "Unknown option: $1"; exit 1 ;;
    esac
done

# Check prerequisites
for cmd in docker curl; do
    if ! command -v $cmd &> /dev/null; then
        log_error "$cmd is not installed"
        exit 1
    fi
done

# Build
log_info "Building packages..."
cd "$PROJECT_ROOT/packages/adapter-tests" && bun run build
cd "$PROJECT_ROOT/packages/core" && bun run build

# Start containers
log_info "Starting Keycloak + Nutshell auth mint..."
cd "$SCRIPT_DIR"
docker compose up -d

wait_for_service "${KEYCLOAK_URL}/realms/cashu" "Keycloak" 60
wait_for_service "${MINT_URL}/v1/info" "Nutshell mint" 60

# Run tests
cd "$PROJECT_ROOT/packages/core"

export MINT_URL
[ -n "$LOG_LEVEL" ] && export TEST_LOG_LEVEL="$LOG_LEVEL"

# Keycloak test credentials for automated token acquisition
export AUTH_TEST_KEYCLOAK_URL="$KEYCLOAK_URL"
export AUTH_TEST_CLIENT_ID="cashu-client"
export AUTH_TEST_USERNAME="test@test.com"
export AUTH_TEST_PASSWORD="testtest"

log_test "Auth integration tests (login + BAT)"

test_result=0
if [ -n "$TEST_PATTERN" ]; then
    bun test "test/integration/auth-login.test.ts" "test/integration/auth-bat.test.ts" -t "$TEST_PATTERN" --timeout 300000 || test_result=$?
else
    bun test "test/integration/auth-login.test.ts" "test/integration/auth-bat.test.ts" --timeout 300000 || test_result=$?
fi

if [ $test_result -eq 0 ]; then
    log_info "Auth integration tests passed!"
else
    log_error "Auth integration tests failed"
fi

exit $test_result
