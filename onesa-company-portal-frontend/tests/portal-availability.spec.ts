import { test, expect } from "@playwright/test";

test("an unavailable session service offers a retry and sends a signed-out visitor to the shared account", async ({page, baseURL}) => {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL || "http://localhost:3300").hostname)) throw new Error("Loopback frontend required");
  let status = 503;
  let requests = 0;
  await page.route("**/api/v1/auth/me", route => {
    requests++;
    return route.fulfill({status,contentType:"application/json",body:JSON.stringify({error:{code:"SYNTHETIC",message:"Synthetic session result",requestId:"session-fixture"}})});
  });
  await page.goto("/admin#privacy/overview");
  await expect(page.getByRole("alert")).toContainText("We could not check your Portal session");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const entry = page.getByRole("link",{name:"Continue with Onesa"});
  await expect(entry).toHaveAttribute("href","/account?next=/admin#workspace=%23privacy%2Foverview");
  status = 401;
  await page.getByRole("button",{name:"Retry session check"}).click();
  await expect(page).toHaveURL(/account\?next=\/admin#workspace=%23privacy%2Foverview$/);
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
  expect(requests).toBe(2);
});
