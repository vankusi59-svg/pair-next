/**
 * P15.2 Objective → Workstream decomposition — adversarial test matrix.
 *
 * Mandate §16 groups:
 *   A happy path (canonical ACTIVE objective, chain A→B→C, deterministic
 *     root, WDEC/WGM/WDS/WGE, binding, unassigned BACKLOG, zero missions)
 *   B objective authority gate (fake/tampered/stale/terminal/paused)
 *   C proposal validation (empty/dup key/unknown dep/self/cycle/cap/
 *     empty fields/dup dep)
 *   D P14 integration (objective_id inheritance, canonical validators)
 *   E idempotency (exact replay converges, different → CONFLICT,
 *     amend-then-replay historical adoption)
 *   F crash safety (fault injection at every write point → zero residue)
 *   G concurrency (same-proposal race converges; different → one winner)
 *   H tamper (binding digest/foreign root/wrong WDEC/child drift/
 *     fabricated binding)
 *
 * Non-vacuous discipline: every rejection asserts the canonical error
 * code AND that no canonical graph/bridge rows were minted.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  BusinessLayer,
  IntegrityError,
  ObjectiveAuthorityService,
  ObjectiveWorkstreamService,
  PairEvidenceStore,
  WorkforceService,
  assertCanonicalDecomposition,
  assertCanonicalDependencySet,
  assertCanonicalMembership,
  assertCanonicalObjectiveWorkstreamBinding,
  decompositionRowId,
  dependencySetRowId,
  digest,
  membershipRowId,
  objectiveRootWorkItemId,
  objectiveWorkstreamBindingDigest,
  objectiveWorkstreamBindingId,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p152-"));
let counter = 0;

type Stack = {
  dbPath: string;
  store: PairEvidenceStore;
  biz: BusinessLayer;
  wf: WorkforceService;
  objectives: ObjectiveAuthorityService;
  svc: ObjectiveWorkstreamService;
};

function freshStack(name: string): Stack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  // Minimal BusinessLayer deps — P15.2 seams never touch control/
  // schedules: only store + org_agent/agent-contract/objective reads.
  const biz = new BusinessLayer({
    store,
    control: { projects: () => [{ project_id: "PRJ_TEST" }] } as never,
    schedules: {} as never,
  });
  const wf = new WorkforceService({ store, business: biz });
  const objectives = biz.objectives;
  const svc = new ObjectiveWorkstreamService({ store, business: biz, workforce: wf, objectives });
  return { dbPath, store, biz, wf, objectives, svc };
}

const OP = "1882810918";

function mkBusiness(store: PairEvidenceStore, id = `BIZ_${digest(String(counter)).slice(0, 8)}_${counter}`) {
  store.put("business", id, {
    business_id: id, name: "b", status: "ACTIVE", currency: "USD",
    project_id: "PRJ_TEST", created_at: "x", version: 0,
  }, 0);
  return id;
}

function mkObjective(svc: ObjectiveAuthorityService, businessId: string, extra: Record<string, unknown> = {}) {
  return svc.create({
    business_id: businessId,
    title: "Sell 10 units",
    statement: "Grow sales",
    kpis: [{ name: "sales", unit: "units", baseline: 0, target: 10 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500_000_000,
    hard_constraints: ["no discounts below cost"],
    success_conditions: ["10 units sold"],
    operator_id: OP,
    ...extra,
  });
}

function pins(o: Record<string, unknown>) {
  return {
    expected_objective_version: Number(o.version),
    expected_terms_version: Number(o.terms_version),
    expected_objective_digest: String(o.objective_digest),
  };
}

function proposal(workstreams: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { workstreams, actor: OP, ...extra };
}

function expectFail(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} — call succeeded`);
}

function rowCount(store: PairEvidenceStore, entity: string): number {
  return store.list(entity).length;
}

/* ============================ A — happy path ============================ */

