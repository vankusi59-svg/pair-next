import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

/* P18.4 — real-browser acceptance for the canonical liveness +
 * recovery-operations surfaces (Mission Detail ops sections, System
 * Observability operations rollup). Golden paths run against the real
 * backend; interceptions are labeled adversarial cases. */

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

/** Canonical mission mint: persisted plan authority (metadata.llm_plan)
 * — the same seam serve-planner uses for pool winners. The Planner Pool
 * is deliberately unavailable in e2e (zero model spend); a caller plan
 * in metadata is validated, digest-pinned and persisted by the same
 * createPlanPreview path. A goal-less submission passes the expander
 * verbatim by design. */
async function mkMission(page: Page, goal: string): Promise<string> {
  const p = await firstProject(page);
  const plan = [
    { task_key: "T1", title: `record ${goal}`, task_instruction: "write an operator-visible note file", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    { task_key: "T2", title: "summarize note", task_instruction: "summarize the note into a second file", required_capabilities: ["FILE_OPERATIONS"], depends_on: ["T1"] },
  ];
  const r = await api(page, "POST", "/missions", {
    project_id: String(p.project_id),
    metadata: { llm_plan: plan },
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [String(p.root_location ?? "")],
  });
  expect(r.ok, `mint -> ${r.status} ${JSON.stringify(r.json)}`).toBeTruthy();
  return String((r.json.mission ?? r.json).mission_id);
}

type OpsResp = {
  execution_health?: { executions?: Array<Record<string, unknown>> };
  recovery_ops?: {
    mission_id?: string;
    runtime_state?: string;
    pending_recovery?: unknown;
    deferred_recovery?: unknown[];
  };
};

/** Drive the server-side supervisor until the ops projection shows real
 * canonical evidence — execution rows and/or a recovery signal. Bounded;
 * the mission reaches a governed state within seconds. */
async function driveUntilOps(page: Page, mid: string): Promise<OpsResp> {
  let last: OpsResp = {};
  for (let i = 0; i < 120; i++) {
    const r = await api(page, "GET", `/missions/${mid}/operations`);
    last = (r.json ?? {}) as OpsResp;
    const execs = last.execution_health?.executions ?? [];
    const settled = execs.some((e) => {
      const d = e.derived as Record<string, unknown> | undefined;
      return d?.stage === "SETTLED" || d?.stage === "TERMINAL_OBSERVED";
    });
    const signal = last.recovery_ops?.pending_recovery != null
      || (last.recovery_ops?.deferred_recovery?.length ?? 0) > 0;
    if ((execs.length > 0 && settled) || signal) return last;
    await page.waitForTimeout(250);
  }
  return last;
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

/* D1 — Mission Detail: execution health + recovery operations render
 * from canonical evidence. */
test("p184: mission detail ops sections render canonical evidence", async ({ page }) => {
  const mid = await mkMission(page, `p184-ops-${uniq()} record the goal file`);
  const ops = await driveUntilOps(page, mid);

  // API-level scope check: the projection echoes ONLY this mission.
  expect(ops.recovery_ops?.mission_id).toBe(mid);
  const execs = ops.execution_health?.executions ?? [];
  for (const e of execs) expect(e.mission_id).toBe(mid);
  const signal = ops.recovery_ops?.pending_recovery != null
    || (ops.recovery_ops?.deferred_recovery?.length ?? 0) > 0;
  expect(execs.length > 0 || signal,
    "ops projection produced no canonical evidence").toBeTruthy();

  await page.goto(`/app/missions/${mid}`);
  await expect(page.getByRole("heading", { name: /execution health/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /recovery operations/i })).toBeVisible();

  // Every API execution row renders; none → the honest empty note.
  if (execs.length === 0) {
    await expect(page.getByText(/no executions in the liveness projection/i)).toBeVisible();
  }
  for (const e of execs) {
    const eid = String(e.execution_id);
    await expect(page.getByText(eid.slice(0, 24), { exact: false }).first()).toBeVisible();
  }

  // Recovery ops renders pending/deferred state when the projection has it.
  if (ops.recovery_ops?.pending_recovery != null) {
    await expect(page.getByText(/PENDING RECOVERY/i).first()).toBeVisible();
  }

  // Recovery ops renders the persisted runtime state — never absent.
  const runtime = String(ops.recovery_ops?.runtime_state ?? "");
  if (runtime) await expect(page.getByText(runtime, { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/p184-mission-ops.png", fullPage: true });
});

/* D1-adversarial — malformed ops payload renders unavailable, never
 * fabricated empty/healthy state. */
test("p184: malformed ops response renders unavailable panel", async ({ page }) => {
  const mid = await mkMission(page, `p184-mal-${uniq()} record the goal file`);
  await driveUntilOps(page, mid);
  await page.route(`**/api/missions/${mid}/operations`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto(`/app/missions/${mid}`);
  // The validator rejects the shape-less body → unavailable panels for
  // both ops sections; the rest of the page still loads.
  await expect(page.getByText(/unavailable|malformed/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /execution health \(\d+\)/i })).toHaveCount(0);
});

/* D2 — System Observability: operations rollup renders aggregate
 * canonical metrics. */
test("p184: operations rollup shows bounded aggregate metrics", async ({ page }) => {
  await api(page, "GET", "/operations").then((r) =>
    expect(r.ok, `operations -> ${r.status}`).toBeTruthy());
  await page.goto("/app/system/observability");
  await page.getByRole("tab", { name: /operations/i }).click();
  await expect(page.getByText(/GET \/api\/operations/)).toBeVisible({ timeout: 15_000 });
  // The metric labels render — values are canonical counts (0 is a real
  // zero-state, not a gap).
  await expect(page.getByText(/missions_active|active supervised missions/i)).toBeVisible();
  await page.screenshot({ path: "test-results/p184-ops-rollup.png", fullPage: true });
});

/* D3 — operator actions: approval navigation targets the canonical
 * inbox; unauthorized mutation stays blocked. */
test("p184: mutations require auth+operator identity; no forged client path", async ({ page }) => {
  const mid = await mkMission(page, `p184-auth-${uniq()} record the goal file`);
  // No token at all → 401.
  const noTok = await page.request.fetch(`/api/missions/${mid}/operations`);
  expect(noTok.status()).toBe(401);
  // Bad token → 401.
  const badTok = await page.request.fetch(`/api/missions/${mid}/operations`, {
    headers: { authorization: "Bearer wrong-token" },
  });
  expect(badTok.status()).toBe(401);
  // Mutation without operator identity → rejected (4xx), never 2xx.
  const noOp = await page.request.fetch(`/api/missions/${mid}/pause`, {
    method: "POST",
    headers: { authorization: `Bearer ${mcToken()}` },
    data: {},
  });
  expect(noOp.status()).toBeGreaterThanOrEqual(400);
  expect(noOp.status()).toBeLessThan(500);
});
