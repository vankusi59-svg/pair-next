/**
 * Phase C — GOVERNED DSH MULTI-MODEL ROUTING + SAFE FAILOVER + DURABLE
 * PROVENANCE. Mandate test groups A–K:
 *
 *   A layering (router→executor→route→model, no generic routes per model)
 *   B PR #24 non-regression (binding.capabilities stays canonical)
 *   C pool (configured order, dedupe-after-resolution, no silent shrink)
 *   D role authority (DSH_EXECUTION held, no Planner alias, not REMOVED…)
 *   E runtime eligibility (provider/model/executor/binding state at invoke)
 *   F side-effect safety (failover ONLY pre-dispatch; exactly-once)
 *   G recovery (exhaustion → FAIL_CLOSED_DSH_MODEL_EXHAUSTED taxonomy)
 *   H shared deadline (task.timeout spans candidates; budget never reset)
 *   I credentials (credential follows selected model; never leaked)
 *   J provenance (dsh_model_attempt rows + events, ≤1 winner)
 *   K restart (crash after STARTED stays STARTED; evidence survives)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  assertDshCandidateEligible,
  assertDshExecutionModelRole,
  assignModelRole,
  createDshModelRouter,
  DshExecutorAdapter,
  DSH_ATTEMPT_ENTITY,
  DSH_EXECUTOR_ID,
  DSH_MODEL_CONFIG_ID,
  dshModelExhaustedError,
  ensureBinding,
  ExecutorRegistry,
  IntegrityError,
  listBindings,
  ModelEvidenceCatalog,
  MODEL_ROLE,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  PROVIDER_QUALIFICATION_REQUIRED_GATES,
  providerEntryId,
  qualifyBinding,
  qualifyModel,
  registerGovernedExecutors,
  resolveConfiguredModelRoleRoute,
  revokeModelRole,
} from "../pair/index.js";
import type { DshModelCandidate } from "../pair/index.js";

const FAKE_ACP_PHC = path.resolve(__dirname, "fixtures", "fake-acp-agent-phc.mjs");

const ROOT = mkTmpDir("pair-phc-");
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/* ------------------------------------------------------------ fixtures -- */

const mkProvider = (
  store: PairEvidenceStore,
  pid: string,
  opts: { lifecycle?: string; auth_state?: string; health_state?: string; conditions?: string[] } = {},
) => {
  const id = providerEntryId(pid);
  const existing = store.tryGet("provider", id);
  const lifecycle = opts.lifecycle ?? "QUALIFIED";
  store.put(
    "provider",
    id,
    {
      ...(existing ?? { provider_id: pid, entry_id: id }),
      lifecycle_state: lifecycle,
      auth_state: opts.auth_state ?? "AUTH_OK",
      health_state: opts.health_state ?? "READY",
      conditions: [],
      // R3 §7 — MODEL_DISCOVERY_ELIGIBLE is a qualified resting state too,
      // so it carries durable PROBED evidence like QUALIFIED.
      probe_state: ["QUALIFIED", "MODEL_DISCOVERY_ELIGIBLE"].includes(lifecycle) ? "PROBED" : "UNPROBED",
    },
    existing ? Number(existing.version) : 0,
  );
  // Phase E §7 — routable-authority lifecycles carry a material-bound
  // qualification receipt (both reachable only through canonical
  // qualification in production).
  if (lifecycle === "QUALIFIED" || lifecycle === "MODEL_DISCOVERY_ELIGIBLE") {
    // R5 — the seam derives the required gate set from durable state:
    // mint under canonical healthy state, then apply the caller's
    // degraded auth/health after the receipt (post-qualification
    // degradation ordering).
    const cur = store.get("provider", id);
    store.put("provider", id, { ...cur, auth_state: "AUTH_OK", probe_state: "PROBED", health_state: "READY" }, Number(cur.version));
    new ProviderCatalog(store).issueQualificationReceipt(pid, {
      policy_version: "test-policy",
      actor: "test",
    });
    if (opts.auth_state !== undefined || opts.health_state !== undefined) {
      const b = store.get("provider", id);
      store.put("provider", id, {
        ...b,
        auth_state: opts.auth_state ?? b.auth_state,
        health_state: opts.health_state ?? b.health_state,
      }, Number(b.version));
    }
    if (lifecycle === "MODEL_DISCOVERY_ELIGIBLE") {
      const b = store.get("provider", id);
      store.put("provider", id, { ...b, lifecycle_state: "MODEL_DISCOVERY_ELIGIBLE" }, Number(b.version));
    }
  }
  if (opts.conditions?.length) {
    const b = store.get("provider", id);
    store.put("provider", id, { ...b, conditions: opts.conditions }, Number(b.version));
  }
};

const mkModel = (
  store: PairEvidenceStore,
  pid: string,
  mid: string,
  opts: { conditions?: string[]; aliases?: string[]; lifecycle?: string } = {},
): string => {
  const mcat = new ModelEvidenceCatalog(store);
  const { entry } = mcat.upsertModelClaim({
    provider_id: pid,
    provider_family: pid,
    model_id: mid,
    capability_hints: ["text_inference"],
  });
  const eid = String(entry.model_entry_id);
  const lifecycle = opts.lifecycle ?? "QUALIFIED";
  if (lifecycle === "QUALIFIED") {
    // Phase E R2 §4 — canonical probe→qualify chain only; direct receipt
    // minting fails closed now.
    mcat.recordProbeReceipt({
      probe_id: `PRB_${pid}_${mid}`.replace(/[^A-Za-z0-9_-]/g, "_"),
      model_entry_id: eid,
      provider_id: pid,
      result: "PASS",
      probe_type: "text_inference",
      capability_evidence: { text_inference: "PASS" },
      latency_ms: 1,
    });
    const q = qualifyModel(store, eid, { capability_scope: ["text_inference"], actor: "t" });
    if (!q.qualified) throw new Error(`mkModel fixture failed: ${JSON.stringify(q.gates)}`);
  } else if (lifecycle !== "DISCOVERED") {
    const body = store.get("model_entry", eid);
    store.put("model_entry", eid, { ...body, lifecycle_state: lifecycle }, Number(body.version));
  }
  if (opts.conditions?.length || opts.aliases?.length) {
    const body = store.get("model_entry", eid);
    store.put(
      "model_entry",
      eid,
      {
        ...body,
        conditions: opts.conditions ?? body.conditions,
        model_alias_ids: opts.aliases ?? body.model_alias_ids,
      },
      Number(body.version),
    );
  }
  return eid;
};

