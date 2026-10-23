"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api/client";
import { accessLinkToken } from "@/lib/access-link";
import type { operations } from "@/lib/api/generated/schema";
type SignedIn = operations["login"]["responses"][200]["content"]["application/json"];
export function AdminSignIn({ onSignedIn, accessEnabled }: { accessEnabled: boolean; onSignedIn: (value: SignedIn) => void }) {
  const [method, setMethod] = useState<"password" | "link">("password"), [link, setLink] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(false);
  useEffect(() => {
    if (!accessEnabled) return;
    const receiveLink = () => {
      const raw = accessLinkToken(window.location.hash);
      if (raw) { setLink(raw); setMethod("link"); setNotice(""); setError(false); window.history.replaceState(null, "", window.location.pathname + window.location.search); }
    };
    receiveLink();
    window.addEventListener("hashchange", receiveLink);
    return () => window.removeEventListener("hashchange", receiveLink);
  }, [accessEnabled]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy) return;
    const form = e.currentTarget, data = new FormData(form); setBusy(true); setNotice(""); setError(false);
    try {
      if (method === "password") {
        const result = await api.POST("/api/v1/auth/login", { body: { email: String(data.get("email")), password: String(data.get("password")), code: String(data.get("code")) } });
        onSignedIn(result.data!);
      } else if (link) {
        const result = await api.POST("/api/v1/access/link/verify", { body: { token: link, code: String(data.get("code")) } });
        setLink(null); onSignedIn(result.data!);
      } else {
        await api.POST("/api/v1/access/link", { body: { email: String(data.get("email")) } });
        setNotice("If this address has an active account, a sign-in link is on its way. It expires in 15 minutes. First time here? Register for access below.");
      }
    } catch (error) { setError(true); setNotice(error instanceof Error ? error.message : "Sign-in could not be completed. Please try again."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Administrator sign-in">
    <p>Protected administration for approved accounts.</p>
    {accessEnabled && <div className="signin-methods" role="group" aria-label="Sign-in method">
      <button type="button" aria-pressed={method === "link"} disabled={busy} onClick={() => { setMethod("link"); setNotice(""); }}>Email a sign-in link</button>
      <button type="button" aria-pressed={method === "password"} disabled={busy} onClick={() => { setMethod("password"); setNotice(""); }}>Email and password</button>
    </div>}
    <form onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy}>
        <legend className="sr-only">{method === "password" ? "Administrator credentials" : link ? "Confirm your sign-in link" : "Receive a sign-in link"}</legend>
        {!(method === "link" && link) && <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>}
        {method === "password" && <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>}
        {(method === "password" || link) && <><label>Authenticator or recovery code<input name="code" autoComplete="one-time-code" required minLength={6} maxLength={64} aria-describedby="admin-mfa-help" /></label><p id="admin-mfa-help" className="signin-factor-help">Use the current code from your authenticator app or one of your saved recovery codes. First time? <a href="/access/setup-authenticator">Set up your authenticator</a>.</p></>}
        <button className="button" disabled={busy}>{busy ? "Please wait…" : method === "link" && !link ? "Send sign-in link" : "Sign in"}</button>
      </fieldset>
    </form>
    {notice && <p role={error ? "alert" : "status"}>{notice}</p>}
    {accessEnabled && <p className="signin-registration">First time here? <a href="/access/register?audience=admin">Register for administrator access</a>.</p>}
    <details className="signin-help"><summary>Access and security</summary><p>{accessEnabled?"New access requires email verification and owner approval. Existing approvals are retained. ":""}Administrator sign-in requires an authenticator or unused recovery code with either method. Signing in here grants no Engineering Docs or Robot role.</p></details>
  </section>;
}
