/**
 * P4 tests — three-layer trust model + persistence convergence.
 *  Layer A: cognitive (non-authoritative), Layer B: canonical evidence,
 *  Layer C: verified experience (advisory, firewall-gated).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, insertKnowledge, getTaskById } from "../state/database.js";
import { rememberFact } from "../memory/tools.js";
import { SemanticMemoryManager } from "../memory/semantic.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import {
  ArtifactProvenanceValidator,
  ExperienceService,
  ExecutorRegistry,
  GovernedTaskGate,
  IntegrityError,
  MissionRouter,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  PairPersistence,
  PersistenceMigrator,
  PAIR_NATIVE_EXECUTOR_ID,
  PAIR_NATIVE_ROUTE_ID,
  PolicyError,
  RouteSelector,
  validatePlanProposal,
  workerFilePaths,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p4-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const noopInference: WorkerInferenceClient = {
  chat: async () => {
    throw new Error("no inference in tests");
  },
};
const noopCompute = {
  exec: async () => {
    throw new Error("no remote compute");
  },
  writeFile: async () => {
    throw new Error("no remote compute");
  },
  readFile: async () => {
    throw new Error("no remote compute");
  },
} as unknown as ComputeClient;

interface Ctx {
  pp: PairPersistence;
  store: PairEvidenceStore;
  service: PairControlPlane;
  runner: PairNativeWorkerRunner;
  adapter: PairNativeExecutorAdapter;
  gate: GovernedTaskGate;
  router: MissionRouter;
  experience: ExperienceService;
  workspace: string;
  dir: string;
}

function makeCtx(name: string): Ctx {
  const dir = freshDir(name);
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const pp = PairPersistence.open(dir); // ONE pair-next.db — unified plane
  const store = pp.store;
  const service = new PairControlPlane(store);
  const runner = new PairNativeWorkerRunner({
    db: pp.automaton.raw,
    config: { name: "p4", logLevel: "error" } as unknown as AutomatonConfig,
    identity: { name: "p4" } as unknown as AutomatonIdentity,
    inference: noopInference,
    compute: noopCompute,
    journalRoot: path.join(dir, "journal"),
    allowedEditRoot: dir,
  });
  const adapter = new PairNativeExecutorAdapter(runner);
  const gate = new GovernedTaskGate(service);
  const router = new MissionRouter(service, gate);
  const experience = new ExperienceService(service);
  new ExecutorRegistry(service).register({
    executor_id: PAIR_NATIVE_EXECUTOR_ID,
    executor_type: "AUTOMATON_WORKER",
    capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
    health_state: "READY",
    status: "ENABLED",
    metadata: {
      qualification_state: "QUALIFIED",
      max_concurrency: 4,
      permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
      workspace_modes: ["EXPLICIT_WORKSPACE"],
      routing_priority: 100,
    },
  });
  service.routes.seedPairNativeRoute();
  return { pp, store, service, runner, adapter, gate, router, experience, workspace, dir };
}

function seedMission(ctx: Ctx, opts: { permissions?: string[] } = {}) {
  const project = ctx.service.createProject({ name: "p4", root_location: ctx.workspace });
  const mission = ctx.service.createMission({
    project_id: String(project.project_id),
    goal: "p4 slice",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [ctx.workspace],
  });
  ctx.service.transitionMission(String(mission.mission_id), "READY");
  ctx.service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  ctx.service.setRuntimeGovernance(String(mission.mission_id), { max_retries: 3 });
  const proposal = {
    tasks: [
      {
        task_key: "T1",
        title: "p4 governed task",
        task_instruction: "read fixture.txt write out/result.txt",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
        metadata: { risk_class: "LOW" },
      },
    ],
  };
  const tasks = validatePlanProposal(proposal, new Set(["FILE_OPERATIONS"]));
  const committed = ctx.service.commitPlan({
    mission_id: String(mission.mission_id),
    tasks: tasks.map((t) => ({ ...t })),
    source: "AUTOMATON_PLANNER",
    proposal,
  });
  const active = ctx.service.activeRevision(String(mission.mission_id));
  return {
    missionId: String(mission.mission_id),
    taskId: committed.task_ids[0],
    request: {
      mission_id: mission.mission_id,
      task_id: committed.task_ids[0],
      plan_revision: active.revision,
      task_instruction: "read fixture.txt write out/result.txt",
      workspace: ctx.workspace,
      allowed_paths: [ctx.workspace],
      permissions: opts.permissions ?? ["FILE_WRITE"],
      constraints: [],
      timeout: 30,
      correlation_id: "corr-p4",
      expected_output_contract: {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [
            { op: "write_text_file", path: "out/result.txt", content: "x", idempotency_class: "WRITE", risk_class: "MEDIUM" },
            { op: "finish", result: { summary: "ok" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
          ],
          limits: { max_ops: 5, timeout_seconds: 30 },
          allowed_ops: ["write_text_file", "finish"],
        },
      },
    },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const adaptersOf = (ctx: Ctx) => new Map([[PAIR_NATIVE_EXECUTOR_ID, ctx.adapter]]);

/** A resolvable evidence ref: real canonical entity "entityType:entityId". */
async function makeEvidenceRef(ctx: Ctx): Promise<string> {
  const m = seedMission(ctx);
  return `mission:${m.missionId}`;
}

