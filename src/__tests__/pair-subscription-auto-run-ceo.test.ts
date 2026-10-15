/**
 * PR #121 — Subscription-Only Auto Run CEO: focused regressions.
 *
 * Z1 zero-API-budget contract — budget_microusd_cap: 0 is a valid
 *    explicit hard zero-spend policy; invalid values stay rejected.
 * Z2 autonomous supply projection — the driver's dispatch-cost bound
 *    derives pairings from canonical Executor/Route/Binding state,
 *    restricted to the AUTONOMOUS_EXECUTOR_IDS allowlist (CODEX +
 *    PAIR_NATIVE). Disabled/unqualified executors and unrelated or
 *    historical routes never poison the envelope; DEVIN/DSH can never
 *    enter it, even ENABLED via the dashboard.
 * Z3 provable cost binding — CODEX requires an ACTIVE SUBSCRIPTION
 *    profile plus provider auth_state AUTH_OK (subscription-session
 *    evidence); PAIR_NATIVE uses UNMETERED. UNKNOWN/unbounded/metered-
 *    contradictory bindings fail closed.
 * Z4 autonomous dispatch boundary — a driver-attributed mission
 *    (work_open_binding.created_by = DRIVER_ACTOR) can only reserve
 *    through the autonomous executor set inside assertAndReserve's
 *    atomic transaction; under a zero policy its billing identity must
 *    be provably non-metered. Manual missions keep existing semantics.
 * Z5 readiness codes — truthful owner-scoped distinction:
 *    DRIVER_DISABLED / POLICY_NOT_EFFECTIVE / OBJECTIVE_ZERO_BUDGET /
 *    SUBSCRIPTION_AUTH_UNVERIFIED / EXECUTOR_UNAVAILABLE /
 *    COST_BINDING_UNVERIFIED / METERED_ROUTE_FORBIDDEN /
 *    BUDGET_EXHAUSTED / READY, re-derived from live canonical state.
 * Z6 lifecycle — pause/revoke/global-halt stay fail-closed under the
 *    zero-spend contract; replay never double-reserves.
 * Z7 E2E — production-composition pass: durable wake → scheduler
 *    claim → driver admission → real runObjectivePass with a
 *    CodexCliCeoDecisionInvoker over a controlled fake codex CLI →
 *    real admitPlannerInvocation + codexPlannerPlan over the SAME fake
 *    CLI → governed dispatch through the real gate + the REAL
 *    CodexCliExecutorAdapter (ambient metered keys in its env reader —
 *    proves the F1 boundary end-to-end) → executor terminal
 *    collection via gate.collect_execution_result → scheduler settle.
 *    Boundary actually exercised: admission → CEO → planner →
 *    governed dispatch → execution terminal + reservation settlement.
 *    No external paid API calls (global fetch rejects).
 * Z8 AUDIT R1 corrections — F1: real CodexCliExecutorAdapter child env
 *    carries no OPENAI_API_KEY/CODEX_API_KEY on driver-attributed
 *    (autonomous) dispatch; manual dispatch semantics preserved.
 *    F2: metered/unknown/unbounded autonomous dispatch denied under
 *    absent, zero AND positive caps. F3: driver-attributed CODEX
 *    reserves require ACTIVE SUBSCRIPTION profile + AUTH_OK session —
 *    UNMETERED/FREE/missing profile/broken session denied at the
 *    atomic gate; proven COMMITTED history still adopted. F4: CEO
 *    subscription authorization proven independently of executor
 *    supply — PAIR_NATIVE-only fleets still need the Codex session.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTONOMOUS_EXECUTOR_IDS,
  beginPlannerRun,
  BusinessLayer,
  canonicalModelId,
  CEO_DECISION_ATTEMPT_ENTITY,
  CodexCliCeoDecisionInvoker,
  CodexCliExecutorAdapter,
  codexPlannerPlan,
  codexRunRoot,
  CODEX_CLI_PROVIDER_ID,
  CODEX_EXECUTOR_ID,
  CostService,
  createDefaultObjectiveOperatingService,
  DEVIN_EXECUTOR_ID,
  DRIVER_ACTOR,
  DSH_EXECUTOR_ID,
  ensureCodexCliCatalog,
  ExecutorRegistry,
  finishPlannerRun,
  GovernedTaskGate,
  IntegrityError,
  MissionRouter,
  ApprovalQueue,
  MissionControl,
  MissionObservability,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ReconciliationService,
  RecoveryController,
  SCHEDULER_RECEIPT,
  ModelEvidenceCatalog,
  ObjectiveAutoDriverService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveWorkstreamService,
  PAIR_NATIVE_EXECUTOR_ID,
  PAIR_NATIVE_ROUTE_ID,
  PairControlPlane,
  PairEvidenceStore,
  PolicyError,
  ProviderCatalog,
  providerEntryId,
  qualifyModel,
  registerGovernedExecutors,
  runPlannerFailover,
  assertCodexCliPlannerTransport,
  WorkforceAllocationService,
  WorkforceService,
  WORKFORCE_ALLOCATION_ENTITY,
  type ExecutorAdapter,
  type PlannerCandidate,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-sub-auto-ceo-"));
const OP = "1882810918";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;
const code = (e: unknown) => String((e as { code?: string })?.code ?? "");

function throwsCode(fn: () => unknown, want: string | RegExp) {
  try {
    fn();
  } catch (e) {
    const c = code(e);
    if (typeof want === "string") expect(c).toBe(want);
    else expect(c).toMatch(want);
    return;
  }
  expect.unreachable(`expected throw ${String(want)}`);
}

/* ============================ harness ============================ */

type Row = Record<string, unknown> & { version: number };

