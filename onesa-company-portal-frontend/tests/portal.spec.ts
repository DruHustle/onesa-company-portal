import {expect} from '@playwright/test';
import {test,db} from './database';
import AxeBuilder from '@axe-core/playwright';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
const fixture=randomUUID();const email=`e2e-${fixture}@example.test`;const password='e2e-private-password-12345';let ownerId='';
if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Browser tests require an isolated TEST_DATABASE_URL ending _test');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const {passwordHash,encrypt,hash}=await import('../../onesa-company-portal-backend/src/auth/crypto');
const {remove}=await import('../../onesa-company-portal-backend/src/services/storage');
const {generatePDF}=await import('../../onesa-company-portal-backend/src/documents/pdf');
const recovery=randomUUID();
test.beforeAll(async()=>{await db.query('DELETE FROM rate_limits');ownerId=randomUUID();await db.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',[ownerId,email,passwordHash(password),'owner',encrypt('JBSWY3DPEHPK3PXP')]);await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[ownerId,hash(recovery)]);});
test.afterAll(async()=>{const files=(await db.query('SELECT f.id,f.storage_key FROM files f JOIN applications a ON a.file_id=f.id WHERE a.email=$1',[email])).rows;await db.query('DELETE FROM applications WHERE email=$1',[email]);for(const file of files){await remove(file.storage_key);await db.query('DELETE FROM files WHERE id=$1',[file.id]);}await db.query('DELETE FROM enquiries WHERE email=$1',[email]);await db.query('DELETE FROM content WHERE author_id=$1',[ownerId]);await db.query('DELETE FROM audit WHERE actor_id=$1',[ownerId]);await db.query('DELETE FROM users WHERE id=$1',[ownerId]);});
test('Homepage, desktop navigation, German switching and accessibility',async({page})=>{const start=Date.now();await page.goto('/en');await expect(page.getByRole('heading',{level:1})).toHaveText(/^Onesa\.\s*Engineering what comes next\.$/);await page.screenshot({path:'test-results/home-desktop.png',fullPage:true});const violations=(await new AxeBuilder({page}).analyze()).violations;expect(violations).toEqual([]);await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Technology'}).click();await expect(page).toHaveURL(/\/en\/technology$/);await page.getByRole('link',{name:'DE',exact:true}).click();await expect(page).toHaveURL(/\/de\/technology$/);await expect(page.locator('html')).toHaveAttribute('lang','de');await expect(page.getByRole('heading',{level:1})).toHaveText('Technologie');await mkdir('test-results',{recursive:true});await writeFile('test-results/performance.json',JSON.stringify({scenario:'Homepage + navigation + language + axe',elapsedMs:Date.now()-start,note:'Browser scenario duration, not a Core Web Vitals benchmark'},null,2));});
test('Mobile navigation and responsive layout',async({page})=>{await page.setViewportSize({width:390,height:844});await page.goto('/de');await page.getByRole('button',{name:'Menü',exact:true}).click();await page.getByRole('navigation',{name:'Hauptnavigation'}).getByRole('link',{name:'Kontakt',exact:true}).click();await expect(page).toHaveURL(/\/de\/contact$/);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-results/contact-mobile.png',fullPage:true});});
for(const [hour,mode] of [[20,'light'],[12,'dark']] as const) test(`All published ${mode} detail kinds, locale variants, privacy alias and not-found state`,async({page},info)=>{
 test.setTimeout(300000);
 await page.addInitScript(hour=>{Date.prototype.getHours=()=>hour;},hour); await page.emulateMedia({colorScheme:mode});
 const kinds=[['products','product'],['news','article'],['careers','job'],['research','research']] as const;
 for(const locale of ['en','de'])for(const [section,kind] of kinds){
  const slug=`detail-${fixture}-${mode}-${kind}`;
  await db.query("INSERT INTO content(id,kind,slug,locale,title,summary,body,state,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",[randomUUID(),kind,slug,locale,`Synthetic ${kind} ${locale}`,'Synthetic detail layout fixture','Synthetic content used only in the isolated local test database.',ownerId]);
  for(const width of [320,1440]){
   await page.setViewportSize({width,height:900});await page.goto('/');
   const response=await page.goto(`/${locale}/${section}/${slug}`);expect(response?.status()).toBe(200);
   await expect(page.getByRole('heading',{level:1})).toHaveText(`Synthetic ${kind} ${locale}`);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
   await page.screenshot({path:info.outputPath(`detail-${locale}-${kind}-${mode}-${width}.png`),fullPage:true});
  }
 }
 await page.goto('/privacy-policy');await expect(page).toHaveURL(/\/en\/privacy$/);
 const absent=await page.goto('/en/products/absent-synthetic-detail');expect(absent?.status()).toBe(404);await expect(page.locator('main')).toBeVisible();
});
test('Contact form persists; owner reviews and changes status through administration; publishes article',async({page})=>{await page.goto('/en/contact');await page.getByLabel('Your name').fill('E2E visitor');await page.getByLabel('Email address').fill(email);await page.getByLabel('Organization').fill('E2E fixture');await page.getByLabel('How can we help?').fill('Browser integration enquiry for '+fixture);await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Send enquiry',exact:true}).click();await expect(page.getByRole('status')).toContainText('Your enquiry has been saved');const record=(await db.query('SELECT * FROM enquiries WHERE email=$1',[email])).rows[0];expect(record.status).toBe('new');await page.goto('/admin');await page.getByLabel('Email',{exact:true}).first().fill(email);await page.getByLabel('Password',{exact:true}).first().fill(password);await expect(page.getByLabel('Authenticator or recovery code')).toHaveCount(0);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel('Authenticator or recovery code').fill(recovery);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Company workspace'})).toBeVisible();await page.getByRole('button',{name:'Enquiries and follow-ups',exact:true}).click();await page.getByRole('button',{name:/E2E visitor/}).click();await page.getByLabel('Status',{exact:true}).selectOption('active');await page.getByLabel('Internal notes').fill('Reviewed through browser');await page.getByRole('button',{name:'Update enquiry'}).click();await expect(page.locator('[data-workspace-notice]')).toHaveText('Saved');expect((await db.query('SELECT status FROM enquiries WHERE id=$1',[record.id])).rows[0].status).toBe('active');expect(Number((await db.query("SELECT count(*) FROM audit WHERE record_id=$1 AND action='enquiry.updated'",[record.id])).rows[0].count)).toBe(1);await page.getByRole('button',{name:'Content and publication',exact:true}).click();await page.getByRole('button',{name:'New content'}).click();await page.getByLabel('Type',{exact:true}).selectOption('article');await page.getByLabel('URL slug',{exact:true}).fill('e2e-'+fixture);await page.getByLabel('Title',{exact:true}).fill('E2E workflow fixture');await page.getByLabel('Summary',{exact:true}).fill('Browser acceptance fixture');await page.getByLabel('Body — plain text, with blank lines between paragraphs').fill('This is an automated test fixture.');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.locator('[data-workspace-notice]')).toHaveText('Saved');await page.getByLabel('Next action').selectOption('approved');await page.getByLabel('Review note').fill('Synthetic owner reviewed exact article version for browser acceptance.');await page.getByRole('button',{name:'Record review decision',exact:true}).click();await expect(page.locator('[data-workspace-notice]')).toHaveText('Saved');await page.getByRole('button',{name:'Publish or schedule this revision',exact:true}).click();await expect(page.locator('[data-workspace-notice]')).toHaveText('Saved');await page.goto('/en/news/e2e-'+fixture);await expect(page.getByRole('heading',{level:1})).toHaveText('E2E workflow fixture');});
test('Applicant uploads a private CV using the public application form',async({page})=>{test.setTimeout(120000);const jobId=randomUUID();await db.query("INSERT INTO content(id,kind,slug,locale,title,body,state,author_id) VALUES($1,'job',$2,'en','E2E test vacancy','Automated fixture only','published',$3)",[jobId,'e2e-job-'+fixture,ownerId]);await page.goto('/en/careers/e2e-job-'+fixture);await page.getByLabel('Your name').fill('E2E applicant');await page.getByLabel('Email address').fill(email);await page.getByLabel('How can we help?').fill('Browser recruitment test');const pdf=await generatePDF('Browser test CV','Synthetic acceptance fixture.');const trailer=pdf.lastIndexOf(Buffer.from('startxref'));expect(trailer).toBeGreaterThan(0);const bytes=Buffer.concat([pdf.subarray(0,trailer),Buffer.alloc(10*1024*1024-pdf.length,0x20),pdf.subarray(trailer)]);let chunks=0;page.on('request',request=>{if(request.url().includes('/transfers/')&&request.url().endsWith('/chunks')){chunks++;expect(Buffer.byteLength(request.postData()||'')).toBeLessThan(1024*1024);}});await page.getByLabel(/CV \(PDF, up to \d+ MB\)/).setInputFiles({name:'cv.pdf',mimeType:'application/pdf',buffer:bytes});await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Submit application'}).click();await expect(page.getByRole('status')).toContainText('Your application has been saved',{timeout:60000});const record=(await db.query('SELECT f.* FROM files f JOIN applications a ON a.file_id=f.id WHERE a.email=$1',[email])).rows[0];expect(chunks).toBeGreaterThan(10);expect(Number(record.size)).toBe(10*1024*1024);expect(record.classification).toBe('applicant');expect(record.scan_status).toBe('quarantine');const denied=await page.request.get(`/api/v1/public/files/${record.id}/download`);expect(denied.status()).toBe(404);
// Mark only this synthetic fixture clean; this does not qualify a real hosted scanner.
await db.query("UPDATE files SET scan_status='clean' WHERE id=$1",[record.id]);const downloadCode=randomUUID();await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[ownerId,hash(downloadCode)]);await page.goto('/admin');await page.getByLabel('Email',{exact:true}).first().fill(email);await page.getByLabel('Password',{exact:true}).first().fill(password);await expect(page.getByLabel('Authenticator or recovery code')).toHaveCount(0);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel('Authenticator or recovery code').fill(downloadCode);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Company workspace'})).toBeVisible();await page.getByRole('button',{name:'Applications and CVs',exact:true}).click();await page.getByRole('button',{name:/E2E applicant/}).click();const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download private CV'}).click();const download=await downloaded;const received=await readFile((await download.path())!);expect(received.length).toBe(bytes.length);expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));});
test('Frontend remains usable when backend responses fail',async({page})=>{await page.route('**/api/v1/public/enquiries',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'Temporarily unavailable',requestId:'failure-test'}})}));await page.goto('/en/contact');await page.getByLabel('Your name').fill('Outage test');await page.getByLabel('Email address').fill(email);await page.getByLabel('How can we help?').fill('Service outage test message');await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Send enquiry'}).click();await expect(page.locator('#main').getByRole('alert')).toContainText('We could not save your enquiry');await expect(page.getByRole('button',{name:'Send enquiry'})).toBeEnabled();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'About',exact:true}).click();await expect(page.getByRole('heading',{level:1})).toHaveText('About');});

