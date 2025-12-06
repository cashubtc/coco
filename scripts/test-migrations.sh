#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_test() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

# Show help
show_help() {
    echo "Usage: $0 [adapter|all|list]"
    echo ""
    echo "Run migration tests for storage adapters."
    echo ""
    echo "Options:"
    echo "  expo-sqlite    Run expo-sqlite migration tests"
    echo "  sqlite3        Run sqlite3 migration tests"
    echo "  indexeddb      Run indexeddb migration tests (requires Playwright)"
    echo "  all            Run all migration tests (default)"
    echo "  list           List available adapters"
    echo "  help           Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                    # Run all migration tests"
    echo "  $0 expo-sqlite        # Run expo-sqlite migration tests only"
    echo "  $0 sqlite3            # Run sqlite3 migration tests only"
    echo ""
}

# List available adapters
list_adapters() {
    log_info "Available adapters with migration tests:"
    echo ""
    echo "  - expo-sqlite   (bun test)"
    echo "  - sqlite3       (bun test)"
    echo "  - indexeddb     (vitest + playwright)"
    echo ""
}

# Run expo-sqlite migration tests
run_expo_sqlite() {
    log_test "Running expo-sqlite migration tests..."
    cd "$PROJECT_ROOT/packages/expo-sqlite"
    bun test migrations
}

# Run sqlite3 migration tests
run_sqlite3() {
    log_test "Running sqlite3 migration tests..."
    cd "$PROJECT_ROOT/packages/sqlite3"
    bun test migrations
}

# Run indexeddb migration tests
run_indexeddb() {
    log_test "Running indexeddb migration tests..."
    log_info "Installing Playwright browsers (chromium)..."
    cd "$PROJECT_ROOT/packages/indexeddb"
    bunx playwright install --with-deps chromium 2>/dev/null || {
        log_warn "Failed to install with deps, trying without..."
        bunx playwright install chromium
    }
    bunx vitest run --reporter=verbose src/test/migrations.test.ts
}

# Build required packages
build_packages() {
    log_info "Building packages..."
    
    cd "$PROJECT_ROOT/packages/core"
    bun run build
    
    cd "$PROJECT_ROOT/packages/adapter-tests"
    bun run build
}

# Run all migration tests
run_all() {
    local failed=0
    
    log_test "Running expo-sqlite migration tests..."
    if run_expo_sqlite; then
        log_info "expo-sqlite migration tests passed"
    else
        log_error "expo-sqlite migration tests failed"
        failed=$((failed + 1))
    fi
    echo ""
    
    log_test "Running sqlite3 migration tests..."
    if run_sqlite3; then
        log_info "sqlite3 migration tests passed"
    else
        log_error "sqlite3 migration tests failed"
        failed=$((failed + 1))
    fi
    echo ""
    
    log_test "Running indexeddb migration tests..."
    if run_indexeddb; then
        log_info "indexeddb migration tests passed"
    else
        log_error "indexeddb migration tests failed"
        failed=$((failed + 1))
    fi
    echo ""
    
    if [ $failed -eq 0 ]; then
        log_info "All migration tests passed!"
        return 0
    else
        log_error "$failed adapter(s) failed"
        return 1
    fi
}

# Parse command
COMMAND="${1:-all}"

case "$COMMAND" in
    help|--help|-h)
        show_help
        exit 0
        ;;
    list|--list)
        list_adapters
        exit 0
        ;;
    expo-sqlite)
        build_packages
        run_expo_sqlite
        ;;
    sqlite3)
        build_packages
        run_sqlite3
        ;;
    indexeddb)
        build_packages
        run_indexeddb
        ;;
    all)
        build_packages
        run_all
        ;;
    *)
        log_error "Unknown adapter: $COMMAND"
        echo ""
        list_adapters
        exit 1
        ;;
esac

