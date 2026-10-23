import { expect, type Page } from "@playwright/test";
import { test, db } from "./database";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
const { passwordHash, encrypt, hash } =
  await import("../../onesa-company-portal-backend/src/auth/crypto");
const run = randomUUID(),
  password = "synthetic-editorial-test-only-1234",
  prefix = "Review " + run;
const vacancyId = randomUUID(),
  cvId = randomUUID(),
  applicationId = randomUUID();
const accounts = new Map<string, { id: string; email: string }>();
test.beforeAll(async () => {
  for (const role of ["owner", "editor", "business", "hr"]) {
    const id = randomUUID(),
      email = `review-${role}-${run}@example.test`;
    await db.query(
      "INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)",
      [id, email, passwordHash(password), role, encrypt("JBSWY3DPEHPK3PXP")],
    );
    accounts.set(role, { id, email });
  }
  await db.query(
    "INSERT INTO content(id,kind,slug,locale,title,body,state,author_id) VALUES($1,'job',$2,'en','Synthetic recruitment task','Isolated acceptance only','published',$3)",
    [vacancyId, "review-job-" + run, accounts.get("owner")!.id],
  );
  await db.query(
    "INSERT INTO files(id,filename,mime,size,storage_key,sha256,classification,scan_status,title) VALUES($1::uuid,'synthetic-cv.pdf','application/pdf',8,($1::uuid)::text,$2,'applicant','quarantine','Synthetic CV metadata only')",
    [cvId, "a".repeat(64)],
  );
  await db.query(
    "INSERT INTO applications(id,job_id,name,email,message,file_id,delete_after) VALUES($1,$2,'Synthetic review applicant',$3,'Isolated recruitment acceptance only',$4,now()+interval '1 day')",
    [applicationId, vacancyId, "applicant-" + run + "@example.test", cvId],
  );
  for (let i = 0; i < 47; i++)
    await db.query(
      "INSERT INTO enquiries(id,category,name,email,message,locale) VALUES($1,'general',$2,$3,'Synthetic task acceptance only','en')",
      [randomUUID(), `${prefix} ${i}`, `query-${i}-${run}@example.test`],
    );
});
test.beforeEach(async () => {
  await db.query("DELETE FROM rate_limits WHERE key=$1", ["login:127.0.0.1"]);
});
test.afterAll(async () => {
  await db.query("DELETE FROM applications WHERE id=$1", [applicationId]);
  await db.query("DELETE FROM files WHERE id=$1", [cvId]);
  await db.query("DELETE FROM enquiries WHERE name LIKE $1", [prefix + "%"]);
  const ids = [...accounts.values()].map((account) => account.id);
  await db.query("DELETE FROM content WHERE author_id=ANY($1::uuid[])", [ids]);
  await db.query("DELETE FROM audit WHERE actor_id=ANY($1::uuid[])", [ids]);
  await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [ids]);
});
async function signIn(page: Page, role: string) {
  const account = accounts.get(role)!,
    code = randomUUID();
  await db.query("INSERT INTO mfa_recovery VALUES($1,$2)", [
    account.id,
    hash(code),
  ]);
  await page.goto("/admin");
  await page.getByLabel("Email", { exact: true }).first().fill(account.email);
  await page.getByLabel("Password", { exact: true }).first().fill(password);
  await expect(page.getByLabel('Authenticator or recovery code')).toHaveCount(0);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel("Authenticator or recovery code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Company workspace" }),
  ).toBeVisible();
}
const saved = (page: Page) =>
  expect(page.locator("[data-workspace-notice]")).toHaveText("Saved");
