import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const root = process.cwd();
const ai = path.basename(root) === 'onesa-ai-platform';
const front = ai ? 'onesa-ai-platform-frontend/apps/chat' : 'onesa-company-portal-frontend';
const require = createRequire(path.join(root, front, 'package.json'));
const { chromium } = require('@playwright/test');
const folder = path.join(root, 'docs/internal/release-audit');
if (!fs.existsSync(path.join(folder, 'RELEASE_DECISION.md'))) throw Error('Restricted audit sources missing');
const artifacts = path.join(folder, 'artifacts');fs.mkdirSync(artifacts, { recursive:true, mode:0o700 });
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const inline = value => escape(value).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,url)=>'<a href="'+(url.startsWith('https://')?url:escape(path.join(folder,url)))+'">'+label+'</a>');
function markdown(source){
 let output='',code=false,table=false;
 for(const line of source.split('\n')){
  if(line.startsWith('```')){ if(table){output+='</tbody></table>';table=false;}output+=code?'</code></pre>':'<pre><code>';code=!code;continue; }
  if(code){output+=escape(line)+'\n';continue;}
  if(line.startsWith('|')){if(/^\|[-| :]+\|$/.test(line))continue;if(!table){output+='<table><tbody>';table=true;}output+='<tr>'+line.slice(1,-1).split('|').map(cell=>'<td>'+inline(cell.trim())+'</td>').join('')+'</tr>';continue;}
  if(table){output+='</tbody></table>';table=false;}
  const heading=line.match(/^(#{1,6}) (.*)/);
  if(heading)output+='<h'+heading[1].length+'>'+inline(heading[2])+'</h'+heading[1].length+'>';
  else if(line.startsWith('> '))output+='<div class="notice">'+inline(line.slice(2))+'</div>';
  else if(line.startsWith('- '))output+='<div class="bullet">• '+inline(line.slice(2))+'</div>';
  else if(line.trim())output+='<p>'+inline(line)+'</p>';
 }
 if(table)output+='</tbody></table>';return output;
}
const css='body{font:10pt/1.48 Arial,sans-serif;color:#173238}h1{font-size:24pt;color:#065e46}h2{font-size:16pt;margin-top:20pt}h3{font-size:12pt}a{color:#065e46;overflow-wrap:anywhere}p,.bullet{margin:5pt 0;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:8pt}td{border:1px solid #cbd5d1;padding:5pt;vertical-align:top;overflow-wrap:anywhere}tr{break-inside:avoid}pre{font:8pt/1.45 monospace;background:#eef4f1;padding:12pt;white-space:pre-wrap;overflow-wrap:anywhere}code{font-size:8pt}.notice{font-size:8pt;color:#53645d}.cover{break-after:page;padding-top:100pt}.section{break-before:page}svg{width:100%;height:auto}.toc a{display:block;padding:4pt 0}';
const header='<html lang="en"><head><meta charset="utf-8"><title>Onesa restricted release audit</title><style>'+css+'</style></head><body>';
const sourceNames=fs.readdirSync(folder).filter(x=>x.endsWith('.md')).sort();
const decision=sourceNames.indexOf('RELEASE_DECISION.md');sourceNames.unshift(sourceNames.splice(decision,1)[0]);
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();await page.route('http://**/*',route=>route.abort());await page.route('https://**/*',route=>route.abort());
 for(const [name,names,title] of [['release-audit',sourceNames,'Release audit and qualification'],['deployment-runbook',['ARCHITECTURE_AND_DEPLOYMENT.md','VERCEL_RENDER_RUNBOOK.md','BACKUP_RESTORE_REPORT.md','OWNER_ACTIONS.md'],'Deployment and recovery runbook']]){
  const toc=names.map((name,i)=>'<a href="#section'+i+'">'+escape(name.replace('.md','').replaceAll('_',' '))+'</a>').join('');
  const diagram=fs.existsSync(path.join(artifacts,'service-map.svg'))?fs.readFileSync(path.join(artifacts,'service-map.svg'),'utf8'):'';
  const body='<div class="cover"><h1>Onesa UG</h1><h2>'+title+'</h2><p>'+escape(path.basename(root))+'</p><p>RESTRICTED INTERNAL · v1 · 2026-10-09 · NO-GO</p><p>Local candidate; no deployment or legal approval. Exact baseline commit and candidate hash are recorded in each source report and evidence/gates.json.</p></div><h2>Contents</h2><div class="toc">'+toc+'</div>'+diagram+names.map((name,i)=>'<section class="section" id="section'+i+'">'+markdown(fs.readFileSync(path.join(folder,name),'utf8'))+'</section>').join('');
  await page.setContent(header+body+'</body></html>');
  const target=path.join(artifacts,name+'.pdf');await page.pdf({path:target,format:'A4',printBackground:true,outline:true,tagged:true,displayHeaderFooter:true,headerTemplate:'<div></div>',footerTemplate:'<div style="font-size:8px;width:100%;text-align:center">RESTRICTED INTERNAL · Onesa UG · 2026-10-09 · <span class="pageNumber"></span>/<span class="totalPages"></span></div>',margin:{top:'18mm',right:'16mm',bottom:'18mm',left:'16mm'}});fs.chmodSync(target,0o600);
 }
 for(const name of ['service-map','auth-flow','release-gates']){
  const svg=path.join(artifacts,name+'.svg');if(!fs.existsSync(svg))continue;
  await page.setViewportSize({width:1200,height:680});await page.setContent('<style>body{margin:0;background:white}</style>'+fs.readFileSync(svg,'utf8'));
  await page.locator('svg').screenshot({path:path.join(artifacts,name+'.png')});fs.chmodSync(path.join(artifacts,name+'.png'),0o600);
 }
 const manifest=fs.readdirSync(artifacts).filter(x=>/\.(pdf|svg|png)$/.test(x)).map(name=>({path:name,classification:'restricted-internal',approval:'pending',sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(artifacts,name))).digest('hex')}));
 fs.writeFileSync(path.join(artifacts,'manifest.json'),JSON.stringify({version:1,date:'2026-10-09',release_decision:'NO-GO',artifacts:manifest},null,2)+'\n',{mode:0o600});
 console.log('Rendered two genuine PDFs and three editable SVG/PNG diagram pairs; restricted manifest saved');
}finally{await browser.close();}
