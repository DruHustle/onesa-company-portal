"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accessLinkToken } from "@/lib/access-link";
import { engineeringSignInError } from "@/lib/engineering-sign-in-errors";
export function EngineeringSignIn({ uid, environment }: { uid: string; environment: string }) {
  const [csrf, setCsrf] = useState(""), [method, setMethod] = useState<"link" | "password">("link"), [link, setLink] = useState<string | null>(null), [notice, setNotice] = useState(""), [sent, setSent] = useState(false), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const sentRef = useRef<HTMLParagraphElement>(null);
  const submitting = useRef(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [registrationRequired, setRegistrationRequired] = useState(false);
  const [email, setEmail] = useState("");
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
    let active = true, timedOut = false; const abort = new AbortController(); setReady(false); setCsrf(""); setRestartRequired(false); setNotice(""); setRegistrationRequired(false);
    const deadline = window.setTimeout(() => { timedOut = true; abort.abort(); }, 25000);
    const receiveLink = () => {
      const raw = accessLinkToken(window.location.hash);
      if (raw) { setLink(raw); setMethod("link"); setNotice(""); setRegistrationRequired(false); setSent(false); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    };
    receiveLink();
    window.addEventListener("hashchange", receiveLink);
    fetch("/engineering/sign-in/" + uid + "/details", { cache: "no-store", signal: abort.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) {
        const failure = engineeringSignInError(response.status, value?.error?.code, "details");
        if (active) { setRestartRequired(true); setNotice(failure.message); }
        return;
      }
      if (!/^[a-f0-9]{64}$/.test(value.csrf)) throw Error();
      if (active) { setCsrf(value.csrf); setReady(true); }
    }).catch(() => { if (active && (!abort.signal.aborted || timedOut)) { setRestartRequired(true); setNotice(timedOut ? "The sign-in page took too long to load. Start a new sign-in." : "The sign-in page could not be loaded. Start a new sign-in."); } }).finally(() => window.clearTimeout(deadline));
    return () => { active = false; window.clearTimeout(deadline); abort.abort(); window.removeEventListener("hashchange", receiveLink); };
  }, [uid]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current || !ready || (method === "link" && !link && resendSeconds > 0)) return;
    const data = new FormData(event.currentTarget); submitting.current = true; setBusy(true); setNotice(""); setRegistrationRequired(false);
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 25000);
    try {
      const action = method === "password" ? "password" : link ? "link-verify" : "link";
      if (action === "link") setSent(false);
      const response = await fetch("/engineering/sign-in/" + uid + "/" + action, { method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csrf, ...(method === "password" ? { email, password: String(data.get("password")) } : link ? { token: link } : { email }) }) });
      const value = await response.json().catch(() => { throw Error("Sign-in is temporarily unavailable. Please try again."); });
      if (!response.ok) {
        const failure = engineeringSignInError(response.status, value?.error?.code, action);
        if (failure.restart) { setReady(false); setRestartRequired(true); }
        setRegistrationRequired(failure.registration);
        throw Error(failure.message);
      }
      if (action === "link") { if (value?.ok !== true) throw Error("The sign-in request could not be confirmed. Please try again."); setSent(true); setResendSeconds(5); setResendUntil(performance.now() + 5000); return; }
      if (typeof value?.continuePath !== "string" || !/^\/api\/v1\/engineering-identity\/auth\/[A-Za-z0-9_-]{8,128}$/.test(value.continuePath)) throw Error("The sign-in service returned an unexpected response. Start a new sign-in.");
      setLink(null); window.location.assign(value.continuePath);
    } catch (error) { setNotice(abort.signal.aborted ? "The request took too long. Please try again." : error instanceof TypeError ? "Could not connect. Please try again." : error instanceof Error ? error.message : "Sign-in could not be completed."); }
    finally { window.clearTimeout(timeout); submitting.current = false; setBusy(false); }
  }
  const confirming = method === "link" && Boolean(link);
  const linkSent = sent && method === "link" && !confirming;
  const coolingDown = method === "link" && !confirming && resendSeconds > 0;
  const controlsDisabled = busy || linkSent || coolingDown;
  return <main className="admin-main admin-auth-shell engineering-auth-shell"><div className="container"><a className="skip-link" href="#engineering-sign-in">Skip to sign-in</a><section className="admin-login" aria-labelledby="engineering-title">
    <div className="admin-product-title"><a href="https://onesa.eu/" aria-label="Onesa company homepage"><img src="/brand/icons/v1/onesa-company.svg" width="48" height="48" alt="Onesa" /></a><small>ONESA PORTAL</small><span className="engineering-access-context">Protected access · {environment}</span></div>
    <h1 id="engineering-title">{confirming ? "Open Engineering Docs" : "Sign in to Engineering Docs"}</h1>
    <p className="engineering-signin-intro">{confirming ? "Confirm your email link to continue securely." : "Use your approved email to continue."}</p>
    <div id="engineering-sign-in">
      {notice && <p role="alert">{notice}{registrationRequired && <> <a href="/access/register?audience=engineering">Register for Engineering Docs</a></>}</p>}
      {restartRequired && <a className="button" href="/engineering">Start a new sign-in</a>}
      {!ready && !notice && <p role="status">Preparing secure sign-in…</p>}
      {ready && <>
        {!confirming && <div className="signin-methods" role="group" aria-label="Sign-in method"><button type="button" disabled={busy} aria-pressed={method === "link"} onClick={() => { setMethod("link"); setNotice(""); setRegistrationRequired(false); }}>Email a sign-in link</button><button type="button" disabled={busy} aria-pressed={method === "password"} onClick={() => { setMethod("password"); setNotice(""); setRegistrationRequired(false); }}>Email and password</button></div>}
        <form ref={formRef} onSubmit={submit} aria-busy={busy}><fieldset disabled={controlsDisabled}><legend className="sr-only">{method === "password" ? "Email and password" : confirming ? "Confirm your sign-in link" : "Your approved email"}</legend>
          {!confirming && <label>Email address<input name="email" type="email" value={email} onChange={event => { setEmail(event.target.value); setSent(false); }} disabled={controlsDisabled} autoComplete="username" maxLength={254} required /></label>}
          {method === "password" && <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={256} required /></label>}
          {!linkSent && <button className="button" type="submit" disabled={controlsDisabled}>{busy ? (method === "link" && !confirming ? "Sending…" : "Signing in…") : method === "password" ? "Sign in to Docs" : confirming ? "Confirm sign-in and open Docs" : coolingDown ? "Please wait…" : "Send sign-in link"}</button>}
        </fieldset></form>
        {sent && !confirming && method === "link" && <div className="engineering-link-sent"><p className="engineering-sent-notice" ref={sentRef} tabIndex={-1} role="status">Sent.</p><button className="button" type="button" disabled={busy || resendSeconds > 0} onClick={() => formRef.current?.requestSubmit()}>Send another link</button></div>}
      </>}
      <div className="engineering-signin-support">
        {!confirming && !sent && !registrationRequired && <p className="signin-registration">First time here? <a href="/access/register?audience=engineering">Register for Engineering Docs</a></p>}
        <details className="signin-help"><summary>Help with access</summary><p>New access requires owner approval. Existing approvals are retained.</p>{sent && <p><a href="/access/register?audience=engineering">Register for Engineering Docs</a></p>}<p><a href="/engineering">Start a new sign-in</a> · <a href="https://onesa.eu/en/contact">Contact Onesa</a></p></details>
      </div>
    </div>
  </section></div></main>;
}
