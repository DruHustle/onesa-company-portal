import {expect} from '@playwright/test';
import {test,db} from './database';
import AxeBuilder from '@axe-core/playwright';
import {randomBytes,randomUUID} from 'node:crypto';
import {governanceSeed} from '../../onesa-company-portal-backend/tests/governance-fixture';
if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw new Error('Governance browsers require an isolated _test database');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const {hash,passwordHash,encrypt}=await import('../../onesa-company-portal-backend/src/auth/crypto');
const {importGovernance}=await import('../../onesa-company-portal-backend/src/governance/import');
const password=randomBytes(32).toString('hex'),email=`governance-${randomUUID()}@example.invalid`,ownerId=randomUUID();
test.beforeAll(async()=>{
 await db.query('TRUNCATE governance_events,governance_versions,governance_records CASCADE');
 await importGovernance(governanceSeed(),{vercel:{currentPlan:'hobby',verifiedAt:new Date().toISOString(),accountIdentifier:'team_synthetic',managementStatement:'Synthetic management declaration: pre-commercial setup with future Pro or Enterprise transition; no current DPA applicability established.',futurePlan:'Pro or Enterprise',dpaReference:'https://vercel.com/legal/dpa',termsReference:'https://vercel.com/legal/terms',fairUseReference:'https://vercel.com/docs/limits/fair-use-guidelines',currentDpaStatus:'not_established',eligibilityStatus:'subject_to_terms_review',reviewTriggers:['Commercial transition']},additionalProviders:[]});
 await db.query('DELETE FROM rate_limits');
 await db.query('INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',[ownerId,email,passwordHash(password),'owner',encrypt('JBSWY3DPEHPK3PXP')]);
});
test.afterAll(async()=>{await db.query('TRUNCATE governance_events,governance_versions,governance_records CASCADE');await db.query('TRUNCATE privacy_lifecycle_events,privacy_lifecycle_targets,privacy_lifecycle_requests,privacy_holds CASCADE');await db.query('DELETE FROM audit WHERE actor_id=$1',[ownerId]);await db.query('DELETE FROM users WHERE id=$1',[ownerId]);});
async function recovery(){const code=randomUUID();await db.query('INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)',[ownerId,hash(code)]);return code;}
async function login(page:import('@playwright/test').Page){
 await page.goto('/admin#privacy/overview');
 await page.getByLabel('Email',{exact:true}).first().fill(email);await page.getByLabel('Password',{exact:true}).first().fill(password);await page.getByLabel('Authenticator or recovery code').fill(await recovery());await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Privacy Overview',exact:true})).toBeVisible();
}
test('Protected governance documents, search, evidence, PDF, amendments and scoped approval work in the actual UI',async({page})=>{
 expect((await page.request.get('/api/v1/admin/governance/records')).status()).toBe(401);
 await login(page);
 await page.getByRole('button',{name:'Policies & Documents',exact:true}).click();
 await expect(page.getByText('Page 1 · 3 records')).toBeVisible();
 await page.getByLabel('Search records').fill('retention');await page.getByRole('button',{name:'Search',exact:true}).click();await expect(page.getByText('Page 1 · 1 records')).toBeVisible();
 await page.getByRole('button',{name:'Synthetic retention policy',exact:true}).click();
 await expect(page.locator('.governance-prose').getByRole('heading',{name:'Synthetic retention policy',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>('__governanceUnsafe' in window))).toBe(false);
 const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Download this PDF'}).click();const download=await downloadEvent;expect(download.suggestedFilename()).toBe('ONESA-PRIV-RET-001-r1.pdf');expect(await download.failure()).toBeNull();
 await page.getByRole('button',{name:'Create amendment',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Synthetic amended retention policy');await page.getByRole('button',{name:'Save new draft revision'}).click();await expect(page.getByRole('heading',{name:'Synthetic amended retention policy',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Review & decision',exact:true}).click();await page.getByLabel('Decision',{exact:true}).selectOption('approved');await page.getByLabel('Review notes').fill('Synthetic browser review only.');await page.getByLabel('Approval / review scope').fill('Synthetic isolated browser test only; no production approval.');await page.getByLabel('Evidence references · non-secret URLs or record paths').fill('tests/synthetic/browser-evidence');await page.getByLabel('Effective date (local time)').fill('2026-10-13T10:00');await page.getByLabel('Next review (local time)').fill('2027-10-13T10:00');await page.getByLabel('Current password',{exact:true}).fill(password);await page.getByLabel('Fresh authenticator or unused recovery code').fill(await recovery());await page.getByRole('button',{name:'Record decision for this version'}).click();await expect(page.getByText('Synthetic isolated browser test only; no production approval.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Versions & audit'}).click();await page.getByRole('button',{name:'Compare revisions'}).click();await expect(page.getByRole('heading',{name:'Revision 1',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Revision 2',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Processors & Transfers',exact:true}).click();await page.getByRole('button',{name:'Synthetic provider 1',exact:true}).click();await expect(page.getByText('hobby',{exact:true})).toBeVisible();await expect(page.getByText('not_established',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'https://vercel.com/legal/dpa',exact:true}).first()).toHaveAttribute('href','https://vercel.com/legal/dpa');
 const counts=(await db.query("SELECT kind,count(*)::int AS n FROM governance_records GROUP BY kind ORDER BY kind")).rows;expect(counts).toEqual([{kind:'decision',n:12},{kind:'document',n:3},{kind:'processor',n:9},{kind:'retention',n:16}]);
});
for(const width of [390,768,1440])for(const [hour,mode] of [[20,'light'],[12,'dark']] as const)test(`Governance is accessible and responsive at ${width}px in ${mode}`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.addInitScript(hour=>{Date.prototype.getHours=()=>hour;},hour); await page.emulateMedia({colorScheme:mode});await login(page);
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)).toBe(mode);
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Retention & Deletion',exact:true}).click();await expect(page.getByRole('columnheader',{name:'Deletion method',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Data Subject Requests',exact:true}).click();await expect(page.getByRole('heading',{name:'Scoped erasure requests'})).toBeVisible();
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('System appearance changes preserve an administration draft, focus and session without API writes',async({page})=>{
 await page.emulateMedia({colorScheme:'light'});await login(page);
 await page.getByRole('button',{name:'Content',exact:true}).click();
 await page.getByRole('button',{name:'+ New content',exact:true}).click();
 const title=page.getByLabel('Title',{exact:true});await title.fill('Synthetic unsaved editorial draft');await title.focus();
 const cookies=await page.context().cookies();const writes:string[]=[];
 page.on('request',request=>{if(request.url().includes('/api/v1/')&&request.method()!=='GET')writes.push(request.method());});
 for(const scheme of ['dark','light'] as const){await page.emulateMedia({colorScheme:scheme});await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));expect(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)).toBe(scheme);await expect(title).toHaveValue('Synthetic unsaved editorial draft');await expect(title).toBeFocused();}
 expect(await page.context().cookies()).toEqual(cookies);expect(writes).toEqual([]);
 await page.getByRole('button',{name:'Background Processing',exact:true}).click();await expect(page.getByRole('heading',{name:'Background Processing',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Background processing jobs',exact:true})).toBeVisible();await expect(page.getByRole('columnheader',{name:'Attempts',exact:true})).toBeVisible();
});

test('Actual privacy workspace plans, preserves, releases, erases and records owner completion for one synthetic enquiry',async({page})=>{
 const id=randomUUID(),reference='Synthetic browser request '+id;
 await db.query("INSERT INTO enquiries(id,category,name,email,message,locale) VALUES($1,'general','Synthetic browser fixture','synthetic@example.invalid','Local lifecycle fixture only','en')",[id]);
 await login(page);await page.getByRole('button',{name:'Data Subject Requests',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Preservation holds',exact:true})).toBeVisible();
 const create=page.locator('details').filter({has:page.locator('summary').filter({hasText:/^Create a hold$/})});await create.locator('summary').click();await create.getByLabel('Exact record UUID').fill(id);await create.getByLabel('Preservation reason').fill('Synthetic browser preservation only');await create.getByLabel('Identity/scope evidence references').fill('tests/synthetic/browser-hold');await create.getByLabel('Current password',{exact:true}).fill(password);await create.getByLabel('Authenticator or unused recovery code',{exact:true}).fill(await recovery());await create.getByRole('button',{name:'Record hold',exact:true}).click();await expect(page.getByText('Hold recorded. Existing deletion routes enforce it.')).toBeVisible();
 const held=(await db.query('SELECT id FROM privacy_holds WHERE target_id=$1 AND released_at IS NULL',[id])).rows[0];expect(held).toBeTruthy();await expect(create.getByLabel('Current password',{exact:true})).toHaveValue('');
 const release=page.locator('details').filter({has:page.locator('summary').filter({hasText:/^Release a hold$/})});await release.locator('summary').click();await release.getByLabel('Active hold',{exact:true}).selectOption(held.id);await release.getByLabel('Release reason').fill('Synthetic browser case resolved');await release.getByLabel('Current password',{exact:true}).fill(password);await release.getByLabel('Authenticator or unused recovery code',{exact:true}).fill(await recovery());await release.getByRole('button',{name:'Release selected hold'}).click();await expect(page.getByText('Hold release recorded; history is retained.')).toBeVisible();
 const plan=page.locator('form').filter({has:page.getByRole('button',{name:'Save impact plan',exact:true})});await plan.getByLabel('Internal case reference').fill(reference);await plan.getByLabel('Identity/scope evidence references').fill('tests/synthetic/browser-identity');await plan.getByLabel('Explicit targets').fill('enquiry:'+id);await plan.getByRole('button',{name:'Save impact plan'}).click();await expect(page.getByText('Preview saved. No records have been deleted.')).toBeVisible();expect((await db.query('SELECT id FROM enquiries WHERE id=$1',[id])).rowCount).toBe(1);
 const execute=page.locator('details').filter({has:page.locator('summary').filter({hasText:/^Owner: review and execute this exact plan$/})});await execute.locator('summary').click();await execute.getByLabel('Execution scope and review note').fill('Synthetic browser scope confirmed');await execute.getByLabel('I have verified identity').check();await execute.getByLabel('Current password',{exact:true}).fill(password);await execute.getByLabel('Authenticator or unused recovery code',{exact:true}).fill(await recovery());await execute.getByRole('button',{name:'Execute reviewed local erasure'}).click();await expect(page.getByText('Local results recorded. Review each target and complete external actions separately.')).toBeVisible();expect((await db.query('SELECT id FROM enquiries WHERE id=$1',[id])).rowCount).toBe(0);
 const complete=page.locator('details').filter({has:page.locator('summary').filter({hasText:/^Record independently verified completion$/})});await complete.locator('summary').click();await complete.getByLabel('Processor/mailbox reconciliation references').fill('tests/synthetic/no-provider-copies');await complete.getByLabel('Backup deletion-replay evidence').fill('tests/synthetic/local-replay');await complete.getByLabel('Completion scope and limitations').fill('Synthetic isolated fixture only, no real customer data');await complete.getByLabel('Current password',{exact:true}).fill(password);await complete.getByLabel('Authenticator or unused recovery code',{exact:true}).fill(await recovery());await complete.getByRole('button',{name:'Record verified completion'}).click();await expect(page.getByRole('heading',{name:'External reconciliation recorded'})).toBeVisible();
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
});
