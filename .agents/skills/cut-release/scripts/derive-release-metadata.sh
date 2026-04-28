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

  version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)",/\1/p' "$file" | head -n 1)"
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
last_tag="$(git describe --tags --abbrev=0)"
last_tag_type="$(git cat-file -t "refs/tags/$last_tag" 2>/dev/null || echo commit)"
last_tag_signed=false
if [[ "$last_tag_type" == "tag" ]] && \
  grep -q -- 'BEGIN .* SIGNATURE' < <(git cat-file -p "refs/tags/$last_tag"); then
  last_tag_signed=true
fi

if [[ "$new_package_version" =~ ^([0-9]+)\.0\.0-rc\.([0-9]+)$ ]]; then
  new_major="${BASH_REMATCH[1]}"
  new_rc="${BASH_REMATCH[2]}"
else
  echo "Unsupported package version format: $new_package_version" >&2
  exit 1
fi

if [[ "$last_tag" =~ ^stable-v([0-9]+)\.RC([0-9]+)$ ]]; then
  last_major="${BASH_REMATCH[1]}"
  last_rc="${BASH_REMATCH[2]}"
else
  echo "Unsupported repo tag format: $last_tag" >&2
  exit 1
fi

new_release_tag="stable-v${new_major}.RC${new_rc}"

if (( new_major < last_major )) || \
  (( new_major == last_major && new_rc <= last_rc )); then
  echo "Derived release tag $new_release_tag is not ahead of latest tag $last_tag" >&2
  exit 1
fi

commit_message="version: $new_release_tag"

printf 'LAST_TAG=%q\n' "$last_tag"
printf 'LAST_TAG_TYPE=%q\n' "$last_tag_type"
printf 'LAST_TAG_SIGNED=%q\n' "$last_tag_signed"
printf 'NEW_PACKAGE_VERSION=%q\n' "$new_package_version"
printf 'NEW_RELEASE_TAG=%q\n' "$new_release_tag"
printf 'COMMIT_MESSAGE=%q\n' "$commit_message"
