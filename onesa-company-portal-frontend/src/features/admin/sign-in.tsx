"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api/client";
import { accessLinkToken } from "@/lib/access-link";
import type { operations } from "@/lib/api/generated/schema";
type SignedIn = operations["login"]["responses"][200]["content"]["application/json"];
export function AdminSignIn({ onSignedIn, accessEnabled }: { accessEnabled: boolean; onSignedIn: (value: SignedIn) => void }) {
  const [rememberBrowser, setRememberBrowser] = useState(false);
  const [method, setMethod] = useState<"password" | "link">("password"), [link, setLink] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(false);
  const [email, setEmail] = useState(""), [factor, setFactor] = useState<"unknown" | "required" | "setup">("unknown");
  const [sent, setSent] = useState(false), [resendUntil, setResendUntil] = useState(0), [resendSeconds, setResendSeconds] = useState(0);
  const pending = useRef(false), formRef = useRef<HTMLFormElement>(null), codeRef = useRef<HTMLInputElement>(null), statusRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!accessEnabled) return;
    const receiveLink = () => {
      const raw = accessLinkToken(window.location.hash);
      if (raw) { setLink(raw); setMethod("link"); setFactor("unknown"); setSent(false); setNotice(""); setError(false); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    };
    receiveLink();
    window.addEventListener("hashchange", receiveLink);
    return () => window.removeEventListener("hashchange", receiveLink);
  }, [accessEnabled]);
  useEffect(() => {
    if (!resendUntil) return;
    const tick = () => setResendSeconds(Math.max(0, Math.ceil((resendUntil - performance.now()) / 1000)));
    tick(); const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [resendUntil]);
  useEffect(() => { if (factor === "required") codeRef.current?.focus(); }, [factor]);
  useEffect(() => { if (sent) statusRef.current?.focus(); }, [sent]);
  function chooseMethod(value: "link" | "password") { setMethod(value); setFactor("unknown"); setNotice(""); setError(false); }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const sendingLink = method === "link" && !link;
    if (pending.current || (sendingLink && performance.now() < resendUntil)) return;
    const data = new FormData(e.currentTarget); pending.current = true; setBusy(true); setNotice(""); setError(false);
    if (sendingLink) setSent(false);
    try {
      if (method === "password") {
        const result = await api.POST("/api/v1/auth/login", { body: { email, password: String(data.get("password")), ...(factor === "required" ? {code: String(data.get("code"))} : {}), rememberBrowser } });
        onSignedIn(result.data!);
      } else if (link) {
        const result = await api.POST("/api/v1/access/link/verify", { body: { token: link, ...(factor === "required" ? {code: String(data.get("code"))} : {}), rememberBrowser } });
        setLink(null); onSignedIn(result.data!);
      } else {
        const result = await api.POST("/api/v1/access/link", { body: { email } });
        if (result.data?.ok !== true) throw Error("The request could not be confirmed. Please try again.");
        setSent(true); setResendSeconds(30); setResendUntil(performance.now() + 30000);
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "MFA_REQUIRED") {
        setFactor("required"); setNotice("Enter the code from your authenticator app or a saved recovery code.");
      } else if (reason instanceof ApiError && reason.code === "MFA_ENROLLMENT_REQUIRED") {
        setFactor("setup"); setNotice("Your account needs authenticator setup before you can sign in.");
      } else { setError(true); setNotice(reason instanceof Error ? reason.message : "Sign-in could not be completed. Please try again."); }
    } finally { pending.current = false; setBusy(false); }
  }
  const linkSent = method === "link" && !link && sent;
  return <section aria-label="Administrator sign-in">
    <p>Protected administration for approved accounts.</p>
    {accessEnabled && <div className="signin-methods" role="group" aria-label="Sign-in method">
      <button type="button" aria-pressed={method === "link"} disabled={busy} onClick={() => chooseMethod("link")}>Email a sign-in link</button>
      <button type="button" aria-pressed={method === "password"} disabled={busy} onClick={() => chooseMethod("password")}>Email and password</button>
    </div>}
    <form ref={formRef} onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy || linkSent}>
        <legend className="sr-only">{method === "password" ? "Administrator credentials" : link ? "Confirm your sign-in link" : "Receive a sign-in link"}</legend>
        {!(method === "link" && link) && <label>Email<input name="email" type="email" value={email} onChange={event => {setEmail(event.target.value); setFactor("unknown"); setSent(false); setNotice("");}} autoComplete="username" required maxLength={254} /></label>}
        {method === "password" && <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={256} onChange={() => {setFactor("unknown"); setNotice("");}} /></label>}
        {factor === "required" && <><label>Authenticator or recovery code<input ref={codeRef} name="code" autoComplete="one-time-code" required minLength={6} maxLength={64} aria-describedby="admin-mfa-help" /></label><p id="admin-mfa-help" className="signin-factor-help">Use your authenticator app or a saved recovery code. Codes are not sent by email.</p></>}
        {!linkSent && <><label className="signin-remember"><input name="rememberBrowser" type="checkbox" checked={rememberBrowser} onChange={event => setRememberBrowser(event.target.checked)} aria-describedby="admin-remember-help" />Remember this browser</label>
        <p id="admin-remember-help" className="signin-factor-help">Stay signed in for up to 8 hours. Use only on a private device.</p>
        {factor !== "setup" && <button className="button" disabled={busy}>{busy ? "Please wait…" : method === "link" && !link ? "Send sign-in link" : factor === "required" ? "Sign in" : method === "link" ? "Confirm sign-in link" : "Continue"}</button>}</>}
      </fieldset>
    </form>
    {linkSent && <div className="engineering-link-sent"><p ref={statusRef} tabIndex={-1} role="status">Sent.</p><button className="button" type="button" disabled={busy || resendSeconds > 0} onClick={() => formRef.current?.requestSubmit()}>Send another link{resendSeconds > 0 ? ` (${resendSeconds}s)` : ""}</button></div>}
    {notice && <p role={error ? "alert" : "status"}>{notice}</p>}
    {factor === "setup" && <a className="button" href="/access/setup-authenticator">Set up your authenticator</a>}
    {accessEnabled && <p className="signin-registration">First time here? <a href="/access/register?audience=admin">Register for administrator access</a>.</p>}
    <details className="signin-help"><summary>Access and security</summary><p>{accessEnabled?"New access requires email verification and owner approval. Existing approvals are retained. ":""}After verifying your password or email link, Onesa checks whether you need authenticator setup or your existing MFA code. Administrator access requires MFA. Signing in here grants no Engineering Docs or Robot role.</p></details>
  </section>;
}
