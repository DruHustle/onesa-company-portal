# Onesa Portal — Vercel Root Directory contract

The Vercel project `onesa-company-portal` (team `druhustles-projects`, ID
`prj_91TBAfa7ByYzG6Q022gTbzI6iR2m`) uses the **fixed Root Directory**
`onesa-company-portal-frontend`. Vercel applies one project setting to
commits from all branches; it does not select a directory per branch.

## No missing-root / stale-preview invariant

Every supported branch — `main`, `staging`, and `dev` — must contain BOTH
real Git directories: `onesa-company-portal-frontend` and
`onesa-portal-frontend`. Their Git tree SHAs must be **identical**.
This protects against missing-root failures if the project root is
accidentally changed between either known name, and detects stale
frontend mirrors before merge.

- `main` and `staging`: edit `onesa-company-portal-frontend` (legacy source),
  mirror it into `onesa-portal-frontend`.
- `dev`: edit `onesa-portal-frontend` (current canonical source),
  mirror it into `onesa-company-portal-frontend`.
- Git shares the exact same blob/tree objects across both directory names;
  it does not duplicate stored source file contents.
- A symbolic link is **not** a valid Vercel Root Directory; actual
  Vercel preview builds confirmed the real-tree approach succeeds.

After editing the authoritative frontend, review and `git add` **only intended source files** first; the helper never stages new source files automatically. Then run the synchronizer for your branch:

```bash
# Main / staging source:
bash scripts/sync-portal-vercel-root.sh onesa-company-portal-frontend
# OR dev source:
bash scripts/sync-portal-vercel-root.sh onesa-portal-frontend

node --test scripts/test-portal-vercel-root.mjs
node scripts/check-portal-vercel-root.mjs
git diff --cached --stat
# Review, then commit BOTH frontend paths together.
```

The script uses only the explicitly staged source path, reconstructs
the other directory from its already-staged Git tree, and refuses CI
writes or local changes to the mirror. The CI check refuses missing
directories, symlink roots, absent Next.js build files, and unequal
subtree SHAs on EVERY branch.

`.github/workflows/portal-vercel-root.yml` runs on every push and PR
targeting `main`, `staging`, or `dev`. It needs no external credentials.
The Vercel project setting itself should remain
`onesa-company-portal-frontend`; GitHub CI cannot read that private
setting without a scoped Vercel API credential.

**Migration cleanup:** remove the second real tree only after all
supported branches have one canonical frontend directory, the live
project is configured for that directory, and an exact-SHA preview
has passed. Never change the Vercel Root Directory in an unrelated PR.
