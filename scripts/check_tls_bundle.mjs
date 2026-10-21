// Verify actual traced/deployable server code, never infer packaging from a successful build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const app=path.resolve(process.argv[2]||'');
const company=fs.existsSync(path.join(app,'src/lib/api/server.ts'));
const routes=company?['api/v1/[...path]','engineering/sign-in/[uid]/[action]']:['api/[...path]'];
const fingerprint='86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b';
const policy=text=>text.includes(fingerprint)&&text.includes('setDefaultCACertificates');
function containsPolicy(files){return files.some(file=>/\.[cm]?js$/.test(file)&&fs.existsSync(file)&&policy(fs.readFileSync(file,'utf8')));}
function walk(folder,seen=new Set()){
 const actual=fs.realpathSync(folder);if(seen.has(actual))return[];seen.add(actual);
 return fs.readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
  const file=path.join(folder,entry.name);return fs.statSync(file).isDirectory()?walk(file,seen):[file];
 });
}
let verified=0;
for(const route of routes){
 const entry=path.join(app,'.next/server/app',route,'route.js');
 const trace=JSON.parse(fs.readFileSync(entry+'.nft.json','utf8'));
 assert.equal(trace.version,1);
 assert(containsPolicy([entry,...trace.files.map(file=>path.resolve(path.dirname(entry),file))]),'TLS policy missing from server route trace: '+route);
 verified++;
}
const vercel=process.argv[3];
if(vercel){
 for(const route of routes){
  const folder=path.resolve(vercel,'functions',route+'.func');
  assert(containsPolicy(walk(folder)),'TLS policy missing from Vercel function: '+route);
 }
}
for(const file of walk(path.join(app,'.next/static'))){
 if(/\.[cm]?js$/.test(file))assert(!fs.readFileSync(file,'utf8').includes(fingerprint),'Node trust code leaked into browser bundle');
}
console.log(JSON.stringify({status:'PASS',server_route_traces:verified,actual_vercel_functions:vercel?verified:0,browser_policy_leaks:0}));
