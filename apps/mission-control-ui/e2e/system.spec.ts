import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

// P15.9-B5.5 — System UI: providers / observability / schedules / cost /
// settings. Golden paths run on the REAL backend; interceptions are
// labeled adversarial cases (malformed/delayed/failed responses). No
// real paid model calls — the e2e env uses the template planner.

const OP = "op:e2e";

async function api(page: Page, method: string, path: string, body?: Record<string, unknown>) {
  const r = await page.request.fetch(`/api${path}`, {
    method,
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
    data: body,
  });
  return { ok: r.ok(), status: r.status(), json: await r.json().catch(() => null) };
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

function trackPosts(page: Page) {
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(`${r.method()} ${r.url()}`); });
  return posts;
}

/* ---------------- Providers & Models ---------------- */

test("providers: renders all four sections on the real backend; zero mutation POSTs", async ({ page }) => {
  const posts = trackPosts(page);
  await seedSession(page);
  await page.goto("/app/system/providers");
  await expect(page.getByRole("heading", { name: "Providers & Models" })).toBeVisible();
  await expect(page.getByText(/GET \/api\/providers/)).toBeVisible();
  // all three canonical reads settle — provider + model tables render
  await expect(page.locator("section[aria-label='provider catalog'] .tbl")).toBeVisible();
  await expect(page.locator("section[aria-label='model catalog'] .tbl")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent routing decisions" })).toBeVisible();
  expect(posts).toEqual([]); // read-only page — no mutations
});

test("providers: 401 on one read shows honest error, never window.prompt, other sections intact", async ({ page }) => {
  const posts = trackPosts(page);
  await seedSession(page);
  await page.route("**/api/models", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "UNAUTHORIZED", detail: "bad token" }) }));
  let promptSeen = false;
  page.on("dialog", (d) => { promptSeen = true; void d.dismiss(); });
  await page.goto("/app/system/providers");
  await expect(page.locator("section[aria-label='model catalog']").getByText(/UNAUTHORIZED/i)).toBeVisible();
  // providers + routes still render independently
  await expect(page.locator("section[aria-label='provider catalog'] .tbl")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent routing decisions" })).toBeVisible();
  await page.waitForTimeout(400);
  expect(promptSeen).toBe(false);
  expect(posts).toEqual([]);
});

test("providers: failed models read does not fabricate an empty catalog", async ({ page }) => {
  await seedSession(page);
  await page.route("**/api/models", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "INTERNAL", detail: "boom" }) }));
  await page.goto("/app/system/providers");
  await expect(page.locator("section[aria-label='model catalog']").getByText("Canonical code: INTERNAL")).toBeVisible();
  // no "No model entries" empty-state fabrication
  await expect(page.locator("section[aria-label='model catalog']").getByText("No model entries")).toHaveCount(0);
});

test("providers: route bindings show canonical gate values — non-PASS never rendered as PASS", async ({ page }) => {
  await seedSession(page);
  // labeled interception — deterministic gate fixture: one routable
  // binding, one failing gate, one binding with NO gate evidence.
  await page.route("**/api/routes", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        routes: [], model_bindings: [], route_decisions: [], routing_decisions: [],
        routable_models: [
          { binding_id: "B1", provider_id: "prov-a", executor_id: "DEVIN", routable: true, gates: { CREDENTIAL: "PASS", HEALTH: "PASS" } },
          { binding_id: "B2", provider_id: "prov-b", executor_id: "DEVIN", routable: false, gates: { CREDENTIAL: "PASS", QUALIFICATION: "FAIL" }, reason_not_routable: "QUALIFICATION" },
          { binding_id: "B3", provider_id: "prov-c", executor_id: "DEVIN", routable: false, gates: {} },
        ],
      }),
    }));
  await page.goto("/app/system/providers");
  const sec = page.locator("section[aria-label='route bindings']");
  await expect(sec.getByText("ROUTABLE", { exact: true })).toBeVisible();
  await expect(sec.getByText("NOT ROUTABLE").first()).toBeVisible();
  await expect(sec.getByText("QUALIFICATION: FAIL")).toBeVisible();
  await expect(sec.getByText(/first failing gate:/)).toBeVisible();
  // B3 has no gate evidence — never presented as PASS
  await expect(sec.getByText(/no gate evidence/i)).toBeVisible();
});

/* ---------------- Observability ---------------- */

