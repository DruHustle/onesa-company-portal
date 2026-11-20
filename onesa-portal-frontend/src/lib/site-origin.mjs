/** Canonical URLs never depend on a request's Host or forwarded headers. */
export function companyOrigin() {
  const value = process.env.SITE_URL || 'https://onesa.eu';
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value || !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol !== 'https:' && (!local || process.env.VERCEL === '1' || process.env.PUBLIC_RELEASE_ENABLED === 'true')) ||
      (local && (process.env.VERCEL === '1' || process.env.PUBLIC_RELEASE_ENABLED === 'true'))) {
    throw new Error('SITE_URL must be an exact HTTPS origin; loopback HTTP is allowed only for local previews');
  }
  return url.origin;
}

/** The root is the English homepage; /en is its canonical alias. */
export function companyPageUrl(origin, locale, path = '') {
  return locale === 'en' && !path ? `${origin}/` : `${origin}/${locale}${path}`;
}

export function companyLanguages(origin, path = '') {
  return {
    en: companyPageUrl(origin, 'en', path),
    de: companyPageUrl(origin, 'de', path),
    'x-default': companyPageUrl(origin, 'en', path),
  };
}