describe("P15.2 A — happy path", () => {
  it("canonical ACTIVE objective decomposes into a P14 work graph", () => {
    const { store, biz, objectives, svc } = freshStack("a-happy");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const res = svc.decomposeObjective({
      objective_id: oid,
      ...pins(o),
      ...proposal([
        { workstream_key: "research", title: "Research", goal: "gather" },
        { workstream_key: "spec", title: "Spec", goal: "write", depends_on_keys: ["research"] },
        { workstream_key: "build", title: "Build", goal: "ship", depends_on_keys: ["spec"] },
      ]),
    });
    // deterministic root
    expect(res.root.work_item_id).toBe(objectiveRootWorkItemId(oid));
    expect(res.root.objective_id).toBe(oid);
    expect(res.root.business_id).toBe(bid);
    expect(res.root.source).toBe("objective");
    expect(res.root.assignee_agent_id).toBeNull();
    expect(res.root.status).toBe("BACKLOG");
    // children — deterministic DC_* ids, topo order, unassigned BACKLOG
    expect(res.children).toHaveLength(3);
    for (const c of res.children) {
      expect(String(c.work_item_id)).toMatch(/^DC_/);
      expect(c.objective_id).toBe(oid);
      expect(c.business_id).toBe(bid);
      expect(c.assignee_agent_id).toBeNull();
      expect(c.status).toBe("BACKLOG");
      expect((c.mission_ids as string[]).length).toBe(0);
      expect(c.source).toBe("decomposition");
    }
    // canonical P14 rows — proven by the existing validators
    const graphDeps = {
      store, getBusiness: (id: string) => biz.getBusiness(id),
      agentContracts: biz.agentContracts,
    };
    const wdec = store.get("work_decomposition", decompositionRowId(String(res.root.work_item_id)));
    assertCanonicalDecomposition(graphDeps, wdec);
    expect(String(wdec.decomposition_id)).toMatch(/^OWD_/);
    for (const c of res.children) {
      const id = String(c.work_item_id);
      assertCanonicalMembership(graphDeps, store.get("work_graph_membership", membershipRowId(id)) as never);
      assertCanonicalDependencySet(graphDeps, store.get("work_dependency_set", dependencySetRowId(id)) as never);
    }
    // dependency edges B→research, C→spec (dependent → dependency)
    const edges = store.list("work_graph_edge");
    expect(edges).toHaveLength(2);
    const [a, b, c] = res.children.map((x) => String(x.work_item_id));
    const edgePairs = edges.map((e) => `${String(e.dependent_work_item_id)}→${String(e.dependency_work_item_id)}`);
    expect(edgePairs).toContain(`${b}→${a}`);
    expect(edgePairs).toContain(`${c}→${b}`);
    // binding — canonical, self-verifying
    const binding = svc.getBinding(oid)!;
    expect(binding.binding_id).toBe(objectiveWorkstreamBindingId(oid));
    expect(binding.objective_id).toBe(oid);
    expect(binding.objective_version_at_commit).toBe(Number(o.version));
    expect(binding.objective_terms_version).toBe(Number(o.terms_version));
    expect(binding.objective_digest).toBe(String(o.objective_digest));
    expect((binding.workstreams as Array<Record<string, unknown>>).map((w) => w.workstream_key))
      .toEqual(["research", "spec", "build"]);
    assertCanonicalObjectiveWorkstreamBinding(
      { store, business: biz, workforce: undefined as never, objectives }, binding as never);
    // §13 — zero execution side effects
    expect(rowCount(store, "mission")).toBe(0);
    expect(rowCount(store, "work_open_binding")).toBe(0);
    expect(rowCount(store, "executor_execution")).toBe(0);
    store.close();
  });

  it("equivalent proposal in different input order normalizes identically", () => {
    const { store, objectives, svc } = freshStack("a-norm");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const res1 = svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([
        { workstream_key: "c", title: "C", goal: "g", depends_on_keys: ["b"] },
        { workstream_key: "a", title: "A", goal: "g" },
        { workstream_key: "b", title: "B", goal: "g", depends_on_keys: ["a"] },
      ]),
    });
    expect((res1.binding.workstreams as Array<Record<string, unknown>>).map((w) => w.workstream_key))
      .toEqual(["a", "b", "c"]);
    store.close();
  });
});

/* ============================ B — objective gate ============================ */

