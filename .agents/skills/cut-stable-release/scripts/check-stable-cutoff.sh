#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${3:-$(pwd)}"
cd "$ROOT_DIR"

cutoff_ref="${1:?Usage: check-stable-cutoff.sh <cutoff-ref> [candidate-ref] [root-dir]}"
candidate_ref="${2:-}"

cutoff_commit="$(git rev-parse --verify "$cutoff_ref^{commit}")"

if [[ -n "$candidate_ref" ]]; then
  candidate_commit="$(git rev-parse --verify "$candidate_ref^{commit}")"
  read -r -a candidate_line <<<"$(git rev-list --parents -n 1 "$candidate_commit")"

  if [[ "${#candidate_line[@]}" -ne 2 || "${candidate_line[1]}" != "$cutoff_commit" ]]; then
    echo "Stable candidate must be one commit directly after cutoff $cutoff_commit" >&2
    exit 1
  fi

  diff_args=("$cutoff_commit" "$candidate_commit")
else
  if [[ "$(git rev-parse HEAD)" != "$cutoff_commit" ]]; then
    echo "HEAD must remain at cutoff $cutoff_commit before the stable commit" >&2
    exit 1
  fi

  diff_args=("$cutoff_commit")
fi

mapfile -d '' changed_files < <(git diff --name-only -z "${diff_args[@]}" --)

if [[ "${#changed_files[@]}" -eq 0 ]]; then
  echo "Stable candidate has no release metadata changes" >&2
  exit 1
fi

unexpected_files=()
for file in "${changed_files[@]}"; do
  case "$file" in
    .changeset/* | packages/*/package.json | packages/*/CHANGELOG.md) ;;
    *) unexpected_files+=("$file") ;;
  esac
done

if [[ "${#unexpected_files[@]}" -gt 0 ]]; then
  echo "Stable candidate changes files outside the RC cutoff:" >&2
  printf '  %s\n' "${unexpected_files[@]}" >&2
  exit 1
fi

printf 'Verified stable candidate changes only release metadata after cutoff %s\n' \
  "$cutoff_commit"