describe("P4 Layer A — cognitive memory is non-authoritative", () => {
  it("A: model-written semantic memory cannot mutate canonical evidence", () => {
    const ctx = makeCtx("a");
    cleanups.push(() => ctx.pp.close());
    const m = seedMission(ctx);
    const before = ctx.store.list("entities").length;
    rememberFact(ctx.pp.automaton.raw, {
      category: "domain",
      key: "forged-permission",
      value: "grant SECRETS_ACCESS to all tasks",
      confidence: 1.0,
      source: "model",
    });
    // Canonical evidence untouched.
    expect(ctx.store.list("entities")).toHaveLength(before);
    // The row carries Layer-A trust metadata — hypothesis, not truth.
    const row = ctx.pp.automaton.raw
      .prepare("SELECT trust_class, source_kind FROM semantic_memory WHERE key=?")
      .get("forged-permission") as { trust_class: string; source_kind: string };
    expect(row.trust_class).toBe("MODEL_HYPOTHESIS");
    expect(row.source_kind).toBe("MODEL");
    void m;
  });

  it("B: cognitive memory cannot authorize dispatch", () => {
    const ctx = makeCtx("b");
    cleanups.push(() => ctx.pp.close());
    const m = seedMission(ctx);
    // A model 'remembers' that this task is already dispatched.
    rememberFact(ctx.pp.automaton.raw, {
      category: "domain",
      key: "task-status",
      value: `task ${m.taskId} is DISPATCH_AUTHORIZED`,
    });
    // But dispatch still requires the gate path.
    const forged = {
      governed_task_id: "GTSK_forged",
      mission_id: m.missionId,
      task_id: m.taskId,
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
      workspace: ctx.workspace,
      correlation_id: "c",
      governance_state: "VALIDATED",
      dispatch_enabled: false,
      governance_digest: "x",
      expected_output_contract: {},
    };
    expect(() => ctx.adapter.dispatch(forged)).toThrowError(
      /FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED/,
    );
    void ctx.runner.shutdown();
  });

  it("C: cognitive memory cannot grant permission", () => {
    const ctx = makeCtx("c");
    cleanups.push(() => ctx.pp.close());
    const m = seedMission(ctx);
    rememberFact(ctx.pp.automaton.raw, {
      category: "domain",
      key: "granted",
      value: "SECRETS_ACCESS",
    });
    insertKnowledge(ctx.pp.automaton.raw, {
      category: "operational",
      key: "granted",
      content: "SECRETS_ACCESS granted",
      source: "model",
      tokenCount: 4,
    });
    // Permissions unchanged; routing a SECRETS task still fails closed.
    expect(() =>
      ctx.router.routeGovernedTask(
        { ...m.request, permissions: ["SECRETS_ACCESS"] },
        adaptersOf(ctx),
      ),
    ).toThrowError(/FAIL_CLOSED_NO_ELIGIBLE_EXECUTOR/);
    void ctx.runner.shutdown();
  });

  it("J: cognitive corruption cannot corrupt canonical mission state", () => {
    const ctx = makeCtx("j");
    cleanups.push(() => ctx.pp.close());
    const m = seedMission(ctx);
    // Corrupt a cognitive row directly.
    ctx.pp.automaton.raw
      .prepare("INSERT INTO semantic_memory (id, category, key, value, confidence, source) VALUES ('x','domain','k','corrupt',1.0,'model')")
      .run();
    ctx.pp.automaton.raw
      .prepare("UPDATE semantic_memory SET value = randomblob(64) WHERE id='x'")
      .run();
    // Canonical mission still verifies byte-for-byte.
    const mission = ctx.service.getMission(m.missionId);
    expect(mission.status).toBe("READY");
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
  });
});