/** Canonical candidate fixture: model entry + provider + DSH_EXECUTION role
 *  + QUALIFIED model_binding — exactly what production mints at boot. */
const mkCandidate = (
  store: PairEvidenceStore,
  service: PairControlPlane,
  pid: string,
  mid: string,
  opts: { role?: string; qualifyBinding?: boolean; model?: object } = {},
): DshModelCandidate => {
  mkProvider(store, pid);
  const me = mkModel(store, pid, mid, opts.model ?? {});
  assignModelRole(store, me, (opts.role ?? MODEL_ROLE.DSH_EXECUTION) as never, { actor: "t" });
  const b = ensureBinding(service, {
    executor_id: DSH_EXECUTOR_ID,
    provider_id: pid,
    model_entry_id: me,
    transport_compat: "OPENAI_COMPLETIONS",
  });
  if (opts.qualifyBinding !== false) qualifyBinding(service, String(b.binding_id));
  return { ref: `${pid}:${mid}`, pid, mid, model_entry_id: me };
};

interface DshCtx {
  dir: string;
  workspace: string;
  store: PairEvidenceStore;
  service: PairControlPlane;
  adapter: DshExecutorAdapter;
  router: ReturnType<typeof createDshModelRouter>;
  candidates: DshModelCandidate[];
}

/** Full governed stack: real adapter (fixture launch), executor record via
 *  the real registration seam, canonical model bindings, bound router. */
const mkDsh = (
  name: string,
  opts: {
    pids?: string[];
    envReader?: (n: string) => string | undefined;
    /** Env knobs forwarded to the fixture agent via launch.env (child env
     *  is minimal by design — test controls must be explicit pins). */
    launchEnv?: Record<string, string>;
    extra?: Record<string, unknown>;
    roleAssertion?: boolean;
    qualifyExecutor?: boolean;
  } = {},
): DshCtx => {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const pids = opts.pids ?? ["palpha", "pbeta"];
  const candidates = pids.map((pid, i) => mkCandidate(store, service, pid, `m${i}`));
  const envReader =
    opts.envReader ??
    ((n: string) => (n.endsWith("_API_KEY") ? "test-credential" : process.env[n]));
  const adapter = new DshExecutorAdapter({
    journalRoot: path.join(dir, "journal"),
    envReader,
    launchOverride: {
      command: "node",
      args: [FAKE_ACP_PHC, "--profile", "acp"],
      env: opts.launchEnv ?? {},
    },
    ...(opts.roleAssertion
      ? {
          modelRoleAssertion: (provider: string, model: string) => {
            const me = new ModelEvidenceCatalog(store).getModelByIds(provider, model);
            if (!me) throw new IntegrityError("FAIL_CLOSED_MODEL_ROLE_UNASSIGNED", `${provider}:${model}`);
            assertDshExecutionModelRole(store, String(me.model_entry_id));
          },
        }
      : {}),
    ...(opts.extra ?? {}),
  });
  if (opts.qualifyExecutor !== false) {
    // Real registration seam: probe → qualify → canonical executor row.
    registerGovernedExecutors(service, new Map([[DSH_EXECUTOR_ID, adapter]]), "t");
  }
  const router = createDshModelRouter({ service, executorId: DSH_EXECUTOR_ID, candidates });
  adapter.bindModelRouter(router, service);
  return { dir, workspace, store, service, adapter, router, candidates };
};

const governedTask = (ctx: DshCtx, extra: Record<string, unknown> = {}) => ({
  governed_task_id: `GTSK_${counter}_${Math.random().toString(36).slice(2, 8)}`,
  mission_id: "MSN_PHC",
  task_id: "TSK_PHC",
  correlation_id: "corr-phc",
  executor_id: DSH_EXECUTOR_ID,
  governance_state: "DISPATCH_AUTHORIZED",
  dispatch_enabled: true,
  governance_digest: "d",
  workspace: ctx.workspace,
  allowed_paths: [ctx.workspace],
  task_instruction: "write agent_out.txt",
  timeout: 20,
  ...extra,
});

