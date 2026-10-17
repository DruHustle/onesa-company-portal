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
        setNotice("If this address has an active account, a sign-in link is on its way. It expires in 15 minutes. First time here? Register below.");
      }
    } catch (error) { setError(true); setNotice(error instanceof Error ? error.message : "Sign-in could not be completed. Please try again."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Administrator sign-in">
    <p>{accessEnabled ? "Choose a sign-in method. Administrator access keeps its authenticator or recovery-code protection." : "Use your email, password and authenticator or recovery code to sign in."}</p>
    {accessEnabled && <div className="admin-actions" aria-label="Sign-in method">
      <button type="button" aria-pressed={method === "link"} disabled={busy} onClick={() => { setMethod("link"); setNotice(""); }}>Email a sign-in link</button>
      <button type="button" aria-pressed={method === "password"} disabled={busy} onClick={() => { setMethod("password"); setNotice(""); }}>Email and password</button>
    </div>}
    <form onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy}>
        <legend>{method === "password" ? "Email and password" : link ? "Confirm your sign-in link" : "Receive a sign-in link"}</legend>
        {!(method === "link" && link) && <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>}
        {method === "password" && <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>}
        {(method === "password" || link) && <label>Authenticator or recovery code<input name="code" autoComplete="one-time-code" required minLength={6} maxLength={64} /></label>}
        <button className="button" disabled={busy}>{busy ? "Please wait…" : method === "link" && !link ? "Send sign-in link" : "Sign in"}</button>
      </fieldset>
    </form>
    {notice && <p role={error ? "alert" : "status"}>{notice}</p>}
    {accessEnabled && <p>First time here? <a href="/access/register?audience=admin">Register for administrator access</a>. New requests go to the owner for approval; existing approvals are retained.</p>}
  </section>;
}
