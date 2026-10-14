import {readFile, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
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
    for(const file of product.files){
      const bytes=await readFile(new URL(directory+file.name,root));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.name);
      if(file.mime==='image/svg+xml'){
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