async function search(page: Page, value: string) {
  await page.getByLabel("Search records", { exact: true }).fill(value);
  await expect(page.getByLabel("Search records", { exact: true })).toHaveValue(
    value,
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Loading this queue…")).toHaveCount(0);
}

test("editor saves and submits, owner publishes exact revision, replacement stays private", async ({
  page,
  browser,
}) => {
  const slug = "review-" + randomUUID();
  await signIn(page, "editor");
  await page
    .getByRole("button", { name: "Content and publication", exact: true })
    .click();
  await page.getByLabel("URL slug").fill(slug);
  await page
    .getByLabel("Title", { exact: true })
    .fill("Synthetic approved public edition");
  await page
    .getByLabel("Body — plain text, with blank lines between paragraphs")
    .fill("First approved synthetic edition.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await saved(page);
  await page
    .getByLabel("Review note")
    .fill("Ready for owner review; synthetic acceptance only.");
  await expect(
    page.getByRole("button", { name: "Submit saved draft for review" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Submit saved draft for review" })
    .click();
  await saved(page);
  await expect(
    page.getByRole("button", { name: "Publish or schedule this revision" }),
  ).toHaveCount(0);
  const ownerContext = await browser.newContext(),
    owner = await ownerContext.newPage();
  try {
    await signIn(owner, "owner");
    await owner
      .getByRole("button", { name: "Content and publication", exact: true })
      .click();
    await owner
      .getByRole("button", { name: /Synthetic approved public edition/ })
      .click();
    await owner.getByLabel("Next action").selectOption("approved");
    await owner
      .getByLabel("Review note")
      .fill("Owner approves this exact synthetic revision.");
    await owner.getByRole("button", { name: "Record review decision" }).click();
    await saved(owner);
    await owner
      .getByRole("button", { name: "Publish or schedule this revision" })
      .click();
    await saved(owner);
    const publicBefore = await owner.request.get(
      "/api/v1/public/content/article/en/" + slug,
    );
    expect(publicBefore.status()).toBe(200);
    expect((await publicBefore.json()).title).toBe(
      "Synthetic approved public edition",
    );
    await page
      .getByRole("button", { name: "Content and publication", exact: true })
      .click();
    await page.reload();
    await page
      .getByRole("button", { name: /Synthetic approved public edition/ })
      .click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Private replacement pending review");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await saved(page);
    expect(
      (
        await (
          await owner.request.get("/api/v1/public/content/article/en/" + slug)
        ).json()
      ).title,
    ).toBe("Synthetic approved public edition");
  } finally {
    await ownerContext.close();
  }
});

test("page-three search resets page state, section filters persist, Back and Forward work", async ({
  page,
}) => {
  await signIn(page, "business");
  await page
    .getByRole("button", { name: "Enquiries and follow-ups", exact: true })
    .click();
  await search(page, prefix);
  await expect(page.getByText("Page 1 · 47 records")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 2 · 47 records")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 3 · 47 records")).toBeVisible();
  await search(page, `query-46-${run}@example.test`);
  await expect(page.getByText("Page 1 · 1 records")).toBeVisible();
  await expect(page).toHaveURL(/page=1/);
  await page
    .getByRole("button", { name: "Queues and exceptions", exact: true })
    .click();
  await page.goBack();
  await expect(page.getByText("Page 1 · 1 records")).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Queues and exceptions" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Enquiries and follow-ups", exact: true })
    .click();
  await expect(page.getByLabel("Search records")).toHaveValue(
    `query-46-${run}@example.test`,
  );
});

test("business staff use scoped assignment; cancelling deletion sends no mutation; dirty navigation is protected", async ({
  page,
}) => {
  await signIn(page, "business");
  await page
    .getByRole("button", { name: "Enquiries and follow-ups", exact: true })
    .click();
  await search(page, `query-0-${run}@example.test`);
  await page.getByRole("button", { name: new RegExp(prefix + " 0") }).click();
  const staff = page.getByLabel("Assigned staff", { exact: true });
  await expect(
    staff
      .locator("option")
      .filter({ hasText: accounts.get("business")!.email }),
  ).toHaveCount(1);
  await staff.selectOption(accounts.get("business")!.id);
  await page.getByLabel("Internal notes").fill("Synthetic assignment by email");
  await page.getByRole("button", { name: "Update enquiry" }).click();
  await saved(page);
  let deletions = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().includes("/enquiries/"))
      deletions++;
  });
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(`query-0-${run}@example.test`);
    return dialog.dismiss();
  });
  await page.getByRole("button", { name: "Delete personal data" }).click();
  await expect(page.locator("[data-workspace-notice]")).toContainText(
    "Deletion cancelled",
  );
  expect(deletions).toBe(0);
  await page.getByLabel("Internal notes").fill("Unsaved synthetic note");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Queues and exceptions", exact: true })
    .click();
  await expect(page.getByLabel("Internal notes")).toHaveValue(
    "Unsaved synthetic note",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Queues and exceptions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Queues and exceptions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Staff and access", exact: true }),
  ).toHaveCount(0);
});

