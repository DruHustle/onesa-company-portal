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
