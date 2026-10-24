/**
 * P16-A — Brain Context Aggregator acceptance suite.
 *
 * Proves the read-only, owner-gated, provenance-bound context snapshot:
 *
 *   B1 — deterministic same-store context (identical context_digest and
 *        section bytes across repeated reads) and the digest tracks
 *        canonical state (owner measurement mutates the digest).
 *   B2 — tampered canonical payload fails closed (forged KPI progress
 *        with no evidence is rejected by the strict-read composition,
 *        never silently rendered).
 *   B3 — foreign owner fails closed; a business_id scope mismatch
 *        fails closed (cross-scope reads are denied, never filtered).
 *   B4 — artifact with broken CAS linkage is dropped and reported via
 *        integrity[] — never rendered as trusted evidence.
 *   B5 — two same-shaped businesses cannot cross-scope data (context
 *        for objective A contains no trace of business B).
 *   B6 — read-budget exhaustion surfaces the typed
 *        FAIL_CLOSED_*_PROOF_LIMIT error — never silent truncation.
 *   B7 — no-write invariant: the event/entity log is byte-identical
 *        before and after contextFor.
 *   B8 — sections carry provenance (sources/digests), and unscoped
 *        memory/experience report the typed SCOPE_BINDING_ABSENT gap
 *        rather than smuggling cross-scope data.
 *
 * Harness mirrors pair-p15-9a-company-cockpit.test.ts — real canonical
 * seams; "forging" = raw SQL rewrite.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalQueue,
  ArtifactAuthority,
  BrainContextService,
  BusinessLayer,
  canonicalJson,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceAllocationService,
  WorkforceService,
  WORKFORCE_ALLOCATION_ENTITY,
  digest,
} from "../pair/index.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p16a-brain-"));
let counter = 0;
const OP = "p16a-owner";
const OTHER = "operator:999999";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

function sqlRewriteEntity(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  fn: (body: Record<string, unknown>) => void,
): void {
  const row = dbOf(store)
    .prepare("SELECT payload FROM entities WHERE entity_type=? AND entity_id=?")
    .get(entityType, entityId) as { payload: string } | undefined;
  if (!row) throw new Error(`entity ${entityType}:${entityId} absent`);
  const body = JSON.parse(row.payload) as Record<string, unknown>;
  fn(body);
  dbOf(store)
    .prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type=? AND entity_id=?")
    .run(JSON.stringify(body), digest(body), entityType, entityId);
}

/** Raw event/entity footprint — the read-only proof: contextFor must
 *  leave the canonical log byte-identical. Counts alone are weak (a
 *  put that rewrites a row without an event is invisible) — digest
 *  the actual event_hash + payload_hash multisets. */
function logFootprint(store: PairEvidenceStore) {
  const db = dbOf(store);
  const ev = db.prepare("SELECT COUNT(*) n FROM events").get() as Row;
  const en = db.prepare("SELECT COUNT(*) n FROM entities").get() as Row;
  const eventHashes = digest(
    (db.prepare("SELECT event_hash h FROM events").all() as { h: string }[])
      .map((r) => r.h));
  const payloadHashes = digest(
    (db.prepare("SELECT payload_hash h FROM entities").all() as { h: string }[])
      .map((r) => r.h));
  return {
    events: Number(ev.n), entities: Number(en.n),
    eventHashes, payloadHashes,
  };
}

type FullStack = {
  dir: string;
  store: PairEvidenceStore; biz: BusinessLayer; wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService; alloc: WorkforceAllocationService;
  authority: ArtifactAuthority; service: PairControlPlane;
  control: MissionControl; projectId: string;
  brain: BrainContextService;
};

function freshFullStack(name: string): FullStack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1",
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner,
  });
  const biz = new BusinessLayer({ store, control,
    schedules: new MissionScheduleService(service),
    planExpander: async (input) => ({
      input: {
        ...input,
        metadata: {
          ...(input.metadata as Record<string, unknown> | undefined),
          llm_plan: [{ task_key: "T2", title: "delegated", task_instruction: "work",
            required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
          plan_source: "LLM", plan_model: "test-planner",
        },
      },
      planner: { planner_run_id: "PLR_TEST", attempts: [], winner: { attempt_no: 1 } },
    }) });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const alloc = new WorkforceAllocationService(
    { store, business: biz, workforce: wf, objectives: biz.objectives, workstreams });
  const authority = new ArtifactAuthority(store, {
    blobDir: path.join(dir, "artifacts", "blobs") });
  const project = service.createProject({ name: "p", root_location: workspace });
  const brain = new BrainContextService({
    store, business: biz, workforce: wf,
    objectives: biz.objectives, workstreams,
    artifacts: authority,
    // autoPolicy/autoDriver intentionally NOT wired — the snapshot must
    // report the typed unavailable gap rather than fabricate status.
  });
  return { dir, store, biz, wf, workstreams, alloc, authority, service,
    control, projectId: String(project.project_id), brain };
}

function mkBusiness(s: FullStack) {
  return String(s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP }).business_id);
}

