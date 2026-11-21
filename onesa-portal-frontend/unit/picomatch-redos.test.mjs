import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);

test("locally patched picomatch rejects the ReDoS extglobs and retains normal globs", () => {
  const matcher = require("picomatch");
  const installed = require("picomatch/package.json");
  assert.equal(installed.name, "@onesa/picomatch");
  assert.equal(installed.version, "4.0.8-onesa.1");
  for (const pattern of ["+(*)", "+(*a)", "+(a*)", "*(a*|b)", "+(ab|abab)"]) {
    assert.equal(matcher.makeRe(pattern).test("a".repeat(150) + "!"), false, pattern);
    assert.equal(matcher.isMatch("a".repeat(150) + "!", pattern), false, pattern);
    assert.equal(matcher.isMatch(pattern, pattern), true, "risky pattern must be literal: " + pattern);
  }
  assert.equal(matcher.isMatch("src/.private/notes.ts", "src/**/*.ts", { dot: true }), true);
  assert.equal(matcher.isMatch("src/a.js", "src/**/*.ts", { dot: true }), false);
  assert.equal(matcher.isMatch("file.tsx", "*.{ts,tsx}"), true);
  assert.equal(matcher.isMatch("fff", "*(f)"), true);
});
