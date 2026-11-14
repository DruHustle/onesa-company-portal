/** The server supplies the pilot destination. No request data influences the host. */
export function identityAdministrationUrl() {
  if (process.env.ONESA_IDENTITY_ADMINISTRATION !== "external") return null;
  const origin = process.env.ONESA_IDENTITY_UI_ORIGIN;
  if (!origin) throw Error("External Identity administration requires ONESA_IDENTITY_UI_ORIGIN");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin)
    throw Error("ONESA_IDENTITY_UI_ORIGIN must be an exact HTTPS origin");
  // A fixed fragment prevents a browser inheriting an old emailed proof on redirect.
  return new URL("/admin#accounts", url).href;
}
