import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

// P15.9-B5.2 — Legacy Admin Parity: /app/system/business-admin +
// /app/workforce/admin. Real backend seeds via the public API; route
// interception only for adversarial failures/double-submit (labeled).
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

async function firstProjectId(page: Page): Promise<string> {
  const prjs = (await page.request.get("/api/projects", {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as Array<Record<string, unknown>>;
  return String(prjs[0]?.project_id ?? prjs[0]?.entity_id ?? "default");
}

async function mkBusiness(page: Page, tag: string): Promise<string> {
  const b = await apiPost(page, "/businesses", {
    name: `e2e-b52-${tag}-${uniq()}`, project_id: await firstProjectId(page),
  });
  return String(b.business_id ?? b.entity_id);
}

async function mkAgent(page: Page, businessId: string, title: string) {
  const a = await apiPost(page, "/org-agents", { business_id: businessId, title, department: "ops" });
  return String(a.agent_id ?? a.entity_id);
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

/* 1+2+14+19: create business → global list (disclosed) → select →
   cockpit reads that business; inspect renders the detail bundle. */
test("business-admin: create business, global list disclosure, select, inspect bundle", async ({ page }) => {
  const existing = await mkBusiness(page, "list");
  const bizName = `e2e-b52-created-${uniq()}`;
  await page.goto("/app/system/business-admin");
  await expect(page.locator("h1")).toHaveText("Business Administration");

  // global-list disclosure — labeled, never presented as owner-scoped
  await expect(page.locator(".sub")).toContainText("global, unfiltered listing");
  await expect(page.locator(".sub")).toContainText("not proof of ownership");
  await expect(page.locator(".sub")).toContainText("NOT an owner-scoped");
  await expect(page.locator(".page")).toContainText(existing);

  // create → pinned dialog → canonical POST
  await page.getByLabel("business name").fill(bizName);
  const projectOpt = page.getByLabel("project").locator("option").nth(1);
  const projectId = await projectOpt.getAttribute("value");
  await page.getByLabel("project").selectOption(projectId!);
  await page.getByRole("button", { name: "Create business…" }).click();
  await expect(page.locator(".cdlg")).toContainText(bizName);
  await expect(page.locator(".cdlg")).toContainText(String(projectId));
  await page.locator(".cdlg").getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".page")).toContainText("Business created — BIZ_", { timeout: 15000 });

  const row = page.locator(".nrow", { hasText: "CREATED" });
  const createdId = (await row.locator("code").first().textContent())!.trim();

  // appears in the global list after refetch
  await expect(page.locator(".page")).toContainText(createdId);
  await expect(page.locator(".page")).toContainText(bizName);

  // select → canonical BizContext → /app/company reads THAT business_id
  await row.getByRole("button", { name: "Select this business" }).click();
  await expect(page.locator(".bizswitch .v").first()).toHaveText(createdId);
  const reads: string[] = [];
  await page.route(`**/*${createdId}**`, (route) => {
    reads.push(route.request().url());
    return route.continue();
  });
  await page.goto("/app/company");
  await expect.poll(() => reads.length, { timeout: 15000 }).toBeGreaterThan(0);
  await page.unroute(`**/*${createdId}**`);

  // inspect deep-link → exact row, full bundle sections
  await page.goto("/app/system/business-admin");
  await page.getByLabel("business id to inspect").fill(createdId);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.locator(".inspectbundle")).toContainText("Agents (");
  await expect(page.locator(".inspectbundle")).toContainText("Objectives (");
  await expect(page.locator(".inspectbundle")).toContainText("Routines (");
  await expect(page.locator(".inspectbundle")).toContainText("Work items (board columns)");
  await expect(page.locator(".inspectbundle")).not.toContainText(existing); // pinned to exact id
});

/* 3+4+5+6+7+8+17: full work-item lifecycle + agent creation through
   the UI, canonical refresh after every mutation. */
test("workforce-admin: agent + work-item lifecycle (create/open/block/unblock/comment)", async ({ page }) => {
  const biz = await mkBusiness(page, "wfadmin");
  const agentTitle = `Worker-${uniq()}`;
  const wiTitle = `Job-${uniq()}`;
  await seedBiz(page, biz);
  await page.goto("/app/workforce/admin");
  await expect(page.locator("h1")).toHaveText("Workforce Administration");
  await expect(page.locator(".srcnote")).toContainText("NOT server-side authorization");

  // --- create agent ---
  await page.getByLabel("agent title").fill(agentTitle);
  await page.getByLabel("agent department").fill("ops");
  await page.getByRole("button", { name: "Create agent…" }).click();
  await expect(page.locator(".cdlg")).toContainText("auto-materializes a baseline execution contract");
  await page.locator(".cdlg").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".page")).toContainText("Agent created — AGT_", { timeout: 15000 });
  await expect(page.locator(".page")).toContainText(agentTitle);
  const agentLink = page.getByRole("link", { name: /open AGT_.* in Agent Detail/ });
  const agentId = (await agentLink.textContent())!.replace(/^open (.*) in Agent Detail$/, "$1").trim();

  // canonical identity in Agent Detail
  await agentLink.click();
  await expect(page.locator("h1")).toHaveText(agentTitle);
  await expect(page).toHaveURL(new RegExp(`/app/workforce/${agentId}`));
  await page.goto("/app/workforce/admin");

  // --- create work item assigned → READY, never auto-opened ---
  await page.getByLabel("work item title").fill(wiTitle);
  await page.getByLabel("work item goal").fill("ship it");
  await page.getByLabel("assignee", { exact: true }).selectOption({ label: `${agentTitle} (${agentId.slice(0, 12)}…)` });
  await page.getByRole("button", { name: "Create work item…" }).click();
  await expect(page.locator(".cdlg")).toContainText("never auto-opened");
  await page.locator(".cdlg").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".page")).toContainText("Work item created — WI_", { timeout: 15000 });
  const wiRow = page.locator(".nrow", { hasText: wiTitle });
  await expect(wiRow).toContainText("READY");
  await expect(wiRow).not.toContainText("IN_PROGRESS"); // no auto-open

  // --- open (high-impact trigger) → canonical refresh ---
  await wiRow.getByRole("button", { name: "Open…" }).click();
  await expect(page.locator(".cdlg")).toContainText("HIGH-IMPACT");
  await expect(page.locator(".cdlg")).toContainText("governed mission execution");
  await page.locator(".cdlg").getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".page")).toContainText("Open committed", { timeout: 15000 });
  await expect(page.locator(".nrow", { hasText: wiTitle })).toContainText("IN_PROGRESS");

  // --- block → canonical refresh (in-flight mission paused first by backend) ---
  await page.locator(".nrow", { hasText: wiTitle }).getByRole("button", { name: "Block…" }).click();
  await page.getByLabel("block reason").fill("e2e freeze");
  await page.locator(".cdlg").getByRole("button", { name: "Block" }).click();
  await expect(page.locator(".page")).toContainText(`Blocked`, { timeout: 15000 });
  await expect(page.locator(".nrow", { hasText: wiTitle })).toContainText("BLOCKED");

  // --- unblock → READY ---
  await page.locator(".nrow", { hasText: wiTitle }).getByRole("button", { name: "Unblock…" }).click();
  await page.locator(".cdlg").getByRole("button", { name: "Unblock" }).click();
  await expect(page.locator(".page")).toContainText("Unblocked", { timeout: 15000 });
  await expect(page.locator(".nrow", { hasText: wiTitle })).toContainText("READY");

  // --- comment ---
  await page.locator(".nrow", { hasText: wiTitle }).getByRole("button", { name: "Comment…" }).click();
  await page.getByLabel("comment body").fill("e2e note");
  await page.locator(".cdlg").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".page")).toContainText("Comment added", { timeout: 15000 });

  // refresh → canonical state (BLOCKED→READY row still READY, comment persisted server-side)
  await page.reload();
  await expect(page.locator(".nrow", { hasText: wiTitle })).toContainText("READY", { timeout: 15000 });
});

