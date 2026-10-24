/**
 * P16-C — CEO consumption of the ReasoningBrief acceptance suite.
 *
 * The seam: CeoObservationDeps.brain_brief composes an advisory
 * briefObservationView INSIDE observation_digest — cycle identity,
 * replay, and the post-invocation drift check all bind the brief's
 * canonical content. The brief is ADVISORY-ONLY: it can never mint
 * authority, never skips the canonical decision validator, and never
 * becomes a command.
 *
 *   C1  — brief attached: brain_brief present in the prompt's
 *         serialized observation, self-labeled ADVISORY_ONLY, digest
 *         fields bound; WAIT decision commits normally.
 *   C2  — replay invariance: identical canonical state replays with
 *         ZERO additional invocations (brief cannot destabilize the
 *         digest that drives cycle identity).
 *   C3  — advisory isolation: a malformed/authority-violating model
 *         decision is rejected by the UNCHANGED canonical validator;
 *         brief content loosens nothing.
 *   C4a — compositional IntegrityError degrades to a deterministic
 *         BRAIN_BRIEF_UNAVAILABLE marker inside the digest; the cycle
 *         commits (the advisory surface never wedges the cycle).
 *   C4b — non-IntegrityError seam throws propagate fail-closed BEFORE
 *         the attempt claim — zero attempt rows, zero invocations.
 *   C5  — no writes added: the entity/event type footprint of a cycle
 *         is identical with and without the brief seam (reads only).
 *   C6  — read identity: a non-owner invoker actor still composes the
 *         OWNER's brief; the invoker's identity stays on attempt
 *         provenance (started_by).
 *   C7  — view binding: digest(view − brief_digest) === brief_digest;
 *         volatile fields (asof/actor/effective/expiry_pending/
 *         eligibility/failure_code/transport) never reach the view.
 *   C8  — digest binding: a wired seam changes observation_digest;
 *         the same seam is deterministic across reads.
 *   C9  — drift binds brief: a mid-flight auto-policy mutation
 *         invisible to the CEO observation fields settles the attempt
 *         STALE only when the brief is wired — the post-invocation
 *         drift check binds brief content, not just the old fields.
 *   C10 — prompt contract: the user prompt carries the advisory
 *         boundary line + the full serialized brief projection.
 *   C11 — bound objective: BINDING/WORKSTREAM_STATE facts reach the
 *         prompt; PRIORITIZE_EXISTING commits through the unchanged
 *         canonical gate.
 *   C12 — unproven KPI claim (hash-consistent row, current outside
 *         objective_digest): the seam's stronger re-proof fails →
 *         typed marker, cycle commits AND replays — the advisory
 *         surface never wedges replay either.
 *   C13 — forged non-operator owner_authority_id → marker +
 *         seam never invoked (assertOwnerAuthorityRef pins the read
 *         identity before the seam's owner gate could pass
 *         tautologically on the row's own value).
 *
 * Harness mirrors pair-p15-3 (FakeInvoker + mkModel/mkProvider) over
 * the real P16-B stack (freshFullStack + ReasoningBriefService).
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
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduleService,
  MissionScheduler,
  MissionSupervisor,
  ModelEvidenceCatalog,
  ObjectiveAutoPolicyService,
  ObjectiveWorkstreamService,
  PairControlPlane,
  PairEvidenceStore,
  ProviderCatalog,
  ReconciliationService,
  RecoveryController,
  WorkforceService,
  briefObservationView,
  buildCeoObservation,
  buildCeoUserPrompt,
  CeoPlanningCycleService,
  digest,
  objectiveDigest,
  providerEntryId,
  qualifyModel,
  termsOf,
  ReasoningBriefService,
  type CeoDecisionInvoker,
  type CeoInvokeInput,
  type CeoInvokeResult,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p16c-"));
let counter = 0;
const OP = "p16c-owner";
const OWNER = `operator:${OP}`;
const FUTURE = "2999-01-01T00:00:00.000Z";
const KPI = "KPI_DELIVERABLES";

type Row = Record<string, unknown> & { version: number };

const CEO_WAIT = JSON.stringify({
  schema: "pair.ceo-decision.v1", decision_kind: "WAIT",
  workstreams: null, priority_order: null,
  wait_reason: "AWAITING_PROGRESS", summary: null,
});

class FakeInvoker implements CeoDecisionInvoker {
  calls = 0;
  inputs: CeoInvokeInput[] = [];
  constructor(
    private readonly raw: string | ((i: CeoInvokeInput) => string),
  ) {}
  async invoke(input: CeoInvokeInput): Promise<CeoInvokeResult> {
    this.calls++;
    this.inputs.push(input);
    return {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: typeof this.raw === "function" ? this.raw(input) : this.raw,
    };
  }
}

const mkModel = (store: PairEvidenceStore, pid: string, mid: string) => {
  const mcat = new ModelEvidenceCatalog(store);
  const { entry } = mcat.upsertModelClaim({
    provider_id: pid, provider_family: pid, model_id: mid,
    capability_hints: ["text_inference"],
  });
  const eid = String(entry.model_entry_id);
  mcat.recordProbeReceipt({
    probe_id: `PRB_${pid}_${mid}`.replace(/[^A-Za-z0-9_-]/g, "_"),
    model_entry_id: eid, provider_id: pid, result: "PASS",
    probe_type: "text_inference",
    capability_evidence: { text_inference: "PASS" }, latency_ms: 1,
  });
  const q = qualifyModel(store, eid, { capability_scope: ["text_inference"], actor: "t" });
  if (!q.qualified) throw new Error("mkModel fixture failed");
  return eid;
};

const mkProvider = (store: PairEvidenceStore, pid: string) => {
  const id = providerEntryId(pid);
  store.put("provider", id, {
    provider_id: pid, entry_id: id,
    lifecycle_state: "QUALIFIED", auth_state: "AUTH_OK",
    health_state: "READY", conditions: [], probe_state: "PROBED",
    provider_type: "LOCAL_CLI", protocol_family: "CODEX_CLI",
    endpoint_reference: "codex-cli://local",
    configured_endpoint_identity: "codex-cli://local",
    credential_envs: [], credential_reference_name: null,
  }, 0);
  new ProviderCatalog(store).issueQualificationReceipt(
    pid, { policy_version: "test-policy", actor: "test" });
};

type Stack = {
  dir: string;
  store: PairEvidenceStore; biz: BusinessLayer; wf: WorkforceService;
  workstreams: ObjectiveWorkstreamService;
  service: PairControlPlane; control: MissionControl;
  projectId: string; brain: BrainContextService;
};

function freshStack(name: string): Stack {
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
    schedules: new MissionScheduleService(service) });
  const wf = new WorkforceService({ store, business: biz });
  const workstreams = new ObjectiveWorkstreamService(
    { store, business: biz, workforce: wf, objectives: biz.objectives });
  const project = service.createProject({ name: "p", root_location: workspace });
  const brain = new BrainContextService({
    store, business: biz, workforce: wf,
    objectives: biz.objectives, workstreams });
  return { dir, store, biz, wf, workstreams, service, control,
    projectId: String(project.project_id), brain };
}

function mkBusiness(s: Stack) {
  return String(s.biz.createBusiness({
    name: `b${counter}`, project_id: s.projectId, operator_id: OP }).business_id);
}

function mkObjective(s: Stack, businessId: string) {
  return s.biz.objectives.create({
    business_id: businessId,
    title: "obj", statement: "Produce deliverables.",
    kpis: [{ kpi_id: KPI, name: "deliverables", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: FUTURE, budget_ceiling_microusd: 500_000,
    dedup_key: `dk-${counter++}`, operator_id: OP,
  });
}

/** The production seam wiring — same shape as ceo-runtime's default:
 *  briefFor → briefObservationView bound to the stack's brain. */
