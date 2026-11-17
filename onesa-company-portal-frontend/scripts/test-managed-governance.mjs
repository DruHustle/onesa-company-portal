/** Production Portal renderer and proxy with a synthetic backend and browser-intercepted OIDC provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, firefox, webkit, expect } from "@playwright/test";

const origin = "http://127.0.0.1:3357";
const issuer = "https://provider.example.invalid/";
const identityUi = "https://identity.example.invalid";
const target = "00000000-0000-4000-8000-000000000001";
const challenges = new Map();
const requests = [];
const providerStates = new Map();
const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const json = (data, status = 200, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };
  const redirect = location => { res.writeHead(302, { location }); res.end(); };
  if (url.pathname === "/api/v1/auth/me") return json({ user: { id: target, role: "owner", email: "member@example.invalid" }, csrf: "synthetic-csrf" });
  if (url.pathname === "/api/v1/admin/governance/overview") return json({ restrictions: [], upcomingReviews: 0 });
  if (url.pathname === "/api/v1/admin/governance/requests" || (url.pathname === "/api/v1/admin/governance/holds" && req.method === "GET"))
    return json({ items: [], page: 1, total: 0 });
  if (url.pathname === "/api/v1/admin/governance/holds" && req.method === "POST") {
    if (req.headers["x-csrf-token"] !== "synthetic-csrf") return json({ error: { code: "CSRF" } }, 403);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    const { stepUp, ...operation } = body;
    if (!stepUp?.managed) return json({ error: { code: "INVALID_PROOF" } }, 403);
    if (stepUp.receipt === undefined) {
      const challenge = randomBytes(32).toString("hex");
      challenges.set(challenge, { operation, verified: false });
      return json({ error: { code: "PROVIDER_STEP_UP_REQUIRED", message: "Verify this action with Onesa." } }, 403, { "x-onesa-step-up": challenge });
    }
    const item = challenges.get(stepUp.receipt);
    if (!item?.verified || JSON.stringify(item.operation) !== JSON.stringify(operation))
      return json({ error: { code: "STEP_UP_FAILED", message: "Verification expired or incomplete." } }, 403);
    challenges.delete(stepUp.receipt);
    return json({}, 201);
  }
  if (url.pathname === "/api/v1/auth/managed/step-up") {
    if (url.search || req.method !== "POST" || req.headers.origin !== origin) return json({ error: { code: "START" } }, 400);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const challenge = new URLSearchParams(Buffer.concat(chunks).toString()).get("challenge");
    if (!challenges.has(challenge)) return json({ error: { code: "CHALLENGE" } }, 400);
    const state = randomBytes(24).toString("hex");
    providerStates.set(state, challenge);
    res.writeHead(303, { location: issuer + "authorize?state=" + state,
      "set-cookie": "fixture-" + state + "=started; Path=/api/v1/auth/managed/callback; HttpOnly; SameSite=Lax" });
    return res.end();
  }
  if (url.pathname === "/api/v1/auth/managed/callback") {
    const item = challenges.get(providerStates.get(url.searchParams.get("state")));
    const state = url.searchParams.get("state");
    if (!item || !req.headers.cookie?.split("; ").includes("fixture-" + state + "=started")) return json({ error: { code: "STATE" } }, 400);
    item.verified = true;
    return redirect("/admin/step-up-complete");
  }
  return json({ error: { code: "FIXTURE_ROUTE" } }, 404);
});

let child, browser;
const engines = { chromium, firefox, webkit };
const browsers = (process.env.ONESA_TEST_BROWSERS || "chromium,firefox,webkit").split(",");
try {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "-p", "3357"], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", PUBLIC_ORIGIN: origin, BACKEND_URL: "http://127.0.0.1:" + api.address().port,
      ONESA_IDENTITY_PORTAL_LOGIN: "managed", ONESA_IDENTITY_ISSUER: issuer, ONESA_IDENTITY_UI_ORIGIN: identityUi, ACCESS_REGISTRATION_ENABLED: "false",
      NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "ignore", "inherit"],
  });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error("Isolated Portal exited");
    try { return (await fetch(origin + "/admin/step-up-complete", { signal: AbortSignal.timeout(1000) })).status; } catch { return 0; }
  }, { timeout: 20_000 }).toBe(200);
  for (const engine of browsers) {
    assert(Object.hasOwn(engines, engine));
    const executablePath = engine === "chromium" ? process.env.ONESA_TEST_CHROMIUM_EXECUTABLE : undefined;
    browser = await engines[engine].launch({ executablePath });
    const context = await browser.newContext();
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(20_000);
    const page = await context.newPage();
    await context.route(identityUi + "/register", route => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Onesa registration</h1>" }));
    await page.goto(origin + "/access/register");
    await expect(page).toHaveURL(identityUi + "/register#registration");
    await expect(page.getByRole("heading", { name: "Onesa registration" })).toBeVisible();
    await context.route(issuer + "authorize?*", route => {
      const state = new URL(route.request().url()).searchParams.get("state");
      return route.fulfill({ status: 200, contentType: "text/html", body:
        '<a href="' + origin + '/api/v1/auth/managed/callback?state=' + encodeURIComponent(state) + '">Confirm synthetic verification</a>' });
    });
    const seenUrls = [];
    context.on("request", request => seenUrls.push(request.url()));
    await page.goto(origin + "/admin#privacy/requests");
    await page.getByText("Create a hold", { exact: true }).click();
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Record hold" }) });
    await form.getByLabel("Exact record UUID").fill(target);
    await form.getByLabel("Preservation reason").fill("Synthetic browser verification.");
    await form.getByLabel("Identity/scope evidence references").fill("tests/synthetic");
    await expect(form.locator('input[type="password"]')).toHaveCount(0);
    const save = form.getByRole("button", { name: "Record hold" });
    const dialog = page.getByRole("dialog");

    const initial = requests.length;
    await save.click();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Verification was cancelled.", { exact: true })).toBeVisible();
    await expect(form.getByLabel("Preservation reason")).toHaveValue("Synthetic browser verification.");
    assert.equal(requests.length, initial + 1);

    await save.click();
    const popupEvent = context.waitForEvent("page");
    await dialog.getByRole("button", { name: "Verify with Onesa" }).click();
    const popup = await popupEvent;
    await popup.getByRole("link", { name: "Confirm synthetic verification" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Hold recorded. Existing deletion routes enforce it.")).toBeVisible();
    const { stepUp, ...operation } = requests.at(-1);
    assert.match(stepUp.receipt, /^[a-f0-9]{64}$/);
    assert.deepEqual(requests.at(-2), { ...operation, stepUp: { managed: true } });

    await page.evaluate(() => { window.open = () => null; });
    await save.click();
    await dialog.getByRole("button", { name: "Verify with Onesa" }).click();
    await expect(dialog.getByRole("status")).toContainText("blocked");
    const newTab = context.waitForEvent("page");
    await dialog.getByRole("link", { name: "Open verification in a new tab" }).click();
    const tab = await newTab;
    await tab.getByRole("link", { name: "Confirm synthetic verification" }).click();
    await expect(tab.getByRole("heading", { name: "Verification complete" })).toBeVisible();
    await dialog.getByRole("button", { name: "I completed verification" }).click();
    await expect(page.getByText("Hold recorded. Existing deletion routes enforce it.")).toBeVisible();
    assert.equal(requests.length, initial + 5);
    assert.deepEqual(requests.at(-2).id, requests.at(-1).id);
    assert.notEqual(requests.at(-1).id, operation.id);

    for (const request of requests.slice(initial)) {
      if (request.stepUp.receipt) assert(seenUrls.every(url => !url.includes(request.stepUp.receipt)));
    }
    await context.close();
    await browser.close();
    browser = null;
    console.log(engine + " verified the managed operation, cancellation, original form and blocked-popup return through the Portal proxy.");
  }
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  api.closeAllConnections();
  await new Promise(resolve => api.close(resolve));
}
