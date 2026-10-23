"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accessLinkToken } from "@/lib/access-link";
import { engineeringSignInError } from "@/lib/engineering-sign-in-errors";
export function EngineeringSignIn({ uid, environment }: { uid: string; environment: string }) {
  const [rememberBrowser, setRememberBrowser] = useState(false);
  const [onesaAccount, setOnesaAccount] = useState<string | null>(null);
  const [useExistingSession, setUseExistingSession] = useState(true);
  const [csrf, setCsrf] = useState(""), [method, setMethod] = useState<"link" | "password">("link"), [linkEmail, setLinkEmail] = useState<string | null>(null), [notice, setNotice] = useState(""), [sent, setSent] = useState(false), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const sentRef = useRef<HTMLParagraphElement>(null);
  const submitting = useRef(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [registrationRequired, setRegistrationRequired] = useState(false);
  const [email, setEmail] = useState("");
  const [openingDocs, setOpeningDocs] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [resendUntil, setResendUntil] = useState(0);
  useEffect(() => { if (sent) sentRef.current?.focus({ preventScroll: true }); }, [sent]);
  useEffect(() => {
    if (!resendUntil) return;
    const update = () => setResendSeconds(Math.max(0, Math.ceil((resendUntil - performance.now()) / 1000)));
    update();
    const timer = window.setInterval(() => { update(); if (performance.now() >= resendUntil) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [resendUntil]);
  useEffect(() => {
    let active = true, timedOut = false, preparingLink = false; const abort = new AbortController(); setReady(false); setOpeningDocs(false); setCsrf(""); setLinkEmail(null); setOnesaAccount(null); setUseExistingSession(true); setRestartRequired(false); setNotice(""); setRegistrationRequired(false);
    let deadline = window.setTimeout(() => { timedOut = true; abort.abort(); }, 25000);
    const receiveLink = () => {
      const raw = accessLinkToken(window.location.hash);
      if (!raw) return false;
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      if (preparingLink) return true;
      preparingLink = true;
      setReady(false); setCsrf(""); setLinkEmail(null); setMethod("link"); setNotice(""); setRegistrationRequired(false); setSent(false);
      window.clearTimeout(deadline);
      deadline = window.setTimeout(() => { timedOut = true; abort.abort(); }, 25000);
      const prepareDeadline = deadline;
      // Preparation is not redemption. A short-lived HttpOnly handoff lets this
      // browser start its own Access/OIDC request before explicit confirmation.
      fetch("/engineering/sign-in/" + uid + "/link-prepare", { method: "POST", cache: "no-store", signal: abort.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: raw }) }).then(async response => {
        const value = await response.json();
        if (!response.ok) throw Error(engineeringSignInError(response.status, value?.error?.code, "link-verify").message);
        if (value?.continuePath !== "/engineering") throw Error("This sign-in link could not be prepared. Request a new link.");
        if (active) window.location.assign("/engineering");
      }).catch(error => { if (active && (!abort.signal.aborted || timedOut)) { setRestartRequired(true); setNotice(timedOut ? "Opening the sign-in link took too long. Open the email link again." : error instanceof Error ? error.message : "Open your latest sign-in email link again."); } }).finally(() => window.clearTimeout(prepareDeadline));
      return true;
    };
    const detailsDeadline = deadline;
    const hasLink = receiveLink();
    window.addEventListener("hashchange", receiveLink);
    if (!hasLink) fetch("/engineering/sign-in/" + uid + "/details", { cache: "no-store", signal: abort.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) {
        const failure = engineeringSignInError(response.status, value?.error?.code, "details");
        if (active && !preparingLink) { setRestartRequired(true); setNotice(failure.message); }
        return;
      }
      if (!/^[a-f0-9]{64}$/.test(value.csrf)) throw Error();
      if (value.linkEmail !== undefined && (typeof value.linkEmail !== "string" || value.linkEmail.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(value.linkEmail))) throw Error();
      if (value.onesaAccount !== undefined && (typeof value.onesaAccount?.email !== "string" || value.onesaAccount.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(value.onesaAccount.email))) throw Error();
      if (active && !preparingLink) {
        const remaining = Number.isInteger(value.linkResendSeconds) && value.linkResendSeconds > 0 && value.linkResendSeconds <= 30 ? value.linkResendSeconds : 0;
        setSent(remaining > 0); setResendSeconds(remaining); setResendUntil(remaining > 0 ? performance.now() + remaining * 1000 : 0);
        setOnesaAccount(value.onesaAccount?.email ?? null); setCsrf(value.csrf); setLinkEmail(value.linkEmail ?? null); setReady(true); }
    }).catch(() => { if (active && !preparingLink && (!abort.signal.aborted || timedOut)) { setRestartRequired(true); setNotice(timedOut ? "The sign-in page took too long to load. Start a new sign-in." : "The sign-in page could not be loaded. Start a new sign-in."); } }).finally(() => window.clearTimeout(detailsDeadline));
    return () => { active = false; window.clearTimeout(deadline); abort.abort(); window.removeEventListener("hashchange", receiveLink); };
  }, [uid]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current || openingDocs || !ready || (method === "link" && !linkEmail && resendSeconds > 0)) return;
    const data = new FormData(event.currentTarget); submitting.current = true; setBusy(true); setNotice(""); setRegistrationRequired(false);
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 25000);
    let navigating = false;
    try {
      const action = onesaAccount && useExistingSession && !linkEmail ? "session" : method === "password" ? "password" : linkEmail ? "handoff-verify" : "link";
      if (action === "link") setSent(false);
      const response = await fetch("/engineering/sign-in/" + uid + "/" + action, { method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csrf, rememberBrowser, ...(action === "session" ? {} : method === "password" ? { email, password: String(data.get("password")) } : linkEmail ? {} : { email }) }) });
      const value = await response.json().catch(() => { throw Error("Sign-in is temporarily unavailable. Please try again."); });
      if (!response.ok) {
        const failure = engineeringSignInError(response.status, value?.error?.code, action);
        if (failure.restart) { setReady(false); setRestartRequired(true); }
        setRegistrationRequired(failure.registration);
        throw Error(failure.message);
      }
      if (action === "link") { if (value?.ok !== true) throw Error("The sign-in request could not be confirmed. Please try again."); setSent(true); setResendSeconds(30); setResendUntil(performance.now() + 30000); return; }
      if (typeof value?.continuePath !== "string" || !/^\/api\/v1\/engineering-identity\/auth\/[A-Za-z0-9_-]{8,128}$/.test(value.continuePath)) throw Error("The sign-in service returned an unexpected response. Start a new sign-in.");
      navigating = true; setOpeningDocs(true); window.location.assign(value.continuePath);
    } catch (error) { navigating = false; setOpeningDocs(false); setNotice(abort.signal.aborted ? "The request took too long. Please try again." : error instanceof TypeError ? "Could not connect. Please try again." : error instanceof Error ? error.message : "Sign-in could not be completed."); }
    finally { window.clearTimeout(timeout); if (!navigating) { submitting.current = false; setBusy(false); } }
  }
  const continuingSession = Boolean(onesaAccount && useExistingSession && !linkEmail);
  const confirming = method === "link" && Boolean(linkEmail);
  const linkSent = sent && method === "link" && !confirming && !continuingSession;
  const coolingDown = method === "link" && !confirming && !continuingSession && resendSeconds > 0;
  const controlsDisabled = busy || linkSent || coolingDown;
  return <main className="admin-main admin-auth-shell engineering-auth-shell"><div className="container"><a className="skip-link" href="#engineering-sign-in">Skip to sign-in</a><section className="admin-login" aria-labelledby="engineering-title">
    <div className="admin-product-title"><a href="https://onesa.eu/" aria-label="Onesa company homepage"><img src="/brand/icons/v1/onesa-company.svg" width="48" height="48" alt="Onesa" /></a><small>ONESA PORTAL</small><span className="engineering-access-context">Protected access · {environment}</span></div>
    <h1 id="engineering-title">{openingDocs ? "Opening Engineering Docs" : confirming ? "Open Engineering Docs" : "Sign in to Engineering Docs"}</h1>
    {!openingDocs && <p className="engineering-signin-intro">{confirming ? <>Continue as <strong>{linkEmail}</strong>.</> : continuingSession ? <>Continue as <strong>{onesaAccount}</strong>.</> : "Use your approved email to continue."}</p>}
    <div id="engineering-sign-in">
      {openingDocs ? <p role="status">Please wait…</p> : <>
      {notice && <p role="alert">{notice}{registrationRequired && <> <a href="/access/register?audience=engineering">Register for Engineering Docs</a></>}</p>}
      {restartRequired && <a className="button" href="/engineering">Start a new sign-in</a>}
      {!ready && !notice && <p role="status">Preparing secure sign-in…</p>}
      {ready && <>
        {!confirming && !continuingSession && <div className="signin-methods" role="group" aria-label="Sign-in method"><button type="button" disabled={busy} aria-pressed={method === "link"} onClick={() => { setMethod("link"); setNotice(""); setRegistrationRequired(false); }}>Email a sign-in link</button><button type="button" disabled={busy} aria-pressed={method === "password"} onClick={() => { setMethod("password"); setNotice(""); setRegistrationRequired(false); }}>Email and password</button></div>}
        <form ref={formRef} onSubmit={submit} aria-busy={busy}><fieldset disabled={controlsDisabled}><legend className="sr-only">{method === "password" ? "Email and password" : confirming ? "Confirm your sign-in link" : "Your approved email"}</legend>
          {!confirming && !continuingSession && <label>Email address<input name="email" type="email" value={email} onChange={event => { setEmail(event.target.value); setSent(false); }} disabled={controlsDisabled} autoComplete="username" maxLength={254} required /></label>}
          {method === "password" && !continuingSession && <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={256} required /></label>}
          {!linkSent && <><label className="signin-remember"><input name="rememberBrowser" type="checkbox" checked={rememberBrowser} onChange={event => setRememberBrowser(event.target.checked)} aria-describedby="engineering-remember-help" />Remember this browser</label><p id="engineering-remember-help" className="signin-factor-help">Stay signed in to Onesa for up to 8 hours. Use only on a private device.</p></>}
          {!linkSent && <button className="button" type="submit" disabled={controlsDisabled}>{busy ? (method === "link" && !confirming && !continuingSession ? "Sending…" : "Signing in…") : continuingSession ? "Continue with Onesa" : method === "password" ? "Sign in to Docs" : confirming ? "Confirm sign-in and open Docs" : coolingDown ? "Please wait…" : "Send sign-in link"}</button>}
        </fieldset></form>
        {continuingSession && <button type="button" disabled={busy} onClick={() => {setUseExistingSession(false); setNotice("");}}>Use another account</button>}
        {sent && !confirming && method === "link" && <div className="engineering-link-sent"><p className="engineering-sent-notice" ref={sentRef} tabIndex={-1} role="status">Sent.</p><button className="button" type="button" disabled={busy || resendSeconds > 0} onClick={() => { if (!email) { setSent(false); return; } formRef.current?.requestSubmit(); }}>Send another link{resendSeconds > 0 ? ` (${resendSeconds}s)` : ""}</button></div>}
      </>}
      <div className="engineering-signin-support">
        {!confirming && !sent && !registrationRequired && <p className="signin-registration">First time here? <a href="/access/register?audience=engineering">Register for Engineering Docs</a></p>}
        <details className="signin-help"><summary>Help with access</summary><p>New access requires owner approval. Existing approvals are retained.</p>{sent && <p><a href="/access/register?audience=engineering">Register for Engineering Docs</a></p>}<p><a href="/engineering">Start a new sign-in</a> · <a href="https://onesa.eu/en/contact">Contact Onesa</a></p></details>
      </div>
      </>}
    </div>
  </section></div></main>;
}