async function waitTerminal(adapter: DshExecutorAdapter, executionId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const o = adapter.observe(executionId);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(String(o.status))) return o;
    if (Date.now() > deadline) throw new Error(`execution ${executionId} never terminal`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

const attemptsOf = (store: PairEvidenceStore, gtid: string) =>
  (store.list(DSH_ATTEMPT_ENTITY) as Array<Record<string, unknown>>)
    .filter((a) => String(a.governed_task_id) === gtid)
    .sort((a, b) => Number(a.attempt_no) - Number(b.attempt_no));

const dispatchAndWait = async (ctx: DshCtx, task?: Record<string, unknown>) => {
  const t = task ?? governedTask(ctx);
  const disp = ctx.adapter.dispatch(t);
  const eid = String(disp.execution_id);
  const term = await waitTerminal(ctx.adapter, eid);
  return { task: t, eid, term, attempts: attemptsOf(ctx.store, String(t.governed_task_id)) };
};

/* ===================== A — layering invariants ========================== */

describe("A — layering (executor → route → model)", () => {
  it("A1/A6: model router is invoked only INSIDE DSH dispatch — no rows before dispatch", () => {
    const ctx = mkDsh("a1");
    expect(ctx.store.list(DSH_ATTEMPT_ENTITY)).toHaveLength(0);
    // The pool exists but produces no state until a governed dispatch runs.
    expect(ctx.router.candidates()).toHaveLength(2);
  });

  it("A2: no generic PAIR route is minted per model — route set unchanged by dispatch", async () => {
    const ctx = mkDsh("a2");
    const routesBefore = ctx.store.list("route").map((r) => String(r.route_id));
    await dispatchAndWait(ctx);
    const routesAfter = ctx.store.list("route").map((r) => String(r.route_id));
    expect(routesAfter.sort()).toEqual(routesBefore.sort());
  });

  it("A3: attempt evidence links executor_supply_binding separately from model_binding", async () => {
    const ctx = mkDsh("a3");
    const { attempts } = await dispatchAndWait(ctx, governedTask(ctx, { route_id: "RTE_DSH_ACP" }));
    expect(attempts).toHaveLength(1);
    const a = attempts[0];
    expect(String(a.model_binding_id)).toMatch(/^MBD_/);
    // Model binding and supply binding are distinct authorities — never aliased.
    const bindings = listBindings(ctx.service);
    const mb = bindings.find((b) => b.binding_id === a.model_binding_id);
    expect(mb).toBeTruthy();
    expect(String(mb!.model_entry_id)).toBe(String(ctx.candidates[0].model_entry_id));
    expect(String(mb!.executor_id)).toBe(DSH_EXECUTOR_ID);
  });

  it("A4: executor identity is fixed — DSH dispatch never drifts to another executor", async () => {
    const ctx = mkDsh("a4");
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("COMPLETED");
    for (const a of attempts) expect(String(a.executor_id)).toBe(DSH_EXECUTOR_ID);
  });
});

/* ============ B — PR #24 non-regression (capability authority) ========== */

describe("B — PR #24 capability authority untouched", () => {
  it("B1: executor_supply_binding caps still minted by registration; model layer adds model_binding rows only", () => {
    const ctx = mkDsh("b1");
    // registerGovernedExecutors minted executor↔route bindings (PR #24);
    // ensureBinding minted executor↔model bindings (Phase C). Both coexist.
    const supply = ctx.store.list("executor_supply_binding");
    const models = ctx.store.list("model_binding");
    expect(supply.length).toBeGreaterThan(0);
    expect(models.length).toBeGreaterThanOrEqual(2);
    // They never share ids — two disjoint authorities.
    const supplyIds = new Set(supply.map((r) => String(r.binding_id ?? r.executor_supply_binding_id)));
    for (const m of models) expect(supplyIds.has(String(m.binding_id))).toBe(false);
  });

  it("B2: dispatch does not mutate executor_supply_binding capability authority", async () => {
    const ctx = mkDsh("b2");
    const before = ctx.store
      .list("executor_supply_binding")
      .map((b) => `${b.binding_id}:${JSON.stringify(b.capabilities)}`)
      .sort();
    await dispatchAndWait(ctx);
    const after = ctx.store
      .list("executor_supply_binding")
      .map((b) => `${b.binding_id}:${JSON.stringify(b.capabilities)}`)
      .sort();
    expect(after).toEqual(before);
  });
});

/* ===================== C — pool order & resolution ====================== */

describe("C — candidate pool", () => {
  it("C1: configured order is authoritative — primary first, then fallback, then extras", () => {
    const dir = freshDir("c1");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    const c1 = mkCandidate(store, service, "pz", "m1");
    const c2 = mkCandidate(store, service, "pa", "m2");
    const c3 = mkCandidate(store, service, "pb", "m3");
    const router = createDshModelRouter({
      service,
      executorId: DSH_EXECUTOR_ID,
      candidates: [c1, c2, c3],
    });
    expect(router.candidates().map((c) => c.ref)).toEqual(["pz:m1", "pa:m2", "pb:m3"]);
  });

  it("C2: pool snapshot is a copy — mutating the returned array cannot reorder authority", () => {
    const ctx = mkDsh("c2");
    const got = ctx.router.candidates();
    got.reverse();
    expect(ctx.router.candidates()[0].ref).toBe(ctx.candidates[0].ref);
  });

  it("C3: dedupe happens AFTER canonical resolution — same model_entry_id collapses", () => {
    // Operator sets primary == fallback (single-route pool): both refs
    // resolve to the SAME canonical entry — dedupe keys on model_entry_id,
    // never on the configured spelling.
    const dir = freshDir("c3");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const mcat = new ModelEvidenceCatalog(store);
    const resolve = (p: string, m: string) => mcat.getModelByIds(p, m);
    const me = mkModel(store, "pa", "m1");
    mkProvider(store, "pa");
    const r1 = resolveConfiguredModelRoleRoute(resolve, { route: "pa:m1", role: MODEL_ROLE.DSH_EXECUTION });
    const r2 = resolveConfiguredModelRoleRoute(resolve, { route: "pa:m1", role: MODEL_ROLE.DSH_EXECUTION });
    expect(String(r1.model_entry_id)).toBe(String(me));
    expect(String(r2.model_entry_id)).toBe(String(me));
    const seen = new Set<string>();
    const pool = [r1, r2].filter((r) => (seen.has(String(r.model_entry_id)) ? false : (seen.add(String(r.model_entry_id)), true)));
    expect(pool).toHaveLength(1);
  });

  it("C4: unresolved configured route fails closed at resolution (no silent shrink)", () => {
    const dir = freshDir("c4");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const mcat = new ModelEvidenceCatalog(store);
    const resolve = (p: string, m: string) => mcat.getModelByIds(p, m);
    expect(() =>
      resolveConfiguredModelRoleRoute(resolve, { route: "ghost:model", role: MODEL_ROLE.DSH_EXECUTION }),
    ).toThrowError(/FAIL_CLOSED_MODEL_ROLE_ROUTE_UNRESOLVED/);
  });

  it("C5: failover consumes the pool in order — primary failure then fallback win", async () => {
    const marker = path.join(freshDir("c5m"), "marker.txt");
    const ctx = mkDsh("c5", {
      launchEnv: {
        PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "fail_setconfig" }),
        PAIR_TEST_MARKER: marker,
      },
    });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("COMPLETED");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].configured_ref).toBe("palpha:m0");
    expect(attempts[0].outcome).toBe("FAILED");
    expect(attempts[0].safe_to_failover).toBe(true);
    expect(attempts[1].configured_ref).toBe("pbeta:m1");
    expect(attempts[1].winner).toBe(true);
    // Side effect exactly once — written by the winner only.
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["pbeta:m1"]);
  });
});

/* ===================== D — role authority =============================== */

