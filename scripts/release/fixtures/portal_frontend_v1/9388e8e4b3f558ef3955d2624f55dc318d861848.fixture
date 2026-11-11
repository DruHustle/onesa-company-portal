const identityPath = "/api/v1/identity";
export function identityProtocolPath(path: readonly string[]) {
  return /^identity\/(?:\.well-known\/openid-configuration|jwks|auth(?:\/[A-Za-z0-9_-]{8,128})?|token|me|session|revoke)$/.test(path.join("/"));
}
/** Only exact, independently configured product callbacks can leave the account origin. */
export function identityRedirectLocation(value: string | null, origin: string, encodedCallbacks: string | undefined) {
  if (!value || value.length > 8192) return null;
  try {
    const url = new URL(value, origin);
    if (url.username || url.password || url.hash) return null;
    if (url.origin === origin && !url.search && (new RegExp("^" + identityPath + "/auth/[A-Za-z0-9_-]{8,128}$").test(url.pathname) || /^\/account\/sign-in\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname))) return url.href;
    const callbacks: unknown = JSON.parse(encodedCallbacks || "[]");
    if (!Array.isArray(callbacks) || callbacks.length > 4) return null;
    const exact = callbacks.some(value => {
      if (typeof value !== "string") return false;
      const allowed = new URL(value);
      return allowed.protocol === "https:" && !allowed.username && !allowed.password && !allowed.search && !allowed.hash && allowed.pathname !== "/" && allowed.origin === url.origin && allowed.pathname === url.pathname;
    });
    if (!exact) return null;
    const keys = new Set(["code", "state", "iss", "error", "error_description", "error_uri"]);
    for (const key of url.searchParams.keys()) if (!keys.has(key) || url.searchParams.getAll(key).length !== 1) return null;
    const issuer = url.searchParams.get("iss");
    if (issuer && issuer !== origin + identityPath) return null;
    return url.href;
  } catch { return null; }
}
