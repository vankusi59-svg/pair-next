/**
 * P16-E — capability-gap advisory: DRIVER_* fault classification →
 * persisted canonical projection.
 *
 *   G1  recordGap mints a canonical OPEN row — closed-vocabulary
 *       classification (label → gap_kind + owner_action + permanence),
 *       digest pin, OBJECTIVE_CAPABILITY_GAP_OPENED event anchor.
 *   G2  same (label,fence) replay is idempotent — same version, no
 *       double count, no second event.
 *   G3  recurrence with a new fence bumps occurrences + appends bounded
 *       evidence; the ring never exceeds the cap.
 *   G4  a label CHANGE on an OPEN row reclassifies in place + anchors
 *       reclassified:true on the event.
 *   G5  resolveGap closes OPEN → RESOLVED (+event); a later denial
 *       re-OPENs the same row with reopened:true anchor.
 *   G6  non-vocabulary label fails closed — FAIL_CLOSED_CAPABILITY_GAP_LABEL.
 *   G7  every DRIVER_* label classifies — no unmapped vocabulary member.
 *   G8  tampered row never renders canonical — gapFor surfaces the
 *       deterministic UNVERIFIED marker instead of throwing.
 *   G9  gapFor absent → null; read path performs ZERO writes.
 *  G10  driver admit denial (cost halt, transient) → statusReadOnly
 *       exposes capability_gap OPEN with COST_CONTROL/OWNER_RESUME_COST_SPEND.
 *  G11  a settled pass resolves the gap — denial then success → RESOLVED.
 *  G12  mid-pass DriverDenial (never reaches recordDenial) still
 *       projects — SUBSCRIPTION_UNVERIFIED mid-pass → OPEN gap.
 *  G13  capabilityGaps unwired → driver works unchanged; the status
 *       field is null, never fabricated.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PairEvidenceStore,
  BusinessLayer,
  WorkforceService,
  ObjectiveWorkstreamService,
  WorkforceAllocationService,
  ObjectiveAutoPolicyService,
  ObjectiveAutoScheduler,
  ObjectiveAutoWakeupService,
  ObjectiveAutoDriverService,
  ObjectiveCapabilityGapService,
  DriverDenial,
  DRIVER_FAULT_LABELS,
  CAP_GAP_ENTITY,
  CAP_GAP_OPENED_EVENT,
  CAP_GAP_RESOLVED_EVENT,
  IntegrityError,
  digest,
  ProviderCatalog,
  ModelEvidenceCatalog,
  ensureCodexCliCatalog,
  providerEntryId,
  CODEX_CLI_PROVIDER_ID,
  CEO_CODEX_DEFAULT_MODEL,
  qualifyModel,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p16e-"));
const OP = "1882810918";
const OWNER = "operator:" + OP;
const FUTURE = "2999-01-01T00:00:00.000Z";
let counter = 0;

function freshSvc(name: string, initial = 1_000_000) {
  let t = initial;
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const codexHome = path.join(dir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: { sub: "u" }, access_token: "a", refresh_token: "r" },
  }));
  process.env.CODEX_HOME = codexHome;
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
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
  const gaps = new ObjectiveCapabilityGapService(store, () => t);
  const bid = `BIZ_P16E_${counter}`;
  store.put("business", bid, {
    business_id: bid, name: "b", status: "ACTIVE",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  const o = objectives.create({
    business_id: bid, title: "Sell", statement: "s",
    kpis: [{ name: "sales", unit: "u", baseline: 0, target: 10 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000_000,
    operator_id: OP, dedup_key: `p16e-${counter}`,
  });
  const oid = String((o as { objective_id: string }).objective_id);
  const meId = ensureCodexCliCatalog(store, CEO_CODEX_DEFAULT_MODEL, "t");
  const pid = CODEX_CLI_PROVIDER_ID;
  const id = providerEntryId(pid);
  const existing = store.tryGet("provider", id) as Record<string, unknown> | null;
  store.put("provider", id, {
    ...(existing ?? { provider_id: pid, entry_id: id }),
    lifecycle_state: "QUALIFIED", auth_state: "AUTH_OK", health_state: "READY",
    conditions: [], probe_state: "PROBED", provider_type: "LOCAL_CLI",
    protocol_family: "CODEX_CLI", endpoint_reference: "codex-cli://local",
    configured_endpoint_identity: "codex-cli://local",
    credential_envs: [], credential_reference_name: null,
  }, existing ? Number(existing.version) : 0);
  new ProviderCatalog(store).issueQualificationReceipt(pid, { policy_version: "t", actor: "t" });
  new ModelEvidenceCatalog(store).recordProbeReceipt({
    probe_id: `PRB_p16e_${counter++}`, model_entry_id: meId, provider_id: pid,
    result: "PASS", probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" }, latency_ms: 1,
  });
  const q = qualifyModel(store, meId, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error("seedCeoModel failed");
  return { dir, store, biz, objectives, policy, scheduler, wakeup, gaps, oid, bid,
    now: () => t, setNow: (v: number) => { t = v; } };
}

type Svc = ReturnType<typeof freshSvc>;
const LIMITS = (extra: Record<string, unknown> = {}) =>
  ({ expires_at: FUTURE, max_ceo_calls: 10, max_retries: 3, ...extra });

function enable(s: Svc, extra: Record<string, unknown> = {}) {
  s.policy.control({ objective_id: s.oid, actor: OWNER,
    action: "configure", limits: LIMITS(extra), idempotency_key: `cfg-${counter}-${Math.random()}` });
  s.policy.control({ objective_id: s.oid, actor: OWNER,
    action: "enable", policy_version: 1, idempotency_key: `en-${counter}-${Math.random()}` });
  s.wakeup.tick();
}

function mkDriver(s: Svc, runPassImpl: (input: {
  objective_id: string; actor: string; authority_gate: () => void;
}) => Promise<{ outcome: string; objective_id: string }>,
  opts: { halt?: () => boolean; gaps?: boolean } = {}) {
  if (!s.store.tryGet("executor", "CODEX")) {
    s.store.put("executor", "CODEX", {
      executor_id: "CODEX", executor_type: "EXTERNAL", status: "ENABLED",
      health_state: "READY", capabilities: [],
      metadata: { qualification_state: "QUALIFIED" },
    }, 0);
  }
  return new ObjectiveAutoDriverService({
    store: s.store, objectives: s.objectives, policy: s.policy,
    scheduler: s.scheduler,
    runPass: async (input) => runPassImpl(input) as never,
    executors: ["CODEX"],
    billingFor: (e: string) =>
      e === "CODEX"
        ? { mode: "SUBSCRIPTION", profile: { billing_mode: "SUBSCRIPTION" }, unbounded: false }
        : { mode: "UNMETERED", profile: null, unbounded: false },
    costHaltActive: opts.halt ?? (() => false),
    workerId: "p16e-w", bootId: "p16e-b",
    now: s.now, heartbeatMs: 60_000,
    ...(opts.gaps === false ? {} : { capabilityGaps: s.gaps }),
  });
}

const gapRows = (s: Svc) =>
  (s.store.list(CAP_GAP_ENTITY) as Array<Record<string, unknown>>);
const gapEvents = (s: Svc, type: string) =>
  (s.store.listEvents(CAP_GAP_ENTITY, `cap-gap:${s.oid}`) as Array<Record<string, unknown>>)
    .filter((e) => e.event_type === type);

function rawGapStore(s: Svc) {
  // Standalone service fixture — no objective wiring needed.
  const dir = path.join(ROOT, `${counter++}-raw`);
  fs.mkdirSync(dir, { recursive: true });
  let t = 1_000_000;
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  return { store, svc: new ObjectiveCapabilityGapService(store, () => t) };
}

describe("P16-E — capability-gap advisory projection", () => {

  it("G1 recordGap mints a classified OPEN row + digest + OPENED event", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_AUTHORITY_LOST",
      transient: false, fence: 7 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    expect(row.state).toBe("OPEN");
    expect(row.label).toBe("DRIVER_AUTHORITY_LOST");
    expect(row.gap_kind).toBe("AUTHORITY");
    expect(row.permanence).toBe("permanent");
    expect(row.owner_action).toBe("OWNER_RECHECK_OBJECTIVE_POLICY");
    expect(row.occurrences).toBe(1);
    expect(row.schema_version).toContain("capability-gap");
    expect(typeof row.digest).toBe("string");
    const g = svc.gapFor("OBJ1")!;
    expect(g.state).toBe("OPEN");
    expect(g.gap_kind).toBe("AUTHORITY");
    const evs = (store.listEvents(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Array<Record<string, unknown>>)
      .filter((e) => e.event_type === CAP_GAP_OPENED_EVENT);
    expect(evs).toHaveLength(1);
    expect((evs[0]!.metadata as Record<string, unknown>).pins_digest).toBe(digest(row));
  });

  it("G2 same (label,fence) replay is idempotent — no recount, no event", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_CAP_EXHAUSTED",
      transient: false, fence: 3 });
    const v1 = (store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>).version;
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_CAP_EXHAUSTED",
      transient: false, fence: 3 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    expect(row.version).toBe(v1);
    expect(row.occurrences).toBe(1);
    expect((row.evidence as unknown[])).toHaveLength(1);
  });

  it("G3 recurrence bumps occurrences + bounded evidence ring", () => {
    const { store, svc } = rawGapStore();
    for (let fence = 1; fence <= 12; fence++) {
      svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_CAP_EXHAUSTED",
        transient: false, fence });
    }
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    expect(row.occurrences).toBe(12);
    expect((row.evidence as unknown[]).length).toBeLessThanOrEqual(8);
    const tail = (row.evidence as Array<{ fence: number }>).slice(-1)[0]!;
    expect(tail.fence).toBe(12); // newest evidence kept
  });

  it("G4 label change on OPEN reclassifies in place + anchors event", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_AUTHORITY_LOST",
      transient: false, fence: 2 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    expect(row.state).toBe("OPEN");
    expect(row.label).toBe("DRIVER_AUTHORITY_LOST");
    expect(row.gap_kind).toBe("AUTHORITY");
    expect(row.permanence).toBe("permanent");
    const evs = (store.listEvents(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Array<Record<string, unknown>>)
      .filter((e) => e.event_type === CAP_GAP_OPENED_EVENT);
    expect(evs).toHaveLength(2);
    expect((evs[1]!.metadata as Record<string, unknown>).reclassified).toBe(true);
  });

  it("G5 resolveGap closes; a later denial reopens with anchor", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    svc.resolveGap("OBJ1");
    let row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    expect(row.state).toBe("RESOLVED");
    expect(typeof row.resolved_at).toBe("string");
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_CAP_EXHAUSTED",
      transient: false, fence: 5 });
    row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    expect(row.state).toBe("OPEN");
    expect(row.resolved_at).toBeNull();
    expect(row.occurrences).toBe(2);
    const evs = (store.listEvents(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Array<Record<string, unknown>>)
      .filter((e) => e.event_type === CAP_GAP_OPENED_EVENT);
    expect((evs[1]!.metadata as Record<string, unknown>).reopened).toBe(true);
    // Idempotent resolve — no-op on a RESOLVED row.
    const v = row.version;
    // (RESOLVED row, not re-resolving the OPEN one)
    svc.recordGap({ objective_id: "OBJ2", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    svc.resolveGap("OBJ2");
    const v2 = (store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ2") as Record<string, unknown>).version;
    svc.resolveGap("OBJ2");
    expect((store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ2") as Record<string, unknown>).version).toBe(v2);
    void v;
  });

  it("G6 non-vocabulary label fails closed", () => {
    const { svc } = rawGapStore();
    expect(() => svc.recordGap({ objective_id: "OBJ1",
      label: "DRIVER_MADE_UP" as never, transient: false }))
      .toThrowError(/FAIL_CLOSED_CAPABILITY_GAP_LABEL/);
    expect(() => svc.recordGap({ objective_id: "OBJ1",
      label: "raw error text leak" as never, transient: false }))
      .toThrowError(IntegrityError);
  });

  it("G7 every DRIVER_* vocabulary member classifies", () => {
    const { svc } = rawGapStore();
    for (const label of DRIVER_FAULT_LABELS) {
      const g = svc.recordGap({ objective_id: `OBJ_${label}`,
        label, transient: false, fence: 1 });
      expect(g.state).toBe("OPEN");
      expect(typeof g.gap_kind).toBe("string");
      expect(String(g.owner_action)).toMatch(/^OWNER_/);
      const p = svc.gapFor(`OBJ_${label}`)!;
      expect(p.label).toBe(label);
    }
  });

  it("G8 tampered row surfaces UNVERIFIED marker, never throws", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    // Forge a state flip while keeping the (now-stale) digest.
    store.put(CAP_GAP_ENTITY, "cap-gap:OBJ1",
      { ...row, state: "RESOLVED" }, Number(row.version));
    const g = svc.gapFor("OBJ1")!;
    expect(g.state).toBe("UNVERIFIED");
    expect(g.reason).toBe("FAIL_CLOSED_CAPABILITY_GAP_TAMPERED");
    expect(g.label).toBeUndefined();
    expect(g.gap_kind).toBeUndefined();
  });

  it("G9 gapFor absent → null; read performs zero writes", () => {
    const { store, svc } = rawGapStore();
    expect(svc.gapFor("NOPE")).toBeNull();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    const footprint = digest(store.list(CAP_GAP_ENTITY) as unknown[]);
    const evs = (store.listEvents(CAP_GAP_ENTITY, "cap-gap:OBJ1") as unknown[]).length;
    svc.gapFor("OBJ1");
    svc.gapFor("OBJ1");
    svc.gapFor("NOPE");
    expect(digest(store.list(CAP_GAP_ENTITY) as unknown[])).toBe(footprint);
    expect((store.listEvents(CAP_GAP_ENTITY, "cap-gap:OBJ1") as unknown[]).length).toBe(evs);
  });

  it("G10 admit denial (cost halt) → statusReadOnly exposes OPEN gap", async () => {
    const s = freshSvc("g10");
    enable(s);
    const driver = mkDriver(s, async (input) =>
      ({ outcome: "WAITING", objective_id: input.objective_id }),
      { halt: () => true });
    const out = await driver.tick();
    expect(out.driven[0]!.denied).toBe("DRIVER_COST_HALTED");
    const st = driver.statusReadOnly(s.oid, OWNER);
    const gap = st.capability_gap as Record<string, unknown> | null;
    expect(gap).not.toBeNull();
    expect(gap!.state).toBe("OPEN");
    expect(gap!.label).toBe("DRIVER_COST_HALTED");
    expect(gap!.gap_kind).toBe("COST_CONTROL");
    expect(gap!.permanence).toBe("transient");
    expect(gap!.owner_action).toBe("OWNER_RESUME_COST_SPEND");
  });

  it("G11 denial then settled pass → gap RESOLVED", async () => {
    const s = freshSvc("g11");
    enable(s);
    let halt = true;
    const driver = mkDriver(s, async (input) =>
      ({ outcome: "WAITING", objective_id: input.objective_id }),
      { halt: () => halt });
    const out1 = await driver.tick();
    expect(out1.driven[0]!.denied).toBe("DRIVER_COST_HALTED");
    expect((s.gaps.gapFor(s.oid)!).state).toBe("OPEN");
    halt = false;
    s.setNow(s.now() + 31_000); // past the released-lease retry backoff
    s.wakeup.tick();
    // The real runtime ticks every interval — a released-lease candidate
    // re-enters once the fairness scan passes its rank; bound the retry
    // like the production loop instead of asserting on one cursor pass.
    let out2: Awaited<ReturnType<typeof driver.tick>> | null = null;
    for (let i = 0; i < 3; i++) {
      out2 = await driver.tick();
      if (out2.driven.length > 0) break;
      s.setNow(s.now() + 31_000);
      s.wakeup.tick();
    }
    expect(out2?.driven.length).toBeGreaterThan(0);
    expect(out2!.driven[0]!.settled).toBe(true);
    const gap = s.gaps.gapFor(s.oid)!;
    expect(gap.state).toBe("RESOLVED");
    expect(gap.resolved_at).not.toBeNull();
    const evs = gapEvents(s, CAP_GAP_RESOLVED_EVENT);
    expect(evs).toHaveLength(1);
  });

  it("G12 mid-pass DriverDenial still projects the gap", async () => {
    const s = freshSvc("g12");
    enable(s);
    const driver = mkDriver(s, async () => {
      throw new DriverDenial("DRIVER_SUBSCRIPTION_UNVERIFIED",
        "codex-cli subscription authority lost mid-pass", false);
    });
    const out = await driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    const gap = s.gaps.gapFor(s.oid)!;
    expect(gap.state).toBe("OPEN");
    expect(gap.label).toBe("DRIVER_SUBSCRIPTION_UNVERIFIED");
    expect(gap.gap_kind).toBe("SUBSCRIPTION");
    expect(gap.permanence).toBe("permanent");
    expect(gap.owner_action).toBe("OWNER_RESTORE_CODEX_SUBSCRIPTION");
  });

  it("G13 unwired capabilityGaps → null field, driver unchanged", async () => {
    const s = freshSvc("g13");
    enable(s);
    const driver = mkDriver(s, async (input) =>
      ({ outcome: "WAITING", objective_id: input.objective_id }),
      { halt: () => true, gaps: false });
    const out = await driver.tick();
    expect(out.driven[0]!.denied).toBe("DRIVER_COST_HALTED");
    const st = driver.statusReadOnly(s.oid, OWNER);
    expect(st.capability_gap).toBeNull();
    expect(gapRows(s)).toHaveLength(0); // nothing persisted without the seam
  });
});
