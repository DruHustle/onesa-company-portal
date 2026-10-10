import http from 'node:http';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const origin=new URL(process.env.DOMAIN_TEST_FRONTEND_ORIGIN||'http://127.0.0.1:3362');
assert.equal(origin.protocol,'http:');
assert.ok(['127.0.0.1','localhost'].includes(origin.hostname),'Only the isolated local frontend may be probed');
function request(host,path,extra={}){return new Promise((resolve,reject)=>{const req=http.get(new URL(path,origin),{headers:{Host:host,'X-Forwarded-Host':host,'X-Forwarded-Proto':'https',...extra}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.setTimeout(25000,()=>req.destroy(new Error('Local probe timed out')));req.on('error',reject);});}
const cases=[['portal.onesa.eu','/',307,'https://portal.onesa.eu/admin'],['onesa.eu','/privacy-policy',308,'/en/privacy'],['onesa.eu','/admin/users',307,'https://portal.onesa.eu/admin/users'],['portal.onesa.eu','/en/contact',307,'https://onesa.eu/en/contact'],['unknown.invalid','/',421],['onesa.eu','/api/v1/auth/me',403],['portal.onesa.eu','/api/v1/auth/me',503]];
for(const [host,path,status,location] of cases){const response=await request(host,path);assert.equal(response.status,status,`${host}${path}`);if(location)assert.equal(response.headers.location,location);console.log(`PASS ${host}${path} → ${status}`);}
const spoof=await request('unknown.invalid','/',{'X-Forwarded-Host':'portal.onesa.eu'});assert.equal(spoof.status,421);
for(const host of ['onesa.eu','portal.onesa.eu']){const response=await request(host,'/favicon.ico');assert.equal(response.status,200,`${host} favicon`);assert.match(response.headers['content-type'],/image\/(x-icon|vnd.microsoft.icon)/);assert.equal(createHash('sha256').update(response.body).digest('hex'),createHash('sha256').update(readFileSync('public/favicon.ico')).digest('hex'));console.log(`PASS ${host} same-origin favicon`);}
for(const [host,path] of [['onesa.eu','/en'],['portal.onesa.eu','/admin']]){const response=await request(host,path);assert.equal(response.status,200);assert.match(response.body.toString(),/<link[^>]*rel="icon"[^>]*href="\/favicon\.ico\?v=20261010"/);console.log(`PASS ${host} explicit favicon metadata`);}
const robots=await request('onesa.eu','/robots.txt');assert.equal(robots.status,200);assert.match(robots.headers['content-type'],/text\/plain/);assert.match(robots.body.toString(),/^User-agent: \*\nDisallow: \/\n/);assert.match(robots.body.toString(),/User-agent: facebookexternalhit\nDisallow: \/\nAllow: \/\$/m);assert.match(robots.body.toString(),/Allow: \/social\/onesa-social-card\.png\$/m);assert.equal(robots.headers['cache-control'],'no-store');console.log('PASS unreleased company robots blocks crawling');
for(const path of ['/brand/onesa-orbit.png','/social/onesa-banner.png']){const response=await request('portal.onesa.eu',path);assert.equal(response.status,200,path);assert.match(response.headers['content-type'],/image\/png/);assert.equal(createHash('sha256').update(response.body).digest('hex'),createHash('sha256').update(readFileSync(`public${path}`)).digest('hex'));console.log(`PASS same-origin brand asset ${path}`);}
const page=await request('portal.onesa.eu','/admin');assert.equal(page.status,200);const html=page.body.toString();assert.ok(html.includes('/brand/onesa-orbit.png'));assert.ok(html.includes('/social/onesa-banner.png'));assert.match(html,/property="og:title" content="Onesa Portal"/);assert.equal(page.headers['x-robots-tag'],'noindex, nofollow');console.log('PASS portal favicon, preview metadata and noindex');

for (const agent of ['Mozilla/5.0', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)']) {
  const homepage = await request('onesa.eu', '/', {'User-Agent': agent});
  assert.equal(homepage.status, 200);
  assert.equal(homepage.headers.location, undefined);
  const head = homepage.body.toString().split('</head>')[0];
  assert.match(head, /<title>Onesa \| Engineering Intelligent Possibilities<\/title>/);
  for (const name of ['description', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
    assert.equal((head.match(new RegExp('name="' + name + '"', 'g')) || []).length, 1, name);
  }
  for (const name of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:secure_url', 'og:image:type', 'og:image:width', 'og:image:height', 'og:image:alt']) {
    assert.equal((head.match(new RegExp('property="' + name + '"', 'g')) || []).length, 1, name);
  }
  assert.match(head, /rel="canonical" href="https:\/\/onesa.eu\/"/);
  assert.match(head, /property="og:url" content="https:\/\/onesa.eu\/"/);
  const crawlerRobots = await request('onesa.eu', '/robots.txt', {'User-Agent': agent});
  assert.equal(crawlerRobots.status, 200);
  assert.equal(crawlerRobots.body.toString(), robots.body.toString());
  assert.match(head, /name="twitter:card" content="summary_large_image"/);
  assert.match(head, /property="og:image" content="https:\/\/onesa.eu\/social\/onesa-social-card.png"/);
  assert.ok(homepage.body.toString().includes('Engineering what'));
  const image = await request('onesa.eu', '/social/onesa-social-card.png', {'User-Agent': agent});
  assert.equal(image.status, 200);
  assert.match(image.headers['content-type'], /image\/png/);
  assert.equal(image.body.readUInt32BE(16), 1200);
  assert.equal(image.body.readUInt32BE(20), 630);
  console.log(`PASS server-rendered social metadata and 1200x630 image: ${agent}`);
}