function fresh(name: string, initial = 1_000_000) {
  let t = initial;
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const service = new PairControlPlane(store);
  const biz = new BusinessLayer({
    store,
    control: { projects: () => [{ project_id: "PRJ_TEST" }] } as never,
    schedules: {} as never,
  });
  const wf = new WorkforceService({ store, business: biz });
  const objectives = biz.objectives;
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives, workstreams });
  const policy = new ObjectiveAutoPolicyService(store, objectives, () => t);
  const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, () => t);
  const wakeup = new ObjectiveAutoWakeupService(store, scheduler, () => t);
  const cost = new CostService({ store } as never);
  const bid = `BIZ_${counter}`;
  store.put("business", bid, {
    business_id: bid, name: "b", status: "ACTIVE",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  return { dir, workspace, dbPath, store, service, biz, wf, objectives,
    workstreams, alloc, policy, scheduler, wakeup, cost, bid,
    now: () => t, setNow: (v: number) => { t = v; } };
}
type S = ReturnType<typeof fresh>;
let objSeq = 0;

function mkObjective(s: S, budgetCeiling = 500_000_000) {
  const o = s.objectives.create({
    business_id: s.bid, title: "Sell", statement: "s",
    kpis: [{ name: "sales", unit: "u", baseline: 0, target: 10 }],
    deadline: FUTURE, budget_ceiling_microusd: budgetCeiling,
    operator_id: OP, dedup_key: `z-${counter}-${++objSeq}`,
  });
  return String(o.objective_id);
}

const LIMITS = (extra: Record<string, unknown> = {}) =>
  ({ expires_at: FUTURE, max_ceo_calls: 10, ...extra });

function configure(s: S, oid: string, limits: Record<string, unknown>) {
  return s.policy.control({ objective_id: oid, actor: OWNER,
    action: "configure", limits, idempotency_key: `cfg-${counter}-${Math.random()}` });
}
function enable(s: S, oid: string, extra: Record<string, unknown> = {}) {
  configure(s, oid, LIMITS(extra));
  s.policy.control({ objective_id: oid, actor: OWNER,
    action: "enable", policy_version: 1,
    idempotency_key: `en-${counter}-${Math.random()}` });
  s.wakeup.tick();
}

/* ---------- canonical executor/route/binding supply ---------- */

class RecordingAdapter implements ExecutorAdapter {
  dispatched: Array<Record<string, unknown>> = [];
  constructor(
    public readonly executor_id: string,
    private readonly caps: string[] = ["FILE_OPERATIONS"],
    private readonly qualified = true,
  ) {}
  probe() { return { executor_id: this.executor_id, available: true, state: "READY" }; }
  qualify() {
    return this.qualified
      ? { qualified: true, dispatch_enabled: true }
      : { qualified: false, dispatch_enabled: false, reasons: ["unqualified"] };
  }
  capabilities() { return { capability_ids: this.caps }; }
  prepare_task(task: Record<string, unknown>) { return task; }
  dispatch(task: Record<string, unknown>) {
    const eid = `EXEC_${this.executor_id}_${this.dispatched.length}`;
    this.dispatched.push({ execution_id: eid, task });
    return { execution_id: eid, status: "RUNNING", run_root: null, workspace: task.workspace };
  }
  observe() { return { status: "RUNNING" }; }
  cancel() { return { status: "CANCELLED" }; }
  collect_result(executionId: string) {
    return { execution_id: executionId, artifacts: [], status: "COMPLETED", summary: "ok" };
  }
  collect_artifacts() { return []; }
  health() { return { state: "READY" }; }
}

/** Production seam: qualified adapters mint executor row + route +
 *  QUALIFIED binding; PAIR_NATIVE registers + seeds its canonical
 *  route/binding. Mirrors scripts/serve-mission-control.mjs. */
function seedExecutorSupply(
  s: S,
  ids: string[] = [CODEX_EXECUTOR_ID, PAIR_NATIVE_EXECUTOR_ID],
  opts: { default_disabled?: string[] } = {},
): Map<string, RecordingAdapter> {
  const governed = ids.filter((i) => i !== PAIR_NATIVE_EXECUTOR_ID);
  const adapters = new Map<string, RecordingAdapter>();
  for (const id of governed) adapters.set(id, new RecordingAdapter(id));
  if (governed.length) {
    registerGovernedExecutors(s.service, adapters, "TEST", {
      default_disabled: opts.default_disabled,
    });
  }
  if (ids.includes(PAIR_NATIVE_EXECUTOR_ID)) {
    const registry = new ExecutorRegistry(s.service);
    registry.register({
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      executor_type: "AUTOMATON_WORKER",
      capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
      health_state: "READY",
      status:
        String(s.store.tryGet("executor", PAIR_NATIVE_EXECUTOR_ID)?.status ?? "") ||
        (opts.default_disabled?.includes(PAIR_NATIVE_EXECUTOR_ID) ? "DISABLED" : "ENABLED"),
      metadata: {
        qualification_state: "QUALIFIED",
        permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
      },
    });
    s.service.routes.seedPairNativeRoute("TEST");
  }
  return adapters;
}

/** Canonical codex-cli provider AUTH_OK — the subscription-session
 *  evidence the autonomous binding requires (real probe outcome in
 *  production; seeded through the canonical row here). */
function seedCodexAuth(s: S, authState = "AUTH_OK") {
  ensureCodexCliCatalog(s.store, "gpt-6.1-sol", "TEST");
  const pid = providerEntryId(CODEX_CLI_PROVIDER_ID);
  const p = s.store.get("provider", pid) as Row;
  s.store.put("provider", pid, {
    ...p, lifecycle_state: "QUALIFIED", auth_state: authState,
    health_state: "READY", probe_state: "PROBED", conditions: [],
  }, Number(p.version));
}

/** P13 canonical billing declaration — the production opt-in seed:
 *  codex-cli's ChatGPT subscription billed as SUBSCRIPTION. */
function seedCodexSubscription(s: S, mode = "SUBSCRIPTION") {
  s.cost.upsertCostProfile(
    { ref_type: "executor", ref_id: CODEX_EXECUTOR_ID, billing_mode: mode }, "TEST");
}

function mkDriver(s: S, extra: Record<string, unknown> = {}) {
  return new ObjectiveAutoDriverService({
    store: s.store, objectives: s.objectives, policy: s.policy,
    scheduler: s.scheduler,
    runPass: async () => ({ outcome: "WAITING" }) as never,
    executors: [...AUTONOMOUS_EXECUTOR_IDS],
    billingFor: (e: string, r: string | null) => s.cost.billingFor(e, r),
    costHaltActive: () => false,
    workerId: "z-w", bootId: "z-b",
    now: s.now, heartbeatMs: 0, ceoTimeoutMs: 300_000,
    ...extra,
  });
}

/** Canonical driver-attributed mission lineage — mirrors the r3
 *  harness: allocation → work_open_binding(created_by=DRIVER_ACTOR)
 *  → mission row bound to it. */
function driverMission(s: S, oid: string, tag: string) {
  const o = s.objectives.get(oid);
  if (!(s.store.list("workstream_binding") as Array<Record<string, unknown>>)
      .some((b) => String(b.objective_id) === oid)) {
    s.workstreams.decomposeObjective({
      objective_id: oid,
      expected_objective_version: Number(o.version),
      expected_terms_version: Number(o.terms_version),
      expected_objective_digest: String(o.objective_digest),
      workstreams: [{ workstream_key: "w1", title: "t", goal: "g" }],
      actor: OP,
    });
    s.biz.createOrgAgent({
      business_id: s.bid, title: `agent ${counter}`,
      department: "ops", operator_id: OP,
    });
  }
  s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: "w1", actor: OP });
  const allocRow = (s.store.list("workforce_allocation") as Array<Record<string, unknown>>)
    .filter((a) => String(a.objective_id) === oid).at(-1)!;
  const workItemId = String(allocRow.delegated_child_work_item_id ??
    allocRow.workstream_work_item_id);
  const openId = `OPEN_${tag}_${counter}`;
  const mid = `MIS_${tag}_${counter}`;
  s.store.put("work_open_binding", openId, {
    open_id: openId, work_item_id: workItemId, mission_id: mid,
    created_by: DRIVER_ACTOR,
  }, 0);
  s.store.put("mission", mid, {
    mission_id: mid, bound_open_id: openId, metadata: {},
    state: "RUNNING", business_id: s.bid, created_at: "x", updated_at: "x",
  }, 0);
  return { missionId: mid, openId, workItemId };
}

function reserve(s: S, m: { missionId: string }, taskId: string,
  routeId: string | null, executorId: string) {
  const mission = s.store.get("mission", m.missionId) as Record<string, unknown>;
  return s.cost.assertAndReserve({
    mission,
    task: { task_id: taskId, selected_route_id: routeId },
    governedTask: { governed_task_id: `GT_${taskId}`, task_id: taskId },
    executorId,
  });
}

/* ---------- fake codex CLI (controlled child process) ---------- */

