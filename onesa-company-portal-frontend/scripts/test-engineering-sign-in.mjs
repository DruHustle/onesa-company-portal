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
  const match = req.url.match(
    /^\/api\/v1\/engineering-sign-in\/([A-Za-z0-9_-]+)\/(details|start|verify)$/,
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
  if (action === "start") {
    states.set(uid, true);
    res.end('{"ok":true}');
    return;
  }
  if (input.code !== "123456") {
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
        (r) => r.url() === origin + "/engineering/sign-in/" + uid + "/start",
      );
      await page
        .getByRole("button", { name: "Email me a sign-in code" })
        .click();
      expect((await started).status()).toBe(200);
      const code = page.getByLabel("Sign-in code");
      await expect(code).toBeFocused();
      await code.fill("000000");
      await page.getByRole("button", { name: "Verify and open Docs" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(code).toHaveValue("000000");
      await expect(
        page.getByRole("button", { name: "Verify and open Docs" }),
      ).toBeEnabled();
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
      await code.fill("123456");
      await page.getByRole("button", { name: "Verify and open Docs" }).click();
      await page.waitForURL(
        origin + "/api/v1/engineering-identity/auth/" + uid,
      );
      views.push({
        width,
        initialMode: mode,
        systemChangePreservesInput: true,
        invalidCodeRetained: true,
        axeViolations: 0,
        overflow: false,
      });
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
