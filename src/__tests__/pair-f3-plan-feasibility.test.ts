/**
 * F3 — canonical plan feasibility + plan semantic digest (permanent suite).
 *
 *   A1–A10  canonicalPlanSemanticDigest (pair-plan-semantic.v1)
 *   B1–B9   analyzePlanFeasibility — structural-only artifact/dataflow proof
 *   C       commit boundary re-proof + persisted revision semantic digest
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzePlanFeasibility,
  canonicalPlanSemanticDigest,
  PairControlPlane,
  PairEvidenceStore,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-f3-feas-"));
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const REMOTE = "REMOTE_CLOUD_TASK_EXECUTION";

function task(
  key: string,
  caps: string[],
  deps: string[],
  instruction: string,
  metadata: Record<string, unknown> = {},
  selected_executor?: string,
): Record<string, unknown> {
  const t: Record<string, unknown> = {
    task_key: key,
    title: key,
    task_instruction: instruction,
    required_capabilities: caps,
    depends_on: deps,
    metadata,
  };
  if (selected_executor) t.selected_executor = selected_executor;
  return t;
}

const df = (produces: string[] = [], consumes: string[] = []) => ({
  pair_dataflow: { produces, consumes },
});

const feasibilityError = (tasks: Array<Record<string, unknown>>) => {
  try {
    analyzePlanFeasibility(tasks);
    return null;
  } catch (err) {
    return err as Error & {
      code?: string;
      dependency_reason?: string;
      source_code?: string;
    };
  }
};

/* ============================== B — feasibility ======================= */

