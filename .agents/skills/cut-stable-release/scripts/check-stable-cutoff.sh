#!/usr/bin/env bash
set -euo pipefail

cutoff_ref="${1:?Usage: check-stable-cutoff.sh <cutoff-ref> [candidate-ref] [root-dir]}"
candidate_ref="${2:-}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validator="$script_dir/../../../../scripts/release-pr.ts"
cd "${3:-$(pwd)}"

exec bun "$validator" cutoff "$cutoff_ref" "$candidate_ref"
