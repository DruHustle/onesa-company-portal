import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {mobileApps} from "../src/config/mobile-apps.ts";

type RegistryItem = {id: string; group: string; label: string; href: string};
const registry = JSON.parse(readFileSync(new URL("../src/config/onesa-applications.json", import.meta.url), "utf8"))
  .applications as RegistryItem[];
const products = registry.filter(item => item.group === "product");

test("every registered product appears in the web/mobile availability directory", () => {
  assert.equal(products.length, 8, "The canonical catalog must list exactly eight products");
  const byName = new Map(mobileApps.map(app => [app.name, app]));
  assert.equal(byName.size, mobileApps.length, "Duplicate labels hide a product");
  assert.deepEqual([...byName.keys()].sort(), products.map(item => item.label).sort());
  for (const product of products) {
    const app = byName.get(product.label)!;
    assert.equal(app.website ?? "", product.href ? new URL(product.href).href : "",
      `Website destination for ${product.id} differs from the canonical registry`);
  }
  assert.equal(byName.get("PasoFi")?.parent, "Onesa Mobile");
});

test("only verified HTTPS native destinations can be advertised", () => {
  for (const app of mobileApps) {
    for (const platform of ["ios", "android"] as const) {
      const release = app[platform];
      if (!release) continue;
      assert.equal(new URL(release.url).protocol, "https:", `${app.name} ${platform}`);
      assert.ok(platform === "ios" ? ["App Store", "TestFlight"].includes(release.channel)
        : ["Google Play", "APK"].includes(release.channel));
    }
  }
});
