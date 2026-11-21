# Onesa local picomatch ReDoS hotfix candidate

Source: upstream picomatch v4.0.7, https://github.com/micromatch/picomatch/tree/4.0.7
Patch: independently unmerged upstream proposal https://github.com/micromatch/picomatch/pull/235
Advisory: GHSA-fc5q-39xc-vjpf (CVE-2026-112366)
This is **not** an official upstream picomatch 4.0.8 release. Local label: 4.0.8-onesa.1.

This candidate conservatively literalizes repeated extglobs that contain glob * wildcards, and detects repeating multi-character prefix overlap. This is deliberately a compatibility tradeoff for high-risk patterns, not a blanket npm-audit waiver. It must pass exact-source CI, native ESLint and glob semantics checks, ReDoS regression tests, lockfile integrity and release review before adoption. An official upstream patch should replace the fork after an independent compatibility/security qualification. Preserve MIT license and original author notices.

## Package-identity separation
This reviewed patched source is distributed as a distinct scoped fork (`@onesa/picomatch`) and replaces the unpatched upstream `picomatch` dependency via a file-backed npm override. The alias `node_modules/picomatch` must still load these exact bytes for every consumer. It is not an official upstream fix, nor does a zero-advisory registry result by itself prove this fork safe: its code and adversarial regression tests remain mandatory. Vendor code and upstream license remain readable; do not change package identity without requalification.
