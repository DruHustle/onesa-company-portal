#!/usr/bin/env bash
set -euo pipefail
# Refresh the other real frontend root from the authoritative branch source.
# This uses the same Git tree SHA, not copied or duplicated source blobs.
if [[ $# -ne 1 ]]; then
  echo 'Usage: bash scripts/sync-portal-vercel-root.sh onesa-portal-frontend|onesa-company-portal-frontend' >&2; exit 2
fi
case "$1" in
  onesa-portal-frontend) source_dir=onesa-portal-frontend; root_dir=onesa-company-portal-frontend ;;
  onesa-company-portal-frontend) source_dir=onesa-company-portal-frontend; root_dir=onesa-portal-frontend ;;
  *) echo 'Source must be one of the two reviewed frontend roots' >&2; exit 2 ;;
esac
cd "$(git rev-parse --show-toplevel)"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo 'Refusing to rewrite the Git index from CI' >&2; exit 1
fi
if [[ ! -d "$source_dir" || -L "$source_dir" || ! -d "$root_dir" || -L "$root_dir" ]]; then
  echo 'Expected two real, local frontend directories; no changes made' >&2; exit 1
fi
if [[ -n "$(git status --porcelain -- "$root_dir")" ||
      -n "$(git ls-files --others --exclude-standard -- "$root_dir")" ]]; then
  echo 'Mirror root has local changes; review before synchronizing' >&2; exit 1
fi
# Never stage source files automatically: an unreviewed .env or other local
# file must not enter Git history through this helper. Stage intended source
# changes explicitly before running it.
if [[ -n "$(git diff --name-only -- "$source_dir")" ||
      -n "$(git ls-files --others --exclude-standard -- "$source_dir")" ]]; then
  echo 'Review and git add intended source files before running the sync helper' >&2; exit 1
fi
staged_tree=$(git write-tree)
source_tree=$(git rev-parse "$staged_tree:$source_dir")
if [[ $(git cat-file -t "$source_tree") != tree ]]; then
  echo 'Source frontend must resolve to a Git tree' >&2; exit 1
fi
git rm -r -q -- "$root_dir"
git read-tree --prefix="$root_dir/" -u "$source_tree"
verified_tree=$(git write-tree)
if [[ $(git rev-parse "$verified_tree:$root_dir") != "$source_tree" ]]; then
  echo 'Mirror mismatch after staging; do not commit' >&2; exit 1
fi
echo 'Both frontend directories now stage the exact same Git tree.'
echo 'Review with: git diff --cached --stat'
echo 'Commit both directory changes together; the PR check verifies parity.'