const FAKE_CODEX_JS = `const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
// The real executor probe runs --version with no stdin — answer and exit
// before waiting on the prompt stream.
if (argv.includes("--version")) { process.stdout.write("fake-codex 9.9.9-test\\n"); process.exit(0); }
const outIdx = argv.indexOf("--output-last-message");
const out = outIdx >= 0 ? argv[outIdx + 1] : null;
const b = process.env.FAKE_CODEX_BEHAVIOR || "ceo_init";
// Governed EXECUTOR dispatches carry the pair_workspace/pair_read
// permission profile; CEO (pair_ceo) and planner (pair_planner) carry
// their own. The real CodexCliExecutorAdapter never forwards FAKE_*
// child-env controls, so executor mode is argv-derived and the child env
// is dumped next to the output file (visible to the test via the run
// root) rather than through a FAKE_CODEX_* channel.
const joined = argv.join(" ");
const isExec = joined.includes("default_permissions=pair_workspace") ||
  joined.includes("default_permissions=pair_read");
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const log = process.env.FAKE_CODEX_INVOKELOG;
  if (log) fs.appendFileSync(log, argv.join(" ") + "\\n");
  const envDump = JSON.stringify({
    CODEX_HOME: process.env.CODEX_HOME != null,
    CODEX_API_KEY: process.env.CODEX_API_KEY != null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY != null,
  });
  const envFile = process.env.FAKE_CODEX_ENVFILE;
  if (envFile) fs.writeFileSync(envFile, envDump);
  if (out) fs.writeFileSync(out + ".env.json", envDump);
  if (b === "authfail") { process.stderr.write("error: 401 unauthorized\\n"); process.exit(1); }
  if (b === "ratelimit") { process.stderr.write("error: 429 rate limit exceeded\\n"); process.exit(1); }
  if (!out) { process.stderr.write("missing --output-last-message\\n"); process.exit(1); }
  if (isExec) {
    fs.writeFileSync(out, JSON.stringify({
      status: "COMPLETED", summary: "fake exec done", artifacts: [],
    }));
    process.exit(0);
  }
  if (b === "plan") {
    fs.writeFileSync(out, JSON.stringify({ tasks: [
      { task_key: "T1", title: "work", task_instruction: "do work",
        required_capabilities: ["FILE_OPERATIONS"], depends_on: [] },
    ]}));
    process.exit(0);
  }
  fs.writeFileSync(out, JSON.stringify({
    schema: "pair.ceo-decision.v1", decision_kind: "INITIALIZE_WORKSTREAMS",
    workstreams: [{ workstream_key: "w1", title: "T", goal: "G", depends_on_keys: null }],
    priority_order: ["w1"], wait_reason: null, summary: "init",
  }));
  process.exit(0);
});
`;

/** Spawnable fake codex on every platform: a .cmd COMSPEC shim on
 *  win32 (windowsSpawnTarget contract), a posix shell wrapper else.
 *  Both exec node over the same .cjs body. */