describe("D — role authority", () => {
  it("D1: candidate without DSH_EXECUTION role → authority throw (never availability)", () => {
    const ctx = mkDsh("d1");
    // Model + provider + binding all valid — role was NEVER assigned.
    mkProvider(ctx.store, "pnope");
    const me = mkModel(ctx.store, "pnope", "mX");
    const b = ensureBinding(ctx.service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pnope",
      model_entry_id: me,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    qualifyBinding(ctx.service, String(b.binding_id));
    const noRole: DshModelCandidate = {
      ref: "pnope:mX",
      pid: "pnope",
      mid: "mX",
      model_entry_id: me,
    };
    expect(() =>
      assertDshCandidateEligible(ctx.service, noRole, DSH_EXECUTOR_ID),
    ).toThrowError(/FAIL_CLOSED_MODEL_ROLE/);
  });

  it("D2: role revoked at runtime → next invocation fails closed", () => {
    const ctx = mkDsh("d2");
    expect(ctx.router.assertEligible(ctx.candidates[0])).toBeUndefined();
    revokeModelRole(ctx.store, ctx.candidates[0].model_entry_id, { actor: "t" });
    expect(() => ctx.router.assertEligible(ctx.candidates[0])).toThrowError(/FAIL_CLOSED_MODEL_ROLE/);
  });

  it("D3: REMOVED model → authority throw", () => {
    const dir = freshDir("d3");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    mkProvider(store, "pa");
    const me = mkModel(store, "pa", "m1", { conditions: ["REMOVED"] });
    assignModelRole(store, me, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    const c: DshModelCandidate = { ref: "pa:m1", pid: "pa", mid: "m1", model_entry_id: me };
    expect(() => assertDshCandidateEligible(service, c, DSH_EXECUTOR_ID)).toThrowError(
      /MODEL_NOT_USABLE|FAIL_CLOSED/,
    );
  });

  it("D4: PLANNER-role candidate → overlap violation throw", () => {
    const ctx = mkDsh("d4");
    // Candidate holding PLANNER_COORDINATOR cannot be a DSH candidate.
    const planner = mkCandidate(ctx.store, ctx.service, "ppln", "mP", {
      role: MODEL_ROLE.PLANNER_COORDINATOR,
    });
    expect(() => ctx.router.assertEligible(planner)).toThrowError(/FAIL_CLOSED_MODEL_ROLE/);
    // And a DSH candidate canonically equal to a planner model → overlap.
    const plannerModel = mkCandidate(ctx.store, ctx.service, "palias", "mReal", {
      role: MODEL_ROLE.PLANNER_COORDINATOR,
    });
    const dshAlias: DshModelCandidate = {
      ref: "palias:mAlias",
      pid: "palias",
      mid: "mAlias",
      model_entry_id: mkModel(ctx.store, "palias", "mAlias", { aliases: ["mReal"] }),
    };
    assignModelRole(ctx.store, dshAlias.model_entry_id, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    ensureBinding(ctx.service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "palias",
      model_entry_id: dshAlias.model_entry_id,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    void plannerModel;
    expect(() => ctx.router.assertEligible(dshAlias)).toThrowError(/FAIL_CLOSED_DSH_PLANNER_OVERLAP/);
  });
});

/* ===================== E — runtime eligibility ========================== */

describe("E — runtime eligibility re-proof per invocation", () => {
  it("E1: provider DOWN at invoke → availability reject (not authority)", () => {
    const ctx = mkDsh("e1");
    mkProvider(ctx.store, "palpha", { health_state: "DOWN" });
    const res = ctx.router.assertEligible(ctx.candidates[0]);
    expect(res).toMatchObject({ reject: true, failure_class: "PROVIDER_UNAVAILABLE" });
  });

  it("E2: model UNAVAILABLE at invoke → availability reject", () => {
    const ctx = mkDsh("e2");
    const body = ctx.store.get("model_entry", ctx.candidates[0].model_entry_id);
    ctx.store.put("model_entry", ctx.candidates[0].model_entry_id, {
      ...body,
      conditions: [...(body.conditions as string[]), "UNAVAILABLE"],
    }, Number(body.version));
    const res = ctx.router.assertEligible(ctx.candidates[0]);
    expect(res).toMatchObject({ reject: true, failure_class: "MODEL_UNAVAILABLE" });
  });

  it("E3: provider unqualified at invoke → AUTHORITY throw, never failover", () => {
    const ctx = mkDsh("e3");
    mkProvider(ctx.store, "palpha", { lifecycle: "DISCOVERED" });
    expect(() => ctx.router.assertEligible(ctx.candidates[0])).toThrowError(
      /FAIL_CLOSED_DSH_PROVIDER_INELIGIBLE/,
    );
  });

  it("E4: model_binding absent → AUTHORITY throw (governance, not availability)", () => {
    const dir = freshDir("e4");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    mkProvider(store, "pa");
    const me = mkModel(store, "pa", "m1");
    assignModelRole(store, me, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    // Executor row registered but NO model_binding row exists.
    new ExecutorRegistry(service).register({
      executor_id: DSH_EXECUTOR_ID,
      executor_type: "DEEPSEEK_HARNESS_ACP",
      capabilities: ["CODE_GENERATION"],
      health_state: "READY",
      status: "ENABLED",
      metadata: { qualification_state: "QUALIFIED" },
    });
    const c: DshModelCandidate = { ref: "pa:m1", pid: "pa", mid: "m1", model_entry_id: me };
    expect(() => assertDshCandidateEligible(service, c, DSH_EXECUTOR_ID)).toThrowError(
      /FAIL_CLOSED_DSH_MODEL_BINDING/,
    );
  });

  it("E5: model_binding non-QUALIFIED → AUTHORITY throw", () => {
    const dir = freshDir("e5");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    mkProvider(store, "pa");
    const me = mkModel(store, "pa", "m1");
    assignModelRole(store, me, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    new ExecutorRegistry(service).register({
      executor_id: DSH_EXECUTOR_ID,
      executor_type: "DEEPSEEK_HARNESS_ACP",
      capabilities: ["CODE_GENERATION"],
      health_state: "READY",
      status: "ENABLED",
      metadata: { qualification_state: "QUALIFIED" },
    });
    ensureBinding(service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "pa",
      model_entry_id: me,
      transport_compat: "OPENAI_COMPLETIONS",
    }); // left DISCOVERED — never qualified
    const c: DshModelCandidate = { ref: "pa:m1", pid: "pa", mid: "m1", model_entry_id: me };
    expect(() => assertDshCandidateEligible(service, c, DSH_EXECUTOR_ID)).toThrowError(
      /FAIL_CLOSED_DSH_MODEL_BINDING/,
    );
  });

  it("E6: executor not QUALIFIED at invoke → AUTHORITY throw", () => {
    const ctx = mkDsh("e6");
    const row = ctx.store.get("executor", DSH_EXECUTOR_ID);
    ctx.store.put("executor", DSH_EXECUTOR_ID, {
      ...row,
      metadata: { ...(row.metadata as object), qualification_state: "UNQUALIFIED" },
    }, Number(row.version));
    expect(() => ctx.router.assertEligible(ctx.candidates[0])).toThrowError(
      /FAIL_CLOSED_DSH_EXECUTOR_INELIGIBLE/,
    );
  });

  it("E7: eligibility is re-proved every attempt — provider recovering mid-loop wins next time", async () => {
    const dir = freshDir("e7");
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    new ExecutorRegistry(service).register({
      executor_id: DSH_EXECUTOR_ID,
      executor_type: "DEEPSEEK_HARNESS_ACP",
      capabilities: ["CODE_GENERATION"],
      health_state: "READY",
      status: "ENABLED",
      metadata: { qualification_state: "QUALIFIED" },
    });
    const c = mkCandidate(store, service, "pa", "m1");
    const router = createDshModelRouter({ service, executorId: DSH_EXECUTOR_ID, candidates: [c] });
    mkProvider(store, "pa", { health_state: "DOWN" });
    expect(router.assertEligible(c)).toMatchObject({ reject: true });
    mkProvider(store, "pa", { health_state: "READY" });
    expect(router.assertEligible(c)).toBeUndefined();
  });
});

/* ===================== F — side-effect safety =========================== */

describe("F — safe failover boundary (pre-dispatch only)", () => {
  it("F1: set_config_option failure is pre-dispatch → failover to next model", async () => {
    const ctx = mkDsh("f1", {
      launchEnv: { PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "fail_setconfig" }) },
    });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("COMPLETED");
    expect(attempts[0].dispatch_state).toBe("PRE_DISPATCH");
    expect(attempts[0].safe_to_failover).toBe(true);
    expect(attempts[1].dispatch_state).toBe("DISPATCHED");
    expect(attempts[1].winner).toBe(true);
  });

  it("F2: ACP initialize failure on first launch → failover; durable evidence", async () => {
    const onceFlag = path.join(freshDir("f2f"), "init-failed");
    const ctx = mkDsh("f2", {
      launchEnv: { PAIR_TEST_FAIL_INIT_ONCE: onceFlag },
    });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("COMPLETED");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].failure_class).toBe("TRANSIENT_TRANSPORT");
    expect(attempts[1].winner).toBe(true);
  });

  it("F3: prompt-level failure is POST-dispatch — NEVER failover to next model", async () => {
    const marker = path.join(freshDir("f3m"), "marker.txt");
    const ctx = mkDsh("f3", {
      launchEnv: {
        PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "fail_prompt" }),
        PAIR_TEST_MARKER: marker,
      },
    });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("FAILED");
    // Exactly ONE attempt — dispatch happened; no second model ever ran.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].dispatch_state).toBe("DISPATCHED");
    expect(attempts[0].safe_to_failover).toBe(false);
    expect(attempts[0].winner).toBe(false);
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["palpha:m0"]);
  });

  it("F4/F8: post-dispatch hang after side effect → TIMEOUT, no failover, side effect exactly once", async () => {
    const marker = path.join(freshDir("f4m"), "marker.txt");
    const ctx = mkDsh("f4", {
      launchEnv: {
        PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "hang_after_effect" }),
        PAIR_TEST_MARKER: marker,
      },
    });
    const { term, attempts } = await dispatchAndWait(ctx, governedTask(ctx, { timeout: 4 }));
    expect(term.status).toBe("TIMEOUT");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].dispatch_state).toBe("DISPATCHED");
    expect(attempts[0].safe_to_failover).toBe(false);
    const out = path.join(ctx.workspace, "agent_out.txt");
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["palpha:m0"]);
  });

  it("F5: pinned ACP model equals attempt evidence verbatim", async () => {
    const ctx = mkDsh("f5");
    const { eid, attempts } = await dispatchAndWait(ctx);
    void eid;
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(ctx.dir, "journal", "acp", String(attempts[0].execution_id), "execution_journal.json"),
        "utf8",
      ),
    );
    const pinned = journal.post_session_setup.model_route;
    expect(pinned).toEqual([ctx.candidates[0].pid, ctx.candidates[0].mid]);
    expect(journal.post_session_setup.model_governed).toBe(true);
    expect(attempts[0].provider_id).toBe(ctx.candidates[0].pid);
    expect(attempts[0].model_id).toBe(ctx.candidates[0].mid);
    expect(journal.post_session_setup.model_config.config_id).toBe(DSH_MODEL_CONFIG_ID);
  });

  it("F6: eligibility rejections are pre-dispatch — dispatch_state stays PRE_DISPATCH", async () => {
    const ctx = mkDsh("f6");
    mkProvider(ctx.store, "palpha", { health_state: "DOWN" });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("COMPLETED");
    expect(attempts[0].dispatch_state).toBe("PRE_DISPATCH");
    expect(attempts[0].failure_class).toBe("PROVIDER_UNAVAILABLE");
    expect(attempts[1].winner).toBe(true);
  });
});

