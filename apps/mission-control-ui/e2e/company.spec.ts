import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

// P15.9-B2 — Company Cockpit. Real backend data for the main paths;
// contract-shaped fixtures only where a state has no public-API seed
// route (pending review row, >200 truncation, integrity failure).
const OP = "op:e2e";
const OWNER = "operator:op:e2e";

async function apiPost(page: Page, path: string, body: Record<string, unknown>) {
  const r = await page.request.post(`/api${path}`, {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
    data: body,
  });
  expect(r.ok(), `${path} -> ${r.status()}`).toBeTruthy();
  return r.json();
}

// PAIR_MC_DIR persists across runs — names/dedup keys must be unique.
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

async function mkBusiness(page: Page, tag: string): Promise<{ id: string; name: string }> {
  const name = `e2e-b2-${tag}-${uniq()}`;
  const prjs = (await page.request.get("/api/projects", {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as Array<Record<string, unknown>>;
  const project_id = String(prjs[0]?.project_id ?? prjs[0]?.entity_id ?? "default");
  const b = await apiPost(page, "/businesses", {
    name, project_id, description: "B2 e2e business",
  });
  return { id: String(b.business_id ?? b.entity_id), name };
}

async function mkObjective(page: Page, businessId: string, title: string, owner = OWNER) {
  await apiPost(page, "/vnext/objectives", {
    business_id: businessId,
    title,
    statement: "Produce deliverables.",
    kpis: [{ kpi_id: "k_deliver", name: "deliverables", unit: "count", direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: "2030-12-31",
    budget_ceiling_microusd: 500000,
    owner_authority_id: owner,
    dedup_key: `e2e-${title}-${uniq()}`,
  });
}

async function seedBiz(page: Page, bizId: string) {
  await seedSession(page);
  await page.addInitScript((id: string) => {
    localStorage.setItem("pair.business_id", id);
  }, bizId);
}

test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

test("company with real objectives: header, exact stats, unverified chips", async ({ page }) => {
  const biz = await mkBusiness(page, "main");
  await mkObjective(page, biz.id, "Obj One");
  await mkObjective(page, biz.id, "Obj Two");
  const calls: string[] = [];
  page.on("request", (r) => calls.push(r.url()));
  await seedBiz(page, biz.id);
  await page.goto("/app/company");
  await expect(page.getByRole("heading", { name: biz.name })).toBeVisible();
  await expect(page.locator(".stat", { hasText: "Objectives owned" }).getByText("2")).toBeVisible();
  await expect(page.getByText(/of 2 returned/)).toBeVisible();
  const cards = page.locator(".ecard");
  await expect(cards).toHaveCount(2);
  // fresh objectives: canonically proven ZERO progress -> "0/1 MET" + proven chip
  // (never inflated, and UNVERIFIED coverage is in the fixture test below)
  await expect(page.locator(".pchip.proven").first()).toBeVisible();
  await expect(page.getByText("0/1 MET").first()).toBeVisible();
  // HALT lane: unavailable explanation, never a count
  await expect(page.getByText(/no HALT enumeration exists/)).toBeVisible();
  // no owner-scoped enumeration, no mutations from the page.
  // company endpoint is read twice: the page itself + the B4 Inbox
  // badge (proven pending count) — still no unscoped enumeration.
  expect(calls.filter((u) => u.includes("/api/businesses") && !u.includes("/company"))).toEqual([]);
  expect(calls.filter((u) => u.includes("/api/vnext/businesses/"))).toHaveLength(2);
});

test("non-owner business -> DeniedState (FAIL_CLOSED_COMPANY_SCOPE)", async ({ page }) => {
  const biz = await mkBusiness(page, "foreign");
  await mkObjective(page, biz.id, "foreign-obj", "operator:someone-else");
  await seedBiz(page, biz.id);
  await page.goto("/app/company");
  await expect(page.getByText("Access denied")).toBeVisible();
  await expect(page.getByText(/FAIL_CLOSED_COMPANY_SCOPE/)).toBeVisible();
  await expect(page.locator(".ecard")).toHaveCount(0);
});

test("no business selected -> honest empty state", async ({ page }) => {
  await page.goto("/app/company");
  await expect(page.locator(".pstate .t")).toHaveText("No business selected");
});

test("switching business discards previous data; slow stale response never overwrites", async ({ page }) => {
  const bizA = await mkBusiness(page, "slow-a");
  await mkObjective(page, bizA.id, "Obj A");
  const bizB = await mkBusiness(page, "fast-b");
  await mkObjective(page, bizB.id, "Obj B");
  // bizA's company response arrives late
  await page.route(`**/api/vnext/businesses/${bizA.id}/company`, async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await seedBiz(page, bizA.id);
  await page.goto("/app/company");
  // switch to B while A is still loading
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill(bizB.id);
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(page.getByRole("heading", { name: bizB.name })).toBeVisible();
  // after A's stale response lands (~900ms), B must still be shown
  await page.waitForTimeout(1200);
  await expect(page.getByRole("heading", { name: bizB.name })).toBeVisible();
  await expect(page.getByText(bizA.name)).toHaveCount(0);
});

test("pending review + truncation (contract-shaped fixture)", async ({ page }) => {
  const biz = "BIZ_fixture";
  const baseObj = (i: number) => ({
    objective_id: `OBJ_f${i}`, title: `Obj ${i}`, status: "RUNNING", deadline: null, created_at: "2026-01-01T00:00:00Z",
    budget: { ceiling_microusd: 1000000, consumed_microusd: 0, canonically_proven: true },
    kpi_summary: { total: 1, met: 0, gap: 1, unverified: 0, all_targets_met: false, canonically_proven: true },
    latest_review: null,
    review_count: 0,
  });
  const objectives = Array.from({ length: 200 }, (_, i) => baseObj(i));
  // fresh pending (company-side flag)
  objectives[0] = {
    ...baseObj(0),
    objective_id: "OBJ_pend", title: "Review me",
    kpi_summary: { total: 1, met: 1, gap: 0, unverified: 0, all_targets_met: true, canonically_proven: true },
    latest_review: { review_id: "r1", outcome: "TARGET_MET_CANDIDATE", owner_action_required: true, recommended_status: null, created_at: "2026-06-01T00:00:00Z" },
    review_count: 1,
  };
  // historical flag is NOT fresh pending; canonically_proven=false never claims MET
  objectives[1] = {
    ...baseObj(1),
    objective_id: "OBJ_hist", title: "History only",
    budget: { ceiling_microusd: 0, consumed_microusd: 0, canonically_proven: false },
    kpi_summary: { total: 1, met: 0, gap: 1, unverified: 1, all_targets_met: false, canonically_proven: false },
    latest_review: { review_id: "r0", outcome: "TARGET_MET_CANDIDATE", owner_action_required: false, recommended_status: null, created_at: "2026-05-01T00:00:00Z" },
    review_count: 2,
  };
  const payload = {
    company: {
      business: { business_id: biz, name: "Fixture Co", description: null, currency: "USD", status: "ACTIVE", project_id: "p", created_at: "2026-01-01T00:00:00Z" },
      objectives,
      objectives_total_owned: 230,
      objectives_truncated: true,
      counts: { objectives_owned: 230, objectives_returned: 200, targets_met_pending: 1 },
    },
  };
  await page.route(`**/api/vnext/businesses/${biz}/company`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }));
  await seedBiz(page, biz);
  await page.goto("/app/company");
  // truncation: 230 owned, exactly the 200 returned, counts stay exact
  await expect(page.getByText(/Showing 200 of 230 owned objectives/)).toBeVisible();
  await expect(page.locator(".ecard")).toHaveCount(200);
  await expect(page.locator(".stat", { hasText: "Objectives owned" }).getByText("230")).toBeVisible();
  await expect(page.locator(".stat", { hasText: "Pending reviews" }).getByText("1")).toBeVisible();
  // fresh pending flag only: OBJ_pend in needs-you, OBJ_hist (historical) NOT
  const need = page.locator(".need").first();
  await expect(need.getByText("Review me")).toBeVisible();
  await expect(need.getByText("review pending owner sign-off")).toBeVisible();
  expect(await need.getByText("History only").count()).toBe(0);
  // proven KPI renders MET + proven chip
  await expect(page.locator(".ecard", { hasText: "Review me" }).getByText("1/1 MET")).toBeVisible();
  // canonically_proven=false -> UNVERIFIED + unverifiable chip, never MET-as-evidence
  const hist = page.locator(".ecard", { hasText: "History only" });
  await expect(hist.getByText("UNVERIFIED").first()).toBeVisible();
  await expect(hist.locator(".pchip.unverifiable").first()).toBeVisible();
  await expect(hist.getByText("claimed")).toBeVisible();
});

test("integrity error after a good load renders fail-closed error, no stale data", async ({ page }) => {
  const bizA = await mkBusiness(page, "ok-a");
  await mkObjective(page, bizA.id, "Obj A");
  await page.route("**/api/vnext/businesses/BIZ_corrupt/company", (route) =>
    route.fulfill({ status: 500, contentType: "application/json",
      body: JSON.stringify({ error: "FAIL_CLOSED_ENTITY_HASH_MISMATCH", detail: "digest mismatch" }) }));
  await seedBiz(page, bizA.id);
  await page.goto("/app/company");
  await expect(page.getByRole("heading", { name: bizA.name })).toBeVisible();
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill("BIZ_corrupt");
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(page.getByText("FAIL_CLOSED_ENTITY_HASH_MISMATCH").first()).toBeVisible();
  await expect(page.getByText(/Integrity check failed/)).toBeVisible();
  await expect(page.locator(".ecard")).toHaveCount(0);
  await expect(page.getByText(bizA.name)).toHaveCount(0);
});

test("no unexpected API mutations from the cockpit page", async ({ page }) => {
  const biz = await mkBusiness(page, "readonly");
  await mkObjective(page, biz.id, "Obj R");
  const methods: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) methods.push(r.method()); });
  await seedBiz(page, biz.id);
  await page.goto("/app/company");
  await expect(page.getByRole("heading", { name: biz.name })).toBeVisible();
  expect(methods.filter((m) => m !== "GET")).toEqual([]);
});

test("microusd always displays as USD, never business.currency (audit F1)", async ({ page }) => {
  const biz = "BIZ_vnd";
  const payload = {
    company: {
      business: { business_id: biz, name: "Foreign Ccy Co", description: null, currency: "VND", status: "ACTIVE", project_id: "p", created_at: "2026-01-01T00:00:00Z" },
      objectives: [
        {
          objective_id: "OBJ_vnd", title: "Money check", status: "RUNNING", deadline: null, created_at: "2026-01-01T00:00:00Z",
          budget: { ceiling_microusd: 20000000, consumed_microusd: 10000000, canonically_proven: true },
          kpi_summary: { total: 0, met: 0, gap: 0, unverified: 0, all_targets_met: false, canonically_proven: true },
          latest_review: null,
          review_count: 0,
        },
      ],
      objectives_total_owned: 1,
      objectives_truncated: false,
      counts: { objectives_owned: 1, objectives_returned: 1, targets_met_pending: 0 },
    },
  };
  await page.route(`**/api/vnext/businesses/${biz}/company`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }));
  await seedBiz(page, biz);
  await page.goto("/app/company");
  // 10_000_000 microusd == USD 10.00 — never "10 VND", even with currency=VND
  await expect(page.getByText("$10.00 / $20.00")).toBeVisible();
  await expect(page.locator(".stat", { hasText: "Reported spend" }).getByText("$10.00")).toBeVisible();
  expect(await page.getByText(/VND/).count()).toBe(0);
});

