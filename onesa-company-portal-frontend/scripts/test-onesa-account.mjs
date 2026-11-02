/** Real production renderer, isolated API fixtures, no mail/provider/database access. */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, firefox, webkit, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const port = Number(process.env.ONESA_TEST_ACCOUNT_PORT || 3356);
const apiPort = Number(process.env.ONESA_TEST_ACCOUNT_API_PORT || 8356);
assert([port, apiPort].every(value => Number.isSafeInteger(value) && value > 1024 && value < 65536));
assert.notEqual(port, apiPort);
const origin = "http://127.0.0.1:" + port;
const proxyKey = "test-only-account-ui-proxy";
const proof = "a".repeat(64);
const password = "test-only-account-password";
const accountId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const workspaceId = "00000000-0000-4000-8000-000000000003";
const csrf = "test-only-account-csrf";
const fixtures = new Map();
const receipts = [];
let tokenInRequestUrl = false;
let browser, child;
const engines = { chromium, firefox, webkit };
const requestedBrowsers = (process.env.ONESA_TEST_BROWSERS || "chromium,firefox,webkit").split(",");
assert(requestedBrowsers.length > 0 && new Set(requestedBrowsers).size === requestedBrowsers.length);
assert(requestedBrowsers.every(name => Object.hasOwn(engines, name)));
const supplemental = process.env.ONESA_TEST_CHROMIUM_EXECUTABLE;
if (supplemental) assert(supplemental.startsWith("/"), "Supplemental Chromium path must be absolute");

