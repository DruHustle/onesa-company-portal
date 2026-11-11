import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clientProducts,
  identityConfiguration,
  type IdentityConfig,
} from "../src/identity/config.js";
import {
  prepareIdentityRelease,
  productionOrigins,
} from "../src/identity/prepare-release.js";

const callbacks = {
  ai: "https://platform.onesa.eu/api/v1/auth/onesa/callback",
  drone: "https://drone.onesa.eu/api/v1/auth/identity/callback",
  robot: "https://robot.onesa.eu/api/v1/auth/identity/callback",
  farmer: "https://farmer.onesa.eu/auth/onesa/callback",
  logistics: "https://logistics.onesa.eu/api/auth/onesa/callback",
  pasofi: "https://pasofi.mobile.onesa.eu/onesa-callback.html",
  mobile: "https://mobile.onesa.eu/api/v1/auth/onesa/callback",
};
function encoded(config: IdentityConfig) {
  return JSON.stringify({
    ONESA_IDENTITY_ENABLED: "true",
    ONESA_IDENTITY_CONFIG_B64: Buffer.from(JSON.stringify(config)).toString(
      "base64",
    ),
  });
}
async function json(path: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path, "utf8"));
}
test("creates private issuer and product inputs and preserves an existing issuer exactly across expansion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "onesa-private-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "initial");
  await prepareIdentityRelease([
    "--environment",
    "production",
    "--initialize",
    "--output",
    output,
  ]);
  const issuerEnv = await json(join(output, "portal-issuer.env.json"));
  const initial = identityConfiguration(issuerEnv, productionOrigins.portal)!;
  assert.equal(initial.issuer, productionOrigins.portal + "/api/v1/identity");
  assert.equal(initial.clients.length, 7);
  const frontend = await json(join(output, "portal-frontend.env.json"));
  assert.deepEqual(Object.keys(frontend), ["ONESA_IDENTITY_CALLBACKS_JSON"]);
  assert.deepEqual(
    JSON.parse(frontend.ONESA_IDENTITY_CALLBACKS_JSON).sort(),
    Object.values(callbacks).sort(),
  );
  const files = await readdir(output);
  assert.equal(files.length, 10);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  for (const file of files)
    assert.equal((await stat(join(output, file))).mode & 0o777, 0o600);
  for (const product of clientProducts) {
    const client = initial.clients.find((c) => c.product === product)!;
    assert.equal(client.redirectUri, callbacks[product]);
    const env = await json(join(output, product + ".env.json"));
    const keys = new Set(Object.keys(env));
    const prefix =
      product === "pasofi"
        ? "PASOFI_ONESA_"
        : product === "mobile"
          ? "ONESA_"
          : "ONESA_IDENTITY_";
    assert.equal(env[prefix + "CLIENT_ID"], client.clientId);
    assert.equal(env[prefix + "ISSUER"], initial.issuer);
    if (product === "pasofi") {
      assert.equal(
        await readFile(join(output, "pasofi_onesa_client_secret"), "utf8"),
        client.clientSecret,
      );
      assert.equal(keys.has(prefix + "CLIENT_SECRET"), false);
    } else assert.equal(env[prefix + "CLIENT_SECRET"], client.clientSecret);
    if (product !== "mobile" && product !== "pasofi")
      assert.equal(env.ONESA_IDENTITY_ENABLED, "true");
    const cb = {
      ai: "ONESA_IDENTITY_CALLBACK_URL",
      drone: "ONESA_IDENTITY_CALLBACK",
      robot: "ONESA_IDENTITY_CALLBACK_URL",
      logistics: "ONESA_IDENTITY_REDIRECT_URI",
      pasofi: "PASOFI_ONESA_REDIRECT_URI",
      mobile: "PUBLIC_ORIGIN",
      farmer: "WEB_ORIGIN",
    }[product];
    assert.equal(
      env[cb],
      product === "mobile" || product === "farmer"
        ? productionOrigins[product]
        : client.redirectUri,
    );
    for (const other of initial.clients.filter((c) => c !== client)) {
      assert.equal(Object.values(env).includes(other.clientSecret), false);
    }
  }
  const source = structuredClone(initial);
  source.clients = source.clients.filter((c) =>
    ["ai", "drone", "robot", "mobile"].includes(c.product),
  );
  source.clients.find((c) => c.product === "mobile")!.applicationUrl +=
    "/account";
  const existing = join(dir, "existing.json");
  await writeFile(existing, encoded(source), { mode: 0o600 });
  const next = join(dir, "expanded");
  const extend = [
    "--environment",
    "production",
    "--existing",
    existing,
    "--output",
    next,
  ];
  const results = await Promise.allSettled([
    prepareIdentityRelease(extend),
    prepareIdentityRelease(extend),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const expanded = identityConfiguration(
    await json(join(next, "portal-issuer.env.json")),
    productionOrigins.portal,
  )!;
  assert.deepEqual(expanded.cookieKeys, source.cookieKeys);
  assert.deepEqual(expanded.jwks, source.jwks);
  assert.deepEqual(
    expanded.clients.slice(0, source.clients.length),
    source.clients,
  );
  const complete = join(dir, "stable");
  await prepareIdentityRelease([
    "--environment",
    "production",
    "--existing",
    join(next, "portal-issuer.env.json"),
    "--output",
    complete,
  ]);
  assert.deepEqual(
    await json(join(next, "portal-issuer.env.json")),
    await json(join(complete, "portal-issuer.env.json")),
  );
  await assert.rejects(prepareIdentityRelease(extend));
  source.clients[0].redirectUri = productionOrigins.ai + "/wrong";
  await writeFile(existing, encoded(source));
  const failed = join(dir, "failed");
  const invalid = [
    "--environment",
    "production",
    "--existing",
    existing,
    "--output",
    failed,
  ];
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/identity/prepare-release.ts", ...invalid],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /^Identity preparation failed\./);
  assert.equal(child.stderr.includes(source.clients[0].clientSecret), false);
  assert.equal(child.stderr.includes(source.jwks.keys[0].d), false);
  await assert.rejects(stat(failed), { code: "ENOENT" });
  await chmod(existing, 0o644);
  await assert.rejects(prepareIdentityRelease(invalid), /private/);
  await chmod(existing, 0o600);
  const link = join(dir, "link");
  await symlink(existing, link);
  await assert.rejects(
    prepareIdentityRelease([
      "--environment",
      "production",
      "--existing",
      link,
      "--output",
      failed,
    ]),
  );
});
test("staging uses seven independently selected, exact HTTPS origins and rejects production overlap", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "onesa-staging-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origins = Object.fromEntries(
    Object.keys(productionOrigins).map((p) => [
      p,
      "https://" + p + ".staging.example",
    ]),
  );
  const file = join(dir, "origins.json");
  await writeFile(file, JSON.stringify(origins));
  const output = join(dir, "good");
  const args = [
    "--environment",
    "staging",
    "--staging-origins",
    file,
    "--initialize",
    "--output",
    output,
  ];
  await prepareIdentityRelease(args);
  const issuerFile = join(output, "portal-issuer.env.json");
  const config = identityConfiguration(await json(issuerFile), origins.portal)!;
  assert.equal(config.clients.length, 7);
  assert.equal(
    config.clients.every(
      (c) => new URL(c.redirectUri).origin === origins[c.product],
    ),
    true,
  );
  const bad = join(dir, "bad");
  await assert.rejects(
    prepareIdentityRelease([
      "--environment",
      "production",
      "--existing",
      issuerFile,
      "--output",
      bad,
    ]),
  );
  for (const value of [
    productionOrigins.farmer,
    origins.portal,
    "https://*.staging.example",
    "https://farmer.staging.example/path",
    "https://user@farmer.staging.example",
    "http://farmer.staging.example",
  ]) {
    await writeFile(file, JSON.stringify({ ...origins, farmer: value }));
    await assert.rejects(prepareIdentityRelease([...args.slice(0, -1), bad]));
  }
  await assert.rejects(
    prepareIdentityRelease([
      "--environment",
      "production",
      "--staging-origins",
      file,
      "--initialize",
      "--output",
      bad,
    ]),
  );
  await assert.rejects(stat(bad), { code: "ENOENT" });
});
