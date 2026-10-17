/** Tokens stay in a URL fragment until an explicit confirmation, never in a query or storage. */
export function accessLinkToken(fragment: string): string | null {
  const values = new URLSearchParams(fragment.replace(/^#/, ""));
  const raw = values.get("access-link");
  return values.size === 1 && raw !== null && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}
