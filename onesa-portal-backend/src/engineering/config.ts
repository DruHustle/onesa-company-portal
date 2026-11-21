import { createPrivateKey, createPublicKey } from "node:crypto";
export const identityPath = "/api/v1/engineering-identity";
export type EngineeringIdentityConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  cookieKeys: string[];
  jwks: { keys: Record<string, string>[] };
  externalEmails: string[];
};
/** Root-only deployment input. Never include rejected values in a configuration error. */
export function engineeringIdentityConfiguration(
  values: Record<string, string | undefined>,
  origin: string,
): EngineeringIdentityConfig | null {
  if (values.ENGINEERING_IDENTITY_ENABLED !== "true") return null;
  try {
    const encoded = values.ENGINEERING_OIDC_CONFIG_B64;
    if (
      !encoded ||
      encoded.length > 32768 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw Error();
    const x = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as EngineeringIdentityConfig;
    const issuer = new URL(x.issuer),
      callback = new URL(x.redirectUri);
    if (
      issuer.origin !== origin ||
      issuer.pathname !== identityPath ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password ||
      issuer.protocol !== "https:"
    )
      throw Error();
    if (
      callback.protocol !== "https:" ||
      !/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(callback.hostname) ||
      callback.pathname !== "/cdn-cgi/access/callback" ||
      callback.search ||
      callback.hash ||
      callback.username ||
      callback.password ||
      callback.port
    )
      throw Error();
    if (
      !/^[a-zA-Z0-9_-]{16,128}$/.test(x.clientId) ||
      typeof x.clientSecret !== "string" ||
      x.clientSecret.length < 48 ||
      x.clientSecret.length > 256
    )
      throw Error();
    if (
      !Array.isArray(x.cookieKeys) ||
      x.cookieKeys.length < 1 ||
      x.cookieKeys.length > 2 ||
      x.cookieKeys.some(
        (k) => typeof k !== "string" || k.length < 48 || k.length > 256,
      )
    )
      throw Error();
    if (
      !Array.isArray(x.externalEmails) ||
      x.externalEmails.length > 10 ||
      x.externalEmails.some(
        (e) =>
          typeof e !== "string" ||
          e !== e.toLowerCase() ||
          !/^\S+@\S+\.\S+$/.test(e) ||
          e.includes("*"),
      )
    )
      throw Error();
    if (!Array.isArray(x.jwks?.keys) || x.jwks.keys.length !== 1) throw Error();
    const jwk = x.jwks.keys[0];
    if (
      jwk.kty !== "RSA" ||
      jwk.alg !== "RS256" ||
      jwk.use !== "sig" ||
      !jwk.d ||
      !jwk.p ||
      !jwk.q ||
      !jwk.kid ||
      !/^[a-zA-Z0-9_-]{8,64}$/.test(jwk.kid)
    )
      throw Error();
    const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
    if ((privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw Error();
    createPublicKey(privateKey);
    return x;
  } catch {
    throw Error("Engineering identity configuration rejected");
  }
}
export function engineeringEmailAllowed(
  email: string,
  externalEmails: readonly string[],
) {
  return /^\S+@onesa\.eu$/.test(email) || externalEmails.includes(email);
}
