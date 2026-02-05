#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_PORT=3338

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

# Check if a package uses browser tests (has test:browser script)
is_browser_test_package() {
    local package_dir=$1
    local package_json="$package_dir/package.json"
    
    if [ -f "$package_json" ]; then
        if grep -q '"test:browser"' "$package_json" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Ensure Playwright browsers are installed
ensure_playwright_browsers() {
    log_info "Ensuring Playwright browsers are installed..."
    cd "$PROJECT_ROOT"
    npx playwright install --with-deps chromium firefox webkit 2>/dev/null || {
        log_warn "Failed to install all browsers, trying without deps..."
        npx playwright install chromium firefox webkit || {
            log_error "Failed to install Playwright browsers"
            return 1
        }
    }
}

# Discover integration test files
discover_integration_tests() {
    find "$PROJECT_ROOT/packages" -name "integration.test.ts" -type f | while read -r test_file; do
        # Extract package name from path: packages/package-name/src/test/integration.test.ts
        package_path=$(echo "$test_file" | sed -n 's|.*packages/\([^/]*\)/.*|\1|p')
        echo "$package_path|$test_file"
    done
}

# List available integration tests
list_tests() {
    log_info "Available integration tests:"
    echo ""
    discover_integration_tests | while IFS='|' read -r package test_file; do
        echo "  - $package"
        echo "    Path: $test_file"
    done
}

# Start a mint container for a specific package
start_mint_container() {
    local package_name=$1
    local port=$2
    local container_name="cdk-mint-${package_name}"
    local mint_url="http://localhost:${port}"
    
    log_info "Starting mint container for $package_name on port $port..."
    
    # Stop and remove existing container if it exists
    docker stop "$container_name" 2>/dev/null || true
    docker rm "$container_name" 2>/dev/null || true
    
    # Start new container
    docker run -d \
        -p "${port}:3338" \
        --name "$container_name" \
        -e CDK_MINTD_DATABASE=sqlite \
        -e CDK_MINTD_LN_BACKEND=fakewallet \
        -e CDK_MINTD_INPUT_FEE_PPK=100 \
        -e CDK_MINTD_LISTEN_HOST=0.0.0.0 \
        -e CDK_MINTD_LISTEN_PORT=3338 \
        -e CDK_MINTD_FAKE_WALLET_MIN_DELAY=0 \
        -e CDK_MINTD_FAKE_WALLET_MAX_DELAY=0 \
        -e CDK_MINTD_MNEMONIC='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' \
        cashubtc/mintd:0.13
    
    # Wait for mint to be ready
    log_info "Waiting for mint to be ready..."
    MAX_ATTEMPTS=30
    ATTEMPT=0
    
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        if curl -f -s "${mint_url}/v1/info" > /dev/null 2>&1; then
            log_info "Mint is ready!"
            return 0
        fi
        
        ATTEMPT=$((ATTEMPT + 1))
        if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
            log_error "Mint failed to start after $MAX_ATTEMPTS attempts"
            log_info "Container logs:"
            docker logs "$container_name"
            return 1
        fi
        
        sleep 1
    done
}

# Stop and remove a mint container
stop_mint_container() {
    local package_name=$1
    local container_name="cdk-mint-${package_name}"
    
    log_info "Stopping mint container for $package_name..."
    docker stop "$container_name" 2>/dev/null || true
    docker rm "$container_name" 2>/dev/null || true
}

# Run a specific integration test
run_test() {
    local package_name=$1
    local port=$2
    local test_pattern="${3:-}"
    local log_level="${4:-}"
    local test_file
    local mint_url="http://localhost:${port}"
    
    # Find the test file for this package
    test_file=$(discover_integration_tests | grep "^${package_name}|" | cut -d'|' -f2)
    
    if [ -z "$test_file" ]; then
        log_error "No integration test found for package: $package_name"
        echo ""
        list_tests
        return 1
    fi
    
    if [ ! -f "$test_file" ]; then
        log_error "Test file not found: $test_file"
        return 1
    fi
    
    # Start mint container for this test
    if ! start_mint_container "$package_name" "$port"; then
        return 1
    fi
    
    # Extract package directory from test file path
    local package_dir=$(dirname "$test_file" | sed 's|/src/test||')
    
    log_test "Running integration tests for: $package_name"
    if [ -n "$test_pattern" ]; then
        log_test "Filtering tests matching: $test_pattern"
    fi
    if [ -n "$log_level" ]; then
        log_test "Log level: $log_level"
    fi
    cd "$package_dir"
    
    # Run the test
    local test_result=0
    
    # Check if this is a browser test package
    if is_browser_test_package "$package_dir"; then
        log_test "Using browser test runner (Vitest + Playwright)"
        
        # Set environment variables for Vitest (uses VITE_ prefix)
        export VITE_MINT_URL="$mint_url"
        if [ -n "$log_level" ]; then
            export VITE_TEST_LOG_LEVEL="$log_level"
        else
            unset VITE_TEST_LOG_LEVEL
        fi
        
        if [ -n "$test_pattern" ]; then
            bun run test:browser -- --testNamePattern="$test_pattern" || test_result=$?
        else
            bun run test:browser || test_result=$?
        fi
        
        unset VITE_MINT_URL
        unset VITE_TEST_LOG_LEVEL
    else
        # Standard npm test for non-browser packages (uses vitest or bun:test)
        export MINT_URL="$mint_url"
        if [ -n "$log_level" ]; then
            export TEST_LOG_LEVEL="$log_level"
        else
            unset TEST_LOG_LEVEL
        fi
        
        if [ -n "$test_pattern" ]; then
            bun run test -- -t "$test_pattern" "$test_file" || test_result=$?
        else
            bun run test -- "$test_file" || test_result=$?
        fi
        
        unset MINT_URL
        unset TEST_LOG_LEVEL
    fi
    
    # Stop the mint container
    stop_mint_container "$package_name"
    
    return $test_result
}

# Run all integration tests
run_all_tests() {
    local test_pattern="${1:-}"
    local log_level="${2:-}"
    local tests
    tests=$(discover_integration_tests)
    
    if [ -z "$tests" ]; then
        log_error "No integration tests found"
        exit 1
    fi
    
    local failed=0
    local total=0
    local temp_file
    local port=$BASE_PORT
    
    # Create temp file to store results (avoids subshell variable issues)
    temp_file=$(mktemp)
    echo "$tests" > "$temp_file"
    
    while IFS='|' read -r package test_file; do
        [ -z "$package" ] && continue
        total=$((total + 1))
        log_test "Running integration tests for: $package (port $port)"
        if [ -n "$test_pattern" ]; then
            log_test "Filtering tests matching: $test_pattern"
        fi
        if [ -n "$log_level" ]; then
            log_test "Log level: $log_level"
        fi
        if run_test "$package" "$port" "$test_pattern" "$log_level"; then
            log_info "✓ $package tests passed"
        else
            log_error "✗ $package tests failed"
            failed=$((failed + 1))
        fi
        port=$((port + 1))
        echo ""
    done < "$temp_file"
    
    rm -f "$temp_file"
    
    if [ $failed -eq 0 ]; then
        log_info "All tests completed successfully!"
        return 0
    else
        log_error "$failed out of $total test suites failed"
        return 1
    fi
}

# Cleanup function - stop all mint containers
cleanup() {
    log_info "Cleaning up mint containers..."
    cd "$PROJECT_ROOT"
    # Stop all containers matching the pattern
    local containers
    containers=$(docker ps -a --filter "name=cdk-mint-" --format "{{.Names}}" 2>/dev/null || true)
    if [ -n "$containers" ]; then
        echo "$containers" | while read -r container; do
            [ -n "$container" ] && docker stop "$container" 2>/dev/null || true
            [ -n "$container" ] && docker rm "$container" 2>/dev/null || true
        done
    fi
    # Also clean up old compose-based container if it exists
    docker stop cdk-mint 2>/dev/null || true
    docker rm cdk-mint 2>/dev/null || true
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Check if docker and curl are available
if ! command -v docker &> /dev/null; then
    log_error "Docker is not installed or not in PATH"
    exit 1
fi

if ! command -v curl &> /dev/null; then
    log_error "curl is not installed or not in PATH"
    exit 1
fi

# Parse command line arguments
COMMAND="all"
TEST_PATTERN=""
LOG_LEVEL=""

# Parse flags and positional arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--test-name-pattern)
            TEST_PATTERN="$2"
            shift 2
            ;;
        -t=*|--test-name-pattern=*)
            TEST_PATTERN="${1#*=}"
            shift
            ;;
        -l|--log-level)
            LOG_LEVEL="$2"
            shift 2
            ;;
        -l=*|--log-level=*)
            LOG_LEVEL="${1#*=}"
            shift
            ;;
        list|--list)
            list_tests
            exit 0
            ;;
        help|--help|-h)
            echo "Usage: $0 [package-name|all|list] [-t PATTERN] [-l LEVEL]"
            echo ""
            echo "Options:"
            echo "  package-name              Run integration tests for a specific package (e.g., expo-sqlite, sqlite3)"
            echo "  all                       Run all integration tests (default)"
            echo "  list                      List available integration tests"
            echo "  -t, --test-name-pattern   Filter tests by name pattern (e.g., 'should create a melt quote')"
            echo "  -l, --log-level           Set log level: error, warn, info, debug (default: no logging)"
            echo "  help                      Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Run all tests"
            echo "  $0 expo-sqlite                        # Run all expo-sqlite tests"
            echo "  $0 expo-sqlite -t 'melt quote'        # Run expo-sqlite tests matching 'melt quote'"
            echo "  $0 all -t 'should create'            # Run all tests matching 'should create'"
            echo "  $0 expo-sqlite -l debug               # Run expo-sqlite tests with debug logging"
            echo "  $0 all -l info -t 'melt'             # Run all 'melt' tests with info logging"
            echo ""
            exit 0
            ;;
        all)
            COMMAND="all"
            shift
            ;;
        *)
            # Treat as package name
            COMMAND="$1"
            shift
            ;;
    esac
