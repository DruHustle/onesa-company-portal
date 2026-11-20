# Backend minimatch compatibility entry point

This independent development-only adapter exports the unchanged `minimatch`
function from pinned upstream minimatch 11.0.1. Its attached `Minimatch`
constructor preserves the callable CommonJS interface required by the three
reviewed ESLint consumers in `UPSTREAM.json`. TypeScript ESTree receives the
upstream named exports directly through a separate scoped override.

The upstream implementation is an ordinary registry dependency with lockfile
integrity, not a vendored fork. `UPSTREAM_LICENSE.md` preserves its Blue Oak
license. The adapter does not modify patterns, results or upstream matching
logic, and it adds no application runtime dependency.

Rebuild the package from this directory with `npm pack --ignore-scripts
--pack-destination ../../vendor`, then run the backend dependency-security
suite and a clean locked install. Changing a consumer or upstream version
requires compatibility and provenance review.
