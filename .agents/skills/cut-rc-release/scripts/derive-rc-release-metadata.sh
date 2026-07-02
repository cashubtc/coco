#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(pwd)}"
cd "$ROOT_DIR"

package_files=(
  "packages/core/package.json"
  "packages/indexeddb/package.json"
  "packages/expo-sqlite/package.json"
  "packages/sqlite3/package.json"
  "packages/sqlite-bun/package.json"
  "packages/adapter-tests/package.json"
  "packages/react/package.json"
)

versions=()
for file in "${package_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing package manifest: $file" >&2
    exit 1
  fi

  version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1)"
  if [[ -z "$version" ]]; then
    echo "Could not read version from $file" >&2
    exit 1
  fi
  versions+=("$version")
done

unique_versions="$(printf '%s\n' "${versions[@]}" | sort -u)"
unique_count="$(printf '%s\n' "$unique_versions" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$unique_count" != "1" ]]; then
  echo "Fixed release group does not share one version:" >&2
  printf '%s\n' "$unique_versions" >&2
  exit 1
fi

new_package_version="$unique_versions"
if [[ ! "$new_package_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-rc\.([0-9]+)$ ]]; then
  echo "Expected package version X.Y.Z-rc.N, got $new_package_version" >&2
  exit 1
fi

base_version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
new_release_tag="v${new_package_version}"
release_branch="release/${base_version}-rc"
commit_message="version: release ${new_package_version}"

for file in "${package_files[@]}"; do
  changelog="${file%package.json}CHANGELOG.md"
  if [[ ! -f "$changelog" ]]; then
    echo "Missing changelog: $changelog" >&2
    exit 1
  fi

  latest_heading="$(sed -n 's/^##[[:space:]]*\(.*\)$/\1/p' "$changelog" | head -n 1)"
  if [[ "$latest_heading" != "$new_package_version" ]]; then
    echo "$changelog latest heading is $latest_heading, expected $new_package_version" >&2
    exit 1
  fi
done

if [[ ! -f .changeset/pre.json ]]; then
  echo "Missing .changeset/pre.json for RC release" >&2
  exit 1
fi

printf 'NEW_PACKAGE_VERSION=%q\n' "$new_package_version"
printf 'NEW_RELEASE_TAG=%q\n' "$new_release_tag"
printf 'RELEASE_BRANCH=%q\n' "$release_branch"
printf 'COMMIT_MESSAGE=%q\n' "$commit_message"