/* 9+10: routine create → ENABLED; disable/enable via canonical action. */
test("workforce-admin: routine create/enable/disable", async ({ page }) => {
  const biz = await mkBusiness(page, "rt");
  const rtName = `Daily-${uniq()}`;
  await seedBiz(page, biz);
  await page.goto("/app/workforce/admin");

  await page.getByLabel("routine name").fill(rtName);
  await page.getByLabel("goal template").fill("summarize the day");
  await page.getByLabel("cron").fill("0 9 * * 1-5");
  await page.getByRole("button", { name: "Create routine…" }).click();
  await expect(page.locator(".cdlg")).toContainText("canonical mission_schedule");
  await page.locator(".cdlg").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".page")).toContainText("Routine created — RTN_", { timeout: 15000 });
  const rtRow = page.locator(".nrow", { hasText: rtName });
  await expect(rtRow).toContainText("ENABLED");

  await rtRow.getByRole("button", { name: "Disable…" }).click();
  await expect(page.locator(".cdlg")).toContainText("DISABLE");
  await page.locator(".cdlg").getByRole("button", { name: "Disable" }).click();
  await expect(page.locator(".page")).toContainText("disabled", { timeout: 15000 });
  await expect(page.locator(".nrow", { hasText: rtName })).toContainText("DISABLED");

  await page.locator(".nrow", { hasText: rtName }).getByRole("button", { name: "Enable…" }).click();
  await page.locator(".cdlg").getByRole("button", { name: "Enable" }).click();
  await expect(page.locator(".page")).toContainText("enabled", { timeout: 15000 });
  await expect(page.locator(".nrow", { hasText: rtName })).toContainText("ENABLED");
});

