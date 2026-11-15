const identityIssuer = "https://auth.onesa.eu/";
const identityOrigin = new URL(identityIssuer).origin;
const endpointFields = ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const;

/**
 * A green Identity probe must describe the configured issuer and keep every
 * advertised OIDC endpoint on that same HTTPS origin. HTTPS alone is not
 * sufficient: a foreign endpoint would make a healthy-looking probe lie about
 * which service receives authentication traffic.
 */
export function identityHealthAvailable(data: Record<string, unknown> | null) {
  if (data?.issuer !== identityIssuer) return false;
  return endpointFields.every(key => {
    const value = data[key];
    if (typeof value !== "string" || !URL.canParse(value)) return false;
    const endpoint = new URL(value);
    return endpoint.protocol === "https:" && endpoint.origin === identityOrigin &&
      !endpoint.username && !endpoint.password && !endpoint.hash;
  });
}
