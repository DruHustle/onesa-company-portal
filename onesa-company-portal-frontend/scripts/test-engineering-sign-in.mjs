/** Isolated production-renderer UI regression. No provider, database or email access. */
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const accessEnabled = process.env.ONESA_TEST_ACCESS_MODE !== "disabled";
const states = new Map(),
  proxyKey = "synthetic-ui-proxy-only",
  proof = "a".repeat(64);
let engineeringConfirmations = 0, adminConfirmations = 0, tokenInRequestUrl = false;
const registrationRequests = [];
let registrationConfirmation = {status: "pending", audience: "engineering"};
const api = http.createServer(async (req, res) => {
  tokenInRequestUrl ||= /access-link|a{64}/.test(req.url);
  if (req.url === "/api/v1/access/link/verify") adminConfirmations++;
  res.setHeader("content-type", "application/json");
  if (req.headers["x-portal-proxy-key"] !== proxyKey) {
    res.writeHead(403).end("{}");
    return;
  }
  if (req.url === "/api/v1/auth/me") {
    res.writeHead(401).end('{"error":{"message":"Sign in required"}}'); return;
  }
  if (["/api/v1/access/link", "/api/v1/access/register"].includes(req.url)) {
    let body = ""; for await (const c of req) body += c;
    const input = JSON.parse(body);
    if (!input.email) { res.writeHead(400).end("{}"); return; }
    if (req.url === "/api/v1/access/register") {
      if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > 120) { res.writeHead(400).end("{}"); return; }
      registrationRequests.push(input);
    }
    res.writeHead(202).end('{"ok":true}'); return;
  }
  if (req.url === "/api/v1/access/confirm") {
    let body = ""; for await (const c of req) body += c;
    const input = JSON.parse(body);
    if (input.token !== "a".repeat(64) || input.password.length < 14) { res.writeHead(401).end("{}"); return; }
    res.end(JSON.stringify(registrationConfirmation)); return;
  }
  const match = req.url.match(
    /^\/api\/v1\/engineering-sign-in\/([A-Za-z0-9_-]+)\/(details|link|password|link-verify)$/,
  );
  if (!match) {
    res.writeHead(404).end("{}");
    return;
  }
  const [, uid, action] = match;
  let body = "";
  for await (const c of req) {
    body += c;
    if (body.length > 2048) {
      res.writeHead(413).end("{}");
      return;
    }
  }
  if (action === "details") {
    res.end(JSON.stringify({ csrf: proof, emailSent: states.has(uid) }));
    return;
  }
  const input = JSON.parse(body);
  if (input.csrf !== proof) {
    res.writeHead(403).end("{}");
    return;
  }
  if (action === "link") {
    states.set(uid, true);
    res.end('{"ok":true}');
    return;
  }
  if (action === "password" && input.password !== "synthetic-valid-password") {
    res.writeHead(401).end('{"error":"synthetic-invalid-code"}');
    return;
  }
  if (action === "link-verify") {
    if (input.token !== proof) { res.writeHead(401).end("{}"); return; }
    engineeringConfirmations++;
  }
  res.end(
    JSON.stringify({
      continuePath: "/api/v1/engineering-identity/auth/" + uid,
    }),
  );
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiPort = api.address().port;
const reserve = http.createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = "http://127.0.0.1:" + port;
const env = {
  PATH: process.env.PATH,
  NODE_ENV: "production",
  PUBLIC_ORIGIN: origin,
  SITE_URL: origin,
  BACKEND_URL: "http://127.0.0.1:" + apiPort,
  ENGINEERING_SIGNIN_ENABLED: String(accessEnabled),
  ACCESS_REGISTRATION_ENABLED: String(accessEnabled),
  PROXY_SHARED_KEY: proxyKey,
  NEXT_TELEMETRY_DISABLED: "1",
  AWS_EC2_METADATA_DISABLED: "true",
};
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "-p",
    String(port),
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let startup = "";
child.stdout.on("data", (x) => (startup = (startup + x).slice(-2000)));
child.stderr.on("data", (x) => (startup = (startup + x).slice(-2000)));
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw Error("Isolated renderer exited");
    try {
      const response = await fetch(
        origin + (accessEnabled ? "/engineering/sign-in/synthetic_ready_01" : "/admin"),
        { signal: AbortSignal.timeout(500) },
      );
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  if (!ready) throw Error("Isolated renderer readiness deadline");
  browser = await chromium.launch();
  if (accessEnabled) {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
    const page = await context.newPage();
    let releaseDetails;
    const detailsGate = new Promise(resolve => { releaseDetails = resolve; });
    await page.route("**/engineering/sign-in/synthetic_loading_01/details", async route => {
      await detailsGate;
      await route.continue();
    });
    try {
      await page.goto(origin + "/engineering/sign-in/synthetic_loading_01", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("status")).toHaveText("Preparing secure sign-in…");
      await expect(page.getByRole("group", { name: "Sign-in method" })).toHaveCount(0);
      await expect(page.locator("form")).toHaveCount(0);
      releaseDetails();
      await expect(page.getByLabel("Email address")).toBeEnabled();
      await expect(page.getByRole("group", { name: "Sign-in method" })).toBeVisible();
      await expect(page.getByRole("status")).toHaveCount(0);
      await expect(page.getByText("New access requires owner approval. Existing approvals are retained.")).toBeHidden();
      await page.getByText("Help with access", { exact: true }).click();
      await expect(page.getByText("New access requires owner approval. Existing approvals are retained.")).toBeVisible();
      await page.clock.install();
      await page.getByLabel("Email address").fill("synthetic-engineer@onesa.eu");
      await page.getByRole("button", { name: "Send sign-in link", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Link sent.");
      await expect(page.getByLabel("Email address")).toBeHidden();
      await expect(page.getByRole("button", { name: "Send again in 15s", exact: true })).toBeDisabled();
      await page.clock.fastForward(15000);
      const resend = page.getByRole("button", { name: "Send another link", exact: true });
      await expect(resend).toBeEnabled();
      const resent = page.waitForResponse(r => r.url() === origin + "/engineering/sign-in/synthetic_loading_01/link");
      await resend.click();
      expect((await resent).status()).toBe(200);
      await expect(page.getByRole("button", { name: "Send again in 15s", exact: true })).toBeDisabled();
      await expect(page.getByLabel("Email address")).toBeHidden();
    } finally { releaseDetails(); await context.close(); }
  }
  const screenshotDir = process.env.ONESA_SIGNIN_SCREENSHOTS;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true, mode: 0o700 });
  const views = [];
  for (const width of (accessEnabled ? [320, 390, 768, 1440] : []))
    for (const mode of (accessEnabled ? ["light", "dark"] : [])) {
      const uid = "synthetic_ui_" + width + "_" + mode,
        context = await browser.newContext({
          viewport: { width, height: 960 },
          colorScheme: mode,
        });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.name));
      await page.route("https://**/*", (route) => route.abort());
      await page.goto(origin + "/engineering/sign-in/" + uid, {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", { name: "Sign in to Engineering Docs" }),
      ).toBeVisible();
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `signin-${width}-${mode}.png`), fullPage: true });
      const email = page.getByLabel("Email address");
      await expect(email).toBeEnabled();
      await email.fill("synthetic-engineer@onesa.eu");
      await page.emulateMedia({
        colorScheme: mode === "light" ? "dark" : "light",
      });
      await expect(email).toHaveValue("synthetic-engineer@onesa.eu");
      const started = page.waitForResponse(
        (r) => r.url() === origin + "/engineering/sign-in/" + uid + "/link",
      );
      await page
        .getByRole("button", { name: "Send sign-in link" })
        .click();
      expect((await started).status()).toBe(200);
      await expect(page.getByRole("status")).toHaveText("Link sent.");
      await expect(page.locator("form")).toBeHidden();
      await expect(page.getByRole("link", { name: "Register for Engineering Docs" })).toHaveCount(0);
      await page.getByRole("button", {name:"Email and password",exact:true}).click();
      const password = page.getByLabel("Password", {exact:true});
      await password.fill("synthetic-invalid-password");
      await page.getByRole("button", {name:"Sign in to Docs",exact:true}).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(password).toHaveValue("synthetic-invalid-password");
      await expect(page.getByRole("button", {name:"Sign in to Docs",exact:true})).toBeEnabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(errors).toEqual([]);
      await password.fill("synthetic-valid-password");
      await page.getByRole("button", { name: "Sign in to Docs" }).click();
      await page.waitForURL(
        origin + "/api/v1/engineering-identity/auth/" + uid,
      );
      const linkUid = uid + "_same_page", beforeConfirmation = engineeringConfirmations;
      await page.goto(origin + "/engineering/sign-in/" + linkUid, {waitUntil: "networkidle"});
      await page.getByLabel("Email address", {exact: true}).fill("synthetic-engineer@onesa.eu");
      await page.getByRole("button", {name: "Send sign-in link", exact: true}).click();
      await expect(page.getByRole("status")).toHaveText("Link sent.");
      await page.evaluate(() => { window.__onesaLinkDocumentMarker = "same-document"; });
      await page.goto(origin + "/engineering/sign-in/" + linkUid + "#access-link=" + proof);
      await expect(page.getByRole("button", {name: "Confirm sign-in and open Docs", exact: true})).toBeEnabled();
      expect(await page.evaluate(() => window.__onesaLinkDocumentMarker)).toBe("same-document");
      expect(new URL(page.url()).hash).toBe("");
      await expect(page.getByRole("heading", { name: "Open Engineering Docs" })).toBeVisible();
      await expect(page.getByRole("group", { name: "Sign-in method" })).toHaveCount(0);
      await expect(page.getByLabel("Email address", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Confirm sign-in and open Docs", exact: true })).toHaveCount(1);
      await expect(page.getByRole("status")).toHaveCount(0);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `confirm-${width}-${mode}.png`), fullPage: true });
      expect(engineeringConfirmations).toBe(beforeConfirmation);
      await page.getByRole("button", {name: "Confirm sign-in and open Docs", exact: true}).click();
      await page.waitForURL(origin + "/api/v1/engineering-identity/auth/" + linkUid);
      expect(engineeringConfirmations).toBe(beforeConfirmation + 1);
      expect(errors).toEqual([]);
      views.push({
        width,
        initialMode: mode,
        systemChangePreservesInput: true,
        failedPasswordRetained: true,
        bothMethodsAvailable: true,
        sameDocumentEmailLinkConfirmedExplicitly: true,
        axeViolations: 0,
        overflow: false,
      });
      await context.close();
    }
  for (const mode of (accessEnabled ? ["light", "dark"] : [])) {
    const context = await browser.newContext({ viewport: { width: 390, height: 960 }, colorScheme: mode }), page = await context.newPage();
    await page.goto(origin + "/admin", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Email and password", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Password", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Register for administrator access" })).toBeVisible();
    await page.getByRole("button", { name: "Email a sign-in link", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).first().fill("synthetic@onesa.eu");
    await page.getByRole("button", { name: "Send sign-in link", exact: true }).click();
    await expect(page.locator('section[aria-label="Administrator sign-in"]').getByRole("status")).toContainText("a sign-in link is on its way");
    const adminProofsBefore = adminConfirmations;
    await page.evaluate(() => { window.__onesaLinkDocumentMarker = "same-document"; });
    await page.goto(origin + "/admin#access-link=" + proof);
    const adminSignIn = page.locator('section[aria-label="Administrator sign-in"]');
    await expect(adminSignIn.getByLabel("Authenticator or recovery code", {exact: true})).toBeVisible();
    await expect(adminSignIn.getByLabel("Authenticator or recovery code", {exact: true})).toHaveAttribute("required", "");
    await expect(adminSignIn.getByRole("button", {name: "Sign in", exact: true})).toBeEnabled();
    expect(await page.evaluate(() => window.__onesaLinkDocumentMarker)).toBe("same-document");
    expect(new URL(page.url()).hash).toBe(""); expect(adminConfirmations).toBe(adminProofsBefore);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    views.push({ type: "admin-signin", mode, width: 390, bothMethodsAvailable: true, sameDocumentLinkRetainsMfa: true });
    await page.goto(origin + "/access/register?audience=engineering", { waitUntil: "networkidle" });
    await expect(page.locator('input[name="name"]')).toHaveCount(0);
    await page.getByLabel("Email address", { exact: true }).fill("Synthetic@Onesa.eu");
    await expect(page.getByLabel("Access requested")).toHaveValue("engineering");
    await page.getByRole("button", { name: "Email my registration link" }).click();
    await expect(page.getByRole("status")).toContainText("Check your email");
    expect(registrationRequests.at(-1)).toEqual({email: "synthetic@onesa.eu", name: "synthetic@onesa.eu", audience: "engineering"});
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    views.push({ type: "registration", mode, width: 390, approvalExplained: true });
    await page.goto(origin + "/access/register", {waitUntil: "networkidle"});
    const longEmail = "a".repeat(60) + "@" + "b".repeat(60) + "." + "c".repeat(60) + ".example.eu";
    await expect(page.locator('input[name="name"]')).toHaveCount(0);
    await expect(page.getByLabel("Access requested")).toHaveValue("admin");
    await page.getByLabel("Email address", {exact: true}).fill(longEmail);
    await page.getByRole("button", {name: "Email my registration link"}).click();
    await expect(page.getByRole("status")).toContainText("Check your email");
    expect(registrationRequests.at(-1)).toEqual({email: longEmail, name: longEmail.slice(0, 120), audience: "admin"});
    views.push({type: "registration-email-identifier", mode, width: 390, fullEmailPreserved: true});
    registrationConfirmation = {status: "pending", audience: "engineering"};
    let confirmations = 0;
    page.on("request", r => { if (r.url().endsWith("/api/v1/access/confirm")) confirmations++; });
    await page.goto(origin + "/access/confirm?source=synthetic", {waitUntil: "networkidle"});
    await expect(page.getByRole("button", {name: "Verify email and complete registration"})).toBeDisabled();
    await page.evaluate(() => { window.__onesaLinkDocumentMarker = "same-document"; });
    await page.goto(origin + "/access/confirm?source=synthetic#access-link=" + proof);
    await expect(page.getByRole("button", {name: "Verify email and complete registration"})).toBeEnabled();
    expect(await page.evaluate(() => window.__onesaLinkDocumentMarker)).toBe("same-document");
    expect(new URL(page.url()).search).toBe("?source=synthetic");
    expect(confirmations).toBe(0); expect(new URL(page.url()).hash).toBe("");
    await page.getByLabel("Password (at least 14 characters)").fill("synthetic-registration-password");
    await page.getByLabel("Confirm password", { exact: true }).fill("different-password");
    await page.getByRole("button", { name: "Verify email and complete registration" }).click();
    await expect(page.locator('section[aria-labelledby="registration-title"]').getByRole("alert")).toContainText("passwords must match"); expect(confirmations).toBe(0);
    await page.getByLabel("Confirm password", { exact: true }).fill("synthetic-registration-password");
    await page.getByRole("button", { name: "Verify email and complete registration" }).click();
    await expect(page.getByRole("status")).toContainText("sent to the owner for approval"); expect(confirmations).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    views.push({ type: "registration-confirmation", mode, width: 390, emailScannerDoesNotConsume: true, sameDocumentLinkRecognized: true });
    for (const audience of ["engineering", "admin"]) {
      registrationConfirmation = {status: "approved", audience};
      await page.goto(origin + "/access/confirm?approved=" + audience + "#access-link=" + proof, {waitUntil: "networkidle"});
      await page.getByLabel("Password (at least 14 characters)").fill("synthetic-registration-password");
      await page.getByLabel("Confirm password", {exact: true}).fill("synthetic-registration-password");
      await page.getByRole("button", {name: "Verify email and complete registration"}).click();
      await expect(page.getByRole("status")).toContainText("Registration is complete");
      if (audience === "engineering") {
        await expect(page.getByRole("status")).toContainText("You can now sign in to Engineering Docs");
        await expect(page.getByRole("status")).not.toContainText("authenticator");
      } else await expect(page.getByRole("status")).toContainText("New administrators must enroll their authenticator");
      views.push({type: "approved-registration", audience, mode, width: 390, correctAudienceInstructions: true});
    }
    await context.close();
  }
  if (!accessEnabled) {
    for (const mode of ["light", "dark"]) {
      const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:mode}),page=await context.newPage();
      await page.goto(origin+"/admin",{waitUntil:"networkidle"});
      await expect(page.getByLabel("Email",{exact:true}).first()).toBeVisible();
      await expect(page.getByLabel("Password",{exact:true}).first()).toBeVisible();
      await expect(page.getByLabel("Authenticator or recovery code",{exact:true})).toBeVisible();
      await expect(page.getByRole("button",{name:"Email a sign-in link",exact:true})).toHaveCount(0);
      await expect(page.getByRole("link",{name:"Register for administrator access"})).toHaveCount(0);
      for(const path of ["/access/register","/access/confirm","/engineering/sign-in/synthetic_disabled_01"]){
        const response=await page.request.get(origin+path);expect(response.status()).toBe(404);
      }
      expect((await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze()).violations).toEqual([]);
      views.push({mode,width:390,pendingControlsHidden:true,existingPasswordMfaPreserved:true});await context.close();
    }
  }
  expect(tokenInRequestUrl).toBe(false);
  console.log(
    JSON.stringify({
      status: "PASS",
      scope:
        "Isolated production renderer and synthetic mock API; backend protocol tested separately; no hosted/provider acceptance claimed",
      views: views.length,
      accessEnabled,
      mailSent: 0,
      databaseRequests: 0,
      providerRequests: 0,
    }),
  );
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await new Promise((resolve) => api.close(resolve));
}
