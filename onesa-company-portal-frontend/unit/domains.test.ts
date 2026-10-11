import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {surface,routeDestination,applicationOrigin} from '../src/lib/domains.ts';
import {companySitemap} from '../src/lib/company-sitemap.ts';
import {companyOrigin,companyPageUrl,companyLanguages} from '../src/lib/site-origin.mjs';
import {publicContentPath} from '../src/lib/public-content-url.mjs';
const original={...process.env};
test('Company sitemap excludes unreleased content, redirect aliases and private routes',()=>{
 assert.deepEqual(companySitemap('https://onesa.eu',false),[]);
 assert.deepEqual(companySitemap(undefined,true),[]);
 assert.deepEqual(companySitemap('http://localhost:3300',true),[]);
 const sitemap=companySitemap('https://onesa.eu',true);
 for(const locale of ['en','de']){
  assert.ok(sitemap.some(entry=>entry.url===(locale==='en'?'https://onesa.eu/':'https://onesa.eu/de')));
  assert.ok(sitemap.some(entry=>entry.url===`https://onesa.eu/${locale}/privacy`));
 }
 assert.ok(!sitemap.some(entry=>entry.url==='https://onesa.eu/en'));
 for(const entry of sitemap){
  assert.ok(!/\/(admin|api|privacy-policy|search)(\/|$)/.test(new URL(entry.url).pathname));
  assert.equal(entry.lastModified,undefined);
  assert.ok(entry.alternates?.languages?.en&&entry.alternates?.languages?.de);
 }
});
afterEach(()=>{for(const key of ['SITE_URL','PORTAL_URL','PUBLIC_ORIGIN','PUBLIC_RELEASE_ENABLED','VERCEL']){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}});
test('Canonical homepage aliases and hreflang agree with sitemap destinations',()=>{
 delete process.env.SITE_URL;
 assert.equal(companyOrigin(),'https://onesa.eu');
 const origin='https://onesa.eu';
 assert.equal(companyPageUrl(origin,'en'),'https://onesa.eu/');
 assert.deepEqual(companyLanguages(origin),{en:'https://onesa.eu/',de:'https://onesa.eu/de','x-default':'https://onesa.eu/'});
 for(const entry of companySitemap(origin,true)){
  for(const url of Object.values(entry.alternates!.languages!))assert.ok(companySitemap(origin,true).some(page=>page.url===url));
 }
});
test('Published details are discoverable without inventing translation routes or dates',()=>{
 const published=[
  {kind:'article',locale:'en',slug:'launch',updated_at:'2026-10-10T10:00:00Z'},
  {kind:'job',locale:'de',slug:'engineer',updated_at:'invalid'},
  {kind:'page',locale:'en',slug:'about',updated_at:'2026-10-11T10:00:00Z'},
  {kind:'page',locale:'en',slug:'homepage',updated_at:'2026-10-12T10:00:00Z'},
  {kind:'page',locale:'en',slug:'unimplemented-page',updated_at:'2026-10-12T10:00:00Z'},
  {kind:'article',locale:'fr',slug:'launch',updated_at:'2026-10-12T10:00:00Z'},
  {kind:'article',locale:'en',slug:'../../admin',updated_at:'2026-10-12T10:00:00Z'},
 ];
 assert.deepEqual(companySitemap('https://onesa.eu',false,published),[]);
 const pages=companySitemap('https://onesa.eu',true,published);
 const article=pages.find(page=>page.url==='https://onesa.eu/en/news/launch')!;
 assert.equal(new Date(article.lastModified!).toISOString(),'2026-10-10T10:00:00.000Z');
 assert.equal(article.alternates,undefined);
 assert.equal(pages.find(page=>page.url==='https://onesa.eu/de/careers/engineer')!.lastModified,undefined);
 assert.equal(pages.filter(page=>page.url==='https://onesa.eu/en/about').length,1);
 assert.equal(pages.filter(page=>page.url==='https://onesa.eu/').length,1);
 assert.ok(!pages.some(page=>/unimplemented|\/fr\/|\.\./.test(page.url)));
 assert.equal(publicContentPath(published[2]),'/en/about');
 assert.equal(publicContentPath(published[3]),'/');
 assert.equal(publicContentPath(published[4]),null);
});
test('Malformed or hosted loopback origins cannot publish canonical URLs',()=>{
 for(const value of ['https://onesa.eu/','https://onesa.eu/path','https://onesa.eu?query=1','https://onesa.eu#fragment','https://user:password@onesa.eu','http://onesa.eu']){
  process.env.SITE_URL=value;assert.throws(()=>companyOrigin());
 }
 delete process.env.VERCEL;delete process.env.PUBLIC_RELEASE_ENABLED;
 process.env.SITE_URL='http://localhost:3300';assert.equal(companyOrigin(),process.env.SITE_URL);
 process.env.VERCEL='1';assert.throws(()=>companyOrigin());
 delete process.env.VERCEL;process.env.PUBLIC_RELEASE_ENABLED='true';assert.throws(()=>companyOrigin());
 process.env.SITE_URL='https://localhost';assert.throws(()=>companyOrigin());
 process.env.SITE_URL='https://onesa.eu';assert.equal(companyOrigin(),process.env.SITE_URL);
});
function configure(){process.env.SITE_URL='https://onesa.eu';process.env.PORTAL_URL='https://portal.onesa.eu';process.env.PUBLIC_ORIGIN=process.env.PORTAL_URL;}
test('Configured hosts separate company and portal and reject other hosts',()=>{
 configure();assert.equal(surface('https://onesa.eu'),'company');assert.equal(surface('https://portal.onesa.eu'),'portal');assert.equal(surface('https://onesa.eu.attacker.invalid'),'unknown');assert.equal(surface('https://unknown.vercel.app'),'unknown');
 assert.equal(routeDestination('https://portal.onesa.eu','/'),'https://portal.onesa.eu/admin');
 assert.equal(routeDestination('https://onesa.eu','/admin/users'),'https://portal.onesa.eu/admin/users');
 assert.equal(routeDestination('https://portal.onesa.eu','/en/contact'),'https://onesa.eu/en/contact');
 assert.equal(routeDestination('https://portal.onesa.eu','/admin'),null);
 assert.equal(routeDestination('https://portal.onesa.eu','/brand/onesa-orbit.png'),null);
 assert.equal(routeDestination('https://portal.onesa.eu','/social/onesa-banner.png'),null);
});
test('A mismatched authentication origin and credentials in URLs fail configuration',()=>{
 configure();process.env.PUBLIC_ORIGIN='https://onesa.eu';assert.throws(()=>surface('https://onesa.eu'));
 process.env.PUBLIC_ORIGIN=process.env.PORTAL_URL;process.env.SITE_URL='https://user:password@onesa.eu';assert.throws(()=>surface('https://onesa.eu'));
});
test('Local single-host operation remains supported without domain splitting',()=>{delete process.env.PORTAL_URL;assert.equal(surface('http://localhost:3300'),'combined');assert.equal(routeDestination('http://localhost:3300','/admin'),null);});
test('Host selection uses configured origins even when Next.js has an internal server URL',()=>{configure();assert.equal(applicationOrigin('portal.onesa.eu','http://127.0.0.1:3362'),'https://portal.onesa.eu');assert.equal(applicationOrigin('onesa.eu','http://127.0.0.1:3362'),'https://onesa.eu');assert.equal(applicationOrigin('onesa.eu.attacker.invalid','https://onesa.eu'),null);assert.equal(applicationOrigin('onesa.eu:444','https://onesa.eu'),null);assert.equal(applicationOrigin(null,'https://onesa.eu'),null);});