function briefSeam(s: Stack, modelEntryId: string) {
  const briefs = new ReasoningBriefService(s.store, {
    brain: s.brain, model_entry_id: modelEntryId });
  return (objectiveId: string, ownerActor: string) =>
    briefObservationView(briefs.briefFor(objectiveId, ownerActor));
}

function ceoStack(name: string, raw: string | ((i: CeoInvokeInput) => string), opts: {
  brain_brief?: (objectiveId: string, ownerActor: string) => Record<string, unknown>;
  extraDeps?: Record<string, unknown>;
} = {}) {
  const s = freshStack(name);
  const me = mkModel(s.store, "codex-cli", `ceo-m-${counter}`);
  mkProvider(s.store, "codex-cli");
  const invoker = new FakeInvoker(raw);
  const svc = new CeoPlanningCycleService({
    store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
    proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
    invoker, model_entry_id: me,
    ...(opts.brain_brief ? { brain_brief: opts.brain_brief } : {}),
    ...(opts.extraDeps ?? {}),
  });
  const bid = mkBusiness(s);
  const o = mkObjective(s, bid);
  const oid = String(o.objective_id);
  return { ...s, svc, invoker, me, oid, bid };
}

const attemptsOf = (store: PairEvidenceStore) => store.list("ceo_decision_attempt") as Row[];
const decisionsOf = (store: PairEvidenceStore) => store.list("ceo_decision") as Row[];

