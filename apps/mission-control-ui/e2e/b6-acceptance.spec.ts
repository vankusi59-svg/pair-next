import { test, expect } from "@playwright/test";
import { seedSession } from "./helpers";

/* P15.9-B6 + A2 cutover acceptance: full deep-link coverage,
   browser navigation, /app landing, and browser-local redirect overrides.
   The Playwright webServer is serve-mission-control.mjs serving the BUILT
   dist bundle — i.e. production-build semantics apply here: an absent
   preference defaults to the /app tree. Vite dev-server legacy-first
   behavior is a local-workflow property, not covered by this harness.
   Legacy-route regressions are exercised under the explicit "legacy"
   rollback preference — which is also the production rollback path. */

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
  // production bundle default is /app — legacy routes via the rollback flag.
  await page.addInitScript(() => localStorage.setItem("pair.legacy_redirect", "legacy"));
  await page.goto("/");
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 10000 });
  await page.goto("/app/company");
  await expect(page.getByRole("heading", { name: /Company Cockpit/i }).first()).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/company/);
});

test("b6: production default — absent preference redirects mapped legacy routes to /app", async ({ page }) => {
  await seedSession(page);
  // flag absent → production build default applies (import.meta.env.PROD)
  const pairs: Array<[string, RegExp]> = [
    ["/", /\/app\/company$/],
    ["/missions/new", /\/app\/missions\/new$/],
    ["/approvals", /\/app\/inbox$/],
    ["/schedules", /\/app\/system\/schedules$/],
    ["/providers", /\/app\/system\/providers$/],
    ["/observability", /\/app\/system\/observability$/],
    ["/objectives", /\/app\/objectives$/],
    // /app/chat materializes a session query (?s=…) after landing
    ["/chat", /\/app\/chat/],
  ];
  for (const [from, re] of pairs) {
    await page.goto(from);
    await page.waitForURL(re, { timeout: 10000 });
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

test("b6: redirect preserves dynamic mission id + query + hash, unmapped routes never redirect", async ({ page }) => {
  await seedSession(page);
  // production default (absent preference): dynamic id + query + hash
  // preserved verbatim in ONE hop (the page itself may error on a
  // nonexistent mission — this test is about the redirect contract, not
  // mission data)
  await page.goto(`/missions/MSN_b6fake?tab=files#evidence`);
  await page.waitForURL(/\/app\/missions\/MSN_b6fake\?tab=files#evidence/, { timeout: 10000 });
  // no redirect loop: the landed /app URL is stable — it must not bounce
  // again or drop the fragment
  const landed = page.url();
  await page.waitForTimeout(400);
  expect(page.url()).toBe(landed);
  expect(landed).toContain("#evidence");
  // unmapped legacy-ish path does not redirect anywhere unexpected
  await page.goto("/ui");
  await expect(page).not.toHaveURL(/\/app\//);
  // the "legacy" rollback carries id + query + hash untouched too — the
  // classic route keeps the FULL original location, never a redirect
  await page.evaluate(() => localStorage.setItem("pair.legacy_redirect", "legacy"));
  await page.goto(`/missions/MSN_b6fake?tab=files#evidence`);
  await expect(page).toHaveURL(/\/missions\/MSN_b6fake\?tab=files#evidence$/);
  await expect(page).not.toHaveURL(/\/app\//);
});

test("b6: flag removal restores production default (no sticky state)", async ({ page }) => {
  await seedSession(page);
  await page.goto("/");
  // production build: absent flag already redirects
  await page.waitForURL(/\/app\/company$/);
  // explicit rollback, then cleared — next navigation follows the build default
  await page.evaluate(() => localStorage.setItem("pair.legacy_redirect", "legacy"));
  await page.goto("/approvals");
  await expect(page).toHaveURL(/\/approvals$/);
  await page.evaluate(() => localStorage.removeItem("pair.legacy_redirect"));
  await page.goto("/approvals");
  await page.waitForURL(/\/app\/inbox$/);
});

test("a2: explicit legacy override keeps classic routes accessible after cutover", async ({ page }) => {
  await seedSession(page);
  // absent flag → production default lands on Company Cockpit
  await page.goto("/");
  await page.waitForURL(/\/app\/company$/);
  // owner opts out — flag set via evaluate persists per-origin (an
  // addInitScript would re-seed and defeat mid-session switching)
  await page.evaluate(() => localStorage.setItem("pair.legacy_redirect", "legacy"));
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
