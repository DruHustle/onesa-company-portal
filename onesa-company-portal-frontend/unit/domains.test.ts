import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {surface,routeDestination,applicationOrigin} from '../src/lib/domains.ts';
import {companySitemap} from '../src/lib/company-sitemap.ts';
const original={...process.env};
test('Company sitemap excludes unreleased content, redirect aliases and private routes',()=>{
 assert.deepEqual(companySitemap('https://onesa.eu',false),[]);
 assert.deepEqual(companySitemap(undefined,true),[]);
 assert.deepEqual(companySitemap('http://localhost:3300',true),[]);
 const sitemap=companySitemap('https://onesa.eu',true);
 for(const locale of ['en','de']){
  assert.ok(sitemap.some(entry=>entry.url===`https://onesa.eu/${locale}`));
  assert.ok(sitemap.some(entry=>entry.url===`https://onesa.eu/${locale}/privacy`));
 }
 for(const entry of sitemap){
  assert.ok(!/\/(admin|api|privacy-policy|search)(\/|$)/.test(new URL(entry.url).pathname));
  assert.equal(entry.lastModified,undefined);
  assert.ok(entry.alternates?.languages?.en&&entry.alternates?.languages?.de);
 }
});
afterEach(()=>{for(const key of ['SITE_URL','PORTAL_URL','PUBLIC_ORIGIN']){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}});
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