function account(admin = false) {
  return { id: accountId, email: "synthetic-member@example.test", name: "Synthetic Onesa Member", globalAdmin: admin, owner: admin, portalAccess: admin, emailVerified: true, mfaEnrolled: true };
}
function session(admin = false) {
  return {
    account: account(admin), csrf,
    access: [
      { product: "ai", role: "user", status: "active", revision: 1 },
      { product: "drone", role: "viewer", status: "pending", revision: 1 },
      { product: "robot", role: "viewer", status: "rejected", revision: 1 },
    ], memberships: [],
    applications: ["ai", "drone", "robot"].map(product => ({ product, url: "https://" + product + ".example.test/" })),
  };
}
function directory() {
  return { items: [{ account: { ...account(), id: memberId, name: "Synthetic Applicant", email: "synthetic-applicant@example.test" }, access: [{ product: "drone", role: "viewer", status: "pending", revision: 4 }], memberships: [] }], page: 1, hasMore: false };
}
const api = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (status, value) => res.writeHead(status).end(JSON.stringify(value));
  const fail = (status, code, message) => send(status, { error: { code, message, requestId: "synthetic-ui" } });
  try {
    tokenInRequestUrl ||= req.url.includes(proof) || req.url.includes("access-link");
    if (req.headers["x-portal-proxy-key"] !== proxyKey) return fail(403, "PROXY", "Invalid synthetic proxy");
    const url = new URL(req.url, origin), path = url.pathname;
    const key = /(?:^|;\s*)onesa_account_ui=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const state = fixtures.get(key);
    if (!state) return fail(401, "FIXTURE", "Synthetic browser state required");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8192) return fail(413, "BODY", "Synthetic body bound");
    }
    const input = raw ? JSON.parse(raw) : null;
    if (req.method !== "GET") state.writes.push({ path, method: req.method, input, csrf: req.headers["x-csrf-token"] });
    if (state.gate && path === state.gate.path) await state.gate.promise;
    if (path === "/api/v1/account/config") return send(200, { enabled: state.enabled !== false });
    if (path === "/api/v1/account/me") return state.session ? send(200, state.session) : fail(401, "UNAUTHENTICATED", "Sign in required");
    if (path === "/api/v1/account/register") return send(202, { ok: true });
    if (path === "/api/v1/account/confirm") {
      assert.equal(input.token, proof);
      assert.equal(input.password, password);
      return send(200, { status: "verified" });
    }
    if (path === "/api/v1/account/login") {
      if (state.loginError) return fail(state.loginError.status || 403, state.loginError.code, state.loginError.message);
      if (state.mfa && input.code !== "123456") return fail(401, "MFA_REQUIRED", "Enter your authenticator or recovery code.");
      state.session = session(); return send(200, state.session);
    }
    if (path === "/api/v1/account/logout") {
      assert.equal(req.headers["x-csrf-token"], csrf);
      state.session = null; return send(200, { ok: true });
    }
    const productRequest = /^\/api\/v1\/account\/products\/(ai|drone|robot)\/request$/.exec(path);
    if (productRequest) {
      assert.equal(req.headers["x-csrf-token"], csrf);
      const product = productRequest[1], old = state.session.access.find(item => item.product === product);
      state.session.access = state.session.access.filter(item => item.product !== product);
      state.session.access.push({ product, status: "pending", role: product === "ai" ? "user" : "viewer", revision: (old?.revision || 0) + 1 });
      return send(200, state.session);
    }
    if (path === "/api/v1/account/password/request") return send(202, { ok: true });
    if (path === "/api/v1/account/password/change") {
      assert.equal(req.headers["x-csrf-token"], csrf);
      assert.equal(input.currentPassword, password); assert.equal(input.code, "123456");
      state.session = null; return send(200, { ok: true });
    }
    if (path === "/api/v1/auth/password/reset") {
      assert.equal(input.token, proof); return send(200, { ok: true });
    }
    if (path === "/api/v1/admin/identity/accounts") return send(200, state.directory || directory());
    if (/^\/api\/v1\/admin\/identity\/accounts\/[a-f0-9-]+\/(products\/(ai|drone|robot)|administrator)$/.test(path)) {
      assert.equal(req.headers["x-csrf-token"], csrf);
      assert.deepEqual(input.stepUp, { password, code: "123456" });
      if (state.grantError) return fail(409, "REVISION", "Access changed. Reload this account and review it again.");
      const record = (state.directory ||= directory()).items[0];
      if (path.endsWith("/administrator")) record.account.globalAdmin = input.administrator;
      else { record.access = [{ product: path.split("/").at(-1), role: input.role, status: input.status, revision: input.expectedRevision + 1 }]; record.memberships = input.memberships; }
      return send(200, { ok: true });
    }
    const interaction = /^\/api\/v1\/account\/interaction\/([A-Za-z0-9_-]+)(?:\/(login|continue))?$/.exec(path);
    if (interaction) {
      const [, uid, operation] = interaction;
      if (!operation) {
        if (state.interactionError) return fail(410, "INTERACTION_EXPIRED", "This sign-in has expired. Return to your product and sign in again.");
        return send(200, { csrf, product: "robot", freshRequired: false, mfaRequired: false, account: state.existingAccount ? account() : null, ...state.interaction });
      }
      assert.equal(input.csrf, csrf);
      if (state.interactionLoginError) return fail(403, state.interactionLoginError.code, state.interactionLoginError.message);
      return send(200, { continuePath: state.badContinuation ? "https://unexpected.example.test/" : "/api/v1/identity/auth/" + uid });
    }
    if (/^\/api\/v1\/identity\/auth\/[A-Za-z0-9_-]+$/.test(path)) {
      res.setHeader("content-type", "text/html");
      return res.end("<!doctype html><html lang=en><title>Synthetic product continuation</title><main><h1>Synthetic product continuation</h1></main></html>");
    }
    return fail(404, "FIXTURE_ROUTE", "Synthetic route not selected");
  } catch (error) {
    // Fixture assertions are surfaced without sending tokens, passwords or bodies to logs.
    stateErrors.push(error instanceof Error ? error.message : "Synthetic fixture failed");
    if (!res.headersSent) return fail(500, "FIXTURE_ASSERTION", "Synthetic fixture assertion failed");
    res.end();
  }
});
const stateErrors = [];
await new Promise((resolve, reject) => { api.once("error", reject); api.listen(apiPort, "127.0.0.1", resolve); });