function makeFakeCodex(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, "fake-codex.cjs");
  fs.writeFileSync(js, FAKE_CODEX_JS);
  if (process.platform === "win32") {
    const cmd = path.join(dir, "fake-codex.cmd");
    fs.writeFileSync(cmd, `@echo off\r\nnode "${js.replace(/\//g, "\\")}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, "fake-codex.sh");
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "${js}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

/* ============================ Z1 — zero cap ============================ */

describe("Z1 — zero-API-budget policy contract", () => {
  it("Z1.1 budget_microusd_cap: 0 configures + enables (explicit zero-spend)", () => {
    const s = fresh("z1a");
    const oid = mkObjective(s);
    configure(s, oid, { expires_at: FUTURE, budget_microusd_cap: 0 });
    s.policy.control({ objective_id: oid, actor: OWNER, action: "enable",
      policy_version: 1, idempotency_key: `en-${counter}` });
    const st = s.policy.evaluate(oid);
    expect(st.effective).toBe(true);
    expect((st.limits as { budget_microusd_cap?: number }).budget_microusd_cap).toBe(0);
  });

  it("Z1.2 cap 0 alone satisfies the at-least-one-cap requirement", () => {
    const s = fresh("z1b");
    const oid = mkObjective(s);
    // No max_ceo_calls/max_missions — the zero budget cap is itself a cap.
    expect(() => configure(s, oid, { expires_at: FUTURE, budget_microusd_cap: 0 }))
      .not.toThrow();
  });

  it("Z1.3 negative / fractional / malformed budget caps stay rejected", () => {
    const s = fresh("z1c");
    const oid = mkObjective(s);
    for (const bad of [-1, -1000, 0.5, 1.5, "0", "abc"]) {
      throwsCode(
        () => configure(s, oid, { expires_at: FUTURE, budget_microusd_cap: bad }),
        "FAIL_CLOSED_POLICY_LIMITS");
    }
    // NaN/Infinity can never reach the limits assertion: canonical
    // digest() rejects non-finite numbers up front — still fail-closed.
    for (const bad of [NaN, Infinity]) {
      expect(() => configure(s, oid, { expires_at: FUTURE, budget_microusd_cap: bad }))
        .toThrow();
    }
  });

  it("Z1.4 other caps still reject 0 and non-integers", () => {
    const s = fresh("z1d");
    const oid = mkObjective(s);
    for (const k of ["max_ceo_calls", "max_missions", "max_retries"]) {
      throwsCode(
        () => configure(s, oid, { expires_at: FUTURE, [k]: 0 }),
        "FAIL_CLOSED_POLICY_LIMITS");
      throwsCode(
        () => configure(s, oid, { expires_at: FUTURE, [k]: 1.5 }),
        "FAIL_CLOSED_POLICY_LIMITS");
    }
  });
});

/* ============ Z2 — canonical autonomous supply projection ============ */

describe("Z2 — supply derived from canonical Executor/Route/Binding state", () => {
  it("Z2.1 AUTONOMOUS_EXECUTOR_IDS is exactly CODEX + PAIR_NATIVE", () => {
    expect([...AUTONOMOUS_EXECUTOR_IDS].sort()).toEqual(
      [CODEX_EXECUTOR_ID, PAIR_NATIVE_EXECUTOR_ID].sort());
    expect(AUTONOMOUS_EXECUTOR_IDS).not.toContain(DEVIN_EXECUTOR_ID);
    expect(AUTONOMOUS_EXECUTOR_IDS).not.toContain(DSH_EXECUTOR_ID);
  });

  it("Z2.2 qualified supply + proven bindings → READY under cap 0", () => {
    const s = fresh("z2b");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0, max_missions: 5 });
    const driver = mkDriver(s);
    const r = driver.readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.objective_runnable).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("Z2.3 a metered route UNBOUND to autonomous executors cannot poison the envelope", () => {
    const s = fresh("z2c");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    // Historical/unrelated route — never bound to CODEX or PAIR_NATIVE.
    s.service.routes.registerRoute({
      route_id: "RTE_HIST_PAID", route_kind: "REMOTE_GATEWAY_API",
      enabled: true, eligibility_state: "QUALIFIED",
      qualification_state: "QUALIFIED", capabilities: [],
      capability_source: "ROUTE_EXPLICIT", priority: 10,
    }, "TEST");
    s.cost.upsertCostProfile({
      ref_type: "route", ref_id: "RTE_HIST_PAID",
      billing_mode: "METERED_API", reserve_microusd: 9_000_000,
    }, "TEST");
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toEqual([]);
    expect(r.objective_runnable).toBe(true);
  });

  it("Z2.4 DEVIN ENABLED + qualified + bound is still NEVER an autonomous pairing", () => {
    const s = fresh("z2d");
    const oid = mkObjective(s);
    // Full canonical DEVIN supply (dashboard ON) — metered route profile.
    seedExecutorSupply(s, [CODEX_EXECUTOR_ID, PAIR_NATIVE_EXECUTOR_ID, DEVIN_EXECUTOR_ID]);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    s.cost.upsertCostProfile({
      ref_type: "route", ref_id: "RTE_DEVIN_API",
      billing_mode: "METERED_API", reserve_microusd: 9_000_000,
    }, "TEST");
    enable(s, oid, { budget_microusd_cap: 0 });
    // Under the allowlist, DEVIN's reachable metered pairing never enters
    // the envelope — a Cartesian projection would trip BUDGET_EXHAUSTED
    // or METERED_ROUTE_FORBIDDEN here.
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toEqual([]);
    expect(r.objective_runnable).toBe(true);
  });

  it("Z2.5 disabled executor drops out — EXECUTOR_UNAVAILABLE when none remain", () => {
    const s = fresh("z2e");
    const oid = mkObjective(s);
    seedExecutorSupply(s, [CODEX_EXECUTOR_ID, PAIR_NATIVE_EXECUTOR_ID], {
      default_disabled: [CODEX_EXECUTOR_ID, PAIR_NATIVE_EXECUTOR_ID],
    });
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("EXECUTOR_UNAVAILABLE");
    expect(r.objective_runnable).toBe(false);
  });

  it("Z2.6 toggling the executor OFF mid-flight is re-derived — no stale snapshot", () => {
    const s = fresh("z2f");
    const oid = mkObjective(s);
    seedExecutorSupply(s, [CODEX_EXECUTOR_ID]);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const driver = mkDriver(s);
    expect((driver.readiness(oid, OWNER) as { reasons: string[] }).reasons).toEqual([]);
    // Operator disables the executor — the NEXT readiness re-derives.
    const reg = new ExecutorRegistry(s.service);
    reg.setExecutorEnabled(CODEX_EXECUTOR_ID, false, "TEST");
    const r = driver.readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("EXECUTOR_UNAVAILABLE");
  });
});

/* ============ Z3 — provable cost binding ============ */

describe("Z3 — subscription binding proof", () => {
  it("Z3.1 SUBSCRIPTION profile + AUTH_OK provider → provable $0 pairing", () => {
    const s = fresh("z3a");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    expect((mkDriver(s).readiness(oid, OWNER) as { reasons: string[] }).reasons)
      .toEqual([]);
  });

  it("Z3.2 SUBSCRIPTION profile WITHOUT session auth → SUBSCRIPTION_AUTH_UNVERIFIED", () => {
    const s = fresh("z3b");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s, "AUTH_REQUIRED"); // session never proven
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("SUBSCRIPTION_AUTH_UNVERIFIED");
    expect(r.objective_runnable).toBe(false);
  });

  it("Z3.3 absent codex profile → COST_BINDING_UNVERIFIED (never $0-by-default)", () => {
    const s = fresh("z3c");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    // No cost_profile — billingFor(CODEX) resolves UNKNOWN.
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("COST_BINDING_UNVERIFIED");
  });

  it("Z3.4 contradictory UNMETERED/FREE codex profile → binding unverified", () => {
    const s = fresh("z3d");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s, "UNMETERED"); // codex is the subscription transport
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("COST_BINDING_UNVERIFIED");
  });

  it("Z3.5 metered reachable pairing under cap 0 → METERED_ROUTE_FORBIDDEN", () => {
    const s = fresh("z3e");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    // Codex route itself metered — reaches the envelope via the QUALIFIED binding.
    s.cost.upsertCostProfile({
      ref_type: "route", ref_id: "RTE_CODEX_CLI",
      billing_mode: "METERED_API", reserve_microusd: 10_000,
    }, "TEST");
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("METERED_ROUTE_FORBIDDEN");
    expect(r.objective_runnable).toBe(false);
  });

  it("Z3.6 profile flipped to METERED_API after admission → next reserve is denied", () => {
    const s = fresh("z3f");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const m = driverMission(s, oid, "m1");
    // Baseline: subscription dispatch reserves $0.
    expect(() => reserve(s, m, "T1", null, CODEX_EXECUTOR_ID)).not.toThrow();
    // Profile drifts mid-flight — the SAME lineage re-resolves billing
    // inside the atomic reservation txn.
    const prof = s.store.list("cost_profile") as Array<Record<string, unknown>>;
    const cp = prof.find((p) => String(p.ref_id) === CODEX_EXECUTOR_ID)!;
    s.cost.upsertCostProfile({
      ref_type: "executor", ref_id: CODEX_EXECUTOR_ID,
      billing_mode: "METERED_API", reserve_microusd: 5_000,
    }, "TEST", Number(cp.version));
    throwsCode(
      () => reserve(s, m, "T2", null, CODEX_EXECUTOR_ID),
      /FAIL_CLOSED_COST_(AUTONOMOUS_METERED|OBJECTIVE_BUDGET_EXCEEDED)/);
  });
});

/* ============ Z4 — autonomous dispatch boundary ============ */

describe("Z4 — driver-attributed dispatches only via the autonomous set", () => {
  it("Z4.1 driver-opened mission reserving through DEVIN → denied even ENABLED", () => {
    const s = fresh("z4a");
    const oid = mkObjective(s);
    seedExecutorSupply(s, [CODEX_EXECUTOR_ID, PAIR_NATIVE_EXECUTOR_ID, DEVIN_EXECUTOR_ID]);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    s.cost.upsertCostProfile({
      ref_type: "executor", ref_id: DEVIN_EXECUTOR_ID,
      billing_mode: "FREE",
    }, "TEST");
    const m = driverMission(s, oid, "d1");
    throwsCode(
      () => reserve(s, m, "T1", null, DEVIN_EXECUTOR_ID),
      "FAIL_CLOSED_COST_AUTONOMOUS_EXECUTOR");
  });

  it("Z4.2 driver-opened mission reserving through DSH → denied", () => {
    const s = fresh("z4b");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    s.cost.upsertCostProfile({
      ref_type: "executor", ref_id: DSH_EXECUTOR_ID,
      billing_mode: "UNMETERED",
    }, "TEST");
    const m = driverMission(s, oid, "d2");
    throwsCode(
      () => reserve(s, m, "T1", null, DSH_EXECUTOR_ID),
      "FAIL_CLOSED_COST_AUTONOMOUS_EXECUTOR");
  });

  it("Z4.3 cap 0 + metered bound route on an autonomous executor → denied", () => {
    const s = fresh("z4c");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    s.cost.upsertCostProfile({
      ref_type: "route", ref_id: "RTE_CODEX_CLI",
      billing_mode: "METERED_API", reserve_microusd: 10_000,
    }, "TEST");
    enable(s, oid, { budget_microusd_cap: 0 });
    const m = driverMission(s, oid, "d3");
    throwsCode(
      () => reserve(s, m, "T1", "RTE_CODEX_CLI", CODEX_EXECUTOR_ID),
      /FAIL_CLOSED_COST_(AUTONOMOUS_METERED|OBJECTIVE_BUDGET_EXCEEDED)/);
  });

  it("Z4.4 proven subscription PAIR_NATIVE dispatch under cap 0 → $0 HELD", () => {
    const s = fresh("z4d");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const m = driverMission(s, oid, "d4");
    const res = reserve(s, m, "T1", PAIR_NATIVE_ROUTE_ID, PAIR_NATIVE_EXECUTOR_ID);
    expect(String(res.billing_mode ?? res.billing_mode)).toBeDefined();
    const row = s.store.get("cost_reservation", String(res.reservation_id)) as Row;
    expect(Number(row.reserved_microusd)).toBe(0);
    expect(String(row.billing_mode)).toBe("UNMETERED");
  });

  it("Z4.5 a NON-driver mission keeps existing dispatch semantics (no autonomous gate)", () => {
    const s = fresh("z4e");
    const oid = mkObjective(s);
    seedExecutorSupply(s, [CODEX_EXECUTOR_ID, PAIR_NATIVE_EXECUTOR_ID, DEVIN_EXECUTOR_ID]);
    enable(s, oid, { budget_microusd_cap: 0 });
    const m = driverMission(s, oid, "d5");
    // Manual provenance — same lineage, owner-opened.
    const wob = s.store.get("work_open_binding", m.openId) as Row;
    s.store.put("work_open_binding", m.openId, {
      ...wob, created_by: OWNER,
    }, Number(wob.version));
    s.cost.upsertCostProfile({
      ref_type: "executor", ref_id: DEVIN_EXECUTOR_ID,
      billing_mode: "FREE",
    }, "TEST");
    expect(() => reserve(s, m, "T1", null, DEVIN_EXECUTOR_ID)).not.toThrow();
  });

  it("Z4.6 driver mission under cap>0: metered autonomous dispatch still denied (subscription-only)", () => {
    // AUDIT R1 F2 — the monetary cap is not the subscription gate: a
    // driver-attributed dispatch resolving to METERED_API billing is
    // forbidden under ANY cap, including a positive one. The cap still
    // binds what IS allowed; manual lineage keeps metered semantics
    // (Z8.5).
    const s = fresh("z4f");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    s.cost.upsertCostProfile({
      ref_type: "route", ref_id: "RTE_CODEX_CLI",
      billing_mode: "METERED_API", reserve_microusd: 100_000,
    }, "TEST");
    enable(s, oid, { budget_microusd_cap: 500_000 });
    const m = driverMission(s, oid, "d6");
    throwsCode(
      () => reserve(s, m, "T1", "RTE_CODEX_CLI", CODEX_EXECUTOR_ID),
      /FAIL_CLOSED_COST_AUTONOMOUS_(METERED|SUBSCRIPTION)/);
  });
});

/* ============ Z5 — readiness codes ============ */

describe("Z5 — truthful readiness vocabulary", () => {
  it("Z5.1 no driver wired → driver_missing reports DRIVER_DISABLED", () => {
    const s = fresh("z5a");
    const oid = mkObjective(s);
    enable(s, oid);
    const st = s.scheduler.status(oid, OWNER) as Record<string, unknown>;
    expect(st.driver_missing).toContain("DRIVER_DISABLED");
  });

  it("Z5.2 OBJECTIVE_ZERO_BUDGET: canonical ceiling 0 blocks readiness", () => {
    const s = fresh("z5b");
    const oid = mkObjective(s, 0); // ceiling_microusd = 0
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("OBJECTIVE_ZERO_BUDGET");
    expect(r.objective_runnable).toBe(false);
  });

  it("Z5.3 POLICY_NOT_EFFECTIVE before enable", () => {
    const s = fresh("z5c");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("POLICY_NOT_EFFECTIVE");
  });

  it("Z5.4 BUDGET_EXHAUSTED when attributed spend reaches the cap", () => {
    const s = fresh("z5d");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 100 });
    const m = driverMission(s, oid, "e1");
    // Historical charged reservation — never reinterpreted as $0.
    s.cost.upsertCostProfile({
      ref_type: "executor", ref_id: "EXEC_PAID",
      billing_mode: "METERED_API", reserve_microusd: 500,
    }, "TEST");
    // Forge attribution via a PAID reservation on driver lineage is not
    // possible without spending — simulate attributed usage by direct
    // canonical reservation write under the driver's mission.
    s.store.put("cost_reservation", `CRSV_${counter}`, {
      reservation_id: `CRSV_${counter}`, governed_task_id: "GT_hist",
      mission_id: m.missionId, task_id: "T_hist", executor_id: "EXEC_PAID",
      route_id: null, billing_mode: "METERED_API", reserved_microusd: 500,
      settled_microusd: null, unbounded: false, status: "COMMITTED",
      created_at: "x", updated_at: "x", version: 0,
    }, 0);
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("BUDGET_EXHAUSTED");
  });
});

/* ============ Z6 — lifecycle under the zero-spend contract ============ */

describe("Z6 — pause / revoke / halt remain fail-closed", () => {
  it("Z6.1 paused policy → admission denied before any pass", async () => {
    const s = fresh("z6a");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const ver = Number((s.store.get("objective_auto_policy", `oap:${oid}`) as Row)
      .policy_version);
    s.policy.control({ objective_id: oid, actor: OWNER, action: "pause",
      policy_version: ver, idempotency_key: `pz-${counter}` });
    const driver = mkDriver(s);
    const res = await driver.tick();
    const d = res.driven[0] as Record<string, unknown> | undefined;
    // A paused policy is caught at the EARLIEST boundary — the scheduler
    // claim itself refuses (skipped + fault) or admission denies; either
    // way no pass ever runs.
    expect(d?.denied != null || d?.skipped === true).toBe(true);
    const passes = (s.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Row[])
      .filter((a) => String(a.objective_id) === oid);
    expect(passes).toHaveLength(0);
  });

  it("Z6.2 global halt → DRIVER_COST_HALTED, no admission receipt", async () => {
    const s = fresh("z6b");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const driver = mkDriver(s, { costHaltActive: () => true });
    const res = await driver.tick();
    const d = res.driven[0] as Record<string, unknown>;
    expect(d.denied).toBe("DRIVER_COST_HALTED");
    const receipts = s.store.list(SCHEDULER_RECEIPT) as Row[];
    expect(receipts.filter((r) => String(r.operation) === "DRIVER_ADMISSION")).toHaveLength(0);
  });

  it("Z6.3 replayed tick never duplicates the admission receipt", async () => {
    const s = fresh("z6c");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    let passes = 0;
    const driver = mkDriver(s, {
      runPass: async () => { passes++; return { outcome: "WAITING" } as never; },
    });
    const r1 = await driver.tick();
    expect(r1.driven[0]).toMatchObject({ outcome: "WAITING", settled: true });
    expect(passes).toBe(1);
    const receipts = s.store.list(SCHEDULER_RECEIPT) as Row[];
    const admits = receipts.filter((r) => String(r.operation) === "DRIVER_ADMISSION");
    expect(admits).toHaveLength(1);
  });
});

/* ============ Z8 — AUDIT R1 corrections ============ */

/** Real governed Codex executor with ambient metered API credentials in
 *  the parent env — the F1 attack shape. The fake CLI dumps the child
 *  env beside final.json (argv-derived — the adapter never forwards
 *  FAKE_* controls, so no test channel crosses the spawn boundary). */
function realCodexAdapter(s: S, tag: string, opts: { store?: boolean } = {}) {
  const journalRoot = path.join(s.dir, `jr-${tag}`);
  const exe = makeFakeCodex(path.join(s.dir, `fk-${tag}`));
  const codexHome = path.join(s.dir, `ch-${tag}`);
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
  const ambient: Record<string, string> = {
    OPENAI_API_KEY: "sk-ambient-metered",
    CODEX_API_KEY: "ck-ambient-metered",
    CODEX_HOME: codexHome,
  };
  const adapter = new CodexCliExecutorAdapter({
    journalRoot, executable: exe,
    envReader: (n: string) => (n in ambient ? ambient[n] : process.env[n]),
    ...(opts.store === false ? {} : { store: s.store }),
  });
  return { adapter, journalRoot };
}

function governedTask(s: S, m: { missionId: string }, tag: string) {
  const ws = path.join(s.dir, `ws-${tag}`);
  fs.mkdirSync(ws, { recursive: true });
  return {
    governed_task_id: `GT_${tag}_${counter}`,
    mission_id: m.missionId,
    task_id: `T_${tag}`,
    workspace: ws,
    allowed_paths: [ws],
    permissions: ["FILE_WRITE"],
    correlation_id: `corr-${tag}`,
    governance_digest: "x",
    executor_id: CODEX_EXECUTOR_ID,
    governance_state: "DISPATCH_AUTHORIZED",
    dispatch_enabled: true,
    timeout: 30,
    task_instruction: "noop",
    constraints: [],
  };
}

async function waitExec(a: CodexCliExecutorAdapter, id: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const o = a.observe(id);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"]
        .includes(String(o.status))) return o;
    if (Date.now() > deadline) throw new Error(`exec ${id} never terminal`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const childEnvDump = (journalRoot: string, executionId: string) =>
  JSON.parse(fs.readFileSync(path.join(
    codexRunRoot(journalRoot, executionId), "final.json.env.json"), "utf8"));

describe("Z8 — AUDIT R1 corrections (F1–F4)", () => {

  /* ----- F1: governed Codex executor child env ----- */

  it("Z8.1 autonomous dispatch strips OPENAI_API_KEY/CODEX_API_KEY from the real executor child env", async () => {
    const s = fresh("z8a");
    const oid = mkObjective(s);
    const m = driverMission(s, oid, "a"); // wob.created_by = DRIVER_ACTOR
    const { adapter, journalRoot } = realCodexAdapter(s, "z8a");
    const rec = adapter.dispatch(governedTask(s, m, "z8a"));
    const o = await waitExec(adapter, String(rec.execution_id));
    expect(o.status).toBe("COMPLETED");
    const env = childEnvDump(journalRoot, String(rec.execution_id));
    expect(env.OPENAI_API_KEY).toBe(false);
    expect(env.CODEX_API_KEY).toBe(false);
    // The subscription session still reaches the child — subscription-only
    // means SESSION auth, not no auth.
    expect(env.CODEX_HOME).toBe(true);
  });

  it("Z8.2 manual (owner-opened) dispatch preserves existing credential forwarding", async () => {
    const s = fresh("z8b");
    const oid = mkObjective(s);
    const m = driverMission(s, oid, "b");
    // Manual provenance — same lineage, owner-opened binding.
    const wob = s.store.get("work_open_binding", m.openId) as Row;
    s.store.put("work_open_binding", m.openId,
      { ...wob, created_by: OWNER }, Number(wob.version));
    const { adapter, journalRoot } = realCodexAdapter(s, "z8b");
    const rec = adapter.dispatch(governedTask(s, m, "z8b"));
    await waitExec(adapter, String(rec.execution_id));
    const env = childEnvDump(journalRoot, String(rec.execution_id));
    expect(env.OPENAI_API_KEY).toBe(true);
    expect(env.CODEX_API_KEY).toBe(true);
  });

  /* ----- F2: subscription-only regardless of monetary cap ----- */

  it("Z8.3 NO budget cap + reachable metered pairing → METERED_ROUTE_FORBIDDEN + admission denied", async () => {
    const s = fresh("z8c");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    s.cost.upsertCostProfile({
      ref_type: "route", ref_id: "RTE_CODEX_CLI",
      billing_mode: "METERED_API", reserve_microusd: 10_000,
    }, "TEST");
    enable(s, oid); // no budget_microusd_cap at all — metered still forbidden
    const driver = mkDriver(s);
    const r = driver.readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("METERED_ROUTE_FORBIDDEN");
    expect(r.objective_runnable).toBe(false);
    const out = await driver.tick();
    expect(out.driven[0]).toMatchObject({ denied: "DRIVER_METERED_FORBIDDEN" });
    expect((s.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Row[])
      .filter((a) => String(a.objective_id) === oid)).toHaveLength(0);
  });

  it("Z8.4 NO budget cap + unbounded pairing → admission denied (never silently free)", async () => {
    const s = fresh("z8d");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    // METERED_API with no reserve/rates is UNBOUNDED — unprovable bound.
    s.cost.upsertCostProfile({
      ref_type: "route", ref_id: "RTE_CODEX_CLI",
      billing_mode: "METERED_API",
    }, "TEST");
    enable(s, oid); // no budget cap — unprovable binding still denied
    const out = await mkDriver(s).tick();
    expect(out.driven[0]).toMatchObject({ denied: "DRIVER_COST_UNVERIFIED" });
  });

  it("Z8.5 positive cap + METERED manual (owner-opened) mission still reserves — manual semantics preserved", () => {
    const s = fresh("z8e");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    s.cost.upsertCostProfile({
      ref_type: "route", ref_id: "RTE_CODEX_CLI",
      billing_mode: "METERED_API", reserve_microusd: 100_000,
    }, "TEST");
    enable(s, oid, { budget_microusd_cap: 500_000 });
    const m = driverMission(s, oid, "e");
    const wob = s.store.get("work_open_binding", m.openId) as Row;
    s.store.put("work_open_binding", m.openId,
      { ...wob, created_by: OWNER }, Number(wob.version));
    const res = reserve(s, m, "T1", "RTE_CODEX_CLI", CODEX_EXECUTOR_ID);
    const row = s.store.get("cost_reservation", String(res.reservation_id)) as Row;
    expect(Number(row.reserved_microusd)).toBe(100_000);
  });

  /* ----- F3: final CODEX SUBSCRIPTION + session re-proof at reserve ----- */

  it("Z8.6 driver CODEX + UNMETERED profile → denied (FREE/UNMETERED never substitutes)", () => {
    const s = fresh("z8f");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s, "UNMETERED"); // contradictory label on codex
    enable(s, oid, { budget_microusd_cap: 0 });
    const m = driverMission(s, oid, "f");
    throwsCode(
      () => reserve(s, m, "T1", null, CODEX_EXECUTOR_ID),
      "FAIL_CLOSED_COST_AUTONOMOUS_SUBSCRIPTION");
  });

  it("Z8.7 driver CODEX + SUBSCRIPTION profile + unproven session → denied", () => {
    const s = fresh("z8g");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s, "AUTH_REQUIRED"); // session never proven
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const m = driverMission(s, oid, "g");
    throwsCode(
      () => reserve(s, m, "T1", null, CODEX_EXECUTOR_ID),
      "FAIL_CLOSED_COST_AUTONOMOUS_SUBSCRIPTION");
  });

  it("Z8.8 driver CODEX + ACTIVE SUBSCRIPTION + AUTH_OK → $0 HELD (proven subscription)", () => {
    const s = fresh("z8h");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const m = driverMission(s, oid, "h");
    const res = reserve(s, m, "T1", null, CODEX_EXECUTOR_ID);
    const row = s.store.get("cost_reservation", String(res.reservation_id)) as Row;
    expect(Number(row.reserved_microusd)).toBe(0);
    expect(String(row.billing_mode)).toBe("SUBSCRIPTION");
  });

  it("Z8.9 proven COMMITTED reservation is adopted — never re-gated after profile/auth drift", () => {
    const s = fresh("z8i");
    const oid = mkObjective(s);
    seedExecutorSupply(s);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const m = driverMission(s, oid, "i");
    const res = reserve(s, m, "T1", null, CODEX_EXECUTOR_ID);
    // The dispatch was proven + committed. Then the world drifts: profile
    // flips to METERED and the session evidence is revoked.
    const row = s.store.get("cost_reservation", String(res.reservation_id)) as Row;
    s.store.put("cost_reservation", String(res.reservation_id),
      { ...row, status: "COMMITTED" }, Number(row.version));
    const cp = (s.store.list("cost_profile") as Row[])
      .find((p) => String(p.ref_id) === CODEX_EXECUTOR_ID)!;
    s.cost.upsertCostProfile({
      ref_type: "executor", ref_id: CODEX_EXECUTOR_ID,
      billing_mode: "METERED_API", reserve_microusd: 5_000,
    }, "TEST", Number(cp.version));
    seedCodexAuth(s, "AUTH_REQUIRED");
    // Re-resolving the SAME governed task adopts the proven charge — the
    // autonomous gate applies to NEW dispatches, never history.
    const again = reserve(s, m, "T1", null, CODEX_EXECUTOR_ID);
    expect(String(again.reservation_id)).toBe(String(res.reservation_id));
    expect(String(again.status)).toBe("COMMITTED");
  });

  /* ----- F4: CEO subscription authority independent of executor supply ----- */

  it("Z8.10 PAIR_NATIVE-only supply + unproven codex session → SUBSCRIPTION_AUTH_UNVERIFIED, not runnable", () => {
    const s = fresh("z8j");
    const oid = mkObjective(s);
    seedExecutorSupply(s, [PAIR_NATIVE_EXECUTOR_ID]); // no CODEX executor at all
    seedCodexAuth(s, "AUTH_REQUIRED");
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toContain("SUBSCRIPTION_AUTH_UNVERIFIED");
    expect(r.objective_runnable).toBe(false);
  });

  it("Z8.11 PAIR_NATIVE-only supply + proven codex subscription → READY (CEO proven independent of CODEX supply)", () => {
    const s = fresh("z8k");
    const oid = mkObjective(s);
    seedExecutorSupply(s, [PAIR_NATIVE_EXECUTOR_ID]);
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const r = mkDriver(s).readiness(oid, OWNER) as Record<string, unknown>;
    expect(r.reasons).toEqual([]);
    expect(r.objective_runnable).toBe(true);
  });

  it("Z8.12 unproven CEO session → admission denied before any CEO attempt", async () => {
    const s = fresh("z8l");
    const oid = mkObjective(s);
    seedExecutorSupply(s, [PAIR_NATIVE_EXECUTOR_ID]);
    seedCodexAuth(s, "AUTH_REQUIRED");
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0 });
    const out = await mkDriver(s).tick();
    expect(out.driven[0]).toMatchObject({ denied: "DRIVER_SUBSCRIPTION_UNVERIFIED" });
    expect((s.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Row[])
      .filter((a) => String(a.objective_id) === oid)).toHaveLength(0);
  });
});

/* ============ Z7 — production-composition E2E ============ */

describe("Z7 — end-to-end: objective → driver → CEO → planner → governed dispatch → execution settle", () => {
  it("Z7.1 bounded lifecycle, zero metered API calls, real governed Codex executor env", async () => {
    const s = fresh("z7");
    const oid = mkObjective(s);
    // Canonical workspace authority — startBoundMission requires a real
    // project root_location (EXPLICIT_WORKSPACE mode).
    const project = s.service.createProject({ name: "pz7", root_location: s.workspace });
    const bizRow = s.store.get("business", s.bid) as Row;
    s.store.put("business", s.bid, {
      ...bizRow, project_id: String(project.project_id) }, Number(bizRow.version));

    // Controlled fake codex CLI — CEO + planner + the real governed
    // executor all spawn it; ambient metered keys sit in the parent env.
    const fakeDir = path.join(s.dir, "fake-codex");
    const exe = makeFakeCodex(fakeDir);
    const invokeLog = path.join(s.dir, "codex-invocations.log");
    const envFile = path.join(s.dir, "codex-env.json");
    const childEnv = {
      PAIR_CODEX_EXECUTABLE: exe,
      CODEX_HOME: path.join(s.dir, ".codex"),
      OPENAI_API_KEY: "sk-metered-must-not-leak",
      CODEX_API_KEY: "ck-metered-must-not-leak",
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      FAKE_CODEX_INVOKELOG: invokeLog,
      FAKE_CODEX_ENVFILE: envFile,
      FAKE_CODEX_BEHAVIOR: "ceo_init",
    };
    fs.mkdirSync(childEnv.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(childEnv.CODEX_HOME, "auth.json"), "{}");

    // AUDIT R1 — the REAL CodexCliExecutorAdapter is the governed CODEX
    // supply: canonical registration, real child-env boundary, ambient
    // metered credentials present in its env reader.
    const codexJournal = path.join(s.dir, "codex-journal");
    const realCodex = new CodexCliExecutorAdapter({
      journalRoot: codexJournal,
      executable: exe,
      envReader: (n: string) =>
        (n in childEnv
          ? (childEnv as Record<string, string>)[n]
          : process.env[n]),
      store: s.store,
    });
    const adapters = new Map<string, ExecutorAdapter>(
      [[CODEX_EXECUTOR_ID, realCodex]]);
    registerGovernedExecutors(s.service, adapters, "TEST");
    // PAIR_NATIVE canonical supply (envelope coverage; this pass's
    // dispatched task routes to CODEX, the only registered adapter).
    new ExecutorRegistry(s.service).register({
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      executor_type: "AUTOMATON_WORKER",
      capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
      health_state: "READY",
      status: "ENABLED",
      metadata: {
        qualification_state: "QUALIFIED",
        permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
        workspace_modes: ["EXPLICIT_WORKSPACE"],
      },
    });
    s.service.routes.seedPairNativeRoute("TEST");
    seedCodexAuth(s);
    seedCodexSubscription(s);
    enable(s, oid, { budget_microusd_cap: 0, max_ceo_calls: 4, max_missions: 2 });

    // Canonical CEO model entry qualified through the real evidence seams.
    const meId = ensureCodexCliCatalog(s.store, "gpt-6.1-sol", "TEST");
    new ProviderCatalog(s.store).issueQualificationReceipt(
      CODEX_CLI_PROVIDER_ID, { policy_version: "t", actor: "t" });
    new ModelEvidenceCatalog(s.store).recordProbeReceipt({
      probe_id: `PRB_${counter}`, model_entry_id: meId,
      provider_id: CODEX_CLI_PROVIDER_ID, result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" }, latency_ms: 1 });
    const q = qualifyModel(s.store, meId, { capability_scope: ["text_inference"], actor: "t" });
    if (!q.qualified) throw new Error("model qualification failed");

    const fetchSpy = vi.fn(() => Promise.reject(new Error("NO_NETWORK")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const invoker = new CodexCliCeoDecisionInvoker({
        executable: exe, scratchDir: path.join(s.dir, "ceo-scr"), env: childEnv });
      // planExpander — mirrors serve-mission-control.mjs composition:
      // planner_run → admitPlannerInvocation (objective lineage) →
      // codex-only failover over codexPlannerPlan → settle.
      const planExpander = async (input: Record<string, unknown>,
        expandCtx?: { work_item_id?: string; deadlineMs?: number }) => {
        const goal = String(input.goal);
        const candidate: PlannerCandidate = {
          model_entry_id: canonicalModelId(CODEX_CLI_PROVIDER_ID, "gpt-6.1-sol"),
          ref: "codex-cli:gpt-6.1-sol", provider: CODEX_CLI_PROVIDER_ID,
          model: "gpt-6.1-sol", endpoint: "codex-cli://local",
          credentialEnv: "", transport: "codex_cli",
        };
        const run = beginPlannerRun(s.store, {
          project_id: input.project_id != null ? String(input.project_id) : undefined,
          operator_id: input.operator_id, routes: [candidate.ref],
          actor: "PAIR_PLANNER",
        });
        let admission: { reservation_id: string | null } = { reservation_id: null };
        try {
          admission = s.cost.admitPlannerInvocation({
            planner_run_id: String(run.planner_run_id),
            work_item_id: expandCtx?.work_item_id ?? null,
            est_microusd: s.cost.plannerRequestBoundMicrousd(candidate).per_request_microusd * 3,
            unbounded_unknown: s.cost.plannerRequestBoundMicrousd(candidate).billing.unbounded,
            candidates: 1, actor: "PAIR_PLANNER",
          });
          const res = await runPlannerFailover({
            candidates: [candidate],
            assertEligible: () => undefined,
            planFn: async (c) => {
              assertCodexCliPlannerTransport(c);
              return codexPlannerPlan(goal, {
                executable: exe, model: c.model, timeoutMs: 30_000,
                scratchDir: path.join(s.dir, "pln-scr"),
                allowedCapabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
                capabilitySets: [["FILE_OPERATIONS"]],
                maxTasks: 8,
                env: { ...childEnv, FAKE_CODEX_BEHAVIOR: "plan" },
              });
            },
          });
          finishPlannerRun(s.store, {
            planner_run_id: String(run.planner_run_id),
            outcome: "WINNER_SELECTED",
            winner_attempt_no: res.winner.attempt_no, actor: "PAIR_PLANNER" });
          if (admission.reservation_id) {
            s.cost.settlePlannerInvocation(admission.reservation_id, "CALLS_MADE", null);
          }
          return {
            input: { ...input, metadata: {
              ...(input.metadata as Record<string, unknown>),
              llm_plan: res.tasks, plan_source: "LLM",
              plan_model: res.winner.model } },
            planner: { planner_run_id: String(run.planner_run_id),
              attempts: res.attempts, winner: { attempt_no: res.winner.attempt_no } },
          };
        } catch (e) {
          finishPlannerRun(s.store, {
            planner_run_id: String(run.planner_run_id),
            outcome: "EXHAUSTED", actor: "PAIR_PLANNER" });
          if (admission.reservation_id) {
            s.cost.settlePlannerInvocation(admission.reservation_id, "NO_CALLS", null);
          }
          throw e;
        }
      };
      // Full production composition — the REAL MissionControl behind
      // openWorkItem's bound-mission mint (mirrors freshFullStack in
      // pair-p15-10d.test.ts): runtime + gate + router + the recording
      // adapters registered through registerGovernedExecutors above.
      const gate = new GovernedTaskGate(s.service);
      const router = new MissionRouter(s.service, gate);
      const recovery = new RecoveryController(s.service);
      const recon = new ReconciliationService(s.service, new Map());
      const approvals = new ApprovalQueue(s.service);
      const missionScheduler = new MissionScheduler(s.service, { mission_concurrency: 2 });
      // Canonical capability row — plan validation checks task
      // required_capabilities against the capability registry.
      s.service.registerCapability("FILE_OPERATIONS");
      const runtimePlanner = () => ({
        tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1",
          required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
      });
      const runtime = new MissionRuntime({
        service: s.service, gate, router, adapters,
        scheduler: missionScheduler, approvals,
        reconciliation: recon, recovery, planner: runtimePlanner,
      });
      const supervisor = new MissionSupervisor(s.service, runtime, recovery, recon);
      const control = new MissionControl({
        service: s.service, runtime, supervisor, scheduler: missionScheduler,
        approvals, reconciliation: recon,
        observability: new MissionObservability(s.service), planner: runtimePlanner,
      });
      const schedules = new MissionScheduleService(s.service);
      const biz = new BusinessLayer({
        store: s.store, control, schedules, planExpander });
      biz.createOrgAgent({
        business_id: s.bid, title: "agent-z7",
        department: "ops", operator_id: OP });
      const wf = new WorkforceService({ store: s.store, business: biz });
      const workstreams = new ObjectiveWorkstreamService(
        { store: s.store, business: biz, workforce: wf, objectives: biz.objectives });
      const ops = createDefaultObjectiveOperatingService({
        store: s.store, business: biz, workforce: wf,
        objectives: biz.objectives, workstreams, invoker });
      const driver = mkDriver(s, {
        runPass: (input: {
          objective_id: string; actor: string;
          authority_gate: () => void; planning_deadline_epoch_ms: number;
        }) => ops.service.runObjectivePass(input),
      });
      const res = await driver.tick();
      const d = res.driven[0] as Record<string, unknown>;
      expect(d.settled).toBe(true);
      expect(d.outcome).toBe("DISPATCHED");

      // Zero paid transport: the only outbound channels were fake-codex spawns.
      expect(fetchSpy).not.toHaveBeenCalled();
      const invocations = fs.existsSync(invokeLog)
        ? fs.readFileSync(invokeLog, "utf8").split("\n").filter(Boolean) : [];
      // CEO attempted exactly once through the subscription CLI.
      const attempts = (s.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Row[])
        .filter((a) => String(a.objective_id) === oid);
      expect(attempts.length).toBe(1);
      expect(invocations.length).toBeGreaterThanOrEqual(1);
      // Metered API credentials never reached the CEO/planner child env.
      const laneEnvDump = JSON.parse(fs.readFileSync(envFile, "utf8"));
      expect(laneEnvDump.OPENAI_API_KEY).toBe(false);
      expect(laneEnvDump.CODEX_API_KEY).toBe(false);
      // Reservations (planner lane) exist under objective lineage at $0.
      const plannerRes = (s.store.list("cost_reservation") as Row[])
        .filter((r) => String(r.reservation_id).startsWith("CRSV_PLN_"));
      expect(plannerRes.length).toBe(1);
      expect(Number(plannerRes[0].reserved_microusd)).toBe(0);
      // Driver-attributed mission binding exists.
      const wobs = (s.store.list("work_open_binding") as Row[])
        .filter((w) => String(w.created_by) === DRIVER_ACTOR);
      expect(wobs.length).toBeGreaterThanOrEqual(1);

      // REAL governed Codex execution to terminal: drive the real
      // MissionRuntime — the READY task routes through the
      // GovernedTaskGate into the real CodexCliExecutorAdapter, then a
      // later tick observes the terminal execution and the canonical
      // collect → validate → settle path runs (reservation settled
      // inside the gate), exactly as production runs it.
      // Mission identity comes from canonical driver lineage (the
      // work_open_binding minted by the pass), not the result DTO.
      const missionId = String(wobs[0].mission_id);
      expect(s.store.tryGet("mission", missionId)).toBeTruthy();
      let execs: Row[] = [];
      for (let i = 0; i < 8 && execs.length === 0; i++) {
        runtime.tick(missionId);
        execs = (s.store.list("executor_execution") as Row[])
          .filter((e) => String(e.executor_id) === CODEX_EXECUTOR_ID);
      }
      expect(execs.length).toBe(1);
      const execId = String(execs[0].execution_id);
      const o = await waitExec(realCodex, execId);
      expect(o.status).toBe("COMPLETED");
      for (let i = 0; i < 8; i++) {
        runtime.tick(missionId);
        const row = s.store.get("executor_execution", execId) as Row;
        if (row.result != null) break;
      }
      const execAfter = s.store.get("executor_execution", execId) as Row;
      expect(String(execAfter.execution_state)).toBe("COMPLETED");
      expect(execAfter.result).toBeTruthy();
      // The governed-task reservation is terminal COMMITTED at its $0
      // bound — canonical subscription semantics: per-call usage is
      // unmeasured so it stays at reserved maximum ($0), never SETTLED
      // positive (settlement requires a proven microusd figure).
      const taskRes = (s.store.list("cost_reservation") as Row[])
        .filter((r) => String(r.executor_id) === CODEX_EXECUTOR_ID);
      expect(taskRes.length).toBe(1);
      expect(String(taskRes[0].status)).toBe("COMMITTED");
      expect(Number(taskRes[0].reserved_microusd)).toBe(0);
      // F1 proven E2E: the REAL executor child env carried no metered keys.
      const execEnv = childEnvDump(codexJournal, execId);
      expect(execEnv.OPENAI_API_KEY).toBe(false);
      expect(execEnv.CODEX_API_KEY).toBe(false);
      expect(execEnv.CODEX_HOME).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