test("observability: global event stream labeled global, live badge, never business-scoped", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/system/observability");
  await expect(page.getByText(/global system event stream/i)).toBeVisible();
  await expect(page.getByText(/not the business-scoped/i)).toBeVisible();
  await expect(page.getByText("live").first()).toBeVisible({ timeout: 10000 });
});

test("observability: routing and recovery tabs render independently", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/system/observability");
  await page.getByRole("tab", { name: "Routing" }).click();
  await expect(page.getByRole("heading", { name: /Routing decisions/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Route decisions/ })).toBeVisible();
  await page.getByRole("tab", { name: "Recovery" }).click();
  await expect(page.getByRole("heading", { name: /Recovery decisions/ })).toBeVisible();
  await expect(page.getByText(/not.*mission schedules/i)).toBeVisible();
});

async function mkMission(page: Page, goal: string): Promise<string> {
  const prjs = (await api(page, "GET", "/projects")).json as Array<Record<string, unknown>>;
  const p = prjs[0];
  const pv = await api(page, "POST", "/missions/preview", {
    project_id: String(p.project_id), goal,
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [String(p.root_location ?? "")],
  });
  expect(pv.ok).toBeTruthy();
  const cf = await api(page, "POST", "/missions/confirm", {
    preview_id: String(pv.json.preview_id), plan_digest: String(pv.json.plan_digest),
  });
  expect(cf.ok).toBeTruthy();
  return String(cf.json.mission_id ?? cf.json.mission?.mission_id);
}

test("observability: evidence pinned to selected mission; late response A never overwrites B; export carries selected id", async ({ page }) => {
  await seedSession(page);
  const a = await mkMission(page, `e2e-evidence-A-${uniq()}`);
  const b = await mkMission(page, `e2e-evidence-B-${uniq()}`);
  // hold A's evidence response until B has rendered — labeled interception
  let holdA: ((v: unknown) => void) | null = null;
  const gateA = new Promise((res) => { holdA = res; });
  await page.route(`**/api/missions/${a}/evidence`, async (route) => {
    await gateA;
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([{ kind: "AAA_STALE", payload: { mark: "A" }, evidence_hash: "h1", created_at: "2026-01-01T00:00:00" }]),
    });
  });
  await page.route(`**/api/missions/${b}/evidence`, (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([{ kind: "BBB_FRESH", payload: { mark: "B" }, evidence_hash: "h2", created_at: "2026-01-01T00:00:00" }]),
    }));
  await page.goto("/app/system/observability");
  await page.getByRole("tab", { name: "Evidence" }).click();
  const sel = page.getByLabel("select mission");
  await sel.selectOption({ value: a });
  await sel.selectOption({ value: b }); // switch before A resolves
  await expect(page.getByText("BBB_FRESH")).toBeVisible();
  holdA?.(null); // release A now
  await page.waitForTimeout(500);
  await expect(page.getByText("BBB_FRESH")).toBeVisible();
  await expect(page.getByText("AAA_STALE")).toHaveCount(0);
  // export carries the selected canonical mission id
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export evidence JSON" }).click();
  const f = await dl;
  const text = await (await import("node:fs")).promises.readFile(await f.path()!, "utf8");
  expect(text).toContain(`"mission_id": "${b}"`);
  expect(text).toContain("BBB_FRESH");
  expect(text).not.toContain("AAA_STALE");
});

/* ---------------- Schedules ---------------- */

test("schedules: global list renders, UTC label, zero tick calls", async ({ page }) => {
  const posts = trackPosts(page);
  const ticks: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/tick")) ticks.push(r.url()); });
  await seedSession(page);
  const g = `e2e-schedule-${uniq()}`;
  const c = await api(page, "POST", "/schedules", { goal: g, cron: "0 9 * * *", name: `sched-${uniq()}` });
  expect(c.ok).toBeTruthy();
  await page.goto("/app/system/schedules");
  await expect(page.getByText(/global, unfiltered/i)).toBeVisible();
  await expect(page.getByText(/Cron semantics are/i)).toBeVisible();
  await expect(page.getByText(g).first()).toBeVisible();
  await expect(page.locator("section[aria-label='schedule list'] .tbl")).toBeVisible();
  expect(ticks).toEqual([]);
  expect(posts.filter((p) => !p.includes("/missions/"))).toEqual([]);
});