done

# Validate log level if provided
if [ -n "$LOG_LEVEL" ]; then
    case "$LOG_LEVEL" in
        error|warn|info|debug)
            ;;
        *)
            log_error "Invalid log level: $LOG_LEVEL"
            log_error "Valid levels are: error, warn, info, debug"
            exit 1
            ;;
    esac
fi

log_info "Building packages..."
cd "$PROJECT_ROOT/packages/adapter-tests"
bun run build

cd "$PROJECT_ROOT/packages/core"
bun run build

# Check if any browser tests will be run and install Playwright if needed
check_and_install_playwright() {
    local needs_playwright=false
    
    if [ "$COMMAND" = "all" ]; then
        # Check all packages for browser tests
        discover_integration_tests | while IFS='|' read -r package test_file; do
            [ -z "$package" ] && continue
            local pkg_dir=$(dirname "$test_file" | sed 's|/src/test||')
            if is_browser_test_package "$pkg_dir"; then
                echo "true"
                return
            fi
        done
    else
        # Check specific package
        local test_file_path
        test_file_path=$(discover_integration_tests | grep "^${COMMAND}|" | cut -d'|' -f2)
        if [ -n "$test_file_path" ]; then
            local pkg_dir=$(dirname "$test_file_path" | sed 's|/src/test||')
            if is_browser_test_package "$pkg_dir"; then
                echo "true"
                return
            fi
        fi
    fi
    echo "false"
}

if [ "$(check_and_install_playwright)" = "true" ]; then
    if ! ensure_playwright_browsers; then
        log_error "Failed to install Playwright browsers"
        exit 1
    fi
fi

# Run tests based on command
if [ "$COMMAND" = "all" ]; then
    if ! run_all_tests "$TEST_PATTERN" "$LOG_LEVEL"; then
        exit 1
    fi
else
    if ! run_test "$COMMAND" "$BASE_PORT" "$TEST_PATTERN" "$LOG_LEVEL"; then
        exit 1
    fi
fi

log_info "All tests completed successfully!"
