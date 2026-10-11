import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

/* P15.9-B3 — Objective List / Detail / Reviews. Real backend seeds for
   owner paths; contract-shaped fixtures only where a state has no
   public-API seed route (foreign-owner cockpit fixture, MET+converging,
   observation_error, expiry_pending, review truncation). */
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

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

async function mkBusiness(page: Page, tag: string): Promise<string> {
  const prjs = (await page.request.get("/api/projects", {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as Array<Record<string, unknown>>;
  const project_id = String(prjs[0]?.project_id ?? prjs[0]?.entity_id ?? "default");
  const b = await apiPost(page, "/businesses", {
    name: `e2e-b3-${tag}-${uniq()}`, project_id, description: "B3 e2e",
  });
  return String(b.business_id ?? b.entity_id);
}

async function mkObjective(page: Page, businessId: string, title: string, owner = OWNER) {
  const r = await apiPost(page, "/vnext/objectives", {
    business_id: businessId, title,
    statement: "Produce deliverables.",
    kpis: [{ kpi_id: "k_deliver", name: "deliverables", unit: "count", direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: "2030-12-31", budget_ceiling_microusd: 500000,
    owner_authority_id: owner,
    dedup_key: `e2e-b3-${uniq()}`,
  });
  return String(r.objective_id);
}

async function seedBiz(page: Page, bizId: string) {
  await seedSession(page);
  await page.addInitScript((id: string) => {
    localStorage.setItem("pair.business_id", id);
  }, bizId);
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

test("objective list: real owned objectives render with KPI/budget chips", async ({ page }) => {
  const biz = await mkBusiness(page, "list");
  await mkObjective(page, biz, `obj-${uniq()}`);
  await seedBiz(page, biz);
  await page.goto("/app/objectives");
  await expect(page.getByRole("heading", { name: "Objectives" })).toBeVisible();
  await expect(page.getByText("1 owned")).toBeVisible();
  await expect(page.locator(".ecard").first()).toBeVisible();
  await expect(page.locator(".ecard .kpibar").first()).toBeVisible();
  await expect(page.locator(".ecard").first()).toContainText("0/1 MET");
});

test("no business selected → honest empty state on all three routes", async ({ page }) => {
  await page.goto("/app/objectives");
  await expect(page.locator(".pstate .t")).toHaveText("No business selected");
  await page.goto("/app/objectives/xyz");
  await expect(page.locator(".pstate .t")).toHaveText("No business selected");
  await page.goto("/app/objectives/xyz/reviews");
  await expect(page.locator(".pstate .t")).toHaveText("No business selected");
});

test("foreign-owned objective → 403 DeniedState on detail + reviews", async ({ page }) => {
  const biz = await mkBusiness(page, "deny");
  const oid = await mkObjective(page, biz, `foreign-${uniq()}`, "operator:someone_else");
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.locator(".pstate .t")).toHaveText("Access denied");
  await expect(page.getByText("FAIL_CLOSED_COCKPIT_AUTHORITY").first()).toBeVisible();
  await page.goto(`/app/objectives/${oid}/reviews`);
  await expect(page.locator(".pstate .t")).toHaveText("Access denied");
});

test("objective in a different business → mismatch state, no leak", async ({ page }) => {
  const bizA = await mkBusiness(page, "a");
  const bizB = await mkBusiness(page, "b");
  const oid = await mkObjective(page, bizA, `obj-a-${uniq()}`);
  await seedBiz(page, bizB);
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByText("belongs to business")).toBeVisible();
});

test("owned detail renders: header sections, KPI claimed-unverifiable, pre-binding, reviews link", async ({ page }) => {
  const biz = await mkBusiness(page, "det");
  const title = `detail-${uniq()}`;
  const oid = await mkObjective(page, biz, title);
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText(`owner ${OWNER}`)).toBeVisible();
  await expect(page.getByText("terms v", { exact: false })).toBeVisible();
  // KPI: created objective has no proven evidence → UNVERIFIED, never MET.
  await expect(page.getByText("deliverables", { exact: true })).toBeVisible();
  await expect(page.getByText("UNVERIFIED").first()).toBeVisible();
  // Pre-binding → no canonical plan yet (not fabricated workstreams).
  await expect(page.getByText("no canonical plan yet")).toBeVisible();
  // Budget display in USD.
  await expect(page.getByText("$0.00 / $0.50")).toBeVisible();
  // Fresh pending flag absent → "no pending owner action".
  await expect(page.getByText("no pending owner action")).toBeVisible();
  // Reviews link works.
  await page.getByText("view all reviews").click();
  await expect(page).toHaveURL(new RegExp(`/app/objectives/${oid}/reviews`));
  await expect(page.getByRole("heading", { name: "Reviews" })).toBeVisible();
});

test("fixture: verified MET KPI + workstreams still converging + CANDIDATE vs ACHIEVED", async ({ page }) => {
  const biz = await mkBusiness(page, "met");
  const oid = `OBJ-MET-${uniq()}`;
  await page.route(`**/api/vnext/objectives/${oid}/cockpit`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      cockpit: {
        objective: { objective_id: oid, business_id: biz, status: "RUNNING", title: "metfix", statement: null, description: null, owner_authority_id: OWNER, deadline: null, currency: "USD", terms_version: 1, version: 1, created_at: "2026-10-10T00:00:00Z",
          budget: { ceiling_microusd: 1000000, consumed_microusd: 100000, canonically_proven: true },
          hard_constraints: [], success_conditions: [],
          kpis: [{ kpi_id: "k1", name: "sales", unit: "count", direction: "AT_LEAST", baseline: 0, current: 5, target: 5, assessment: "MET", canonically_proven: true, last_evidence_key: null, updated_at: null }] },
        lifecycle: { objective_status: "RUNNING", all_targets_met: true, latest_review_outcome: "TARGET_MET_CANDIDATE", owner_action_required: true, recommended_status: "ACHIEVED" },
        binding: { binding_id: "BND-1", binding_digest: "abc123digest" }, observation_error: null,
        kpi_summary: { all_targets_met: true, verified_kpi_count: 1, unverified_kpi_count: 0, gap_kpi_count: 0 },
        workstreams: [{ workstream_key: "ws1", work_item_id: "WI-1", workstream_status: "IN_PROGRESS", completion_proven: false, allocation_state: "ALLOCATED", selected_agent_id: "agent-1", delegated_child: null }],
        observer: { active: 0, intervention: 0, exhausted: 0 }, missions: [], artifacts: [], artifacts_truncated: false, artifacts_dropped_unverified: 0,
        latest_review: { review_id: "REV-1", outcome: "TARGET_MET_CANDIDATE", owner_action_required: true, recommended_status: "ACHIEVED", wait_reason: null, binding_id: "BND-1", review_observation_digest: "d", source_ceo_decision_id: "DEC-1", strategy_revision_id: "SR-1", all_targets_met: true, verified_kpi_count: 1, unverified_kpi_count: 0, gap_kpi_count: 0, created_by: "ceo", created_at: "2026-10-10T00:00:00Z" },
        review_count: 1, auto_policy: null, auto_driver: null,
      } }) }));
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  // CANDIDATE ≠ ACHIEVED: status stays RUNNING, review outcome shows separately.
  await expect(page.getByText("RUNNING", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("last review TARGET_MET_CANDIDATE")).toBeVisible();
  // MET + workstreams converging → informational note.
  await expect(page.getByText("workstreams still converging")).toBeVisible();
  // Fresh pending.
  await expect(page.getByText("owner action REQUIRED")).toBeVisible();
  // MET KPI rendered proven.
  await expect(page.getByText("MET").first()).toBeVisible();
});

