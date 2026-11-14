/** Only the browser-facing OIDC start/callback exchanges may forward redirects. */
export function managedPortalRedirect(path: string[], target: string | null, origin: string, issuer?: string) {
  if (!target || !issuer || path.length !== 3 || path[0] !== "auth" || path[1] !== "managed") return null;
  try {
    const url = new URL(target,origin);
    if (url.username || url.password) return null;
    if (path[2] === "start" && url.protocol === "https:" && url.origin === new URL(issuer).origin &&
      url.pathname === "/authorize" && !url.hash) return url.href;
    if (url.origin !== origin || !target.startsWith("/") || target.startsWith("//")) return null;
    if ((path[2] === "start" || path[2] === "callback") && url.pathname === "/api/v1/auth/managed/retry") return url.href;
    if (path[2] === "callback" && url.pathname === "/admin") return url.href;
  } catch { /* Reject malformed issuer or upstream destination. */ }
  return null;
}
