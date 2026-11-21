import {test} from "node:test";
import assert from "node:assert/strict";
import {origin, probeIdentity} from "./external_identity_health.mjs";

test("origin is the fixed public account readiness endpoint", () => {
  assert.equal(origin, "https://account.onesa.eu/readyz");
});

test("accepts only exact identity readiness JSON over an HTTP 200", async () => {
  let called = 0;
  const r = await probeIdentity(async (url, options) => {
    called++;
    assert.equal(url, origin);
    assert.equal(options.redirect, "manual");
    assert.equal(options.method, "GET");
    return Response.json({service: "onesa-identity", ready: true});
  });
  assert.equal(called, 1);
  assert.deepEqual(r, {service:"onesa-identity",status:"PASS",reason:"expected_origin_readiness"});
});

test("rejects redirect and protected sign-in, not just server errors", async () => {
  for (const status of [301, 302, 307, 308, 401, 403, 404, 502, 503]) {
    const r = await probeIdentity(async () => new Response(null, {status}));
    assert.equal(r.status,"FAIL");
    assert.equal(r.httpStatus,status);
    assert.equal(r.reason,[301,302,307,308].includes(status)?"unexpected_redirect":"http_error");
  }
});

test("rejects homepage HTML, missing/oversized/invalid content", async () => {
  for(const response of [
    new Response("<html>Access login</html>", {status:200,headers:{"content-type":"text/html"}}),
    new Response(null,{status:200,headers:{"content-type":"application/json"}}),
    new Response("x".repeat(4100),{status:200,headers:{"content-type":"application/json"}}),
    new Response("not json",{status:200,headers:{"content-type":"application/json"}}),
    Response.json({service:"other-service",ready:true}),
    Response.json({service:"onesa-identity",ready:false}),
    Response.json({service:"onesa-identity",ready:"true"}),
  ]) {
    const r=await probeIdentity(async()=>response);
    assert.equal(r.status,"FAIL");
  }
});

test("rejects transport failure without printing raw response details", async () => {
  const r=await probeIdentity(async()=>{throw Error("secret external host diagnostics");});
  assert.deepEqual(r,{service:"onesa-identity",status:"FAIL",reason:"network_or_timeout"});
  assert.doesNotMatch(JSON.stringify(r),/secret external host diagnostics/);
});
