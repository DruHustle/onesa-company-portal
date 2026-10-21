"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accessLinkToken } from "@/lib/access-link";
export function EngineeringSignIn({ uid, environment }: { uid: string; environment: string }) {
  const [csrf, setCsrf] = useState(""), [method, setMethod] = useState<"link" | "password">("link"), [link, setLink] = useState<string | null>(null), [notice, setNotice] = useState(""), [sent, setSent] = useState(false), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const [expired, setExpired] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [resendUntil, setResendUntil] = useState(0);
  useEffect(() => {
    if (!resendUntil) return;
    const update = () => setResendSeconds(Math.max(0, Math.ceil((resendUntil - performance.now()) / 1000)));
    update();
    const timer = window.setInterval(() => { update(); if (performance.now() >= resendUntil) window.clearInterval(timer); }, 1000);
    return () => window.clearInterval(timer);
  }, [resendUntil]);
  useEffect(() => {
    let active = true; const abort = new AbortController(); setReady(false); setCsrf(""); setExpired(false);
    const receiveLink = () => {
      const raw = accessLinkToken(window.location.hash);
      if (raw) { setLink(raw); setMethod("link"); setNotice(""); setSent(false); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    };
    receiveLink();
    window.addEventListener("hashchange", receiveLink);
    fetch("/engineering/sign-in/" + uid + "/details", { cache: "no-store", signal: abort.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) { if (value.error?.code === "ENGINEERING_INTERACTION" && active) setExpired(true); throw Error(); } if (!/^[a-f0-9]{64}$/.test(value.csrf)) throw Error();
      if (active) { setCsrf(value.csrf); setReady(true); }
    }).catch(() => { if (active && !abort.signal.aborted) setNotice("This sign-in request has expired or is unavailable. Return to Engineering Docs to start again in this browser."); });
    return () => { active = false; abort.abort(); window.removeEventListener("hashchange", receiveLink); };
  }, [uid]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current || !ready || (method === "link" && !link && resendSeconds > 0)) return;
    const data = new FormData(event.currentTarget); submitting.current = true; setBusy(true); setNotice("");
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 25000);
    try {
      const action = method === "password" ? "password" : link ? "link-verify" : "link";
      const response = await fetch("/engineering/sign-in/" + uid + "/" + action, { method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csrf, ...(method === "password" ? { email: String(data.get("email")), password: String(data.get("password")) } : link ? { token: link } : { email: String(data.get("email")) }) }) });
      const value = await response.json();
      if (!response.ok) {
        if (value.error?.code === "ENGINEERING_INTERACTION") { setReady(false); setExpired(true); throw Error("This sign-in request has expired. Start a new sign-in to continue."); }
        throw Error(response.status === 429 ? "Please wait before trying again." : response.status >= 500 ? "Sign-in is temporarily unavailable. Please try again." : "Sign-in could not be completed. Check your details and try again.");
      }
      if (action === "link") { setSent(true); setResendSeconds(15); setResendUntil(performance.now() + 15000); return; }
      if (typeof value.continuePath !== "string" || !/^\/api\/v1\/engineering-identity\/auth\/[A-Za-z0-9_-]{8,128}$/.test(value.continuePath)) throw Error("Sign-in could not be completed.");
      setLink(null); window.location.assign(value.continuePath);
    } catch (error) { setNotice(abort.signal.aborted ? "The request took too long. Please try again." : error instanceof Error ? error.message : "Sign-in could not be completed."); }
    finally { window.clearTimeout(timeout); submitting.current = false; setBusy(false); }
  }
  const confirming = method === "link" && Boolean(link);
  const coolingDown = method === "link" && !confirming && resendSeconds > 0;
  return <main className="admin-main admin-auth-shell engineering-auth-shell"><div className="container"><a className="skip-link" href="#engineering-sign-in">Skip to sign-in</a><section className="admin-login" aria-labelledby="engineering-title">
    <div className="admin-product-title"><a href="https://onesa.eu/" aria-label="Onesa company homepage"><img src="/brand/icons/v1/onesa-company.svg" width="48" height="48" alt="Onesa" /></a><small>ONESA PORTAL</small><span className="engineering-access-context">Protected access · {environment}</span></div>
    <h1 id="engineering-title">{confirming ? "Open Engineering Docs" : "Sign in to Engineering Docs"}</h1>
    <p className="engineering-signin-intro">{confirming ? "Confirm your email link to continue securely." : "Use your approved email to continue."}</p>
    <div id="engineering-sign-in">
      {notice && <p role="alert">{notice}</p>}
      {expired && <a className="button" href="/engineering">Start a new sign-in</a>}
      {!ready && !notice && <p role="status">Preparing secure sign-in…</p>}
      {ready && <>
        {!confirming && <div className="signin-methods" role="group" aria-label="Sign-in method"><button type="button" disabled={busy} aria-pressed={method === "link"} onClick={() => { setMethod("link"); setNotice(""); }}>Email a sign-in link</button><button type="button" disabled={busy} aria-pressed={method === "password"} onClick={() => { setMethod("password"); setNotice(""); }}>Email and password</button></div>}
        <form ref={formRef} onSubmit={submit} aria-busy={busy} hidden={sent && method === "link" && !confirming}><fieldset disabled={busy || coolingDown}><legend className="sr-only">{method === "password" ? "Email and password" : confirming ? "Confirm your sign-in link" : "Your approved email"}</legend>
          {!confirming && <label>Email address<input name="email" type="email" disabled={busy || coolingDown} autoComplete="username" maxLength={254} required /></label>}
          {method === "password" && <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={256} required /></label>}
          <button className="button" type="submit" disabled={busy || coolingDown}>{busy ? (method === "link" && !confirming ? "Sending…" : "Signing in…") : method === "password" ? "Sign in to Docs" : confirming ? "Confirm sign-in and open Docs" : "Send sign-in link"}</button>
        </fieldset></form>
        {sent && !confirming && method === "link" && <div className="engineering-link-sent"><p role="status">Link sent.</p><button className="button" type="button" disabled={busy || resendSeconds > 0} onClick={() => formRef.current?.requestSubmit()}>{busy ? "Sending…" : resendSeconds > 0 ? `Send again in ${resendSeconds}s` : "Send another link"}</button></div>}
      </>}
      <div className="engineering-signin-support">
        {!confirming && !sent && <p className="signin-registration">First time here? <a href="/access/register?audience=engineering">Register for Engineering Docs</a></p>}
        <details className="signin-help"><summary>Help with access</summary><p>New access requires owner approval. Existing approvals are retained.</p><p><a href="/engineering">Start a new sign-in</a> · <a href="https://onesa.eu/en/contact">Contact Onesa</a></p></details>
      </div>
    </div>
  </section></div></main>;
}
