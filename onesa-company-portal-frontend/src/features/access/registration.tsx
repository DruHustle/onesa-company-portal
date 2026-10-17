"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import { accessLinkToken } from "@/lib/access-link";
export function AccessRegistration({ confirmation = false }: { confirmation?: boolean }) {
  const [token, setToken] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [done, setDone] = useState(false), [audience, setAudience] = useState<"admin" | "engineering">("admin");
  useEffect(() => {
    if (confirmation) { const raw = accessLinkToken(window.location.hash); setToken(raw); window.history.replaceState(null, "", window.location.pathname); if (!raw) setNotice("This registration link is missing or invalid. Request a new one."); }
    else if (new URLSearchParams(window.location.search).get("audience") === "engineering") setAudience("engineering");
  }, [confirmation]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy) return; const form = e.currentTarget, data = new FormData(form); setBusy(true); setNotice("");
    try {
      if (confirmation) {
        if (!token) throw Error("Request a new registration link.");
        if (data.get("password") !== data.get("confirmPassword")) throw Error("The passwords must match.");
        const r = await api.POST("/api/v1/access/confirm", { body: { token, password: String(data.get("password")) } });
        setAudience(r.data!.audience); setToken(null); setDone(true);
        setNotice(r.data!.status === "approved" ? "Your existing approval is recognized. Registration is complete. New administrators must enroll their authenticator before signing in." : "Your email is verified. Your request has been sent to the owner for approval. We’ll email you when it has been reviewed.");
      } else {
        await api.POST("/api/v1/access/register", { body: { name: String(data.get("name")), email: String(data.get("email")), audience } });
        setDone(true); setNotice("Check your email for a registration link. If you already have an account, sign in with it. A new account receives access only after approval.");
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Registration could not be completed. Please try again."); }
    finally { setBusy(false); }
  }
  return <main className="admin-main"><div className="container"><section className="admin-login" aria-labelledby="registration-title">
    <a className="wordmark" href="https://onesa.eu/">onesa<span>UG</span></a><p>ONESA PORTAL · PROTECTED ACCESS</p>
    <h1 id="registration-title">{confirmation ? "Complete your registration" : "Request access"}</h1>
    <p>{confirmation ? "Verify your email by confirming this link and choose a password. Opening the link does not grant access." : "Register before your first sign-in. Administrator and Engineering Docs access are approved separately. Previously approved addresses do not need another approval."}</p>
    {!done && <form onSubmit={submit} aria-busy={busy}><fieldset disabled={busy || (confirmation && !token)}><legend>{confirmation ? "Choose your password" : "Your access request"}</legend>
      {confirmation ? <><label>Password (at least 14 characters)<input name="password" type="password" autoComplete="new-password" required minLength={14} maxLength={256} /></label><label>Confirm password<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={14} maxLength={256} /></label></> : <><label>Your name<input name="name" autoComplete="name" required maxLength={120} /></label><label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254} /></label><label>Access requested<select value={audience} onChange={e => setAudience(e.target.value as "admin" | "engineering")}><option value="admin">Company administration</option><option value="engineering">Engineering Docs</option></select></label></>}
      <button className="button">{busy ? "Please wait…" : confirmation ? "Verify email and complete registration" : "Email my registration link"}</button>
    </fieldset></form>}
    {notice && <p role={done ? "status" : "alert"}>{notice}</p>}
    <p><a href={audience === "admin" ? "/admin" : "/engineering"}>Return to sign-in</a> · <a href="https://onesa.eu/en/contact">Contact Onesa</a></p>
  </section></div></main>;
}
