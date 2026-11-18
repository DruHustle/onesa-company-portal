# Onesa local picomatch ReDoS hotfix candidate

Source: upstream picomatch v4.0.7, https://github.com/micromatch/picomatch/tree/4.0.7
Patch: independently unmerged upstream proposal https://github.com/micromatch/picomatch/pull/235
Advisory: GHSA-fc5q-39xc-vjpf (CVE-2026-112366)
This is **not** an official upstream picomatch 4.0.8 release. Local label: 4.0.8-onesa.1.

This candidate conservatively literalizes repeated extglobs that contain glob * wildcards, and detects repeating multi-character prefix overlap. This is deliberately a compatibility tradeoff for high-risk patterns, not a blanket npm-audit waiver. It must pass exact-source CI, native ESLint and glob semantics checks, ReDoS regression tests, lockfile integrity and release review before adoption. An official upstream patch should replace the fork after an independent compatibility/security qualification. Preserve MIT license and original author notices.
