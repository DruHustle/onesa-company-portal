export function identityAdministrationRequired() {
  return process.env.ONESA_IDENTITY_PORTAL_LOGIN === "managed" || process.env.ONESA_IDENTITY_ADMINISTRATION === "external";
}

/** Only a distinct, server-configured HTTPS Identity origin can receive the admin link. */
export function identityAdministrationMode(required: boolean, url: string | null): "external" | "unavailable" | "local" {
  return url ? "external" : required ? "unavailable" : "local";
}

/** The pre-Identity Farmer compatibility grant is allowed only in isolated local mode. */
export function legacyPortalFarmerAccess(input: { mode: "external" | "unavailable" | "local"; product: string; hasGrant: boolean; portalAccess: boolean; emailVerified: boolean }): boolean {
  return input.mode === "local" && input.product === "farmer" && !input.hasGrant && input.portalAccess && input.emailVerified;
}

export function identityAdministrationUrl() {
  if (!identityAdministrationRequired()) return null;
  const origin = process.env.ONESA_IDENTITY_UI_ORIGIN;
  if (!origin) return null;
  let url: URL;
  try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== "https:" || url.origin !== origin) return null;
  const portalOrigins = [process.env.PORTAL_URL, process.env.PUBLIC_ORIGIN, process.env.SITE_URL]
    .filter((value): value is string => !!value)
    .flatMap(value => {
      try {
        const configured = new URL(value);
        return configured.origin === value ? [configured.origin] : [];
      } catch { return []; }
    });
  if (portalOrigins.includes(url.origin)) return null;
  return new URL("/admin#accounts", url).href;
}
