/**
 * Autonomous Loop observability — pure derivation tests.
 *
 * The derive layer lives in apps/mission-control-ui (UI scope); the
 * test file lives here because the verification harness executes
 * `npx vitest run <selector>` under the ROOT vitest config, whose
 * include pattern covers only src/__tests__/. The tested module has
 * zero runtime imports (type-only) so it is exercised directly.
 *
 * Scenarios (task §7 phase-3 list):
 *   1  no configured policy                  11 missing reads
 *   2  effective policy + waiting scheduler   12 cockpit observation_error
 *   3  lease without admission (rule B)       13 401/403/404/transport
 *   4  admission fence/generation match       14 cross-objective identity
 *   5  RUNNING mission                        15 out-of-order responses
 *   6  historical artifacts + current fault   16 multi-workstream
 *   7  INTEGRITY_FAULT + older success (E)    17 timestamp edge cases
 *   8  blocked + retry exhaustion             18 no false settlement (D)
 *   9  waiting + due checkpoint               19 inspector view-model
 *   10 driver denial                          20 snapshot→snapshot updates
 */

import { describe, expect, it } from "vitest";
import {
  deriveLoopSnapshot,
  epError,
  epMissing,
  epReady,
  fmtDue,
  fmtTs,
  matchingAdmission,
  nodeInspector,
  shouldApplyResponse,
} from "../../apps/mission-control-ui/src/app/lib/objectiveLoop";
import type {
  LoopInputs,
  LoopNodeId,
} from "../../apps/mission-control-ui/src/app/lib/objectiveLoop";
import type {
  AutoDriverStatus,
  AutoPolicyStatus,
  AutoSchedulerStatus,
} from "../../apps/mission-control-ui/src/types";
import type { CockpitPayload } from "../../apps/mission-control-ui/src/app/types";

const OID = "OBJ_TEST_LOOP";
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const AT = NOW - 2000;

/* ---------------- fixtures ---------------- */

function cockpit(over: Partial<CockpitPayload> = {}): CockpitPayload {
  return {
    objective: {
      objective_id: OID,
      business_id: "BIZ_T",
      status: "ACTIVE",
      title: "t",
      statement: "s",
      description: null,
      owner_authority_id: "operator:op:e2e",
      deadline: null,
      currency: "USD",
      terms_version: 1,
      version: 1,
      created_at: "2026-01-01T00:00:00Z",
      budget: { ceiling_microusd: 0, consumed_microusd: 0, canonically_proven: false },
      hard_constraints: [],
      success_conditions: [],
      kpis: [],
    },
    lifecycle: {
      objective_status: "ACTIVE",
      all_targets_met: false,
      latest_review_outcome: null,
      owner_action_required: false,
      recommended_status: null,
    },
    binding: null,
    observation_error: null,
    kpi_summary: { all_targets_met: false, verified_kpi_count: 0, unverified_kpi_count: 0, gap_kpi_count: 0 },
    workstreams: [],
    observer: { active: 0, intervention: 0, exhausted: 0 },
    missions: [],
    artifacts: [],
    artifacts_truncated: false,
    artifacts_dropped_unverified: 0,
    latest_review: null,
    review_count: 0,
    auto_policy: null,
    auto_driver: null,
    ...over,
  } as CockpitPayload;
}

function policy(over: Partial<AutoPolicyStatus> = {}): AutoPolicyStatus {
  return {
    objective_id: OID,
    configured: true,
    state: "ENABLED",
    effective: true,
    reasons: [],
    policy_version: 3,
    expires_at: null,
    limits: null,
    halt: null,
    owner_authority_id: "operator:op:e2e",
    business_id: "BIZ_T",
    driver_ready: true,
    driver_missing: [],
    terms_digest_binding: null,
    terms_current: true,
    ...over,
  };
}

function scheduler(over: Partial<AutoSchedulerStatus> = {}): AutoSchedulerStatus {
  return {
    objective_id: OID,
    scheduler_mode: "AUTO",
    scheduler_ready: true,
    driver_integrated: true,
    consumer_ready: true,
    driver_ready: true,
    objective_runnable: true,
    driver_missing: [],
    policy_effective: true,
    policy_version: 3,
    terms_current: true,
    queue_state: "WAITING_CONSUMER",
    pending_generation: 5,
    claimed_generation: 4,
    checkpoint_digest: "dg",
    pending_reasons: ["MISSION_TERMINAL"],
    coalesced_count: 1,
    source_refs: ["ev:1"],
    next_due: NOW + 60_000,
    wait_kind: "NOT_DUE_YET",
    retry_count: 0,
    blocked_reason: null,
    owner_action_required: false,
    lease: { state: "RELEASED", fence: 4, expires_at: null },
    catchup_state: null,
    ...over,
  };
}

