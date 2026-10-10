import {NextRequest, NextResponse} from "next/server";
import {surface,routeDestination,applicationOrigin} from "./lib/domains";
/** Per-response nonces allow Next.js hydration without trusting injected inline scripts. */
export function proxy(request: NextRequest) {
  const origin=applicationOrigin(request.headers.get('host'),request.nextUrl.origin);
  const current=origin?surface(origin):'unknown';
  if(current==='unknown')return new NextResponse('Unrecognized application hostname',{status:421,headers:{'Cache-Control':'no-store'}});
  const destination=routeDestination(origin!,request.nextUrl.pathname);
  if(destination){const target=new URL(destination);target.search=request.nextUrl.search;return NextResponse.redirect(target,307);}
  const nonce = btoa(crypto.randomUUID());
  const development = process.env.NODE_ENV === "development";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({request:{headers}});
  response.headers.set("Content-Security-Policy", policy);
  if(current==='portal')response.headers.set('X-Robots-Tag','noindex, nofollow');
  response.headers.set("Cache-Control", "private, no-store");
  // Enable only after approved domain/TLS verification; no inherited subdomain policy.
  if (process.env.ONESA_HSTS_ENABLED === "true" && request.nextUrl.protocol === "https:") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return response;
}
export const config = {matcher:["/((?!api|_next/static|_next/image|favicon.ico).*)"]};