test("fixture: observation_error → UnverifiedPanel, claims labeled unverified", async ({ page }) => {
  const biz = await mkBusiness(page, "obs");
  const oid = `OBJ-OBS-${uniq()}`;
  await page.route(`**/api/vnext/objectives/${oid}/cockpit`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      cockpit: {
        objective: { objective_id: oid, business_id: biz, status: "ACHIEVED", title: "terminal", statement: null, description: null, owner_authority_id: OWNER, deadline: null, currency: "USD", terms_version: 1, version: 1, created_at: "2026-10-10T00:00:00Z",
          budget: { ceiling_microusd: 0, consumed_microusd: 0, canonically_proven: false },
          hard_constraints: [], success_conditions: [],
          kpis: [{ kpi_id: "k1", name: "rev", unit: "usd", direction: "AT_LEAST", baseline: 0, current: 99, target: 1, assessment: "UNVERIFIED", canonically_proven: false, last_evidence_key: null, updated_at: null }] },
        lifecycle: { objective_status: "ACHIEVED", all_targets_met: false, latest_review_outcome: "TARGET_MET_CANDIDATE", owner_action_required: false, recommended_status: null },
        binding: null, observation_error: "FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW",
        kpi_summary: { all_targets_met: false, verified_kpi_count: 0, unverified_kpi_count: 1, gap_kpi_count: 0 },
        workstreams: [], observer: { active: 0, intervention: 0, exhausted: 0 }, missions: [], artifacts: [], artifacts_truncated: false, artifacts_dropped_unverified: 3,
        latest_review: null, review_count: 1, auto_policy: null, auto_driver: null,
      } }) }));
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByText("Observation failed integrity check")).toBeVisible();
  await expect(page.getByText("FAIL_CLOSED_P15_5_ADAPTIVE_REVIEW")).toBeVisible();
  await expect(page.getByText("UNVERIFIED").first()).toBeVisible();
  await expect(page.getByText("Workstream state unverified")).toBeVisible();
  await expect(page.getByText("+3 dropped unverifiable")).toBeVisible();
});

