// The issuer registers one exact callback for each of the eight supported products.
const maximumProductCallbacks = 8;
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
    if (url.origin === origin && !url.search) {
      const interaction = /^\/account\/sign-in\/([A-Za-z0-9_-]{8,128})$/.exec(url.pathname);
      if (interaction) return origin + "/account?interaction=" + interaction[1];
      if (new RegExp("^" + identityPath + "/auth/[A-Za-z0-9_-]{8,128}$").test(url.pathname)) return url.href;
    }
    const callbacks: unknown = JSON.parse(encodedCallbacks || "[]");
    if (!Array.isArray(callbacks) || callbacks.length > maximumProductCallbacks) return null;
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

/** Launch a platform administrator into the staff surface on the registered origin. */
export function accountApplicationUrl(product: string, registeredUrl: string, globalAdmin: boolean) {
  if (globalAdmin && product === "pasofi") return new URL("/#staff", registeredUrl).href;
  if (globalAdmin && product === "mobile") return new URL("/internal/", registeredUrl).href;
  return registeredUrl;
}