function driver(over: Partial<AutoDriverStatus> = {}): AutoDriverStatus {
  return {
    objective_id: OID,
    enabled: true,
    last_outcome: "CEO_PASS_COMMITTED",
    last_result: { fault: null },
    last_fence: 4,
    admissions: [
      { at: "2026-01-01T11:00:00Z", fence: 4, generation: 4,
        usage: { ceo_calls: 1, microusd: 5000, missions: 1 } },
    ],
    denials: [],
    lease: { state: "RELEASED", fence: 4, expires_at: null },
    ...over,
  };
}

function inputs(over: Partial<LoopInputs> = {}): LoopInputs {
  return {
    objectiveId: OID,
    nowMs: NOW,
    cockpit: epReady(cockpit(), AT),
    policy: epReady(policy(), AT),
    scheduler: epReady(scheduler(), AT),
    driver: epReady(driver(), AT),
    ...over,
  };
}

const node = (i: LoopInputs, id: LoopNodeId) =>
  deriveLoopSnapshot(i).nodes.find((n) => n.id === id)!;

/* ---------------- scenarios ---------------- */

describe("autonomous loop derive — scenarios", () => {
  it("1. no configured policy → policy node inactive, loop dormant", () => {
    const s = deriveLoopSnapshot(inputs({
      policy: epReady(policy({ configured: false, effective: false, state: "DISABLED" }), AT),
      scheduler: epReady(scheduler({ pending_reasons: [], pending_generation: null, claimed_generation: null, next_due: null, queue_state: "IDLE" }), AT),
      driver: epReady(driver({ enabled: false, admissions: [], last_fence: null, last_outcome: null }), AT),
    }));
    const pol = s.nodes.find((n) => n.id === "policy")!;
    expect(pol.visual).toBe("upcoming");
    expect(pol.status).toContain("no auto-policy");
    expect(s.nodes.find((n) => n.id === "mission")!.visual).toBe("upcoming");
    expect(s.headline.visual).not.toBe("active");
  });

  it("2. effective policy + WAITING_CONSUMER → scheduler waiting, wake pending", () => {
    const s = deriveLoopSnapshot(inputs());
    expect(node(inputs(), "policy").visual).toBe("proven");
    expect(s.nodes.find((n) => n.id === "scheduler")!.visual).toBe("waiting");
    expect(s.nodes.find((n) => n.id === "wake")!.visual).toBe("active");
    expect(s.nodes.find((n) => n.id === "br_waiting")!.visual).toBe("waiting");
    expect(s.nodes.find((n) => n.id === "continuation")!.visual).toBe("waiting");
  });

  it("3. active lease WITHOUT correlated admission → claim active, admission NOT active (rule B)", () => {
    const i = inputs({
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED",
        lease: { state: "CLAIMED", fence: 9, expires_at: "2026-01-01T12:05:00Z" },
      }), AT),
      driver: epReady(driver({ admissions: [] }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.nodes.find((n) => n.id === "claim")!.visual).toBe("active");
    const adm = s.nodes.find((n) => n.id === "admission")!;
    expect(adm.visual).not.toBe("active"); // no proof of admission — never inferred
  });

  it("4. admission matched by fence+generation → admission active", () => {
    const i = inputs({
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED",
        claimed_generation: 7,
        lease: { state: "CLAIMED", fence: 9, expires_at: null },
      }), AT),
      driver: epReady(driver({
        admissions: [{ at: "2026-01-01T11:59:00Z", fence: 9, generation: 7,
          usage: { ceo_calls: 0, microusd: 0, missions: 0 } }],
      }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("active");
    expect(s.nodes.find((n) => n.id === "pass")!.visual).toBe("active");
    const m = matchingAdmission(
      driver({ admissions: [{ at: "x", fence: 9, generation: 7, usage: null }] }),
      { fence: 9 }, 7,
    );
    expect(m?.fence).toBe(9);
    /* wrong generation → falls back to same-fence record only */
    const m2 = matchingAdmission(
      driver({ admissions: [{ at: "x", fence: 9, generation: 3, usage: null }] }),
      { fence: 9 }, 7,
    );
    expect(m2?.fence).toBe(9);
    /* wrong fence → no match at all */
    expect(matchingAdmission(
      driver({ admissions: [{ at: "x", fence: 3, generation: 7, usage: null }] }),
      { fence: 9 }, 7,
    )).toBeNull();
  });

  it("5. RUNNING mission → mission + exec active", () => {
    const i = inputs({
      cockpit: epReady(cockpit({
        missions: [{ mission_id: "MSN_1", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: "OPN_1" }],
      }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.nodes.find((n) => n.id === "mission")!.visual).toBe("active");
    expect(s.nodes.find((n) => n.id === "exec")!.visual).toBe("active");
  });

  it("6. historical artifacts + current fault → evidence proven but fault visible, no fake current success", () => {
    const i = inputs({
      cockpit: epReady(cockpit({
        artifacts: [
          { artifact_id: "ART_1", logical_name: "a.html", mission_id: "MSN_1", execution_id: "EX_1",
            state: "VERIFIED", artifact_class: "FILE", sha256: "x".repeat(64), byte_size: 10, created_at: "2025-12-31T00:00:00Z" },
        ],
      }), AT),
      driver: epReady(driver({ last_result: { fault: "PLANNER_EXHAUSTED" } }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.nodes.find((n) => n.id === "evidence")!.visual).toBe("proven");
    expect(s.nodes.find((n) => n.id === "evidence")!.detail).toContain("rule A");
    expect(s.nodes.find((n) => n.id === "br_fault")!.visual).toBe("failed");
    expect(s.headline.visual).not.toBe("active"); // fault dominates headline
  });

  it("7. INTEGRITY_FAULT coexists with older successful last_outcome (rule E)", () => {
    const i = inputs({
      driver: epReady(driver({
        last_outcome: "CEO_PASS_COMMITTED",
        last_result: { fault: "INTEGRITY_FAULT" },
      }), AT),
    });
    const s = deriveLoopSnapshot(i);
    const fault = s.nodes.find((n) => n.id === "br_fault")!;
    expect(fault.visual).toBe("failed");
    expect(fault.status).toBe("INTEGRITY_FAULT");
    /* older success is still shown on the pass node — as history */
    const pass = s.nodes.find((n) => n.id === "pass")!;
    expect(pass.evidence.some((e) => e.value === "CEO_PASS_COMMITTED")).toBe(true);
  });

  it("8. blocked authority + retry count → blocked + retry branches lit", () => {
    const i = inputs({
      scheduler: epReady(scheduler({
        queue_state: "BLOCKED_AUTHORITY",
        blocked_reason: "TERMS_STALE",
        retry_count: 4,
        pending_reasons: [],
      }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.nodes.find((n) => n.id === "scheduler")!.visual).toBe("blocked");
    expect(s.nodes.find((n) => n.id === "br_blocked")!.visual).toBe("blocked");
    expect(s.nodes.find((n) => n.id === "br_retry")!.status).toContain("retry 4");
    expect(s.headline.visual).toBe("blocked");
  });

  it("9. waiting evidence + due checkpoint shown as checkpoint, not ETA (rule G)", () => {
    const i = inputs({ scheduler: epReady(scheduler({ next_due: NOW + 90_000 }), AT) });
    const cont = node(i, "continuation");
    expect(cont.status).toContain("due in 1m 30s");
    const iso = cont.status.match(/\(([^)]+)\)/)![1];
    expect(new Date(iso).getTime()).toBe(NOW + 90_000);
  });

  it("10. driver denials → DENIED/FAULT branch lit with count", () => {
    const i = inputs({
      driver: epReady(driver({ denials: [{ reason: "BUDGET" }, { reason: "X" }] }), AT),
    });
    expect(node(i, "br_fault").visual).toBe("failed");
    expect(node(i, "br_fault").status).toContain("2 denial");
  });

  it("11. all reads missing → spine unknown, honest headline", () => {
    const s = deriveLoopSnapshot(inputs({
      cockpit: epMissing(), policy: epMissing(),
      scheduler: epMissing(), driver: epMissing(),
    }));
    for (const id of ["policy", "scheduler", "mission", "evidence"] as LoopNodeId[])
      expect(s.nodes.find((n) => n.id === id)!.visual).toBe("unknown");
    expect(s.headline.label).toContain("unavailable");
    expect(s.freshness.every((f) => f.state === "missing")).toBe(true);
  });

  it("12. cockpit observation_error → evidence unverified, flag set", () => {
    const i = inputs({
      cockpit: epReady(cockpit({ observation_error: "DIGEST_MISMATCH" }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.observationVerified).toBe(false);
    expect(s.observationError).toBe("DIGEST_MISMATCH");
    const ev = s.nodes.find((n) => n.id === "evidence")!;
    expect(ev.visual).toBe("unknown");
    expect(ev.status).toBe("unverified");
  });

  it("13. endpoint failures — 401/403/404/transport → unknown, never success", () => {
    const i = inputs({
      cockpit: epError(401, "UNAUTHORIZED"),
      policy: epError(403, "FORBIDDEN"),
      scheduler: epError(404, "AUTO_SCHEDULER_DISABLED"),
      driver: epError(null, "ERR_NETWORK"),
    });
    const s = deriveLoopSnapshot(i);
    for (const id of ["policy", "scheduler", "claim", "admission", "pass"] as LoopNodeId[])
      expect(s.nodes.find((n) => n.id === id)!.visual).toBe("unknown");
    const sched = s.nodes.find((n) => n.id === "scheduler")!;
    expect(sched.evidence.some((e) => e.value.includes("404"))).toBe(true);
    expect(s.freshness.filter((f) => f.state === "error")).toHaveLength(4);
  });

  it("14. cross-objective response → identity mismatch, no foreign data", () => {
    const foreign = cockpit();
    foreign.objective.objective_id = "OBJ_OTHER";
    const i = inputs({
      cockpit: epReady(foreign, AT),
      scheduler: epReady(scheduler({ objective_id: "OBJ_OTHER" }), AT),
      driver: epReady(driver({ objective_id: "OBJ_OTHER" }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.nodes.find((n) => n.id === "evidence")!.visual).toBe("unknown");
    expect(s.nodes.find((n) => n.id === "scheduler")!.visual).toBe("unknown");
    expect(s.freshness.filter((f) => f.state === "error")).toHaveLength(3);
    /* no foreign mission leaks into mission evidence */
    expect(s.nodes.find((n) => n.id === "mission")!.evidence
      .every((e) => !e.value.includes("MSN"))).toBe(true);
  });

  it("15. out-of-order polling responses rejected by shouldApplyResponse", () => {
    expect(shouldApplyResponse(100, 200)).toBe(true);
    expect(shouldApplyResponse(200, 100)).toBe(false); // stale — never applied
    expect(shouldApplyResponse(100, 100)).toBe(false); // duplicate — never applied
  });

  it("16. multiple workstreams/missions aggregate honestly", () => {
    const i = inputs({
      cockpit: epReady(cockpit({
        workstreams: [
          { workstream_key: "w1", work_item_id: "WI1", workstream_status: "IN_PROGRESS",
            completion_proven: false, allocation_state: "ALLOCATED", selected_agent_id: null,
            delegated_child: { work_item_id: "D1", status: "READY", completion_proven: false, bound_mission: true, lifecycle_class: "DELEGATED", mission: null } },
          { workstream_key: "w2", work_item_id: "WI2", workstream_status: "BACKLOG",
            completion_proven: false, allocation_state: "ALLOCATED", selected_agent_id: null, delegated_child: null },
        ],
        missions: [
          { mission_id: "MSN_A", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: null },
          { mission_id: "MSN_B", status: "COMPLETED", runtime_state: "IDLE", bound_open_id: null },
        ],
      }), AT),
    });
    const s = deriveLoopSnapshot(i);
    const alloc = s.nodes.find((n) => n.id === "alloc")!;
    expect(alloc.status).toBe("2 allocated");
    const msn = s.nodes.find((n) => n.id === "mission")!;
    expect(msn.visual).toBe("active"); // a running mission exists
    expect(msn.evidence.some((e) => e.label === "MSN_B")).toBe(true);
  });

  it("17. timestamps — null/invalid/past render safely and honestly", () => {
    expect(fmtTs(null)).toBe("not available");
    expect(fmtTs(undefined)).toBe("not available");
    expect(fmtTs("")).toBe("not available");
    expect(fmtTs("not-a-date")).toBe("invalid timestamp");
    expect(fmtTs(0)).toBe(new Date(0).toISOString()); // epoch 0 is valid
    expect(fmtDue(null, NOW)).toBe("none scheduled");
    expect(fmtDue(NOW - 5000, NOW)).toContain("due now"); // past → due now, not negative
    const i = inputs({
      scheduler: epReady(scheduler({ lease: { state: "CLAIMED", fence: 2, expires_at: "garbage" } }), AT),
    });
    const claim = node(i, "claim");
    expect(claim.evidence.some((e) => e.value === "invalid timestamp")).toBe(true);
  });

  it("18. settlement never claims completion without evidence (rule D)", () => {
    // fully-happy path — everything else proven, settle still unobserved
    const s = deriveLoopSnapshot(inputs());
    const settle = s.nodes.find((n) => n.id === "settle")!;
    expect(settle.visual).toBe("unknown");
    expect(settle.status).toBe("not observable");
    // even with a completed review and terminal objective, no settle proof exists
    const s2 = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        objective: { ...cockpit().objective, status: "ACHIEVED" },
        latest_review: {
          review_id: "RV1", outcome: "ALL_TARGETS_MET", owner_action_required: false,
          recommended_status: "ACHIEVED", wait_reason: null, binding_id: "B1",
          review_observation_digest: "d", source_ceo_decision_id: null,
          strategy_revision_id: null, all_targets_met: true,
          verified_kpi_count: 1, unverified_kpi_count: 0, gap_kpi_count: 0,
          created_by: "a", created_at: "2026-01-01T00:00:00Z",
        },
      }), AT),
    }));
    expect(s2.nodes.find((n) => n.id === "settle")!.visual).toBe("unknown");
    expect(s2.nodes.find((n) => n.id === "review")!.visual).toBe("proven");
  });

  it("19. nodeInspector returns clicked node's evidence with source kinds", () => {
    const s = deriveLoopSnapshot(inputs());
    const insp = nodeInspector(s, "admission")!;
    expect(insp.id).toBe("admission");
    expect(insp.evidence.length).toBeGreaterThan(0);
    expect(insp.evidence.every((e) => ["observed", "derived", "absent"].includes(e.kind))).toBe(true);
    expect(nodeInspector(s, "settle")!.evidence.some((e) => e.kind === "absent")).toBe(true);
    expect(nodeInspector(s, "br_fault" as LoopNodeId)).not.toBeNull();
  });

  it("20. snapshot updates across polls — visuals track new observations", () => {
    const before = deriveLoopSnapshot(inputs());
    expect(before.nodes.find((n) => n.id === "mission")!.visual).toBe("upcoming");
    const after = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        missions: [{ mission_id: "MSN_9", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: null }],
      }), NOW),
    }));
    expect(after.nodes.find((n) => n.id === "mission")!.visual).toBe("active");
    /* edges exist: spine + continuation loop + branches */
    const loop = after.edges.find((e) => e.kind === "loop")!;
    expect(loop.from).toBe("continuation");
    expect(loop.to).toBe("wake");
    const activeEdges = after.edges.filter((e) => e.active);
    expect(activeEdges.some((e) => e.to === "mission" || e.to === "exec")).toBe(true);
    /* freshness carries the newer observation time */
    expect(after.freshness.find((f) => f.source === "cockpit")!.atMs).toBe(NOW);
  });

  it("edge topology — spine sequential, branches attached, no phantom edges", () => {
    const s = deriveLoopSnapshot(inputs());
    const spine = s.edges.filter((e) => e.kind === "spine");
    expect(spine.length).toBe(14); // 15 spine nodes → 14 edges
    expect(spine[0]).toMatchObject({ from: "policy", to: "wake" });
    expect(spine[13]).toMatchObject({ from: "settle", to: "continuation" });
    const branches = s.edges.filter((e) => e.kind === "branch");
    expect(branches.length).toBe(5);
    expect(branches.every((b) => ["scheduler", "admission"].includes(b.from))).toBe(true);
  });

  it("active edges are observed-only — no animation without evidence", () => {
    // everything dormant → zero active edges
    const s = deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({
        queue_state: "IDLE", pending_reasons: [], pending_generation: null,
        claimed_generation: null, next_due: null, wait_kind: null, retry_count: 0,
        lease: null,
      }), AT),
      driver: epReady(driver({ enabled: false, admissions: [], last_fence: null, last_outcome: null }), AT),
      policy: epReady(policy({ configured: false, effective: false, state: "DISABLED" }), AT),
    }));
    expect(s.edges.filter((e) => e.active)).toHaveLength(0);
    expect(s.headline.visual).not.toBe("active");
  });
});
