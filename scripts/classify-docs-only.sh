#!/usr/bin/env bash

set -u

event=${1:-}
base=${2:-}
head=${3:-}
zero_sha=0000000000000000000000000000000000000000

is_docs_path() {
  case "$1" in
    *.md | docs/*) return 0 ;;
    *) return 1 ;;
  esac
}

diff_range=

case "$event" in
  pull_request)
    if [[ -z "$base" || -z "$head" ]]; then
      echo false
      exit 0
    fi

    merge_base=$(git merge-base "$base" "$head" 2>/dev/null) || {
      echo false
      exit 0
    }
    diff_range="$merge_base..$head"
    ;;
  push)
    if [[ -z "$base" || -z "$head" || "$base" == "$zero_sha" ]]; then
      echo false
      exit 0
    fi

    git merge-base --is-ancestor "$base" "$head" 2>/dev/null || {
      echo false
      exit 0
    }
    diff_range="$base..$head"
    ;;
  *)
    echo false
    exit 0
    ;;
esac

diff_file=$(mktemp "${TMPDIR:-/tmp}/duplexd-docs-diff.XXXXXX") || {
  echo false
  exit 0
}
trap 'rm -f -- "$diff_file"' EXIT

git diff --name-status -z --find-renames --diff-filter=ACDMRT "$diff_range" >"$diff_file" 2>/dev/null || {
  echo false
  exit 0
}

docs_only=true
found_path=false
parse_error=false

while IFS= read -r -d '' status; do
  case "$status" in
    R* | C*)
      IFS= read -r -d '' source_path || {
        parse_error=true
        break
      }
      IFS= read -r -d '' destination_path || {
        parse_error=true
        break
      }

      for path in "$source_path" "$destination_path"; do
        found_path=true
        if ! is_docs_path "$path"; then
          docs_only=false
        fi
      done
      ;;
    *)
      IFS= read -r -d '' path || {
        parse_error=true
        break
      }
      found_path=true
      if ! is_docs_path "$path"; then
        docs_only=false
      fi
      ;;
  esac
done <"$diff_file"

if [[ "$parse_error" == true || "$found_path" == false ]]; then
  echo false
else
  echo "$docs_only"
fi
