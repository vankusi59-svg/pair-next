import { test, expect } from "@playwright/test";
import { seedSession } from "./helpers";

/* P15.9-B6 + A2 cutover acceptance: full deep-link coverage,
   browser navigation, /app landing, and browser-local redirect overrides.
   Playwright runs the Vite development server (legacy-first); production
   builds default to /app with an explicit "legacy" rollback preference.
   Production-preview verification is documented separately. */

test("b6: every /app deep link loads a real page (no placeholder, no crash)", async ({ page }) => {
  await seedSession(page);
  const routes = [
    "/app/company",
    "/app/inbox",
    "/app/objectives",
    "/app/ceo",
    "/app/workforce",
    "/app/workforce/admin",
    "/app/missions",
    "/app/missions/new",
    "/app/chat",
    "/app/system/providers",
    "/app/system/observability",
    "/app/system/schedules",
    "/app/system/cost",
    "/app/system/settings",
    "/app/system/business-admin",
  ];
  for (const path of routes) {
    await page.goto(path);
    // every page renders inside the AppShell main region — loading, ready or
    // a labeled error state are all acceptable; a crash/blank is not
    const main = page.locator("main.amain");
    await expect(main).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => (await main.innerText()).trim().length).toBeGreaterThan(0);
    // never a stale placeholder
    await expect(page.getByText(/lands in B\d|planned for B\d/i)).toHaveCount(0);
  }
});

test("b6: /app index lands on Company Cockpit", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app");
  await page.waitForURL("**/app/company");
  await expect(page.getByRole("heading", { name: /Company Cockpit/i }).first()).toBeVisible();
});

test("b6: legacy deep links still work + back/forward across the two trees", async ({ page }) => {
  await seedSession(page);
  await page.goto("/");
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 10000 });
  await page.goto("/app/company");
  await expect(page.getByRole("heading", { name: /Company Cockpit/i }).first()).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/company/);
});

test("b6: Vite dev default remains legacy-first for regression coverage", async ({ page }) => {
  await seedSession(page);
  // flag absent → legacy tree intact (no redirect)
  for (const path of ["/approvals", "/schedules", "/providers", "/observability", "/objectives", "/chat", "/missions/new"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path.replace(/\//g, "\\/") + "$"));
  }
});

test("b6: opt-in redirect ON maps each legacy route to its /app destination (isolated)", async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => localStorage.setItem("pair.legacy_redirect", "app"));
  const pairs: Array<[string, RegExp]> = [
    ["/", /\/app\/company/],
    ["/missions/new", /\/app\/missions\/new/],
    ["/approvals", /\/app\/inbox/],
    ["/schedules", /\/app\/system\/schedules/],
    ["/providers", /\/app\/system\/providers/],
    ["/observability", /\/app\/system\/observability/],
    ["/objectives", /\/app\/objectives/],
    ["/chat", /\/app\/chat/],
  ];
  for (const [from, re] of pairs) {
    await page.goto(from);
    await page.waitForURL(re, { timeout: 10000 });
  }
});

test("b6: redirect preserves dynamic mission id + query, and unmapped routes never redirect", async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => localStorage.setItem("pair.legacy_redirect", "app"));
  // dynamic id + query preserved verbatim (page itself may error on a
  // nonexistent mission — this test is about the redirect contract)
  await page.goto(`/missions/MSN_b6fake?tab=files`);
  await page.waitForURL(/\/app\/missions\/MSN_b6fake\?tab=files/, { timeout: 10000 });
  // unmapped legacy-ish path does not redirect anywhere unexpected
  await page.goto("/ui");
  await expect(page).not.toHaveURL(/\/app\//);
});

test("b6: flag removal restores Vite dev default (no sticky state)", async ({ page }) => {
  await seedSession(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  // flag on mid-session then cleared — next navigation follows the flag
  await page.evaluate(() => localStorage.setItem("pair.legacy_redirect", "app"));
  await page.goto("/approvals");
  await page.waitForURL(/\/app\/inbox/);
  await page.evaluate(() => localStorage.removeItem("pair.legacy_redirect"));
  await page.goto("/approvals");
  await expect(page).toHaveURL(/\/approvals$/);
});

test("a2: explicit legacy override keeps classic routes accessible after cutover", async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => localStorage.setItem("pair.legacy_redirect", "legacy"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.goto("/approvals");
  await expect(page).toHaveURL(/\/approvals$/);
  // Owner can switch forward and roll back again without wiping tokens.
  await page.evaluate(() => localStorage.setItem("pair.legacy_redirect", "app"));
  await page.goto("/");
  await page.waitForURL(/\/app\/company$/);
  await page.evaluate(() => localStorage.setItem("pair.legacy_redirect", "legacy"));
  await page.goto("/providers");
  await expect(page.getByRole("heading", { name: "Providers & models" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pair.mc_token"))).toBeTruthy();
});