const text = {
  en: { register: "Create your Onesa account", name: "Your name", email: "Email address", choose: "Choose at least one product.", submit: "Email my verification link", sent: "Check your email", title: "Your applications", pending: "Awaiting approval", denied: "Request not approved", open: "Open product", request: "Request access", logout: "Sign out of Onesa", login: "Sign in to Onesa", admin: "Accounts and product access", search: "Find an account", product: "Product", role: "Maximum product role", access: "Access", workspace: "Add workspace", workspaceName: "Workspace name", workspaceId: "Workspace identifier", workspaceRole: "Workspace role", ownPassword: "Your password", ownCode: "Your authenticator code", save: "Save product access", saved: "Access saved.", administrator: "Make Onesa Administrator" },
  de: { register: "Ihr Onesa-Konto erstellen", name: "Ihr Name", email: "E-Mail-Adresse", choose: "Wählen Sie mindestens ein Produkt.", submit: "Bestätigungslink senden", sent: "Prüfen Sie Ihre E-Mails", title: "Ihre Anwendungen", pending: "Freigabe ausstehend", denied: "Anfrage nicht freigegeben", open: "Produkt öffnen", request: "Zugang anfordern", logout: "Bei Onesa abmelden", login: "Bei Onesa anmelden", admin: "Konten und Produktzugänge", search: "Konto suchen", product: "Produkt", role: "Maximale Produktrolle", access: "Zugang", workspace: "Arbeitsbereich hinzufügen", workspaceName: "Name des Arbeitsbereichs", workspaceId: "Arbeitsbereich-Kennung", workspaceRole: "Rolle im Arbeitsbereich", ownPassword: "Ihr Passwort", ownCode: "Ihr Authenticator-Code", save: "Produktzugang speichern", saved: "Zugang gespeichert.", administrator: "Als Onesa-Administrator ernennen" },
};

