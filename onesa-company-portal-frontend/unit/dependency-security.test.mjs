import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const frontend = fileURLToPath(new URL("..", import.meta.url));
const source = join(frontend, "security/minimatch-callable");
const upstream = JSON.parse(await readFile(join(source, "UPSTREAM.json"), "utf8"));
const lock = JSON.parse(await readFile(join(frontend, "package-lock.json"), "utf8"));
const callableConsumers = Object.entries(upstream.callable_consumers);
const fromConsumer = (name) => createRequire(join(frontend, "node_modules", name, "package.json"));
const lockPath = (packageFile) => relative(frontend, dirname(packageFile)).replaceAll("\\", "/");

test("pinned legacy consumers execute the intact fixed upstream through the independent adapter", async () => {
  const archive = await readFile(join(frontend, "vendor/onesa-portal-minimatch-callable-1.0.0.tgz"));
  const archiveIntegrity = "sha512-" + createHash("sha512").update(archive).digest("base64");
  for (const [name, version] of callableConsumers) {
    const consumer = fromConsumer(name);
    assert.equal(consumer("./package.json").version, version, name + " requires compatibility review");
    const adapterFile = consumer.resolve("minimatch/package.json");
    assert.equal(consumer("minimatch/package.json").name, "@onesa/portal-minimatch-callable");
    assert.deepEqual(JSON.parse(await readFile(adapterFile, "utf8")),
      JSON.parse(await readFile(join(source, "package.json"), "utf8")));
    const adapterRequire = createRequire(adapterFile);
    const fixed = adapterRequire("minimatch-fixed");
    const fixedFile = adapterRequire.resolve("minimatch-fixed/package.json");
    assert.equal(adapterRequire("minimatch-fixed/package.json").version, "11.0.1");
    assert.equal(consumer("minimatch"), fixed.minimatch);
    assert.equal(consumer("minimatch").Minimatch, fixed.Minimatch);
    assert.equal(lock.packages[lockPath(adapterFile)].integrity, archiveIntegrity);
    assert.equal(lock.packages[lockPath(fixedFile)].integrity, upstream.integrity);
    for (const file of ["index.cjs", "README.md", "UPSTREAM.json", "UPSTREAM_LICENSE.md"]) {
      assert.deepEqual(await readFile(join(dirname(adapterFile), file)), await readFile(join(source, file)));
    }
    assert.deepEqual(await readFile(join(source, "UPSTREAM_LICENSE.md")), await readFile(join(dirname(fixedFile), "LICENSE.md")));
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.endsWith("/minimatch") || path.endsWith("/minimatch-fixed")) {
      assert.ok(entry.name === "@onesa/portal-minimatch-callable" || entry.version === "11.0.1",
        "Unreviewed matcher implementation at " + path);
    }
  }
});

test("legacy consumers retain dot, brace, basename, negated and partial directory matching", () => {
  for (const [name] of callableConsumers) {
    const matcher = fromConsumer(name)("minimatch");
    assert.equal(matcher("contracts/openapi.json", "contracts/*.json"), true);
    assert.equal(matcher("private/record.json", "contracts/*.json"), false);
    const files = new matcher.Minimatch("src/**/*.{ts,tsx}", { dot: true });
    assert.equal(files.match("src", true), true);
    assert.equal(files.match("src/nested", true), true);
    assert.equal(files.match("src/nested/page.tsx"), true);
    assert.equal(files.match("src/.private/file.ts"), true);
    assert.equal(files.match("src/nested/file.js"), false);
    assert.equal(files.match("outside", true), false);
    assert.equal(new matcher.Minimatch("*.ts", { dot: true, matchBase: true }).match("src/nested/a.ts"), true);
    assert.equal(new matcher.Minimatch("!src/*.test.ts", { dot: true, flipNegate: true }).match("src/a.test.ts"), true);
    assert.equal(new matcher.Minimatch("src/*.ts", { dot: true, allowWindowsEscape: true }).match("src/a.ts"), true);
  }
});