/* 11: legacy objective create → labeled distinct from vnext Objective UI. */
test("workforce-admin: legacy objective create labeled as compat API", async ({ page }) => {
  const biz = await mkBusiness(page, "obj");
  const objTitle = `LegacyObj-${uniq()}`;
  await seedBiz(page, biz);
  await page.goto("/app/workforce/admin");

  await expect(page.locator(".page")).toContainText("LEGACY compat contract");
  await expect(page.locator(".page")).toContainText("distinct from the canonical vnext Objective UI");
  await page.getByLabel("legacy objective title").fill(objTitle);
  await page.getByLabel("metric").fill("widgets");
  await page.getByLabel("target").fill("10");
  await page.getByRole("button", { name: "Create legacy objective…" }).click();
  await expect(page.locator(".cdlg")).toContainText("LEGACY compat contract");
  await page.locator(".cdlg").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".page")).toContainText("Legacy objective created — OBJ_", { timeout: 15000 });
  await expect(page.locator(".page")).toContainText(objTitle);
});

/* 12+13: business switch invalidates pinned dialogs; no-business state
   shows no create forms (fail closed). */
test("workforce-admin: business switch closes dialogs; no-biz hides forms", async ({ page }) => {
  const bizA = await mkBusiness(page, "sw-a");
  const bizB = await mkBusiness(page, "sw-b");
  await seedBiz(page, bizA);
  await page.goto("/app/workforce/admin");

  // a dialog pinned under A can never submit under B: switch via the
  // canonical localStorage identity + reload — the pinned dialog is gone
  // and a fresh dialog pins B.
  await page.getByLabel("agent title").fill("Ghost");
  await page.getByLabel("agent department").fill("ops");
  await page.getByRole("button", { name: "Create agent…" }).click();
  await expect(page.locator(".cdlg")).toContainText(bizA);
  // register a later init script (init scripts run in order: first seeds A,
  // this one lands B) then reload — the pinned A dialog must be gone
  await page.addInitScript((b) => localStorage.setItem("pair.business_id", b), bizB);
  await page.reload();
  await expect(page.locator(".cdlg")).toHaveCount(0);
  await expect(page.locator(".bizswitch .v").first()).toHaveText(bizB);

  // re-open → pinned to B, never to A
  await page.getByLabel("agent title").fill("GhostB");
  await page.getByLabel("agent department").fill("ops");
  await page.getByRole("button", { name: "Create agent…" }).click();
  await expect(page.locator(".cdlg")).toContainText(bizB);
  await expect(page.locator(".cdlg")).not.toContainText(bizA);
  await page.locator(".cdlg").getByRole("button", { name: "Cancel" }).click();

  // no-business → no create forms at all
  await page.addInitScript(() => localStorage.removeItem("pair.business_id"));
  await page.goto("/app/workforce/admin");
  await expect(page.getByText("No business selected", { exact: true })).toBeVisible();
  await expect(page.getByText(/bound to the selected business/)).toBeVisible();
  await expect(page.getByLabel("agent title")).toHaveCount(0);
  await expect(page.getByLabel("work item title")).toHaveCount(0);
  await expect(page.getByLabel("routine name")).toHaveCount(0);
});