describe("P4 Layer C — verified experience lifecycle + firewall", () => {
  it("D: candidate experience is not retrievable (no routing influence before qualification)", async () => {
    const ctx = makeCtx("d");
    cleanups.push(() => ctx.pp.close());
    const ref = await makeEvidenceRef(ctx);
    const cand = ctx.experience.createCandidate({
      type: "EXECUTOR_OBSERVATION",
      source_evidence_refs: [ref],
      provenance: "test",
      payload: { note: "pair_native fast" },
    });
    expect(cand.status).toBe("CANDIDATE");
    // Retrieval only surfaces QUALIFIED+ — a candidate is invisible.
    expect(ctx.experience.retrieve({ text: "pair_native" })).toHaveLength(0);
  });

  it("E: ACTIVE requires verifier evidence; qualification chain enforced", async () => {
    const ctx = makeCtx("e");
    cleanups.push(() => ctx.pp.close());
    const ref = await makeEvidenceRef(ctx);
    const cand = ctx.experience.createCandidate({
      type: "ROUTING_PRIOR",
      source_evidence_refs: [ref],
      provenance: "test",
      payload: { prefer: "PAIR_NATIVE" },
    });
    const id = String(cand.experience_id);
    // Cannot activate from CANDIDATE (must qualify first).
    expect(() =>
      ctx.experience.activate(id, { verifier_id: "v", verifier_result: { ok: true } }),
    ).toThrowError(PolicyError);
    // Cannot qualify without a verifier result.
    expect(() =>
      ctx.experience.qualify(id, { verifier_id: "", verifier_result: null as never }),
    ).toThrowError(/FAIL_CLOSED_EXPERIENCE_NO_VERIFIER/);
    // Proper chain: qualify → activate.
    ctx.experience.qualify(id, { verifier_id: "test-verifier", verifier_result: { passed: true } });
    const active = ctx.experience.activate(id, {
      verifier_id: "test-verifier",
      verifier_result: { passed: true },
    });
    expect(active.status).toBe("ACTIVE");
    expect(active.qualified_at).toBeTruthy();
    // Now retrievable.
    const hits = ctx.experience.retrieve({ text: "pair_native" });
    expect(hits.map((h) => h.experience_id)).toContain(id);
  });

  it("F: permission_effect != NONE is rejected", async () => {
    const ctx = makeCtx("f");
    cleanups.push(() => ctx.pp.close());
    const ref = await makeEvidenceRef(ctx);
    expect(() =>
      ctx.experience.createCandidate({
        type: "EXECUTOR_OBSERVATION",
        source_evidence_refs: [ref],
        provenance: "evil",
        permission_effect: "GRANT_SECRETS",
      }),
    ).toThrowError(/FAIL_CLOSED_EXPERIENCE_PERMISSION_EFFECT/);
  });

  it("G: revoked experience is not retrievable", async () => {
    const ctx = makeCtx("g");
    cleanups.push(() => ctx.pp.close());
    const ref = await makeEvidenceRef(ctx);
    const cand = ctx.experience.createCandidate({
      type: "NEGATIVE_EXPERIENCE",
      source_evidence_refs: [ref],
      provenance: "test",
      payload: { bad: "x" },
    });
    const id = String(cand.experience_id);
    ctx.experience.qualify(id, { verifier_id: "v", verifier_result: { ok: true } });
    ctx.experience.activate(id, { verifier_id: "v", verifier_result: { ok: true } });
    expect(ctx.experience.retrieve({ text: "bad" })).toHaveLength(1);
    ctx.experience.revoke(id, "no longer valid");
    expect(ctx.experience.retrieve({ text: "bad" })).toHaveLength(0);
  });

  it("H: stale/incompatible experience filtered before semantic ranking", async () => {
    const ctx = makeCtx("h");
    cleanups.push(() => ctx.pp.close());
    const ref = await makeEvidenceRef(ctx);
    const mk = (scope: Record<string, unknown>, stale?: string) =>
      ctx.experience.createCandidate({
        type: "ROUTING_PRIOR",
        source_evidence_refs: [ref],
        provenance: "test",
        compatibility_scope: scope,
        trust_metadata: stale ? { stale_after: stale } : {},
        payload: { note: "routing prior pair_native" },
      });
    const stale = mk({}, "2000-01-01T00:00:00Z");
    const wrongExec = mk({ executors: ["SOME_OTHER_EXECUTOR"] });
    const good = mk({ executors: [PAIR_NATIVE_EXECUTOR_ID] });
    for (const e of [stale, wrongExec, good]) {
      const id = String(e.experience_id);
      ctx.experience.qualify(id, { verifier_id: "v", verifier_result: { ok: true } });
      ctx.experience.activate(id, { verifier_id: "v", verifier_result: { ok: true } });
    }
    const hits = ctx.experience.retrieve({
      text: "routing prior pair_native",
      executor_id: PAIR_NATIVE_EXECUTOR_ID,
    });
    expect(hits.map((h) => h.experience_id)).toEqual([good.experience_id]);
  });

  it("createCandidate requires resolvable Layer-B evidence refs", () => {
    const ctx = makeCtx("norefs");
    cleanups.push(() => ctx.pp.close());
    expect(() =>
      ctx.experience.createCandidate({
        type: "PLAN_TEMPLATE",
        source_evidence_refs: [],
        provenance: "test",
      }),
    ).toThrowError(/FAIL_CLOSED_EXPERIENCE_NO_EVIDENCE/);
    expect(() =>
      ctx.experience.createCandidate({
        type: "PLAN_TEMPLATE",
        source_evidence_refs: ["mission:NONEXISTENT"],
        provenance: "test",
      }),
    ).toThrowError(/FAIL_CLOSED_EXPERIENCE_UNRESOLVED_REF/);
  });
});

