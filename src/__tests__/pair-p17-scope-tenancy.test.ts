/**
 * P17 — business/objective tenancy for experience + memory → Brain
 * consumption.
 *
 *   T1  createCandidate tenancy validation — objective+business
 *       consistent, business-only, unscoped; foreign business, missing
 *       objective/business → FAIL_CLOSED_EXPERIENCE_SCOPE.
 *   T2  retrieve() scoped admission — objective-exact, business-shared,
 *       unscoped and foreign rows never admitted; the unscoped legacy
 *       query still sees everything.
 *   T3  scopedFor returns rows + honest exclusion counts.
 *   T4  extraction derives scope from the canonical chain — bound
 *       mission (work_open_binding → work_item → root → objective
 *       workstream binding) mints an objective-scoped candidate;
 *       standalone mission degrades to business/unscoped.
 *   T5  cross-scope same-signature observations are DIFFERENT series
 *       (tenancy is part of dedup identity) — no cross-tenant fold.
 *   T6  ScopedMemoryReader — scoped admission, unscoped/foreign
 *       excluded, malformed (objective vs foreign business) denied;
 *       legacy schema without V13 columns → all rows unscoped.
 *   T7  BrainContext sections — wired seams carry real scoped data +
 *       exclusion counts; unwired deps report *_NOT_WIRED; the read is
 *       still zero-write.
 *   T8  ReasoningBrief — EXPERIENCE/MEMORY facts appear with honest
 *       provenance tiers (PROJECTED / UNVERIFIED); SCOPE_BINDING_ABSENT
 *       is gone once wired.
 *   T9  malformed scoped-memory binding (objective id + foreign
 *       business) → counted out_of_scope, never admitted.
 *   T10 malformed experience binding survives only as exclusion — a
 *       raw-forged row claiming objective X + business Y never renders
 *       in X's scoped read.
 *
 * Harness mirrors pair-p16-a-brain-context.test.ts — real canonical
 * seams; memory reads run against a real automaton database.
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
  ExperienceExtractor,
  ExperienceService,
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
  ReasoningBriefService,
  ReconciliationService,
  RecoveryController,
  ScopedMemoryReader,
  VerifiedExperiencePlannerAdvisor,
  VerifiedExperienceRoutingAdvisor,
  WorkforceAllocationService,
  WorkforceService,
  WORKFORCE_ALLOCATION_ENTITY,
  digest,
} from "../pair/index.js";
import { IntegrityError } from "../pair/errors.js";
import Database from "better-sqlite3";
import { createDatabase } from "../state/database.js";
import { SemanticMemoryManager } from "../memory/semantic.js";
import { ProceduralMemoryManager } from "../memory/procedural.js";
import { canonicallyCompleteMission } from "./canonical-mission-completion.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p17-scope-"));
let counter = 0;
const OP = "p17-owner";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

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
  experience: ExperienceService;
  extractor: ExperienceExtractor;
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
  const experience = new ExperienceService(service);
  const extractor = new ExperienceExtractor(service, experience);
  return { dir, store, biz, wf, workstreams, alloc, authority, service,
    control, projectId: String(project.project_id), experience, extractor };
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

/** A canonical evidence anchor the experience service can resolve —
 *  createCandidate requires ≥1 resolvable ref; any canonical row works. */
function anyRef(s: FullStack): string {
  const p = s.store.list<Row>("project")[0]!;
  return `project:${String(p.project_id)}`;
}

function brainWith(s: FullStack, extra: Record<string, unknown>) {
  return new BrainContextService({
    store: s.store, business: s.biz, workforce: s.wf,
    objectives: s.biz.objectives, workstreams: s.workstreams,
    artifacts: s.authority,
    ...extra,
  });
}

/* ----------------------------- tests ----------------------------- */