/* 15+16: failed create shows the exact backend error (no fabricated
   success); double-submit commits exactly one POST. */
test("workforce-admin: exact error on failed create; dup-submit sends one POST", async ({ page }) => {
  const biz = await mkBusiness(page, "err");
  await seedBiz(page, biz);

  // adversarial: fail the create endpoint deterministically
  await page.route("**/api/org-agents", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 400, contentType: "application/json",
        body: JSON.stringify({ error: "FAIL_CLOSED_ORG_AGENT_FIELDS", detail: "title and department required" }),
      });
    }
    return route.continue();
  });
  await page.goto("/app/workforce/admin");
  await page.getByLabel("agent title").fill("Doomed");
  await page.getByLabel("agent department").fill("ops");
  await page.getByRole("button", { name: "Create agent…" }).click();
  await page.locator(".cdlg").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".page")).toContainText("create agent failed: title and department required (FAIL_CLOSED_ORG_AGENT_FIELDS)");
  await expect(page.locator(".page")).not.toContainText("Agent created —");
  await page.unroute("**/api/org-agents");

  // double-submit → exactly one canonical POST
  const posts: string[] = [];
  await page.route("**/api/org-agents", (route) => {
    if (route.request().method() === "POST") posts.push("x");
    return route.continue();
  });
  await page.getByLabel("agent title").fill("SingleShot");
  await page.getByLabel("agent department").fill("ops");
  await page.getByRole("button", { name: "Create agent…" }).click();
  const confirm = page.locator(".cdlg").getByRole("button", { name: "Confirm" });
  await confirm.dblclick();
  await expect(page.locator(".page")).toContainText("Agent created — AGT_", { timeout: 15000 });
  expect(posts.length).toBe(1);
});

/* extra fail-closed coverage: projects read unavailable → business
   creation blocked (never guess a project_id); 401 �� honest error. */
test("business-admin: projects unavailable blocks creation; unauthenticated fails closed", async ({ page }) => {
  await page.route("**/api/projects", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "ERR" }) }));
  await page.goto("/app/system/business-admin");
  await expect(page.locator(".page")).toContainText("project list unavailable");
  await expect(page.locator(".page")).toContainText("creation blocked fail-closed");
  await expect(page.getByLabel("business name")).toHaveCount(0);
  await page.unroute("**/api/projects");

  // unauthenticated — fresh browser context with NO seeded token/localStorage:
  // the app-level auth gate renders, never a fabricated admin surface
  const ctx2 = await page.context().browser()!.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto("/app/system/business-admin");
  await expect(p2.locator("body")).toContainText(/error|unavailable|sign in|auth|token/i, { timeout: 15000 });
  await expect(p2.getByLabel("business name")).toHaveCount(0);
  await ctx2.close();
});