test('Owner confirms a fresh proof for user changes and changes own password',async({page})=>{
 const loginCode=randomUUID(),proofCode=randomUUID(),passwordCode=randomUUID(),newLoginCode=randomUUID(),targetId=randomUUID(),targetEmail=`stepup-${fixture}@example.test`,changedPassword='browser-changed-private-password-45678';
 for(const code of [loginCode,proofCode,passwordCode,newLoginCode])await db.query('INSERT INTO mfa_recovery VALUES($1,$2)',[ownerId,hash(code)]);
 await db.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',[targetId,targetEmail,passwordHash(password),'viewer',encrypt('JBSWY3DPEHPK3PXP')]);
 try {
  await page.goto('/admin');
  await page.getByLabel('Email',{exact:true}).first().fill(email);
  await page.getByLabel('Password',{exact:true}).first().fill(password);
  await expect(page.getByLabel('Authenticator or recovery code')).toHaveCount(0);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel('Authenticator or recovery code').fill(loginCode);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Company workspace'})).toBeVisible();
  await page.getByRole('button',{name:'Staff and access',exact:true}).click();
  await page.getByRole('button',{name:new RegExp(targetEmail)}).click();
  await page.getByLabel('Role',{exact:true}).selectOption('business');
  await page.getByLabel('Reset MFA after independently verifying the user’s identity').check();
  await page.getByLabel('Your current password').fill(password);
  await page.getByLabel('Fresh authenticator or unused recovery code').fill(proofCode);
  await page.getByRole('button',{name:'Save user',exact:true}).click();
  await expect(page.locator('[data-workspace-notice]')).toHaveText('Saved');
  expect((await db.query('SELECT role FROM users WHERE id=$1',[targetId])).rows[0].role).toBe('business');
  expect((await db.query('SELECT mfa_secret FROM users WHERE id=$1',[targetId])).rows[0].mfa_secret).toBeNull();
  await expect(page.getByLabel('Your current password')).toHaveValue('');
  await expect(page.getByLabel('Fresh authenticator or unused recovery code')).toHaveValue('');
  await page.getByRole('button',{name:'My security',exact:true}).click();
  for(const width of [320,390,768,1024,1440]){
   await page.setViewportSize({width,height:900});
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll("body *")].filter(el=>el.getBoundingClientRect().right>innerWidth).map(el=>({tag:el.tagName,className:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})).slice(0,20)})))).toBe(true);
   expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
  }
  await page.getByLabel('Your current password').fill(password);
  await page.getByLabel('Fresh authenticator or unused recovery code').fill(passwordCode);
  await page.getByLabel('New password',{exact:true}).fill(changedPassword);
  await page.getByLabel('Confirm new password',{exact:true}).fill(changedPassword);
  await page.getByRole('button',{name:'Change password and sign out',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  expect(Number((await db.query('SELECT count(*) FROM sessions WHERE user_id=$1',[ownerId])).rows[0].count)).toBe(0);
  expect((await db.query('SELECT mfa_secret FROM users WHERE id=$1',[ownerId])).rows[0].mfa_secret).toBeTruthy();
  await page.getByLabel('Email',{exact:true}).first().fill(email);
  await page.getByLabel('Password',{exact:true}).first().fill(changedPassword);
  await expect(page.getByLabel('Authenticator or recovery code')).toHaveCount(0);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel('Authenticator or recovery code').fill(newLoginCode);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Company workspace'})).toBeVisible();
 } finally {
  await db.query('DELETE FROM audit WHERE record_id=$1::text OR actor_id=$1::uuid',[targetId]);
  await db.query('DELETE FROM users WHERE id=$1',[targetId]);
 }
});
