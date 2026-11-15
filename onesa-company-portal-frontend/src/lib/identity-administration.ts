/** Global account administration is delegated in every deployed Portal runtime. */
export function identityAdministrationRequired() {
  return process.env.NODE_ENV !== "test" || process.env.ONESA_IDENTITY_ADMINISTRATION === "external";
}

/** Only a server-configured, exact HTTPS origin can receive the admin link. */
export function identityAdministrationUrl() {
  if (!identityAdministrationRequired()) return null;
  const origin = process.env.ONESA_IDENTITY_UI_ORIGIN;
  if (!origin) return null;
  let url: URL;
  try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== "https:" || url.origin !== origin) return null;
  return new URL("/admin#accounts", url).href;
}
