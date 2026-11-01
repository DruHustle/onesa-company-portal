// Explicit build-time derivatives of the approved owner artwork; no runtime sibling dependency.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,join} from 'node:path';
import {createRequire} from 'node:module';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source='onesa-company-portal-frontend/public/brand/onesa-orbit.png';
const sourceSha='4dc5ada01211fe5127ab59f33a9e4b19482658ef9878300fa088de4b27e6d7e6';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(sha(readFileSync(join(root,source)))!==sourceSha)throw new Error('Approved artwork changed: review derivatives before generating');
// Cyan O outline traced from the supplied artwork, 5943 source pixels, two contours,
// even-odd fill and <=0.65-source-pixel simplification. Original bitmap remains unchanged.
const mark="M5.43,13.12 5.58,13.12 5.58,12.39 5.72,12.39 5.72,11.67 5.87,11.67 6.01,10.80 6.16,10.80 6.16,10.51 6.30,10.51 6.30,10.22 6.45,10.22 6.74,9.35 7.03,9.21 7.03,8.91 7.32,8.77 7.32,8.48 7.46,8.48 7.46,8.34 7.61,8.34 7.61,8.19 7.75,8.19 7.75,8.04 7.90,8.04 8.62,7.17 8.91,7.17 8.91,7.03 9.06,7.03 9.21,6.74 9.50,6.74 9.64,6.45 9.93,6.45 9.93,6.30 10.22,6.30 10.22,6.16 10.51,6.16 10.51,6.01 10.95,6.01 10.95,5.87 11.81,5.72 11.81,5.58 12.39,5.58 12.39,5.43 16.16,5.43 16.16,5.58 16.74,5.58 16.74,5.72 17.18,5.72 17.18,5.87 18.05,6.01 18.05,6.16 18.34,6.16 18.34,6.30 19.21,6.59 19.50,7.03 19.79,7.03 20.08,7.46 20.37,7.46 20.37,7.61 20.95,8.04 20.95,8.34 21.09,8.34 21.09,8.48 21.53,8.77 21.53,9.06 21.82,9.21 21.82,9.50 21.96,9.50 21.96,9.79 22.11,9.79 22.11,10.07 22.25,10.07 22.25,10.36 22.40,10.36 22.40,10.65 22.54,10.65 22.54,11.09 22.69,11.09 22.69,11.38 22.83,11.38 22.83,11.96 22.98,11.96 22.98,12.54 23.12,12.54 23.12,13.55 23.27,13.55 23.27,16.60 23.12,16.60 23.12,17.61 22.98,17.61 22.98,18.05 22.83,18.05 22.83,18.63 22.69,18.63 22.54,19.50 22.40,19.50 22.40,19.79 22.25,19.79 21.96,20.66 21.67,20.80 21.53,21.38 20.80,21.96 20.80,22.25 20.52,22.25 19.79,23.12 19.21,23.27 19.06,23.56 18.77,23.56 18.77,23.70 18.48,23.70 18.48,23.85 18.20,23.85 18.20,23.99 17.91,23.99 17.91,24.14 17.47,24.14 17.47,24.29 17.03,24.29 17.03,24.43 16.60,24.43 16.60,24.57 15.73,24.57 15.73,24.72 12.97,24.72 12.97,24.57 11.52,24.43 11.52,24.29 10.80,24.14 10.80,23.99 10.51,23.99 10.51,23.85 10.22,23.85 10.22,23.70 9.35,23.41 9.21,23.12 8.91,23.12 8.91,22.98 8.77,22.98 8.04,22.11 7.75,22.11 7.75,21.82 7.17,21.38 7.17,21.09 6.88,20.95 6.74,20.37 6.45,20.23 6.45,19.79 6.30,19.79 6.30,19.50 6.16,19.50 6.16,19.21 6.01,19.21 6.01,18.77 5.87,18.77 5.87,18.34 5.72,18.34 5.58,17.03 5.43,17.03 5.43,13.12ZM8.04,13.26 8.04,17.18 8.19,17.18 8.34,18.34 8.48,18.34 8.48,18.63 8.62,18.63 8.77,19.35 8.91,19.35 9.06,19.79 9.35,19.93 9.35,20.23 9.50,20.23 9.50,20.37 9.64,20.37 9.64,20.52 9.79,20.52 9.79,20.66 9.93,20.66 10.65,21.53 11.23,21.67 11.38,21.96 11.81,21.96 11.81,22.11 12.11,22.11 12.11,22.25 13.12,22.40 13.12,22.54 15.44,22.54 15.44,22.40 16.60,22.25 16.60,22.11 16.89,22.11 16.89,21.96 17.76,21.67 18.05,21.24 18.34,21.24 18.34,21.09 19.06,20.52 19.06,20.23 19.50,19.93 19.50,19.64 19.79,19.50 19.79,19.06 19.93,19.06 19.93,18.77 20.08,18.77 20.08,18.48 20.23,18.48 20.23,17.91 20.37,17.91 20.37,17.47 20.52,17.47 20.52,16.45 20.66,16.45 20.66,13.70 20.52,13.70 20.52,12.68 20.37,12.68 20.37,12.25 20.23,12.25 20.08,11.38 19.93,11.38 19.93,11.09 19.79,11.09 19.50,10.22 19.06,9.93 19.06,9.64 18.92,9.64 18.20,8.77 17.91,8.77 17.76,8.48 17.18,8.34 17.03,8.04 16.60,8.04 16.60,7.90 16.16,7.90 16.16,7.75 15.58,7.75 15.58,7.61 13.12,7.61 13.12,7.75 12.39,7.75 12.39,7.90 12.11,7.90 12.11,8.04 11.67,8.04 11.67,8.19 10.80,8.48 10.80,8.62 10.65,8.62 10.51,8.91 10.22,8.91 10.22,9.06 9.35,9.79 9.35,10.07 9.06,10.22 9.06,10.51 8.91,10.51 8.91,10.80 8.77,10.80 8.77,11.09 8.62,11.09 8.62,11.52 8.48,11.52 8.48,11.81 8.34,11.81 8.34,12.54 8.19,12.54 8.19,13.26 8.04,13.26Z";
const products=[
 {id:'company',title:'Onesa Company',accent:'#407cce',frame:'<rect x="1" y="1" width="30" height="30" rx="7"/>'},
 {id:'ai',title:'Onesa AI Platform',accent:'#9c90ed',frame:'<path d="M13 2Q16-1 19 2L30 13Q33 16 30 19L19 30Q16 33 13 30L2 19Q-1 16 2 13Z"/>'},
 {id:'robot',title:'Onesa Robot',accent:'#2da8a0',frame:'<circle cx="16" cy="16" r="15"/>'},
 {id:'docs',title:'Onesa Developer Docs',accent:'#a1b0c6',frame:'<path d="M3 1H23L31 9V31H3Z"/><path d="M23 1V9H31" fill="none"/>'},
];
const svgFor=product=>`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><title>${product.title}</title><g fill="#0a1d31" stroke="${product.accent}" stroke-width="2">${product.frame}</g><path d="${mark}" fill="#4ed6e7" fill-rule="evenodd"/></svg>
`;
const titlesOnly=process.argv.includes('--titles-only');
const arguments_=process.argv.slice(2).filter(value=>value!=='--titles-only');
if(arguments_.length>1||arguments_.some(value=>value.startsWith('--')))throw new Error('Usage: generate_identity_icons.mjs [--titles-only] [output-directory]');
const canonicalOutput=join(root,'onesa-company-portal-frontend/public/brand/icons/v1');
const output=arguments_[0]?resolve(arguments_[0]):canonicalOutput;
const previousFiles=new Map();
if(titlesOnly){
 const previous=JSON.parse(readFileSync(join(canonicalOutput,'sources.json'),'utf8'));
 if(previous.version!=='1.0.0'||previous.source!==source||previous.sourceSha256!==sourceSha||previous.products.length!==products.length)throw new Error('Approved identity provenance changed');
 for(const product of products){
  const matches=previous.products.filter(value=>value.id===product.id);
  if(matches.length!==1||matches[0].accent!==product.accent)throw new Error('Product identity changed beyond its title');
  const recorded=matches[0].files;
  const names=['.svg','-16.png','-32.png','-64.png','.ico','-180.png'].map(suffix=>'onesa-'+product.id+suffix);
  if(recorded.length!==names.length||new Set(recorded.map(file=>file.name)).size!==names.length||recorded.some(file=>!names.includes(file.name)))throw new Error('Complete known icon derivatives required');
  for(const file of recorded){
   const bytes=readFileSync(join(canonicalOutput,file.name));
   if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw new Error('Existing icon differs from its approved provenance');
   previousFiles.set(file.name,bytes);
  }
  const before=previousFiles.get('onesa-'+product.id+'.svg').toString('utf8');
  const withoutTitle=value=>value.replace(/<title>[^<>]*<\/title>/,'<title/>');
  if((before.match(/<title>/g)||[]).length!==1||!before.includes(`<title>${matches[0].title}</title>`)||withoutTitle(before)!==withoutTitle(svgFor(product)))throw new Error('Title-only generation cannot change icon geometry, styling, or unbound metadata');
 }
}
mkdirSync(output,{recursive:true});
const require=createRequire(join(root,'onesa-company-portal-frontend/package.json'));
const browser=titlesOnly?null:await require('playwright').chromium.launch({headless:true});
const page=browser?await browser.newPage():null;
const manifest={version:'1.0.0',source,sourceSha256:sourceSha,rights:'Owner-supplied Onesa artwork; technical product-icon derivatives authorized by master specification Section10.4. No new official or registered logo is asserted.',method:'Source-traced common O; distinct geometric frames and product accents; existing Chromium SVG export, no generative redraw or source-bitmap modification.',products:[]};
try{for(const product of products){
 const svg=svgFor(product);
 const prefix=`onesa-${product.id}`;const files=[];
 const save=(name,bytes,width,height,mime)=>{if(titlesOnly&&mime!=='image/svg+xml'&&!bytes.equals(previousFiles.get(name)))throw new Error('Title-only generation cannot change raster or ICO bytes');writeFileSync(join(output,name),bytes);files.push({name,sha256:sha(bytes),bytes:bytes.length,width,height,mime});};
 save(prefix+'.svg',Buffer.from(svg),32,32,'image/svg+xml');
 const rendered=titlesOnly?Object.fromEntries([16,32,64,180].map(size=>[size,previousFiles.get(prefix+'-'+size+'.png').toString('base64')])):await page.evaluate(async svg=>{const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(svg);await image.decode();const images={};for(const size of [16,32,64,180]){const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;canvas.getContext('2d').drawImage(image,0,0,size,size);images[size]=canvas.toDataURL('image/png').split(',')[1];}return images;},svg);
 const frames=[16,32,64].map(size=>({size,bytes:Buffer.from(rendered[size],'base64')}));
 const header=Buffer.alloc(6+16*frames.length);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);let offset=header.length;
 for(let i=0;i<frames.length;i++){const {size,bytes}=frames[i];let at=6+i*16;header[at]=size;header[at+1]=size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(bytes.length,at+8);header.writeUInt32LE(offset,at+12);offset+=bytes.length;save(prefix+'-'+size+'.png',bytes,size,size,'image/png');}
 save(prefix+'.ico',titlesOnly?previousFiles.get(prefix+'.ico'):Buffer.concat([header,...frames.map(x=>x.bytes)]),null,null,'image/vnd.microsoft.icon');
 save(prefix+'-180.png',Buffer.from(rendered[180],'base64'),180,180,'image/png');
 manifest.products.push({...product,frame:undefined,files});
}}finally{await browser?.close();}
writeFileSync(join(output,'sources.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({version:manifest.version,sourceUnchanged:true,rasterRenderingPerformed:!titlesOnly,products:manifest.products.map(x=>({id:x.id,files:x.files.length,bytes:x.files.reduce((n,f)=>n+f.bytes,0)}))}));
