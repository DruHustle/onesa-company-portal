import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
// Independent public readiness probe. Run only on a trusted GitHub-hosted
// runner outside the single Oracle VM. No credentials, raw body or secrets.
// A Portal/Cloudflare sign-in redirect is NOT a successful origin check.
export const origin = "https://account.onesa.eu/readyz";
const byteLimit = 4096;

export async function probeIdentity(fetcher = fetch) {
  let response;
  try {
    response = await fetcher(origin, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
      headers: {Accept: "application/json"},
    });
  } catch {
    return {service: "onesa-identity", status: "FAIL", reason: "network_or_timeout"};
  }
  const statusCode = response.status;
  if (statusCode !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return {service: "onesa-identity", status: "FAIL",
      reason: statusCode === 301 || statusCode === 302 || statusCode === 303 ||
        statusCode === 307 || statusCode === 308 ? "unexpected_redirect" : "http_error",
      httpStatus: statusCode};
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    return {service: "onesa-identity", status: "FAIL", reason: "non_json_response"};
  }
  if (!response.body) return {service: "onesa-identity", status: "FAIL", reason: "missing_body"};
  const chunks = [];
  let size = 0, reader = response.body.getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > byteLimit) {
        await reader.cancel();
        return {service: "onesa-identity", status: "FAIL", reason: "oversized_response"};
      }
      chunks.push(value);
    }
  } catch {
    return {service: "onesa-identity", status: "FAIL", reason: "incomplete_response"};
  } finally {reader.releaseLock();}
  let result;
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    result = JSON.parse(text);
  } catch {
    return {service: "onesa-identity", status: "FAIL", reason: "malformed_json"};
  }
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      result.service !== "onesa-identity" || result.ready !== true) {
    return {service: "onesa-identity", status: "FAIL", reason: "wrong_service_or_readiness"};
  }
  return {service: "onesa-identity", status: "PASS", reason: "expected_origin_readiness"};
}

// The third-party polling environment is not an admin session, and its health
// state never authorizes product login, billing, rollout or physical operations.
export function isDirectExecution(entry, path = process.argv[1]) {
  return typeof path === "string" && path.length > 0 &&
    fileURLToPath(entry) === resolve(path);
}
if (isDirectExecution(import.meta.url)) {
  const observations = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1500));
    const value = await probeIdentity();
    observations.push(value);
    if (value.status === "PASS") break;
  }
  const last = observations.at(-1);
  console.log(JSON.stringify({at: new Date().toISOString(), ...last,
    attempts: observations.length, independentOfOracle: true}));
  if (last.status !== "PASS") process.exitCode = 1;
}