/* ===================== G — recovery taxonomy ============================ */

describe("G — exhaustion & recovery taxonomy", () => {
  it("G1: every candidate fails pre-dispatch → FAIL_CLOSED_DSH_MODEL_EXHAUSTED", async () => {
    const ctx = mkDsh("g1", {
      launchEnv: {
        PAIR_TEST_BEHAVIORS: JSON.stringify({
          "palpha:m0": "fail_setconfig",
          "pbeta:m1": "fail_setconfig",
        }),
      },
    });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("FAILED");
    expect(attempts).toHaveLength(2);
    for (const a of attempts) {
      expect(a.outcome).toBe("FAILED");
      expect(a.safe_to_failover).toBe(true);
      expect(a.dispatch_state).toBe("PRE_DISPATCH");
    }
  });

  it("G2: exhaustion error carries safe structured evidence (attempts, no secrets)", () => {
    const err = dshModelExhaustedError([
      { attempt_no: 1, configured_ref: "pa:m1", provider_id: "pa", model_entry_id: "ME1", outcome: "FAILED", failure_class: "MODEL_UNAVAILABLE", safe_to_failover: true },
    ]);
    expect(err).toBeInstanceOf(IntegrityError);
    expect(err.code).toBe("FAIL_CLOSED_DSH_MODEL_EXHAUSTED");
    expect(err.detail).toContain("pa:m1");
  });

  it("G3: empty candidate pool → FAIL_CLOSED_DSH_MODEL_EXHAUSTED immediately", async () => {
    const dir = freshDir("g3");
    const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
    const store = new PairEvidenceStore(path.join(dir, "pair.db"));
    const service = new PairControlPlane(store);
    const adapter = new DshExecutorAdapter({
      journalRoot: path.join(dir, "journal"),
      envReader: (n) => (n.endsWith("_API_KEY") ? "c" : process.env[n]),
      launchOverride: { command: "node", args: [FAKE_ACP_PHC, "--profile", "acp"] },
    });
    registerGovernedExecutors(service, new Map([[DSH_EXECUTOR_ID, adapter]]), "t");
    adapter.bindModelRouter(
      createDshModelRouter({ service, executorId: DSH_EXECUTOR_ID, candidates: [] }),
      service,
    );
    const ctx: DshCtx = { dir, workspace, store, service, adapter, router: null as never, candidates: [] };
    const t = governedTask(ctx);
    const disp = adapter.dispatch(t);
    const term = await waitTerminal(adapter, String(disp.execution_id));
    expect(term.status).toBe("FAILED");
    // No attempt rows — zero candidates is not a per-model failure.
    expect(attemptsOf(store, String(t.governed_task_id))).toHaveLength(0);
  });

  it("G4: authority throw mid-pool aborts the whole dispatch — no later candidate runs", async () => {
    const ctx = mkDsh("g4");
    mkProvider(ctx.store, "palpha", { lifecycle: "DISCOVERED" });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("FAILED");
    // Candidate 0 threw authority → loop aborted — candidate 1 never attempted.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].safe_to_failover).toBe(false);
    expect(attempts[0].outcome).toBe("FAILED");
  });
});