test("fixture: expiry_pending → advisory chip, canonical policy-status GET issued", async ({ page }) => {
  const biz = await mkBusiness(page, "pol");
  const oid = `OBJ-POL-${uniq()}`;
  let policyStatusCalls = 0;
  await page.route(`**/api/vnext/objectives/${oid}/auto-policy`, (route) => {
    if (route.request().method() === "GET") policyStatusCalls++;
    return route.fallback();
  });
  await page.route(`**/api/vnext/objectives/${oid}/cockpit`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      cockpit: {
        objective: { objective_id: oid, business_id: biz, status: "RUNNING", title: "polfix", statement: null, description: null, owner_authority_id: OWNER, deadline: null, currency: "USD", terms_version: 1, version: 1, created_at: "2026-10-10T00:00:00Z",
          budget: { ceiling_microusd: 0, consumed_microusd: 0, canonically_proven: true }, hard_constraints: [], success_conditions: [], kpis: [] },
        lifecycle: { objective_status: "RUNNING", all_targets_met: false, latest_review_outcome: null, owner_action_required: false, recommended_status: null },
        binding: { binding_id: "B", binding_digest: "d" }, observation_error: null,
        kpi_summary: { all_targets_met: false, verified_kpi_count: 0, unverified_kpi_count: 0, gap_kpi_count: 0 },
        workstreams: [], observer: { active: 0, intervention: 0, exhausted: 0 }, missions: [], artifacts: [], artifacts_truncated: false, artifacts_dropped_unverified: 0,
        latest_review: null, review_count: 0,
        auto_policy: { configured: true, state: "ENABLED", effective: true, reasons: [], policy_version: 3, expires_at: "2026-10-01T00:00:00Z", expiry_pending: true },
        auto_driver: { status: { scheduled: false } },
      } }) }));
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByText("policy expired — awaiting canonical commit")).toBeVisible();
  await expect(page.getByText("ENABLED", { exact: true })).toBeVisible();
  /* Auto-run controls card: the canonical GET is the control-plane
     source of truth — it IS issued (and repolled), the advisory chip
     still derives from the cockpit snapshot's expiry_pending flag. */
  expect(policyStatusCalls).toBeGreaterThanOrEqual(1);
});