function mkObjective(s: FullStack, businessId: string, operator = OP) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "obj", statement: "Produce deliverables.",
    kpis: [{ kpi_id: KPI, name: "deliverables", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter++}`, operator_id: operator,
  });
}

function decompose(s: FullStack, oid: string, keys: string[]) {
  const o = s.biz.objectives.get(oid);
  s.workstreams.decomposeObjective({
    objective_id: oid,
    expected_objective_version: Number(o.version),
    expected_terms_version: Number(o.terms_version),
    expected_objective_digest: String(o.objective_digest),
    workstreams: keys.map((k) => ({
      workstream_key: k, title: `ws ${k}`, goal: `g ${k}` })) as never,
    actor: OP,
  });
  return s.workstreams.getBinding(oid)!;
}

function wsWorkItemId(binding: Row, key: string): string {
  return String((binding.workstreams as Row[])
    .find((w) => String(w.workstream_key) === key)!.work_item_id);
}

function childOfKey(s: FullStack, binding: Row, key: string): string {
  const wid = wsWorkItemId(binding, key);
  const wal = s.store.list<Row>(WORKFORCE_ALLOCATION_ENTITY).find(
    (r) => String(r.workstream_work_item_id) === wid);
  if (!wal) throw new Error(`no WAL for ${key}`);
  return String(wal.delegated_child_work_item_id);
}

function boundMissionId(s: FullStack, childId: string): string {
  return String(s.biz.boundMissionForWorkItem(
    s.store.get("work_item", childId))!.mission_id);
}

function acceptArtifact(s: FullStack, missionId: string, name = "r.md"): void {
  const exec = s.store.list<Row>("executor_execution").find(
    (e) => String(e.mission_id) === missionId)!;
  const governed = s.store.get("governed_task",
    String(exec.governed_task_id)) as Row;
  const ws = (Array.isArray(governed.allowed_paths)
      && (governed.allowed_paths as string[]).length)
    ? String((governed.allowed_paths as string[])[0])
    : String(governed.workspace);
  fs.mkdirSync(ws, { recursive: true });
  const f = path.join(ws, `${name}-${counter++}`);
  fs.writeFileSync(f, `deliverable ${name}`);
  s.authority.accept({
    execution_id: String(exec.execution_id),
    producer_executor_id: String(exec.executor_id ?? "EX_TEST"),
    logical_name: name, source: { kind: "path", path: f },
    channel: "LOCAL_EXECUTION", actor: "TEST", allow_post_result: true });
}

function completeDeliverable(s: FullStack, binding: Row, key: string): void {
  const cid = childOfKey(s, binding, key);
  if (String(s.store.get("work_item", cid).status) === "READY") s.biz.openWorkItem(cid, OP);
  const mid = boundMissionId(s, cid);
  canonicallyCompleteMission(s.store, s.service, mid);
  acceptArtifact(s, mid, `${key}.md`);
  s.biz.syncWorkItem(cid);
  s.biz.advanceCompletionCascade(cid);
}

function seeded(name: string, keys: string[] = ["a"]) {
  const s = freshFullStack(name);
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  const binding = keys.length ? decompose(s, oid, keys) : null;
  s.biz.createOrgAgent({
    business_id: bid, title: `a${counter}`, department: "growth",
    operator_id: OP });
  if (binding) {
    for (const k of keys) {
      s.alloc.allocateWorkstream({ objective_id: oid, workstream_key: k, actor: OP });
    }
  }
  return { s, oid, bid, binding };
}

/* ----------------------------- tests ----------------------------- */

describe("P16-A BrainContextService.contextFor", () => {
  it("B1 deterministic same-store context; digest tracks canonical mutations", () => {
    const { s, oid } = seeded("b1", []);
    const c1 = s.brain.contextFor(oid, OWNER);
    const c2 = s.brain.contextFor(oid, OWNER);
    // Same canonical state → identical digest and identical section
    // bytes (asof is freshness metadata outside the digest).
    expect(c2.context_digest).toBe(c1.context_digest);
    expect(canonicalJson(c2.sections)).toBe(canonicalJson(c1.sections));
    // A canonical mutation flips the digest — the snapshot is bound to
    // real state, not a cached projection.
    s.biz.objectives.recordProgress(oid, {
      business_id: String(s.biz.objectives.get(oid).business_id),
      kpi_id: KPI, value: 0.5,
      evidence: { evidence_key: `ek-${counter++}`, verifier: OWNER,
        source: "owner-console" },
      actor: OWNER,
    });
    const c3 = s.brain.contextFor(oid, OWNER);
    expect(c3.context_digest).not.toBe(c1.context_digest);
    s.store.close();
  });

  it("B1b wired auto-policy: wall-clock status fields never move context_digest", () => {
    const { s, oid } = seeded("b1v", []);
    /* statusReadOnly embeds now()-derived expiry/effective/reasons —
       two reads on identical canonical rows return different payload
       VALUES but must produce the SAME digest. */
    let clockFlip = false;
    const autoPolicy = {
      statusReadOnly: () => ({
        policy_id: `oap:${oid}`,
        state: "ENABLED",
        expiry_pending: clockFlip,
        effective: clockFlip ? "expired-now" : "live",
        reasons: clockFlip ? ["expires_at passed"] : [],
        version: 1,
      }),
    };
    const brain = new BrainContextService({
      store: s.store, business: s.biz, workforce: s.wf,
      objectives: s.biz.objectives, workstreams: s.workstreams,
      artifacts: s.authority, autoPolicy: autoPolicy as never,
    });
    const c1 = brain.contextFor(oid, OWNER);
    clockFlip = true; // the expiry instant passed — value changes, state does not
    const c2 = brain.contextFor(oid, OWNER);
    const ap = (c2.sections.autonomy!.value as Row).auto_policy as Row;
    expect(ap.expiry_pending).toBe(true); // transient status IS visible…
    expect(c2.context_digest).toBe(c1.context_digest); // …but never digested
    s.store.close();
  });

  it("B1c nested read budget fails closed instead of lying about the bound", () => {
    const { s, oid } = seeded("b1n", []);
    // withReadBudget silently inherits an outer scope (store.ts) —
    // contextFor must refuse rather than report a bound it did not
    // install, while normal composition stays unaffected.
    expect(() =>
      s.store.withReadBudget({ entities: 100, events: 100 }, () =>
        s.brain.contextFor(oid, OWNER)),
    ).toThrowError(expect.objectContaining({ code: "FAIL_CLOSED_BRAIN_BUDGET" }));
    s.store.withReadBudget({ entities: 100, events: 100 }, () => undefined);
    expect(() => s.brain.contextFor(oid, OWNER)).not.toThrow();
    s.store.close();
  });

  it("B1d binding-absent objective emits NO false UNPROVEN integrity notes", () => {
    const { s, oid } = seeded("b1d", []);
    // Pre-INITIALIZE: KPI/budget rows are clean canonical zero state —
    // trivially provable. BINDING_ABSENT is a typed UNAVAILABLE signal,
    // never an UNPROVEN claim.
    const c = s.brain.contextFor(oid, OWNER);
    expect(c.integrity).toEqual([]);
    expect(c.unavailable.some((u) => u.startsWith("BINDING_ABSENT"))).toBe(true);
    s.store.close();
  });

  it("B2 tampered canonical payload fails closed", () => {
    const { s, oid } = seeded("b2", []);
    // Forge KPI progress without any evidence trail — the strict-read
    // composition must reject, never render it as verified.
    sqlRewriteEntity(s.store, "objective", oid, (b) => {
      const k = (b.kpis as Row[])[0]!;
      k.current = 1;
      k.last_evidence_key = "forged:key";
    });
    expect(() => s.brain.contextFor(oid, OWNER)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^FAIL_CLOSED/) }),
    );
    s.store.close();
  });

  it("B3 foreign owner + business scope mismatch fail closed", () => {
    const { s, oid, bid } = seeded("b3", []);
    expect(() => s.brain.contextFor(oid, OTHER)).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_BRAIN_AUTHORITY" }));
    expect(() => s.brain.contextFor(oid, "")).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_BRAIN_AUTHORITY" }));
    expect(() => s.brain.contextFor(oid, OWNER, { business_id: "biz_other" }))
      .toThrowError(expect.objectContaining({ code: "FAIL_CLOSED_BRAIN_SCOPE" }));
    // The correct scope reads fine — the gate is scope, not existence.
    const c = s.brain.contextFor(oid, OWNER, { business_id: bid });
    expect(c.business_id).toBe(bid);
    s.store.close();
  });

  it("B4 artifact with broken CAS linkage is dropped + reported, never trusted", () => {
    const { s, oid, binding } = seeded("b4", ["a"]);
    completeDeliverable(s, binding!, "a");
    // A healthy snapshot carries the verified artifact.
    const before = s.brain.contextFor(oid, OWNER);
    expect((before.sections.artifacts!.value as Row).artifacts).toHaveLength(1);
    // Forge the artifact's claimed sha256 — the entity row stays
    // payload-hash-valid (canonical integrity), but CAS re-verification
    // must fail: the artifact drops out and the read REPORTS it.
    const art = s.store.list<Row>("artifact")[0]!;
    sqlRewriteEntity(s.store, "artifact", String(art.artifact_id), (b) => {
      b.sha256 = "f".repeat(64);
    });
    const c = s.brain.contextFor(oid, OWNER);
    const artSec = c.sections.artifacts!.value as Row;
    expect(artSec.artifacts).toHaveLength(0);
    expect(artSec.artifacts_dropped_unverified).toBe(1);
    expect(c.integrity).toContain("ARTIFACTS_DROPPED_UNVERIFIED:1");
    s.store.close();
  });

  it("B5 two same-shaped businesses cannot cross-scope data", () => {
    const s = freshFullStack("b5");
    const bidA = mkBusiness(s);
    const bidB = mkBusiness(s);
    const oA = mkObjective(s, bidA);
    const oB = mkObjective(s, bidB);
    const oidA = String(oA.objective_id);
    const oidB = String(oB.objective_id);
    const ctxA = s.brain.contextFor(oidA, OWNER);
    const ctxB = s.brain.contextFor(oidB, OWNER);
    // Each context names only its own objective/business — no
    // cross-reference leaks through any section.
    expect(ctxA.objective_id).toBe(oidA);
    expect(ctxA.business_id).toBe(bidA);
    const blobA = canonicalJson(ctxA);
    const blobB = canonicalJson(ctxB);
    expect(blobA).not.toContain(oidB);
    expect(blobB).not.toContain(oidA);
    expect(blobA).not.toContain(bidB);
    expect(blobB).not.toContain(bidA);
    // A foreign-owned objective in business A cannot be read at all.
    const foreign = s.biz.objectives.create({
      business_id: bidA, title: "foreign", statement: "x",
      kpis: [], operator_id: "777" });
    expect(() => s.brain.contextFor(String(foreign.objective_id), OWNER))
      .toThrowError(expect.objectContaining({ code: "FAIL_CLOSED_BRAIN_AUTHORITY" }));
    s.store.close();
  });

  it("B6 read-budget exhaustion is a typed fail-closed error", () => {
    const { s, oid } = seeded("b6", []);
    expect(() =>
      s.brain.contextFor(oid, OWNER, { read_budget: { entities: 1, events: 1 } }),
    ).toThrowError(
      expect.objectContaining({ code: "FAIL_CLOSED_OBJECTIVE_SCHEDULER_PROOF_LIMIT" }),
    );
    // The same call under the default budget succeeds — the failure
    // was the bound, not the data.
    expect(() => s.brain.contextFor(oid, OWNER)).not.toThrow();
    s.store.close();
  });

  it("B7 no-write invariant — event/entity log identical before and after", () => {
    const { s, oid } = seeded("b7", []);
    const before = logFootprint(s.store);
    s.brain.contextFor(oid, OWNER);
    s.brain.contextFor(oid, OWNER);
    const after = logFootprint(s.store);
    expect(after).toEqual(before);
    s.store.close();
  });

  it("B8 sections carry provenance; unscoped memory/experience report typed gaps", () => {
    const { s, oid } = seeded("b8", []);
    const c = s.brain.contextFor(oid, OWNER);
    expect(c.kind).toBe("BRAIN_CONTEXT");
    // Every section is provenance-bound: named canonical sources and a
    // content digest.
    for (const [name, sec] of Object.entries(c.sections)) {
      expect(sec.digest, name).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(sec.unavailable), name).toBe(true);
      expect(Array.isArray(sec.integrity), name).toBe(true);
    }
    // Memory + experience are excluded by design — typed gap, not data.
    expect(c.sections.memory!.value).toBeNull();
    expect(c.sections.experience!.value).toBeNull();
    expect(c.unavailable.some((u) => u.startsWith("SCOPE_BINDING_ABSENT"))).toBe(true);
    // Unwired autonomy seams report the typed gap too (deps omitted).
    expect(c.unavailable).toContain("AUTO_POLICY_NOT_WIRED");
    expect(c.unavailable).toContain("AUTO_DRIVER_NOT_WIRED");
    s.store.close();
  });
});