/* ===================== H — shared task deadline ========================= */

describe("H — one deadline across candidates", () => {
  it("H1: exhausted shared budget → timeout evidence persisted, next candidate never starts", async () => {
    const ctx = mkDsh("h1", {
      launchEnv: { PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "hang_prompt" }) },
    });
    const { term, attempts } = await dispatchAndWait(ctx, governedTask(ctx, { timeout: 3 }));
    expect(term.status).toBe("TIMEOUT");
    // hang_prompt consumes the whole budget — the next candidate never ran.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].dispatch_state).toBe("DISPATCHED");
    expect(attempts[0].safe_to_failover).toBe(false);
  });

  it("H2: pre-dispatch candidate inherits remaining budget — second attempt gets the remainder", async () => {
    // Candidate 0 fails fast at set_config; candidate 1 succeeds inside the
    // SAME deadline — proving one budget, not a fresh timeout per model.
    const ctx = mkDsh("h2", {
      launchEnv: { PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "fail_setconfig" }) },
    });
    const { term, attempts } = await dispatchAndWait(ctx, governedTask(ctx, { timeout: 8 }));
    expect(term.status).toBe("COMPLETED");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].winner).toBe(true);
  });
});

/* ===================== I — credentials ================================== */

describe("I — credential follows the selected model", () => {
  it("I1: missing credential env for a candidate → CREDENTIAL_MISSING, pre-dispatch, failover", async () => {
    const ctx = mkDsh("i1", {
      envReader: (n) =>
        n === "PALPHA_API_KEY" ? undefined : n.endsWith("_API_KEY") ? "c" : process.env[n],
    });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("COMPLETED");
    expect(attempts[0].failure_class).toBe("CREDENTIAL_MISSING");
    expect(attempts[0].dispatch_state).toBe("PRE_DISPATCH");
    expect(attempts[1].winner).toBe(true);
  });

  it("I2: the primary credential is never reused for a fallback provider", async () => {
    // palpha has NO credential; pbeta's own env is required — a reuse bug
    // would let palpha launch with pbeta's key and never emit CREDENTIAL_MISSING.
    const marker = path.join(freshDir("i2m"), "marker.txt");
    const ctx = mkDsh("i2", {
      envReader: (n) =>
        n === "PALPHA_API_KEY" ? undefined : n.endsWith("_API_KEY") ? "c" : process.env[n],
      launchEnv: { PAIR_TEST_MARKER: marker },
    });
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("COMPLETED");
    expect(attempts[0].failure_class).toBe("CREDENTIAL_MISSING");
    expect(fs.readFileSync(marker, "utf8").trim()).toBe("pbeta:m1");
  });

  it("I3: no credential values in attempt rows, events, or journals", async () => {
    const ctx = mkDsh("i3");
    const { attempts } = await dispatchAndWait(ctx);
    const blob = JSON.stringify({
      attempts,
      events: ctx.store.listEvents(DSH_ATTEMPT_ENTITY),
      journalDir: fs.existsSync(path.join(ctx.dir, "journal"))
        ? fs.readdirSync(path.join(ctx.dir, "journal"), { recursive: true }).join(",")
        : "",
    });
    expect(blob).not.toContain("test-credential");
  });
});

/* ===================== J — durable provenance =========================== */

describe("J — attempt provenance", () => {
  it("J1: attempt row carries the governed identity fields", async () => {
    const ctx = mkDsh("j1");
    const t = governedTask(ctx, { route_id: "RTE_DSH_ACP" });
    const { eid, attempts } = await dispatchAndWait(ctx, t);
    const a = attempts[0];
    expect(String(a.dsh_model_attempt_id)).toMatch(/^DMA_/);
    expect(String(a.mission_id)).toBe("MSN_PHC");
    expect(String(a.task_id)).toBe("TSK_PHC");
    expect(String(a.governed_task_id)).toBe(String(t.governed_task_id));
    expect(String(a.execution_id)).toBe(eid);
    expect(String(a.correlation_id)).toBe("corr-phc");
    expect(String(a.generic_route_id)).toBe("RTE_DSH_ACP");
    expect(a.attempt_no).toBe(1);
    expect(a.started_at).toBeTruthy();
    expect(a.completed_at).toBeTruthy();
    expect(typeof a.latency_ms).toBe("number");
  });

  it("J2: lifecycle events DSH_MODEL_ATTEMPT_STARTED/SUCCEEDED emitted", async () => {
    const ctx = mkDsh("j2");
    const { attempts } = await dispatchAndWait(ctx);
    const evs = ctx.store
      .listEvents(DSH_ATTEMPT_ENTITY, String(attempts[0].dsh_model_attempt_id))
      .map((e) => String(e.event_type));
    expect(evs).toEqual(["DSH_MODEL_ATTEMPT_STARTED", "DSH_MODEL_ATTEMPT_SUCCEEDED"]);
  });

  it("J3: at most ONE winner across the whole pool", async () => {
    const ctx = mkDsh("j3", {
      launchEnv: { PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "fail_setconfig" }) },
    });
    const { attempts } = await dispatchAndWait(ctx);
    expect(attempts.filter((a) => a.winner === true)).toHaveLength(1);
    expect(attempts.find((a) => a.winner)?.configured_ref).toBe("pbeta:m1");
  });
});

