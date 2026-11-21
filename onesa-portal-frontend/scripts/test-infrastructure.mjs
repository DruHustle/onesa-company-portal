/** Production UI with isolated API fixtures; backend role denial is tested separately. */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const origin = "http://127.0.0.1:3367", proxyKey = "synthetic-infrastructure-proxy";
let role = "administrator", unavailable = false, snapshots = 0;
const ids = ["portal", "ai", "robot", "farmer", "drone", "logistics", "mobile", "factory", "pasofi", "kubernetes", "portainer"];
const names = ["Company Portal", "Onesa AI Platform", "Onesa Robot", "Smart Farmer", "Onesa Drone", "Smart Logistics", "Onesa Mobile", "Smart Factory", "PasoFi", "Kubernetes", "Portainer"];
const api = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
  const send = (status, body) => response.writeHead(status).end(JSON.stringify(body));
  if (request.headers["x-portal-proxy-key"] !== proxyKey) return send(403, {error:{message:"Synthetic proxy required"}});
  if (request.url === "/api/v1/auth/me") return send(200, {user:{id:"00000000-0000-4000-8000-000000000001",email:"synthetic@example.invalid",role},csrf:"synthetic-csrf"});
  if (request.url === "/api/v1/admin/infrastructure") {
    snapshots++;
    if (unavailable) return send(503, {error:{message:"Infrastructure observations are unavailable. Try again."}});
    if (role !== "administrator") return send(403, {error:{message:"Administrator access required"}});
    return send(200, {checkedAt:new Date().toISOString(),staleAfterSeconds:300,observationState:"loaded",services:ids.map((id,index)=>({id,name:names[index],hosting:"Synthetic hosting observation",url:"https://example.invalid",dependencies:["Synthetic dependency"],status:index===0?"available":index===1?"unavailable":index===2?"stale":"not_observed",lastObservedState:index<3?"available":null,observedAt:index<3?new Date(Date.now()-(index===2?600000:0)).toISOString():null,source:index<3?"public_http":null,environment:index<3?"local":null,revision:null,scope:"Synthetic API liveness only; no production claim."}))});
  }
  if (request.url === "/api/v1/admin/dashboard") return send(200,{enquiries:null,partnerships:null,applications:null,documents:null,drafts:null,published:null,pendingJobs:null,releaseReady:false,publicationEnabled:false,publicationStage:"launch"});
  return send(404,{error:{message:"Unknown synthetic route"}});
});
api.listen(8367,"127.0.0.1"); await once(api,"listening");
let child, browser;
try {
  child=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","-p","3367"],{env:{PATH:process.env.PATH,NODE_ENV:"production",PUBLIC_ORIGIN:origin,SITE_URL:origin,BACKEND_URL:"http://127.0.0.1:8367",PROXY_SHARED_KEY:proxyKey,NEXT_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
  let startup=""; for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{startup=(startup+data).slice(-2000);});
  let ready=false;
  for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error(startup);try{if((await fetch(origin+"/admin")).ok){ready=true;break;}}catch{}await delay(250);}
  assert(ready,"Isolated frontend did not start");
  browser=await chromium.launch();
  await mkdir("test-results/infrastructure",{recursive:true});
  for(const width of [320,1280]){
    const context=await browser.newContext({viewport:{width,height:900}});
    const page=await context.newPage();
    await page.goto(origin+"/admin?section=Infrastructure");
    await expect(page.getByRole("heading",{name:"Infrastructure",exact:true})).toBeVisible();
    await expect(page.getByRole("heading",{name:"Portainer",exact:true})).toBeVisible();
    await expect(page.getByText("Stale observation",{exact:true})).toBeVisible();
    await expect(page.getByText("Unavailable",{exact:true})).toBeVisible();
    await page.screenshot({path:`test-results/infrastructure/${width}.png`,fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Horizontal overflow at ${width}px: ${JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll("body *")].filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right}))))}`);
    const audit=await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa"]).analyze();
    assert.deepEqual(audit.violations.filter(item=>["serious","critical"].includes(item.impact)),[]);
    await page.screenshot({path:`test-results/infrastructure/${width}.png`,fullPage:true});
    unavailable=true; await page.getByRole("button",{name:"Refresh observations"}).click();
    await expect(page.getByRole("region", {name:"Infrastructure observations"}).getByRole("alert")).toContainText("observations are unavailable");
    await expect(page.getByRole("heading",{name:"Portainer",exact:true})).toHaveCount(0);
    unavailable=false; await page.getByRole("button",{name:"Refresh observations"}).click();
    await expect(page.getByRole("heading",{name:"Portainer",exact:true})).toBeVisible();
    await context.close();
  }
  role="viewer";const before=snapshots;
  const page=await browser.newPage();await page.goto(origin+"/admin?section=Infrastructure");
  await expect(page.getByRole("heading",{name:"Infrastructure",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Infrastructure",exact:true})).toHaveCount(0);
  await delay(300);assert.equal(snapshots,before,"Ordinary UI requested protected infrastructure");
  console.log("Infrastructure desktop/mobile rendering, accessibility, failure/recovery and ordinary-user navigation passed.");
} finally {
  await browser?.close();
  if(child&&child.exitCode===null){child.kill("SIGTERM");await once(child,"exit");}
  await new Promise(resolve=>api.close(resolve));
}
