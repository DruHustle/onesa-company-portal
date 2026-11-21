#!/usr/bin/env bash
set -euo pipefail
# Run after editing onesa-portal-frontend. Use Git tree objects, not copied bytes.
cd "$(git rev-parse --show-toplevel)"
source_dir=onesa-portal-frontend
root_dir=onesa-company-portal-frontend
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo 'Refusing to rewrite the Git index from CI' >&2; exit 1
fi
if [[ ! -d "$source_dir" || -L "$source_dir" || ! -d "$root_dir" || -L "$root_dir" ]]; then
  echo 'Expected two real, local frontend directories; no changes made' >&2; exit 1
fi
if [[ -n "$(git status --porcelain -- "$root_dir")" ||
      -n "$(git ls-files --others --exclude-standard -- "$root_dir")" ]]; then
  echo 'Compatibility root has local changes; review before synchronizing' >&2; exit 1
fi
# Stage ONLY the canonical frontend path. Review staged changes before commit.
git add -A -- "$source_dir"
staged_tree=$(git write-tree)
source_tree=$(git rev-parse "$staged_tree:$source_dir")
if [[ $(git cat-file -t "$source_tree") != tree ]]; then
  echo 'Canonical frontend must resolve to a Git tree' >&2; exit 1
fi
# Remove only tracked compatibility files; install the same Git tree under
# Vercel Root Directory. No redundant source blobs are created.
git rm -r -q -- "$root_dir"
git read-tree --prefix="$root_dir/" -u "$source_tree"
verified_tree=$(git write-tree)
if [[ $(git rev-parse "$verified_tree:$root_dir") != "$source_tree" ]]; then
  echo 'Mirror mismatch after staging; do not commit' >&2; exit 1
fi
echo 'Vercel compatibility root staged with identical Git tree.'
echo 'Review with: git diff --cached --stat'
echo 'Commit BOTH frontend paths together; the PR check verifies their parity.'
