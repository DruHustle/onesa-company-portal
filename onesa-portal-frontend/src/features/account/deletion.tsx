"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { company } from "@/config/company";
import { AccountError, accountRequest, type AccountSession } from "./api";
import styles from "./account.module.css";

const copy = {
  en: {
    title: "Request account deletion",
    scope:
      "You can request deletion of your shared Onesa account and associated product data, including Onesa Drone. This affects all products using that account.",
    review:
      "The privacy team reviews the request and contacts you about deletion and any records it must retain.",
    checking: "Checking your account…",
    signIn: "Sign in with Onesa to make a request",
    help: "If you cannot sign in, send your request to the privacy contact.",
    identity: "Signed in as",
    confirm:
      "I want to request deletion of this Onesa account and its associated data.",
    send: "Submit deletion request",
    success:
      "Your request was recorded. Keep this reference when contacting the privacy team.",
    wait: "Submitting…",
    retry: "Check your session and try again.",
    policy: "Privacy information",
  },
  de: {
    title: "Kontolöschung beantragen",
    scope:
      "Sie können die Löschung Ihres gemeinsamen Onesa-Kontos und der zugehörigen Produktdaten einschließlich Onesa Drone beantragen. Dies betrifft alle Produkte, die dieses Konto verwenden.",
    review:
      "Das Datenschutzteam prüft die Anfrage und informiert Sie über die Löschung und eventuell aufzubewahrende Daten.",
    checking: "Konto wird geprüft…",
    signIn: "Mit Onesa anmelden und Löschung beantragen",
    help: "Falls Sie sich nicht anmelden können, senden Sie Ihren Antrag an den Datenschutzkontakt.",
    identity: "Angemeldet als",
    confirm:
      "Ich möchte die Löschung dieses Onesa-Kontos und der zugehörigen Daten beantragen.",
    send: "Löschantrag senden",
    success:
      "Ihr Antrag wurde erfasst. Bewahren Sie diese Referenz für Rückfragen auf.",
    wait: "Wird gesendet…",
    retry: "Prüfen Sie Ihre Sitzung und versuchen Sie es erneut.",
    policy: "Datenschutzhinweise",
  },
};

export function AccountDeletion() {
  const [language, setLanguage] = useState<keyof typeof copy>("en");
  const [session, setSession] = useState<AccountSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [reference, setReference] = useState("");
  const [error, setError] = useState(false);
  const t = copy[language];
  useEffect(() => {
    try {
      if (localStorage.getItem("onesa.account.language") === "de")
        setLanguage("de");
    } catch {
      /* optional preference */
    }
    let active = true;
    accountRequest<AccountSession>("/api/v1/account/me")
      .then((value) => {
        if (active) setSession(value);
      })
      .catch((reason) => {
        if (
          active &&
          !(reason instanceof AccountError && reason.status === 401)
        )
          setError(true);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await accountRequest<{ reference: string }>(
        "/api/v1/account/deletion-requests",
        { confirmed: true },
        session.csrf,
      );
      setReference(result.reference);
    } catch (reason) {
      if (reason instanceof AccountError && reason.status === 401)
        setSession(null);
      setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <main className={styles.shell} lang={language}>
      <header className={styles.header}>
        <a className={styles.brand} href="/account">
          Onesa
        </a>
        <select
          aria-label="Language / Sprache"
          value={language}
          onChange={(event) =>
            setLanguage(event.target.value as keyof typeof copy)
          }
        >
          <option value="en">English</option>
          <option value="de">Deutsch</option>
        </select>
      </header>
      <section className={styles.card}>
        <h1>{t.title}</h1>
        <p>{t.scope}</p>
        <p>{t.review}</p>
        {checking ? (
          <p role="status">{t.checking}</p>
        ) : reference ? (
          <p role="status">
            {t.success} <strong>{reference}</strong>
          </p>
        ) : session ? (
          <form onSubmit={submit}>
            <p>
              {t.identity} <strong>{session.account.email}</strong>
            </p>
            <label>
              <input type="checkbox" required /> {t.confirm}
            </label>
            <button className="button" disabled={busy}>
              {busy ? t.wait : t.send}
            </button>
          </form>
        ) : (
          <p>
            <a className="button" href="/account?next=%2Faccount%2Fdelete">
              {t.signIn}
            </a>
          </p>
        )}
        {error && <p role="alert">{t.retry}</p>}
        <p>
          {t.help}{" "}
          <a href={`mailto:${company.privacyEmail}`}>{company.privacyEmail}</a>
        </p>
        <a href={`/${language}/privacy`}>{t.policy}</a>
      </section>
    </main>
  );
}
