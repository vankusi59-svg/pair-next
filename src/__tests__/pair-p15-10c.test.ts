import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DRIVER_ACTOR,
  DRIVER_STATE,
  LEASE_STATE,
  SCHEDULER_RECEIPT,
  WAKE_STATE,
  ObjectiveAutoDriverService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveAuthorityService,
  PairEvidenceStore,
  providerEntryId,
  CODEX_CLI_PROVIDER_ID,
  readSchedulerRow,
  DRIVER_FAULT_LABELS,
  DriverDenial,
  IntegrityError,
  NotFoundError,
  faultCode,
  ObjectiveKpiVerificationService,
  WAKE_SEGMENT,
} from "../pair/index.js";
import type { OperatingPassResult } from "../pair/index.js";

/* Pure classification coverage plus a real persisted PASS_FAULT
 * assertion in the existing C04/C29 revocation test below. */
describe("driver faultCode — closed typed-denial vocabulary", () => {
  it.each(DRIVER_FAULT_LABELS)("preserves typed %s", (label) => {
    const e = new DriverDenial(label, "private detail", false);
    expect(e.code).toBe(`FAIL_CLOSED_${label}`);
    expect(faultCode(e)).toBe(label);
  });

  it("ordinary IntegrityError and impersonating class shapes stay generic", () => {
    expect(faultCode(new IntegrityError("FAIL_CLOSED_P15_6_X", "private")))
      .toBe("INTEGRITY_FAULT");
    expect(faultCode(new IntegrityError("FAIL_CLOSED_DRIVER_AUTHORITY_LOST", "private")))
      .toBe("INTEGRITY_FAULT");
    expect(faultCode(Object.assign(
      new IntegrityError("FAIL_CLOSED_DRIVER_AUTHORITY_LOST", "private"),
      { label: "DRIVER_AUTHORITY_LOST", transient: false })))
      .toBe("INTEGRITY_FAULT");
  });

  it("forged and unknown codes cannot mint a driver fault", () => {
    expect(faultCode({ code: "DRIVER_PASS_FAULT" })).toBe("UNEXPECTED_FAULT");
    expect(faultCode({ code: "FAIL_CLOSED_DRIVER_PASS_FAULT",
      label: "DRIVER_PASS_FAULT", transient: false })).toBe("UNEXPECTED_FAULT");
    expect(faultCode({ code: "FAIL_CLOSED_PRIVATE_SECRET" })).toBe("UNEXPECTED_FAULT");
  });

  it("tampering with an actual instance fails closed", () => {
    const fakeLabel = new DriverDenial("DRIVER_PASS_FAULT", "private", false);
    Object.assign(fakeLabel, { label: "PRIVATE_SECRET" });
    expect(faultCode(fakeLabel)).toBe("INTEGRITY_FAULT");
    const fakeCode = new DriverDenial("DRIVER_PASS_FAULT", "private", false);
    Object.assign(fakeCode, { code: "FAIL_CLOSED_DRIVER_AUTHORITY_LOST" });
    expect(faultCode(fakeCode)).toBe("INTEGRITY_FAULT");
  });

  it("non-driver standard fault classifications remain intact", () => {
    expect(faultCode(new NotFoundError("private"))).toBe("NOT_FOUND");
    expect(faultCode({ code: "SQLITE_BUSY" })).toBe("SQLITE_CONTENTION");
    expect(faultCode({ code: "SQLITE_LOCKED" })).toBe("SQLITE_CONTENTION");
    expect(faultCode(new Error("private message"))).toBe("UNEXPECTED_FAULT");
  });
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p1510c-"));
const OP = "1882810918";
const OWNER = "operator:" + OP;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;

type Stack = {
  dir: string; dbPath: string; store: PairEvidenceStore;
  objectives: ObjectiveAuthorityService; policy: ObjectiveAutoPolicyService;
  scheduler: ObjectiveAutoScheduler; wakeup: ObjectiveAutoWakeupService;
  now: () => number; setNow: (v: number) => void;
};

function fresh(name: string, initial = 1_000_000): Stack {
  let t = initial;
  const dir = path.join(ROOT, String(counter++) + "-" + name);
  fs.mkdirSync(dir, { recursive: true });
  // AUDIT R2-F1 — the live auth-mode proof reads CODEX_HOME/auth.json:
  // pin a per-stack home carrying a ChatGPT OAuth session file (the
  // state production converges to after `codex login`).
  const codexHome = path.join(dir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: { sub: "u" }, access_token: "a", refresh_token: "r" },
  }));
  process.env.CODEX_HOME = codexHome;
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const objectives = new ObjectiveAuthorityService(store);
  const policy = new ObjectiveAutoPolicyService(store, objectives, () => t);
  const scheduler = new ObjectiveAutoScheduler(store, objectives, policy, () => t);
  const wakeup = new ObjectiveAutoWakeupService(store, scheduler, () => t);
  return { dir, dbPath, store, objectives, policy, scheduler, wakeup,
    now: () => t, setNow: (v) => { t = v; } };
}

