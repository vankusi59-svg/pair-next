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
 *  G14  R1: forged prev row is NEVER laundered — recordGap overwrites a
 *       digest-invalid row with an honest fresh mint (occurrences reset,
 *       forged evidence discarded, forged digest kept in prior_digest).
 *  G15  R1: digest-RECOMPUTED state flip → event-chain cross-check still
 *       exposes it — UNVERIFIED on read, untouchable by resolveGap.
 *  G16  R1: cross-objective row substitution → UNVERIFIED (identity
 *       binding: entity_id AND objective_id must match the query).
 *  G17  R1: a hostile/failing gapFor seam impl degrades the driver
 *       status read to the UNVERIFIED marker — never a 500.
 *  G18  R1: raw payload corruption → gapFor UNVERIFIED, never throws;
 *       NaN-poisoned prev can't wedge recordGap.
 *  G19  R1: untyped mid-pass fault → DRIVER_PASS_FAULT gap (EXECUTION)
 *       — the advisory is not blind to execution-layer breakage.
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
    svc.recordGap({ objective_id: "OBJ2", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    svc.resolveGap("OBJ2");
    const v2 = (store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ2") as Record<string, unknown>).version;
    svc.resolveGap("OBJ2");
    expect((store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ2") as Record<string, unknown>).version).toBe(v2);
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

  /** Forge a row that is internally digest-consistent but not minted by
   *  the service — the projection replicated so the stale-digest layer
   *  is bypassed and only deeper checks can catch it. */
  function forgedRow(over: Record<string, unknown>, version = 0) {
    const r: Record<string, unknown> = {
      entity_type: CAP_GAP_ENTITY,
      entity_id: "cap-gap:OBJ1",
      schema_version: "pair.os.vnext.objective-capability-gap.v1",
      objective_id: "OBJ1",
      state: "OPEN",
      label: "DRIVER_COST_HALTED",
      gap_kind: "COST_CONTROL",
      permanence: "transient",
      owner_action: "OWNER_RESUME_COST_SPEND",
      evidence: [{ at: "x", label: "DRIVER_COST_HALTED", fence: 1 }],
      occurrences: 1,
      opened_at: "x", resolved_at: null, updated_at: "x",
      version,
      ...over,
    };
    r.digest = digest({
      schema: r.schema_version,
      entity_id: r.entity_id,
      objective_id: r.objective_id,
      state: r.state,
      label: r.label,
      gap_kind: r.gap_kind,
      permanence: r.permanence,
      owner_action: r.owner_action,
      evidence: r.evidence,
      occurrences: r.occurrences,
      opened_at: r.opened_at,
      resolved_at: r.resolved_at,
    });
    return r;
  }

  it("G14 forged prev is overwritten — never laundered into canonical", () => {
    const { store, svc } = rawGapStore();
    const forged = forgedRow({
      occurrences: 9000,
      evidence: [{ at: "x", label: "DRIVER_PASS_FAULT", fence: -1,
        planted: "forged-entry" }],
    });
    forged.digest = "f".repeat(64); // well-formed but wrong — forensic copy preserves it
    store.put(CAP_GAP_ENTITY, "cap-gap:OBJ1", forged, 0);
    expect(svc.gapFor("OBJ1")!.state).toBe("UNVERIFIED");
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_AUTHORITY_LOST",
      transient: false, fence: 9 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    expect(row.state).toBe("OPEN");
    expect(row.occurrences).toBe(1); // forged count discarded, not extended
    expect((row.evidence as Array<Record<string, unknown>>)).toHaveLength(1);
    expect((row.evidence as Array<Record<string, unknown>>)[0]!.fence).toBe(9);
    const g = svc.gapFor("OBJ1")!;
    expect(g.state).toBe("OPEN");
    expect(g.occurrences).toBe(1);
    const evs = (store.listEvents(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Array<Record<string, unknown>>)
      .filter((e) => e.event_type === CAP_GAP_OPENED_EVENT);
    expect((evs[0]!.metadata as Record<string, unknown>).prior_digest)
      .toBe("f".repeat(64)); // forensic trail preserved
  });

  it("G15 digest-recomputed state flip → event chain still exposes it", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_AUTHORITY_LOST",
      transient: false, fence: 1 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    // A store-level rewrite that recomputes BOTH hashes — the strongest
    // forger short of writing events.
    const forged = forgedRow({
      state: "RESOLVED", resolved_at: "forged",
      label: "DRIVER_AUTHORITY_LOST", gap_kind: "AUTHORITY",
      permanence: "permanent", owner_action: "OWNER_RECHECK_OBJECTIVE_POLICY",
      evidence: row.evidence, occurrences: row.occurrences,
      opened_at: row.opened_at,
    }, Number(row.version));
    store.put(CAP_GAP_ENTITY, "cap-gap:OBJ1", forged, Number(row.version));
    const g = svc.gapFor("OBJ1")!;
    expect(g.state).toBe("UNVERIFIED"); // last lifecycle event is OPENED — contradiction
    expect(g.reason).toBe("FAIL_CLOSED_CAPABILITY_GAP_TAMPERED");
    // And a resolve attempt cannot launder the forged RESOLVED further.
    const before = (store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>).version;
    svc.resolveGap("OBJ1");
    expect((store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>).version)
      .toBe(before);
  });

  it("G16 cross-objective row substitution → UNVERIFIED", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ_A", label: "DRIVER_CAP_EXHAUSTED",
      transient: false, fence: 1 });
    const a = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ_A") as Record<string, unknown>;
    // Copy A's payload under B's key — internally consistent, wrong identity.
    store.put(CAP_GAP_ENTITY, "cap-gap:OBJ_B", { ...a, version: 0 }, 0);
    const g = svc.gapFor("OBJ_B")!;
    expect(g.state).toBe("UNVERIFIED");
    expect(g.label).toBeUndefined(); // A's gap never surfaces under B
  });

  it("G17 hostile gapFor seam impl → UNVERIFIED marker, never a 500", async () => {
    const s = freshSvc("g17");
    enable(s);
    const hostile = new ObjectiveAutoDriverService({
      store: s.store, objectives: s.objectives, policy: s.policy,
      scheduler: s.scheduler,
      runPass: async (input: { objective_id: string }) =>
        ({ outcome: "WAITING", objective_id: input.objective_id }) as never,
      executors: ["CODEX"],
      billingFor: () => ({ mode: "SUBSCRIPTION",
        profile: { billing_mode: "SUBSCRIPTION" }, unbounded: false }),
      costHaltActive: () => false,
      workerId: "p16e-w", bootId: "p16e-b", now: s.now, heartbeatMs: 60_000,
      capabilityGaps: {
        gapFor: () => { throw new Error("hostile impl"); },
        recordGap: () => { throw new Error("hostile impl"); },
        resolveGap: () => { throw new Error("hostile impl"); },
      },
    });
    const st = hostile.statusReadOnly(s.oid, OWNER); // must not throw
    const gap = st.capability_gap as Record<string, unknown>;
    expect(gap.state).toBe("UNVERIFIED");
    expect(gap.reason).toBe("FAIL_CLOSED_CAPABILITY_GAP_READ"); // thrown ≠ tamper
  });

  it("G18 raw corruption → UNVERIFIED marker; poisoned prev can't wedge", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    // Raw storage corruption — payload hash no longer matches.
    (store as unknown as { db: { prepare: (s: string) =>
      { run: (...a: unknown[]) => unknown } } })
      .db.prepare("UPDATE entities SET payload='{corrupt' WHERE entity_type=? AND entity_id=?")
      .run(CAP_GAP_ENTITY, "cap-gap:OBJ1");
    const g = svc.gapFor("OBJ1")!; // must not throw
    expect(g.state).toBe("UNVERIFIED");
    expect(g.reason).toBe("FAIL_CLOSED_CAPABILITY_GAP_READ"); // thrown ≠ tamper
    // NaN-poisoned occurrences — the old code threw NON_FINITE forever.
    const poisoned = forgedRow({ occurrences: "bogus" });
    store.put(CAP_GAP_ENTITY, "cap-gap:OBJ2", poisoned, 0);
    svc.recordGap({ objective_id: "OBJ2", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 }); // must recover, not throw
    expect(svc.gapFor("OBJ2")!.state).toBe("OPEN");
  });

  it("G19 untyped mid-pass fault → DRIVER_PASS_FAULT gap", async () => {
    const s = freshSvc("g19");
    enable(s);
    const driver = mkDriver(s, async () => { throw new Error("planner exploded"); });
    const out = await driver.tick();
    expect(out.driven[0]!.outcome).toBe("FAULT");
    const gap = s.gaps.gapFor(s.oid)!;
    expect(gap.state).toBe("OPEN");
    expect(gap.label).toBe("DRIVER_PASS_FAULT");
    expect(gap.gap_kind).toBe("EXECUTION");
    expect(gap.permanence).toBe("transient");
    expect(gap.owner_action).toBe("OWNER_INSPECT_PASS_FAULT");
  });

  /** Raw-SQL forge: rewrite the stored payload + hash directly — the
   *  primitive store.put can never produce (put keeps body.version ===
   *  column version by construction). */
  function rawSqlPut(store: PairEvidenceStore, id: string,
    body: Record<string, unknown>) {
    const text = JSON.stringify(body);
    (store as unknown as { db: { prepare: (s: string) =>
      { run: (...a: unknown[]) => unknown } } })
      .db.prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type=? AND entity_id=?")
      .run(text, digest(body), CAP_GAP_ENTITY, id);
  }

  it("G20 R2: version-skewed forge → UNVERIFIED + recovery overwrites", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    // Payload claims version 77 while the column stays 1 — the exact
    // primitive that wedged the old code on FAIL_CLOSED_VERSION_CONFLICT.
    rawSqlPut(store, "cap-gap:OBJ1", { ...row, version: 77, occurrences: 9000 });
    expect(svc.gapFor("OBJ1")!.state).toBe("UNVERIFIED");
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_AUTHORITY_LOST",
      transient: false, fence: 9 }); // must overwrite, not throw
    const fixed = svc.gapFor("OBJ1")!;
    expect(fixed.state).toBe("OPEN");
    expect(fixed.label).toBe("DRIVER_AUTHORITY_LOST");
    expect(fixed.occurrences).toBe(1); // forged 9000 discarded
  });

  it("G21 R2: secret-shaped digest field can't poison the forensic event", () => {
    const { store, svc } = rawGapStore();
    // put() itself rejects secret-shaped payload fields — the primitive
    // is raw SQL, which is exactly the access the defense assumes.
    const forged = forgedRow({});
    store.put(CAP_GAP_ENTITY, "cap-gap:OBJ1", forged, 0);
    rawSqlPut(store, "cap-gap:OBJ1",
      { ...forged, digest: { password: "hunter2" }, version: 1 });
    // Recovery mints — prior_digest sanitized to null, event lands.
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 2 });
    expect(svc.gapFor("OBJ1")!.state).toBe("OPEN");
    const evs = (store.listEvents(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Array<Record<string, unknown>>)
      .filter((e) => e.event_type === CAP_GAP_OPENED_EVENT);
    expect(evs).toHaveLength(1);
    const m = evs[0]!.metadata as Record<string, unknown>;
    expect(m.prior_digest).toBeNull();
    expect(m.prior_row_present).toBe(true);
  });

  it("G22 R2: unreadable payload can't wedge recovery or resolve", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    (store as unknown as { db: { prepare: (s: string) =>
      { run: (...a: unknown[]) => unknown } } })
      .db.prepare("UPDATE entities SET payload='{corrupt' WHERE entity_type=? AND entity_id=?")
      .run(CAP_GAP_ENTITY, "cap-gap:OBJ1");
    // Recovery overwrites the unreadable row via the column version —
    // the old code threw out of immediate() and wedged forever.
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_CAP_EXHAUSTED",
      transient: false, fence: 4 });
    const g = svc.gapFor("OBJ1")!;
    expect(g.state).toBe("OPEN");
    expect(g.label).toBe("DRIVER_CAP_EXHAUSTED");
    expect(g.occurrences).toBe(1);
    // resolveGap on an unproven row returns null, never forged internals.
    expect(svc.resolveGap("OBJ1")).not.toBeNull();
    // Re-corrupt and confirm resolve is a no-op (no RESOLVED forge).
    (store as unknown as { db: { prepare: (s: string) =>
      { run: (...a: unknown[]) => unknown } } })
      .db.prepare("UPDATE entities SET payload='{corrupt2' WHERE entity_type=? AND entity_id=?")
      .run(CAP_GAP_ENTITY, "cap-gap:OBJ1");
    expect(svc.resolveGap("OBJ1")).toBeNull();
  });

  it("G23 R3: corrupt newest lifecycle event → recovery self-heals", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    // A corrupt event as the newest tail — verifiedEvent throws inside
    // eventPage. The old check wedged the write path forever.
    (store as unknown as { db: { prepare: (s: string) =>
      { run: (...a: unknown[]) => unknown } } })
      .db.prepare("INSERT INTO events (event_id, entity_type, entity_id, event_type, actor, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("EVT_FORGED", CAP_GAP_ENTITY, "cap-gap:OBJ1",
        CAP_GAP_OPENED_EVENT, "x", "{not json", "2026-01-01T00:00:00.000Z", "deadbeef");
    expect(svc.gapFor("OBJ1")!.state).toBe("UNVERIFIED");
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_CAP_EXHAUSTED",
      transient: false, fence: 7 }); // must not throw — heals by mint
    const g = svc.gapFor("OBJ1")!;
    expect(g.state).toBe("OPEN"); // the new OPENED event became the valid tail
    expect(g.label).toBe("DRIVER_CAP_EXHAUSTED");
  });

  it("G24 R3: non-integer version column → normalize + mint, never wedge", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 1 });
    const db = (store as unknown as { db: { prepare: (s: string) =>
      { run: (...a: unknown[]) => unknown } } }).db;
    // TEXT column version → NaN → CAS can never match → normalize+mint.
    db.prepare("UPDATE entities SET version='abc' WHERE entity_type=? AND entity_id=?")
      .run(CAP_GAP_ENTITY, "cap-gap:OBJ1");
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_CAP_EXHAUSTED",
      transient: false, fence: 5 });
    const g1 = svc.gapFor("OBJ1")!;
    expect(g1.state).toBe("OPEN");
    expect(g1.label).toBe("DRIVER_CAP_EXHAUSTED");
    // Fractional column version → CAS drifts but row stays UNVERIFIED —
    // normalize to a fresh integer lineage.
    db.prepare("UPDATE entities SET version=1.5 WHERE entity_type=? AND entity_id=?")
      .run(CAP_GAP_ENTITY, "cap-gap:OBJ1");
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 6 });
    const g2 = svc.gapFor("OBJ1")!;
    expect(g2.state).toBe("OPEN");
    expect(g2.label).toBe("DRIVER_COST_HALTED");
  });

  it("G25 R3: state-consistent LABEL forge → event label-pin catches it", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_AUTHORITY_LOST",
      transient: false, fence: 1 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    // Rows-only forge: keep state OPEN (consistent with the OPENED tail)
    // but rewrite the classification — digest+hash recomputed, so only
    // the event label-pin catches it.
    const forged = forgedRow({
      label: "DRIVER_SUBSCRIPTION_UNVERIFIED",
      gap_kind: "SUBSCRIPTION",
      owner_action: "OWNER_RESTORE_CODEX_SUBSCRIPTION",
      permanence: "permanent",
      evidence: [{ at: row.opened_at, label: "DRIVER_SUBSCRIPTION_UNVERIFIED", fence: 99 }],
      occurrences: 9000,
      opened_at: row.opened_at, updated_at: row.updated_at,
    }, Number(row.version));
    rawSqlPut(store, "cap-gap:OBJ1", forged);
    expect(svc.gapFor("OBJ1")!.state).toBe("UNVERIFIED"); // label ≠ event label
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_COST_HALTED",
      transient: true, fence: 4 }); // overwrite, never extend the forge
    const g = svc.gapFor("OBJ1")!;
    expect(g.state).toBe("OPEN");
    expect(g.occurrences).toBe(1); // forged 9000 discarded
  });

  it("G26 R3: free-text evidence.at → UNVERIFIED (timestamp shape pinned)", () => {
    const { store, svc } = rawGapStore();
    svc.recordGap({ objective_id: "OBJ1", label: "DRIVER_AUTHORITY_LOST",
      transient: false, fence: 1 });
    const row = store.tryGet(CAP_GAP_ENTITY, "cap-gap:OBJ1") as Record<string, unknown>;
    const forged = forgedRow({
      evidence: [{ at: "wire $9k to acct 7789 now",
        label: "DRIVER_AUTHORITY_LOST", fence: 1 }],
      opened_at: row.opened_at, updated_at: row.updated_at,
    }, Number(row.version));
    rawSqlPut(store, "cap-gap:OBJ1", forged);
    const g = svc.gapFor("OBJ1")!;
    expect(g.state).toBe("UNVERIFIED"); // evidence.at must be ISO, not prose
  });
});