test("schedules: create requires confirmation; double-click = exactly one POST; refetch shows row", async ({ page }) => {
  await seedSession(page);
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/schedules")) posts.push(r.url()); });
  // hold the create POST in-flight so we can race a second click against
  // the single-flight guard, then release it to the real backend.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((res) => { release = res; });
  await page.route("**/api/schedules", async (route, req) => {
    if (req.method() === "POST") { await gate; return route.continue(); }
    return route.continue();
  });
  const g = `e2e-schedule-create-${uniq()}`;
  await page.goto("/app/system/schedules");
  await page.getByLabel("Goal").fill(g);
  await page.getByLabel("Cron (UTC)").fill("0 12 * * *");
  const btn = page.getByRole("button", { name: "Create schedule…" });
  await btn.click();
  // explicit ConfirmDialog with the consequence text
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(/REAL mission/i)).toBeVisible();
  const confirm = page.getByRole("button", { name: "Create schedule", exact: true });
  // two synchronous clicks on the same node while the POST is held
  // in-flight — the single-flight guard must drop the second.
  await confirm.evaluate((el) => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  release?.();
  await expect(page.getByText(g).first()).toBeVisible({ timeout: 15000 });
  expect(posts.length).toBe(1);
});

test("schedules: enable/disable/delete use pinned schedule identity + confirmation", async ({ page }) => {
  await seedSession(page);
  const g = `e2e-schedule-act-${uniq()}`;
  const c = await api(page, "POST", "/schedules", { goal: g, cron: "0 10 * * *" });
  expect(c.ok).toBeTruthy();
  const sid = String((c.json.schedule ?? c.json).schedule_id);
  const urls: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") urls.push(r.url()); });
  await page.goto("/app/system/schedules");
  const row = page.locator("tr", { hasText: g });
  // disable
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByText(`DISABLE schedule ${sid}`)).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(row.getByText("DISABLED")).toBeVisible({ timeout: 10000 });
  // enable
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByText(`ENABLE schedule ${sid}`)).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(row.getByText("ENABLED")).toBeVisible({ timeout: 10000 });
  // delete — destructive, pinned id
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(`DELETE schedule ${sid}`)).toBeVisible();
  await expect(page.getByText(/destructive/i)).toBeVisible();
  await page.getByRole("button", { name: "Delete schedule" }).click();
  await expect(page.getByText(g).first()).toHaveCount(0, { timeout: 10000 });
  expect(urls.some((u) => u.includes(`/api/schedules/${sid}/disable`))).toBeTruthy();
  expect(urls.some((u) => u.includes(`/api/schedules/${sid}/enable`))).toBeTruthy();
  expect(urls.some((u) => u.includes(`/api/schedules/${sid}/delete`))).toBeTruthy();
});

test("schedules: failed mutation shows honest outcome, no auto-retry, canonical refetch", async ({ page }) => {
  await seedSession(page);
  const g = `e2e-schedule-fail-${uniq()}`;
  const c = await api(page, "POST", "/schedules", { goal: g, cron: "0 11 * * *" });
  expect(c.ok).toBeTruthy();
  const sid = String((c.json.schedule ?? c.json).schedule_id);
  let attempts = 0;
  await page.route(`**/api/schedules/${sid}/disable`, (route) => {
    attempts++;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "INTERNAL", detail: "boom" }) });
  });
  await page.goto("/app/system/schedules");
  const row = page.locator("tr", { hasText: g });
  await row.getByRole("button", { name: "Disable" }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/outcome not confirmed/i)).toBeVisible();
  await page.waitForTimeout(600);
  expect(attempts).toBe(1); // never auto-retried
});

/* ---------------- Cost & Usage ---------------- */

test("cost: guard + monetary + policies + profiles render; zero POSTs; no secrets", async ({ page }) => {
  const posts = trackPosts(page);
  await seedSession(page);
  await page.goto("/app/system/cost");
  await expect(page.getByText("Remote dispatches today", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/executor_execution records/i)).toBeVisible();
  await expect(page.getByText(/Cost halt/i).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cost policies" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cost profiles" })).toBeVisible();
  await expect(page.getByText(/a reservation is not spent money/i)).toBeVisible();
  expect(posts).toEqual([]);
});