test("recruitment shows only valid transitions and quarantined CVs remain protected", async ({
  page,
}) => {
  await signIn(page, "hr");
  await page
    .getByRole("button", { name: "Applications and CVs", exact: true })
    .click();
  await search(page, "applicant-" + run + "@example.test");
  await page
    .getByRole("button", { name: /Synthetic review applicant/ })
    .click();
  expect(
    await page
      .getByLabel("Status", { exact: true })
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).toEqual(["new", "review", "rejected"]);
  await expect(
    page.getByRole("button", { name: "Download private CV" }),
  ).toBeDisabled();
  await page.getByLabel("Status", { exact: true }).selectOption("review");
  await page
    .getByLabel("Review notes")
    .fill("Synthetic CV pending security scan; workflow review only.");
  await page.getByRole("button", { name: "Update application" }).click();
  await saved(page);
  expect(
    await page
      .getByLabel("Status", { exact: true })
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).toEqual(["review", "interview", "rejected"]);
  let deletions = 0;
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      request.url().includes("/applications/")
    )
      deletions++;
  });
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("linked CV");
    return dialog.dismiss();
  });
  await page.getByRole("button", { name: "Delete application and CV" }).click();
  await expect(page.locator("[data-workspace-notice]")).toContainText(
    "Deletion cancelled",
  );
  expect(deletions).toBe(0);
  expect(
    (
      await db.query("SELECT status FROM applications WHERE id=$1", [
        applicationId,
      ])
    ).rows[0].status,
  ).toBe("review");
});

test("a delayed obsolete search cannot replace newer results",async({page})=>{
 await signIn(page,'business');await page.getByRole('button',{name:'Enquiries and follow-ups',exact:true}).click();
 let release!:()=>void,observed!:()=>void;const pending=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>observed=resolve);
 await page.route('**/api/v1/admin/enquiries?*',async route=>{if(new URL(route.request().url()).searchParams.get('search')!=='stale-owned-fixture'){await route.continue();return;}observed();await pending;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],page:1,limit:20,total:999})}).catch(()=>{});});
 try{await page.getByLabel('Search records').fill('stale-owned-fixture');await page.getByRole('button',{name:'Search',exact:true}).click();await started;await search(page,`query-46-${run}@example.test`);await expect(page.getByText('Page 1 · 1 records')).toBeVisible();release();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(page.getByText('Page 1 · 1 records')).toBeVisible();await expect(page.getByText('Page 1 · 999 records')).toHaveCount(0);}finally{release();await page.unrouteAll({behavior:'ignoreErrors'});}
});

