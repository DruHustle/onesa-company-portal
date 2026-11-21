/** The optional browser regression fixture binds both the portal and API to loopback. */
export function legacyEngineeringFixture(): boolean {
  const local = (url = "") => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);
  return process.env.ENGINEERING_LEGACY_TEST_FIXTURE === "true" && !process.env.VERCEL &&
    local(process.env.PUBLIC_ORIGIN) && local(process.env.BACKEND_URL);
}
