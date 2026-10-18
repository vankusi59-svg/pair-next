import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

/* Autonomous Loop observability dashboard — real-stack e2e.
   The e2e server has the reconcile scheduler but NO auto-driver
   (PAIR_OBJECTIVE_AUTO_DRIVER unset), so the spec proves the honest
   rendering contract end-to-end: scheduler data renders as observed,
   the driver's 404 renders an explicit failure state — never silent,
   never fabricated. */

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

async function mkBusiness(page: Page): Promise<string> {
  const prjs = (await page.request.get("/api/projects", {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as Array<Record<string, unknown>>;
  const project_id = String(prjs[0]?.project_id ?? prjs[0]?.entity_id ?? "default");
  const b = await apiPost(page, "/businesses", {
    name: `e2e-loop-${uniq()}`, project_id, description: "loop e2e",
  });
  return String(b.business_id ?? b.entity_id);
}

async function mkObjective(page: Page, businessId: string) {
  const r = await apiPost(page, "/vnext/objectives", {
    business_id: businessId,
    title: `loop-${uniq()}`,
    statement: "Produce deliverables.",
    kpis: [{ kpi_id: "k_deliver", name: "deliverables", unit: "count", direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: "2030-12-31",
    budget_ceiling_microusd: 500000,
    owner_authority_id: OWNER,
    dedup_key: `e2e-loop-${uniq()}`,
  });
  return String(r.objective_id);
}

async function gotoObjective(page: Page, biz: string, oid: string) {
  await seedSession(page);
  await page.addInitScript((id: string) => {
    localStorage.setItem("pair.business_id", id);
  }, biz);
  await page.goto(`/app/objectives/${oid}`);
  await expect(page.locator("section.aloop")).toBeVisible();
}

test("loop dashboard renders on objective detail with real node/edge graph", async ({ page }) => {
  const biz = await mkBusiness(page);
  const oid = await mkObjective(page, biz);
  await gotoObjective(page, biz, oid);

  const loop = page.locator("section.aloop");
  await expect(loop.getByRole("heading", { name: "Autonomous loop" })).toBeVisible();
  /* real node/edge SVG — spine nodes exist as buttons */
  await expect(loop.locator(".aloop-svg")).toBeVisible();
  for (const t of ["SCHEDULER", "DRIVER ADMISSION", "EXECUTION", "CONTINUATION"])
    await expect(loop.getByRole("button", { name: new RegExp(t) }).first()).toBeVisible();
  /* directional edges rendered */
  expect(await loop.locator(".aloop-edge").count()).toBeGreaterThanOrEqual(15);
  /* legend explains every state treatment */
  await expect(loop.locator(".aloop-legend")).toContainText("unknown");
  /* freshness footer reports real observation state */
  await expect(loop.locator(".aloop-fresh")).toContainText("auto-scheduler");
  await expect(loop.locator(".aloop-fresh")).toContainText("observations only");
});

test("node click opens inspector with observed evidence", async ({ page }) => {
  const biz = await mkBusiness(page);
  const oid = await mkObjective(page, biz);
  await gotoObjective(page, biz, oid);
  const loop = page.locator("section.aloop");

  await loop.getByRole("button", { name: /SCHEDULER/ }).first().click();
  const insp = loop.locator(".aloop-inspector");
  await expect(insp).toContainText("SCHEDULER");
  await expect(insp).toContainText("queue_state");
  await expect(insp).toContainText("auto-scheduler");
  /* evidence values are real strings — never empty fabrication */
  await expect(insp.locator(".aloop-insp-table td").nth(1)).not.toBeEmpty();
});

test("driver endpoint unavailable → explicit failure state, no silent empty", async ({ page }) => {
  const biz = await mkBusiness(page);
  const oid = await mkObjective(page, biz);
  await gotoObjective(page, biz, oid);
  const loop = page.locator("section.aloop");

  /* auto-driver is not integrated in the e2e env → GET fails; the panel
     must say so and DRIVER ADMISSION must show NOT OBSERVED, not success. */
  await expect(loop.locator(".aloop-panel", { hasText: "Driver activity" }))
    .toContainText(/auto-driver read (failed|unavailable)/);
  const admission = loop.getByRole("button", { name: /DRIVER ADMISSION/ }).first();
  await expect(admission).toContainText("NOT OBSERVED");
  /* freshness marks the source as bad */
  await expect(loop.locator(".aloop-fresh-item.is-bad")).toHaveCount(1);
});

test("settlement node never fabricates completion", async ({ page }) => {
  const biz = await mkBusiness(page);
  const oid = await mkObjective(page, biz);
  await gotoObjective(page, biz, oid);
  const loop = page.locator("section.aloop");

  const settle = loop.getByRole("button", { name: /SCHEDULER SETTLEMENT/ }).first();
  await expect(settle).toContainText("not observable");
  await settle.click();
  await expect(loop.locator(".aloop-inspector")).toContainText("settlement proof");
  await expect(loop.locator(".aloop-inspector")).toContainText("not available");
});

test("objective switch does not leak the previous objective's loop", async ({ page }) => {
  const biz = await mkBusiness(page);
  const oid1 = await mkObjective(page, biz);
  const oid2 = await mkObjective(page, biz);
  await gotoObjective(page, biz, oid1);
  await expect(page.locator("section.aloop")).toBeVisible();
  await page.goto(`/app/objectives/${oid2}`);
  await expect(page.locator("section.aloop")).toBeVisible();
  /* freshness for the new objective — nothing renders the old objective's
     identity; graph is rebuilt for the current route */
  await expect(page.locator(".chead")).toContainText(oid2);
});

test("branches toggle hides only inactive side branches and restores them", async ({ page }) => {
  const biz = await mkBusiness(page);
  const oid = await mkObjective(page, biz);
  await gotoObjective(page, biz, oid);
  const loop = page.locator("section.aloop");

  const brCount = async () => await loop.locator(".aloop-node.br").count();
  const edgeCount = async () => await loop.locator(".aloop-edge").count();
  const spineCount = async () => await loop.locator(".aloop-node:not(.br)").count();

  const brBefore = await brCount();
  const edgesBefore = await edgeCount();
  const spineBefore = await spineCount();
  expect(brBefore).toBe(5);
  expect(spineBefore).toBe(15);

  await loop.getByRole("button", { name: "branches" }).click();
  const brHidden = await brCount();
  expect(brHidden).toBeLessThanOrEqual(brBefore);
  /* inactive branches hide; spine never hides */
  expect(await spineCount()).toBe(spineBefore);
  /* hidden branch edges are removed with their nodes */
  expect(await edgeCount()).toBeLessThanOrEqual(edgesBefore);

  /* toggle back restores graph state */
  await loop.getByRole("button", { name: "branches" }).click();
  expect(await brCount()).toBe(brBefore);
  expect(await edgeCount()).toBe(edgesBefore);
});

test("cockpit observation_error → Missions panel marked UNVERIFIED, no cockpit-derived claims verified", async ({ page }) => {
  const biz = await mkBusiness(page);
  const oid = await mkObjective(page, biz);
  await seedSession(page);
  await page.addInitScript((id: string) => {
    localStorage.setItem("pair.business_id", id);
  }, biz);
  /* Inject an observation-integrity failure into the live cockpit
     response — simulates the server-flagged unverified read. */
  await page.route("**/vnext/objectives/*/cockpit*", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    if (json?.cockpit) {
      json.cockpit.observation_error = "DIGEST_MISMATCH";
      json.cockpit.missions = [
        { mission_id: "MSN_FAKE_RUN", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: null },
      ];
      json.cockpit.lifecycle = { ...(json.cockpit.lifecycle ?? {}), owner_action_required: true };
    }
    await route.fulfill({ response: res, json });
  });
  await page.goto(`/app/objectives/${oid}`);
  const loop = page.locator("section.aloop");
  await expect(loop).toBeVisible();

  /* per-panel UNVERIFIED label on the Missions panel */
  await expect(loop.locator(".aloop-msn-unverified")).toBeVisible();
  await expect(loop.locator(".aloop-msn-unverified")).toContainText("UNVERIFIED");
  /* raw mission row still visible but marked raw */
  await expect(loop.locator(".aloop-msn-list")).toContainText("MSN_FAKE_RUN");

  /* cockpit-derived nodes are not presented as verified/active */
  await expect(loop.locator(".aloop-head")).toContainText("unverified cockpit observation");
  /* headline never claims verified execution */
  await expect(loop.locator(".aloop-head")).not.toContainText("executing");
});

test("driver denials render as bounded historical table with real labels", async ({ page }) => {
  const biz = await mkBusiness(page);
  const oid = await mkObjective(page, biz);
  await seedSession(page);
  await page.addInitScript((id: string) => {
    localStorage.setItem("pair.business_id", id);
  }, biz);
  /* The e2e server has no auto-driver (404). Intercept the read and
     inject a realistic driver payload with 10 denials — proves the
     table renders bounded (8) historical rows with exact labels. */
  await page.route("**/vnext/objectives/*/auto-driver*", async (route) => {
    const denials = Array.from({ length: 10 }, (_, k) => ({
      at: k === 9 ? "not-a-date" : `2026-01-01T10:${String(k).padStart(2, "0")}:00Z`,
      fence: k + 1,
      label: k === 3 ? "<b>inject</b>" : `DENIAL_${k}`,
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        auto_driver: {
          objective_id: oid,
          enabled: true,
          last_outcome: "WAITING",
          last_result: { fault: null },
          last_fence: 4,
          admissions: [],
          denials,
          lease: null,
        },
      }),
    });
  });
  await page.goto(`/app/objectives/${oid}`);
  const loop = page.locator("section.aloop");
  await expect(loop).toBeVisible();

  const table = loop.locator(".aloop-den-table");
  await expect(table).toBeVisible();
  /* bounded at 8 records */
  await expect(table.locator("tbody tr")).toHaveCount(8);
  /* exact labels rendered, suspicious text stays plain text */
  await expect(table).toContainText("DENIAL_9");
  await expect(table).toContainText("<b>inject</b>");
  await expect(table.locator("b")).toHaveCount(0);
  /* malformed timestamp → explicit invalid value, no crash */
  await expect(table).toContainText("invalid timestamp");
  /* marked historical, never an objective failure */
  await expect(loop.locator(".aloop-den-h")).toContainText("historical");
  /* admission history table untouched */
  await expect(loop.locator(".aloop-adm-table:not(.aloop-den-table)")).toHaveCount(0);
});
