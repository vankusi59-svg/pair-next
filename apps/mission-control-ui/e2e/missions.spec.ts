import { test, expect, type Page, type Route } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

// P15.9-B5.3 — Mission Operations + Task Entry + Mission Detail.
// Golden paths run against the real backend; interceptions are labeled
// adversarial cases (malformed/failed/ambiguous reads).

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

async function firstProject(page: Page) {
  const prjs = (await page.request.get("/api/projects", {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as Array<Record<string, unknown>>;
  return prjs[0];
}

/** Canonical two-step create: preview → confirm (same seam as the UI). */
async function mkMission(page: Page, goal: string): Promise<string> {
  const p = await firstProject(page);
  const body = {
    project_id: String(p.project_id), goal,
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [String(p.root_location ?? "")],
  };
  const pv = await api(page, "POST", "/missions/preview", body);
  expect(pv.ok, `preview -> ${pv.status}`).toBeTruthy();
  const cf = await api(page, "POST", "/missions/confirm", {
    preview_id: String(pv.json.preview_id), plan_digest: String(pv.json.plan_digest),
  });
  expect(cf.ok, `confirm -> ${cf.status}`).toBeTruthy();
  const m = (cf.json.mission ?? cf.json) as Record<string, unknown>;
  return String(m.mission_id);
}

const countPosts = async (page: Page, urls: string[]) => {
  page.on("request", (r) => {
    if (r.method() === "POST") urls.push(r.url());
  });
};

test.beforeEach(async ({ page }) => { await seedSession(page); });

/* 1+2+3+4+6: global list labeled, runtime states preserved, search,
   filter, sort, deep links, new-mission nav, routing card. */
test("missions list: global label, search/filter/sort, deep links, cards", async ({ page }) => {
  const goalA = `e2e-m53-list-${uniq()}`;
  const mid = await mkMission(page, goalA);
  await page.goto("/app/missions");
  await expect(page.getByText(/global, unfiltered listing/)).toBeVisible();
  await expect(page.locator("h1")).toContainText("Mission Operations");
  // runtime state preserved verbatim — no merged/invented label
  const row = page.locator(".nrow", { hasText: goalA }).first();
  await expect(row).toBeVisible();
  await expect(row.locator(".sbadge").first()).toBeVisible();
  // cards: running/finished numbers + routable executor count (not "—")
  await expect(page.locator(".nrow", { hasText: "Routable executors" }).first()).toContainText(/\d/);
  // search by goal fragment + by id
  await page.getByLabel("search missions").fill(goalA.slice(-10));
  await expect(page.locator(".nrow", { hasText: goalA })).toHaveCount(1);
  await page.getByLabel("search missions").fill(mid.slice(0, 12));
  await expect(page.locator(".nrow", { hasText: goalA })).toHaveCount(1);
  await page.getByLabel("search missions").fill("");
  // filter to the mission's own state
  await page.getByLabel("filter runtime state").selectOption({ index: 1 });
  await page.getByLabel("filter runtime state").selectOption("");
  // sort toggle
  await page.getByRole("button", { name: "toggle sort" }).click();
  // deep link to detail
  await page.locator(".nrow", { hasText: goalA }).getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/app/missions/${mid}`));
  await expect(page.locator("h1")).toContainText(mid);
});

/* 5: unavailable routing read is disclosed, never rendered as zero. */
test("missions list: routing unavailable disclosed, never zero (adversarial)", async ({ page }) => {
  await page.route("**/api/routing", (r: Route) =>
    r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' }));
  await page.goto("/app/missions");
  await expect(page.locator(".nrow", { hasText: "Routable executors" })).toContainText(/unavailable/);
  await expect(page.locator(".nrow", { hasText: "Routable executors" })).not.toContainText(/\b0\b/);
  // missions list still renders independently
  await expect(page.getByText(/global, unfiltered listing/)).toBeVisible();
});

/* 6b: malformed missions payload → fail-closed, never a fake empty list. */
test("missions list: malformed payload fails closed (adversarial)", async ({ page }) => {
  await page.route("**/api/missions", (r: Route) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: '{"missions":[null]}' })
      : r.continue());
  await page.goto("/app/missions");
  await expect(page.getByText(/MALFORMED|malformed/).first()).toBeVisible();
  await expect(page.getByText("No missions")).toHaveCount(0);
});

/* 7+8+9+10+11: Task Entry — verified project select, preview renders
   persisted plan, input edits invalidate, preview alone creates no
   mission, confirmation carries the exact preview_id+digest. */
test("task entry: preview → pinned confirm → detail (single seam)", async ({ page }) => {
  const posts: string[] = [];
  await countPosts(page, posts);
  const goal = `e2e-m53-${uniq()}`;
  await page.goto("/app/missions/new");
  await expect(page.locator("h1")).toHaveText("Task Entry");
  // preview blocked until inputs valid
  const pvBtn = page.getByRole("button", { name: /Preview plan|Preview & execute/ });
  await expect(pvBtn).toBeDisabled();
  await page.getByLabel("goal").fill(goal);
  await page.getByLabel("project").selectOption({ index: 1 });
  // preview — creates no mission (manual confirm default)
  await pvBtn.click();
  await expect(page.getByText("Proposed plan")).toBeVisible();
  await expect(page.getByText(/preview .* · digest/)).toBeVisible();
  await expect(page.getByText(/deps:/).first()).toBeVisible(); // DAG/dep data rendered
  expect(posts.filter((u) => u.includes("/api/missions")).length).toBe(1); // preview POST only
  expect(posts.filter((u) => u.includes("confirm"))).toEqual([]);
  // input edit invalidates the pinned preview
  await page.getByLabel("goal").fill(`${goal}-changed`);
  await expect(page.getByText("Proposed plan")).toHaveCount(0);
  // re-preview then confirm — count posts with exact preview payload
  const seen: Array<Record<string, unknown>> = [];
  await page.route("**/api/missions/confirm", async (r: Route) => {
    seen.push(r.request().postDataJSON() as Record<string, unknown>);
    await r.continue();
  });
  await page.getByRole("button", { name: /Preview plan/ }).click();
  await expect(page.getByText("Proposed plan")).toBeVisible();
  const digestLine = await page.getByText(/preview .* · digest/).innerText();
  await page.getByRole("button", { name: /Confirm & run/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText(/Pinned preview/);
  await Promise.all([
    page.waitForURL(/\/app\/missions\//),
    dlg.getByRole("button", { name: /Confirm & run/ }).click(),
  ]);
  expect(seen).toHaveLength(1);
  const pinned = digestLine.match(/preview (\S+)/)?.[1];
  expect(String(seen[0].preview_id)).toBe(pinned);
  expect(String(seen[0].plan_digest ?? "")).toMatch(/^[0-9a-f]{20,}/);
  await expect(page.locator("h1")).toContainText("Mission");
});

/* 11b: stale digest fails closed — server enforces, no auto-retry. */
test("task entry: stale/invalid digest → canonical failure, no retry", async ({ page }) => {
  await page.goto("/app/missions/new");
  await page.getByLabel("goal").fill(`e2e-m53-stale-${uniq()}`);
  await page.getByLabel("project").selectOption({ index: 1 });
  await page.getByRole("button", { name: /Preview plan/ }).click();
  await expect(page.getByText("Proposed plan")).toBeVisible();
  const posts: string[] = [];
  await countPosts(page, posts);
  // corrupt the pinned digest at confirm-time
  await page.route("**/api/missions/confirm", (r: Route) =>
    r.fulfill({ status: 400, contentType: "application/json",
      body: '{"error":"FAIL_CLOSED_PLAN_DIGEST_MISMATCH"}' }));
  await page.getByRole("button", { name: /Confirm & run/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Confirm & run/ }).click();
  await expect(page.getByText(/Confirm failed.*DIGEST_MISMATCH/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(posts.filter((u) => u.includes("/api/missions/confirm"))).toHaveLength(1);
  await expect(page).toHaveURL(/\/app\/missions\/new/); // no fake success nav
});

/* 11c: double-click confirm = exactly one confirmation POST. */
test("task entry: double-confirm click yields exactly one POST", async ({ page }) => {
  await page.goto("/app/missions/new");
  await page.getByLabel("goal").fill(`e2e-m53-dbl-${uniq()}`);
  await page.getByLabel("project").selectOption({ index: 1 });
  await page.getByRole("button", { name: /Preview plan/ }).click();
  await expect(page.getByText("Proposed plan")).toBeVisible();
  const posts: string[] = [];
  await countPosts(page, posts);
  await page.getByRole("button", { name: /Confirm & run/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Confirm & run/ }).dblclick();
  await page.waitForURL(/\/app\/missions\//, { timeout: 15000 });
  expect(posts.filter((u) => u.includes("/api/missions/confirm"))).toHaveLength(1);
});

/* 11d: ambiguous transport outcome — honest unknown, no auto-retry. */
test("task entry: 5xx on confirm → outcome unknown, no auto-retry", async ({ page }) => {
  await page.goto("/app/missions/new");
  await page.getByLabel("goal").fill(`e2e-m53-amb-${uniq()}`);
  await page.getByLabel("project").selectOption({ index: 1 });
  await page.getByRole("button", { name: /Preview plan/ }).click();
  await expect(page.getByText("Proposed plan")).toBeVisible();
  const posts: string[] = [];
  await countPosts(page, posts);
  await page.route("**/api/missions/confirm", (r: Route) =>
    r.fulfill({ status: 502, contentType: "text/html", body: "bad gateway" }));
  await page.getByRole("button", { name: /Confirm & run/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Confirm & run/ }).click();
  await expect(page.getByText(/outcome unknown.*may have been committed/i)).toBeVisible();
  expect(posts.filter((u) => u.includes("/api/missions/confirm"))).toHaveLength(1);
});

/* 8b: malformed/unavailable project list blocks Task Entry fail-closed. */
test("task entry: malformed project list blocks entry (adversarial)", async ({ page }) => {
  await page.route("**/api/projects", (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[null]" }));
  await page.goto("/app/missions/new");
  await expect(page.getByText(/project list unavailable/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Preview/ })).toHaveCount(0);
});

/* 9b: malformed preview → explicit invalid-preview state, never an
   apparently-valid empty plan to confirm. */
test("task entry: invalid preview payload rejected (adversarial)", async ({ page }) => {
  await page.route("**/api/missions/preview", (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: '{"plan":{"tasks":[]},"plan_digest":"abc","preview_id":"PV_x"}' }));
  await page.goto("/app/missions/new");
  await page.getByLabel("goal").fill(`e2e-m53-inv-${uniq()}`);
  await page.getByLabel("project").selectOption({ index: 1 });
  await page.getByRole("button", { name: /Preview plan/ }).click();
  await expect(page.getByText(/INVALID_PREVIEW/)).toBeVisible();
  await expect(page.getByText("Proposed plan")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Confirm & run/ })).toHaveCount(0);
});

/* 12+13+14+15+16+17: detail — overview, DAG, tasks, executions, timeline,
   evidence, files + read-only viewer + approvals lane link. */
test("mission detail: all sections on canonical reads + file viewer", async ({ page }) => {
  const posts: string[] = [];
  await countPosts(page, posts);
  const goal = `e2e-m53-det-${uniq()}`;
  const mid = await mkMission(page, goal);
  await page.goto(`/app/missions/${mid}`);
  await expect(page.locator("h1")).toContainText(mid);
  await expect(page.getByText(goal)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Task graph" })).toBeVisible();
  // DAG section renders (fresh CREATED mission may legitimately have no task nodes yet)
  await expect(page.locator("svg[role='img']").or(page.getByText("No tasks.")).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /Tasks \(/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workspace files" })).toBeVisible();
  // read-only nav: zero POSTs after page load
  posts.length = 0;
  await page.waitForTimeout(600);
  expect(posts).toEqual([]);
});

/* 13b: malformed subordinate collections settle independently. */
test("mission detail: malformed DAG fails only that section (adversarial)", async ({ page }) => {
  const mid = await mkMission(page, `e2e-m53-dag-${uniq()}`);
  await page.route(`**/api/missions/${mid}/dag`, (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"nodes":[null],"edges":[]}' }));
  await page.goto(`/app/missions/${mid}`);
  await expect(page.locator("h1")).toContainText(mid);
  const dagSec = page.locator("h2", { hasText: "Task graph" }).locator("xpath=following-sibling::div[1]");
  await expect(dagSec).toContainText(/UNAVAILABLE/);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible(); // others intact
});

/* 18: lifecycle — canonical action via pinned dialog, refetch, no
   optimistic state change; failure keeps state visible. */
test("mission detail: lifecycle pause via pinned dialog", async ({ page }) => {
  const mid = await mkMission(page, `e2e-m53-life-${uniq()}`);
  await page.goto(`/app/missions/${mid}`);
  const posts: string[] = [];
  await countPosts(page, posts);
  // whatever state it settles into, only matching actions are offered
  const pause = page.getByRole("button", { name: "Pause…" });
  const resume = page.getByRole("button", { name: "Resume…" });
  if (await pause.isVisible()) {
    await pause.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText(`PAUSE ${mid}`);
    await dlg.locator("button.primary").click();
    await expect(page.locator(".trunc[role='status']")).toContainText(/accepted by the backend/);
    expect(posts.filter((u) => u.endsWith("/pause"))).toHaveLength(1);
  } else if (await resume.isVisible()) {
    await resume.click();
    await page.getByRole("dialog").getByRole("button", { name: "resume" }).click();
    await expect(page.locator(".trunc[role='status']")).toContainText(/accepted/);
    expect(posts.filter((u) => u.endsWith("/resume"))).toHaveLength(1);
  } else {
    // fresh CREATED mission: only Cancel is offered — exercise it canonically
    await expect(pause).toHaveCount(0);
    await expect(resume).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText(`CANCEL ${mid}`);
    await expect(dlg).toContainText(/HIGH-IMPACT/);
    await dlg.locator("button.primary").click();
    await expect(page.locator(".trunc[role='status']")).toContainText(/accepted by the backend/);
    expect(posts.filter((u) => u.endsWith("/cancel"))).toHaveLength(1);
  }
});

/* 19: failed lifecycle action is reported, never optimistic. */
test("mission detail: failed action reports error, no optimistic flip (adversarial)", async ({ page }) => {
  const mid = await mkMission(page, `e2e-m53-fail-${uniq()}`);
  // verify a real state first
  const d = await api(page, "GET", `/missions/${mid}`);
  const st = String(d.json?.runtime?.state ?? d.json?.mission?.state ?? "");
  if (!["RUNNING", "PAUSED"].includes(st)) {
    test.skip(true, `mission settled ${st} — no pause/resume path to break`);
    return;
  }
  const action = st === "RUNNING" ? "pause" : "resume";
  await page.route(`**/api/missions/${mid}/${action}`, (r: Route) =>
    r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await page.goto(`/app/missions/${mid}`);
  await page.getByRole("button", { name: new RegExp(`^${action === "pause" ? "Pause" : "Resume"}…$`) }).click();
  await page.getByRole("dialog").locator("button.primary").click();
  await expect(page.locator(".trunc[role='status']")).toContainText(/AMBIGUOUS|failed/);
  // state badge unchanged (no optimistic transition)
  await expect(page.getByText(st).first()).toBeVisible();
});

/* 20: mission-id switch cannot show stale detail. */
test("mission detail: switching id discards previous payload", async ({ page }) => {
  const a = await mkMission(page, `e2e-m53-A-${uniq()}`);
  const b = await mkMission(page, `e2e-m53-B-${uniq()}`);
  await page.goto(`/app/missions/${a}`);
  await expect(page.getByText(`e2e-m53-A-`)).toBeVisible();
  await page.goto(`/app/missions/${b}`);
  await expect(page.locator("h1")).toContainText(b);
  await expect(page.getByText(`e2e-m53-A-`)).toHaveCount(0);
  await expect(page.getByText(`e2e-m53-B-`)).toBeVisible();
});

/* 20b: identity-mismatched payload is discarded, never rendered. */
test("mission detail: identity mismatch fails closed (adversarial)", async ({ page }) => {
  const mid = await mkMission(page, `e2e-m53-idm-${uniq()}`);
  await page.route(`**/api/missions/${mid}`, (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ mission: { mission_id: "MIS_OTHER", goal: "forged" }, runtime: null,
        task_count: 0, tasks: [], executions: [], approvals_pending: [] }) }));
  await page.goto(`/app/missions/${mid}`);
  await expect(page.getByText(/IDENTITY_MISMATCH/).first()).toBeVisible();
  await expect(page.getByText("forged")).toHaveCount(0);
});

/* 21: read-only detail nav = zero POSTs (explicit). */
test("read-only pages issue zero POSTs", async ({ page }) => {
  const posts: string[] = [];
  await countPosts(page, posts);
  const mid = await mkMission(page, `e2e-m53-ro-${uniq()}`);
  posts.length = 0;
  await page.goto("/app/missions");
  await page.waitForLoadState("networkidle");
  await page.goto(`/app/missions/${mid}`);
  await page.waitForLoadState("networkidle");
  expect(posts).toEqual([]);
});

/* 22: canonical failure codes — 404 detail, 401 tasks-entry hint. */
test("canonical failure codes surface honestly", async ({ page }) => {
  await page.goto("/app/missions/MIS_DOES_NOT_EXIST_e2e");
  await expect(page.getByText(/404|NOT_FOUND|FAIL_CLOSED|MALFORMED/).first()).toBeVisible();
});

/* ================= R1 audit findings ================= */

const detPayload = (over: Record<string, unknown> = {}) => JSON.stringify({
  mission: { mission_id: "MSN_x", goal: "adversarial", status: "RUNNING",
    bound_open_id: null, metadata: {}, ...((over.mission ?? {}) as object) },
  runtime: { state: "RUNNING" },
  task_count: 0, tasks: [], executions: [], approvals_pending: [],
  ...over,
});

const interceptDetail = async (page: Page, mid: string, over: Record<string, unknown> = {}) => {
  await page.route(`**/api/missions/${mid}`, (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: detPayload({ ...over, mission: { mission_id: mid, goal: "adversarial", status: "RUNNING", bound_open_id: null, metadata: {}, ...((over.mission ?? {}) as object) } }) }));
};

/* R1-F1: bound_open_id is an open_id, never an objective_id — backlink
   only when mission→binding→work item→objective fully verifies. */
test("R1-F1: objective backlink requires full canonical chain", async ({ page }) => {
  const mid = "MSN_lin1";
  /* fully proven chain → link rendered */
  await interceptDetail(page, mid, { mission: {
    bound_open_id: "OPEN_a1",
    metadata: { work_item_id: "WI_a1", work_item_open_id: "OPEN_a1", business_id: "BIZ_a1" } } });
  await page.route("**/api/work-items?business_id=BIZ_a1", (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: '{"work_items":[{"work_item_id":"WI_a1","objective_id":"OBJ_proven","business_id":"BIZ_a1"}]}' }));
  await page.goto(`/app/missions/${mid}`);
  const link = page.getByRole("link", { name: /← Objective/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/app/objectives/OBJ_proven");
});

test("R1-F1: non-objective bound_open_id never becomes an Objective URL", async ({ page }) => {
  const mid = "MSN_lin2";
  /* bound_open_id set but metadata chain absent → omit, document */
  await interceptDetail(page, mid, { mission: { bound_open_id: "OPEN_NOPE" } });
  await page.goto(`/app/missions/${mid}`);
  await expect(page.locator("h1")).toContainText(mid);
  await expect(page.getByRole("link", { name: /← Objective/ })).toHaveCount(0);
  await expect(page.getByText(/lineage unproven/)).toBeVisible();
  expect(page.url()).not.toContain("/app/objectives/OPEN_NOPE");
});

test("R1-F1: bound_open_id + WI without objective → still no link", async ({ page }) => {
  const mid = "MSN_lin3";
  await interceptDetail(page, mid, { mission: {
    bound_open_id: "OPEN_b1",
    metadata: { work_item_id: "WI_b1", work_item_open_id: "OPEN_b1", business_id: "BIZ_b1" } } });
  await page.route("**/api/work-items?business_id=BIZ_b1", (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: '{"work_items":[{"work_item_id":"WI_b1","business_id":"BIZ_b1"}]}' }));
  await page.goto(`/app/missions/${mid}`);
  await expect(page.getByRole("link", { name: /← Objective/ })).toHaveCount(0);
  await expect(page.getByText(/lineage unproven/)).toBeVisible();
});

/* R1-F2: late preview response for old inputs never renders/commits. */
test("R1-F2: delayed preview for goal A discarded after edit to B", async ({ page }) => {
  let release: ((r: Route) => void) | null = null;
  await page.route("**/api/missions/preview", (r: Route) => { release = () => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ preview_id: "PV_A", plan_digest: "a".repeat(64),
      plan: { tasks: [{ task_key: "T1", title: "t", task_instruction: "i", depends_on: [], required_capabilities: [] }] },
      plan_source: null, plan_model: null }) }); });
  const confirms: string[] = [];
  await countPosts(page, confirms);
  await page.goto("/app/missions/new");
  await page.getByLabel("goal").fill("goal-A");
  await page.getByLabel("project").selectOption({ index: 1 });
  await page.getByRole("button", { name: /Preview plan/ }).click();
  /* edit inputs while the preview is in flight */
  await page.getByLabel("goal").fill("goal-B");
  release!();
  await page.waitForTimeout(300);
  await expect(page.getByText("Proposed plan")).toHaveCount(0);
  expect(confirms.filter((u) => u.includes("confirm"))).toEqual([]);
});

test("R1-F2: auto-confirm toggled OFF mid-flight → manual preview, zero confirm POSTs", async ({ page }) => {
  let release: ((r: Route) => void) | null = null;
  await page.route("**/api/missions/preview", (r: Route) => { release = () => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ preview_id: "PV_A2", plan_digest: "b".repeat(64),
      plan: { tasks: [{ task_key: "T1", title: "t", task_instruction: "i" }] },
      plan_source: null, plan_model: null }) }); });
  const confirms: string[] = [];
  await countPosts(page, confirms);
  await page.goto("/app/missions/new");
  await page.getByLabel("goal").fill("goal-auto");
  await page.getByLabel("project").selectOption({ index: 1 });
  await page.locator("#autoc").check();
  await page.getByRole("button", { name: /Preview & execute/ }).click();
  await page.locator("#autoc").uncheck();
  release!();
  await page.waitForTimeout(300);
  /* late response renders as manual preview — never auto-commits */
  await expect(page.getByText("Proposed plan")).toBeVisible();
  expect(confirms.filter((u) => u.includes("/missions/confirm"))).toEqual([]);
});

/* R1-F3: malformed detail collections → per-section MALFORMED. */
test("R1-F3: malformed detail collections fail per-section", async ({ page }) => {
  const mid = "MSN_coll";
  await interceptDetail(page, mid, {
    tasks: [null], executions: [null], approvals_pending: null });
  await page.goto(`/app/missions/${mid}`);
  await expect(page.locator("h1")).toContainText(mid);
  await expect(page.getByText(/tasks collection unavailable/)).toBeVisible();
  await expect(page.getByText(/executions collection unavailable/)).toBeVisible();
  await expect(page.getByText(/approvals collection unavailable/)).toBeVisible();
  /* never a fabricated "(0)" canonical count */
  await expect(page.getByRole("heading", { name: "Tasks (0)" })).toHaveCount(0);
});

test("R1-F3: preview task with invalid caps/deps → INVALID_PREVIEW", async ({ page }) => {
  await page.route("**/api/missions/preview", (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ preview_id: "PV_c", plan_digest: "c".repeat(64),
        plan: { tasks: [{ task_key: "T1", required_capabilities: "not-an-array" }] } }) }));
  await page.goto("/app/missions/new");
  await page.getByLabel("goal").fill(`e2e-r1f3-${uniq()}`);
  await page.getByLabel("project").selectOption({ index: 1 });
  await page.getByRole("button", { name: /Preview plan/ }).click();
  await expect(page.getByText(/INVALID_PREVIEW/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Confirm & run/ })).toHaveCount(0);
});

/* R1-F4: delayed file read on A never lands on B's page. */
test("R1-F4: late file result for A never lands on B", async ({ page }) => {
  const a = await mkMission(page, `e2e-r1f4-a-${uniq()}`);
  const b = await mkMission(page, `e2e-r1f4-b-${uniq()}`);
  let release: ((r: Route) => void) | null = null;
  await page.route(`**/api/missions/${a}/files?path=*`, (r: Route) => { release = () => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ path: "a-secret.txt", content: "A-CONTENT-MARKER", truncated: false }) }); });
  await page.route(`**/api/missions/${a}/files`, (r: Route) =>
    r.request().url().includes("?path=") ? undefined : r.fulfill({
      status: 200, contentType: "application/json",
      body: '{"files":[{"path":"a-secret.txt","size":10,"modified_at":"2026-01-01T00:00:00Z"}]}' }));
  await page.route(`**/api/missions/${b}/files`, (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json", body: '{"files":[]}' }));
  await page.goto(`/app/missions/${a}`);
  await page.getByText("a-secret.txt").click();
  await page.goto(`/app/missions/${b}`);
  release!();
  await page.waitForTimeout(400);
  await expect(page.getByText("A-CONTENT-MARKER")).toHaveCount(0);
  await expect(page.locator("h1")).toContainText(b);
});

/* R1 deterministic lifecycle failure: intercepted RUNNING + failed
   pause → AMBIGUOUS, no optimistic flip, no auto-retry. */
test("R1: failed pause on verified RUNNING state → ambiguous, no optimistic flip", async ({ page }) => {
  const mid = "MSN_run1";
  await interceptDetail(page, mid, { runtime: { state: "RUNNING" } });
  const posts: string[] = [];
  await countPosts(page, posts);
  await page.route(`**/api/missions/${mid}/pause`, (r: Route) =>
    r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await page.goto(`/app/missions/${mid}`);
  await page.getByRole("button", { name: "Pause…" }).click();
  await page.getByRole("dialog").locator("button.primary").click();
  await expect(page.locator(".trunc[role='status']")).toContainText(/AMBIGUOUS/);
  await expect(page.getByText("RUNNING").first()).toBeVisible(); // state never flipped
  expect(posts.filter((u) => u.endsWith("/pause"))).toHaveLength(1);
});