/* assignee/objective selects only offer same-business options —
   cross-business IDs can never be submitted from the UI. */
test("workforce-admin: selects offer only same-business candidates", async ({ page }) => {
  const bizA = await mkBusiness(page, "sel-a");
  const bizB = await mkBusiness(page, "sel-b");
  const aTitle = `SameBiz-${uniq()}`;
  await mkAgent(page, bizA, aTitle);
  await mkAgent(page, bizB, `Foreign-${uniq()}`);
  await seedBiz(page, bizA);
  await page.goto("/app/workforce/admin");

  const assignee = page.getByLabel("assignee", { exact: true });
  await expect(assignee).toContainText(aTitle);
  await expect(assignee.locator("option")).toHaveCount(2); // "— unassigned —" + one agent
  const reports = page.getByLabel("reports to");
  await expect(reports).toContainText(aTitle);
  await expect(reports.locator("option")).toHaveCount(2);
});

/* R1-F1: SPA business switch (NO reload) wipes every business-dependent
   form — A-specific reports_to/assignee/objective can never be
   submitted under B, and no mutation fires during the switch. */
test("workforce-admin: SPA business switch resets forms — stale selections unsubmittable", async ({ page }) => {
  const bizA = await mkBusiness(page, "f1-a");
  const bizB = await mkBusiness(page, "f1-b");
  const aTitle = `AgentA-${uniq()}`;
  const agentA = await mkAgent(page, bizA, aTitle);
  await apiPost(page, "/objectives", { business_id: bizA, title: `ObjA-${uniq()}`, metric: "m", target: "1" });
  const posts: string[] = [];
  await page.route("**/api/**", (route) => {
    if (route.request().method() === "POST") posts.push(route.request().url());
    return route.continue();
  });
  await seedBiz(page, bizA);
  await page.goto("/app/workforce/admin");
  await expect(page.locator("h1")).toHaveText("Workforce Administration");

  // populate every business-dependent field under A (no submit)
  await page.getByLabel("agent title").fill("StaleA");
  await page.getByLabel("agent department").fill("ops");
  await page.getByLabel("reports to").selectOption(agentA);
  await page.getByLabel("work item title").fill("StaleWI");
  await page.getByLabel("work item goal").fill("g");
  await page.getByLabel("assignee", { exact: true }).selectOption(agentA);
  const objSel = page.getByLabel("objective", { exact: true });
  const objVal = await objSel.locator("option").nth(1).getAttribute("value");
  await objSel.selectOption(objVal!);
  await page.getByLabel("routine name").fill("StaleRT");
  await page.getByLabel("goal template").fill("t");
  await page.getByLabel("cron").fill("0 9 * * *");
  await page.getByLabel("routine assignee").selectOption(agentA);
  await page.getByLabel("legacy objective title").fill("StaleObj");
  const before = posts.length;

  // switch to B through the REAL switcher — SPA navigation, no reload
  await page.getByRole("button", { name: "business switcher" }).first().click();
  await page.getByLabel("business id").fill(bizB);
  await page.getByRole("button", { name: "Use" }).click();
  await expect(page.locator("h1")).toHaveText("Workforce Administration");
  await expect(page.locator(".srcnote")).toContainText(bizB);

  // every business-dependent form is reset — nothing stale survives
  await expect(page.getByLabel("agent title")).toHaveValue("");
  await expect(page.getByLabel("agent department")).toHaveValue("");
  await expect(page.getByLabel("reports to")).toHaveValue("");
  await expect(page.getByLabel("work item title")).toHaveValue("");
  await expect(page.getByLabel("work item goal")).toHaveValue("");
  await expect(page.getByLabel("assignee", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("objective", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("routine assignee")).toHaveValue("");
  await expect(page.getByLabel("legacy objective title")).toHaveValue("");
  // A's agent/objective are not selectable under B at all
  await expect(page.getByLabel("reports to").locator("option")).toHaveCount(1);
  await expect(page.getByLabel("assignee", { exact: true }).locator("option")).toHaveCount(1);
  // the switch itself issued zero mutations
  expect(posts.length).toBe(before);
});

/* R1-F2: delayed A→B inspect — stale A detail can never render as B;
   out-of-order responses and failures handled; identity verified. */
test("business-admin: inspect clears stale detail — out-of-order + failure proof", async ({ page }) => {
  const nameA = `InspA-${uniq()}`;
  const nameB = `InspB-${uniq()}`;
  const b = await apiPost(page, "/businesses", { name: nameA, project_id: await firstProjectId(page) });
  const bizA = String(b.business_id ?? b.entity_id);
  const b2 = await apiPost(page, "/businesses", { name: nameB, project_id: await firstProjectId(page) });
  const bizB = String(b2.business_id ?? b2.entity_id);

  const aDone: string[] = [];
  await page.route(`**/api/businesses/${bizA}`, async (route) => {
    await new Promise((r) => setTimeout(r, 700)); // A resolves LATE
    aDone.push("a");
    return route.continue();
  });
  await page.goto("/app/system/business-admin");
  await expect(page.locator("h1")).toHaveText("Business Administration");

  // start A's inspect → loading row pinned to A's id
  await page.getByLabel("business id to inspect").fill(bizA);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByTestId("inspect-loading")).toContainText(bizA);

  // switch target to B before A resolves
  await page.getByLabel("business id to inspect").fill(bizB);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByTestId("inspect-loading")).toContainText(bizB);
  await expect(page.locator(".inspectbundle")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".page")).toContainText(nameB);

  // A resolves late — its payload must NEVER render under B's inspection
  // (nameA still legitimately appears in the global list — scope the
  // check to the detail block itself)
  await expect.poll(() => aDone.length, { timeout: 15000 }).toBe(1);
  const detail = page.locator(".nrow", { has: page.locator(".inspectbundle") });
  await expect(detail).toContainText(nameB);
  await expect(detail).not.toContainText(nameA);

  // failure on a third inspect: error replaces — B's stale detail is gone
  await page.getByLabel("business id to inspect").fill("BIZ_missing_e2e");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByTestId("inspect-loading")).toContainText("BIZ_missing_e2e");
  await expect(page.locator(".page")).toContainText(/NOT_FOUND|unavailable|ERROR/i, { timeout: 15000 });
  await expect(page.locator(".inspectbundle")).toHaveCount(0);
});