test("cost: malformed policies read = error state, never fabricated empty", async ({ page }) => {
  await seedSession(page);
  await page.route("**/api/cost-policies", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cost_policies: [null, {}] }) }));
  await page.goto("/app/system/cost");
  await expect(page.locator("section[aria-label='cost policies']").getByText("Canonical code: MALFORMED")).toBeVisible();
  await expect(page.locator("section[aria-label='cost policies']").getByText("No cost policies")).toHaveCount(0);
});

/* ---------------- Settings ---------------- */

test("settings: masked token editor, save → new requests use it, no token in DOM", async ({ page }) => {
  await seedSession(page);
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.headers()["authorization"] ?? ""));
  await page.goto("/app/system/settings");
  const inp = page.getByLabel(/New token/i);
  await expect(inp).toHaveAttribute("type", "password");
  await expect(inp).toHaveValue(""); // stored token never rendered
  await expect(page.getByText("configured")).toBeVisible();
  await inp.fill("fresh-token-xyz");
  await page.getByRole("button", { name: "Save token" }).click();
  await expect(page.getByText(/Token saved/i)).toBeVisible();
  // subsequent requests carry the new token
  await page.locator(".anav .advtoggle").click(); // V2: Schedules lives under Nâng cao
  await page.getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  expect(seen.some((a) => a === "Bearer fresh-token-xyz")).toBeTruthy();
  // token never leaks into the rendered DOM
  await expect(page.getByText("fresh-token-xyz")).toHaveCount(0);
});

test("settings: invalid token → honest Unauthorized state, never a prompt", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/system/settings");
  let promptSeen = false;
  page.on("dialog", (d) => { promptSeen = true; void d.dismiss(); });
  await page.getByLabel(/New token/i).fill("bad-token");
  await page.getByRole("button", { name: "Save token" }).click();
  await page.locator(".anav .advtoggle").click(); // V2: Schedules lives under Nâng cao
  await page.getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByText("UNAUTHORIZED_MC_TOKEN", { exact: true }).first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(300);
  expect(promptSeen).toBe(false);
});