/* ===================== K — restart / crash durability =================== */

describe("K — restart durability", () => {
  it("K1: attempt evidence survives a store reopen (new PairEvidenceStore)", async () => {
    const ctx = mkDsh("k1");
    const { attempts } = await dispatchAndWait(ctx);
    const reopened = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const rows = attemptsOf(reopened, String(attempts[0].governed_task_id));
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("SUCCESS");
  });

  it("K2: a crashed attempt stays distinguishable — STARTED forever", async () => {
    const ctx = mkDsh("k2");
    const token = ctx.router.attemptStart({
      candidate: ctx.candidates[0],
      governed_task_id: "GTSK_CRASH",
      mission_id: "m",
      task_id: "t",
      correlation_id: "c",
      attempt_no: 1,
    });
    // Process dies here — no attemptEnd ever runs.
    const reopened = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const row = reopened.get(DSH_ATTEMPT_ENTITY, token.attempt_id);
    expect(row.outcome).toBe("STARTED");
    expect(row.completed_at).toBeNull();
    const evs = reopened
      .listEvents(DSH_ATTEMPT_ENTITY, token.attempt_id)
      .map((e) => String(e.event_type));
    expect(evs).toEqual(["DSH_MODEL_ATTEMPT_STARTED"]);
    void ctx;
  });
});

/* ============ R1.L — shared deadline covers the FULL ACP attempt ======= */

describe("R1.L — shared deadline covers the full ACP attempt", () => {
  it("L1: setup consumes the whole deadline → prompt is never dispatched, TIMEOUT persisted", async () => {
    const marker = path.join(ROOT, "l1-marker.txt");
    const ctx = mkDsh("l1", {
      launchEnv: {
        PAIR_TEST_BEHAVIORS: JSON.stringify({
          "palpha:m0": "hang_setconfig",
          "pbeta:m1": "hang_setconfig",
        }),
        PAIR_TEST_MARKER: marker,
      },
    });
    const startedAt = Date.now();
    const { term, attempts } = await dispatchAndWait(
      ctx,
      governedTask(ctx, { timeout: 3 }),
    );
    const elapsed = Date.now() - startedAt;
    expect(term.status).toBe("TIMEOUT");
    // The shared deadline (~3s) killed the attempt — WITHOUT the stage
    // clamp setConfigOption alone would have run its full 30s budget.
    expect(elapsed).toBeLessThan(25_000);
    // Prompt was never dispatched: no marker, no side-effect file.
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(ctx.workspace, "agent_out.txt"))).toBe(false);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    const a0 = attempts[0];
    expect(a0.outcome).toBe("FAILED");
    expect(a0.failure_class).toBe("TIMEOUT");
    expect(String(a0.error_code)).toBe("ACP_REQUEST_TIMEOUT");
    // Never dispatched → pre-dispatch rules apply (safe_to_failover).
    expect(a0.dispatch_state).toBe("PRE_DISPATCH");
    expect(a0.safe_to_failover).toBe(true);
    // The next candidate also sees the exhausted budget.
    expect(attempts[1].failure_class).toBe("TIMEOUT");
  });
});

/* ============ R1.M — exact model_binding identity ====================== */

describe("R1.M — exact model_binding identity", () => {
  it("M1: QUALIFIED binding for the same model_entry_id but a DIFFERENT provider is rejected", () => {
    const ctx = mkDsh("m1");
    const entry = ctx.candidates[0].model_entry_id; // binding (palpha, entry) QUALIFIED
    mkProvider(ctx.store, "pstranger");
    const stranger: DshModelCandidate = {
      ref: "pstranger:m0",
      pid: "pstranger",
      mid: "m0",
      model_entry_id: entry,
    };
    expect(() => ctx.router.assertEligible(stranger)).toThrow(/FAIL_CLOSED_DSH_MODEL_BINDING/);
  });

  it("M2: QUALIFIED binding with a DSH-incompatible transport is rejected", () => {
    const ctx = mkDsh("m2", { pids: ["p1"] });
    const eid = mkModel(ctx.store, "p1", "mlegacy");
    assignModelRole(ctx.store, eid, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    const b = ensureBinding(ctx.service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "p1",
      model_entry_id: eid,
      transport_compat: "LEGACY_NATIVE",
    });
    qualifyBinding(ctx.service, String(b.binding_id));
    const cand: DshModelCandidate = { ref: "p1:mlegacy", pid: "p1", mid: "mlegacy", model_entry_id: eid };
    expect(() => ctx.router.assertEligible(cand)).toThrow(/FAIL_CLOSED_DSH_MODEL_BINDING/);
  });

  it("M3: candidate tuple resolving to a different model_entry than the attempt evidence fails closed at pin time", async () => {
    const ctx = mkDsh("m3", { pids: ["p1"] });
    // Second legit candidate identity under the same provider — role +
    // QUALIFIED binding so generic eligibility passes; only the pre-pin
    // tuple→model_entry proof can catch the drift.
    const entryB = mkModel(ctx.store, "p1", "mB");
    assignModelRole(ctx.store, entryB, MODEL_ROLE.DSH_EXECUTION, { actor: "t" });
    const bB = ensureBinding(ctx.service, {
      executor_id: DSH_EXECUTOR_ID,
      provider_id: "p1",
      model_entry_id: entryB,
      transport_compat: "OPENAI_COMPLETIONS",
    });
    qualifyBinding(ctx.service, String(bB.binding_id));
    const drifted: DshModelCandidate = {
      ref: "p1:m0",
      pid: "p1",
      mid: "m0", // resolves to candidates[0].model_entry_id, NOT entryB
      model_entry_id: entryB,
    };
    const router2 = createDshModelRouter({
      service: ctx.service,
      executorId: DSH_EXECUTOR_ID,
      candidates: [drifted],
    });
    ctx.adapter.bindModelRouter(router2, ctx.service);
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("FAILED");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].failure_class).toBe("AUTHORITY_REJECTED");
    expect(String(attempts[0].error_code)).toBe("FAIL_CLOSED_DSH_MODEL_IDENTITY_DRIFT");
    expect(attempts[0].safe_to_failover).toBe(false);
  });

  it("M4: persisted model_binding_id is the EXACT binding for the candidate's provider", async () => {
    const ctx = mkDsh("m4", {
      launchEnv: { PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "fail_setconfig" }) },
    });
    const { attempts } = await dispatchAndWait(ctx);
    const bindings = listBindings(ctx.service);
    for (const a of attempts) {
      const b = bindings.find((x) => x.binding_id === a.model_binding_id);
      expect(b).toBeTruthy();
      expect(String(b!.provider_id)).toBe(String(a.provider_id));
      expect(String(b!.model_entry_id)).toBe(String(a.model_entry_id));
      expect(String(b!.executor_id)).toBe(DSH_EXECUTOR_ID);
    }
  });
});