test("actual ESLint includes nested and dot files, preserves ignores and reports real fixture errors", async () => {
  const { ESLint } = require("eslint");
  const cwd = await mkdtemp(join(tmpdir(), "onesa-portal-matcher-"));
  try {
    const files = {
      "src/ok.js": "const value = 1;\n",
      "src/nested/check.js": "unknownFixtureName();\n",
      "src/.hidden.js": "hiddenFixtureName();\n",
      "dist/ignored.js": "ignoredDistName();\n",
      ".next/ignored.js": "ignoredNextName();\n",
    };
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), contents);
    }
    const eslint = new ESLint({
      cwd, cache: false, fix: false, overrideConfigFile: true,
      overrideConfig: [
        { ignores: ["dist/**", ".next/**"] },
        { files: ["**/*.js"], rules: { "no-undef": "error" }, languageOptions: { ecmaVersion: 2022 } },
      ],
    });
    const results = await eslint.lintFiles(["."]);
    assert.deepEqual(results.map((result) => relative(cwd, result.filePath).replaceAll("\\", "/")).sort(),
      ["src/.hidden.js", "src/nested/check.js", "src/ok.js"]);
    assert.equal(results.reduce((sum, result) => sum + result.errorCount, 0), 2);
    assert.ok(results.flatMap((result) => result.messages).every((message) => message.ruleId === "no-undef"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("actual Redocly URL matching keeps synthetic headers inside their configured allowlist", async () => {
  const consumer = fromConsumer("@redocly/openapi-core");
  const { readFileFromUrl } = consumer("./lib/utils.js");
  const requests = [];
  const config = {
    headers: [
      { matches: "example.invalid/api/**", name: "x-contract-fixture", value: "synthetic-only" },
      { matches: "different.invalid/**", name: "x-unrelated-fixture", value: "must-not-forward" },
    ],
    customFetch: async (url, options) => {
      requests.push({ url, headers: options.headers });
      return { ok: true, text: async () => '{"openapi":"3.1.0"}', headers: new Map([["content-type", "application/json"]]) };
    },
  };
  await readFileFromUrl("https://example.invalid/api/schema.json", config);
  await readFileFromUrl("https://example.invalid/unrelated/schema.json", config);
  await readFileFromUrl("https://third.invalid/api/schema.json", config);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].headers, { "x-contract-fixture": "synthetic-only" });
  assert.deepEqual(requests[1].headers, {});
  assert.deepEqual(requests[2].headers, {});
});

test("TypeScript ESTree receives native fixed named exports, separate from the callable adapter", async () => {
  const consumer = fromConsumer("@typescript-eslint/typescript-estree");
  assert.equal(consumer("./package.json").version, "8.71.1");
  const packageFile = consumer.resolve("minimatch/package.json");
  assert.equal(consumer("minimatch/package.json").name, "minimatch");
  assert.equal(consumer("minimatch/package.json").version, "11.0.1");
  assert.equal(lock.packages[lockPath(packageFile)].integrity, upstream.integrity);
  const native = consumer("minimatch");
  assert.equal(typeof native, "object");
  assert.equal(typeof native.minimatch, "function");
  assert.equal(native.minimatch(".config.ts", "*.ts", { dot: true }), true);
  assert.equal(native.minimatch("unrelated.js", "*.ts", { dot: true }), false);
  assert.deepEqual(await readFile(join(dirname(packageFile), "LICENSE.md")), await readFile(join(source, "UPSTREAM_LICENSE.md")));
});

test("both installed export shapes bound adversarial preprocessing in an isolated process", () => {
  const program = [
    "const {createRequire}=require('node:module');",
    "const {join}=require('node:path');",
    "const native=createRequire(join(process.cwd(),'node_modules/@typescript-eslint/typescript-estree/package.json'))('minimatch').minimatch;",
    "for(const matcher of [require('minimatch'),native])for(let i=1;i<=40;i++)matcher('safe/path','a/'+('**/../'.repeat(i))+'*.json',{optimizationLevel:2});",
  ].join("");
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", program], {
    cwd: frontend, timeout: 2000, maxBuffer: 64 * 1024, encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