/* R1-F3: malformed 200 envelopes → UNAVAILABLE sections, never a
   fabricated empty canonical list, no crash, no indefinite skeleton. */
test("workforce-admin: malformed 200 payloads fail closed — no crash, no fake empty", async ({ page }) => {
  const biz = await mkBusiness(page, "f3");
  await seedBiz(page, biz);
  const posts: string[] = [];
  await page.route("**/api/**", (route) => {
    if (route.request().method() === "POST") posts.push(route.request().url());
    return route.continue();
  });
  await page.route("**/api/work-items*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ work_items: "corrupt" }) }));
  await page.route("**/api/routines*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
  await page.route("**/api/objectives*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ objectives: "bad" }) }));
  await page.goto("/app/workforce/admin");

  // page settles ready (agents read is real); malformed reads are labeled
  await expect(page.locator("h1")).toHaveText("Workforce Administration");
  await expect(page.locator(".page")).toContainText("work-item read unavailable (MALFORMED)");
  await expect(page.locator(".page")).toContainText("routine read unavailable (MALFORMED)");
  await expect(page.locator(".page")).toContainText("objective list unavailable");
  // never rendered as empty canonical lists
  await expect(page.getByText("No work items")).toHaveCount(0);
  await expect(page.getByText("No routines")).toHaveCount(0);
  await expect(posts).toEqual([]);

  // malformed PRIMARY read → honest error, never an empty agent list
  await page.route("**/api/org-agents*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
  await page.reload();
  await expect(page.locator(".page")).toContainText("malformed payload", { timeout: 15000 });
  await expect(page.getByLabel("agent title")).toHaveCount(0);
});

/* R2-F1: malformed COLLECTION ELEMENTS — arrays containing null/
   primitives/identity-less rows are MALFORMED, never silently filtered
   to a fake complete list, never crash/wedge, zero unsafe POSTs. */
test("R2: malformed collection elements fail closed per-section", async ({ page }) => {
  const biz = await mkBusiness(page, "r2");
  const posts: string[] = [];
  await seedBiz(page, biz);

  // --- secondary collections: each malformed independently ---
  await page.route("**/api/**", (route) => {
    if (route.request().method() === "POST") posts.push(route.request().url());
    return route.continue();
  });
  await page.route("**/api/work-items*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ work_items: [null] }) }));
  await page.route("**/api/routines*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ routines: [null] }) }));
  await page.route("**/api/objectives*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ objectives: [null] }) }));
  await page.goto("/app/workforce/admin");
  await expect(page.locator("h1")).toHaveText("Workforce Administration");
  await expect(page.locator(".page")).toContainText("work-item read unavailable (MALFORMED)");
  await expect(page.locator(".page")).toContainText("routine read unavailable (MALFORMED)");
  await expect(page.locator(".page")).toContainText("objective list unavailable");
  await expect(page.getByText("No work items")).toHaveCount(0);
  await expect(page.getByText("No routines")).toHaveCount(0);
  await expect(posts).toEqual([]);
  await page.unroute("**/api/work-items*");
  await page.unroute("**/api/routines*");
  await page.unroute("**/api/objectives*");

  // --- primary collection: [null] and [{}] are both fatal, not empty ---
  for (const body of [JSON.stringify({ agents: [null] }), JSON.stringify({ agents: [{}] })]) {
    await page.route("**/api/org-agents*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body }));
    await page.reload();
    await expect(page.locator(".page")).toContainText("malformed payload", { timeout: 15000 });
    await expect(page.getByLabel("agent title")).toHaveCount(0);
    await page.unroute("**/api/org-agents*");
  }

  // --- valid EMPTY arrays remain genuinely empty ---
  await page.route("**/api/work-items*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ work_items: [] }) }));
  await page.route("**/api/routines*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ routines: [] }) }));
  await page.reload();
  await expect(page.getByText("No work items")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("No routines").first()).toBeVisible();
  await page.unroute("**/api/work-items*");
  await page.unroute("**/api/routines*");

  // --- projects [null] blocks business creation; businesses [null] → unavailable list ---
  await page.route("**/api/projects", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[null]" }));
  await page.route("**/api/businesses", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ businesses: [null] }) }));
  await page.goto("/app/system/business-admin");
  await expect(page.locator(".page")).toContainText("project list unavailable (MALFORMED)");
  await expect(page.getByLabel("business name")).toHaveCount(0);
  await expect(page.locator(".page")).toContainText("global list unavailable (MALFORMED)");
  await page.unroute("**/api/projects");
  await page.unroute("**/api/businesses");

  // --- business-detail child collection malformed → detail error, no partial render ---
  const target = await mkBusiness(page, "r2-detail");
  await page.route(`**/api/businesses/${target}`, (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        business: { business_id: target, name: "X", project_id: "p", status: "ACTIVE", currency: "USD" },
        agents: [null], objectives: [], routines: [], board: {}, budgets: [],
      }),
    }));
  await page.getByLabel("business id to inspect").fill(target);
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.locator(".page")).toContainText("malformed detail payload", { timeout: 15000 });
  await expect(page.locator(".inspectbundle")).toHaveCount(0);
  await expect(posts).toEqual([]);
});