for (const width of [320, 390, 768, 1440])
  for (const mode of ["light", "dark"] as const)
    test(`task workspace keyboard, focus, contrast and overflow ${mode} ${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: mode });
      await signIn(page, "editor");
      await page
        .getByRole("button", { name: "Content and publication", exact: true })
        .click();
      await expect(page.locator("#workspace-heading")).toBeFocused();
      await expect(
        page.getByRole("button", { name: "Save draft" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`editorial-${mode}-${width}.png`),
        fullPage: true,
      });
      await page.getByLabel("Title", { exact: true }).focus();
      await page.keyboard.type("A draft retained on preference change");
      await page.emulateMedia({
        colorScheme: mode === "dark" ? "light" : "dark",
      });
      await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
      await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
        "A draft retained on preference change",
      );
    });

test('pending enquiry save blocks selection, repeated submission and navigation until A is reconciled',async({page})=>{
 await signIn(page,'business');await page.getByRole('button',{name:'Enquiries and follow-ups',exact:true}).click();await search(page,prefix);
 const choices=page.locator('.admin-list button');await expect(choices.first()).toBeVisible();
 const a=choices.nth(0),b=choices.nth(1),bName=(await b.innerText()).replace(/\s+/g," ").trim();await a.click();
 const heading=await page.locator('form[data-workspace-draft] h2').innerText();
 await page.getByLabel('Internal notes').fill('Synthetic pending A notes');
 let release!:()=>void,writes=0;const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/v1/admin/enquiries/*',async route=>{
  if(route.request().method()!=='PATCH')return route.continue();writes++;const response=await route.fetch();await gate;await route.fulfill({response});
 });
 try{
  await page.getByRole('button',{name:'Update enquiry',exact:true}).click();
  await expect(b).toBeDisabled();await expect(page.getByLabel('Internal notes')).toBeDisabled();
  await page.locator('form[data-workspace-draft]').filter({has:page.getByRole('heading',{name:heading,exact:true})}).evaluate(form=>(form as HTMLFormElement).requestSubmit());
  await expect.poll(()=>writes).toBe(1);
  page.once('dialog',dialog=>dialog.dismiss());await page.evaluate(()=>history.back());
  await expect(page.locator('form[data-workspace-draft] h2')).toHaveText(heading);
  release();await saved(page);await expect(page.getByLabel('Internal notes')).toHaveValue('Synthetic pending A notes');
  await page.getByRole('button',{name:bName,exact:true}).click();await page.getByLabel('Internal notes').fill('Synthetic B remains selected');
  await expect(page.locator('form[data-workspace-draft] h2')).not.toHaveText(heading);expect(writes).toBe(1);
 }finally{release();}
});

test('failed enquiry save releases pending navigation but retains unsaved notes',async({page})=>{
 await signIn(page,'business');await page.getByRole('button',{name:'Enquiries and follow-ups',exact:true}).click();await search(page,prefix);
 await page.locator('.admin-list button').first().click();await page.getByLabel('Internal notes').fill('Synthetic failure notes retained');
 await page.route('**/api/v1/admin/enquiries/*',route=>route.request().method()==='PATCH'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SYNTHETIC_FAILURE',message:'Synthetic enquiry save unavailable'}})}):route.continue());
 await page.getByRole('button',{name:'Update enquiry',exact:true}).click();
 await expect(page.locator('[data-workspace-notice]')).toContainText('Synthetic enquiry save unavailable');
 await expect(page.getByLabel('Internal notes')).toBeEnabled();await expect(page.getByLabel('Internal notes')).toHaveValue('Synthetic failure notes retained');
 page.once('dialog',dialog=>dialog.dismiss());await page.locator('.admin-list button').nth(1).click();
 await expect(page.getByLabel('Internal notes')).toHaveValue('Synthetic failure notes retained');
});

test('publication summary distinguishes never published, live, replacement, scheduled and unpublished',async({page},info)=>{
 await signIn(page,'owner');await page.getByRole('button',{name:'Content and publication',exact:true}).click();
 await page.getByLabel('URL slug').fill('publication-summary-'+randomUUID());
 await page.getByLabel('Title',{exact:true}).fill('Synthetic live-edition summary');
 await page.getByLabel('Body — plain text, with blank lines between paragraphs').fill('Synthetic first approved edition.');
 await page.getByRole('button',{name:'Save draft',exact:true}).click();
 const summary=page.getByRole('region',{name:'Publication status',exact:true});
 await expect(summary.getByRole('heading',{name:'Never published',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Unpublish',exact:true})).toHaveCount(0);
 async function approve(){await page.getByRole('combobox',{name:'Next action',exact:true}).selectOption('approved');await page.getByLabel('Review note').fill('Synthetic exact-version approval for isolated tests.');await page.getByRole('button',{name:'Record review decision'}).click();await expect(summary).toContainText(/Approved for revision/);}
 await approve();await page.getByRole('button',{name:'Publish or schedule this revision'}).click();
 await expect(summary.getByRole('heading',{name:'Published — no pending content changes',exact:true})).toBeVisible();
 await expect(summary.getByRole('link',{name:'View live edition'})).toHaveAttribute('href',/\/en\/news\/publication-summary-/);
 await page.getByLabel('Title',{exact:true}).fill('Synthetic replacement not yet public');await page.getByRole('button',{name:'Save draft',exact:true}).click();
 await expect(summary.getByRole('heading',{name:'Live edition and replacement draft',exact:true})).toBeVisible();
 await expect(summary).toContainText('The live edition remains unchanged');await expect(summary).toContainText('Synthetic live-edition summary');
 await approve();await page.getByLabel('Schedule (optional, your local time)').fill('2099-06-01T10:00');await page.getByRole('button',{name:'Publish or schedule this revision'}).click();
 await expect(summary.getByRole('heading',{name:'Replacement scheduled',exact:true})).toBeVisible();
 await expect(summary).toContainText('Synthetic live-edition summary');
 await page.screenshot({path:info.outputPath('publication-summary-scheduled.png'),fullPage:true});
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Unpublish',exact:true}).click();
 await expect(summary.getByRole('heading',{name:'Unpublished — draft retained',exact:true})).toBeVisible();
 await expect(summary.getByRole('link',{name:'View live edition'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Unpublish',exact:true})).toHaveCount(0);
});