test("reviews page: order, fields, truncation + limit refetch", async ({ page }) => {
  const biz = await mkBusiness(page, "rev");
  const oid = `OBJ-RV-${uniq()}`;
  await page.route(`**/api/vnext/objectives/${oid}/cockpit`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      cockpit: {
        objective: { objective_id: oid, business_id: biz, status: "RUNNING", title: "rv", statement: null, description: null, owner_authority_id: OWNER, deadline: null, currency: "USD", terms_version: 1, version: 1, created_at: "2026-10-10T00:00:00Z",
          budget: { ceiling_microusd: 0, consumed_microusd: 0, canonically_proven: true }, hard_constraints: [], success_conditions: [], kpis: [] },
        lifecycle: { objective_status: "RUNNING", all_targets_met: false, latest_review_outcome: "WAIT", owner_action_required: false, recommended_status: null },
        binding: { binding_id: "B", binding_digest: "d" }, observation_error: null,
        kpi_summary: { all_targets_met: false, verified_kpi_count: 0, unverified_kpi_count: 0, gap_kpi_count: 0 },
        workstreams: [], observer: { active: 0, intervention: 0, exhausted: 0 }, missions: [], artifacts: [], artifacts_truncated: false, artifacts_dropped_unverified: 0,
        latest_review: null, review_count: 3, auto_policy: null, auto_driver: null,
      } }) }));
  const rows = (lim: number) => Array.from({ length: Math.min(lim, 3) }).map((_, i) => ({
    review_id: `REV-${3 - i}`, outcome: i === 0 ? "TARGET_MET_CANDIDATE" : "WAIT",
    owner_action_required: i === 0, recommended_status: i === 0 ? "ACHIEVED" : null,
    wait_reason: i === 0 ? null : "not_ready", binding_id: "BND-1",
    review_observation_digest: "dgst", source_ceo_decision_id: `DEC-${3 - i}`,
    strategy_revision_id: `SR-${3 - i}`, all_targets_met: i === 0,
    verified_kpi_count: 2, unverified_kpi_count: 0, gap_kpi_count: 1,
    created_by: "ceo", created_at: `2026-10-1${3 - i}T00:00:00Z`,
  }));
  await page.route(`**/api/vnext/objectives/${oid}/reviews*`, (route) => {
    const u = new URL(route.request().url());
    const lim = Math.min(Number(u.searchParams.get("limit") ?? 50), 200);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      reviews: rows(lim).slice(0, lim), total: 3, returned: Math.min(lim, 3), truncated: 3 > lim,
    }) });
  });
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}/reviews?limit=2`);
  await expect(page.getByText("2 shown of 3 total — truncated")).toBeVisible();
  const first = page.locator(".rvrow").first();
  await expect(first).toContainText("TARGET_MET_CANDIDATE");
  await expect(first).toContainText("REV-3");
  await expect(first).toContainText("historical");
  await expect(first).toContainText("DEC-3");
  await expect(first).toContainText("recommends ACHIEVED");
  await page.getByLabel("reviews limit").selectOption("50");
  await expect(page.getByText("3 shown of 3 total")).toBeVisible();
  await expect(page.locator(".rvrow")).toHaveCount(3);
});

test("mutations: CEO pass requires confirm, posts once, refetches; A2 disabled", async ({ page }) => {
  const biz = await mkBusiness(page, "mut");
  const oid = await mkObjective(page, biz, `mut-${uniq()}`);
  await seedBiz(page, biz);
  let ceoCalls = 0;
  let cockpitCalls = 0;
  await page.route(`**/api/vnext/objectives/${oid}/ceo-cycle`, (route) => {
    ceoCalls++;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route(`**/api/vnext/objectives/${oid}/cockpit`, (route) => {
    cockpitCalls++;
    return route.fallback();
  });
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByRole("heading", { name: /mut-/ })).toBeVisible();
  // A2 actions are disabled/labeled, never fake POSTs.
  await expect(page.getByRole("button", { name: "Accept ACHIEVED (A2)" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Amend objective (A2)" })).toBeDisabled();
  const before = cockpitCalls;
  await page.getByRole("button", { name: "Run CEO pass" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape"); // cancel → zero POSTs
  await expect(ceoCalls).toBe(0);
  await page.getByRole("button", { name: "Run CEO pass" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Run CEO pass" }).click();
  expect(ceoCalls).toBe(1);
  await expect(page.getByText(/CEO pass (committed|failed)/)).toBeVisible();
  expect(cockpitCalls).toBeGreaterThan(before); // refetched canonical projection
});

test("create objective via selected business: confirm → backend refetch → card appears", async ({ page }) => {
  const biz = await mkBusiness(page, "create");
  await seedBiz(page, biz);
  await page.goto("/app/objectives");
  // Zero owned → canonical owner-scoped read denies (403), creation still offered.
  await expect(page.locator(".pstate .t")).toHaveText("Access denied");
  await page.getByRole("button", { name: "New objective" }).click();
  await page.getByLabel("Title").fill(`created-${uniq()}`);
  await page.getByRole("button", { name: "Create objective" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Created OBJ_", { exact: false })).toBeVisible();
  await expect(page.getByText("1 owned")).toBeVisible();
  await expect(page.locator(".ecard").first()).toBeVisible();
});

test("401 on cockpit → no window.prompt/reload; reviews 401 honest", async ({ page }) => {
  const biz = await mkBusiness(page, "unauth");
  const oid = `OBJ-401-${uniq()}`;
  await page.addInitScript(() => {
    (window as unknown as { __prompted: boolean }).__prompted = false;
    const orig = window.prompt;
    window.prompt = (...a: Parameters<typeof window.prompt>) => {
      (window as unknown as { __prompted: boolean }).__prompted = true;
      return orig.apply(window, a);
    };
  });
  await page.route(`**/api/vnext/objectives/${oid}/cockpit`, (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "UNAUTHORIZED", detail: "bad token" }) }));
  await page.route(`**/api/vnext/objectives/${oid}/reviews*`, (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "UNAUTHORIZED", detail: "bad token" }) }));
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByText("credentials were rejected")).toBeVisible();
  const prompted = await page.evaluate(() => (window as unknown as { __prompted: boolean }).__prompted);
  expect(prompted).toBe(false);
  await page.goto(`/app/objectives/${oid}/reviews`);
  await expect(page.getByText("credentials were rejected")).toBeVisible();
});

test("read-only pages generate no unintended POST/write calls", async ({ page }) => {
  const biz = await mkBusiness(page, "ro");
  const oid = await mkObjective(page, biz, `ro-${uniq()}`);
  const writes: string[] = [];
  await page.route("**/api/**", (route) => {
    const m = route.request().method();
    if (m !== "GET") writes.push(`${m} ${route.request().url()}`);
    return route.fallback();
  });
  await seedBiz(page, biz);
  await page.goto("/app/objectives");
  await page.goto(`/app/objectives/${oid}`);
  await page.goto(`/app/objectives/${oid}/reviews`);
  expect(writes).toEqual([]);
});

test("fast switching between objectives shows no stale overwrite", async ({ page }) => {
  const biz = await mkBusiness(page, "sw");
  const o1 = await mkObjective(page, biz, `sw1-${uniq()}`);
  const o2 = await mkObjective(page, biz, `sw2-${uniq()}`);
  await seedBiz(page, biz);
  await page.route(`**/api/vnext/objectives/${o1}/cockpit`, async (route) => {
    await new Promise((r) => setTimeout(r, 800)); // o1 slow — must not overwrite o2
    return route.fallback();
  });
  await page.goto(`/app/objectives/${o1}`);
  await page.goto(`/app/objectives/${o2}`);
  await expect(page.getByRole("heading", { name: /sw2-/ })).toBeVisible();
  await page.waitForTimeout(900);
  await expect(page.getByRole("heading", { name: /sw2-/ })).toBeVisible(); // still o2
});

test("policy HALT on real backend: capture UI request, replay same op/key — no second transition", async ({ page }) => {
  const biz = await mkBusiness(page, "halt");
  const oid = await mkObjective(page, biz, `halt-${uniq()}`);
  await apiPost(page, `/vnext/objectives/${oid}/auto-policy`, {
    action: "configure", idempotency_key: `cfg-${uniq()}`,
    limits: { expires_at: "2030-12-31T00:00:00Z", max_ceo_calls: 5 },
  });
  await apiPost(page, `/vnext/objectives/${oid}/auto-policy`, {
    action: "enable", policy_version: 1, idempotency_key: `en-${uniq()}`,
  });
  await seedBiz(page, biz);

  // Capture the REAL UI request body — action, version, scope, idem key.
  const captured: Record<string, unknown>[] = [];
  await page.route(`**/api/vnext/objectives/${oid}/auto-policy`, (route) => {
    if (route.request().method() === "POST") {
      captured.push(route.request().postDataJSON() as Record<string, unknown>);
    }
    return route.fallback();
  });

  await page.goto(`/app/objectives/${oid}`);
  await page.getByRole("button", { name: "Halt policy (objective scope)" }).click();
  // duplicate-submit protection: rapid second click on confirm sends nothing extra
  const confirm = page.getByRole("dialog").getByRole("button", { name: "Commit halt" });
  await Promise.all([confirm.click(), confirm.click().catch(() => {})]);
  await expect(page.getByText("Policy halt committed")).toBeVisible();
  await expect(page.getByText("HALTED", { exact: true })).toBeVisible();

  expect(captured).toHaveLength(1);
  const body = captured[0]!;
  expect(body.action).toBe("halt");
  expect(body.halt_scope).toBe("OBJECTIVE");
  expect(body.policy_version).toBe(2);
  expect(typeof body.idempotency_key).toBe("string");

  const st1 = (await page.request.get(`/api/vnext/objectives/${oid}/auto-policy`, {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as { auto_policy: { state: string; policy_version: number } };
  expect(st1.auto_policy.state).toBe("HALTED");

  // Replay of THE SAME HALT operation (same body incl. idempotency key)
  // returns the stored status — no second canonical transition.
  const replay = await apiPost(page, `/vnext/objectives/${oid}/auto-policy`, body);
  expect(replay.auto_policy.state).toBe("HALTED");
  expect(replay.auto_policy.policy_version).toBe(st1.auto_policy.policy_version);
  const hist = (await page.request.get(`/api/vnext/objectives/${oid}/auto-policy/history`, {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json()).catch(() => null)) as unknown;
  if (hist && typeof hist === "object" && "transitions" in (hist as Record<string, unknown>)) {
    expect(((hist as { transitions: unknown[] }).transitions).length).toBeLessThanOrEqual(2);
  }
});

test("create form parity: EXACT direction + constraints + success conditions post", async ({ page }) => {
  const biz = await mkBusiness(page, "parity");
  await seedBiz(page, biz);
  let posted: Record<string, unknown> | null = null;
  await page.route("**/api/vnext/objectives", (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON() as Record<string, unknown>;
      return route.fallback();
    }
    return route.fallback();
  });
  await page.goto("/app/objectives");
  await page.getByRole("button", { name: "New objective" }).click();
  await page.getByLabel("Title").fill(`parity-${uniq()}`);
  await page.getByRole("button", { name: "+ add KPI" }).click();
  await page.locator(".kpirow input[placeholder='name']").fill("exact_kpi");
  await page.locator(".kpirow select").selectOption("EXACT");
  await page.locator(".kpirow input[placeholder='target']").fill("3");
  await page.getByLabel("Hard constraints (one per line)").fill("no weekend work");
  await page.getByLabel("Success conditions (one per line)").fill("report shipped");
  await page.getByRole("button", { name: "Create objective" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Created OBJ_", { exact: false })).toBeVisible();
  expect(posted).not.toBeNull();
  expect(posted!.hard_constraints).toEqual(["no weekend work"]);
  expect(posted!.success_conditions).toEqual(["report shipped"]);
  expect((posted!.kpis as Array<Record<string, unknown>>)[0]!.direction).toBe("EXACT");
});

test("dialog lifecycle: focus enters, Escape closes+returns focus, busy disables", async ({ page }) => {
  const biz = await mkBusiness(page, "dlg");
  const oid = await mkObjective(page, biz, `dlg-${uniq()}`);
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  const trigger = page.getByRole("button", { name: "Run CEO pass" });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // focus moved inside dialog
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  // focus returned to the trigger
  await expect(trigger).toBeFocused();
});

const spaNav = (page: import("@playwright/test").Page, path: string) =>
  page.evaluate((p) => {
    window.history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, path);

test("SPA nav with dialog open (unconfirmed) invalidates it — no retarget", async ({ page }) => {
  const biz = await mkBusiness(page, "nav-open");
  const o1 = await mkObjective(page, biz, `nopen1-${uniq()}`);
  const o2 = await mkObjective(page, biz, `nopen2-${uniq()}`);
  await seedBiz(page, biz);
  const posted: string[] = [];
  await page.route("**/api/vnext/objectives/**/ceo-cycle", (route) => {
    posted.push(route.request().url());
    return route.fallback();
  });
  await page.goto(`/app/objectives/${o1}`);
  await page.getByRole("button", { name: "Run CEO pass" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(`Run a real CEO pass on ${o1}`)).toBeVisible();
  // direct SPA navigation detail→detail WITHOUT going through the list
  await spaNav(page, `/app/objectives/${o2}`);
  await expect(page.getByRole("heading", { name: /nopen2-/ })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(`Run a real CEO pass on ${o1}`)).toHaveCount(0);
  // the unconfirmed dialog was discarded — nothing posted
  expect(posted).toHaveLength(0);
  // controls now operate on o2 — confirm on o2 posts to o2 only
  await page.getByRole("button", { name: "Run CEO pass" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Run CEO pass" }).click();
  // whatever the backend verdict, the POST went to o2 — never o1
  await expect(page.getByText(/CEO pass (committed|failed)/)).toBeVisible();
  expect(posted.every((u) => u.includes(o2))).toBe(true);
});

test("in-flight mutation result cannot update another objective's view", async ({ page }) => {
  const biz = await mkBusiness(page, "nav-inf");
  const o1 = await mkObjective(page, biz, `ninf1-${uniq()}`);
  const o2 = await mkObjective(page, biz, `ninf2-${uniq()}`);
  await seedBiz(page, biz);
  await page.route(`**/api/vnext/objectives/${o1}/ceo-cycle`, async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(`/app/objectives/${o1}`);
  await page.getByRole("button", { name: "Run CEO pass" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Run CEO pass" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // navigate away mid-flight — the commit still lands backend-side, but
  // this view must not attribute it to o2
  await spaNav(page, `/app/objectives/${o2}`);
  await expect(page.getByRole("heading", { name: /ninf2-/ })).toBeVisible();
  await page.waitForTimeout(1100);
  await expect(page.getByText("CEO pass committed")).toHaveCount(0);
  // o2's own controls still work (no stale busy state)
  await expect(page.getByRole("button", { name: "Run CEO pass" })).toBeEnabled();
});

test("creation dedup identity: retry after lost response converges — one objective, one key per attempt", async ({ page }) => {
  const biz = await mkBusiness(page, "dedup");
  await seedBiz(page, biz);
  const bodies: Record<string, unknown>[] = [];
  const returnedIds: string[] = [];
  let poisoned = false;
  await page.route("**/api/vnext/objectives", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const resp = await route.fetch();
    const json = (await resp.json().catch(() => null)) as { objective_id?: string } | null;
    if (json?.objective_id) returnedIds.push(json.objective_id);
    if (!poisoned) { poisoned = true; return route.fulfill({ response: resp, status: 502 }); }
    return route.fulfill({ response: resp });
  });
  await page.goto("/app/objectives");
  await page.getByRole("button", { name: "New objective" }).click();
  const title = `dedup-${uniq()}`;
  await page.getByLabel("Title").fill(title);
  // attempt 1: backend commits, client sees a transport-level failure
  await page.getByRole("button", { name: "Create objective" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(page.locator('.trunc[role="alert"]')).toBeVisible();
  // retry the IDENTICAL form → must reuse the same dedup_key
  await page.getByRole("button", { name: "Create objective" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Created OBJ_", { exact: false })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.dedup_key).toBe(bodies[1]!.dedup_key);
  // exact-create replay: backend converged to the SAME objective_id
  expect(new Set(returnedIds)).toEqual(new Set([returnedIds[0]]));
  expect(returnedIds).toHaveLength(2);
  // only one objective exists for this business
  const comp = (await page.request.get(`/api/vnext/businesses/${biz}/company`, {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as { company: { objectives: Array<{ title: string | null }> } };
  expect(comp.company.objectives.filter((o) => o.title === title)).toHaveLength(1);
  // deliberate new creation (different terms) → fresh key
  await page.getByRole("button", { name: "New objective" }).click();
  await page.getByLabel("Title").fill(`dedup2-${uniq()}`);
  await page.getByRole("button", { name: "Create objective" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Created OBJ_", { exact: false }).nth(1)).toBeVisible().catch(async () => {
    await expect(page.locator(".trunc", { hasText: "Created OBJ_" })).toBeVisible();
  });
  expect(bodies).toHaveLength(3);
  expect(bodies[2]!.dedup_key).not.toBe(bodies[0]!.dedup_key);
});

/* Auto-run controls card (objective auto-policy UI hardening): canonical
   GET-backed state, limits, driver readiness, defaults-from-objective,
   same-key retry, 409 canonical refresh, transition-truthful labels. */

test("auto-run card: canonical policy state + limits + driver readiness rendered", async ({ page }) => {
  const biz = await mkBusiness(page, "polcard");
  const oid = await mkObjective(page, biz, `polcard-${uniq()}`);
  await apiPost(page, `/vnext/objectives/${oid}/auto-policy`, {
    action: "configure", idempotency_key: `cfg-${uniq()}`,
    limits: { expires_at: "2030-12-31T00:00:00Z", max_ceo_calls: 7, max_missions: 3, budget_microusd_cap: 250000 },
  });
  await apiPost(page, `/vnext/objectives/${oid}/auto-policy`, {
    action: "enable", policy_version: 1, idempotency_key: `en-${uniq()}`,
  });
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByRole("heading", { name: "Auto-run controls" })).toBeVisible();
  await expect(page.getByText("ENABLED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("7 ceo calls · 3 missions")).toBeVisible();
  await expect(page.getByText("$0.25 cap")).toBeVisible();
  // driver row is truthful: canonical readiness fields from the GET, no fabrication
  await expect(page.locator(".nrow", { hasText: "driver" })).toBeVisible();
});

test("configure dialog: defaults proposed from objective terms, editable", async ({ page }) => {
  const biz = await mkBusiness(page, "poldef");
  const oid = await mkObjective(page, biz, `poldef-${uniq()}`); // deadline 2030-12-31, ceiling $0.50
  await seedBiz(page, biz);
  await page.goto(`/app/objectives/${oid}`);
  await page.getByRole("button", { name: "Configure policy" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByLabel(/expires_at/)).toHaveValue("2030-12-31T00:00");
  await expect(dlg.getByLabel("max ceo calls")).toHaveValue("20");
  await expect(dlg.getByLabel("max missions")).toHaveValue("5");
  await expect(dlg.getByLabel("budget cap usd")).toHaveValue("0.5");
  // editable — owner overrides before commit
  await dlg.getByLabel("max ceo calls").fill("9");
  await dlg.getByRole("button", { name: "Commit configure" }).click();
  await expect(page.getByText("Policy configure committed")).toBeVisible();
  const st = (await page.request.get(`/api/vnext/objectives/${oid}/auto-policy`, {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as { auto_policy: { limits: { max_ceo_calls: number; expires_at: string } } };
  expect(st.auto_policy.limits.max_ceo_calls).toBe(9);
  expect(st.auto_policy.limits.expires_at).toBe("2030-12-31T00:00:00.000Z");
});

test("ambiguous failure retry keeps the same idempotency key", async ({ page }) => {
  const biz = await mkBusiness(page, "polretry");
  const oid = await mkObjective(page, biz, `polretry-${uniq()}`);
  await apiPost(page, `/vnext/objectives/${oid}/auto-policy`, {
    action: "configure", idempotency_key: `cfg-${uniq()}`,
    limits: { expires_at: "2030-12-31T00:00:00Z", max_ceo_calls: 5 },
  });
  await seedBiz(page, biz);
  let failedOnce = false;
  const bodies: Record<string, unknown>[] = [];
  await page.route(`**/api/vnext/objectives/${oid}/auto-policy`, (route) => {
    if (route.request().method() === "POST") {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
      if (!failedOnce) { failedOnce = true; return route.fulfill({ status: 500, body: "{}" }); }
    }
    return route.fallback();
  });
  await page.goto(`/app/objectives/${oid}`);
  await page.getByRole("button", { name: "Enable policy" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Commit enable" }).click();
  await expect(page.getByText("Policy enable failed")).toBeVisible();
  // reopen + commit the SAME operation — key must be reused, not rotated
  await page.getByRole("button", { name: "Enable policy" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Commit enable" }).click();
  await expect(page.getByText("Policy enable committed")).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.idempotency_key).toBe(bodies[1]!.idempotency_key);
});

test("CAS 409 conflict → canonical refetch + honest note, key kept", async ({ page }) => {
  const biz = await mkBusiness(page, "polcas");
  const oid = await mkObjective(page, biz, `polcas-${uniq()}`);
  await apiPost(page, `/vnext/objectives/${oid}/auto-policy`, {
    action: "configure", idempotency_key: `cfg-${uniq()}`,
    limits: { expires_at: "2030-12-31T00:00:00Z", max_ceo_calls: 5 },
  });
  await seedBiz(page, biz);
  let policyGets = 0;
  await page.route(`**/api/vnext/objectives/${oid}/auto-policy`, (route) => {
    if (route.request().method() === "GET") { policyGets++; return route.fallback(); }
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "FAIL_CLOSED_POLICY_CAS", detail: "policy_version stale" }) });
  });
  await page.goto(`/app/objectives/${oid}`);
  const before = policyGets;
  await page.getByRole("button", { name: "Enable policy" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Commit enable" }).click();
  await expect(page.getByText("Policy enable failed")).toBeVisible();
  await expect(page.getByText("same idempotency key kept for retry")).toBeVisible();
  await expect.poll(() => policyGets, { timeout: 5000 }).toBeGreaterThan(before);
});

test("EXPIRED → Re-arm (configure) only; REVOKED → no re-enable offered", async ({ page }) => {
  const biz = await mkBusiness(page, "polexp");
  const oid = await mkObjective(page, biz, `polexp-${uniq()}`);
  await apiPost(page, `/vnext/objectives/${oid}/auto-policy`, {
    action: "configure", idempotency_key: `cfg-${uniq()}`,
    limits: { expires_at: "2030-12-31T00:00:00Z", max_ceo_calls: 5 },
  });
  await seedBiz(page, biz);
  const polShape = (state: string) => ({
    auto_policy: {
      objective_id: oid, configured: true, state, effective: false,
      reasons: [state === "EXPIRED" ? "WINDOW_LAPSED" : "OWNER_REVOKED"],
      policy_version: 1, expires_at: "2020-01-01T00:00:00Z",
      limits: { expires_at: "2020-01-01T00:00:00Z", max_ceo_calls: 5 },
      halt: null, owner_authority_id: OWNER, business_id: biz,
      driver_ready: false, driver_missing: ["POLICY_NOT_EFFECTIVE"],
      terms_digest_binding: null, terms_current: true,
    },
  });
  let state = "EXPIRED";
  await page.route(`**/api/vnext/objectives/${oid}/auto-policy`, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(polShape(state)) });
    return route.fallback();
  });
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByText("EXPIRED", { exact: true })).toBeVisible();
  // configure legal from EXPIRED but labeled truthfully as a re-arm
  await expect(page.getByRole("button", { name: "Re-arm policy (new limits)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable policy" })).toHaveCount(0);
  state = "REVOKED";
  await page.reload();
  await expect(page.getByText("REVOKED", { exact: true })).toBeVisible();
  // terminal: the actions row offers nothing (no silent re-enable path)
  await expect(page.locator(".actions").last().locator("button")).toHaveCount(0);
});

test("policy card polls canonical GET ~every 5s while page is active", async ({ page }) => {
  const biz = await mkBusiness(page, "polpoll");
  const oid = await mkObjective(page, biz, `polpoll-${uniq()}`);
  await seedBiz(page, biz);
  let policyGets = 0;
  await page.route(`**/api/vnext/objectives/${oid}/auto-policy`, (route) => {
    if (route.request().method() === "GET") policyGets++;
    return route.fallback();
  });
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.getByRole("heading", { name: "Auto-run controls" })).toBeVisible();
  await expect.poll(() => policyGets, { timeout: 12000, intervals: [5500, 7000, 9000, 11000] }).toBeGreaterThanOrEqual(2);
});
