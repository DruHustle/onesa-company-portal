const identityPath = "/api/v1/engineering-identity";
export function engineeringProtocolPath(path: readonly string[]) {
  return /^engineering-identity\/(?:\.well-known\/openid-configuration|jwks|auth(?:\/[A-Za-z0-9_-]{8,128})?|token|me)$/.test(
    path.join("/"),
  );
}
/** Redirects are restricted to the Portal interaction/resume or the configured Access callback. */
export function engineeringRedirectLocation(
  value: string | null,
  origin: string,
  callback: string | undefined,
) {
  if (!value || value.length > 8192) return null;
  try {
    const url = new URL(value, origin);
    if (url.username || url.password || url.hash) return null;
    if (
      url.origin === origin &&
      !url.search &&
      (new RegExp("^" + identityPath + "/auth/[A-Za-z0-9_-]{8,128}$").test(
        url.pathname,
      ) ||
        /^\/engineering\/sign-in\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname))
    )
      return url.href;
    if (!callback) return null;
    const approved = new URL(callback);
    if (
      approved.protocol !== "https:" ||
      !/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(approved.hostname) ||
      approved.pathname !== "/cdn-cgi/access/callback" ||
      approved.username ||
      approved.password ||
      approved.search ||
      approved.hash ||
      approved.port
    )
      return null;
    if (url.origin !== approved.origin || url.pathname !== approved.pathname)
      return null;
    const allowed = new Set([
      "code",
      "state",
      "iss",
      "error",
      "error_description",
      "error_uri",
    ]);
    for (const key of url.searchParams.keys())
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
        return null;
    const issuer = url.searchParams.get("iss");
    if (issuer && issuer !== origin + identityPath) return null;
    return url.href;
  } catch {
    return null;
  }
}