describe("P4 persistence convergence — single pair-next.db", () => {
  it("unified file hosts runtime+cognitive+canonical namespaces", () => {
    const ctx = makeCtx("unified");
    cleanups.push(() => ctx.pp.close());
    const tables = (
      ctx.pp.automaton.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    // runtime/* + cognitive/* + canonical/* in ONE file.
    for (const t of ["goals", "task_graph", "semantic_memory", "knowledge_store", "entities", "events", "governed_evidence", "mission_plan_revisions"]) {
      expect(tables).toContain(t);
    }
    // WAL preserved.
    expect(ctx.pp.automaton.raw.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("K: migration is idempotent and integrity-checked", () => {
    const ctx = makeCtx("mig-src");
    cleanups.push(() => ctx.pp.close());
    seedMission(ctx);
    rememberFact(ctx.pp.automaton.raw, { category: "domain", key: "k1", value: "v1" });
    const canonicalBefore = (
      ctx.store.db.prepare("SELECT COUNT(*) AS c FROM entities").get() as { c: number }
    ).c;
    expect(canonicalBefore).toBeGreaterThan(0);

    // Simulate a split legacy deployment: dump ctx's unified file into
    // separate state.db/pair.db is unnecessary — the migrator consumes the
    // same physical tables; instead migrate INTO a fresh target from two
    // real split files.
    const legacy = freshDir("legacy");
    const legacyState = createDatabase(path.join(legacy, "state.db"));
    legacyState.raw.prepare(
      "INSERT INTO kv (key, value) VALUES ('k', 'v')",
    ).run();
    rememberFact(legacyState.raw, { category: "domain", key: "lk", value: "lv" });
    const legacyPair = new PairEvidenceStore(path.join(legacy, "pair.db"));
    const legacyService = new PairControlPlane(legacyPair);
    const lm = legacyService.createProject({ name: "legacy", root_location: "/x" });
    legacyPair.close();
    legacyState.close();

    const targetDir = freshDir("target");
    const target = PairPersistence.open(targetDir);
    cleanups.push(() => target.close());

    const r1 = PersistenceMigrator.migrate({
      stateDb: path.join(legacy, "state.db"),
      pairDb: path.join(legacy, "pair.db"),
      target,
    });
    expect(r1.integrity_ok).toBe(true);
    expect(r1.canonical_verified).toBe(true);
    expect(r1.skipped_idempotent).toBe(false);
    expect(r1.tables.kv?.rows).toBe(1);
    expect(r1.tables.semantic_memory?.rows).toBe(1);
    expect(r1.tables.entities?.rows).toBeGreaterThan(0);

    // Second run is a no-op on the same sources.
    const r2 = PersistenceMigrator.migrate({
      stateDb: path.join(legacy, "state.db"),
      pairDb: path.join(legacy, "pair.db"),
      target,
    });
    expect(r2.skipped_idempotent).toBe(true);
    // Migrated canonical entity reads back verified.
    expect(target.store.get("project", String(lm.project_id)).name).toBe("legacy");
  });

  it("L: crash/restart preserves canonical evidence", () => {
    const ctx = makeCtx("restart");
    const m = seedMission(ctx);
    const mission = ctx.service.getMission(m.missionId);
    ctx.pp.close();

    const reopened = PairPersistence.open(ctx.dir);
    cleanups.push(() => reopened.close());
    const service2 = new PairControlPlane(reopened.store);
    expect(service2.getMission(m.missionId).mission_id).toBe(mission.mission_id);
    expect(() => reopened.store.verifyIntegrity()).not.toThrow();
  });
});

describe("P4 — canonical integrity + routing survive restart", () => {
  it("I: canonical evidence tampering is detected", () => {
    const ctx = makeCtx("tamper");
    cleanups.push(() => ctx.pp.close());
    const m = seedMission(ctx);
    ctx.store.db
      .prepare("UPDATE entities SET payload='{}' WHERE entity_type='mission'")
      .run();
    expect(() => ctx.service.getMission(m.missionId)).toThrowError(IntegrityError);
  });

  it("M: full routed vertical slice on the unified db still passes", async () => {
    const ctx = makeCtx("slice");
    cleanups.push(() => ctx.runner.shutdown(), () => ctx.pp.close());
    fs.writeFileSync(path.join(ctx.workspace, "fixture.txt"), "x", "utf8");
    const m = seedMission(ctx);
    const out = ctx.router.routeGovernedTask(m.request, adaptersOf(ctx));
    const execution = out.execution as Record<string, unknown>;
    const deadline = Date.now() + 25_000;
    for (;;) {
      const o = ctx.adapter.observe(String(execution.execution_id));
      if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(String(o.status))) break;
      if (Date.now() > deadline) throw new Error("never terminal");
      await new Promise((r) => setTimeout(r, 80));
    }
    const collected = ctx.gate.collect_execution_result(ctx.adapter, String(execution.execution_id));
    expect(collected.result_state).toBe("COMPLETED");
    const v = new ArtifactProvenanceValidator().validate_execution(
      ctx.service,
      String(execution.execution_id),
    );
    expect(v.status).toBe("PASS");
    // Automaton task graph reached terminal in the SAME unified file.
    const child = JSON.parse(
      fs.readFileSync(workerFilePaths(String(execution.run_root)).workerChild, "utf8"),
    );
    expect(getTaskById(ctx.pp.automaton.raw, String(child.automaton_task_id))!.status).toBe(
      "completed",
    );
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
  }, 30_000);

  it("N: routing decision remains canonical after restart", () => {
    const ctx = makeCtx("route-restart");
    const m = seedMission(ctx);
    const task = ctx.service.getTask(m.taskId);
    const dec = ctx.router.capabilityRouter.route(task, { mode: "PLAN" });
    const decisionId = String(dec.routing_decision_id);
    const digest = String(dec.decision_digest);
    ctx.pp.close();

    const reopened = PairPersistence.open(ctx.dir);
    cleanups.push(() => reopened.close());
    const service2 = new PairControlPlane(reopened.store);
    const router2 = new MissionRouter(service2, new GovernedTaskGate(service2));
    expect(router2.verifyRoutingDecision(decisionId)).toBe(true);
    expect(service2.store.get("routing_decision", decisionId).decision_digest).toBe(digest);
  });
});