test("settings: operator id propagates to header + shell chip; theme stays synced", async ({ page }) => {
  test.setTimeout(60000);
  await seedSession(page);
  const ops: string[] = [];
  page.on("request", (r) => ops.push(r.headers()["x-operator-id"] ?? ""));
  await page.goto("/app/system/settings");
  await page.getByLabel(/x-operator-id/i).fill("op:settings-test");
  await page.getByRole("button", { name: "Save operator id" }).click();
  // AppShell chip reflects it immediately
  await expect(page.getByText("op:settings-test").first()).toBeVisible();
  // theme toggle syncs with the shell button's pair.theme contract
  // (still on the Settings page — the control lives here)
  await page.getByRole("button", { name: "toggle theme in settings" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("pair.theme"))).toBe("light");
  await page.getByRole("button", { name: "toggle theme in settings" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // subsequent requests carry the new operator id
  await page.locator(".anav .advtoggle").click(); // V2: Chi phí lives under Nâng cao
  await page.getByRole("link", { name: "Chi phí" }).click();
  await expect(page.getByText("Remote dispatches today", { exact: true })).toBeVisible({ timeout: 10000 });
  expect(ops.some((o) => o === "op:settings-test")).toBeTruthy();
});

test("settings: clear token requires confirmation; legacy link present; no credential backend POSTs", async ({ page }) => {
  const posts = trackPosts(page);
  await seedSession(page);
  await page.goto("/app/system/settings");
  await page.getByRole("button", { name: "Clear token…" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(/401 fail-closed/i)).toBeVisible();
  await page.getByRole("button", { name: "Clear token", exact: true }).click();
  await expect(page.getByText("unconfigured")).toBeVisible();
  await expect(page.getByRole("link", { name: /legacy dashboard/i })).toBeVisible();
  expect(posts.filter((p) => p.includes("/api/credentials"))).toEqual([]);
});

/* ---------------- B5.5 R1 ---------------- */

test("cost R1-F1+R2-F1: canonical P13 fields — max_microusd, scope triple, period, hard_stop, profile pricing; null/noncanonical never $0", async ({ page }) => {
  await seedSession(page);
  const mutations: string[] = [];
  // labeled interception — canonical P13-shaped fixtures (src/pair/cost.ts:
  // scope_type ∈ business/department/agent/mission; period ∈ DAY/WEEK/MONTH/
  // MISSION_LIFETIME; billing_mode ∈ METERED_API/SUBSCRIPTION/FREE/UNMETERED/
  // UNKNOWN; hard_stop is a boolean governance flag).
  await page.route("**/api/cost-policies", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ cost_policies: [
      // a1/a2: equal monetary limits, different hard_stop → must stay distinguishable
      { cost_policy_id: "CPOL_a1", business_id: "biz-9", scope_type: "department", scope_id: "trading", period: "DAY", max_microusd: 2500000, hard_stop: true, warning_threshold_pct: 80, enabled: true, status: "ACTIVE", version: 4 },
      { cost_policy_id: "CPOL_a2", business_id: "biz-9", scope_type: "department", scope_id: "analytics", period: "DAY", max_microusd: 2500000, hard_stop: false, warning_threshold_pct: 80, enabled: true, status: "ACTIVE", version: 1 },
      { cost_policy_id: "CPOL_b2", business_id: "biz-3", scope_type: "business", scope_id: "biz-3", period: "MONTH", max_microusd: null, enabled: false, status: "DISABLED", version: 1 }, // hard_stop missing → unknown
      { cost_policy_id: "CPOL_c3", business_id: "biz-5", scope_type: "agent", scope_id: "agt-2", period: "WEEK", max_microusd: "500000", hard_stop: "yes", enabled: true, status: "ACTIVE", version: 2 }, // string amount + string hard_stop → both unknown
      { cost_policy_id: "CPOL_d4", business_id: "biz-7", scope_type: "mission", scope_id: "msn-7", period: "MISSION_LIFETIME", max_microusd: 1000000, hard_stop: true, enabled: true, status: "ACTIVE", version: 1 },
    ] }),
  }));
  await page.route("**/api/cost-profiles", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ cost_profiles: [
      { cost_profile_id: "CPRO_1", ref_type: "model", ref_id: "gpt-5", billing_mode: "METERED_API", fixed_microusd: 125000, input_microusd_per_mtok: 2400, output_microusd_per_mtok: 9600, reserve_microusd: 50000, currency: "USD", status: "ACTIVE", version: 2 },
      { cost_profile_id: "CPRO_2", ref_type: "route", ref_id: "r-1", billing_mode: "SUBSCRIPTION", fixed_microusd: null, input_microusd_per_mtok: null, output_microusd_per_mtok: null, reserve_microusd: 0, currency: "USD", status: "ACTIVE", version: 1 },
    ] }),
  }));
  // registered last → consulted first: records any non-GET to /api/cost*
  // before the GET fulfillers above handle reads (strictly read-only proof)
  await page.route("**/api/cost*", (route, req) => {
    if (req.method() !== "GET") mutations.push(req.method() + " " + req.url());
    return route.fallback();
  });
  await page.goto("/app/system/cost");
  const pol = page.locator("section[aria-label='cost policies']");
  // a1 vs a2: identical $2.5 limit, hard_stop yes vs no — distinguishable
  const rowA = pol.locator("tr", { hasText: "CPOL_a1" });
  await expect(rowA.getByText("biz-9").first()).toBeVisible();
  await expect(rowA.getByText("department", { exact: true })).toBeVisible();
  await expect(rowA.getByText("trading", { exact: true })).toBeVisible();
  await expect(rowA.locator("td").nth(4)).toHaveText("DAY");
  await expect(rowA.locator("td").nth(5)).toHaveText("$2.5"); // 2,500,000 µUSD
  await expect(rowA.locator("td").nth(7)).toHaveText("yes"); // hard_stop === true
  const rowA2 = pol.locator("tr", { hasText: "CPOL_a2" });
  await expect(rowA2.getByText("analytics", { exact: true })).toBeVisible();
  await expect(rowA2.locator("td").nth(5)).toHaveText("$2.5"); // same limit as a1
  await expect(rowA2.locator("td").nth(7)).toHaveText("no"); // hard_stop === false — not inferred
  // DAY vs MONTH vs MISSION_LIFETIME are visibly different periods
  const rowB = pol.locator("tr", { hasText: "CPOL_b2" });
  await expect(rowB.getByText("business", { exact: true })).toBeVisible();
  await expect(rowB.locator("td").nth(4)).toHaveText("MONTH");
  await expect(rowB.locator("td").nth(5)).toHaveText("unknown"); // null limit ≠ $0
  await expect(rowB.locator("td").nth(7)).toHaveText("unknown"); // missing hard_stop ≠ true/false
  const rowC = pol.locator("tr", { hasText: "CPOL_c3" });
  await expect(rowC.getByText("agent", { exact: true })).toBeVisible();
  await expect(rowC.locator("td").nth(4)).toHaveText("WEEK");
  await expect(rowC.locator("td").nth(5)).toHaveText("unknown"); // string amount noncanonical — not $0, not $0.5
  await expect(rowC.locator("td").nth(7)).toHaveText("unknown"); // "yes" string is not boolean true
  const rowD = pol.locator("tr", { hasText: "CPOL_d4" });
  await expect(rowD.getByText("mission", { exact: true })).toBeVisible();
  await expect(rowD.locator("td").nth(4)).toHaveText("MISSION_LIFETIME");
  await expect(rowD.locator("td").nth(7)).toHaveText("yes");
  const prof = page.locator("section[aria-label='cost profiles']");
  const r1 = prof.locator("tr", { hasText: "model:gpt-5" });
  await expect(r1.getByText("model:gpt-5")).toBeVisible();
  await expect(r1.getByText("METERED_API")).toBeVisible();
  await expect(r1.getByText("$0.125")).toBeVisible();  // fixed
  await expect(r1.getByText("$0.0024")).toBeVisible(); // input /Mtok
  await expect(r1.getByText("$0.0096")).toBeVisible(); // output /Mtok
  await expect(r1.getByText("$0.05")).toBeVisible();   // reserve
  const r2 = prof.locator("tr", { hasText: "route:r-1" });
  await expect(r2.getByText("route:r-1")).toBeVisible();
  await expect(r2.getByText("SUBSCRIPTION")).toBeVisible();
  await expect(r2.getByText("$0", { exact: true })).toBeVisible(); // reserve 0 IS a real zero
  await expect(r2.getByText("unknown").first()).toBeVisible();     // the three nulls are unknown
  expect(mutations).toEqual([]); // strictly read-only — zero cost mutation POSTs
});

