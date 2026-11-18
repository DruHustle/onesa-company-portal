"use client";

import { useEffect } from "react";
import { docsAccountPath, productAccountPath } from "@/lib/account-return";

const storageKey = "onesa.portal.registration";
const lifetime = 30 * 60 * 1000;
type Audience = "admin" | "user";

function safeReturn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const prefix = "/account?";
  if (!value.startsWith(prefix)) return null;
  const query = new URLSearchParams(value.slice(prefix.length));
  if (query.size !== 1) return null;
  const docs = query.get("docs");
  const product = query.get("interaction");
  const path = docs ? docsAccountPath(docs) : product ? productAccountPath(product) : null;
  return path === value ? path : null;
}

export function RegistrationDeparture({ destination, audience, returnPath }: {
  destination: string; audience: Audience; returnPath: string | null;
}) {
  useEffect(() => {
    try {
      sessionStorage.removeItem(storageKey);
      const path = safeReturn(returnPath);
      if (path) sessionStorage.setItem(storageKey, JSON.stringify({ path, audience, started: Date.now() }));
    } catch { /* Storage can be unavailable in a private browser. */ }
    window.location.replace(destination);
  }, [destination, audience, returnPath]);
  return <a href={destination} referrerPolicy="no-referrer">Continue to Onesa Identity</a>;
}

export function RegistrationReturn({ audience }: { audience: Audience }) {
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (!saved) return;
      sessionStorage.removeItem(storageKey);
      const context = JSON.parse(saved);
      const path = safeReturn(context.path);
      const age = Date.now() - context.started;
      if (context.audience === audience && Number.isSafeInteger(context.started) && age >= 0 && age < lifetime && path)
        window.location.replace(path);
    } catch { /* Default to the local Portal destination. */ }
  }, [audience]);
  return null;
}