async function isolated({ language = "en", width = 320, ...fixture }, work) {
  const key = randomUUID(), state = { writes: [], ...fixture };
  fixtures.set(key, state);
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
  const failures = [], outside = [];
  await context.addCookies([{ name: "onesa_account_ui", value: key, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(value => localStorage.setItem("onesa.account.language", value), language);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    outside.push(new URL(route.request().url()).origin); return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", error => failures.push(error.message));
  try {
    await work(page, state, text[language]);
    assert.deepEqual(outside, [], "UI attempted an external request");
    assert.deepEqual(failures, [], "Production UI raised an uncaught error");
    assert.deepEqual(stateErrors, [], "Synthetic API assertion failed");
  } finally { await context.close(); fixtures.delete(key); }
}
async function layout(page, a11y = true) {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Horizontal overflow");
  if (a11y) {
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    assert.deepEqual(audit.violations.map(value => ({ id: value.id, impact: value.impact, targets: value.nodes.map(node => node.target) })), []);
  }
}
async function applyTheme(page, colorScheme) {
  const before = await page.locator("main").evaluate(node => ({
    background: getComputedStyle(node).backgroundColor,
    foreground: getComputedStyle(node).color,
  }));
  await page.emulateMedia({ colorScheme });
  // Media emulation can resolve before inherited colors reach the next paint.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => page.locator("main").evaluate((node, { before, colorScheme }) => {
    const style = getComputedStyle(node);
    return {
      media: matchMedia(`(prefers-color-scheme: ${colorScheme})`).matches,
      backgroundChanged: style.backgroundColor !== before.background,
      foregroundChanged: style.color !== before.foreground,
      inheritedText: [...node.querySelectorAll("header a, header a span, h1, h2, article > span, fieldset, legend, label, button:not(.button)")].every(child => getComputedStyle(child).color === style.color),
    };
  }, { before, colorScheme }), { timeout: 5000 }).toEqual({ media: true, backgroundChanged: true, foregroundChanged: true, inheritedText: true });
}
async function preserveTheme(page, field) {
  await field.focus();
  const values = await page.locator("input").evaluateAll(nodes => nodes.map(input => ({ name: input.name, value: input.value, checked: input.checked })));
  await applyTheme(page, "dark");
  assert.deepEqual(await page.locator("input").evaluateAll(nodes => nodes.map(input => ({ name: input.name, value: input.value, checked: input.checked }))), values);
  await expect(field).toBeFocused(); await layout(page);
  await applyTheme(page, "light"); await expect(field).toBeFocused();
}
function gate(state, path) {
  let release;
  state.gate = { path, promise: new Promise(resolve => { release = resolve; }) };
  return () => { release(); state.gate = null; };
}
async function signInFields(page) {
  await page.getByLabel("Email address", { exact: true }).fill("synthetic-member@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
}

try {
  child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "-p", String(port)], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", PUBLIC_ORIGIN: origin, SITE_URL: origin, BACKEND_URL: "http://127.0.0.1:" + apiPort, PROXY_SHARED_KEY: proxyKey, ONESA_IDENTITY_ENABLED: "true", ACCESS_REGISTRATION_ENABLED: "true", NEXT_TELEMETRY_DISABLED: "1", AWS_EC2_METADATA_DISABLED: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startup = "";
  child.stdout.on("data", value => { startup = (startup + value).slice(-2000); });
  child.stderr.on("data", value => { startup = (startup + value).slice(-2000); });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw Error("Isolated renderer exited: " + startup);
    try { if ((await fetch(origin + "/account", { signal: AbortSignal.timeout(500) })).status === 200) { ready = true; break; } } catch { /* bounded local readiness */ }
    await delay(250);
  }
  assert(ready, "Isolated renderer readiness deadline");
  for (const engine of requestedBrowsers) {
    browser = await engines[engine].launch(engine === "chromium" && supplemental ? { executablePath: supplemental, args: ["--disable-dev-shm-usage"] } : {});
    const version = browser.version();
    await isolated({}, async (page, state) => {
      const release = gate(state, "/api/v1/account/config");
      try {
        await page.goto(origin + "/account", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("status")).toHaveText("Please wait…");
        await expect(page.locator("form")).toHaveCount(0);
      } finally { release(); }
      await expect(page.getByLabel("Email address", { exact: true })).toBeEnabled();
      receipts.push({ engine, flow: "loading-without-premature-sign-in-controls" });
    });
    let matrix = 0;
    for (const language of ["en", "de"]) for (const width of [320, 1280]) {
      const products = ["Onesa AI", "Onesa Drone", "Onesa Robot"].slice(0, ++matrix % 3 + 1);
      await isolated({ language, width }, async (page, state, t) => {
        await page.goto(origin + "/account/register");
        await expect(page.getByRole("heading", { name: t.register })).toBeVisible();
        await page.getByLabel(t.name, { exact: true }).fill("Synthetic Onesa Member");
        await page.getByLabel(t.email, { exact: true }).fill("synthetic-member@example.test");
        await page.getByRole("button", { name: t.submit, exact: true }).click();
        await expect(page.getByRole("main").getByRole("alert")).toHaveText(t.choose); assert.equal(state.writes.length, 0);
        for (const product of products) await page.getByRole("checkbox", { name: product, exact: true }).check();
        for (const name of ["Onesa AI", "Onesa Drone", "Onesa Robot"]) {
          const geometry = await page.getByRole("checkbox", { name, exact: true }).evaluate(input => {
            const box = input.getBoundingClientRect(), label = input.parentElement.getBoundingClientRect(), text = input.parentElement.querySelector("span").getBoundingClientRect();
            return { targetHeight: label.height, alongside: text.left >= box.right, aligned: Math.abs(text.top + text.height / 2 - box.top - box.height / 2) <= 2 };
          });
          assert(geometry.targetHeight >= 44 && geometry.alongside && geometry.aligned, "Product checkbox and label must share one comfortably sized row");
        }
        await preserveTheme(page, page.getByLabel(t.name, { exact: true }));
        const release = gate(state, "/api/v1/account/register");
        try {
          await page.getByRole("button", { name: t.submit, exact: true }).click();
          await expect(page.getByLabel(t.email, { exact: true })).toBeDisabled();
          await expect.poll(() => state.writes.length).toBe(1);
        } finally { release(); }
        await expect(page.getByRole("status")).toContainText(t.sent);
        await expect(page.getByRole("status")).toBeFocused();
        assert.deepEqual(state.writes[0].input.products, products.map(name => name.split(" ")[1].toLowerCase()));
        assert.equal(state.writes[0].input.email, "synthetic-member@example.test");
        receipts.push({ engine, flow: "registration", language, width, products: products.length });
      });
      await isolated({ language, width, session: session() }, async (page, state, t) => {
        await page.goto(origin + "/account");
        await expect(page.getByRole("heading", { name: t.title, exact: true })).toBeVisible();
        const product = name => page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
        await expect(product("Onesa AI").getByRole("link", { name: t.open })).toHaveAttribute("href", "https://ai.example.test/");
        await expect(product("Onesa Drone").getByRole("button", { name: t.pending, exact: true })).toBeDisabled();
        await expect(product("Onesa Robot")).toContainText(t.denied);
        await expect(page.getByRole("heading", { name: t.admin })).toHaveCount(0);
        await layout(page); await applyTheme(page, "dark"); await layout(page);
        await product("Onesa Robot").getByRole("button", { name: t.request, exact: true }).click();
        await expect(product("Onesa Robot").getByRole("button", { name: t.pending })).toBeDisabled();
        assert.equal(state.writes.at(-1).csrf, csrf);
        await page.getByRole("button", { name: t.logout, exact: true }).click();
        await expect(page.getByRole("heading", { name: t.login, exact: true })).toBeVisible();
        assert.equal(state.writes.at(-1).path, "/api/v1/account/logout");
        receipts.push({ engine, flow: "access-and-logout", language, width });
      });
    }
    await isolated({ mfa: true }, async (page, state) => {
      await page.goto(origin + "/account"); await signInFields(page);
      await page.getByLabel("Remember this browser").check();
      await preserveTheme(page, page.getByLabel("Password", { exact: true }));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const factor = page.getByLabel("Authenticator or recovery code", { exact: true });
      await expect(factor).toBeFocused(); await expect(page.getByRole("main").getByRole("alert")).toContainText("authenticator");
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue(password);
      await factor.fill("123456"); await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Your applications", exact: true })).toBeVisible();
      assert.equal(state.writes.length, 2); assert.equal(state.writes[1].input.rememberBrowser, true);
      receipts.push({ engine, flow: "mfa-and-form-continuity" });
    });
    for (const issue of [
      { code: "MFA_ENROLLMENT_REQUIRED", message: "Set up your authenticator to continue.", link: "Set up your authenticator", target: "/account/setup-authenticator" },
      { code: "EMAIL_VERIFICATION_REQUIRED", message: "Verify your account email to continue.", link: "Verify your account email", target: "/account/register" },
      { code: "PRODUCT_ACCESS_REQUIRED", message: "This product needs approval.", link: "Go to your account", target: "/account" },
    ]) await isolated({ loginError: issue }, async (page) => {
      await page.goto(origin + "/account"); await signInFields(page);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(issue.message);
      await expect(page.getByRole("link", { name: issue.link, exact: true })).toHaveAttribute("href", issue.target);
      await expect(page.getByLabel("Email address", { exact: true })).toHaveValue("synthetic-member@example.test");
      receipts.push({ engine, flow: "actionable-sign-in-error", code: issue.code });
    });
    await isolated({}, async (page, state) => {
      await page.goto(origin + "/account/confirm#access-link=" + proof);
      await expect(page).toHaveURL(origin + "/account/confirm");
      await expect(page.getByLabel("Password", { exact: true })).toBeEnabled();
      assert.equal(state.writes.length, 0, "Fragment must not verify automatically");
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByLabel("Confirm password", { exact: true }).fill("test-only-mismatch");
      await page.getByRole("button", { name: "Verify your email", exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText("The passwords must match."); assert.equal(state.writes.length, 0);
      await page.getByLabel("Confirm password", { exact: true }).fill(password);
      await preserveTheme(page, page.getByLabel("Confirm password", { exact: true }));
      await page.getByRole("button", { name: "Verify your email", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Your email is verified."); await expect(page.getByRole("status")).toBeFocused();
      assert.equal(state.writes.length, 1); receipts.push({ engine, flow: "fragment-safe-explicit-email-verification" });
    });
    for (const fresh of [false, true]) await isolated({ existingAccount: true, interaction: { freshRequired: fresh, mfaRequired: fresh } }, async (page, state) => {
      const uid = "synthetic_interaction_" + (fresh ? "fresh" : "continue");
      await page.goto(origin + "/account/sign-in/" + uid);
      if (fresh) {
        await expect(page.getByRole("heading", { name: "Confirm your identity", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: /^Continue as/ })).toHaveCount(0);
        await page.getByLabel("Password", { exact: true }).fill(password);
        await page.getByLabel("Authenticator or recovery code", { exact: true }).fill("123456");
        await page.getByRole("button", { name: "Continue", exact: true }).click();
      } else await page.getByRole("button", { name: "Continue as synthetic-member@example.test", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Synthetic product continuation", exact: true })).toBeVisible();
      assert.equal(state.writes.length, 1); assert.equal(state.writes[0].input.csrf, csrf);
      if (fresh) assert.equal(state.writes[0].input.code, "123456");
      receipts.push({ engine, flow: fresh ? "fresh-mfa-continuation" : "existing-account-continuation" });
    });
    await isolated({ interactionError: true }, async (page) => {
      await page.goto(origin + "/account/sign-in/synthetic_expired_interaction");
      await expect(page.getByRole("main").getByRole("alert")).toContainText("sign-in has expired");
      await expect(page.getByLabel("Email address", { exact: true })).toBeDisabled();
      await expect(page.getByRole("link", { name: "New to Onesa? Create one account", exact: true })).toBeVisible();
      receipts.push({ engine, flow: "expired-interaction" });
    });
    await isolated({ existingAccount: true, badContinuation: true }, async (page) => {
      await page.goto(origin + "/account/sign-in/synthetic_bad_continuation");
      await page.getByRole("button", { name: "Continue as synthetic-member@example.test", exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText("Invalid sign-in continuation.");
      await expect(page).toHaveURL(origin + "/account/sign-in/synthetic_bad_continuation");
      receipts.push({ engine, flow: "reject-external-continuation" });
    });
    for (const language of ["en", "de"]) await isolated({ language, session: session(true), directory: directory() }, async (page, state, t) => {
      await page.goto(origin + "/account?tab=access");
      await expect(page.getByRole("heading", { name: t.admin, exact: true })).toBeVisible();
      assert.equal(await page.getByRole("link", { name: t.open, exact: true }).count(), 3);
      await page.getByText("Synthetic Applicant", { exact: true }).click();
      const card = page.locator("details").filter({ has: page.getByText("Synthetic Applicant", { exact: true }) });
      const productForm = card.locator("form").first();
      await productForm.getByRole("combobox", { name: t.role, exact: true }).selectOption("operator");
      await productForm.getByRole("button", { name: t.workspace, exact: true }).click();
      await productForm.getByLabel(t.workspaceName, { exact: true }).fill("Synthetic review workspace");
      await productForm.getByLabel(t.workspaceId, { exact: true }).fill(workspaceId);
      await productForm.getByRole("combobox", { name: t.workspaceRole, exact: true }).selectOption("viewer");
      await productForm.getByLabel(t.ownPassword, { exact: true }).fill(password);
      await productForm.getByLabel(t.ownCode, { exact: true }).fill("123456");
      await preserveTheme(page, productForm.getByLabel(t.workspaceName, { exact: true }));
      state.grantError = true;
      await productForm.getByRole("button", { name: t.save, exact: true }).click();
      await expect(card.getByRole("alert")).toContainText("Access changed.");
      await expect(productForm.getByLabel(t.workspaceName, { exact: true })).toHaveValue("Synthetic review workspace");
      state.grantError = false;
      await productForm.getByRole("button", { name: t.save, exact: true }).click();
      await expect(card.getByRole("status")).toContainText(t.saved);
      assert.deepEqual(state.writes.at(-1).input.memberships, [{ tenant_id: workspaceId, role: "viewer", label: "Synthetic review workspace" }]);
      assert.equal(state.writes.at(-1).input.expectedRevision, 4); assert.equal(state.writes.at(-1).input.role, "operator");
      const adminForm = card.locator("form").last();
      await adminForm.getByLabel(t.ownPassword, { exact: true }).fill(password);
      await adminForm.getByLabel(t.ownCode, { exact: true }).fill("123456");
      await adminForm.getByRole("button", { name: t.administrator, exact: true }).click();
      await expect(card.getByRole("status")).toContainText(t.saved);
      assert.equal(state.writes.at(-1).input.administrator, true);
      receipts.push({ engine, flow: "admin-grant-revision-workspace-and-global-role", language, width: 320 });
    });
    for (const language of ["en", "de"]) {
      const security = language === "en" ? {
        email: "Email address", send: "Email password reset link", sent: "If this address has an active Onesa account", current: "Current password", password: "New password (at least 14 characters)", confirmation: "Confirm new password", code: "Fresh authenticator or recovery code", change: "Change Onesa password", changed: "Your Onesa password has changed.", ended: "Your existing sessions have ended.",
      } : {
        email: "E-Mail-Adresse", send: "Link zur Passwortwiederherstellung senden", sent: "Wenn diese Adresse zu einem aktiven Onesa-Konto gehört", current: "Aktuelles Passwort", password: "Neues Passwort (mindestens 14 Zeichen)", confirmation: "Neues Passwort bestätigen", code: "Aktueller Authenticator- oder Wiederherstellungscode", change: "Onesa-Passwort ändern", changed: "Ihr Onesa-Passwort wurde geändert.", ended: "Ihre bisherigen Sitzungen wurden beendet.",
      };
      await isolated({ language }, async (page, state) => {
        await page.goto(origin + "/account/security");
        await page.getByLabel(security.email, { exact: true }).fill("synthetic-member@example.test");
        await preserveTheme(page, page.getByLabel(security.email, { exact: true }));
        await page.getByRole("button", { name: security.send, exact: true }).click();
        await expect(page.getByRole("status")).toContainText(security.sent);
        assert.equal(state.writes.length, 1); receipts.push({ engine, flow: "non-enumerating-password-recovery", language });
      });
      await isolated({ language, session: session() }, async (page, state) => {
        await page.goto(origin + "/account/security");
        await page.getByLabel(security.current, { exact: true }).fill(password);
        await page.getByLabel(security.password, { exact: true }).fill(password + "-new");
        await page.getByLabel(security.confirmation, { exact: true }).fill(password + "-new");
        await page.getByLabel(security.code, { exact: true }).fill("123456");
        await preserveTheme(page, page.getByLabel(security.current, { exact: true }));
        await page.getByRole("button", { name: security.change, exact: true }).click();
        await expect(page.getByRole("status")).toContainText(security.ended);
        assert.equal(state.writes[0].csrf, csrf); receipts.push({ engine, flow: "password-change-with-fresh-factor", language });
      });
      await isolated({ language }, async (page, state) => {
        await page.goto(origin + "/account/security#access-link=" + proof);
        await expect(page).toHaveURL(origin + "/account/security");
        await page.getByLabel(security.password, { exact: true }).fill(password + "-reset");
        await page.getByLabel(security.confirmation, { exact: true }).fill(password + "-reset");
        assert.equal(state.writes.length, 0);
        await page.getByRole("button", { name: security.change, exact: true }).click();
        await expect(page.getByRole("status")).toContainText(security.changed);
        assert.equal(state.writes[0].input.token, proof); receipts.push({ engine, flow: "fragment-safe-explicit-password-reset", language });
      });
    }
    await isolated({ enabled: false }, async (page, state) => {
      await page.goto(origin + "/account");
      await expect(page.getByRole("heading", { name: "Shared sign-in is being prepared", exact: true })).toBeVisible();
      await expect(page.locator("form")).toHaveCount(0); assert.equal(state.writes.length, 0);
      receipts.push({ engine, flow: "disabled-service" });
    });
    console.log(JSON.stringify({ browser: engine, version, supplemental: engine === "chromium" && Boolean(supplemental), completedFlows: receipts.filter(item => item.engine === engine).length }));
    await browser.close(); browser = undefined;
  }
  assert.equal(tokenInRequestUrl, false, "Sensitive verification fragment reached an HTTP URL");
  assert.deepEqual(stateErrors, []);
  console.log(JSON.stringify({ status: "PASS", scope: "Isolated production renderer and synthetic API; backend protocol and hosted acceptance are separate gates", flows: receipts.length, browsers: requestedBrowsers, supplementalChromium: Boolean(supplemental), mailSent: 0, databaseRequests: 0, providerRequests: 0 }));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM"); await Promise.race([once(child, "exit"), delay(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
}
