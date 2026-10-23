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
const signInChoices = new Map();
let registrationConfirmation = {status: "pending", audience: "engineering"};
let enrollmentGate = null, enrollmentCalls = 0, verificationCalls = 0;
const syntheticRecoveryCodes = Array.from({length: 8}, (_, i) => String(i).repeat(24));
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
  if (req.url === "/api/v1/auth/mfa/enroll") {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); enrollmentCalls++;
    if (input.password !== "synthetic-registration-password") { res.writeHead(403).end('{"error":{"message":"Enrollment not available"}}'); return; }
    if (enrollmentGate) await enrollmentGate;
    res.end(JSON.stringify({challenge: proof, secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/Onesa:synthetic?secret=JBSWY3DPEHPK3PXP&issuer=Onesa"})); return;
  }
  if (req.url === "/api/v1/auth/mfa/verify") {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); verificationCalls++;
    if (input.challenge !== proof || input.code !== "123456") { res.writeHead(401).end('{"error":{"message":"Invalid MFA code"}}'); return; }
    res.end(JSON.stringify({recoveryCodes: syntheticRecoveryCodes})); return;
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
    /^\/api\/v1\/engineering-sign-in\/([A-Za-z0-9_-]+)\/(details|link|password|link-verify|link-prepare|handoff-verify|session)$/,
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
    res.end(JSON.stringify({ csrf: proof, emailSent: states.has(uid), linkResendSeconds: states.has(uid) ? 30 : 0, ...(uid.startsWith("synthetic_session_") ? {onesaAccount:{email:"synthetic-engineer@onesa.eu"}} : {}), ...(req.headers.cookie?.includes("onesa_ui_handoff=fixture") ? {linkEmail: "synthetic-engineer@onesa.eu"} : {}) }));
    return;
  }
  const input = JSON.parse(body);
  signInChoices.set(uid+"/"+action,input.rememberBrowser);
  if (action === "link-prepare") {
    if (input.token !== proof) { res.writeHead(401).end('{}'); return; }
    res.setHeader('set-cookie', 'onesa_ui_handoff=fixture; Path=/; HttpOnly; SameSite=Lax');
    res.end(JSON.stringify({continuePath: '/engineering'})); return;
  }
  if (input.csrf !== proof) {
    res.writeHead(403).end("{}");
    return;
  }
  if (action === "link") {
    states.set(uid, input.email);
    res.end('{"ok":true}');
    return;
  }
  if (action === "password" && input.password !== "synthetic-valid-password") {
    res.writeHead(401).end('{"error":"synthetic-invalid-code"}');
    return;
  }
  if (action === "link-verify" || action === "handoff-verify") {
    if (action === "link-verify" && input.token !== proof) { res.writeHead(401).end("{}"); return; }
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
async function verifyOpeningHandoff(page, uid, submitButton) {
  const destination = origin + "/api/v1/engineering-identity/auth/" + uid;
  const frames = [], binding = "__onesaOpening_" + uid;
  await page.exposeFunction(binding, frame => frames.push(frame));
  await page.evaluate(name => {
    new MutationObserver(() => {
      window[name]({
        heading: document.querySelector("#engineering-title")?.textContent,
        status: document.querySelector('#engineering-sign-in [role="status"]')?.textContent,
        forms: document.querySelectorAll("#engineering-sign-in form").length,
        selectors: document.querySelectorAll('.signin-methods').length,
      });
    }).observe(document.querySelector(".engineering-auth-shell"), {childList: true, subtree: true, characterData: true});
  }, binding);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { reached = resolve; });
  const handler = async route => {
    reached();
    await gate;
    await route.fulfill({status: 200, contentType: "text/html", body: "<!doctype html><title>Synthetic callback</title><main>Isolated callback</main>"});
  };
  await page.route(destination, handler);
  try {
    await submitButton.click({noWaitAfter: true});
    await Promise.race([requested, delay(5000).then(() => { throw Error("Opening callback was not requested within the existing sign-in UI bound"); })]);
    // Locator actions wait for pending navigation. Observe the old document's
    // actual DOM transitions while the destination response is deliberately held.
    await expect.poll(() => frames.some(frame => frame.heading === "Opening Engineering Docs")).toBe(true);
    expect(frames.at(-1)).toEqual({heading: "Opening Engineering Docs", status: "Please wait…", forms: 0, selectors: 0});
    release();
    await page.waitForURL(destination);
  } finally {
    release();
    await page.unroute(destination, handler);
  }
}
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
      await expect(page.getByRole("status")).toHaveText("Sent.");
      await expect(page.getByLabel("Email address")).toBeDisabled();
      await expect(page.getByRole("button", { name: /^Send another link/ })).toBeDisabled();
      await expect(page.getByRole("status")).toBeVisible();
      await expect(page.getByRole("status")).toBeFocused();
      await expect(page.getByRole("button", {name: "Sent", exact: true})).toHaveCount(0);
      await page.clock.fastForward(29000);
      await expect(page.getByRole("button", {name: /^Send another link/})).toBeDisabled();
      await page.clock.fastForward(1000);
      const resend = page.getByRole("button", { name: /^Send another link/ });
      await expect(resend).toBeEnabled();
      const resent = page.waitForResponse(r => r.url() === origin + "/engineering/sign-in/synthetic_loading_01/link");
      await resend.click();
      expect((await resent).status()).toBe(200);
      await expect(page.getByRole("button", { name: /^Send another link/ })).toBeDisabled();
      await expect(page.getByLabel("Email address")).toBeDisabled();
      expect(states.get("synthetic_loading_01")).toBe("synthetic-engineer@onesa.eu");
      await page.getByRole("button", {name: "Email and password", exact: true}).click();
      await page.getByLabel("Email address").fill("other-synthetic@onesa.eu");
      await page.getByRole("button", {name: "Email a sign-in link", exact: true}).click();
      await expect(page.getByRole("status")).toHaveCount(0);
      await expect(page.getByRole("button", {name: "Sent", exact: true})).toHaveCount(0);
      await expect(page.getByLabel("Email address")).toBeDisabled();
      await page.clock.fastForward(30000);
      await page.getByRole("button", {name: "Send sign-in link", exact: true}).click();
      await expect(page.getByRole("status")).toHaveText("Sent.");
      expect(states.get("synthetic_loading_01")).toBe("other-synthetic@onesa.eu");
      await page.reload({waitUntil:"networkidle"});
      await expect(page.getByRole("status")).toHaveText("Sent.");
      await expect(page.getByRole("button",{name:/^Send another link/})).toBeDisabled();
      await page.clock.fastForward(30000);
      await page.getByRole("button",{name:"Send another link",exact:true}).click();
      await expect(page.getByLabel("Email address")).toBeEnabled();
      await expect(page.getByLabel("Email address")).toHaveValue("");
    } finally { releaseDetails(); await context.close(); }
  }
  if (accessEnabled) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({viewport: {width: 320, height: 568}, colorScheme});
      const page = await context.newPage();
      let releaseSend;
      const sendGate = new Promise(resolve => { releaseSend = resolve; });
      let requests = 0;
      await page.route("**/engineering/sign-in/synthetic_pending_01/link", async route => {
        requests++;
        if (requests === 1) { await sendGate; await route.fulfill({status: 503, json: {error: {code: "BACKEND_UNAVAILABLE"}}}); }
        else await route.fulfill({status: 200, json: {ok: true}});
      });
      try {
        await page.goto(origin + "/engineering/sign-in/synthetic_pending_01", {waitUntil: "networkidle"});
        const email = page.getByLabel("Email address", {exact: true});
        const send = page.locator('form button[type="submit"]');
        await email.fill("synthetic-engineer@onesa.eu");
        const activeInput = await email.evaluate(el => getComputedStyle(el).backgroundColor);
        const activeButton = await send.evaluate(el => getComputedStyle(el).backgroundColor);
        await send.click();
        await expect(email).toBeDisabled();
        await expect(send).toBeDisabled();
        await expect(send).toHaveText("Sending…");
        await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
        await expect.poll(() => email.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(activeInput);
        await expect.poll(() => send.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(activeButton);
        await expect(email).toHaveCSS("cursor", "not-allowed");
        await expect(send).toHaveCSS("cursor", "not-allowed");
        await send.hover({force: true});
        await expect(send).toHaveCSS("transform", "none");
        await expect(send).toHaveCSS("box-shadow", "none");
        await page.locator("form").evaluate(form => {
          form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
          form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
        });
        expect(requests).toBe(1);
        releaseSend();
        await expect(page.locator("#engineering-sign-in").getByRole("alert")).toContainText("temporarily unavailable");
        await expect(email).toBeEnabled();
        await expect(email).toHaveValue("synthetic-engineer@onesa.eu");
        await expect(send).toBeEnabled();
        await send.click();
        await expect(page.getByRole("status")).toHaveText("Sent.");
        await expect(page.locator("#engineering-sign-in").getByRole("alert")).toHaveCount(0);
        await expect(email).toBeDisabled();
        await expect(page.getByRole("button", {name: /^Send another link/})).toBeDisabled();
        expect(requests).toBe(2);
      } finally { releaseSend(); await context.close(); }
    }
    const context = await browser.newContext({viewport: {width: 390, height: 844}}), page = await context.newPage();
    try {
      await page.goto(origin + "/engineering/sign-in/synthetic_expired_01", {waitUntil: "networkidle"});
      await page.route("**/engineering/sign-in/synthetic_expired_01/link", route => route.fulfill({status: 401, json: {error: {code: "ENGINEERING_INTERACTION"}}}));
      await page.getByLabel("Email address").fill("synthetic-engineer@onesa.eu");
      await page.getByRole("button", {name: "Send sign-in link", exact: true}).click();
      await expect(page.locator("#engineering-sign-in").getByRole("alert")).toContainText("no longer active in this browser");
      await expect(page.locator("form")).toHaveCount(0);
      await expect(page.getByRole("link", {name: "Start a new sign-in", exact: true})).toHaveAttribute("href", "/engineering");
      await page.route("**/engineering/sign-in/synthetic_expired_load_01/details", route => route.fulfill({status: 401, json: {error: {code: "ENGINEERING_INTERACTION"}}}));
      await page.goto(origin + "/engineering/sign-in/synthetic_expired_load_01", {waitUntil: "networkidle"});
      await expect(page.getByRole("link", {name: "Start a new sign-in", exact: true})).toBeVisible();
      await expect(page.locator("form")).toHaveCount(0);
      await page.goto(origin + "/engineering/sign-in/synthetic_malformed_01", {waitUntil: "networkidle"});
      await page.route("**/engineering/sign-in/synthetic_malformed_01/link", route => route.fulfill({status: 200, json: {unexpected: true}}));
      await page.getByLabel("Email address").fill("synthetic-engineer@onesa.eu");
      await page.getByRole("button", {name: "Send sign-in link", exact: true}).click();
      await expect(page.locator("#engineering-sign-in").getByRole("alert")).toContainText("could not be confirmed");
      await expect(page.getByRole("button", {name: "Sent", exact: true})).toHaveCount(0);
      await expect(page.getByLabel("Email address")).toBeEnabled();
      for (const [code, status, message] of [
        ["ENGINEERING_REGISTRATION_REQUIRED", 401, "Complete Engineering Docs registration"],
        ["ENGINEERING_APPROVAL_PENDING", 403, "awaiting owner approval"],
        ["CREDENTIALS", 401, "Email or password is incorrect"],
      ]) {
        const uid = "synthetic_password_" + code;
        await page.goto(origin + "/engineering/sign-in/" + uid, {waitUntil: "networkidle"});
        await page.route("**/engineering/sign-in/" + uid + "/password", route => route.fulfill({status, json: {error: {code}}}));
        await page.getByRole("button", {name: "Email and password", exact: true}).click();
        await page.getByLabel("Email address").fill("synthetic-engineer@onesa.eu");
        await page.getByLabel("Password", {exact: true}).fill("synthetic-invalid-password");
        await page.getByRole("button", {name: "Sign in to Docs", exact: true}).click();
        await expect(page.locator("#engineering-sign-in").getByRole("alert")).toContainText(message);
        await expect(page.getByLabel("Password", {exact: true})).toHaveValue("synthetic-invalid-password");
        await expect(page.getByRole("button", {name: "Sign in to Docs", exact: true})).toBeEnabled();
        if (code === "ENGINEERING_REGISTRATION_REQUIRED") await expect(page.locator("#engineering-sign-in").getByRole("alert").getByRole("link", {name: "Register for Engineering Docs"})).toHaveAttribute("href", "/access/register?audience=engineering");
        await page.getByRole("button", {name: "Email a sign-in link", exact: true}).click();
        await expect(page.locator("#engineering-sign-in").getByRole("alert")).toHaveCount(0);
      }
      await page.route("**/engineering/sign-in/synthetic_unavailable_01/details", route => route.fulfill({status: 503, json: {error: {code: "BACKEND_UNAVAILABLE"}}}));
      await page.goto(origin + "/engineering/sign-in/synthetic_unavailable_01", {waitUntil: "networkidle"});
      await expect(page.locator("#engineering-sign-in").getByRole("alert")).toContainText("service is temporarily unavailable");
      await expect(page.locator("#engineering-sign-in").getByRole("alert")).not.toContainText("expired");
      await expect(page.getByRole("link", {name: "Start a new sign-in", exact: true})).toBeVisible();
      await page.goto(origin + "/engineering/sign-in/synthetic_timeout_01", {waitUntil: "networkidle"});
      await page.clock.install();
      let releaseTimeout;
      const timeoutGate = new Promise(resolve => {releaseTimeout = resolve;});
      await page.route("**/engineering/sign-in/synthetic_timeout_01/link", async route => {await timeoutGate; await route.abort().catch(() => {});});
      try {
        await page.getByLabel("Email address").fill("synthetic-engineer@onesa.eu");
        await page.getByRole("button", {name: "Send sign-in link", exact: true}).click();
        await expect(page.getByLabel("Email address")).toBeDisabled();
        await page.clock.fastForward(25000);
        await expect(page.locator("#engineering-sign-in").getByRole("alert")).toContainText("took too long");
        await expect(page.getByLabel("Email address")).toBeEnabled();
        await expect(page.getByLabel("Email address")).toHaveValue("synthetic-engineer@onesa.eu");
      } finally {releaseTimeout();}
    } finally {await context.close();}
  }
  const screenshotDir = process.env.ONESA_SIGNIN_SCREENSHOTS;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true, mode: 0o700 });
  const views = [];
  if(accessEnabled)for(const colorScheme of ["light","dark"]){
    const context=await browser.newContext({viewport:{width:390,height:844},colorScheme}),page=await context.newPage();
    const uid="synthetic_session_"+colorScheme;
    states.set(uid,"synthetic-engineer@onesa.eu");
    await page.goto(origin+"/engineering/sign-in/"+uid,{waitUntil:"networkidle"});
    const remember=page.getByRole("checkbox",{name:"Remember this browser",exact:true});
    await expect(remember).not.toBeChecked();
    await expect(page.getByRole("button",{name:"Continue with Onesa",exact:true})).toBeEnabled();
    await expect(page.getByRole("button",{name:/^Send another link/})).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("group",{name:"Sign-in method"})).toHaveCount(0);
    await expect(page.getByLabel("Email address",{exact:true})).toHaveCount(0);
    await remember.check();
    expect((await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button",{name:"Use another account",exact:true}).click();
    await expect(page.getByLabel("Email address",{exact:true})).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Sent.");
    await page.getByRole("button",{name:"Email and password",exact:true}).click();
    await expect(remember).toBeChecked();
    await page.reload({waitUntil:"networkidle"});
    await remember.check();
    await verifyOpeningHandoff(page,uid,page.getByRole("button",{name:"Continue with Onesa",exact:true}));
    expect(signInChoices.get(uid+"/session")).toBe(true);
    views.push({type:"existing-approved-Onesa-session",colorScheme,width:390,explicitConfirmation:true,rememberOptIn:true,canUseAnotherAccount:true,axeViolations:0});
    await context.close();
  }
  for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({viewport:{width:320,height:568},colorScheme}), page=await context.newPage();
    try {
      let requests=0, release;
      const gate=new Promise(resolve=>{release=resolve;});
      await page.route("**/api/v1/auth/login", async route=>{
        requests++;const body=route.request().postDataJSON();
        if(body.email==="new-admin@onesa.eu"){
          await route.fulfill({status:403,json:{error:{code:"MFA_ENROLLMENT_REQUIRED",message:"Set up your authenticator"}}}); return;
        }
        if(body.password!=="synthetic-valid-password"){
          await route.fulfill({status:401,json:{error:{code:"CREDENTIALS",message:"Invalid credentials"}}});return;
        }
        await gate;
        await route.fulfill({status:401,json:{error:{code:body.code?"MFA":"MFA_REQUIRED",message:body.code?"Invalid MFA code":"Enter your authenticator code"}}});
      });
      await page.goto(origin+"/admin",{waitUntil:"networkidle"});
      const admin=page.locator('section[aria-label="Administrator sign-in"]');
      await expect(admin.getByLabel("Authenticator or recovery code",{exact:true})).toHaveCount(0);
      await admin.getByLabel("Email",{exact:true}).fill("enrolled@onesa.eu");
      await admin.getByLabel("Password",{exact:true}).fill("synthetic-valid-password");
      await admin.locator("form").evaluate(form=>{form.requestSubmit();form.requestSubmit();});
      await expect.poll(()=>requests).toBe(1);
      await expect(admin.getByRole("button",{name:"Please wait…",exact:true})).toBeDisabled();
      release();
      await expect(admin.getByLabel("Authenticator or recovery code",{exact:true})).toBeVisible();
      await expect(admin.getByLabel("Authenticator or recovery code",{exact:true})).toBeFocused();
      await admin.getByLabel("Authenticator or recovery code",{exact:true}).fill("000000");
      await admin.getByRole("button",{name:"Sign in",exact:true}).click();
      await expect(admin.getByRole("alert")).toHaveText("Invalid MFA code");
      await admin.getByLabel("Email",{exact:true}).fill("new-admin@onesa.eu");
      await expect(admin.getByLabel("Authenticator or recovery code",{exact:true})).toHaveCount(0);
      await admin.getByRole("button",{name:"Continue",exact:true}).click();
      await expect(admin.getByRole("link",{name:"Set up your authenticator",exact:true})).toHaveAttribute("href","/access/setup-authenticator");
      await expect(admin.getByLabel("Authenticator or recovery code",{exact:true})).toHaveCount(0);
      await expect(admin.getByRole("status")).toContainText("needs authenticator setup");
      expect((await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze()).violations).toEqual([]);
      views.push({type:"credential-verified-admin-mfa",colorScheme,width:320,noEmailOnlyLookup:true,unenrolledGetsSetup:true,enrolledGetsFactor:true,duplicateBlocked:true});
    } finally {await context.close();}
  }
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
      const selectorBackground = await page.getByRole("button", {name: "Email a sign-in link", exact: true}).evaluate(el => getComputedStyle(el).backgroundColor);
      const primaryBackground = await page.getByRole("button", {name: "Send sign-in link", exact: true}).evaluate(el => getComputedStyle(el).backgroundColor);
      expect(selectorBackground).not.toBe(primaryBackground);
      const remember=page.getByRole("checkbox",{name:"Remember this browser",exact:true});
      await expect(remember).not.toBeChecked();
      expect(await remember.locator("..").evaluate(el=>getComputedStyle(el).flexDirection)).toBe("row");
      await remember.check();
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
      expect(signInChoices.get(uid+"/link")).toBe(true);
      await expect(page.getByRole("status")).toHaveText("Sent.");
      await expect(page.locator("form")).toBeVisible();
      await expect(email).toBeDisabled();
      await expect(page.getByRole("button", {name: "Sent", exact: true})).toHaveCount(0);
      await expect(page.getByRole("status")).toBeVisible();
      await expect(page.getByRole("link", { name: "Register for Engineering Docs" })).toHaveCount(0);
      await page.getByRole("button", {name:"Email and password",exact:true}).click();
      const password = page.getByLabel("Password", {exact:true});
      await expect(remember).toBeChecked();
      await password.fill("synthetic-invalid-password");
      await page.getByRole("button", {name:"Sign in to Docs",exact:true}).click();
      await expect(page.locator("#engineering-sign-in").getByRole("alert")).toBeVisible();
      expect(signInChoices.get(uid+"/password")).toBe(true);
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
      await verifyOpeningHandoff(page, uid, page.getByRole("button", { name: "Sign in to Docs" }));
      const linkUid = uid + "_same_page", beforeConfirmation = engineeringConfirmations;
      await page.goto(origin + "/engineering/sign-in/" + linkUid, {waitUntil: "networkidle"});
      await page.getByLabel("Email address", {exact: true}).fill("synthetic-engineer@onesa.eu");
      await page.getByRole("button", {name: "Send sign-in link", exact: true}).click();
      await expect(page.getByRole("status")).toHaveText("Sent.");
      const freshUid = linkUid + "_fresh";
      await page.route(origin + "/engineering", route => route.fulfill({status: 303, headers: {location: origin + "/engineering/sign-in/" + freshUid}}));
      await page.evaluate(() => { window.__onesaLinkDocumentMarker = "old-request"; });
      await page.goto(origin + "/engineering/sign-in/" + linkUid + "#access-link=" + proof);
      await expect(page.getByRole("button", {name: "Confirm sign-in and open Docs", exact: true})).toBeEnabled();
      await page.waitForURL(origin + "/engineering/sign-in/" + freshUid);
      expect(await page.evaluate(() => window.__onesaLinkDocumentMarker)).toBeUndefined();
      await expect(page.getByText("synthetic-engineer@onesa.eu", {exact: true})).toBeVisible();
      expect(await page.evaluate(() => [localStorage,sessionStorage].some(store=>Object.values(store).some(value=>value.includes("a".repeat(64)))))).toBe(false);
      expect(new URL(page.url()).hash).toBe("");
      await expect(page.getByRole("heading", { name: "Open Engineering Docs" })).toBeVisible();
      await expect(page.getByRole("group", { name: "Sign-in method" })).toHaveCount(0);
      await expect(page.getByLabel("Email address", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Confirm sign-in and open Docs", exact: true })).toHaveCount(1);
      await expect(page.getByRole("status")).toHaveCount(0);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `confirm-${width}-${mode}.png`), fullPage: true });
      expect(engineeringConfirmations).toBe(beforeConfirmation);
      await verifyOpeningHandoff(page, freshUid, page.getByRole("button", {name: "Confirm sign-in and open Docs", exact: true}));
      expect(engineeringConfirmations).toBe(beforeConfirmation + 1);
      expect(errors).toEqual([]);
      views.push({
        width,
        initialMode: mode,
        systemChangePreservesInput: true,
        failedPasswordRetained: true,
        bothMethodsAvailable: true,
        freshBrowserRequestAndExplicitIdentityConfirmation: true,
        delayedCallbackShowsOpeningStateWithoutSignInFlash: true,
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
    const remember=page.getByRole("checkbox",{name:"Remember this browser",exact:true});
    await expect(remember).not.toBeChecked();
    await remember.check();
    await expect(page.getByRole("link", { name: "Register for administrator access" })).toBeVisible();
    await page.getByRole("button", { name: "Email a sign-in link", exact: true }).click();
    await page.clock.install();
    let sends=0, releaseSend;
    const sendGate=new Promise(resolve=>{releaseSend=resolve;});
    await page.route("**/api/v1/access/link",async route=>{sends++;await sendGate;await route.fulfill({status:202,json:{ok:true}});});
    await page.getByLabel("Email", { exact: true }).first().fill("synthetic@onesa.eu");
    await page.locator('section[aria-label="Administrator sign-in"] form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});
    await expect.poll(()=>sends).toBe(1);
    releaseSend();
    await expect(page.locator('section[aria-label="Administrator sign-in"]').getByRole("status")).toHaveText("Sent.");
    await expect(page.getByLabel("Email", {exact:true}).first()).toBeDisabled();
    await expect(page.getByRole("button", {name:/^Send another link/})).toBeDisabled();
    const sentEmail=page.getByLabel("Email",{exact:true}).first();
    expect(await sentEmail.evaluate(el=>getComputedStyle(el).cursor)).toBe("not-allowed");
    await page.clock.fastForward(29000);
    await expect(page.getByRole("button",{name:/^Send another link/})).toBeDisabled();
    expect(sends).toBe(1);
    await page.clock.fastForward(1000);
    await page.getByRole("button",{name:"Send another link",exact:true}).click();
    await expect.poll(()=>sends).toBe(2);
    await expect(page.getByRole("button",{name:/^Send another link/})).toBeDisabled();
    await page.clock.fastForward(30000);
    await page.route("**/api/v1/access/link",async route=>route.fulfill({status:503,json:{error:{message:"Synthetic temporary send failure"}}}));
    await page.getByRole("button",{name:"Send another link",exact:true}).click();
    await expect(page.locator('section[aria-label="Administrator sign-in"]').getByRole("alert")).toContainText("Synthetic temporary send failure");
    await expect(page.locator('section[aria-label="Administrator sign-in"]').getByRole("status")).toHaveCount(0);
    await expect(page.getByLabel("Email",{exact:true}).first()).toBeEnabled();
    await expect(page.getByLabel("Email",{exact:true}).first()).toHaveValue("synthetic@onesa.eu");
    await page.unroute("**/api/v1/access/link");
    const adminProofsBefore = adminConfirmations;
    await page.evaluate(() => { window.__onesaLinkDocumentMarker = "same-document"; });
    await page.goto(origin + "/admin#access-link=" + proof);
    const adminSignIn = page.locator('section[aria-label="Administrator sign-in"]');
    await expect(adminSignIn.getByLabel("Authenticator or recovery code", {exact: true})).toHaveCount(0);
    await page.route("**/api/v1/access/link/verify", async route => { await route.fulfill({status:401,json:{error:{code:"MFA_REQUIRED",message:"Enter your authenticator code"}}}); });
    await adminSignIn.getByRole("button", {name:"Confirm sign-in link",exact:true}).click();
    await expect(adminSignIn.getByLabel("Authenticator or recovery code", {exact: true})).toBeVisible();
    await page.unroute("**/api/v1/access/link/verify");
    await expect(adminSignIn.getByLabel("Authenticator or recovery code", {exact: true})).toHaveAttribute("required", "");
    await expect(adminSignIn.getByRole("button", {name: "Sign in", exact: true})).toBeEnabled();
    await expect(remember).toBeChecked();
    let adminRemember;
    await page.route("**/api/v1/access/link/verify",async route=>{adminRemember=route.request().postDataJSON().rememberBrowser;await route.fulfill({status:401,json:{error:{message:"Synthetic invalid factor"}}});});
    await adminSignIn.getByLabel("Authenticator or recovery code",{exact:true}).fill("000000");
    await adminSignIn.getByRole("button",{name:"Sign in",exact:true}).click();
    await expect(adminSignIn.getByRole("alert")).toContainText("Synthetic invalid factor");
    expect(adminRemember).toBe(true);
    await expect(remember).toBeChecked();
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
        await expect(page.getByRole("link", {name: "Set up your authenticator", exact: true})).toHaveCount(0);
      } else {
        await expect(page.getByRole("status")).toContainText("New administrators must enroll their authenticator");
        await page.getByRole("link", {name: "Set up your authenticator", exact: true}).click();
        await expect(page.getByRole("heading", {name: "Set up your authenticator"})).toBeVisible();
        await page.getByLabel("Email address", {exact: true}).fill("synthetic@onesa.eu");
        await page.getByLabel("Registered password").fill("incorrect-synthetic-password");
        await page.getByRole("button", {name: "Start authenticator setup"}).click();
        await expect(page.getByRole("main").getByRole("alert")).toContainText("after administrator registration and approval");
        await expect(page.getByLabel("Setup key")).toHaveCount(0);
        await page.getByLabel("Registered password").fill("synthetic-registration-password");
        let releaseEnrollment;enrollmentGate=new Promise(resolve=>{releaseEnrollment=resolve;});
        const callsBefore=enrollmentCalls;
        try {
          await page.getByRole("button", {name: "Start authenticator setup"}).click();
          await expect(page.getByLabel("Registered password")).toBeDisabled();
          await expect(page.getByRole("button", {name: "Please wait…",exact: true})).toBeDisabled();
          await expect.poll(()=>enrollmentCalls).toBe(callsBefore+1);
        } finally { releaseEnrollment();enrollmentGate=null; }
        await expect(page.getByLabel("Setup key")).toHaveText("JBSWY3DPEHPK3PXP");
        await expect(page.locator('input[type="password"]')).toHaveCount(0);
        await page.getByLabel("Six-digit authenticator code").fill("000000");
        await page.getByRole("button", {name: "Verify authenticator",exact: true}).click();
        await expect(page.getByRole("main").getByRole("alert")).toContainText("current six-digit code");
        await expect(page.getByLabel("Setup key")).toBeVisible();
        await page.getByLabel("Six-digit authenticator code").fill("123456");
        await page.getByRole("button", {name: "Verify authenticator",exact: true}).click();
        await expect(page.getByRole("heading", {name: "Save your recovery codes"})).toBeVisible();
        await expect(page.getByRole("list", {name: "One-use recovery codes"}).locator('li')).toHaveCount(8);
        await expect(page.getByRole("button", {name: "Continue to administrator sign-in"})).toBeDisabled();
        await expect(page.getByLabel("Setup key")).toHaveCount(0);
        expect((await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze()).violations).toEqual([]);
        await page.getByLabel("I have saved my recovery codes securely.", {exact:true}).check();
        await page.getByRole("button", {name: "Continue to administrator sign-in"}).click();
        await expect(page.getByRole("heading", {name: "Sign in",exact:true})).toBeVisible();
        await expect(page.getByRole("list", {name: "One-use recovery codes"})).toHaveCount(0);
        views.push({type:"first-admin-authenticator-setup",mode,width:390,passwordRequired:true,duplicateBlocked:true,invalidCodeRetainsSetup:true,recoveryAcknowledged:true,sessionNotCreated:true});
      }
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
      await expect(page.getByLabel("Authenticator or recovery code",{exact:true})).toHaveCount(0);
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
      requestStateControls: accessEnabled ? {lightDarkDisabledFeedback: true, duplicateBlocked: true, malformedAcknowledgementDoesNotShowSent: true, recipientChangesClearSentWithoutBypassingCooldown: true, plainSentMessageWithoutButton: true, resendDisabledUntilThirtySeconds: true, failedSendPreservesEmail: true, successfulRetryClearsError: true, expiredLoadAndSubmitRestart: true, actionablePasswordRegistrationAndApprovalErrors: true, serviceFailureNotMislabeledExpired: true, stalledRequestRecovery: true} : null,
      firstAdministratorSetup: accessEnabled ? {enrollmentCalls, verificationCalls, syntheticOnly: true, failedCodeKeepsSetup: true, recoveryAcknowledgementRequired: true, noSessionCreated: true} : null,
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