test("401 on BOTH company + approvals -> honest state; no prompt, no reload, no prior data", async ({ page }) => {
  const bizA = await mkBusiness(page, "pre401");
  await mkObjective(page, bizA.id, "Obj Before");
  await page.addInitScript(() => {
    (window as unknown as { __prompted: boolean }).__prompted = false;
    window.prompt = () => { (window as unknown as { __prompted: boolean }).__prompted = true; return null; };
  });
  await page.route("**/api/vnext/businesses/BIZ_401/company", (route) =>
    route.fulfill({ status: 401, contentType: "application/json",
      body: JSON.stringify({ error: "UNAUTHORIZED", detail: "invalid token" }) }));
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 401, contentType: "application/json",
      body: JSON.stringify({ error: "UNAUTHORIZED", detail: "invalid token" }) }));
  await seedBiz(page, bizA.id);
  await page.goto("/app/company");
  await expect(page.getByRole("heading", { name: bizA.name })).toBeVisible();
  // approvals already returned 401 -> lane degrades honestly, no prompt
  await expect(page.getByText(/Global approvals queue failed to load/)).toBeVisible();
  // switch to a business whose read returns 401
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill("BIZ_401");
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  // honest credential-failure explanation, no legacy prompt, no forced reload
  await expect(page.getByText(/credentials were rejected/)).toBeVisible();
  await expect(page.getByText("UNAUTHORIZED").first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __prompted: boolean }).__prompted)).toBe(false);
  expect(page.url()).toContain("/app/company");
  // previous business's data fully discarded
  await expect(page.locator(".ecard")).toHaveCount(0);
  await expect(page.getByText(bizA.name)).toHaveCount(0);
});

test("legacy routes keep the old 401 window.prompt behavior", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __prompted: boolean }).__prompted = false;
    window.prompt = () => { (window as unknown as { __prompted: boolean }).__prompted = true; return null; };
  });
  await page.route("**/api/missions", (route) =>
    route.fulfill({ status: 401, contentType: "application/json",
      body: JSON.stringify({ error: "UNAUTHORIZED", detail: "invalid token" }) }));
  await seedSession(page);
  await page.goto("/");
  // legacy api client still invokes the token prompt on 401 (returns null = cancel)
  await expect.poll(() =>
    page.evaluate(() => (window as unknown as { __prompted: boolean }).__prompted),
  ).toBe(true);
});
