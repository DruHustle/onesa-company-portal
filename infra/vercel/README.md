# Onesa Portal — Vercel Root Directory contract

The project `onesa-company-portal` (team `druhustles-projects`, ID
`prj_91TBAfa7ByYzG6Q022gTbzI6iR2m`) must retain the **fixed Vercel Root Directory**
`onesa-company-portal-frontend`. Vercel uses this path on every linked
Git commit and cannot dynamically select a different path per branch.

## Branch transition

- `main` and `staging` currently have the original real directory
  `onesa-company-portal-frontend`.
- `dev` has the renamed canonical source `onesa-portal-frontend` **and** a
  second **real Git tree** under `onesa-company-portal-frontend` with
  byte-identical tracked files. Both paths have the same Git tree SHA.
- A symbolic link is not an acceptable Vercel Root Directory. The real
  Git-tree mirror was successfully built in a Vercel preview on 2026-11-21.

Until the directory migration is complete across `main` and `staging`,
keep both tracked paths synchronized on `dev` and its PR branches:

```bash
# After editing the canonical dev frontend:
bash scripts/sync-portal-vercel-root.sh
node --test scripts/test-portal-vercel-root.mjs
node scripts/check-portal-vercel-root.mjs
git diff --cached --stat
# Review and commit both directory changes together.
```

The synchronization script stages the canonical frontend and constructs
the mirror from **the same Git tree object**, not a second collection of
independently edited files. It refuses CI writes and dirty alias trees.

Every PR targeting `main`, `staging`, or `dev` runs the separate
`Portal Vercel root contract` workflow. It rejects missing roots,
symbolic links, non-Next.js project layouts, and mismatched Git tree
hashes before a PR can be considered release-qualified. The GitHub
workflow cannot inspect privately scoped Vercel settings without a
dedicated scoped API credential; the deployed project setting must
also remain `onesa-company-portal-frontend`.

**Removal plan:** only remove the compatibility tree when all supported
branches have one canonical directory, live Vercel has been updated to
that directory, and an exact-SHA preview has passed. Until then,
do not change the Vercel Root Directory as part of an unrelated PR.
