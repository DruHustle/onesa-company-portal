"use client";
import { useEffect, useState, type FormEvent } from "react";
import { accessLinkToken } from "@/lib/access-link";
export function EngineeringSignIn({ uid, environment }: { uid: string; environment: string }) {
  const [csrf, setCsrf] = useState(""), [method, setMethod] = useState<"link" | "password">("link"), [link, setLink] = useState<string | null>(null), [notice, setNotice] = useState(""), [sent, setSent] = useState(false), [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true; const abort = new AbortController(); setReady(false); setCsrf("");
    const receiveLink = () => {
      const raw = accessLinkToken(window.location.hash);
      if (raw) { setLink(raw); setMethod("link"); setNotice(""); setSent(false); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    };
    receiveLink();
    window.addEventListener("hashchange", receiveLink);
    fetch("/engineering/sign-in/" + uid + "/details", { cache: "no-store", signal: abort.signal }).then(async response => {
      if (!response.ok) throw Error(); const value = await response.json(); if (!/^[a-f0-9]{64}$/.test(value.csrf)) throw Error();
      if (active) { setCsrf(value.csrf); setReady(true); }
    }).catch(() => { if (active && !abort.signal.aborted) setNotice("This sign-in request has expired or is unavailable. Return to Engineering Docs to start again in this browser."); });
    return () => { active = false; abort.abort(); window.removeEventListener("hashchange", receiveLink); };
  }, [uid]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !ready) return;
    const data = new FormData(event.currentTarget); setBusy(true); setNotice("");
    try {
      const action = method === "password" ? "password" : link ? "link-verify" : "link";
      const response = await fetch("/engineering/sign-in/" + uid + "/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csrf, ...(method === "password" ? { email: String(data.get("email")), password: String(data.get("password")) } : link ? { token: link } : { email: String(data.get("email")) }) }) });
      const value = await response.json();
      if (!response.ok) throw Error(response.status === 429 ? "Please wait before trying again." : "Sign-in could not be completed. Check your credentials or return to Engineering Docs to request a new link.");
      if (action === "link") { setSent(true); return; }
      if (typeof value.continuePath !== "string" || !/^\/api\/v1\/engineering-identity\/auth\/[A-Za-z0-9_-]{8,128}$/.test(value.continuePath)) throw Error("Sign-in could not be completed.");
      setLink(null); window.location.assign(value.continuePath);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Sign-in could not be completed."); }
    finally { setBusy(false); }
  }
  return <main className="admin-main"><div className="container"><a className="skip-link" href="#engineering-sign-in">Skip to sign-in</a><section className="admin-login" aria-labelledby="engineering-title">
    <div className="admin-product-title"><a href="https://onesa.eu/" aria-label="Onesa company homepage"><img src="/brand/icons/v1/onesa-company.svg" width="48" height="48" alt="Onesa" /></a><small>ONESA PORTAL · ENGINEERING DOCS</small><span className="governance-status">Protected access · {environment}</span></div>
    <h1 id="engineering-title">Sign in to Engineering Docs</h1><p>Use an emailed sign-in link or your registered email and password.</p>
    <div id="engineering-sign-in">
      <div className="admin-actions" aria-label="Sign-in method"><button type="button" disabled={busy} aria-pressed={method === "link"} onClick={() => { setMethod("link"); setNotice(""); }}>Email a sign-in link</button><button type="button" disabled={busy} aria-pressed={method === "password"} onClick={() => { setMethod("password"); setNotice(""); }}>Email and password</button></div>
      {notice && <p role="alert">{notice}</p>}
      {!ready && !notice && <p role="status">Preparing secure sign-in…</p>}
      <form onSubmit={submit} aria-busy={busy}><fieldset disabled={!ready || busy}><legend>{method === "password" ? "Email and password" : link ? "Confirm your sign-in link" : "Your approved email"}</legend>
        {!(method === "link" && link) && <label>Email address<input name="email" type="email" autoComplete="username" maxLength={254} required /></label>}
        {method === "password" && <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={256} required /></label>}
        <button className="button" type="submit">{busy ? "Please wait…" : method === "password" ? "Sign in to Docs" : link ? "Confirm sign-in and open Docs" : "Send sign-in link"}</button>
      </fieldset></form>
      {sent && <p role="status">If this address has approved access, a sign-in link is on its way. It expires in 15 minutes. Open it in the same browser where you started.</p>}
      <p>First time here? <a href="/access/register?audience=engineering">Register for Engineering Docs</a>. New access requires owner approval; existing approvals are retained.</p>
      <p><a href="/engineering">Return to Engineering Docs</a></p><p>Need help? <a href="https://onesa.eu/en/contact">Contact Onesa</a>.</p>
    </div>
  </section></div></main>;
}
