import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {verifyPortalVercelRoot} from "./check-portal-vercel-root.mjs";

const contract = JSON.stringify({
  schema:1,vercel_team:"druhustles-projects",vercel_project:"onesa-company-portal",
  vercel_project_id:"prj_91TBAfa7ByYzG6Q022gTbzI6iR2m",
  root_directory:"onesa-company-portal-frontend",dev_source_directory:"onesa-portal-frontend",
});
function fixture(t, {modern=true} = {}) {
  const root=mkdtempSync(join(tmpdir(), "portal-vercel-contract-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,"infra/vercel"),{recursive:true});
  writeFileSync(join(root,"infra/vercel/portal-root-contract.json"),contract);
  for (const dir of ["onesa-company-portal-frontend", ...(modern?["onesa-portal-frontend"]:[])]) {
    mkdirSync(join(root,dir));
    writeFileSync(join(root,dir,"package.json"),JSON.stringify({scripts:{build:"next build --webpack"}}));
    writeFileSync(join(root,dir,"vercel.json"),"{}");
    writeFileSync(join(root,dir,"next.config.mjs"),"export default {}");
  }
  return root;
}
test("checked-in Vercel root exists with real Next.js files on main and staging", t=>{
  const root=fixture(t,{modern:false});
  for(const targetBranch of ["main","staging"]) {
    const v=verifyPortalVercelRoot({root,targetBranch});
    assert.equal(v.rootDirectory,"onesa-company-portal-frontend");
    assert.equal(v.mirrorVerified,false);
  }
});
test("dev checks real mirror identity before allowing Vercel preview",t=>{
  const root=fixture(t);
  const a="a".repeat(40),b="b".repeat(40);
  const ok=verifyPortalVercelRoot({root,targetBranch:"dev",treeSha:()=>a});
  assert.equal(ok.mirrorVerified,true);
  assert.equal(ok.sourceDirectory,"onesa-portal-frontend");
  assert.throws(()=>verifyPortalVercelRoot({root,targetBranch:"dev",treeSha:name=>name.startsWith("onesa-company")?a:b}),/folder drift/);
});
test("dev refuses a missing canonical source or an invalid deploy root",t=>{
  const root=fixture(t,{modern:false});
  assert.throws(()=>verifyPortalVercelRoot({root,targetBranch:"dev"}),/missing/);
  rmSync(join(root,"onesa-company-portal-frontend"),{recursive:true,force:true});
  assert.throws(()=>verifyPortalVercelRoot({root,targetBranch:"main"}),/missing/);
});
test("Vercel Root Directory may not be a symbolic link",t=>{
  const root=fixture(t);
  rmSync(join(root,"onesa-company-portal-frontend"),{recursive:true,force:true});
  symlinkSync("onesa-portal-frontend",join(root,"onesa-company-portal-frontend"),"dir");
  assert.throws(()=>verifyPortalVercelRoot({root,targetBranch:"dev"}),/real Git directory/);
});
test("invalid or swapped Vercel project settings refuse deployment",t=>{
  const root=fixture(t);
  const config=JSON.parse(contract);
  config.root_directory="onesa-portal-frontend";
  writeFileSync(join(root,"infra/vercel/portal-root-contract.json"),JSON.stringify(config));
  assert.throws(()=>verifyPortalVercelRoot({root,targetBranch:"dev"}),/changed unexpectedly/);
});