const PRIORITIZE_JSON = (keys: string[]) => JSON.stringify({
  schema: "pair.ceo-decision.v1", decision_kind: "PRIORITIZE_EXISTING",
  workstreams: null, priority_order: keys,
  wait_reason: null, summary: "order",
});

function decompose(s: Stack, oid: string, keys: string[]) {
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

/** Rewrite an entity payload in place with recomputed payload_hash —
 *  the canonical hash-consistent mutation primitive. */
function sqlRewriteEntity(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  fn: (body: Record<string, unknown>) => void,
): void {
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  const row = db.prepare(
    "SELECT payload FROM entities WHERE entity_type=? AND entity_id=?")
    .get(entityType, entityId) as { payload: string } | undefined;
  if (!row) throw new Error(`entity ${entityType}:${entityId} absent`);
  const body = JSON.parse(row.payload) as Record<string, unknown>;
  fn(body);
  db.prepare(
    "UPDATE entities SET payload=?, payload_hash=? WHERE entity_type=? AND entity_id=?")
    .run(JSON.stringify(body), digest(body), entityType, entityId);
}

function footprint(store: PairEvidenceStore) {
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  const ev = (db.prepare(
    "SELECT entity_type t, event_type e FROM events ORDER BY rowid").all() as Row[])
    .map((r) => `${r.t}:${r.e}`);
  const en = (db.prepare(
    "SELECT entity_type t FROM entities ORDER BY rowid").all() as Row[])
    .map((r) => String(r.t));
  return { events: ev, entities: en };
}

describe("P16-C — CEO consumes ReasoningBrief", () => {
  it("C1 brief attached inside the observation envelope, decision commits", async () => {
    const s = ceoStack("c1", CEO_WAIT, { brain_brief: undefined });
    // wire the real seam
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: briefSeam(s, s.me),
    });
    const r = await svc.runCycle({ objective_id: s.oid, actor: OP });
    expect(String(r.decision.decision_kind)).toBe("WAIT");
    expect(String(r.decision.state)).toBe("COMMITTED");
    const input = s.invoker.inputs[0]!;
    expect(input.user_prompt).toContain("brain_brief");
    expect(input.user_prompt).toContain("ADVISORY-ONLY context");
    const obs = JSON.parse(
      input.user_prompt.split("\n")[1]!) as Record<string, unknown>;
    const bb = obs.brain_brief as Record<string, unknown>;
    expect(bb.authority).toBe("ADVISORY_ONLY");
    expect(String(bb.schema_version)).toBe("pair.os.vnext.reasoning-brief.v1");
    expect(typeof bb.context_digest).toBe("string");
    expect(typeof bb.brief_digest).toBe("string");
    expect((bb.facts as unknown[]).length).toBeGreaterThan(0);
    expect((bb.options as unknown[]).length).toBeGreaterThan(0);
    s.store.close();
  });

  it("C2 replay invariance — same canonical state → zero extra invocations", async () => {
    const s = ceoStack("c2", CEO_WAIT);
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: briefSeam(s, s.me),
    });
    const r1 = await svc.runCycle({ objective_id: s.oid, actor: OP });
    const r2 = await svc.runCycle({ objective_id: s.oid, actor: OP });
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
    expect(s.invoker.calls).toBe(1);
    expect(String(r2.decision.decision_id)).toBe(String(r1.decision.decision_id));
    s.store.close();
  });

  it("C3 advisory isolation — malformed decision rejected by unchanged validator", async () => {
    // A decision object missing required fields must still die in
    // assertCanonicalCeoDecision / parse — brief presence loosens nothing.
    const s = ceoStack("c3", JSON.stringify({ schema: "pair.ceo-decision.v1", decision_kind: "EXECUTE_NOW" }), {
      brain_brief: undefined,
    });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: briefSeam(s, s.me),
    });
    await expect(svc.runCycle({ objective_id: s.oid, actor: OP }))
      .rejects.toMatchObject({ code: "FAIL_CLOSED_CEO_DECISION_INVALID" });
    expect(decisionsOf(s.store)).toHaveLength(0);
    const att = attemptsOf(s.store)[0]!;
    expect(String(att.state)).toBe("REJECTED");
    s.store.close();
  });

  it("C4a compositional IntegrityError degrades to a typed marker — cycle commits", async () => {
    const s = ceoStack("c4a", CEO_WAIT);
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: () => {
        throw new IntegrityError("FAIL_CLOSED_BRAIN_BUDGET", "test");
      },
    });
    const r = await svc.runCycle({ objective_id: s.oid, actor: OP });
    expect(String(r.decision.state)).toBe("COMMITTED");
    const obs = JSON.parse(
      s.invoker.inputs[0]!.user_prompt.split("\n")[1]!) as Record<string, unknown>;
    const bb = obs.brain_brief as Record<string, unknown>;
    expect(bb.kind).toBe("BRAIN_BRIEF_UNAVAILABLE");
    expect(bb.authority).toBe("ADVISORY_ONLY");
    expect(bb.reason).toBe("FAIL_CLOSED_BRAIN_BUDGET");
    s.store.close();
  });

  it("C4b non-IntegrityError propagates fail-closed BEFORE the attempt claim", async () => {
    const s = ceoStack("c4b", CEO_WAIT);
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: () => {
        throw new TypeError("programmer bug");
      },
    });
    await expect(svc.runCycle({ objective_id: s.oid, actor: OP }))
      .rejects.toBeInstanceOf(TypeError);
    expect(s.invoker.calls).toBe(0);
    expect(attemptsOf(s.store)).toHaveLength(0);
    expect(decisionsOf(s.store)).toHaveLength(0);
    s.store.close();
  });

  it("C5 the seam adds zero writes — identical event/entity footprint", async () => {
    const a = ceoStack("c5a", CEO_WAIT); // no brief
    await a.svc.runCycle({ objective_id: a.oid, actor: OP });
    const b = ceoStack("c5b", CEO_WAIT);
    const svc = new CeoPlanningCycleService({
      store: b.store, objectives: b.biz.objectives, workstreams: b.workstreams,
      proveWorkItemDone: (row) => b.biz.proveWorkItemDone(row as never),
      invoker: b.invoker, model_entry_id: b.me,
      brain_brief: briefSeam(b, b.me),
    });
    await svc.runCycle({ objective_id: b.oid, actor: OP });
    // The TYPE sequence must match exactly — the brief composes reads
    // only. (ids/digests differ because observation content differs.)
    const fa = footprint(a.store);
    const fb = footprint(b.store);
    expect(fb.events).toEqual(fa.events);
    expect(fb.entities).toEqual(fa.entities);
    a.store.close(); b.store.close();
  });

  it("C6 non-owner invoker actor — brief composes under canonical owner", async () => {
    const s = ceoStack("c6", CEO_WAIT);
    let seenActor: string | null = null;
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: (oid, actor) => {
        seenActor = actor;
        return briefSeam(s, s.me)(oid, actor);
      },
    });
    const r = await svc.runCycle({ objective_id: s.oid, actor: "someone-else" });
    // The read identity is the CANONICAL owner, not the invoker.
    expect(seenActor).toBe(OWNER);
    // Invoker provenance is preserved on the attempt row.
    const att = attemptsOf(s.store).find((a) => String(a.attempt_id) === String(r.attempt_id))!;
    expect(String(att.started_by)).toBe("someone-else");
    s.store.close();
  });

  it("C7 view binding — digest(view − brief_digest) === brief_digest; no volatile fields", () => {
    const s = freshStack("c7");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    const me = mkModel(s.store, "codex-cli", `ceo-m-${counter}`);
    mkProvider(s.store, "codex-cli");
    const brief = new ReasoningBriefService(s.store, {
      brain: s.brain, model_entry_id: me }).briefFor(oid, OWNER);
    const view = briefObservationView(brief);
    const { brief_digest, ...rest } = view as { brief_digest: string } & Record<string, unknown>;
    expect(digest(rest)).toBe(brief_digest);
    const ser = JSON.stringify(view);
    for (const k of ["asof", "\"actor\"", "effective", "expiry_pending",
      "eligibility", "failure_code", "transport"]) {
      expect(ser.includes(k)).toBe(false);
    }
    // Deterministic across reads.
    const view2 = briefObservationView(
      new ReasoningBriefService(s.store, { brain: s.brain }).briefFor(oid, OWNER));
    // reasoner binding differs (me vs none) — facts/options identical.
    expect((view2.facts as unknown[])).toEqual(view.facts);
    s.store.close();
  });

  it("C8 observation digest binds the brief; seam determinism", () => {
    const s = freshStack("c8");
    const bid = mkBusiness(s);
    const o = mkObjective(s, bid);
    const oid = String(o.objective_id);
    const me = mkModel(s.store, "codex-cli", `ceo-m-${counter}`);
    mkProvider(s.store, "codex-cli");
    const deps = {
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row: Record<string, unknown>) =>
        s.biz.proveWorkItemDone(row as never),
    };
    const plain = buildCeoObservation(deps, oid);
    const wired = buildCeoObservation(
      { ...deps, brain_brief: briefSeam(s, me) }, oid);
    expect(wired.observation_digest).not.toBe(plain.observation_digest);
    const wired2 = buildCeoObservation(
      { ...deps, brain_brief: briefSeam(s, me) }, oid);
    expect(wired2.observation_digest).toBe(wired.observation_digest);
    s.store.close();
  });

  it("C9 mid-flight policy mutation → STALE only when the brief is wired", async () => {
    // A canonical mutation invisible to the CEO observation fields —
    // the auto-policy row never appears in objective/binding/workstreams —
    // must still stale the attempt when the brief binds it.
    const run = async (wire: boolean) => {
      const s = ceoStack(wire ? "c9w" : "c9p", CEO_WAIT);
      const policy = new ObjectiveAutoPolicyService(s.store, s.biz.objectives);
      const svc = new CeoPlanningCycleService({
        store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
        proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
        invoker: s.invoker, model_entry_id: s.me,
        ...(wire
          ? { brain_brief: (() => {
              const brain = new BrainContextService({
                store: s.store, business: s.biz, workforce: s.wf,
                objectives: s.biz.objectives, workstreams: s.workstreams,
                autoPolicy: policy });
              const briefs = new ReasoningBriefService(s.store, {
                brain, model_entry_id: s.me });
              return (oid: string, actor: string) =>
                briefObservationView(briefs.briefFor(oid, actor));
            })() }
          : {}),
        after_attempt_claim: () => {
          policy.control({
            objective_id: s.oid, actor: OWNER, action: "configure",
            limits: { expires_at: FUTURE, max_ceo_calls: 4 },
            idempotency_key: `cfg-${counter++}`,
          });
        },
      });
      try {
        const r = await svc.runCycle({ objective_id: s.oid, actor: OP });
        return { stale: false as const, r, s };
      } catch (e) {
        return { stale: true as const, err: e as IntegrityError, s };
      }
    };
    // Without the seam the policy flip is invisible — decision commits.
    const plain = await run(false);
    expect(plain.stale).toBe(false);
    const attP = attemptsOf(plain.s.store)[0]!;
    expect(String(attP.state)).toBe("ACCEPTED");
    // With the seam the same mutation lands inside the bound brief —
    // the fresh observation digests it and the attempt settles STALE.
    const wired = await run(true);
    expect(wired.stale).toBe(true);
    expect(String(wired.err!.code)).toBe("FAIL_CLOSED_CEO_OBSERVATION_STALE");
    const attW = attemptsOf(wired.s.store)[0]!;
    expect(String(attW.state)).toBe("STALE");
    expect(decisionsOf(wired.s.store)).toHaveLength(0);
    plain.s.store.close(); wired.s.store.close();
  });

  it("C10 prompt contract — advisory line + full serialized projection", async () => {
    const s = ceoStack("c10", CEO_WAIT);
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: briefSeam(s, s.me),
    });
    await svc.runCycle({ objective_id: s.oid, actor: OP });
    const prompt = s.invoker.inputs[0]!.user_prompt;
    expect(prompt).toContain(
      "brain_brief section is ADVISORY-ONLY context");
    expect(prompt).toContain("never commands");
    // The serialized observation embeds the full projection.
    const obs = JSON.parse(prompt.split("\n")[1]!) as Record<string, unknown>;
    const bb = obs.brain_brief as Record<string, unknown>;
    for (const f of ["facts", "hypotheses", "options",
      "missing_information", "confidence", "context_digest", "brief_digest"]) {
      expect(bb[f]).toBeDefined();
    }
    // Without the seam the prompt keeps its original shape (no clause).
    const plain = buildCeoUserPrompt({ a: 1 });
    expect(plain).not.toContain("ADVISORY-ONLY");
    s.store.close();
  });

  it("C11 bound objective — WORKSTREAM_STATE/BINDING facts reach the prompt; PRIORITIZE commits", async () => {
    const s = ceoStack("c11", PRIORITIZE_JSON(["a", "b"]));
    decompose(s, s.oid, ["a", "b"]);
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: briefSeam(s, s.me),
    });
    const r = await svc.runCycle({ objective_id: s.oid, actor: OP });
    expect(String(r.decision.decision_kind)).toBe("PRIORITIZE_EXISTING");
    expect(String(r.decision.state)).toBe("COMMITTED");
    const obs = JSON.parse(
      s.invoker.inputs[0]!.user_prompt.split("\n")[1]!) as Record<string, unknown>;
    const bb = obs.brain_brief as Record<string, unknown>;
    const preds = (bb.facts as Array<{ predicate: string }>).map((f) => f.predicate);
    expect(preds).toContain("BINDING");
    expect(preds).toContain("WORKSTREAM_STATE");
    s.store.close();
  });

  it("C12 unproven KPI claim — typed marker, cycle commits AND replays", async () => {
    /* R1-MAJOR repro: kpis[0].current is group-A runtime state OUTSIDE
       objective_digest — a hash-consistent row carrying an unproven
       current passes objectives.get but fails the seam's stronger
       re-proof (assertCanonicalObjectiveKpiProgress). Without the
       marker the advisory surface would wedge the authoritative cycle
       and its replay forever on a legitimately-degraded objective. */
    const s = ceoStack("c12", CEO_WAIT);
    sqlRewriteEntity(s.store, "objective", s.oid, (b) => {
      (b.kpis as Row[])[0]!.current = 1;
    });
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: briefSeam(s, s.me),
    });
    const r1 = await svc.runCycle({ objective_id: s.oid, actor: OP });
    expect(String(r1.decision.state)).toBe("COMMITTED");
    const obs = JSON.parse(
      s.invoker.inputs[0]!.user_prompt.split("\n")[1]!) as Record<string, unknown>;
    const bb = obs.brain_brief as Record<string, unknown>;
    expect(bb.kind).toBe("BRAIN_BRIEF_UNAVAILABLE");
    expect(String(bb.reason)).toContain("FAIL_CLOSED");
    // The exact property the wedge destroyed: replay of the committed
    // decision still serves on the SAME (degraded) canonical state.
    const r2 = await svc.runCycle({ objective_id: s.oid, actor: OP });
    expect(r2.replayed).toBe(true);
    expect(s.invoker.calls).toBe(1);
    s.store.close();
  });

  it("C13 forged owner ref → marker + seam never invoked (no tautological gate)", async () => {
    /* A hash-consistent row carrying a non-operator owner_authority_id
       passes objectives.get (assertCanonicalRow checks string shape
       only). assertOwnerAuthorityRef at the seam re-validates before
       the value becomes the read identity — without it the seam's
       owner gate would pass tautologically on the row's own value. */
    const s = ceoStack("c13", CEO_WAIT);
    sqlRewriteEntity(s.store, "objective", s.oid, (b) => {
      b.owner_authority_id = "agent:forged";
      // owner_authority_id is inside termsOf — the forge stays
      // digest-consistent only when the self-digest is recomputed,
      // exactly like the repo's own tamper fixtures.
      b.objective_digest = objectiveDigest({
        objective_id: String(b.objective_id),
        business_id: String(b.business_id),
        terms_version: Number(b.terms_version),
        terms: termsOf(b as Row),
        create_semantic_digest: String(b.create_semantic_digest),
      });
    });
    let seamCalled = false;
    const svc = new CeoPlanningCycleService({
      store: s.store, objectives: s.biz.objectives, workstreams: s.workstreams,
      proveWorkItemDone: (row) => s.biz.proveWorkItemDone(row as never),
      invoker: s.invoker, model_entry_id: s.me,
      brain_brief: (oid, actor) => {
        seamCalled = true;
        return briefSeam(s, s.me)(oid, actor);
      },
    });
    const r = await svc.runCycle({ objective_id: s.oid, actor: OP });
    expect(String(r.decision.state)).toBe("COMMITTED");
    expect(seamCalled).toBe(false);
    const obs = JSON.parse(
      s.invoker.inputs[0]!.user_prompt.split("\n")[1]!) as Record<string, unknown>;
    const bb = obs.brain_brief as Record<string, unknown>;
    expect(bb.kind).toBe("BRAIN_BRIEF_UNAVAILABLE");
    expect(bb.reason).toBe("FAIL_CLOSED_OBJECTIVE_FIELD");
    s.store.close();
  });
});