describe("F3 B — analyzePlanFeasibility structural proof", () => {
  it("B1. unbound consume → FAIL_CLOSED_PLAN_FEASIBILITY / PLAN_DATAFLOW_UNBOUND", () => {
    const err = feasibilityError([
      task("T1", ["FILE_OPERATIONS"], [], "write a.txt", df(["a.txt"])),
      task("T2", ["FILE_OPERATIONS"], ["T1"], "read x.txt", df([], ["x.txt"])),
    ]);
    expect(err?.code).toBe("FAIL_CLOSED_PLAN_FEASIBILITY");
    expect(err?.dependency_reason).toBe("PLAN_DATAFLOW_UNBOUND");
  });

  it("B2. two producers for one consume → PLAN_DATAFLOW_AMBIGUOUS", () => {
    const err = feasibilityError([
      task("T1", ["FILE_OPERATIONS"], [], "write a.txt", df(["a.txt"])),
      task("T2", ["FILE_OPERATIONS"], ["T1"], "write a.txt", df(["a.txt"])),
      task("T3", ["FILE_OPERATIONS"], ["T1", "T2"], "read a.txt", df([], ["a.txt"])),
    ]);
    expect(err?.dependency_reason).toBe("PLAN_DATAFLOW_AMBIGUOUS");
  });

  it("B3. consume bound to a LATER producer → PLAN_DATAFLOW_ORDER_INVALID", () => {
    const err = feasibilityError([
      task("T1", ["FILE_OPERATIONS"], [], "read a.txt", df([], ["a.txt"])),
      task("T2", ["FILE_OPERATIONS"], [], "write a.txt", df(["a.txt"])),
    ]);
    expect(err?.dependency_reason).toBe("PLAN_DATAFLOW_ORDER_INVALID");
  });

  it("B4. remote task in depends_on without a consume edge → REMOTE_EDGE_UNGOVERNED", () => {
    const err = feasibilityError([
      task("T1", [REMOTE], [], "gather data"),
      task("T2", ["FILE_OPERATIONS"], ["T1"], "local followup", df()),
    ]);
    expect(err?.dependency_reason).toBe("REMOTE_EDGE_UNGOVERNED");
  });

  it("B5. declared governed consume edge to remote producer → feasible", () => {
    expect(
      feasibilityError([
        task("T1", [REMOTE], [], "gather into r.txt", df(["r.txt"])),
        task("T2", ["FILE_OPERATIONS"], ["T1"], "read r.txt", df([], ["r.txt"])),
      ]),
    ).toBeNull();
  });

  it("B6. artifact names normalize (strip ./ and collapse) — declared-vs-written forms bind", () => {
    expect(
      feasibilityError([
        task("T1", ["FILE_OPERATIONS"], [], "write ./a.txt", df(["a.txt"])),
        task("T2", ["FILE_OPERATIONS"], ["T1"], "read a.txt", df([], ["a.txt"])),
      ]),
    ).toBeNull();
  });

  it("B7. cyclic depends_on → PLAN_DATAFLOW_ORDER_INVALID", () => {
    const err = feasibilityError([
      task("T1", ["FILE_OPERATIONS"], ["T2"], "a", df()),
      task("T2", ["FILE_OPERATIONS"], ["T1"], "b", df()),
    ]);
    expect(err?.dependency_reason).toBe("PLAN_DATAFLOW_ORDER_INVALID");
  });

  it("B8. TELEGRAM_DELIVERY must stay a DAG leaf — dependent → infeasible", () => {
    const err = feasibilityError([
      task("T1", ["FILE_OPERATIONS"], [], "write a.txt", df(["a.txt"])),
      task("T2", ["TELEGRAM_DELIVERY"], ["T1"], "deliver", {
        pair_telegram_delivery: { mode: "FILES", artifacts: ["a.txt"] },
      }),
      task("T3", ["FILE_OPERATIONS"], ["T2"], "later", df()),
    ]);
    expect(err?.code).toBe("FAIL_CLOSED_PLAN_FEASIBILITY");
    expect(err?.dependency_reason).toBe("PLAN_DATAFLOW_ORDER_INVALID");
  });

  it("B9. feasibility is STRUCTURAL only — a missing future artifact is NOT a violation", () => {
    // The consume binds exactly one earlier declared producer; whether the
    // producer will actually emit canonical bytes is a runtime concern,
    // never a plan reject.
    expect(
      feasibilityError([
        task("T1", ["FILE_OPERATIONS"], [], "write maybe.txt", df(["maybe.txt"])),
        task("T2", ["FILE_OPERATIONS"], ["T1"], "read maybe.txt", df([], ["maybe.txt"])),
      ]),
    ).toBeNull();
  });

  it("B10. committed plan boundary re-proves — commitPlan rejects an infeasible list", () => {
    const d = dir("b10");
    const store = new PairEvidenceStore(path.join(d, "pair.db"));
    const service = new PairControlPlane(store);
    const project = service.createProject({ name: "p", root_location: d });
    const mission = service.createMission({
      project_id: String(project.project_id),
      goal: "x",
      granted_permissions: [],
      authorized_workspaces: [d],
    });
    expect(() =>
      service.commitPlan({
        mission_id: String(mission.mission_id),
        tasks: [
          task("T1", ["FILE_OPERATIONS"], [], "a", df(["a.txt"])),
          task("T2", ["FILE_OPERATIONS"], ["T1"], "b", df([], ["x.txt"])),
        ],
        source: "TEST",
        proposal: null,
      }),
    ).toThrowError(/FAIL_CLOSED_PLAN_FEASIBILITY/);
    // Zero partial commit — no task rows, no plan, no revision.
    expect(service.listTasks(String(mission.mission_id))).toHaveLength(0);
    expect(store.planRevisions(String(mission.mission_id))).toHaveLength(0);
  });
});

/* ============================== A — semantic digest =================== */

