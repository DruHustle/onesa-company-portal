"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accessLinkToken } from "@/lib/access-link";
import { AccountError, accountRequest, type AccountSession } from "./api";
import styles from "./account.module.css";
const copy = {
  en: {
    title: "Password and security", manage: "Manage the password for all your Onesa products.",
    reset: "Choose a new password for your single Onesa account. Your authenticator and access approvals remain unchanged.",
    recover: "Recover your account using its verified email address.", checking: "Checking your account…",
    current: "Current password", password: "New password (at least 14 characters)", confirmation: "Confirm new password",
    code: "Fresh authenticator or recovery code", email: "Email address", wait: "Please wait…", change: "Change Onesa password",
    send: "Email password reset link", back: "Return to your Onesa account", setup: "Set up your authenticator",
    nav: "Account security", mismatch: "The passwords must match.", checkError: "Unable to check your account.",
    changed: "Your Onesa password has changed. Your existing sessions have ended. Sign in again with the new password.",
    sent: "If this address has an active Onesa account, a password reset link will arrive by email. Your MFA and product approvals are retained.",
    failed: "Password recovery could not be completed.",
  },
  de: {
    title: "Passwort und Sicherheit", manage: "Verwalten Sie das Passwort für alle Ihre Onesa-Produkte.",
    reset: "Wählen Sie ein neues Passwort für Ihr gemeinsames Onesa-Konto. Ihr Authenticator und Ihre Zugangsfreigaben bleiben unverändert.",
    recover: "Stellen Sie Ihr Konto über Ihre bestätigte E-Mail-Adresse wieder her.", checking: "Ihr Konto wird geprüft…",
    current: "Aktuelles Passwort", password: "Neues Passwort (mindestens 14 Zeichen)", confirmation: "Neues Passwort bestätigen",
    code: "Aktueller Authenticator- oder Wiederherstellungscode", email: "E-Mail-Adresse", wait: "Bitte warten…", change: "Onesa-Passwort ändern",
    send: "Link zur Passwortwiederherstellung senden", back: "Zurück zu Ihrem Onesa-Konto", setup: "Authenticator einrichten",
    nav: "Kontosicherheit", mismatch: "Die Passwörter müssen übereinstimmen.", checkError: "Ihr Konto konnte nicht geprüft werden.",
    changed: "Ihr Onesa-Passwort wurde geändert. Ihre bisherigen Sitzungen wurden beendet. Melden Sie sich mit dem neuen Passwort an.",
    sent: "Wenn diese Adresse zu einem aktiven Onesa-Konto gehört, erhalten Sie einen Link zur Passwortwiederherstellung per E-Mail. Ihr Authenticator und Ihre Produktfreigaben bleiben erhalten.",
    failed: "Die Passwortwiederherstellung konnte nicht abgeschlossen werden.",
  },
};
export function AccountSecurity() {
  const [language, setLanguage] = useState<"en" | "de">("en");
  const t = copy[language];
  useEffect(() => { try { if (localStorage.getItem("onesa.account.language") === "de") setLanguage("de"); } catch { /* storage is optional */ } }, []);
  function chooseLanguage(value: "en" | "de") { setLanguage(value); try { localStorage.setItem("onesa.account.language", value); } catch { /* storage is optional */ } }
  const [session, setSession] = useState<AccountSession | null>(null), [link, setLink] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    const receive = () => { setLink(accessLinkToken(window.location.hash)); window.history.replaceState(null, "", window.location.pathname); };
    receive(); window.addEventListener("hashchange", receive);
    let active = true;
    accountRequest<AccountSession>("/api/v1/account/me").then(value => { if (active) setSession(value); }).catch(reason => { if (active && !(reason instanceof AccountError && reason.status === 401)) { setError(true); setNotice(reason instanceof Error ? reason.message : copy.en.checkError); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; window.removeEventListener("hashchange", receive); };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const data = new FormData(event.currentTarget); pending.current = true; setBusy(true); setNotice(""); setError(false);
    try {
      if (link || session) {
        const password = String(data.get("password"));
        if (password !== data.get("confirmation")) throw Error(t.mismatch);
        if (link) await accountRequest("/api/v1/auth/password/reset", { token: link, password });
        else await accountRequest("/api/v1/account/password/change", { currentPassword: String(data.get("currentPassword")), password, code: String(data.get("code") || "") }, session!.csrf);
        setLink(null); setSession(null); setDone(true); setNotice(t.changed);
      } else { await accountRequest("/api/v1/account/password/request", { email: String(data.get("email")).trim().toLowerCase() }); setDone(true); setNotice(t.sent); }
    } catch (reason) { setError(true); setNotice(reason instanceof Error ? reason.message : t.failed); }
    finally { pending.current = false; setBusy(false); }
  }
  return <main className={styles.shell} lang={language}><header className={styles.header}><a className={styles.brand} href="/account">onesa<span>ACCOUNT</span></a><label><span className={styles.srOnly}>Language / Sprache</span><select aria-label="Language / Sprache" value={language} onChange={event => chooseLanguage(event.target.value as "en" | "de")}><option value="en">English</option><option value="de">Deutsch</option></select></label></header><section className={styles.card}><h1>{t.title}</h1><p className={styles.muted}>{session ? t.manage : link ? t.reset : t.recover}</p>
    {loading ? <p role="status">{t.checking}</p> : !done && <form onSubmit={submit} aria-busy={busy}><fieldset disabled={busy}>
      {link || session ? <>{session && !link && <label>{t.current}<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256}/></label>}<label>{t.password}<input name="password" type="password" autoComplete="new-password" required minLength={14} maxLength={256}/></label><label>{t.confirmation}<input name="confirmation" type="password" autoComplete="new-password" required minLength={14} maxLength={256}/></label>{session?.account.mfaEnrolled && !link && <label>{t.code}<input name="code" autoComplete="one-time-code" required minLength={6} maxLength={64}/></label>}</> : <label>{t.email}<input name="email" type="email" autoComplete="email" required maxLength={254}/></label>}
      <button className="button">{busy ? t.wait : link || session ? t.change : t.send}</button>
    </fieldset></form>}
    {notice && <p className={styles.notice} role={error ? "alert" : "status"}>{notice}</p>}
    <nav className={styles.support} aria-label={t.nav}><a href="/account">{t.back}</a>{session && !session.account.mfaEnrolled && <a href="/account/setup-authenticator">{t.setup}</a>}</nav>
  </section></main>;
}