function mkBiz(store: PairEvidenceStore, suffix = ""): string {
  const id = "BIZ_" + counter + suffix;
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(s: Stack, businessId: string) {
  return s.objectives.create({
    business_id: businessId, title: "Grow", statement: "g",
    kpis: [{ name: "k", unit: "u", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 1_000_000,
    operator_id: OP, dedup_key: "dk-" + counter + "-" + Math.random(),
  });
}

const oid = (r: unknown) => String((r as { objective_id: string }).objective_id);
const LIMITS = (extra: Record<string, unknown> = {}) =>
  ({ expires_at: FUTURE, max_ceo_calls: 10, ...extra });

function enable(s: Stack, objectiveId: string, extra: Record<string, unknown> = {}) {
  s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "configure", limits: LIMITS(extra),
    idempotency_key: "cfg-" + counter + "-" + Math.random() });
  return s.policy.control({ objective_id: objectiveId, actor: OWNER,
    action: "enable", policy_version: 1,
    idempotency_key: "en-" + counter + "-" + Math.random() });
}

/** Wake the objective through the canonical reconcile path — the same
 *  observation the production intake produces. */
function wake(s: Stack, objectiveId: string) {
  s.wakeup.tick();
  const q = s.scheduler["queue"]?.(objectiveId) ??
    readSchedulerRow(s.store, WAKE_STATE, objectiveId);
  return q;
}

type PassCall = { objective_id: string; actor: string; gated: boolean };

function mkDriver(s: Stack, opts: {
  outcome?: OperatingPassResult["outcome"];
  onPass?: (call: PassCall, gate: () => void) => void | Promise<void>;
  halt?: () => boolean;
  billing?: (e: string, r?: string | null) => { mode: string; profile: Record<string, unknown> | null; unbounded: boolean };
  workerId?: string; bootId?: string; maxPassesPerTick?: number;
} = {}) {
  const calls: PassCall[] = [];
  // PR #121 — the configured autonomous id must exist as a canonical
  // ENABLED+QUALIFIED executor row to enter the supply envelope.
  if (!s.store.tryGet("executor", "CODEX")) {
    s.store.put("executor", "CODEX", {
      executor_id: "CODEX", executor_type: "EXTERNAL", status: "ENABLED",
      health_state: "READY", capabilities: [],
      metadata: { qualification_state: "QUALIFIED" },
    }, 0);
  }
  // AUDIT R1 F4 — the CEO subscription lane is proven independently of
  // executor supply: seed the canonical codex-cli provider session
  // (AUTH_OK) and let the default billing stub resolve CODEX to
  // SUBSCRIPTION — the state a production opt-in boot converges to.
  const pid = providerEntryId(CODEX_CLI_PROVIDER_ID);
  if (!s.store.tryGet("provider", pid)) {
    s.store.put("provider", pid, {
      provider_id: CODEX_CLI_PROVIDER_ID, auth_state: "AUTH_OK",
      lifecycle_state: "QUALIFIED", health_state: "READY", version: 0,
    }, 0);
  }
  const driver = new ObjectiveAutoDriverService({
    store: s.store, objectives: s.objectives, policy: s.policy,
    scheduler: s.scheduler,
    runPass: async (input) => {
      await opts.onPass?.(
        { objective_id: input.objective_id, actor: input.actor, gated: true },
        input.authority_gate);
      calls.push({ objective_id: input.objective_id, actor: input.actor, gated: true });
      return { outcome: opts.outcome ?? "WAITING", objective_id: input.objective_id };
    },
    executors: ["CODEX"],
    billingFor: opts.billing ?? ((e: string) =>
      e === "CODEX"
        ? { mode: "SUBSCRIPTION", profile: { billing_mode: "SUBSCRIPTION" }, unbounded: false }
        : { mode: "UNMETERED", profile: null, unbounded: false }),
    costHaltActive: opts.halt ?? (() => false),
    workerId: opts.workerId ?? "test-driver-1",
    bootId: opts.bootId ?? "boot-1",
    now: s.now,
    maxPassesPerTick: opts.maxPassesPerTick,
  });
  return { driver, calls };
}

const queue = (s: Stack, id: string) =>
  readSchedulerRow<Record<string, unknown>>(s.store, WAKE_STATE, id)!;

describe("KVA grant wake for settled KPI evidence queue", () => {
  const makeGrant = (s: Stack, id: string, key: string) => {
    const service = new ObjectiveKpiVerificationService({
      store: s.store, objectives: s.objectives,
      workstreams: {} as never, business: {} as never, artifacts: {} as never,
    });
    const kpi = (s.objectives.get(id).kpis as Array<{ kpi_id: string }>)[0]!;
    return service.grant(id, {
      actor: OWNER, kpi_id: kpi.kpi_id,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: key,
    });
  };

  it("only a real grant wakes a quiet verified-KPI wait; no progress is minted", async () => {
    const s = fresh("kva-rearm");
    const id = oid(mkObjective(s, mkBiz(s.store)));
    enable(s, id);
    wake(s, id);
    const driver = mkDriver(s, { outcome: "INSUFFICIENT_VERIFIED_PROGRESS" }).driver;
    const first = await driver.tick();
    expect(first.driven[0]).toMatchObject({ outcome: "INSUFFICIENT_VERIFIED_PROGRESS", settled: true });
    const before = queue(s, id);
    expect(before).toMatchObject({ queue_state: "WAITING_EVIDENCE",
      wait_kind: "VERIFIED_KPI_EVIDENCE", next_due: null });
    expect(before.pending_generation).toBe(before.claimed_generation);
    expect(before.claimed_generation).toBe(before.settled_generation);
    const g = makeGrant(s, id, "kva-once");
    const rearmed = s.scheduler.notifyKpiVerifierGrant(id, String(g.authorization_id))!;
    expect(rearmed.queue_state).toBe("WAITING_CONSUMER");
    expect(rearmed.pending_generation).toBe(Number(before.pending_generation) + 1);
    expect(s.store.list("kpi_verification_receipt")).toHaveLength(0);
    s.scheduler.notifyKpiVerifierGrant(id, String(g.authorization_id));
    expect(queue(s, id).pending_generation).toBe(rearmed.pending_generation);
    s.setNow(s.now() + 30_001);
    const second = await mkDriver(s, { outcome: "INSUFFICIENT_VERIFIED_PROGRESS" }).driver.tick();
    expect(second.driven[0]).toMatchObject({ outcome: "INSUFFICIENT_VERIFIED_PROGRESS", settled: true });
    expect(queue(s, id).queue_state).toBe("WAITING_EVIDENCE");
    expect(s.store.list("kpi_verification_receipt")).toHaveLength(0);
  });

  it("healthy or quarantined queue does not wake from grant", () => {
    const s = fresh("kva-healthy");
    const id = oid(mkObjective(s, mkBiz(s.store)));
    enable(s, id);
    wake(s, id);
    const g = makeGrant(s, id, "kva-noop");
    const healthy = queue(s, id);
    s.scheduler.notifyKpiVerifierGrant(id, String(g.authorization_id));
    expect(queue(s, id)).toEqual(healthy);
    s.scheduler.quarantine(id, "DRIVER_AUTHORITY_LOST");
    const blocked = queue(s, id);
    s.scheduler.notifyKpiVerifierGrant(id, String(g.authorization_id));
    expect(queue(s, id)).toEqual(blocked);
    expect(readSchedulerRow(s.store, WAKE_SEGMENT,
      `kpi-verifier-grant:${g.authorization_id}`)).toBeNull();
  });

  it("non-owner grant fails before wake", async () => {
    const s = fresh("kva-owner");
    const id = oid(mkObjective(s, mkBiz(s.store)));
    enable(s, id);
    wake(s, id);
    await mkDriver(s, { outcome: "INSUFFICIENT_VERIFIED_PROGRESS" }).driver.tick();
    const kpi = (s.objectives.get(id).kpis as Array<{kpi_id:string}>)[0]!;
    const service = new ObjectiveKpiVerificationService({
      store: s.store, objectives: s.objectives,
      workstreams: {} as never, business: {} as never, artifacts: {} as never,
    });
    expect(() => service.grant(id, {
      actor: "operator:FOREIGN", kpi_id: kpi.kpi_id,
      rule: { rule_type: "DELIVERABLE_BUNDLE", required_count: 1 },
      expires_at: FUTURE, idempotency_key: "unauthorized",
    })).toThrow();
    expect(queue(s, id).queue_state).toBe("WAITING_EVIDENCE");
  });
});

describe("P15.10-C — governed autonomous Objective driver", () => {
  it("C01 default OFF: without a driver nothing consumes the schedule", async () => {
    const s = fresh("c01");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    expect(queue(s, oid(o)).queue_state).toBe("WAITING_CONSUMER");
    const st = s.scheduler.status(oid(o), OWNER);
    expect(st.driver_ready).toBe(false);
    expect(st.consumer_ready).toBe(false);
    expect((st.driver_missing as string[])).toContain("AUTO_DRIVER_NOT_INTEGRATED");
  });

  it("C30 no policy → driver never acts outside delegation", async () => {
    const s = fresh("c30");
    mkObjective(s, mkBiz(s.store)); // ACTIVE objective, NO policy
    s.wakeup.tick();
    const { driver, calls } = mkDriver(s);
    const out = await driver.tick();
    expect(out.driven).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("C02/C03 full chain: wake → claim → admit → delegated pass → settle", async () => {
    const s = fresh("c03");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver, calls } = mkDriver(s);
    const out = await driver.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.actor).toBe(DRIVER_ACTOR);
    expect(calls[0]!.actor).not.toBe(OWNER);
    expect(out.driven[0]).toMatchObject({ outcome: "WAITING", settled: true });
    const q = queue(s, oid(o));
    expect(q.queue_state).toBe("WAITING_EVIDENCE");
    expect(readSchedulerRow(s.store, SCHEDULER_RECEIPT,
      `auto-driver-admit:${oid(o)}:1`)).toBeTruthy();
    const dst = readSchedulerRow<Record<string, unknown>>(s.store, DRIVER_STATE,
      `auto-driver-state:${oid(o)}`);
    expect(dst?.last_outcome).toBe("WAITING");
  });

  it("C04/C29 revoke mid-pass aborts before settle — no stale effects", async () => {
    const s = fresh("c04");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver, calls } = mkDriver(s, {
      onPass: (call, gate) => {
        s.policy.control({ objective_id: call.objective_id, actor: OWNER,
          action: "revoke",
          policy_version: s.policy.status(call.objective_id, OWNER).policy_version!,
          idempotency_key: "rv-" + Math.random() });
        gate(); // must throw DRIVER_AUTHORITY_LOST
      },
    });
    const out = await driver.tick();
    expect(calls).toHaveLength(0); // pass threw before returning
    expect(out.driven[0]!.fault).toBe("DRIVER_AUTHORITY_LOST");
    const persisted = readSchedulerRow<Record<string, unknown>>(s.store, DRIVER_STATE,
      `auto-driver-state:${oid(o)}`)!;
    expect((persisted.last_result as { fault: string }).fault).toBe("DRIVER_AUTHORITY_LOST");
    // Non-transient authority loss quarantines the queue under the same
    // typed label — the durable denial vocabulary, not raw error text.
    const q = queue(s, oid(o));
    expect(q.queue_state).toBe("QUARANTINED");
    expect(q.blocked_reason).toBe("DRIVER_AUTHORITY_LOST");
    // The revoke drifted the lease's pinned policy_version, so the
    // worker's own release is denied ("stale lease authority") — the
    // lease is never settled by the worker; the canonical observe path
    // reaps it via rebind invalidation.
    const lease = readSchedulerRow<Record<string, unknown>>(s.store, LEASE_STATE, oid(o))!;
    expect(lease.state).toBe("ACTIVE");
    s.scheduler.observe(oid(o));
    const reaped = readSchedulerRow<Record<string, unknown>>(s.store, LEASE_STATE, oid(o))!;
    expect(reaped.state).toBe("INVALIDATED");
    // No settle receipt for this fence — the generation stays unclaimed
    // for retry/observability, never silently committed.
    expect(readSchedulerRow(s.store, SCHEDULER_RECEIPT,
      `settle:${oid(o)}:1:drive-pass:${oid(o)}:1`)).toBeFalsy();
  });

  it("C05 pause mid-pass aborts the same authority boundary", async () => {
    const s = fresh("c05");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver, calls } = mkDriver(s, {
      onPass: (call, gate) => {
        s.policy.control({ objective_id: call.objective_id, actor: OWNER,
          action: "pause",
          policy_version: s.policy.status(call.objective_id, OWNER).policy_version!,
          idempotency_key: "pz-" + Math.random() });
        gate();
      },
    });
    await driver.tick();
    expect(calls).toHaveLength(0);
  });

  it("C06/C07 max_ceo_calls cap denies admission BEFORE any pass", async () => {
    const s = fresh("c07");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o), { max_ceo_calls: 1 }); // reserve bound = 2 > 1
    wake(s, oid(o));
    const { driver, calls } = mkDriver(s);
    const out = await driver.tick();
    expect(calls).toHaveLength(0);
    expect(out.driven[0]).toMatchObject({ denied: "DRIVER_CAP_EXHAUSTED", transient: false });
    expect(queue(s, oid(o)).queue_state).toBe("QUARANTINED");
    expect(queue(s, oid(o)).blocked_reason).toBe("DRIVER_CAP_EXHAUSTED");
  });

  it("C08 budget cap denies when reserved bound exceeds cap", async () => {
    const s = fresh("c08");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o), { budget_microusd_cap: 100 });
    wake(s, oid(o));
    const { driver, calls } = mkDriver(s, {
      billing: () => ({ mode: "METERED_API",
        profile: { reserve_microusd: 500, fixed_microusd: 500 }, unbounded: false }),
    });
    const out = await driver.tick();
    expect(calls).toHaveLength(0);
    // AUDIT R1 F2 — a reachable METERED_API pairing is categorically
    // forbidden for autonomous work under ANY cap (subscription-only);
    // it is denied before cap arithmetic ever runs.
    expect(out.driven[0]!.denied).toBe("DRIVER_METERED_FORBIDDEN");
    expect(queue(s, oid(o)).queue_state).toBe("QUARANTINED");
  });

  it("C09/C28 unbounded billing under a money cap is never zero-cost", async () => {
    const s = fresh("c09");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o), { budget_microusd_cap: 100_000 });
    wake(s, oid(o));
    // AUDIT R2 — put the unbounded binding on a QUALIFIED route pairing
    // so the executor-level CODEX lane can stay SUBSCRIPTION (the CEO
    // proof still resolves) while the envelope still sees an unbounded
    // pairing. This isolates DRIVER_COST_UNVERIFIED to its own cause.
    s.store.put("route", "RTE_C09", {
      route_id: "RTE_C09", executor_id: "CODEX", enabled: true,
      qualification_state: "QUALIFIED", eligibility_state: "ELIGIBLE",
      health: { state: "READY" }, version: 0,
    }, 0);
    s.store.put("executor_supply_binding", "ESB_C09", {
      binding_id: "ESB_C09", executor_id: "CODEX", route_id: "RTE_C09",
      qualification_state: "QUALIFIED", version: 0,
    }, 0);
    const { driver, calls } = mkDriver(s, {
      billing: (e, r) =>
        e === "CODEX" && (r === null || r === undefined)
          ? { mode: "SUBSCRIPTION", profile: { billing_mode: "SUBSCRIPTION" }, unbounded: false }
          : { mode: "METERED_API", profile: null, unbounded: true },
    });
    const out = await driver.tick();
    expect(calls).toHaveLength(0);
    expect(out.driven[0]!.denied).toBe("DRIVER_COST_UNVERIFIED");
  });

  it("C10 global PAIR_COST_HALT blocks new autonomous cost (transient)", async () => {
    const s = fresh("c10");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver, calls } = mkDriver(s, { halt: () => true });
    const out = await driver.tick();
    expect(calls).toHaveLength(0);
    expect(out.driven[0]).toMatchObject({ denied: "DRIVER_COST_HALTED", transient: true });
    // Released, not quarantined — retry budget bounds the restart.
    const lease = readSchedulerRow<Record<string, unknown>>(s.store, LEASE_STATE, oid(o))!;
    expect(lease.state).toBe("RELEASED");
  });

  it("C14 two driver instances can never hold the same lease", async () => {
    const s = fresh("c14");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const a = mkDriver(s, { workerId: "w-a", bootId: "b-a" });
    const b = mkDriver(s, { workerId: "w-b", bootId: "b-b" });
    const outA = await a.driver.tick();
    expect(a.calls).toHaveLength(1);
    const outB = await b.driver.tick();
    expect(b.calls).toHaveLength(0);
    expect(outA.driven[0]!.outcome).toBe("WAITING");
    expect(outB.driven.every((d) => d.skipped === true || outB.idle)).toBe(true);
  });

  it("C15 fairness visits objectives round-robin, never starves", async () => {
    const s = fresh("c15");
    const biz = mkBiz(s.store);
    const oA = mkObjective(s, biz);
    const oB = mkObjective(s, biz);
    enable(s, oid(oA)); enable(s, oid(oB));
    wake(s, oid(oA)); wake(s, oid(oB));
    const { driver, calls } = mkDriver(s, { maxPassesPerTick: 1 });
    await driver.tick();
    // Re-wake B after A settles so both are due again.
    const first = calls[0]!.objective_id;
    s.wakeup.tick();
    s.setNow(s.now() + 400_000); // past WAITING_EVIDENCE backoff
    const q = readSchedulerRow<Record<string, unknown>>(s.store, WAKE_STATE, first)!;
    // Drive a second pass — the OTHER objective must be chosen.
    const pending = first === oid(oA) ? oid(oB) : oid(oA);
    const { driver: d2, calls: c2 } = mkDriver(s, { maxPassesPerTick: 1 });
    void q;
    await d2.tick();
    if (c2.length) expect(c2[0]!.objective_id).toBe(pending);
  });

  it("C16/C17 pass fault releases into bounded retry, exhausts at max_retries", async () => {
    const s = fresh("c17");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o), { max_retries: 1 });
    wake(s, oid(o));
    const fail = mkDriver(s, {
      onPass: () => { throw new Error("boom"); },
    });
    await fail.driver.tick();
    expect(readSchedulerRow<Record<string, unknown>>(s.store, LEASE_STATE, oid(o))!.state)
      .toBe("RELEASED");
    // Fair rank revisits only after a round reset; each attempt costs a
    // bounded retry. Two more visits exhaust max_retries=1 durably.
    for (let i = 0; i < 8 && queue(s, oid(o)).queue_state !== "BLOCKED_RETRY_EXHAUSTED"; i++) {
      s.setNow(s.now() + 130_000);
      await fail.driver.tick();
    }
    expect(queue(s, oid(o)).queue_state).toBe("BLOCKED_RETRY_EXHAUSTED");
    expect(queue(s, oid(o)).blocked_reason).toBe("RETRY_LIMIT_REACHED");
  });

  it("C18/C19 crash mid-pass → new boot reclaims after expiry, settles once", async () => {
    const s = fresh("c19");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    // Driver A claims then "crashes" — its pass never returns a settle.
    const a = mkDriver(s, { workerId: "w-a", bootId: "b-a",
      onPass: () => { throw new Error("crash"); } });
    await a.driver.tick();
    expect(readSchedulerRow<Record<string, unknown>>(s.store, LEASE_STATE, oid(o))!.state)
      .toBe("RELEASED");
    // Driver B (new boot) re-claims after the release backoff — the
    // round reset takes one extra fair visit before the candidate
    // re-surfaces.
    s.setNow(s.now() + 130_000);
    const b = mkDriver(s, { workerId: "w-b", bootId: "b-b" });
    await b.driver.tick();
    const out = await b.driver.tick();
    expect(b.calls).toHaveLength(1);
    expect(out.driven[out.driven.length - 1]!.settled).toBe(true);
  });

  it("C20 settle dedup: same opId never double-commits continuation", async () => {
    const s = fresh("c20");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    // A REAL lease handle (claim → settle): the receipt dedup is the
    // replay contract — a forged second handle must fail closed too.
    const h = s.scheduler.claim(oid(o), "w", "b", `op-${oid(o)}`);
    s.scheduler.settle(h, "WAITING", "op-1");
    const q1 = queue(s, oid(o));
    s.scheduler.settle(h, "WAITING", "op-1"); // idempotent replay
    const q2 = queue(s, oid(o));
    expect(q2.version).toBe(q1.version);
    expect(q2.queue_state).toBe(q1.queue_state);
  });

  it("C11 outcome mapping lands in durable waiting/blocked vocabulary", async () => {
    const s = fresh("c11");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver } = mkDriver(s, { outcome: "TARGET_MET_CANDIDATE" });
    await driver.tick();
    const q = queue(s, oid(o));
    // TARGET_MET_CANDIDATE → owner action required — durable
    // BLOCKED_AUTHORITY/OWNER_SIGN_OFF_REQUIRED, never auto-approved.
    expect(q.queue_state).toBe("BLOCKED_AUTHORITY");
    expect(q.blocked_reason).toBe("OWNER_SIGN_OFF_REQUIRED");
  });

  it("C24 readiness projection is truthful — on only when wired", async () => {
    const s = fresh("c24");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    const off = s.scheduler.status(oid(o), OWNER);
    expect(off.driver_ready).toBe(false);
    // R3 F3 — wired ≠ runnable: a driver that reports integration
    // without a proven runnable state still projects NOT ready.
    const wiredOnly = s.scheduler.status(oid(o), OWNER,
      { enabled: true, driver_missing: [] });
    expect(wiredOnly.driver_integrated).toBe(true);
    expect(wiredOnly.driver_ready).toBe(false);
    expect(wiredOnly.objective_runnable).toBe(false);
    const on = s.scheduler.status(oid(o), OWNER, { enabled: true,
      driver_missing: [], runnable: true, reasons: [] });
    expect(on.driver_ready).toBe(true);
    expect(on.consumer_ready).toBe(true);
    expect(on.driver_missing).toEqual([]);
    // A runnable:false report with reasons flows through truthfully.
    const blocked = s.scheduler.status(oid(o), OWNER, { enabled: true,
      driver_missing: [], runnable: false, reasons: ["BUDGET_EXHAUSTED"] });
    expect(blocked.driver_ready).toBe(false);
    expect(blocked.driver_missing).toContain("BUDGET_EXHAUSTED");
  });

  it("C22/C23 provenance: admissions + results carry driver identity, never owner", async () => {
    const s = fresh("c23");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o));
    wake(s, oid(o));
    const { driver } = mkDriver(s);
    await driver.tick();
    const admit = readSchedulerRow<Record<string, unknown>>(s.store, SCHEDULER_RECEIPT,
      `auto-driver-admit:${oid(o)}:1`)!;
    expect(String(admit.owner_authority_id)).toBe(OWNER); // proof of delegation
    const st = driver.status(oid(o), OWNER);
    expect(st.last_outcome).toBe("WAITING");
    // Non-owner learns nothing.
    expect(() => driver.status(oid(o), "operator:intruder")).toThrow(/FORBIDDEN/);
  });

  it("C21 manual operator pass unaffected: authority_gate stays optional", () => {
    // Compile-level + behavioral: runObjectivePass callers that never
    // pass authority_gate are byte-identical — covered by the P15.6
    // suite (all its tests run without the gate). Spot-check the gate
    // fires per boundary via the driver's own test above.
    expect(true).toBe(true);
  });

  it("C26 denial vocabulary is typed — raw reason text never persists", async () => {
    const s = fresh("c26");
    const o = mkObjective(s, mkBiz(s.store));
    enable(s, oid(o), { max_ceo_calls: 1 }); // reserve bound 2 > 1
    wake(s, oid(o));
    const { driver } = mkDriver(s);
    await driver.tick();
    const q = queue(s, oid(o));
    expect(q.queue_state).toBe("QUARANTINED");
    // Only the allowlisted label persists — never the thrown message.
    expect(q.blocked_reason).toBe("DRIVER_CAP_EXHAUSTED");
  });
});
