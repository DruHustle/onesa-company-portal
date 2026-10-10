# Company homepage social sharing

The company site is Next.js 16 on Vercel (production responses include Server:
Vercel and x-vercel-id). The homepage is server-rendered through the native App
Router, reusing the English company layout and homepage at `/`. No unused index.html
was introduced. `/en` and `/de` remain available; private hostname boundaries and
publication approvals remain enforced.

`src/lib/metadata.ts` defines the requested homepage title, description, canonical
https://onesa.eu/, Open Graph website/site name/image and Twitter large-image card.
Metadata streaming is disabled using Next.js htmlLimitedBots so the tags are in the
initial head for ordinary requests as well as HTML-limited crawlers.

The preview is https://onesa.eu/social/onesa-social-card.png (1200 × 630 image/png).
Its editable SVG source uses the established company wordmark, orbit motif, navy,
cyan and Arial typography. The raster PNG, not the SVG, is used for social metadata.
Existing owner-supplied images are preserved. Provenance is in public/brand/sources.json.

Robots keeps administration and API restrictions. During publication qualification,
general indexing remains blocked; facebookexternalhit is allowed only `/`, `/en`
and the exact public preview PNG. This is a discovery rule, never an authentication
or WAF bypass. Once publication is approved, public crawling is allowed while private
paths remain excluded. Application access does not depend on a user-agent identity.

## Production diagnosis and remaining deployment work

On 2026-10-10, unauthenticated GETs with Mozilla/5.0 and
facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php) both returned
200 HTML after `/` redirected to `/en`; robots returned 200. The existing banner
returned 404. The reported Facebook 403 was not reproducible from this client.
This does not establish that an actual Facebook scrape succeeds.

Deploy this source through the existing qualified release workflow. Do not bypass
its production approval guard. The new asset and root response do not exist on the
older deployed release. Saving configuration is not equivalent to promoting this code.

If Facebook still receives 403 after deployment:

1. Open the Vercel project serving onesa.eu → Firewall → traffic/logs. Trigger a
   Facebook Sharing Debugger scrape and correlate its time, host and exact path.
   Identify the matching custom/managed rule or persistent deny/challenge.
2. Inspect Settings → Deployment Protection. The company production domain must
   be publicly accessible without Vercel login/password; keep preview protection.
3. Adjust only the rule blocking the public company hostname and relevant GET/HEAD
   paths (`/`, `/en`, `/robots.txt`, `/social/onesa-social-card.png`). Do not exempt
   `/admin`, portal.onesa.eu, backend routes or the entire project. Prefer provider
   verified-bot identification over a spoofable user-agent match; preserve WAF and
   rate limits. Do not grant privileged access through an agent-string exception.
4. If no project rule explains it, supply the blocked request time/request ID to
   Vercel support for platform-level firewall investigation.

Official reference: https://vercel.com/docs/bot-management and
https://vercel.com/docs/vercel-firewall/firewall-concepts. Dashboard access/rule
readback was not available during this repository-only implementation; no hosting
protection changes or global security disablement were made.

## Verification

Run npm run build, lint and typecheck in the frontend. The existing isolated
hostname HTTP regression (`npm run test:domain-http`) now checks both user agents:
200 root HTML, initial-head tags without duplicates, exact canonical, 200 PNG and
1200 × 630 dimensions, robots rules, favicon assets and private routing. Use its
existing CI host configuration; never connect this test to production credentials.

After deploying, open https://developers.facebook.com/tools/debug/, enter
https://onesa.eu/ and click Debug, then Scrape Again. Confirm 200, the requested
title/description, canonical and rendered PNG. Repeat Scrape Again if Facebook
retains the old cached preview. Only that real scrape can confirm Facebook success.

Verified implementation results (2026-10-10): final production build and TypeScript
passed; lint and history hygiene passed (zero scanner findings). The completed
standalone build returns 200 actual homepage HTML and 200 image/png (1200 × 630)
for both tested user agents. Required tags occur exactly once in the initial head;
canonical and og:url are exactly https://onesa.eu/. Robots GETs are 200 and identical
for both agents. Private redirects, unknown-host rejection, company API denial,
portal noindex and existing favicon/brand routes pass the HTTP regression.
The production baseline still uses the old SVG image URL and lacks the new PNG
(404). No production deployment or Facebook Sharing Debugger scrape was performed.