describe("P17 — tenancy scope for experience + memory → Brain", () => {

  it("T1 createCandidate validates tenancy against canonical state", () => {
    const { s, oid, bid } = seeded("t1", []);
    const ref = anyRef(s);
    // Objective scope — business auto-derives from the objective.
    const scoped = s.experience.createCandidate({
      type: "EXECUTOR_OBSERVATION", source_evidence_refs: [ref],
      provenance: "t", compatibility_scope: { executors: ["EX_A"] },
      scope_objective_id: oid,
    });
    expect(scoped.scope_objective_id).toBe(oid);
    expect(scoped.scope_business_id).toBe(bid);
    expect(scoped.schema).toBe("pair.os.vnext.experience.v2");
    // Business-only scope.
    const bizScoped = s.experience.createCandidate({
      type: "FAILURE_SIGNATURE", source_evidence_refs: [ref],
      provenance: "t", scope_business_id: bid,
    });
    expect(bizScoped.scope_business_id).toBe(bid);
    expect(bizScoped.scope_objective_id).toBeNull();
    // Unscoped — legal, but scoped reads never admit it.
    const unscoped = s.experience.createCandidate({
      type: "FAILURE_SIGNATURE", source_evidence_refs: [ref],
      provenance: "t",
    });
    expect(unscoped.scope_business_id).toBeNull();
    expect(unscoped.scope_objective_id).toBeNull();
    // Foreign business claim on an objective — fail closed.
    expect(() => s.experience.createCandidate({
      type: "FAILURE_SIGNATURE", source_evidence_refs: [ref],
      provenance: "t", scope_objective_id: oid, scope_business_id: "BIZ_FOREIGN",
    })).toThrowError(IntegrityError);
    // Unresolvable objective / business — fail closed.
    expect(() => s.experience.createCandidate({
      type: "FAILURE_SIGNATURE", source_evidence_refs: [ref],
      provenance: "t", scope_objective_id: "OBJ_MISSING",
    })).toThrowError(IntegrityError);
    expect(() => s.experience.createCandidate({
      type: "FAILURE_SIGNATURE", source_evidence_refs: [ref],
      provenance: "t", scope_business_id: "BIZ_MISSING",
    })).toThrowError(IntegrityError);
    s.store.close();
  });

  it("T2 retrieve() tenancy admission — scoped vs unscoped vs foreign", () => {
    const { s, oid, bid } = seeded("t2", []);
    const bid2 = mkBusiness(s);
    const o2 = mkObjective(s, bid2);
    const ref = anyRef(s);
    const mk = (label: string, scope: Record<string, unknown>) => s.experience.createCandidate({
      type: "FAILURE_SIGNATURE", source_evidence_refs: [ref],
      provenance: label, payload: { label }, ...scope,
    });
    const objRow = mk("obj", { scope_objective_id: oid });
    const bizRow = mk("biz", { scope_business_id: bid });
    const unscoped = mk("unscoped", {});
    const foreign = mk("foreign", { scope_objective_id: String(o2.objective_id) });
    // Promote all four so retrieve's default ACTIVE/QUALIFIED statuses see them.
    for (const r of [objRow, bizRow, unscoped, foreign]) {
      s.experience.qualify(String(r.experience_id), {
        verifier_id: "t", verifier_result: { ok: true } });
    }
    // STRICT unscoped query — "no scope asserted" admits only unscoped
    // rows. A scope-bound row is never visible outside its scope, on
    // ANY read path (the advisor contract fix from P17 R1).
    const all = s.experience.retrieve({ text: "label" });
    expect(all.map((r) => String(r.experience_id))).toEqual(
      [String(unscoped.experience_id)]);
    // Scoped query for objective A: only its own + business-shared rows.
    const scoped = s.experience.retrieve({ objective_id: oid, business_id: bid });
    const ids = scoped.map((r) => String(r.experience_id));
    expect(ids).toContain(String(objRow.experience_id));
    expect(ids).toContain(String(bizRow.experience_id));
    expect(ids).not.toContain(String(unscoped.experience_id));
    expect(ids).not.toContain(String(foreign.experience_id));
    // Objective-only query derives the canonical business itself.
    const scopedObj = s.experience.retrieve({ objective_id: oid });
    expect(scopedObj.map((r) => String(r.experience_id)).sort()).toEqual(
      [String(objRow.experience_id), String(bizRow.experience_id)].sort());
    // Business-only query: business-shared rows only — the foreign row
    // is objective-private to O2 and stays private.
    const scopedB = s.experience.retrieve({ business_id: bid2 });
    expect(scopedB).toHaveLength(0);
    const scopedA = s.experience.retrieve({ business_id: bid });
    expect(scopedA.map((r) => String(r.experience_id))).toEqual(
      [String(bizRow.experience_id)]);
    s.store.close();
  });

  it("T3 scopedFor returns rows + honest exclusion counts", () => {
    const { s, oid, bid } = seeded("t3", []);
    const bid2 = mkBusiness(s);
    const ref = anyRef(s);
    s.experience.createCandidate({ type: "FAILURE_SIGNATURE",
      source_evidence_refs: [ref], provenance: "a", scope_objective_id: oid });
    s.experience.createCandidate({ type: "FAILURE_SIGNATURE",
      source_evidence_refs: [ref], provenance: "b", scope_business_id: bid });
    s.experience.createCandidate({ type: "FAILURE_SIGNATURE",
      source_evidence_refs: [ref], provenance: "u" });
    s.experience.createCandidate({ type: "FAILURE_SIGNATURE",
      source_evidence_refs: [ref], provenance: "f", scope_business_id: bid2 });
    const r = s.experience.scopedFor({ objective_id: oid, business_id: bid });
    // CANDIDATE rows are below the admitted-status floor — in-scope
    // but not surfaced → excluded_ineligible, never hidden.
    expect(r.excluded_unscoped).toBe(1);
    expect(r.excluded_out_of_scope).toBe(1);
    expect(r.excluded_ineligible).toBe(2);
    for (const e of s.store.list<Row>("experience")) {
      s.experience.qualify(String(e.experience_id), {
        verifier_id: "t", verifier_result: { ok: true } });
    }
    const r2 = s.experience.scopedFor({ objective_id: oid, business_id: bid });
    expect(r2.rows.length).toBe(2);
    expect(r2.excluded_unscoped).toBe(1);
    expect(r2.excluded_out_of_scope).toBe(1);
    expect(r2.excluded_ineligible).toBe(0);
    s.store.close();
  });

  it("T4 extraction derives tenancy from the canonical mission chain", () => {
    const { s, oid, bid, binding } = seeded("t4", ["a"]);
    // Drive the bound work item to a canonically completed mission —
    // real work_open_binding → work_item → root → objective chain.
    const cid = childOfKey(s, binding!, "a");
    if (String(s.store.get("work_item", cid).status) === "READY") s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    canonicallyCompleteMission(s.store, s.service, mid);
    const exec = s.store.list<Row>("executor_execution")
      .find((e) => String(e.mission_id) === mid)!;
    const rows = s.extractor.fromExecution(String(exec.execution_id), {
      origin: "REAL_EXECUTION" });
    const eo = rows.find((r) => String(r.type) === "EXECUTOR_OBSERVATION")!;
    expect(eo.scope_objective_id).toBe(oid);
    expect(eo.scope_business_id).toBe(bid);
    // Every extraction fold site carries the same derived scope —
    // the ROUTE_OUTCOME row lands on the same tenancy binding.
    const ro = rows.find((r) => String(r.type) === "ROUTE_OUTCOME");
    if (ro) {
      expect(ro.scope_objective_id).toBe(oid);
      expect(ro.scope_business_id).toBe(bid);
    }
    // A standalone mission (no bound_open_id) degrades to unscoped.
    const standalone = s.service.createMission({
      project_id: s.projectId, goal: "standalone", metadata: {} });
    canonicallyCompleteMission(s.store, s.service, String(standalone.mission_id));
    const exec2 = s.store.list<Row>("executor_execution")
      .find((e) => String(e.mission_id) === String(standalone.mission_id))!;
    const rows2 = s.extractor.fromExecution(String(exec2.execution_id), {
      origin: "REAL_EXECUTION" });
    const eo2 = rows2.find((r) => String(r.type) === "EXECUTOR_OBSERVATION")!;
    expect(eo2.scope_objective_id).toBeNull();
    s.store.close();
  });

  it("T5 cross-scope same-signature folds into DIFFERENT series", () => {
    const { s, oid, bid } = seeded("t5", []);
    const o2 = mkObjective(s, bid); // same business, different objective
    const ref = anyRef(s);
    const obs = (o: string) => s.extractor.fold({
      type: "EXECUTOR_OBSERVATION",
      seriesKey: digest({ type: "EXECUTOR_OBSERVATION", executor: "EX_SAME" }),
      evidenceRef: ref, origin: "REAL_EXECUTION",
      scope: { executors: ["EX_SAME"] },
      payload: { executor_id: "EX_SAME" },
      outcome: "SUCCESS", provenance: "t",
      scopeBusinessId: bid, scopeObjectiveId: o,
    });
    const a1 = obs(oid);
    // Same signature, SAME scope, same ref → semantic no-op (dedup).
    const a2 = obs(oid);
    expect(String(a2.experience_id)).toBe(String(a1.experience_id));
    // Same signature, different objective scope → separate series member.
    const b1 = obs(String(o2.objective_id));
    expect(String(b1.experience_id)).not.toBe(String(a1.experience_id));
    expect(b1.scope_objective_id).toBe(String(o2.objective_id));
    s.store.close();
  });

  it("T6 ScopedMemoryReader — scoped admission + honest exclusions", () => {
    const dir = path.join(ROOT, `${counter++}-mem`);
    fs.mkdirSync(dir, { recursive: true });
    const adb = createDatabase(path.join(dir, "state.db"));
    const sem = new SemanticMemoryManager(adb.raw);
    const proc = new ProceduralMemoryManager(adb.raw);
    const BID = "BIZ_A", OID = "OBJ_A";
    sem.store({ category: "domain", key: "k-obj", value: "v1",
      source: "t", scopeBusinessId: BID, scopeObjectiveId: OID });
    sem.store({ category: "domain", key: "k-biz", value: "v2",
      source: "t", scopeBusinessId: BID });
    sem.store({ category: "domain", key: "k-un", value: "v3", source: "t" });
    sem.store({ category: "domain", key: "k-foreign", value: "v4",
      source: "t", scopeBusinessId: "BIZ_B" });
    proc.save({ name: "p-obj", description: "d1", steps: [],
      scopeBusinessId: BID, scopeObjectiveId: OID });
    proc.save({ name: "p-un", description: "d2", steps: [] });
    const reader = new ScopedMemoryReader(adb.raw);
    const r = reader.scopedFor({ business_id: BID, objective_id: OID });
    expect(r.semantic.map((e) => e.name).sort()).toEqual(["k-biz", "k-obj"]);
    expect(r.procedural.map((e) => e.name)).toEqual(["p-obj"]);
    expect(r.excluded_unscoped).toBe(2); // k-un + p-un
    expect(r.excluded_out_of_scope).toBe(1); // k-foreign
    expect(r.semantic.every((e) => e.trust_class === "MODEL_HYPOTHESIS")).toBe(true);
    adb.close();
  });

  it("T6b legacy memory schema (no scope columns) — all rows unscoped", () => {
    const dir = path.join(ROOT, `${counter++}-memlegacy`);
    fs.mkdirSync(dir, { recursive: true });
    const raw = new Database(path.join(dir, "legacy.db"));
    raw.exec(`CREATE TABLE semantic_memory (id TEXT PRIMARY KEY, category TEXT NOT NULL,
      key TEXT NOT NULL, value TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL, UNIQUE(category, key));
      CREATE TABLE procedural_memory (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL, steps TEXT NOT NULL);`);
    raw.prepare("INSERT INTO semantic_memory (id,category,key,value,source) VALUES (?,?,?,?,?)")
      .run("s1", "domain", "k", "v", "t");
    raw.prepare("INSERT INTO procedural_memory (id,name,description,steps) VALUES (?,?,?,?)")
      .run("p1", "n", "d", "[]");
    const reader = new ScopedMemoryReader(raw);
    const r = reader.scopedFor({ business_id: "B", objective_id: "O" });
    expect(r.semantic).toHaveLength(0);
    expect(r.procedural).toHaveLength(0);
    expect(r.excluded_unscoped).toBe(2);
    raw.close();
  });

  it("T7 BrainContext — wired seams carry scoped data; unwired report *_NOT_WIRED", () => {
    const { s, oid, bid } = seeded("t7", []);
    const ref = anyRef(s);
    s.experience.createCandidate({ type: "FAILURE_SIGNATURE",
      source_evidence_refs: [ref], provenance: "a", scope_objective_id: oid });
    s.experience.createCandidate({ type: "FAILURE_SIGNATURE",
      source_evidence_refs: [ref], provenance: "u" });
    for (const e of s.store.list<Row>("experience")) {
      s.experience.qualify(String(e.experience_id), {
        verifier_id: "t", verifier_result: { ok: true } });
    }
    const dir = path.join(ROOT, `${counter++}-t7mem`);
    fs.mkdirSync(dir, { recursive: true });
    const adb = createDatabase(path.join(dir, "state.db"));
    new SemanticMemoryManager(adb.raw).store({
      category: "domain", key: "k", value: "v", source: "t", scopeBusinessId: bid });
    const reader = new ScopedMemoryReader(adb.raw);
    const wired = brainWith(s, { experience: s.experience, scopedMemory: reader });
    const before = logFootprint(s.store);
    const c = wired.contextFor(oid, OWNER);
    const exp = c.sections.experience!.value as Record<string, unknown>;
    expect(Number(exp.admitted)).toBe(1);
    expect((exp.excluded as Record<string, unknown>).unscoped).toBe(1);
    const mem = c.sections.memory!.value as Record<string, unknown>;
    expect((mem.semantic as unknown[]).length).toBe(1);
    // The read is still zero-write — canonical footprint unchanged.
    expect(logFootprint(s.store)).toEqual(before);
    // Unwired deps → typed gaps, never fabricated data.
    const unwired = brainWith(s, {});
    const c2 = unwired.contextFor(oid, OWNER);
    expect(c2.sections.experience!.unavailable.some((u) => u.startsWith("EXPERIENCE_NOT_WIRED"))).toBe(true);
    expect(c2.sections.memory!.unavailable.some((u) => u.startsWith("MEMORY_NOT_WIRED"))).toBe(true);
    adb.close();
    s.store.close();
  });

  it("T8 ReasoningBrief — scoped facts surface with honest provenance", () => {
    const { s, oid, bid } = seeded("t8", []);
    const ref = anyRef(s);
    s.experience.createCandidate({ type: "FAILURE_SIGNATURE",
      source_evidence_refs: [ref], provenance: "a", scope_objective_id: oid });
    for (const e of s.store.list<Row>("experience")) {
      s.experience.qualify(String(e.experience_id), {
        verifier_id: "t", verifier_result: { ok: true } });
    }
    const dir = path.join(ROOT, `${counter++}-t8mem`);
    fs.mkdirSync(dir, { recursive: true });
    const adb = createDatabase(path.join(dir, "state.db"));
    // One scoped memory row — the MEMORY fact emits only on real
    // content (an empty wired table mints no permanent UNVERIFIED fact).
    new SemanticMemoryManager(adb.raw).store({
      category: "domain", key: "k", value: "v", source: "t",
      scopeBusinessId: bid });
    const brain = brainWith(s, {
      experience: s.experience, scopedMemory: new ScopedMemoryReader(adb.raw) });
    const briefs = new ReasoningBriefService(s.store, { brain });
    const b = briefs.briefFor(oid, OWNER);
    const expFact = b.facts.find((f) => f.predicate === "EXPERIENCE")!;
    expect(expFact.provenance).toBe("PROJECTED");
    expect((expFact.value as Record<string, unknown>).admitted).toBe(1);
    const memFact = b.facts.find((f) => f.predicate === "MEMORY")!;
    expect(memFact.provenance).toBe("UNVERIFIED");
    // SCOPE_BINDING_ABSENT is gone — the sections now carry real data.
    expect(b.missing_information.every((g) => g.code !== "SCOPE_BINDING_ABSENT")).toBe(true);
    adb.close();
    s.store.close();
  });

  it("T9 malformed scoped-memory binding (objective + foreign business) denied", () => {
    const dir = path.join(ROOT, `${counter++}-mem2`);
    fs.mkdirSync(dir, { recursive: true });
    const adb = createDatabase(path.join(dir, "state.db"));
    // scope_objective_id=OBJ_A but scope_business_id=BIZ_B — the
    // business disagrees with the objective's own; never admitted.
    adb.raw.prepare(
      "INSERT INTO semantic_memory (id,category,key,value,source,scope_business_id,scope_objective_id) VALUES (?,?,?,?,?,?,?)")
      .run("m1", "domain", "k", "v", "t", "BIZ_B", "OBJ_A");
    const r = new ScopedMemoryReader(adb.raw)
      .scopedFor({ business_id: "BIZ_A", objective_id: "OBJ_A" });
    expect(r.semantic).toHaveLength(0);
    expect(r.excluded_out_of_scope).toBe(1);
    adb.close();
  });

  it("T11 routing advisor reads only the mission's tenancy scope", () => {
    const { s, oid, bid, binding } = seeded("t11", ["a"]);
    const bid2 = mkBusiness(s);
    const o2 = mkObjective(s, bid2);
    const ref = anyRef(s);
    const mk = (label: string, scope: Record<string, unknown>) => s.experience.createCandidate({
      type: "EXECUTOR_OBSERVATION", source_evidence_refs: [ref],
      provenance: label, compatibility_scope: { executors: ["EX_A"] },
      outcome: "SUCCESS", ...scope,
    });
    const objRow = mk("obj", { scope_objective_id: oid });
    const bizRow = mk("biz", { scope_business_id: bid });
    const unscoped = mk("unscoped", {});
    const foreign = mk("foreign", { scope_objective_id: String(o2.objective_id) });
    for (const r of s.store.list<Row>("experience")) {
      s.experience.qualify(String(r.experience_id), {
        verifier_id: "t", verifier_result: { ok: true } });
    }
    // Drive the bound work item to a real bound mission — the advisor
    // resolves its tenancy through the canonical chain.
    const cid = childOfKey(s, binding!, "a");
    if (String(s.store.get("work_item", cid).status) === "READY") s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    const advisor = new VerifiedExperienceRoutingAdvisor(s.service, s.experience);
    const rec = advisor.advise({
      eligible: [{ executor_id: "EX_A" } as never],
      task: { mission_id: mid } as never,
    });
    const considered = rec.experience_ids_considered as string[];
    expect(considered).toContain(String(objRow.experience_id));
    expect(considered).toContain(String(bizRow.experience_id));
    // THE LEAK (R1-MAJOR): foreign-scope + unscoped rows must never
    // reach a scoped mission's routing advice.
    expect(considered).not.toContain(String(foreign.experience_id));
    expect(considered).not.toContain(String(unscoped.experience_id));
    // A scopeless mission sees only unscoped rows.
    const standalone = s.service.createMission({
      project_id: s.projectId, goal: "standalone", metadata: {} });
    const rec2 = advisor.advise({
      eligible: [{ executor_id: "EX_A" } as never],
      task: { mission_id: String(standalone.mission_id) } as never,
    });
    expect(rec2.experience_ids_considered as string[]).toEqual([String(unscoped.experience_id)]);
    s.store.close();
  });

  it("T12 planner advisor reads only the mission's tenancy scope", () => {
    const { s, oid, bid, binding } = seeded("t12", ["a"]);
    const ref = anyRef(s);
    const scoped = s.experience.createCandidate({
      type: "PLAN_TEMPLATE", source_evidence_refs: [ref],
      provenance: "a", scope_objective_id: oid });
    s.experience.createCandidate({
      type: "PLAN_TEMPLATE", source_evidence_refs: [ref],
      provenance: "u" });
    for (const r of s.store.list<Row>("experience")) {
      s.experience.qualify(String(r.experience_id), {
        verifier_id: "t", verifier_result: { ok: true } });
    }
    const cid = childOfKey(s, binding!, "a");
    if (String(s.store.get("work_item", cid).status) === "READY") s.biz.openWorkItem(cid, OP);
    const mid = boundMissionId(s, cid);
    const advisor = new VerifiedExperiencePlannerAdvisor(s.service, s.experience);
    const rec = advisor.advise({ goal: "g", mission_id: mid });
    expect(rec.experience_ids_considered as string[]).toEqual([String(scoped.experience_id)]);
    s.store.close();
  });

  it("T10 forged experience scope binding → exclusion, never admitted", () => {
    const { s, oid, bid } = seeded("t10", []);
    const bid2 = mkBusiness(s);
    const ref = anyRef(s);
    const row = s.experience.createCandidate({ type: "FAILURE_SIGNATURE",
      source_evidence_refs: [ref], provenance: "a", scope_objective_id: oid });
    s.experience.qualify(String(row.experience_id), {
      verifier_id: "t", verifier_result: { ok: true } });
    // Raw forge: rewrite the scope to objective A + business B2 — the
    // malformed pair must be denied admission on the read path.
    const payload = JSON.parse(
      (dbOf(s.store)
        .prepare("SELECT payload FROM entities WHERE entity_type='experience' AND entity_id=?")
        .get(String(row.experience_id)) as { payload: string }).payload);
    payload.scope_business_id = bid2;
    dbOf(s.store)
      .prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type='experience' AND entity_id=?")
      .run(JSON.stringify(payload), digest(payload), String(row.experience_id));
    const r = s.experience.scopedFor({ objective_id: oid, business_id: bid });
    expect(r.rows.map((x) => String(x.experience_id)))
      .not.toContain(String(row.experience_id));
    expect(r.excluded_out_of_scope).toBe(1);
    s.store.close();
  });
});
