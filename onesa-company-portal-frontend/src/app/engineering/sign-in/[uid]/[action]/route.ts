import '@/lib/server/tls-trust';
import { NextRequest } from "next/server";
import { applicationOrigin, surface, stagingOrigin } from "@/lib/domains";
export const dynamic = "force-dynamic";
async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ uid: string; action: string }> },
) {
  const { uid, action } = await params,
    hostOrigin = applicationOrigin(
      request.headers.get("host"),
      request.nextUrl.origin,
    ),
    current = hostOrigin ? surface(hostOrigin) : "unknown",
    origin =
      current === "combined" && hostOrigin !== stagingOrigin()
        ? process.env.PUBLIC_ORIGIN || hostOrigin
        : hostOrigin;
  if (
    !origin ||
    surface(origin) === "company" ||
    process.env.ENGINEERING_SIGNIN_ENABLED !== "true"
  )
    return Response.json({ error: { code: "ENGINEERING_SIGN_IN_UNAVAILABLE" } }, { status: 404 });
  if (
    !/^[A-Za-z0-9_-]{8,128}$/.test(uid) ||
    !["details", "start", "verify", "link", "link-prepare", "link-verify", "handoff-verify", "password"].includes(action) ||
    (request.method === "GET") !== (action === "details")
  )
    return Response.json({ error: { code: "ENGINEERING_PROTOCOL" } }, { status: 400 });
  if (request.method === "POST" && request.headers.get("origin") !== origin)
    return Response.json({ error: { code: "ORIGIN" } }, { status: 403 });
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const key of ["cookie", "origin", "sec-fetch-site"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  if (!process.env.PROXY_SHARED_KEY)
    return Response.json({ error: { code: "ENGINEERING_SIGN_IN_UNAVAILABLE" } }, { status: 503 });
  headers.set("x-portal-proxy-key", process.env.PROXY_SHARED_KEY);
  headers.set(
    "x-portal-client-ip",
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1",
  );
  try {
    let body: string | undefined;
    if (request.method === "POST") {
      if (Number(request.headers.get("content-length") || 0) > 2048)
        return Response.json(
          { error: { code: "FILE_SIZE" } },
          { status: 413 },
        );
      const reader = request.body?.getReader(),
        chunks: Uint8Array[] = [];
      let count = 0;
      if (reader)
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            count += value.byteLength;
            if (count > 2048)
              return Response.json(
                { error: { code: "FILE_SIZE" } },
                { status: 413 },
              );
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      body = new TextDecoder().decode(bytes);
    }
    const response = await fetch(
      (process.env.BACKEND_URL || "http://127.0.0.1:8300") +
        "/api/v1/engineering-sign-in/" +
        uid +
        "/" +
        action,
      {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
      },
    );
    if (response.status >= 300 && response.status < 400)
      return Response.json({ error: { code: "ENGINEERING_REDIRECT" } }, { status: 502 });
    const output = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    });
    for (const cookie of response.headers.getSetCookie())
      output.append("set-cookie", cookie);
    return new Response(response.body, {
      status: response.status,
      headers: output,
    });
  } catch {
    return Response.json(
      { error: { code: "BACKEND_UNAVAILABLE" } },
      { status: 503 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
