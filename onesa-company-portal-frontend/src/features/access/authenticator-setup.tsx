"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { operations } from "@/lib/api/generated/schema";
import styles from "./registration.module.css";

type Enrollment = operations["startMfaEnrollment"]["responses"][200]["content"]["application/json"];

export function AuthenticatorSetup() {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const step = codes.length ? 3 : enrollment ? 2 : 1;
  useEffect(() => { if (step > 1) heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (!codes.length || saved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [codes.length, saved]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const data = new FormData(event.currentTarget);
    pending.current = true; setBusy(true); setError("");
    try {
      if (enrollment) {
        const result = await api.POST("/api/v1/auth/mfa/verify", { body: { challenge: enrollment.challenge, code: String(data.get("code")).trim() } });
        if (!Array.isArray(result.data?.recoveryCodes) || !result.data.recoveryCodes.length || !result.data.recoveryCodes.every(code => typeof code === "string" && code.length > 0)) throw Error("Recovery codes could not be confirmed. Keep this page open and contact Onesa.");
        setCodes(result.data.recoveryCodes); setEnrollment(null);
      } else {
        const result = await api.POST("/api/v1/auth/mfa/enroll", { body: { email: String(data.get("email")).trim().toLowerCase(), password: String(data.get("password")) } });
        if (!result.data?.secret || !result.data.challenge) throw Error("Setup could not be confirmed. Please try again.");
        setEnrollment(result.data);
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 403) {
        if (enrollment) { setEnrollment(null); setError("This setup has expired. Enter your email and password to start again. If setup already completed, use your authenticator to sign in."); }
        else setError("Setup is available after administrator registration and approval. Check your registered email and password. Already enrolled? Sign in with your existing authenticator or a saved recovery code.");
      } else if (reason instanceof ApiError && reason.status === 401 && enrollment) {
        setError("That code was not accepted. Enter the current six-digit code from the Onesa account in your authenticator app.");
      } else setError(reason instanceof Error ? reason.message : "Setup could not be completed. Please try again.");
    } finally { pending.current = false; setBusy(false); }
  }

  return <main className={styles.shell}><section className={styles.card} aria-labelledby="authenticator-title">
    <a className="wordmark" href="https://onesa.eu/" aria-label="Onesa home">onesa<span>UG</span></a>
    <p className={styles.context}>ONESA PORTAL · ADMINISTRATOR SETUP</p>
    <h1 id="authenticator-title" ref={heading} tabIndex={-1}>{step === 3 ? "Save your recovery codes" : "Set up your authenticator"}</h1>
    <p className={styles.intro}>{step === 1 ? "After registration and approval, secure your account before your first sign-in." : step === 2 ? "Add an account in your authenticator app. Choose manual setup, enter the key below and select time-based codes." : "Each code works once if you cannot use your authenticator. Store these securely before continuing."}</p>
    <p className={styles.context}>STEP {step} OF 3</p>
    {step !== 3 && <form onSubmit={submit} aria-busy={busy}><fieldset disabled={busy}>
      <legend className={styles.srOnly}>{enrollment ? "Verify authenticator setup" : "Verify your approved account"}</legend>
      {enrollment ? <>
        <p>Account name: <strong>Onesa</strong></p>
        <label>Setup key<output className={styles.setupKey}>{enrollment.secret}</output></label>
        <p className={styles.intro}>Keep this key private. Setup expires after ten minutes.</p>
        <label>Six-digit authenticator code<input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required minLength={6} maxLength={6} /></label>
      </> : <>
        <label>Email address<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>
        <label>Registered password<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
      </>}
      <button className="button" disabled={busy}>{busy ? "Please wait…" : enrollment ? "Verify authenticator" : "Start authenticator setup"}</button>
    </fieldset></form>}
    {step === 3 && <>
      <ul className={styles.recoveryCodes} aria-label="One-use recovery codes">{codes.map(code => <li key={code}><code>{code}</code></li>)}</ul>
      <label className="check"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />I have saved my recovery codes securely.</label>
      <button className="button" disabled={!saved} onClick={() => { setCodes([]); window.location.replace("/admin"); }}>Continue to administrator sign-in</button>
      <p className={styles.intro}>Wait for your authenticator’s next code, or use a saved recovery code to sign in. Setup does not sign you in automatically.</p>
    </>}
    {error && <p role="alert" className={styles.notice}>{error}</p>}
    <div className={styles.support}>
      {step !== 3 && <a href="/admin">Already enrolled? Sign in</a>}
      <details><summary>Help with setup</summary><p>You need an approved administrator account and its registered password. This page cannot replace existing MFA or reset your account. Engineering Docs has a separate sign-in flow.</p><a href="/access/register?audience=admin">Register for administrator access</a><p><a href="https://onesa.eu/en/contact">Contact Onesa</a></p></details>
    </div>
  </section></main>;
}
