import {readFile, access, cp, mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('docs/engineering/design-system.consumer.json',root),'utf8'));
const css=await readFile(new URL(manifest.local_artifacts[0],root),'utf8');
test('shared foundation has an explicit pinned owner/version/digest',()=>{
  assert.equal(manifest.owner,'DruHustle/onesa-company-portal');
  assert.equal(manifest.version,'1.0.0');
  assert.equal(createHash('sha256').update(css).digest('hex'),manifest.sha256);
  assert.match(css,/@media \(prefers-color-scheme: dark\)/);
  assert.match(css,/color-scheme: light;/);assert.match(css,/color-scheme: dark;/);
});
test('shared product navigation uses the pinned applications artifact and current Robot name',async()=>{
  const bytes=await readFile(new URL(manifest.applications.local_artifacts[0],root));
  const applications=JSON.parse(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.applications.sha256);
  assert.equal(applications.version,manifest.applications.version);
  assert.equal(applications.version,'1.0.1');
  assert.equal(applications.applications.find(product=>product.id==='robot').label,'Onesa Robot');
});
test('initial and live appearance require no boot script, timer or persisted override',async()=>{
  for(const path of ['onesa-company-portal-frontend/src/lib/day-night-boot.ts','onesa-company-portal-frontend/src/components/automatic-day-night.tsx'])await assert.rejects(access(new URL(path,root)));
  for(const path of ['onesa-company-portal-frontend/src/app/[locale]/layout.tsx','onesa-company-portal-frontend/src/app/admin/layout.tsx']){
    const source=await readFile(new URL(path,root),'utf8');
    assert.doesNotMatch(source,/AutomaticDayNight|suppressHydrationWarning|localStorage|setTimeout|getHours/);
    assert.match(source,/data-onesa-product="company"/);
  }
});
function luminance(hex){const c=hex.match(/\w\w/g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];}
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
test('all shared text, product action and status mappings meet ordinary text contrast',()=>{
  const light=css.slice(0,css.indexOf('@media (prefers-color-scheme: dark)'));
  const dark=css.slice(css.indexOf('@media (prefers-color-scheme: dark)'),css.indexOf(':focus-visible'));
  for(const block of [light,dark]){
    const values=Object.fromEntries([...block.matchAll(/--onesa-([\w-]+): #(\w{6})/g)].map(m=>[m[1],m[2]]));
    for(const [foreground,background] of [['text','canvas'],['text','surface'],['muted','canvas'],['muted','surface'],['success','success-surface'],['warning','warning-surface'],['error','error-surface'],['info','info-surface']])assert.ok(contrast(values[foreground],values[background])>=4.5,foreground);
    for(const m of block.matchAll(/--onesa-accent: #(\w{6})/g))assert.ok(contrast(m[1],values['on-accent'])>=4.5,m[1]);
    assert.ok(contrast(values.border,values.canvas)>=3,'control border');
  }
});
test('versioned identity assets are square, self-contained and distinct across products',async()=>{
  const directory='onesa-company-portal-frontend/public/brand/icons/v1/';
  const sources=JSON.parse(await readFile(new URL(directory+'sources.json',root),'utf8'));
  assert.equal(sources.version,'1.0.0');
  assert.equal(createHash('sha256').update(await readFile(new URL(sources.source,root))).digest('hex'),sources.sourceSha256);
  const icons=[];
  for(const product of sources.products){
    if(product.id==='robot')assert.equal(product.title,'Onesa Robot');
    for(const file of product.files){
      const bytes=await readFile(new URL(directory+file.name,root));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.name);
      if(file.mime==='image/svg+xml'){
        assert.ok(bytes.toString().includes(`<title>${product.title}</title>`));
        assert.match(bytes.toString(),/viewBox="0 0 32 32"/);
        assert.doesNotMatch(bytes.toString(),/<script|<foreignObject|\bhref=|\bon\w+=|https?:\/\/(?!www\.w3\.org)/);
        assert.ok(bytes.length<4096,'optimized standalone SVG');
      }else if(file.mime==='image/png'){
        assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
        assert.equal(bytes.readUInt32BE(16),file.width);assert.equal(bytes.readUInt32BE(20),file.height);
      }else{
        assert.equal(bytes.readUInt16LE(0),0);assert.equal(bytes.readUInt16LE(2),1);assert.equal(bytes.readUInt16LE(4),3);
        for(let i=0;i<3;i++){
          const at=6+i*16,size=[16,32,64][i],offset=bytes.readUInt32LE(at+12),length=bytes.readUInt32LE(at+8);
          assert.equal(bytes[at],size);assert.equal(bytes[at+1],size);
          assert.ok(offset>=54&&offset+length<=bytes.length);
          assert.equal(bytes.subarray(offset,offset+8).toString('hex'),'89504e470d0a1a0a');
          assert.equal(bytes.readUInt32BE(offset+16),size);assert.equal(bytes.readUInt32BE(offset+20),size);
        }
        icons.push(file.sha256);
      }
    }
  }
  assert.equal(new Set(icons).size,4,'product icons differ beyond identical fallback bytes');
  for(const file of manifest.identity.files)assert.equal(createHash('sha256').update(await readFile(new URL(file.path,root))).digest('hex'),file.sha256);
});
test('canonical title-only generation preserves pixels and rejects changed or missing inputs',async(t)=>{
  const icons='onesa-company-portal-frontend/public/brand/icons/v1/';
  for(const scenario of ['rename','missing','tampered-raster','changed-geometry'])await t.test(scenario,async()=>{
    const fixture=await mkdtemp(join(tmpdir(),'onesa-identity-title-'));
    try{
      await mkdir(join(fixture,'scripts'));
      await cp(new URL('scripts/generate_identity_icons.mjs',root),join(fixture,'scripts/generate_identity_icons.mjs'));
      await mkdir(join(fixture,'onesa-company-portal-frontend/public/brand'),{recursive:true});
      await cp(new URL('onesa-company-portal-frontend/public/brand/onesa-orbit.png',root),join(fixture,'onesa-company-portal-frontend/public/brand/onesa-orbit.png'));
      await cp(new URL(icons,root),join(fixture,icons),{recursive:true});
      const manifestPath=join(fixture,icons,'sources.json');
      const recorded=JSON.parse(await readFile(manifestPath,'utf8'));
      const robot=recorded.products.find(product=>product.id==='robot');
      const svgFile=robot.files.find(file=>file.name==='onesa-robot.svg');
      if(scenario==='rename'||scenario==='changed-geometry'){
        const path=join(fixture,icons,svgFile.name);
        let svg=await readFile(path,'utf8');
        if(scenario==='rename'){
          svg=svg.replace('<title>Onesa Robot</title>','<title>Onesa AI Robot</title>');
          robot.title='Onesa AI Robot';
        }else svg=svg.replace('fill="#0a1d31"','fill="#0b1d31"');
        await writeFile(path,svg);
        svgFile.bytes=Buffer.byteLength(svg);
        svgFile.sha256=createHash('sha256').update(svg).digest('hex');
        await writeFile(manifestPath,JSON.stringify(recorded,null,2)+'\n');
      }else if(scenario==='missing')await rm(join(fixture,icons,'onesa-robot-32.png'));
      else{
        const path=join(fixture,icons,'onesa-robot-32.png');
        await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('changed fixture')]));
      }
      const output=join(fixture,'generated');
      const result=spawnSync(process.execPath,[join(fixture,'scripts/generate_identity_icons.mjs'),'--titles-only',output],{encoding:'utf8',timeout:10000});
      assert.equal(result.error,undefined);
      if(scenario==='rename'){
        assert.equal(result.status,0,result.stderr);
        assert.equal(JSON.parse(result.stdout).rasterRenderingPerformed,false);
        const expected=JSON.parse(await readFile(new URL(icons+'sources.json',root),'utf8'));
        assert.deepEqual(JSON.parse(await readFile(join(output,'sources.json'),'utf8')),expected);
        for(const product of expected.products)for(const file of product.files){
          assert.deepEqual(await readFile(join(output,file.name)),await readFile(new URL(icons+file.name,root)));
        }
      }else{
        assert.notEqual(result.status,0,'Changed identity input must refuse generation');
        await assert.rejects(access(output));
      }
    }finally{await rm(fixture,{recursive:true,force:true});}
  });
});
