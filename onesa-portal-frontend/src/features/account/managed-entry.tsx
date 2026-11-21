"use client";

import { useEffect, useState, type ReactNode } from "react";
import { sharedSignInToken } from "@/lib/access-link";
import styles from "./account.module.css";

export function ManagedAccountEntry({ accountUrl, children }: { accountUrl: string | null; children: ReactNode }) {
  const [confirmEmail, setConfirmEmail] = useState(false);
  useEffect(() => {
    // Previously issued Portal email proofs must be confirmed on their original origin.
    if (sharedSignInToken(window.location.hash)) setConfirmEmail(true);
    else if (accountUrl) window.location.replace(accountUrl);
  }, [accountUrl]);
  if (confirmEmail) return children;
  return <main className={styles.shell}>
    <section className={styles.card} aria-labelledby="account-title">
      <h1 id="account-title">Onesa Account</h1>
      {accountUrl ? <a href={accountUrl} referrerPolicy="no-referrer">Continue with Onesa</a>
        : <p role="status">Onesa Account is temporarily unavailable. Try again later.</p>}
    </section>
  </main>;
}