test("settings R1-F2: theme alternates across shell + settings — one transition each; reload preserves", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/system/settings");
  const settingsBtn = page.getByRole("button", { name: "toggle theme in settings" });
  const shellBtn = page.getByRole("button", { name: "toggle theme", exact: true });
  // colorScheme dark → settings toggle → light; the SHELL hook must
  // already reflect light (its button + state synced via pair.theme-changed)
  await settingsBtn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // shell toggle → dark — and the SETTINGS hook reflects it (badge text)
  await shellBtn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("dark", { exact: true }).first()).toBeVisible();
  // alternate again — each toggle is exactly one transition
  await settingsBtn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await shellBtn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("pair.theme"))).toBe("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "toggle theme in settings" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("pair.theme"))).toBe("light");
});

test("settings R1-F3: operator change invalidates inbox counts — A's count never presented under B", async ({ page }) => {
  // labeled interception — the badge's global approvals read returns
  // rows scoped to the x-operator-id header it actually sent.
  await page.route("**/api/approvals", (route, req) => {
    const op = req.headers()["x-operator-id"] ?? "";
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(op === "op:e2e"
        ? [{ approval_id: "a1", status: "PENDING" }, { approval_id: "a2", status: "PENDING" }]
        : []),
    });
  });
  await seedSession(page);
  await page.goto("/app/company");
  await expect(page.locator(".ibadge", { hasText: "2" }).first()).toBeVisible({ timeout: 10000 });
  // SPA navigation only — page.goto would full-reload and re-seed credentials
  await page.locator(".anav .advtoggle").click(); // V2: Settings/Cockpit live under Nâng cao
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel(/x-operator-id sent with API requests/).fill("op:other");
  await page.getByRole("button", { name: "Save operator id" }).click();
  await page.getByRole("link", { name: "Company Cockpit" }).click();
  await page.waitForTimeout(500);
  // A's "2" must not remain presented; B's count (0+) is what shows, or nothing while refetching
  await expect(page.locator(".ibadge", { hasText: "2" })).toHaveCount(0);
});

