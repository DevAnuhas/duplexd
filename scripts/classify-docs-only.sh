#!/usr/bin/env bash

set -u

event=${1:-}
base=${2:-}
head=${3:-}
zero_sha=0000000000000000000000000000000000000000

classify_paths() {
  local paths=$1

  [[ -n "$paths" ]] || return 1

  while IFS= read -r path; do
    case "$path" in
      *.md | docs/*) ;;
      *) return 1 ;;
    esac
  done <<<"$paths"
}

changed_paths=

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
    changed_paths=$(git diff --name-only --diff-filter=ACMRT "$merge_base..$head" 2>/dev/null) || {
      echo false
      exit 0
    }
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
    changed_paths=$(git diff --name-only --diff-filter=ACMRT "$base..$head" 2>/dev/null) || {
      echo false
      exit 0
    }
    ;;
  *)
    echo false
    exit 0
    ;;
esac

if classify_paths "$changed_paths"; then
  echo true
else
  echo false
fi
