# Portal development-tool minimatch adapter

This independent private package exposes the callable function from exactly
minimatch 11.0.1, including its upstream Minimatch constructor. Only the four
versions named in UPSTREAM.json receive the adapter. Their inspected call sites
use the callable matcher or Minimatch.match, including partial directory matches.
The TypeScript ESTree consumer instead requires the native named export and
receives minimatch 11.0.1 directly through its own version-scoped override.

No legacy matcher implementation is included or modified. This is not a general
replacement for the legacy API: upstream 11 removes makeRe and matchOne and
changes internal set elements. The pinned consumers do not use those APIs.
Consumer upgrades must be reviewed with fresh installed-resolution and behavior
tests; no global minimatch override is permitted by this package's design.

The fixed upstream addresses GHSA-g3hv-75wg-m249 without disabling advisory
checks. The minimatch-fixed npm alias avoids resolving the adapter recursively.
UPSTREAM.json, UPSTREAM_LICENSE.md and the lockfile preserve the official source,
registry integrity and Blue Oak license. No license is assigned to Onesa code.
All adapter files and its archive are inside the frontend build context; no
sibling repository or runtime package is needed. These are development tools.

Regenerate with npm pack --ignore-scripts --pack-destination ../../vendor from
this directory. Regenerate the frontend lockfile and run a clean npm ci, then
npm run test:dependency-security, contract generation/comparison, lint, typecheck,
build and both full and production dependency audits. The consumer tests check
installed identities and bytes, actual ESLint enumeration and ignored paths,
Redocly header matching, native named exports and bounded adversarial preprocessing.
Remove the adapter when each pinned consumer supports fixed upstream exports.
