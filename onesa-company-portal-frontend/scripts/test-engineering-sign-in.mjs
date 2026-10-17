/** Isolated production-renderer UI regression. No provider, database or email access. */
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const states = new Map(),
  proxyKey = "synthetic-ui-proxy-only",
  proof = "a".repeat(64);
const api = http.createServer(async (req, res) => {
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
    if (!JSON.parse(body).email) { res.writeHead(400).end("{}"); return; }
    res.writeHead(202).end('{"ok":true}'); return;
  }
  if (req.url === "/api/v1/access/confirm") {
    let body = ""; for await (const c of req) body += c;
    const input = JSON.parse(body);
    if (input.token !== "a".repeat(64) || input.password.length < 14) { res.writeHead(401).end("{}"); return; }
    res.end('{"status":"pending","audience":"engineering"}'); return;
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
  ENGINEERING_SIGNIN_ENABLED: "true",
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
        origin + "/engineering/sign-in/synthetic_ready_01",
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
  const views = [];
  for (const width of [320, 390, 768, 1440])
    for (const mode of ["light", "dark"]) {
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
      await expect(page.getByRole("status")).toContainText("a sign-in link is on its way");
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
      views.push({
        width,
        initialMode: mode,
        systemChangePreservesInput: true,
        failedPasswordRetained: true,
        bothMethodsAvailable: true,
        axeViolations: 0,
        overflow: false,
      });
      await context.close();
    }
  for (const mode of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 960 }, colorScheme: mode }), page = await context.newPage();
    await page.goto(origin + "/admin", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Email and password", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Password", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Register for administrator access" })).toBeVisible();
    await page.getByRole("button", { name: "Email a sign-in link", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).first().fill("synthetic@onesa.eu");
    await page.getByRole("button", { name: "Send sign-in link", exact: true }).click();
    await expect(page.locator('section[aria-label="Administrator sign-in"]').getByRole("status")).toContainText("a sign-in link is on its way");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    views.push({ type: "admin-signin", mode, width: 390, bothMethodsAvailable: true });
    await page.goto(origin + "/access/register?audience=engineering", { waitUntil: "networkidle" });
    await page.getByLabel("Your name").fill("Synthetic engineer"); await page.getByLabel("Email address", { exact: true }).fill("synthetic@onesa.eu");
    await expect(page.getByLabel("Access requested")).toHaveValue("engineering");
    await page.getByRole("button", { name: "Email my registration link" }).click();
    await expect(page.getByRole("status")).toContainText("Check your email");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    views.push({ type: "registration", mode, width: 390, approvalExplained: true });
    let confirmations = 0;
    page.on("request", r => { if (r.url().endsWith("/api/v1/access/confirm")) confirmations++; });
    await page.goto(origin + "/access/confirm#access-link=" + "a".repeat(64), { waitUntil: "networkidle" });
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
    views.push({ type: "registration-confirmation", mode, width: 390, emailScannerDoesNotConsume: true });
    await context.close();
  }
  console.log(
    JSON.stringify({
      status: "PASS",
      scope:
        "Isolated production renderer and synthetic mock API; backend protocol tested separately; no hosted/provider acceptance claimed",
      views: views.length,
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
