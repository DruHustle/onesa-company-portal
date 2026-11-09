"use client";

import { useEffect, useRef, useState } from "react";
import { mountBilling } from "./vendor/mount.mjs";
import "./vendor/billing.css";

type State = "loading" | "ready" | "signed-out" | "unavailable";

/** Billing reuses the current verified account or MFA Portal session; assertions stay in the backend. */
export function BillingPage() {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>("loading");
  useEffect(() => {
    const lifetime = new AbortController();
    let mounted: ReturnType<typeof mountBilling> | undefined;
    async function start() {
      try {
        const response = await fetch("/api/v1/account/billing/session", {
          credentials: "same-origin", cache: "no-store", redirect: "error",
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]),
          headers: { Accept: "application/json" },
        });
        if (lifetime.signal.aborted) return;
        if (response.status === 401) { setState("signed-out"); return; }
        if (!response.ok) { setState("unavailable"); return; }
        const session: unknown = await response.json();
        if (!session || typeof session !== "object" || !("csrf" in session)
          || typeof session.csrf !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(session.csrf)) {
          setState("unavailable"); return;
        }
        if (lifetime.signal.aborted || !host.current) return;
        const csrf = session.csrf;
        mounted = mountBilling(host.current, {
          csrf: () => csrf,
          onSessionExpired: () => { mounted?.destroy(); if (!lifetime.signal.aborted) setState("signed-out"); },
        });
        setState("ready");
      } catch { if (!lifetime.signal.aborted) setState("unavailable"); }
    }
    void start();
    return () => { lifetime.abort(); mounted?.destroy(); };
  }, []);

  return <main>
    <nav className="onesa-billing" aria-label="Account navigation"><a href="/account">Onesa account</a></nav>
    {state !== "ready" && <section className="onesa-billing" aria-labelledby="billing-page-title">
      <h1 id="billing-page-title">Billing</h1>
      {state === "loading" && <p role="status">Loading your billing account…</p>}
      {state === "signed-out" && <><p>Sign in to view your purchases and invoices.</p><p><a href="/account">Sign in to Onesa</a></p><p><a href="/admin">Staff sign-in</a></p></>}
      {state === "unavailable" && <><p role="status">Billing is temporarily unavailable. Please try again later.</p><p><a href="/account/billing">Try again</a></p></>}
    </section>}
    <div ref={host} aria-label="Billing workspace" />
  </main>;
}
