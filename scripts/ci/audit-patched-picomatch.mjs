import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const source=resolve(process.cwd());
const advisory='https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const releases={
 v4:{dir:'onesa-picomatch-redos-4.0.8-onesa.1',version:'4.0.8-onesa.1',sha:'526b223084caa8bc76ab5706d3257b90af0cf762'},
 v2:{dir:'onesa-picomatch-redos-2.3.3-onesa.1',version:'2.3.3-onesa.1',sha:'aa99da7ba6195cd0e9b991517bbaaa41ae4b6184'}
};
const roots=[
 {name:'Portal frontend',folder:'.',nodes:{'node_modules/picomatch':'v4'}}
];
function gitBlob(data){return createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex')}
export function traceAudit(report){
 if(!report||typeof report!=='object'||report.error||!report.vulnerabilities||typeof report.vulnerabilities!=='object'||Array.isArray(report.vulnerabilities))throw Error('Missing complete npm advisory report');
 const vulnerabilities=report.vulnerabilities,names=Object.keys(vulnerabilities);
 if(!names.length)return {kind:'clear',count:0,nodes:[]};
 const root=vulnerabilities.picomatch;
 if(!root||!Array.isArray(root.via)||root.via.length!==1||typeof root.via[0]!=='object'||root.via[0]===null||root.via[0].name!=='picomatch'||root.via[0].url!==advisory||!Array.isArray(root.nodes)||!root.nodes.length)throw Error('Unknown direct npm vulnerability');
 const accepted=new Set(['picomatch']);
 for(let i=0;i<names.length;i++)for(const name of names){
  if(accepted.has(name))continue;
  const via=vulnerabilities[name]?.via;
  if(Array.isArray(via)&&via.length&&via.every(x=>typeof x==='string'&&accepted.has(x)))accepted.add(name);
 }
 if(accepted.size!==names.length)throw Error('Unrelated or unrecognized npm advisory');
 return {kind:'mitigated-source',count:names.length,nodes:root.nodes};
}
function checkInstalled(cfg){
 const base=join(source,cfg.folder),pkg=JSON.parse(readFileSync(join(base,'package.json'),'utf8'));
 const lock=JSON.parse(readFileSync(join(base,'package-lock.json'),'utf8'));
 const found=Object.keys(lock.packages).filter(p=>p.startsWith('node_modules/')&&p.endsWith('picomatch')).sort();
 assert.deepEqual(found,Object.keys(cfg.nodes).sort(),'All picomatch source paths must be registered');
 for(const [node,key]of Object.entries(cfg.nodes)){
  const r=releases[key],target='vendor/'+r.dir,actual=lock.packages[node],vendor=join(base,target);
  assert.equal(actual?.link,true);assert.equal(actual?.resolved,target);
  assert.equal(lock.packages[target]?.name,'@onesa/picomatch');assert.equal(lock.packages[target]?.version,r.version);
  assert.equal(gitBlob(readFileSync(join(vendor,'lib/parse.js'))),r.sha);
  assert.equal(realpathSync(join(base,node)),realpathSync(vendor));
  assert.equal(JSON.parse(readFileSync(join(base,node,'package.json'),'utf8')).version,r.version);
 }
 assert.equal(pkg.overrides?.picomatch,'file:vendor/'+releases.v4.dir);
 if(cfg.nodes['node_modules/micromatch/node_modules/picomatch'])assert.equal(pkg.overrides?.micromatch?.picomatch,'file:vendor/'+releases.v2.dir);
}
function audit(cfg){
 checkInstalled(cfg);
 const run=spawnSync('npm',['audit','--json','--package-lock-only','--audit-level=low','--prefix',cfg.folder],{cwd:source,encoding:'utf8',timeout:120000,maxBuffer:4194304});
 if(run.error||![0,1].includes(run.status))throw Error(cfg.name+': npm audit incomplete');
 let report;try{report=JSON.parse(run.stdout)}catch{throw Error(cfg.name+': invalid npm audit JSON')}
 const classification=traceAudit(report);
 if(classification.kind==='clear'){if(run.status!==0)throw Error(cfg.name+': audit failed with no findings');console.log(cfg.name+': standard audit passed');return}
 if(run.status!==1)throw Error(cfg.name+': inconsistent audit exit');
 for(const node of classification.nodes)if(!Object.hasOwn(cfg.nodes,node))throw Error(cfg.name+': unverified installed advisory path');
 console.log(cfg.name+': '+classification.count+' npm findings traced exclusively to GHSA-fc5q-39xc-vjpf; exact patched sources and installed links verified, other advisories refused');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{for(const c of roots)audit(c)}catch(e){console.error('Owner dependency security refused: '+e.message);process.exitCode=1}}