describe("F3 A — canonicalPlanSemanticDigest pair-plan-semantic.v1", () => {
  const base = () => [
    task("T1", ["FILE_OPERATIONS"], [], "write a.txt", df(["a.txt"])),
    task("T2", ["FILE_OPERATIONS"], ["T1"], "read a.txt then reply DONE", df([], ["a.txt"])),
  ];

  it("A1. identical tasks → identical digest", () => {
    expect(canonicalPlanSemanticDigest(base())).toBe(
      canonicalPlanSemanticDigest(base()),
    );
  });

  it("A2. instruction change → different digest", () => {
    const b = base();
    b[1].task_instruction = "read a.txt carefully then reply DONE";
    expect(canonicalPlanSemanticDigest(b)).not.toBe(canonicalPlanSemanticDigest(base()));
  });

  it("A3. capability change → different digest", () => {
    const b = base();
    b[1].required_capabilities = ["REASONING"];
    expect(canonicalPlanSemanticDigest(b)).not.toBe(canonicalPlanSemanticDigest(base()));
  });

  it("A4. depends_on change → different digest", () => {
    const b = base();
    b[1].depends_on = [];
    expect(canonicalPlanSemanticDigest(b)).not.toBe(canonicalPlanSemanticDigest(base()));
  });

  it("A5. dataflow change → different digest", () => {
    const b = base();
    b[0].metadata = df(["other.txt"]);
    b[1].metadata = df([], ["other.txt"]);
    expect(canonicalPlanSemanticDigest(b)).not.toBe(canonicalPlanSemanticDigest(base()));
  });

  it("A6. expected_output_contract / worker_spec change → different digest", () => {
    const b = base();
    b[0].metadata = {
      ...df(["a.txt"]),
      expected_output_contract: { type: "TASK_RESULT", worker_spec: { ops: [{ op: "finish" }] } },
    };
    expect(canonicalPlanSemanticDigest(b)).not.toBe(canonicalPlanSemanticDigest(base()));
  });

  it("A7. selected_executor change → different digest", () => {
    const b = base();
    b[0].selected_executor = "EX_ALPHA";
    expect(canonicalPlanSemanticDigest(b)).not.toBe(canonicalPlanSemanticDigest(base()));
  });

  it("A8. raw key-order / shape noise does NOT change the digest", () => {
    const messy = base().map((t) => ({
      // rebuilt object — different key insertion order
      depends_on: t.depends_on,
      metadata: t.metadata,
      required_capabilities: t.required_capabilities,
      task_instruction: t.task_instruction,
      title: t.title,
      task_key: t.task_key,
      // fields carrying no execution semantics are ignored
      created_at: "2020-01-01T00:00:00Z",
      version: 9,
    }));
    expect(canonicalPlanSemanticDigest(messy)).toBe(canonicalPlanSemanticDigest(base()));
  });

  it("A9. different task ids / plan ids / timestamps → SAME digest", () => {
    const committedLike = base().map((t, i) => ({
      ...t,
      task_id: `TSK_OTHER_${i}`,
      plan_id: "PLN_OTHER",
      mission_id: "MSN_OTHER",
      created_at: "2030-01-01T00:00:00Z",
      provenance: { planner: "other-model" },
    }));
    expect(canonicalPlanSemanticDigest(committedLike)).toBe(
      canonicalPlanSemanticDigest(base()),
    );
  });

  it("A10. pre-commit proposal digest == committed rows digest == persisted revision digest", () => {
    const d = dir("a10");
    const store = new PairEvidenceStore(path.join(d, "pair.db"));
    const service = new PairControlPlane(store);
    const project = service.createProject({ name: "p", root_location: d });
    const mission = service.createMission({
      project_id: String(project.project_id),
      goal: "x",
      granted_permissions: [],
      authorized_workspaces: [d],
    });
    const proposal = { tasks: base() };
    const expected = canonicalPlanSemanticDigest(proposal.tasks);
    const { plan_id } = service.commitPlan({
      mission_id: String(mission.mission_id),
      tasks: proposal.tasks,
      source: "TEST",
      proposal,
    });
    const rows = service
      .listTasks(String(mission.mission_id))
      .filter((t) => t.plan_id === plan_id)
      .sort((a, b) => Number(a.order) - Number(b.order));
    expect(canonicalPlanSemanticDigest(rows)).toBe(expected);
    const [rev] = store.planRevisions(String(mission.mission_id));
    expect(rev.plan_semantic_digest).toBe(expected);
    // Provenance digest stays separate — raw proposal vs semantic.
    expect(rev.proposal_digest).not.toBe(expected);
  });
});