describe("P15.2 B — objective authority gate", () => {
  it("unknown / legacy-shape objective rejected", () => {
    const { store, svc } = freshStack("b-fake");
    mkBusiness(store);
    expectFail(
      () => svc.decomposeObjective({
        objective_id: "OBJ_FAKE",
        ...proposal([{ workstream_key: "w", title: "t", goal: "g" }]),
        expected_objective_version: 0, expected_terms_version: 1, expected_objective_digest: "x",
      }),
      "NOT_FOUND",
    );
    // legacy goal-tree row (no schema_version/digest) is not authority
    store.put("objective", "OBJ_LEGACY", { objective_id: "OBJ_LEGACY", title: "t", version: 0 }, 0);
    expectFail(
      () => svc.decomposeObjective({
        objective_id: "OBJ_LEGACY",
        ...proposal([{ workstream_key: "w", title: "t", goal: "g" }]),
        expected_objective_version: 0, expected_terms_version: 1, expected_objective_digest: "x",
      }),
      "FAIL_CLOSED_OBJECTIVE_SCHEMA",
    );
    expect(rowCount(store, "work_item")).toBe(0);
    store.close();
  });

  it("tampered objective_digest → strict read fails before any mint", () => {
    const { store, biz, objectives, svc } = freshStack("b-tamper");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const r = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    r.objective_digest = digest("forged");
    store.put("objective", oid, r, Number(o.version));
    expectFail(
      () => svc.decomposeObjective({
        objective_id: oid, ...pins(o),
        ...proposal([{ workstream_key: "w", title: "t", goal: "g" }]),
      }),
      "FAIL_CLOSED_OBJECTIVE_DIGEST",
    );
    expect(rowCount(store, "work_item")).toBe(0);
    void biz;
    store.close();
  });

  it("stale expected version/terms/digest → SNAPSHOT, zero mint", () => {
    const { store, objectives, svc } = freshStack("b-stale");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const ws = () => proposal([{ workstream_key: "w", title: "t", goal: "g" }]);
    expectFail(() => svc.decomposeObjective({
      objective_id: oid, ...pins(o), ...ws(), expected_objective_version: Number(o.version) + 1,
    }), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_SNAPSHOT");
    expectFail(() => svc.decomposeObjective({
      objective_id: oid, ...pins(o), ...ws(), expected_terms_version: Number(o.terms_version) + 1,
    }), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_SNAPSHOT");
    expectFail(() => svc.decomposeObjective({
      objective_id: oid, ...pins(o), ...ws(), expected_objective_digest: "deadbeef",
    }), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_SNAPSHOT");
    // legitimate amend then stale ORIGINAL pins still reject on admission
    const o2 = objectives.amend(oid, { business_id: bid, patch: { target: "12" }, reason: "r", actor: `operator:${OP}` });
    expectFail(() => svc.decomposeObjective({ objective_id: oid, ...pins(o), ...ws() }),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_SNAPSHOT");
    // fresh pins admit
    const res = svc.decomposeObjective({ objective_id: oid, ...pins(o2), ...ws() });
    expect(res.children).toHaveLength(1);
    expect(rowCount(store, "work_item")).toBe(2); // root + 1 child
    store.close();
  });

  it("non-ACTIVE objective rejected — terminal, PAUSED, EXPIRED", () => {
    const { store, objectives, svc } = freshStack("b-state");
    const bid = mkBusiness(store);
    const ws = () => proposal([{ workstream_key: "w", title: "t", goal: "g" }]);
    // CANCELLED (terminal)
    const oc = mkObjective(objectives, bid, { dedup_key: "b-cancel" });
    objectives.transitionStatus(String(oc.objective_id), { business_id: bid, to: "CANCELLED", actor: `operator:${OP}` });
    expectFail(() => svc.decomposeObjective({
      objective_id: String(oc.objective_id), ...pins(oc), ...ws(),
    }), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_STATE");
    // PAUSED
    const op = mkObjective(objectives, bid, { dedup_key: "b-paused" });
    objectives.transitionStatus(String(op.objective_id), { business_id: bid, to: "PAUSED", actor: `operator:${OP}` });
    expectFail(() => svc.decomposeObjective({
      objective_id: String(op.objective_id), ...pins(op), ...ws(),
    }), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_STATE");
    // EXPIRED via existing deadline semantics — past deadline commits
    // EXPIRED on admission, then the status gate rejects.
    const ox = mkObjective(objectives, bid, { dedup_key: "b-expired", deadline: "2000-01-01T00:00:00.000Z" });
    expectFail(() => svc.decomposeObjective({
      objective_id: String(ox.objective_id), ...pins(ox), ...ws(),
    }), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_STATE");
    expect(String(objectives.get(String(ox.objective_id)).status)).toBe("EXPIRED");
    expect(rowCount(store, "work_item")).toBe(0);
    store.close();
  });
});

/* ============================ C — proposal validation ============================ */

describe("P15.2 C — proposal validation", () => {
  it("malformed proposals reject deterministically, zero mint", () => {
    const { store, objectives, svc } = freshStack("c-proposal");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const call = (workstreams: unknown[], extra: Record<string, unknown> = {}) =>
      () => svc.decomposeObjective({
        objective_id: oid, ...pins(o), workstreams: workstreams as never, actor: OP, ...extra,
      });
    expectFail(call([]), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    expectFail(call("x"), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    expectFail(call([{ workstream_key: "w", title: "t", goal: "g" }], { actor: "" }),
      "FAIL_CLOSED_OPERATOR_ID_REQUIRED");
    // duplicate key
    expectFail(call([
      { workstream_key: "w", title: "t", goal: "g" },
      { workstream_key: "w", title: "t2", goal: "g" },
    ]), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    // unknown dependency
    expectFail(call([
      { workstream_key: "w", title: "t", goal: "g", depends_on_keys: ["nope"] },
    ]), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    // self dependency
    expectFail(call([
      { workstream_key: "w", title: "t", goal: "g", depends_on_keys: ["w"] },
    ]), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    // cycle a→b→a
    expectFail(call([
      { workstream_key: "a", title: "t", goal: "g", depends_on_keys: ["b"] },
      { workstream_key: "b", title: "t", goal: "g", depends_on_keys: ["a"] },
    ]), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    // over child cap
    expectFail(call(
      Array.from({ length: 17 }, (_, i) => ({ workstream_key: `w${i}`, title: "t", goal: "g" })),
    ), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    // empty title / goal / key
    expectFail(call([{ workstream_key: "w", title: "", goal: "g" }]),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    expectFail(call([{ workstream_key: "w", title: "t", goal: "  " }]),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    expectFail(call([{ workstream_key: "", title: "t", goal: "g" }]),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    // duplicate dependency entry
    expectFail(call([
      { workstream_key: "a", title: "t", goal: "g" },
      { workstream_key: "b", title: "t", goal: "g", depends_on_keys: ["a", "a"] },
    ]), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_PROPOSAL");
    expect(rowCount(store, "work_item")).toBe(0);
    store.close();
  });

  it("caller metadata can never override derived business/objective identity", () => {
    const { store, objectives, svc } = freshStack("c-override");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const res = svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([
        { workstream_key: "w", title: "t", goal: "g", business_id: "EVIL", objective_id: "OBJ_EVIL" },
      ]),
    });
    // foreign fields are dropped by the bounded input contract — the
    // child's identity derives from the parent only.
    expect(res.children[0]!.business_id).toBe(bid);
    expect(res.children[0]!.objective_id).toBe(oid);
    store.close();
  });
});

/* ============================ E — idempotency ============================ */

describe("P15.2 E — idempotency / conflict", () => {
  it("exact replay returns same root/children/binding — zero duplicates", () => {
    const { store, objectives, svc } = freshStack("e-replay");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const input = {
      objective_id: oid, ...pins(o),
      ...proposal([
        { workstream_key: "a", title: "A", goal: "g" },
        { workstream_key: "b", title: "B", goal: "g", depends_on_keys: ["a"] },
      ]),
    };
    const r1 = svc.decomposeObjective(input);
    const counts = () => [
      rowCount(store, "work_item"), rowCount(store, "work_decomposition"),
      rowCount(store, "objective_workstream_binding"), rowCount(store, "work_graph_edge"),
      rowCount(store, "work_graph_membership"), rowCount(store, "work_dependency_set"),
    ];
    const before = counts();
    const r2 = svc.decomposeObjective(input);
    expect(String(r2.binding.binding_id)).toBe(String(r1.binding.binding_id));
    expect(String(r2.root.work_item_id)).toBe(String(r1.root.work_item_id));
    expect(r2.children.map((c) => c.work_item_id))
      .toEqual(r1.children.map((c) => c.work_item_id));
    expect(counts()).toEqual(before);
    store.close();
  });

  it("same objective + different proposal → OBJECTIVE_WORKSTREAM_CONFLICT", () => {
    const { store, objectives, svc } = freshStack("e-conflict");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([{ workstream_key: "a", title: "A", goal: "g" }]),
    });
    expectFail(
      () => svc.decomposeObjective({
        objective_id: oid, ...pins(o),
        ...proposal([
          { workstream_key: "a", title: "A", goal: "g" },
          { workstream_key: "b", title: "B", goal: "g" },
        ]),
      }),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_CONFLICT",
    );
    // no second root/wdec/binding
    expect(rowCount(store, "work_decomposition")).toBe(1);
    expect(rowCount(store, "objective_workstream_binding")).toBe(1);
    expect(rowCount(store, "work_item")).toBe(2);
    store.close();
  });

  it("replay of the ORIGINAL committed decomposition stays adoptable after amend", () => {
    const { store, objectives, svc } = freshStack("e-amend");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid, { target: "10" });
    const oid = String(o.objective_id);
    const input = {
      objective_id: oid, ...pins(o),
      ...proposal([{ workstream_key: "a", title: "A", goal: "g" }]),
    };
    svc.decomposeObjective(input);
    // Amend protected terms AFTER commit — the original replay must
    // still converge on the committed snapshot (the binding preserves
    // it); a different proposal still conflicts.
    objectives.amend(oid, { business_id: bid, patch: { target: "12" }, reason: "r", actor: `operator:${OP}` });
    const r = svc.decomposeObjective(input);
    expect(String(r.binding.objective_digest)).toBe(String(o.objective_digest));
    expect(String(r.binding.normalized_proposal_digest)).toBeDefined();
    expectFail(() => svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([{ workstream_key: "z", title: "Z", goal: "g" }]),
    }), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_CONFLICT");
    store.close();
  });
});

/* ============================ F — crash safety ============================ */

describe("P15.2 F — crash safety", () => {
  it("a fault at ANY write point rolls back the whole bridge — zero residue", () => {
    for (let faultAt = 0; faultAt < 14; faultAt++) {
      const fresh = freshStack(`f-crash-${faultAt}`);
      const origPut = fresh.store.put.bind(fresh.store);
      const origEvent = fresh.store.event.bind(fresh.store);
      const fbid = mkBusiness(fresh.store);
      const fo = mkObjective(fresh.objectives, fbid);
      const foid = String(fo.objective_id);
      const finput = {
        objective_id: foid, ...pins(fo),
        ...proposal([
          { workstream_key: "a", title: "A", goal: "g" },
          { workstream_key: "b", title: "B", goal: "g", depends_on_keys: ["a"] },
        ]),
      };
      let calls = 0;
      fresh.store.put = ((...args: Parameters<typeof origPut>) => {
        calls += 1;
        if (calls > faultAt) throw new IntegrityError("TEST_FAULT", `injected at write ${faultAt}`);
        return origPut(...args);
      }) as typeof fresh.store.put;
      fresh.store.event = ((...args: Parameters<typeof origEvent>) => {
        calls += 1;
        if (calls > faultAt) throw new IntegrityError("TEST_FAULT", `injected at event ${faultAt}`);
        return origEvent(...args);
      }) as typeof fresh.store.event;
      try {
        fresh.svc.decomposeObjective(finput);
      } catch {
        // expected — injected fault
      }
      // Either the fault was never reached (writes < faultAt → success)…
      const minted =
        rowCount(fresh.store, "work_item") +
        rowCount(fresh.store, "work_decomposition") +
        rowCount(fresh.store, "objective_workstream_binding") +
        rowCount(fresh.store, "work_graph_edge") +
        rowCount(fresh.store, "work_dependency_set");
      if (calls > faultAt) {
        // …or the whole transaction rolled back — never partial.
        expect(minted).toBe(0);
        // and a retry commits cleanly
        fresh.store.put = origPut;
        fresh.store.event = origEvent;
        const r = fresh.svc.decomposeObjective(finput);
        expect(r.children).toHaveLength(2);
      }
      fresh.store.close();
    }
  });
});

/* ============================ G — concurrency ============================ */

const G_CACHE = path.join(process.cwd(), "node_modules", ".cache", "pair-p152-g");
const G_BUNDLE = path.join(G_CACHE, "pair-bundle.mjs");
const G_WORKER = path.join(G_CACHE, "g-worker.mjs");

const G_WORKER_SOURCE = `
import { workerData, parentPort } from "node:worker_threads";
import * as PAIR from "./pair-bundle.mjs";

const { dbPath, barrier, args } = workerData;
const store = new PAIR.PairEvidenceStore(dbPath);
const biz = new PAIR.BusinessLayer({
  store,
  control: { projects: () => [{ project_id: "PRJ_TEST" }] },
  schedules: {},
});
const wf = new PAIR.WorkforceService({ store, business: biz });
const svc = new PAIR.ObjectiveWorkstreamService({
  store, business: biz, workforce: wf, objectives: biz.objectives,
});
parentPort.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0);
try {
  const out = svc.decomposeObjective(args);
  parentPort.postMessage({ ok: true, binding: String(out.binding.binding_id) });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e && e.code ? e.code : String(e) });
}
`;

function ensureGWorkerBundle() {
  fs.mkdirSync(G_CACHE, { recursive: true });
  const esbuild = fs
    .readdirSync("node_modules/.pnpm")
    .filter((d) => d.startsWith("esbuild@"))
    .map((d) => path.join("node_modules/.pnpm", d, "node_modules/esbuild/bin/esbuild"))
    .filter((p) => fs.existsSync(p))
    .sort()
    .at(-1);
  if (!esbuild) throw new Error("esbuild binary not found under node_modules/.pnpm");
  execFileSync(esbuild, [
    "src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
    "--external:better-sqlite3", "--external:ulid", "--external:yaml",
    `--outfile=${G_BUNDLE}`,
  ], { cwd: process.cwd(), stdio: "pipe" });
  fs.writeFileSync(G_WORKER, G_WORKER_SOURCE);
}

type GOutcome = { ok: true; binding: string } | { ok: false; code: string };

async function runGRace(args: Array<Record<string, unknown>>, dbPath: string): Promise<GOutcome[]> {
  ensureGWorkerBundle();
  const sab = new SharedArrayBuffer(4);
  const gate = new Int32Array(sab);
  let readyCount = 0;
  return Promise.all(
    args.map(
      (a) =>
        new Promise<GOutcome>((resolve, reject) => {
          const w = new Worker(G_WORKER, {
            workerData: { dbPath, barrier: gate, args: a },
          });
          w.on("message", (msg: Record<string, unknown>) => {
            if (msg.ready === true) {
              readyCount += 1;
              if (readyCount === args.length) {
                Atomics.store(gate, 0, 1);
                Atomics.notify(gate, 0);
              }
              return;
            }
            resolve(msg as unknown as GOutcome);
          });
          w.on("error", reject);
        }),
    ),
  );
}

describe("P15.2 G — real worker-thread contention", () => {
  it("same objective + same proposal racing → one canonical result, both converge", async () => {
    const { dbPath, store, objectives } = freshStack("g-same");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const input = {
      objective_id: String(o.objective_id), ...pins(o),
      ...proposal([
        { workstream_key: "a", title: "A", goal: "g" },
        { workstream_key: "b", title: "B", goal: "g", depends_on_keys: ["a"] },
      ]),
    };
    const results = await runGRace([input, input], dbPath);
    expect(results.every((r) => r.ok)).toBe(true);
    // exactly one root, one WDEC, one binding, 3 work_items
    expect(rowCount(store, "work_item")).toBe(3);
    expect(rowCount(store, "work_decomposition")).toBe(1);
    expect(rowCount(store, "objective_workstream_binding")).toBe(1);
    expect(rowCount(store, "work_graph_edge")).toBe(1);
    store.close();
  });

  it("same objective + DIFFERENT proposals racing → one winner, loser conflicts, no mixed graph", async () => {
    const { dbPath, store, objectives } = freshStack("g-diff");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const mk = (key: string) => ({
      objective_id: String(o.objective_id), ...pins(o),
      ...proposal([{ workstream_key: key, title: "T", goal: "g" }]),
    });
    const results = await runGRace([mk("alpha"), mk("beta")], dbPath);
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as { code: string }).code).toBe("FAIL_CLOSED_OBJECTIVE_WORKSTREAM_CONFLICT");
    // winner's graph is coherent — one root + its ONE child, no mixing
    expect(rowCount(store, "work_item")).toBe(2);
    expect(rowCount(store, "work_decomposition")).toBe(1);
    expect(rowCount(store, "objective_workstream_binding")).toBe(1);
    store.close();
  });
});

/* ============================ H — binding tamper ============================ */

describe("P15.2 H — binding tamper", () => {
  function committed(name: string) {
    const s = freshStack(name);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    s.svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([
        { workstream_key: "a", title: "A", goal: "g" },
        { workstream_key: "b", title: "B", goal: "g", depends_on_keys: ["a"] },
      ]),
    });
    return { ...s, bid, oid };
  }

  it("tampered binding_digest → strict binding read fails", () => {
    const { store, oid, svc } = committed("h-digest");
    const row = JSON.parse(JSON.stringify(
      store.get("objective_workstream_binding", objectiveWorkstreamBindingId(oid))));
    row.binding_digest = digest("forged");
    store.put("objective_workstream_binding", objectiveWorkstreamBindingId(oid), row, Number(row.version));
    expectFail(() => svc.getBinding(oid), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
    store.close();
  });

  it("forged binding fields with a VALID digest still fail the canonical chain", () => {
    const cases: Array<(r: Record<string, unknown>) => void> = [
      (r) => { r.root_work_item_id = "WI_FOREIGN"; },
      (r) => { r.decomposition_id = "OWD_wrong"; },
      (r) => { r.decomposition_row_id = "WDEC_WRONG"; },
      (r) => { (r.workstreams as Array<Record<string, unknown>>)[0].work_item_id = "WI_FAKE"; },
      (r) => { r.normalized_proposal_digest = digest("different"); },
    ];
    for (const [i, mutate] of cases.entries()) {
      const { store, oid, svc } = committed(`h-field-${i}`);
      const row = JSON.parse(JSON.stringify(
        store.get("objective_workstream_binding", objectiveWorkstreamBindingId(oid))));
      mutate(row);
      // valid-looking digest — the validator must still fail deeper
      row.binding_digest = objectiveWorkstreamBindingDigest(row);
      store.put("objective_workstream_binding", objectiveWorkstreamBindingId(oid), row, Number(row.version));
      expectFail(() => svc.getBinding(oid), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
      // replay through decompose also fails closed (validator runs first)
      expectFail(
        () => svc.decomposeObjective({
          objective_id: oid,
          expected_objective_version: 0, expected_terms_version: 0, expected_objective_digest: "x",
          workstreams: [{ workstream_key: "a", title: "A", goal: "g" }], actor: OP,
        }),
        "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING",
      );
      store.close();
    }
  });

  it("child objective_id drift (canonical work_item, wrong lineage) fails", () => {
    const { store, oid, svc } = committed("h-childdrift");
    const binding = svc.getBinding(oid)!;
    const childId = String((binding.workstreams as Array<Record<string, unknown>>)[0].work_item_id);
    const child = JSON.parse(JSON.stringify(store.get("work_item", childId)));
    child.objective_id = "OBJ_OTHER";
    store.put("work_item", childId, child, Number(child.version));
    expectFail(() => svc.getBinding(oid), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
    store.close();
  });

  it("fabricated binding with no WDEC fails closed", () => {
    const { store, oid, objectives, svc } = committed("h-fabricate");
    const o2 = mkObjective(objectives, mkBusiness(store, "BIZ_SECOND"));
    const oid2 = String(o2.objective_id);
    void oid;
    // craft a fully-shaped binding for oid2 that references nothing real
    const fake: Record<string, unknown> = {
      schema_version: "pair.os.vnext.objective-workstream-binding.v1",
      binding_id: objectiveWorkstreamBindingId(oid2),
      objective_id: oid2,
      business_id: String(o2.business_id),
      objective_version_at_commit: Number(o2.version),
      objective_terms_version: Number(o2.terms_version),
      objective_digest: String(o2.objective_digest),
      root_work_item_id: objectiveRootWorkItemId(oid2),
      decomposition_row_id: decompositionRowId(objectiveRootWorkItemId(oid2)),
      decomposition_id: digest("x"),
      workstreams: [],
      normalized_proposal_digest: digest("p"),
      state: "COMMITTED",
      created_by: "attacker",
      created_at: new Date().toISOString(),
      version: 0,
    };
    fake.binding_digest = objectiveWorkstreamBindingDigest(fake);
    store.put("objective_workstream_binding", String(fake.binding_id), fake, 0);
    expectFail(() => svc.getBinding(oid2), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
    store.close();
  });
});

/* ============================ R2 — remediation ============================ */

/** Compute the store-level event hash for an event body — mirrors
 *  PairEvidenceStore.event()'s integrity domain so tests can produce
 *  a COHERENT forged anchor (metadata + matching hash). */
function eventHash(body: Record<string, unknown>): string {
  return digest({
    event_id: body.event_id,
    entity_type: body.entity_type,
    entity_id: body.entity_id,
    event_type: body.event_type,
    old_state: body.old_state ?? null,
    new_state: body.new_state ?? null,
    actor: body.actor,
    correlation_id: body.correlation_id ?? null,
    metadata: body.metadata ?? null,
    created_at: body.created_at,
  });
}

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } }).db;
}

describe("P15.2 R2.A — immutable anchor authority", () => {
  function committed(name: string) {
    const s = freshStack(name);
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    s.svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([
        { workstream_key: "a", title: "A", goal: "g" },
        { workstream_key: "b", title: "B", goal: "g", depends_on_keys: ["a"] },
      ]),
    });
    return { ...s, bid, oid, o };
  }

  it("tampered row fields + recomputed binding_digest still fail — anchor pins the original", () => {
    const cases: Array<(r: Record<string, unknown>) => void> = [
      (r) => { r.objective_version_at_commit = Number(r.objective_version_at_commit) + 1; },
      (r) => { r.objective_terms_version = Number(r.objective_terms_version) + 1; },
      (r) => { r.objective_digest = digest("forged-objective"); },
      (r) => { r.created_by = "attacker"; },
      (r) => { r.created_at = "2020-01-01T00:00:00.000Z"; },
      (r) => {
        const ws = r.workstreams as Array<Record<string, unknown>>;
        const t = ws[0].workstream_key;
        ws[0].workstream_key = ws[1].workstream_key;
        ws[1].workstream_key = t;
      },
    ];
    for (const [i, mutate] of cases.entries()) {
      const { store, oid, svc } = committed(`r2a-field-${i}`);
      const row = JSON.parse(JSON.stringify(
        store.get("objective_workstream_binding", objectiveWorkstreamBindingId(oid))));
      mutate(row);
      row.binding_digest = objectiveWorkstreamBindingDigest(row); // valid-looking
      store.put("objective_workstream_binding", objectiveWorkstreamBindingId(oid), row, Number(row.version));
      expectFail(() => svc.getBinding(oid), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
      store.close();
    }
  });

  it("deleted anchor → fail; duplicated anchor → fail; altered anchor field → fail", () => {
    // DELETE the anchor
    {
      const { store, oid, svc } = committed("r2a-del");
      const bid = objectiveWorkstreamBindingId(oid);
      dbOf(store).prepare(
        "DELETE FROM events WHERE entity_type=? AND entity_id=? AND event_type=?")
        .run("objective_workstream_binding", bid, "OBJECTIVE_WORKSTREAM_COMMITTED");
      expectFail(() => svc.getBinding(oid), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
      store.close();
    }
    // DUPLICATE the anchor
    {
      const { store, oid, svc } = committed("r2a-dup");
      const bid = objectiveWorkstreamBindingId(oid);
      const anchor = store.listEvents("objective_workstream_binding", bid)[0]!;
      store.event({
        entity_type: "objective_workstream_binding", entity_id: bid,
        event_type: "OBJECTIVE_WORKSTREAM_COMMITTED", new_state: "COMMITTED",
        actor: "operator:x", metadata: anchor.metadata as Record<string, unknown>,
      });
      expectFail(() => svc.getBinding(oid), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
      store.close();
    }
    // ALTER one anchored field coherently (metadata + event hash)
    {
      const { store, oid, svc } = committed("r2a-alter");
      const bid = objectiveWorkstreamBindingId(oid);
      const anchor = store.listEvents("objective_workstream_binding", bid)[0]!;
      const md = { ...(anchor.metadata as Record<string, unknown>), workstream_count: 99 };
      const body = {
        event_id: anchor.event_id, entity_type: anchor.entity_type, entity_id: anchor.entity_id,
        event_type: anchor.event_type, old_state: anchor.old_state ?? null,
        new_state: anchor.new_state, actor: anchor.actor,
        correlation_id: anchor.correlation_id ?? null, metadata: md, created_at: anchor.created_at,
      };
      dbOf(store).prepare("UPDATE events SET metadata_json=?, event_hash=? WHERE event_id=?")
        .run(JSON.stringify(md), eventHash(body), String(anchor.event_id));
      expectFail(() => svc.getBinding(oid), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
      store.close();
    }
  });

  it("binding stays canonical after legitimate Objective amendment + replay converges", () => {
    const { store, objectives, oid, bid, svc, o } = committed("r2a-amend");
    objectives.amend(oid, { business_id: bid, patch: { target: "12" }, reason: "r", actor: `operator:${OP}` });
    // binding remains canonical — the anchor pins the COMMIT snapshot,
    // the current objective_digest legitimately differs.
    const b = svc.getBinding(oid)!;
    expect(String(b.objective_digest)).toBe(String(o.objective_digest));
    expect(String(b.objective_digest)).not.toBe(String(objectives.get(oid).objective_digest));
    const r = svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([
        { workstream_key: "a", title: "A", goal: "g" },
        { workstream_key: "b", title: "B", goal: "g", depends_on_keys: ["a"] },
      ]),
    });
    expect(String(r.binding.binding_id)).toBe(String(b.binding_id));
    store.close();
  });
});

describe("P15.2 R2.B — objective root is non-executable", () => {
  it("openWorkItem(objective root) fails closed BEFORE any authority-bearing write", () => {
    const { store, biz, objectives, svc } = freshStack("r2b-root");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const res = svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([{ workstream_key: "a", title: "A", goal: "g" }]),
    });
    const rootId = String(res.root.work_item_id);
    expect(rootId.startsWith("OWI_")).toBe(true);
    expectFail(() => biz.openWorkItem(rootId, OP), "FAIL_CLOSED_OBJECTIVE_ROOT_NON_EXECUTABLE");
    expect(rowCount(store, "work_open_binding")).toBe(0);
    expect(rowCount(store, "mission")).toBe(0);
    expect(rowCount(store, "executor_execution")).toBe(0);
    const root = store.get("work_item", rootId);
    expect(root.status).toBe("BACKLOG");
    expect(root.pending_open_id ?? null).toBeNull();
    store.close();
  });

  it("guard is OWI_-namespaced — normal work items and P14 parents unaffected", () => {
    const { store, biz, wf } = freshStack("r2b-normal");
    const bid = mkBusiness(store);
    // unknown non-OWI id fails differently (not the namespace guard)
    try {
      biz.openWorkItem("WI_NOPE", OP);
      throw new Error("expected failure");
    } catch (e) {
      expect(String((e as { code?: string }).code))
        .not.toBe("FAIL_CLOSED_OBJECTIVE_ROOT_NON_EXECUTABLE");
    }
    // a manual P14 decomposed parent reaches the SAME normal open path —
    // the OWI_ guard never fires for it
    const parent = biz.createWorkItem({
      business_id: bid, title: "manual parent", goal: "g", source: "manual", operator_id: OP,
    });
    wf.decomposeWorkItem(String(parent.work_item_id), {
      decomposition_id: `D_${digest("m").slice(0, 8)}`,
      children: [{ title: "c", goal: "g" }],
    }, OP);
    try {
      biz.openWorkItem(String(parent.work_item_id), OP);
    } catch (e) {
      expect(String((e as { code?: string }).code))
        .not.toBe("FAIL_CLOSED_OBJECTIVE_ROOT_NON_EXECUTABLE");
    }
    store.close();
  });
});

describe("P15.2 R2.C — dependency-order canonicalization", () => {
  it('["A","B"] ≡ ["B","A"] — identical digest, replay not conflict', () => {
    const { store, objectives, svc } = freshStack("r2c-deps");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const mk = (deps: string[], order: string[]) => ({
      objective_id: oid, ...pins(o),
      workstreams: order.map((k) => ({
        workstream_key: k, title: `T_${k}`, goal: "g",
        depends_on_keys: k === "c" ? deps : k === "a" || k === "b" ? [] : undefined,
      })),
      actor: OP,
    });
    const r1 = svc.decomposeObjective(mk(["a", "b"], ["a", "b", "c"]));
    const r2 = svc.decomposeObjective(mk(["b", "a"], ["b", "c", "a"]));
    expect(String(r2.binding.binding_id)).toBe(String(r1.binding.binding_id));
    expect(String(r2.binding.normalized_proposal_digest))
      .toBe(String(r1.binding.normalized_proposal_digest));
    expect(rowCount(store, "work_item")).toBe(4);
    expect(rowCount(store, "objective_workstream_binding")).toBe(1);
    store.close();
  });
});

describe("P15.2 R2.D — orphan root fail-closed", () => {
  it("pre-created OWI-compatible root → admission fails closed", () => {
    const { store, biz, objectives, svc } = freshStack("r2d-orphan");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const rootId = objectiveRootWorkItemId(oid);
    // an OWI_-shaped residue that LOOKS fresh — still unprovable.
    biz.createWorkItem({
      business_id: bid, title: "[objective] forged", goal: "g",
      objective_id: oid, source: "objective", work_item_id: rootId, operator_id: OP,
    });
    expectFail(
      () => svc.decomposeObjective({
        objective_id: oid, ...pins(o),
        ...proposal([{ workstream_key: "a", title: "A", goal: "g" }]),
      }),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_ROOT_CONFLICT",
    );
    expect(rowCount(store, "objective_workstream_binding")).toBe(0);
    store.close();
  });

  it("orphan root with cleared mutable mission_ids still fails — no freshness inference", () => {
    const { store, biz, objectives, svc } = freshStack("r2d-hist");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    const rootId = objectiveRootWorkItemId(oid);
    const row = biz.createWorkItem({
      business_id: bid, title: "x", goal: "g",
      objective_id: oid, source: "objective", work_item_id: rootId, operator_id: OP,
    });
    // simulate "historical" residue: mutable projection cleared
    const r = JSON.parse(JSON.stringify(row));
    r.mission_ids = [];
    store.put("work_item", rootId, r, Number(row.version));
    expectFail(
      () => svc.decomposeObjective({
        objective_id: oid, ...pins(o),
        ...proposal([{ workstream_key: "a", title: "A", goal: "g" }]),
      }),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_ROOT_CONFLICT",
    );
    store.close();
  });
});

describe("P15.2 R2.E — strict integer shape", () => {
  it("numeric-string expected pins reject before mint", () => {
    const { store, objectives, svc } = freshStack("r2e-ints");
    const bid = mkBusiness(store);
    const o = mkObjective(objectives, bid);
    const oid = String(o.objective_id);
    expectFail(
      () => svc.decomposeObjective({
        objective_id: oid,
        expected_objective_version: String(o.version) as unknown as number,
        expected_terms_version: String(o.terms_version) as unknown as number,
        expected_objective_digest: String(o.objective_digest),
        workstreams: [{ workstream_key: "a", title: "t", goal: "g" }], actor: OP,
      }),
      "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_SNAPSHOT",
    );
    expect(rowCount(store, "work_item")).toBe(0);
    store.close();
  });

  it("numeric-string binding fields fail strict validation", () => {
    const s = freshStack("r2e-row");
    const bid = mkBusiness(s.store);
    const o = mkObjective(s.objectives, bid);
    const oid = String(o.objective_id);
    s.svc.decomposeObjective({
      objective_id: oid, ...pins(o),
      ...proposal([{ workstream_key: "a", title: "A", goal: "g" }]),
    });
    const row = JSON.parse(JSON.stringify(
      s.store.get("objective_workstream_binding", objectiveWorkstreamBindingId(oid))));
    row.objective_version_at_commit = String(row.objective_version_at_commit);
    row.binding_digest = objectiveWorkstreamBindingDigest(row);
    s.store.put("objective_workstream_binding", objectiveWorkstreamBindingId(oid), row, Number(row.version));
    expectFail(() => s.svc.getBinding(oid), "FAIL_CLOSED_OBJECTIVE_WORKSTREAM_BINDING");
    s.store.close();
  });
});