test("settings R1-F3: delayed old-operator inbox read never repaints after identity switch", async ({ page }) => {
  let held = true;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((res) => { release = res; });
  await page.route("**/api/approvals", async (route, req) => {
    const op = req.headers()["x-operator-id"] ?? "";
    if (held && op === "op:e2e") await gate; // hold A's read
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(op === "op:e2e"
        ? [{ approval_id: "a1", status: "PENDING" }, { approval_id: "a2", status: "PENDING" }]
        : []),
    });
  });
  await seedSession(page);
  await page.goto("/app/company"); // badge read under op:e2e is held in-flight
  // SPA navigation only — page.goto would full-reload and re-seed credentials
  await page.locator(".anav .advtoggle").click(); // V2: Settings/Cockpit live under Nâng cao
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel(/x-operator-id sent with API requests/).fill("op:other");
  await page.getByRole("button", { name: "Save operator id" }).click();
  held = false;
  release?.(); // the stale A response now resolves — its epoch is old, must not paint
  await page.getByRole("link", { name: "Company Cockpit" }).click();
  await page.waitForTimeout(500);
  await expect(page.locator(".ibadge", { hasText: "2" })).toHaveCount(0);
});

test("settings R1-F3: token save clears the previously-authenticated SSE buffer; clear fails closed, never stale-live", async ({ page }) => {
  await seedSession(page);
  const g = `e2e-sse-ev-${uniq()}`;
  await mkMission(page, g); // emits canonical entity events into the stream
  await page.goto("/app/system/observability");
  const stream = page.locator("section[aria-label='global event stream']");
  await expect(stream.getByText("live")).toBeVisible({ timeout: 15000 });
  await expect(stream.locator("tbody tr").first()).toBeVisible({ timeout: 15000 });
  const marker = stream.locator("tbody tr").first();
  // a credential save must drop the previously-authenticated buffer:
  // make the reconnect fail so the cleared state is deterministic —
  // the old rows must be gone, not shown as current data.
  await page.route("**/api/events", (route) => route.abort());
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("New token (masked — the stored value is never shown)").fill("12");
  await page.getByRole("button", { name: "Save token" }).click();
  await page.getByRole("link", { name: "Observability" }).click();
  await expect(stream.locator("tbody tr")).toHaveCount(0, { timeout: 5000 });
  await expect(marker).toHaveCount(0);
  await expect(stream.getByText("live", { exact: true })).toHaveCount(0);
  await expect(stream.getByText(/reconnecting|STREAM_DISCONNECTED/i).first()).toBeVisible();
});

test("observability R1-F3: stream status is a shared subscription — consumers converge; unmount stops observation", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/system/observability");
  const stream = page.locator("section[aria-label='global event stream']");
  await expect(stream.getByText("live")).toBeVisible({ timeout: 15000 });
  // unmount → remount: a fresh subscriber converges to the same status
  await page.locator(".anav .advtoggle").click(); // V2: Schedules lives under Nâng cao
  await page.getByRole("link", { name: "Schedules" }).click();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await page.getByRole("link", { name: "Observability" }).click();
  await expect(stream.getByText("live")).toBeVisible({ timeout: 15000 });
  // a failed stream is presented consistently as reconnecting, not live
  await page.route("**/api/events", (route) => route.abort());
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("New token (masked — the stored value is never shown)").fill("12");
  await page.getByRole("button", { name: "Save token" }).click();
  await page.getByRole("link", { name: "Observability" }).click();
  await expect(stream.getByText("reconnecting", { exact: true })).toBeVisible({ timeout: 10000 });
});

/* ---------------- Regression ---------------- */

test("regression: legacy /providers /observability /schedules /chat still work", async ({ page }) => {
  await seedSession(page);
  // P15.9-A2: legacy tree under the explicit rollback preference (the e2e
  // harness serves the built production bundle where /app is the default).
  await page.addInitScript(() => localStorage.setItem("pair.legacy_redirect", "legacy"));
  await page.goto("/providers");
  await expect(page.getByRole("heading", { name: "Providers & models" })).toBeVisible();
  await page.goto("/observability");
  await expect(page.getByRole("heading", { name: /Observability/ })).toBeVisible();
  await page.goto("/schedules");
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await page.goto("/chat");
  await expect(page.getByText(/Conversation|session/i).first()).toBeVisible();
});

test("regression: other /app routes unaffected + mobile layouts usable", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/missions");
  await expect(page.getByRole("heading", { name: "Mission Operations" })).toBeVisible();
  await page.goto("/app/chat");
  await expect(page.getByText(/Conversation/i).first()).toBeVisible({ timeout: 10000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/system/providers");
  await expect(page.getByRole("heading", { name: "Providers & Models" })).toBeVisible();
  await page.goto("/app/system/schedules");
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
});