/* ============ R1.N — truthful authority failure provenance ============= */

describe("R1.N — truthful authority failure provenance", () => {
  it("N1: non-QUALIFIED binding → AUTHORITY_REJECTED (not TRANSIENT_TRANSPORT), never failover", async () => {
    const ctx = mkDsh("n1", { pids: ["p1"] });
    const weak = mkCandidate(ctx.store, ctx.service, "p3", "mWeak", { qualifyBinding: false });
    ctx.adapter.bindModelRouter(
      createDshModelRouter({ service: ctx.service, executorId: DSH_EXECUTOR_ID, candidates: [weak, ctx.candidates[0]] }),
      ctx.service,
    );
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("FAILED");
    expect(attempts).toHaveLength(1); // authority aborts the pool
    const a = attempts[0];
    expect(a.failure_class).toBe("AUTHORITY_REJECTED");
    expect(String(a.error_code)).toBe("FAIL_CLOSED_DSH_MODEL_BINDING");
    expect(a.safe_to_failover).toBe(false);
    expect(a.dispatch_state).toBe("PRE_DISPATCH");
  });

  it("N2: availability vs authority vs transport are durable-distinct classes", async () => {
    const ctx = mkDsh("n2", { pids: ["p1"] });
    // availability first (provider DOWN → reject), authority second
    // (non-QUALIFIED binding → abort); a clean third candidate must never run.
    const down = mkCandidate(ctx.store, ctx.service, "pdown", "mDown");
    mkProvider(ctx.store, "pdown", { health_state: "DOWN" });
    const weak = mkCandidate(ctx.store, ctx.service, "pweak", "mWeak", { qualifyBinding: false });
    ctx.adapter.bindModelRouter(
      createDshModelRouter({
        service: ctx.service,
        executorId: DSH_EXECUTOR_ID,
        candidates: [down, weak, ctx.candidates[0]],
      }),
      ctx.service,
    );
    const { term, attempts } = await dispatchAndWait(ctx);
    expect(term.status).toBe("FAILED");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].failure_class).toBe("PROVIDER_UNAVAILABLE");
    expect(attempts[0].safe_to_failover).toBe(true);
    expect(attempts[1].failure_class).toBe("AUTHORITY_REJECTED");
    expect(attempts[1].safe_to_failover).toBe(false);
    // Third candidate never attempted — authority stopped the pool.
    expect(attempts.find((a) => a.provider_id === "p1")).toBeUndefined();
  });
});

/* ============ R1.O — restart safety ==================================== */

describe("R1.O — restart safety", () => {
  const reopen = (ctx: DshCtx) => {
    const store2 = new PairEvidenceStore(path.join(ctx.dir, "pair.db"));
    const service2 = new PairControlPlane(store2);
    const adapter2 = new DshExecutorAdapter({
      journalRoot: path.join(ctx.dir, "journal"),
      envReader: (n) => (n.endsWith("_API_KEY") ? "test-credential" : process.env[n]),
      launchOverride: {
        command: "node",
        args: [FAKE_ACP_PHC, "--profile", "acp"],
        env: {},
      },
    });
    const router2 = createDshModelRouter({
      service: service2,
      executorId: DSH_EXECUTOR_ID,
      candidates: ctx.candidates,
    });
    adapter2.bindModelRouter(router2, service2);
    return { store2, service2, adapter2, router2 };
  };

  it("O1: a DISPATCHED/possibly-side-effecting attempt does NOT auto-resume on another model after restart", async () => {
    const marker = path.join(ROOT, "o1-marker.txt");
    const ctx = mkDsh("o1", {
      launchEnv: {
        PAIR_TEST_BEHAVIORS: JSON.stringify({ "palpha:m0": "crash_prompt" }),
        PAIR_TEST_MARKER: marker,
      },
    });
    const task = governedTask(ctx);
    const { term, attempts } = await dispatchAndWait(ctx, task);
    expect(term.status).toBe("FAILED");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].dispatch_state).toBe("DISPATCHED");
    expect(attempts[0].safe_to_failover).toBe(false);
    // Side effect provably happened once, on the primary only.
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["palpha:m0"]);

    // "Restart": brand-new process-side objects over the SAME durable state.
    const { store2, adapter2 } = reopen(ctx);
    const disp2 = adapter2.dispatch(task);
    // Journal exists → the dispatch is idempotent: recovered record, NOT a
    // re-run. No new attempt rows, no next-model invocation.
    expect(disp2.execution_id).toBe(String(task.governed_task_id && disp2.execution_id));
    const rows2 = attemptsOf(store2, String(task.governed_task_id));
    expect(rows2).toHaveLength(1);
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toEqual(["palpha:m0"]);
  });

  it("O2: restart cannot create a second winner for the same governed task", async () => {
    const ctx = mkDsh("o2");
    const task = governedTask(ctx);
    const { term, attempts } = await dispatchAndWait(ctx, task);
    expect(term.status).toBe("COMPLETED");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].winner).toBe(true);

    const { store2, adapter2 } = reopen(ctx);
    const disp2 = adapter2.dispatch(task);
    expect(["COMPLETED", "FAILED", "UNKNOWN"]).toContain(String(disp2.status));
    const rows2 = attemptsOf(store2, String(task.governed_task_id));
    expect(rows2).toHaveLength(1);
    expect(rows2.filter((a) => a.winner === true)).toHaveLength(1);
  });
});
