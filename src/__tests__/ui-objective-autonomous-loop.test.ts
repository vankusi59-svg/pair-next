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
  correlateAdmission,
  deriveLoopSnapshot,
  epError,
  epMissing,
  epReady,
  fmtDue,
  fmtTs,
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
        lease: { state: "CLAIMED", fence: 9, expires_at: NOW + 300_000 },
      }), AT),
      driver: epReady(driver({ admissions: [],
        lease: { state: "CLAIMED", fence: 9, expires_at: NOW + 300_000 } }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.nodes.find((n) => n.id === "claim")!.visual).toBe("active");
    const adm = s.nodes.find((n) => n.id === "admission")!;
    expect(adm.visual).not.toBe("active"); // no proof of admission — never inferred
  });

  it("4. admission matched by exact fence+generation under live claim → admission active, pass admitted-not-running", () => {
    const i = inputs({
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED",
        claimed_generation: 7,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }), AT),
      driver: epReady(driver({
        admissions: [{ at: "2026-01-01T11:59:00Z", fence: 9, generation: 7,
          usage: { ceo_calls: 0, microusd: 0, missions: 0 } }],
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }), AT),
    });
    const s = deriveLoopSnapshot(i);
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("active");
    /* R1-F1: admission ≠ running pass — shown as admitted/unknown */
    const pass = s.nodes.find((n) => n.id === "pass")!;
    expect(pass.visual).toBe("waiting");
    expect(pass.status).toBe("ADMITTED / PASS STATUS UNKNOWN");
    /* correlateAdmission — exact semantics (R2-F3: confirmed-current
       claims require a valid future epoch expiry) */
    const liveLease = { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 };
    expect(correlateAdmission(
      driver({ admissions: [{ at: "x", fence: 9, generation: 7, usage: null }],
        lease: { ...liveLease } }),
      liveLease, 7, NOW,
    ).verdict).toBe("correlated");
    /* same fence + different generation → contradicted (never fallback) */
    expect(correlateAdmission(
      driver({ admissions: [{ at: "x", fence: 9, generation: 3, usage: null }],
        lease: { ...liveLease } }),
      liveLease, 7, NOW,
    ).verdict).toBe("contradicted");
    /* wrong fence → none */
    expect(correlateAdmission(
      driver({ admissions: [{ at: "x", fence: 3, generation: 7, usage: null }],
        lease: { ...liveLease } }),
      liveLease, 7, NOW,
    ).verdict).toBe("none");
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
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("failed");
    /* R3-F2 — fault has no live claim → historical: stays red on the
       node but cannot drive the headline as a current failure */
    expect(f.historical).toBe(true);
    expect(s.headline.visual).not.toBe("failed");
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
    /* R4-F1 — exact typed fault code preserved, labeled as a recorded
       fault with unverified cycle attribution (matching fences do not
       prove the fault belongs to the current claim) */
    expect(fault.status).toContain("INTEGRITY_FAULT");
    expect(fault.status).toContain("recorded fault");
    expect(fault.historical).toBe(true);
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

  it("10. driver denials → historical diagnostic, never current FAILED (R3-F2)", () => {
    const i = inputs({
      driver: epReady(driver({ denials: [{ reason: "BUDGET" }, { reason: "X" }] }), AT),
    });
    const f = node(i, "br_fault");
    expect(f.visual).not.toBe("failed");
    expect(f.visual).toBe("upcoming");
    expect(f.status).toContain("2 past denial(s)");
    expect(f.status).toContain("historical");
    expect(f.historical).toBe(true);
    /* denials alone must not drive the headline as a failure */
    const s = deriveLoopSnapshot(i);
    expect(s.headline.visual).not.toBe("failed");
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
      scheduler: epReady(scheduler({ lease: { state: "CLAIMED", fence: 2, expires_at: NaN } }), AT),
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

/* ---------------- R1 audit remediation regressions ---------------- */

describe("R1-F1 — no false active admission/pass from history", () => {
  const liveClaim = (leaseState: string, gen = 7, fence = 9) => inputs({
    scheduler: epReady(scheduler({
      queue_state: "CLAIMED",
      claimed_generation: gen,
      lease: { state: leaseState, fence, expires_at: NOW + 60_000 },
    }), AT),
    driver: epReady(driver({
      last_outcome: "WAITING",
      admissions: [{ at: "2026-01-01T11:00:00Z", fence, generation: gen,
        usage: { ceo_calls: 1, microusd: 1, missions: 0 } }],
      /* driver lease mirrors the scheduler observation — consistent
         snapshot; divergence is exercised separately in R2-F1 */
      lease: { state: leaseState, fence, expires_at: NOW + 60_000 },
    }), AT),
  });

  it("SETTLED lease + matching admission → NOT active (historical only)", () => {
    const s = deriveLoopSnapshot(liveClaim("SETTLED"));
    for (const id of ["claim", "admission", "pass"] as LoopNodeId[])
      expect(s.nodes.find((n) => n.id === id)!.visual).not.toBe("active");
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("proven"); // historical record
    expect(s.nodes.find((n) => n.id === "admission")!.detail).toContain("previous cycle");
  });

  it("RELEASED lease + matching admission → NOT active", () => {
    const s = deriveLoopSnapshot(liveClaim("RELEASED"));
    for (const id of ["claim", "admission", "pass"] as LoopNodeId[])
      expect(s.nodes.find((n) => n.id === id)!.visual).not.toBe("active");
  });

  it("ACTIVE lease + exact fence+generation → admission observed", () => {
    const s = deriveLoopSnapshot(liveClaim("ACTIVE"));
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("active");
    expect(s.nodes.find((n) => n.id === "claim")!.visual).toBe("active");
  });

  it("same fence + different generation → correlation fails, never fence-only fallback", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED", claimed_generation: 7,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }), AT),
      driver: epReady(driver({
        admissions: [{ at: "x", fence: 9, generation: 4, usage: null }],
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }), AT),
    }));
    const adm = s.nodes.find((n) => n.id === "admission")!;
    expect(adm.visual).not.toBe("active");
    /* R2-F1 — contradicted is UNKNOWN / INCONSISTENT, not proven */
    expect(adm.visual).toBe("unknown");
    expect(adm.status).toBe("UNKNOWN / INCONSISTENT");
    expect(adm.detail).toContain("earlier cycle");
  });

  it("missing generation inputs → unverifiable, not confirmed", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED", claimed_generation: null,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }), AT),
      driver: epReady(driver({
        admissions: [{ at: "x", fence: 9, generation: 7, usage: null }],
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }), AT),
    }));
    const adm = s.nodes.find((n) => n.id === "admission")!;
    expect(adm.visual).toBe("unknown");
    expect(adm.status).toBe("unverified");
  });

  it("expired ACTIVE lease (server epoch) → no confident current claim", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED", claimed_generation: 7,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW - 5_000 },
      }), AT),
      driver: epReady(driver({
        admissions: [{ at: "x", fence: 9, generation: 7, usage: null }],
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW - 5_000 },
      }), AT),
    }));
    expect(s.nodes.find((n) => n.id === "claim")!.visual).toBe("waiting");
    expect(s.nodes.find((n) => n.id === "claim")!.status).toContain("expiry observed");
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("unknown");
    expect(s.nodes.find((n) => n.id === "pass")!.visual).not.toBe("active");
  });

  it("historical admission + older successful outcome stays historical", () => {
    const s = deriveLoopSnapshot(liveClaim("SETTLED"));
    const pass = s.nodes.find((n) => n.id === "pass")!;
    expect(pass.visual).toBe("proven");
    expect(pass.detail).toContain("rule A");
  });
});

describe("R1-F2 — cockpit observation-integrity gating", () => {
  const obsBad = (over: Parameters<typeof cockpit>[0]) => inputs({
    cockpit: epReady(cockpit({ observation_error: "DIGEST_MISMATCH", ...over }), AT),
  });

  it("observation_error + mission RUNNING → EXECUTION not ACTIVE", () => {
    const s = deriveLoopSnapshot(obsBad({
      missions: [{ mission_id: "M1", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: null }],
    }));
    expect(s.nodes.find((n) => n.id === "exec")!.visual).not.toBe("active");
    expect(s.nodes.find((n) => n.id === "mission")!.status).toBe("unverified");
    /* no cockpit-derived active edge */
    expect(s.edges.filter((e) => e.active && ["mission", "exec", "alloc"].includes(e.to))).toHaveLength(0);
  });

  it("observation_error + allocated workstreams → ALLOCATION not PROVEN", () => {
    const s = deriveLoopSnapshot(obsBad({
      workstreams: [{ workstream_key: "w1", work_item_id: "WI", workstream_status: "IN_PROGRESS",
        completion_proven: false, allocation_state: "ALLOCATED", selected_agent_id: null, delegated_child: null }],
    }));
    const a = s.nodes.find((n) => n.id === "alloc")!;
    expect(a.visual).toBe("unknown");
    expect(a.status).toBe("unverified");
    /* raw claim retained as explicitly unverified evidence */
    expect(a.evidence.some((e) => e.label === "observation_error")).toBe(true);
    expect(a.evidence.some((e) => e.value === "1" && e.source === "cockpit")).toBe(true);
  });

  it("observation_error + latest review → REVIEW not PROVEN", () => {
    const s = deriveLoopSnapshot(obsBad({
      latest_review: {
        review_id: "RV", outcome: "ALL_TARGETS_MET", owner_action_required: false,
        recommended_status: "ACHIEVED", wait_reason: null, binding_id: "B",
        review_observation_digest: "d", source_ceo_decision_id: null,
        strategy_revision_id: null, all_targets_met: true,
        verified_kpi_count: 1, unverified_kpi_count: 0, gap_kpi_count: 0,
        created_by: "a", created_at: "2026-01-01T00:00:00Z",
      },
    }));
    const r = s.nodes.find((n) => n.id === "review")!;
    expect(r.visual).not.toBe("proven");
    expect(r.status).toBe("unverified");
  });

  it("observation_error + verified artifacts → EVIDENCE unverified", () => {
    const s = deriveLoopSnapshot(obsBad({
      artifacts: [{ artifact_id: "A1", logical_name: "f", mission_id: "M", execution_id: "E",
        state: "VERIFIED", artifact_class: "FILE", sha256: "x".repeat(64), byte_size: 1, created_at: "2026-01-01T00:00:00Z" }],
    }));
    expect(s.nodes.find((n) => n.id === "evidence")!.visual).toBe("unknown");
    expect(s.observationVerified).toBe(false);
  });

  it("observation_error + independent scheduler block → block still visible", () => {
    const s = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({ observation_error: "DIGEST_MISMATCH" }), AT),
      scheduler: epReady(scheduler({ queue_state: "BLOCKED_AUTHORITY", blocked_reason: "TERMS_STALE" }), AT),
    }));
    expect(s.nodes.find((n) => n.id === "scheduler")!.visual).toBe("blocked");
    expect(s.nodes.find((n) => n.id === "br_blocked")!.visual).toBe("blocked");
    /* headline surfaces the integrity note alongside independent data */
    expect(s.headline.detail).toContain("unverified");
    expect(s.headline.visual).toBe("blocked");
  });

  it("recovery: clean observation restores positive states", () => {
    const bad = deriveLoopSnapshot(obsBad({
      missions: [{ mission_id: "M1", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: null }],
    }));
    expect(bad.nodes.find((n) => n.id === "exec")!.visual).not.toBe("active");
    const good = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        missions: [{ mission_id: "M1", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: null }],
      }), AT),
    }));
    expect(good.nodes.find((n) => n.id === "exec")!.visual).toBe("active");
    expect(good.observationVerified).toBe(true);
  });
});

describe("R1-F3 — wake generation semantics, not stale reasons", () => {
  it("pending reasons + consumed generation → NO wake active", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({
        pending_reasons: ["OBJECTIVE_CREATED", "POLICY_ENABLE"],
        pending_generation: 5, claimed_generation: 5,
      }), AT),
    }));
    const w = s.nodes.find((n) => n.id === "wake")!;
    expect(w.visual).not.toBe("active");
    expect(w.status).toBe("consumed");
  });

  it("pending_generation > claimed_generation → pending wake observed", () => {
    const w = node(inputs({
      scheduler: epReady(scheduler({ pending_generation: 9, claimed_generation: 4 }), AT),
    }), "wake");
    expect(w.visual).toBe("active");
    expect(w.status).toContain("gen 9");
  });

  it("blocked queue + unconsumed wake → communicates blocked, not healthy", () => {
    const w = node(inputs({
      scheduler: epReady(scheduler({
        queue_state: "BLOCKED_RETRY_EXHAUSTED",
        pending_generation: 9, claimed_generation: 4,
        pending_reasons: ["RETRY"],
      }), AT),
    }), "wake");
    expect(w.visual).not.toBe("active");
    expect(w.status).toContain("blocked");
  });

  it("reasons without generation authority → unknown, not fabricated", () => {
    const w = node(inputs({
      scheduler: epReady(scheduler({
        pending_generation: null, claimed_generation: null,
        pending_reasons: ["OBJECTIVE_CREATED"],
      }), AT),
    }), "wake");
    expect(w.visual).toBe("unknown");
    expect(w.status).toBe("unverified wake");
  });
});

describe("R1-F4 — queue vs lease presentation coherence", () => {
  it("WAITING_CONSUMER + held lease → no contradictory headline", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({
        queue_state: "WAITING_CONSUMER",
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }), AT),
    }));
    const sched = s.nodes.find((n) => n.id === "scheduler")!;
    expect(sched.visual).toBe("waiting");
    expect(sched.status).toContain("lease held fence 9");
    /* claim active coexists — headline reports observed activity while
       the scheduler node's own wording explains the wait */
    expect(s.nodes.find((n) => n.id === "claim")!.visual).toBe("active");
    expect(s.headline.visual).toBe("active");
    expect(s.headline.label).toContain("node(s) active");
  });

  it("WAITING_CONSUMER + no lease → plain waiting presentation", () => {
    const sched = node(inputs({
      scheduler: epReady(scheduler({ queue_state: "WAITING_CONSUMER", lease: null }), AT),
    }), "scheduler");
    expect(sched.visual).toBe("waiting");
    expect(sched.status).toBe("WAITING_CONSUMER");
  });

  it("BLOCKED_RETRY_EXHAUSTED + released lease → blocked dominates", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({
        queue_state: "BLOCKED_RETRY_EXHAUSTED",
        blocked_reason: "RETRY_LIMIT_REACHED", retry_count: 4,
        lease: { state: "RELEASED", fence: 7, expires_at: null },
      }), AT),
    }));
    expect(s.headline.visual).toBe("blocked");
    expect(s.nodes.find((n) => n.id === "claim")!.visual).not.toBe("active");
  });

  it("active lease without admission → CLAIMED, never ADMITTED", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED", claimed_generation: 5,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }), AT),
      driver: epReady(driver({ admissions: [] }), AT),
    }));
    expect(s.nodes.find((n) => n.id === "claim")!.status).toContain("claimed");
    expect(s.nodes.find((n) => n.id === "admission")!.visual).not.toBe("active");
  });
});

describe("R1-F5/F6 — branch metadata + epoch lease expiry", () => {
  it("all five conditional nodes carry branch=true", () => {
    const s = deriveLoopSnapshot(inputs());
    const branches = s.nodes.filter((n) => n.branch);
    expect(branches).toHaveLength(5);
    expect(new Set(branches.map((n) => n.id))).toEqual(
      new Set(["br_blocked", "br_waiting", "br_retry", "br_fault", "br_owner"]),
    );
    /* spine untouched */
    expect(s.nodes.filter((n) => !n.branch)).toHaveLength(15);
  });

  it("lease expiry — valid epoch / null / expired / invalid / future (R2-F3 corrected)", () => {
    /* future expiry → lease held */
    expect(node(inputs({
      scheduler: epReady(scheduler({
        lease: { state: "ACTIVE", fence: 1, expires_at: NOW + 30_000 },
      }), AT),
    }), "claim").visual).toBe("active");
    /* null expiry on an ACTIVE-state lease → UNKNOWN, never ACTIVE */
    const nullC = node(inputs({
      scheduler: epReady(scheduler({
        lease: { state: "ACTIVE", fence: 1, expires_at: null },
      }), AT),
    }), "claim");
    expect(nullC.visual).toBe("unknown");
    expect(nullC.status).toBe("unverified lease");
    /* past expiry → observed-expired, not active */
    expect(node(inputs({
      scheduler: epReady(scheduler({
        lease: { state: "ACTIVE", fence: 1, expires_at: NOW - 1 },
      }), AT),
    }), "claim").visual).toBe("waiting");
    /* invalid expiry → unparseable → unverified, not active */
    const c = node(inputs({
      scheduler: epReady(scheduler({
        lease: { state: "ACTIVE", fence: 1, expires_at: NaN },
      }), AT),
    }), "claim");
    expect(c.visual).toBe("unknown");
    expect(c.status).toBe("unverified lease");
    expect(c.evidence.some((e) => e.value === "invalid timestamp")).toBe(true);
  });
});

describe("R1-F7 — freshness accuracy", () => {
  it("freshness carries each endpoint's own observation time", () => {
    const OLD = AT - 40_000;
    const s = deriveLoopSnapshot(inputs({
      policy: epReady(policy(), OLD),
      scheduler: epReady(scheduler(), AT),
    }));
    const pol = s.freshness.find((f) => f.source === "auto-policy")!;
    const sch = s.freshness.find((f) => f.source === "auto-scheduler")!;
    expect(pol.atMs).toBe(OLD);
    expect(sch.atMs).toBe(AT);
    /* a render tick never refreshes source freshness */
    expect(pol.atMs).toBeLessThan(NOW);
  });

  it("ordering: stale response rejected, newer accepted", () => {
    expect(shouldApplyResponse(5000, 4000)).toBe(false); // older loses
    expect(shouldApplyResponse(4000, 5000)).toBe(true);  // newer wins
    expect(shouldApplyResponse(0, 1000)).toBe(true);     // first apply
  });
});

/* ---------------- R2 audit remediation regressions ---------------- */

describe("R2-F1 — contradicted/inconsistent admission never proven", () => {
  const corrInputs = (schedLease: object | null, drvLease: object | null,
    gen: number | null, adm: { fence: number; generation: number }[]) =>
    inputs({
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED", claimed_generation: gen,
        lease: schedLease as never,
      }), AT),
      driver: epReady(driver({
        admissions: adm.map((a) => ({ at: "x", ...a, usage: null })),
        lease: drvLease as never,
      }), AT),
    });
  const LEASE = { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 };

  it("same fence + different generation → UNKNOWN / INCONSISTENT, conflict kept", () => {
    const s = deriveLoopSnapshot(corrInputs(LEASE, { ...LEASE }, 7,
      [{ fence: 9, generation: 4 }]));
    const adm = s.nodes.find((n) => n.id === "admission")!;
    expect(adm.visual).toBe("unknown");
    expect(adm.status).toBe("UNKNOWN / INCONSISTENT");
    /* conflicting values retained for diagnosis */
    expect(adm.evidence.some((e) => e.label === "matched admission" && e.value === "fence 9 · gen 4")).toBe(true);
    expect(adm.evidence.some((e) => e.label === "claimed_generation" && e.value === "7")).toBe(true);
  });

  it("scheduler vs driver lease fence disagreement → no verified admission", () => {
    const s = deriveLoopSnapshot(corrInputs(LEASE,
      { state: "ACTIVE", fence: 10, expires_at: NOW + 60_000 }, 7,
      [{ fence: 9, generation: 7 }]));
    const adm = s.nodes.find((n) => n.id === "admission")!;
    expect(adm.visual).toBe("unknown");
    expect(adm.status).toBe("UNKNOWN / INCONSISTENT");
    expect(adm.detail).toContain("OBSERVATION_INCONSISTENT");
    /* both raw lease observations retained separately */
    expect(adm.evidence.some((e) => e.label === "scheduler lease" && e.value === "ACTIVE · fence 9")).toBe(true);
    expect(adm.evidence.some((e) => e.label === "driver lease" && e.value === "ACTIVE · fence 10")).toBe(true);
  });

  it("differing lease snapshots mid-transition → inconsistent, NOT a fault", () => {
    const s = deriveLoopSnapshot(corrInputs(LEASE,
      { state: "SETTLED", fence: 9, expires_at: null }, 7,
      [{ fence: 9, generation: 7 }]));
    const adm = s.nodes.find((n) => n.id === "admission")!;
    expect(adm.visual).toBe("unknown");       // never fault/blocked for benign divergence
    expect(adm.status).toBe("UNKNOWN / INCONSISTENT");
    expect(s.nodes.filter((n) => n.visual === "failed")).toHaveLength(0);
  });

  it("contradicted admission → no active admission/pass edge", () => {
    const s = deriveLoopSnapshot(corrInputs(LEASE, { ...LEASE }, 7,
      [{ fence: 9, generation: 4 }]));
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("unknown");
    expect(s.nodes.find((n) => n.id === "pass")!.visual).toBe("unknown");
    expect(s.edges.filter((e) => e.active && (e.to === "admission" || e.to === "pass"))).toHaveLength(0);
  });

  it("valid correlation still observed when leases agree", () => {
    const s = deriveLoopSnapshot(corrInputs(LEASE, { ...LEASE }, 7,
      [{ fence: 9, generation: 7 }]));
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("active");
    expect(s.nodes.find((n) => n.id === "pass")!.status).toBe("ADMITTED / PASS STATUS UNKNOWN");
  });

  it("SETTLED + matching admission stays historical even if driver lease lags", () => {
    const s = deriveLoopSnapshot(corrInputs(
      { state: "SETTLED", fence: 9, expires_at: null },
      { state: "RELEASED", fence: 4, expires_at: null }, 7,
      [{ fence: 9, generation: 7 }]));
    const adm = s.nodes.find((n) => n.id === "admission")!;
    expect(adm.visual).toBe("proven");
    expect(adm.status).toContain("historical");
  });
});

describe("R2-F2 — owner action + missions under observation failure", () => {
  const obsBad = (over: Parameters<typeof cockpit>[0] = {}) => inputs({
    cockpit: epReady(cockpit({ observation_error: "DIGEST_MISMATCH", ...over }), AT),
  });

  it("cockpit DIGEST_MISMATCH + owner flag, scheduler=false → OWNER ACTION unverified", () => {
    const s = deriveLoopSnapshot(obsBad({
      lifecycle: { ...cockpit().lifecycle, owner_action_required: true },
    }));
    const o = s.nodes.find((n) => n.id === "br_owner")!;
    expect(o.visual).toBe("unknown");
    expect(o.status).toBe("unverified");
    expect(o.evidence.some((e) => e.label === "observation_error")).toBe(true);
    /* no branch edge activated by unverified cockpit data */
    expect(s.edges.find((e) => e.to === "br_owner")!.active).toBe(false);
  });

  it("cockpit invalid + scheduler owner flag → independent scheduler claim stays", () => {
    const s = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        observation_error: "DIGEST_MISMATCH",
        lifecycle: { ...cockpit().lifecycle, owner_action_required: true },
      }), AT),
      scheduler: epReady(scheduler({ owner_action_required: true }), AT),
    }));
    const o = s.nodes.find((n) => n.id === "br_owner")!;
    expect(o.visual).toBe("waiting");
    expect(o.status).toContain("scheduler");
    /* both claims distinguished in evidence */
    expect(o.evidence.some((e) => e.label === "scheduler flag" && e.value === "true")).toBe(true);
    expect(o.evidence.some((e) => e.label === "cockpit flag (raw, unverified)")).toBe(true);
  });

  it("cockpit valid + owner flag → normal OWNER ACTION behavior", () => {
    const s = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        lifecycle: { ...cockpit().lifecycle, owner_action_required: true },
      }), AT),
    }));
    const o = s.nodes.find((n) => n.id === "br_owner")!;
    expect(o.visual).toBe("waiting");
    expect(o.status).toContain("action required");
  });

  it("cockpit invalid + mission RUNNING → mission/exec unverified, no active cockpit edge", () => {
    const s = deriveLoopSnapshot(obsBad({
      missions: [{ mission_id: "M1", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: null }],
    }));
    expect(s.nodes.find((n) => n.id === "mission")!.visual).toBe("unknown");
    expect(s.nodes.find((n) => n.id === "exec")!.visual).toBe("unknown");
    expect(s.observationVerified).toBe(false);
    expect(s.edges.filter((e) => e.active &&
      ["mission", "exec", "evidence", "review", "alloc", "planner", "br_owner"]
        .includes(e.to))).toHaveLength(0);
  });

  it("integrity recovery → owner action + mission claims return", () => {
    const s = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        lifecycle: { ...cockpit().lifecycle, owner_action_required: true },
        missions: [{ mission_id: "M1", status: "RUNNING", runtime_state: "RUNNING", bound_open_id: null }],
      }), AT),
    }));
    expect(s.nodes.find((n) => n.id === "br_owner")!.visual).toBe("waiting");
    expect(s.nodes.find((n) => n.id === "exec")!.visual).toBe("active");
    expect(s.observationVerified).toBe(true);
  });
});

describe("R2-F3 — lease expiry validity gates active claims", () => {
  const at = (lease: { state: string; fence: number | null; expires_at: number | null },
    over: Parameters<typeof inputs>[0] = {}) =>
    deriveLoopSnapshot(inputs({
      scheduler: epReady(scheduler({ lease, queue_state: "WAITING_CONSUMER" }), AT),
      ...over,
    }));

  it("ACTIVE + Infinity expiry → UNKNOWN, not active", () => {
    const c = at({ state: "ACTIVE", fence: 1, expires_at: Infinity }).nodes.find((n) => n.id === "claim")!;
    expect(c.visual).toBe("unknown");
    expect(c.status).toBe("unverified lease");
  });

  it("ACTIVE + negative expiry → UNKNOWN, not active", () => {
    const c = at({ state: "ACTIVE", fence: 1, expires_at: -500 }).nodes.find((n) => n.id === "claim")!;
    expect(c.visual).toBe("unknown");
  });

  it("invalid expiry + exact fence/generation → admission never current", () => {
    const lease = { state: "ACTIVE", fence: 9, expires_at: NaN };
    const s = at(lease as never, {
      scheduler: epReady(scheduler({
        queue_state: "CLAIMED", claimed_generation: 7, lease: lease as never,
      }), AT),
      driver: epReady(driver({
        admissions: [{ at: "x", fence: 9, generation: 7, usage: null }],
        lease: lease as never,
      }), AT),
    });
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("unknown");
    expect(s.nodes.find((n) => n.id === "admission")!.status).toBe("unverified");
    expect(s.nodes.find((n) => n.id === "pass")!.visual).not.toBe("active");
  });

  it("WAITING_CONSUMER + invalid lease expiry → no lease-held narrative", () => {
    const s = at({ state: "ACTIVE", fence: 9, expires_at: NaN });
    const sched = s.nodes.find((n) => n.id === "scheduler")!;
    expect(sched.visual).toBe("waiting");
    expect(sched.status).not.toContain("lease held");
    expect(sched.status).toContain("unverified");
  });
});

/* ---------------- R3 audit remediation regressions ---------------- */

describe("R3-F1 — cockpit integrity failure cannot claim FAILED", () => {
  const obsBad = (over: Parameters<typeof cockpit>[0]) => inputs({
    cockpit: epReady(cockpit({ observation_error: "DIGEST_MISMATCH", ...over }), AT),
  });

  it("observation_error + mission FAILED → mission UNKNOWN/UNVERIFIED, headline never FAILED", () => {
    const s = deriveLoopSnapshot(obsBad({
      missions: [{ mission_id: "M1", status: "FAILED", runtime_state: "FAILED", bound_open_id: null }],
    }));
    const m = s.nodes.find((n) => n.id === "mission")!;
    expect(m.visual).toBe("unknown");
    expect(m.status).toBe("unverified");
    expect(m.evidence.some((e) => e.label === "observation_error")).toBe(true);
    /* headline must not assert the unverified failure */
    expect(s.headline.visual).not.toBe("failed");
    expect(s.headline.label).not.toContain("failed");
  });

  it("observation_error + mission CANCELLED → no authoritative failed node", () => {
    const s = deriveLoopSnapshot(obsBad({
      missions: [{ mission_id: "M1", status: "CANCELLED", runtime_state: null, bound_open_id: null }],
    }));
    expect(s.nodes.find((n) => n.id === "mission")!.visual).toBe("unknown");
    expect(s.nodes.filter((n) => !n.historical &&
      n.visual === "failed" && n.id === "mission")).toHaveLength(0);
  });

  it("clean cockpit + mission FAILED → failed presentation preserved as mission observation", () => {
    const s = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        missions: [{ mission_id: "M1", status: "FAILED", runtime_state: "FAILED", bound_open_id: null }],
      }), AT),
    }));
    const m = s.nodes.find((n) => n.id === "mission")!;
    expect(m.visual).toBe("failed");
    expect(m.detail).toContain("cockpit observation");
  });

  it("invalid cockpit + independently blocked scheduler → block stays authoritative", () => {
    const s = deriveLoopSnapshot(obsBad({
      missions: [{ mission_id: "M1", status: "FAILED", runtime_state: "FAILED", bound_open_id: null }],
    }));
    /* override scheduler to blocked */
    const s2 = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        observation_error: "DIGEST_MISMATCH",
        missions: [{ mission_id: "M1", status: "FAILED", runtime_state: "FAILED", bound_open_id: null }],
      }), AT),
      scheduler: epReady(scheduler({
        queue_state: "BLOCKED_RETRY_EXHAUSTED", blocked_reason: "RETRY_LIMIT_REACHED",
      }), AT),
    }));
    expect(s2.nodes.find((n) => n.id === "scheduler")!.visual).toBe("blocked");
    expect(s2.headline.visual).toBe("blocked");
    expect(s2.nodes.find((n) => n.id === "mission")!.visual).toBe("unknown");
    void s;
  });

  it("recovery: valid cockpit restores mission states", () => {
    const bad = deriveLoopSnapshot(obsBad({
      missions: [{ mission_id: "M1", status: "FAILED", runtime_state: "FAILED", bound_open_id: null }],
    }));
    expect(bad.nodes.find((n) => n.id === "mission")!.visual).toBe("unknown");
    const good = deriveLoopSnapshot(inputs({
      cockpit: epReady(cockpit({
        missions: [{ mission_id: "M1", status: "FAILED", runtime_state: "FAILED", bound_open_id: null }],
      }), AT),
    }));
    expect(good.nodes.find((n) => n.id === "mission")!.visual).toBe("failed");
    expect(good.observationVerified).toBe(true);
  });

  it("no edge animates toward a cockpit node whose authority is unverified", () => {
    const s = deriveLoopSnapshot(obsBad({
      missions: [{ mission_id: "M1", status: "FAILED", runtime_state: "FAILED", bound_open_id: null }],
    }));
    for (const id of ["alloc", "planner", "mission", "exec", "evidence", "review"])
      expect(s.edges.filter((e) => e.to === id && e.active)).toHaveLength(0);
  });
});

describe("R3-F2 — historical denials/faults never drive current FAILED", () => {
  const drv = (over: Parameters<typeof driver>[0]) => epReady(driver(over), AT);
  const sch = (over: Parameters<typeof scheduler>[0]) => epReady(scheduler(over), AT);

  it("old denial + newer successful admission + settled → no current FAILED headline", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({
        queue_state: "SETTLED",
        lease: { state: "SETTLED", fence: 9, expires_at: null },
        claimed_generation: 7,
      }),
      driver: drv({
        last_outcome: "CEO_PASS_COMMITTED",
        last_result: { fault: null },
        last_fence: 9,
        admissions: [
          { at: "2026-01-01T11:00:00Z", fence: 8, generation: 6, usage: null },
          { at: "2026-01-01T11:50:00Z", fence: 9, generation: 7, usage: null },
        ],
        denials: [{ at: "2026-01-01T10:00:00Z", fence: 8, reason: "BUDGET" }],
        lease: { state: "SETTLED", fence: 9, expires_at: null },
      }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).not.toBe("failed");
    expect(f.historical).toBe(true);
    expect(s.headline.visual).not.toBe("failed");
    expect(s.headline.label).not.toContain("denial");
  });

  it("old denial only, no fault → historical diagnostic, not failure", () => {
    const s = deriveLoopSnapshot(inputs({
      driver: drv({ denials: [{ reason: "BUDGET", at: "2026-01-01T09:00:00Z", fence: 3 }] }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("upcoming");
    expect(f.status).toContain("past denial");
    expect(f.historical).toBe(true);
    expect(s.edges.find((e) => e.to === "br_fault")!.active).toBe(false);
  });

  it("last_result.fault stays prominent + exact code, distinct from last_outcome", () => {
    const s = deriveLoopSnapshot(inputs({
      driver: drv({
        last_outcome: "CEO_PASS_COMMITTED",
        last_result: { fault: "INTEGRITY_FAULT" },
        last_fence: 4,
      }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("failed");
    expect(f.status).toContain("INTEGRITY_FAULT");
    /* R4-F1 — recorded, unattributed: no current-cycle claim */
    expect(f.historical).toBe(true);
    expect(f.detail).toContain("CURRENT CYCLE UNVERIFIED");
    /* last_outcome preserved separately in pass evidence */
    expect(s.nodes.find((n) => n.id === "pass")!.evidence
      .some((e) => e.value === "CEO_PASS_COMMITTED")).toBe(true);
  });

  it("fault + last_fence equal to claim fence → STILL not current (R4-F1)", () => {
    /* writeState preserves last_result under a newer last_fence —
       fence equality is not an authoritative fault→cycle binding */
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({
        queue_state: "EXECUTING", claimed_generation: 7,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }),
      driver: drv({
        last_result: { fault: "EXECUTION_FAILED" },
        last_fence: 9,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("failed");          // recorded fault stays prominent
    expect(f.status).toContain("EXECUTION_FAILED");
    expect(f.status).toContain("recorded fault");
    expect(f.historical).toBe(true);          // but never a CURRENT failure
    expect(s.headline.visual).not.toBe("failed");
  });

  it("scheduler BLOCKED + historical denials → block dominates headline", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({
        queue_state: "BLOCKED_RETRY_EXHAUSTED", blocked_reason: "RETRY_LIMIT_REACHED",
      }),
      driver: drv({ denials: [{ reason: "BUDGET" }, { reason: "X" }] }),
    }));
    expect(s.headline.visual).toBe("blocked");
    expect(s.nodes.find((n) => n.id === "br_fault")!.historical).toBe(true);
  });

  it("denial at previous fence + current active claim → claim not marked denied", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({
        queue_state: "CLAIMED", claimed_generation: 7,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }),
      driver: drv({
        denials: [{ at: "x", fence: 4, reason: "BUDGET" }],
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }),
    }));
    expect(s.nodes.find((n) => n.id === "claim")!.visual).toBe("active");
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).not.toBe("failed");
    expect(f.historical).toBe(true);
  });

  it("fault tied to prior fence + newer claim → not assigned to new cycle", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({
        queue_state: "CLAIMED", claimed_generation: 7,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }),
      driver: drv({
        last_result: { fault: "EXECUTION_FAILED" },
        last_fence: 4,
        lease: { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 },
      }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("failed");         // stays visible as latest recorded
    expect(f.historical).toBe(true);         // but NOT a current-cycle failure
    expect(f.status).toContain("recorded fault");
    expect(s.headline.visual).not.toBe("failed");
    expect(s.edges.find((e) => e.to === "br_fault")!.active).toBe(false);
  });

  it("malformed denial metadata → no fabricated ordering, stays historical", () => {
    const s = deriveLoopSnapshot(inputs({
      driver: drv({ denials: [{ note: "unstructured" }, {}], last_result: { fault: null } }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("upcoming");
    expect(f.status).toContain("past denial");
    expect(s.headline.visual).not.toBe("failed");
  });

  it("no denials and no fault → branch inactive", () => {
    const s = deriveLoopSnapshot(inputs({
      driver: drv({ denials: [], last_result: { fault: null } }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("upcoming");
    expect(f.status).toBe("no fault");
  });
});

/* ---------------- R4 audit remediation regressions ---------------- */

describe("R4-F1 — no unsound current-cycle fault attribution", () => {
  const drv = (over: Parameters<typeof driver>[0]) => epReady(driver(over), AT);
  const sch = (over: Parameters<typeof scheduler>[0]) => epReady(scheduler(over), AT);
  const LIVE9 = { state: "ACTIVE", fence: 9, expires_at: NOW + 60_000 };

  it("fault@8 + recordDenial bumped last_fence=9 + claim@9 → NO current FAILED", () => {
    /* backend-realistic: recordDenial writes last_fence=9 and a denial
       row while preserving the old last_result.fault */
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({ queue_state: "CLAIMED", claimed_generation: 7, lease: LIVE9 }),
      driver: drv({
        last_result: { fault: "EXECUTION_FAILED" },
        last_fence: 9, // bumped by recordDenial, NOT by a new fault
        denials: [{ at: "2026-01-01T11:55:00Z", fence: 9, label: "BUDGET_EXCEEDED" }],
        lease: { ...LIVE9 },
      }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.status).toContain("EXECUTION_FAILED");
    expect(f.historical).toBe(true);
    expect(s.headline.visual).not.toBe("failed");
    expect(s.edges.find((e) => e.to === "br_fault")!.active).toBe(false);
  });

  it("fault + last_fence === claim fence → still no current attribution", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({ queue_state: "EXECUTING", claimed_generation: 7, lease: LIVE9 }),
      driver: drv({
        last_result: { fault: "EXECUTION_FAILED" },
        last_fence: 9, lease: { ...LIVE9 },
      }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.status).toContain("recorded fault");
    expect(f.historical).toBe(true);
    expect(s.headline.visual).not.toBe("failed");
  });

  it("fault with no active claim → recorded fault visible, no FAILED headline", () => {
    const s = deriveLoopSnapshot(inputs({
      driver: drv({ last_result: { fault: "PLANNER_EXHAUSTED" }, last_fence: 4 }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("failed");
    expect(f.detail).toContain("CURRENT CYCLE UNVERIFIED");
    expect(s.headline.visual).not.toBe("failed");
  });

  it("INTEGRITY_FAULT + older last_outcome → code preserved, unattributed", () => {
    const s = deriveLoopSnapshot(inputs({
      driver: drv({
        last_outcome: "CEO_PASS_COMMITTED",
        last_result: { fault: "INTEGRITY_FAULT" },
      }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.status).toBe("recorded fault · INTEGRITY_FAULT");
    /* separate evidence rows: outcome, fences, both leases */
    const lbl = (l: string) => f.evidence.filter((e) => e.label === l);
    expect(lbl("last_outcome")[0]?.value).toBe("CEO_PASS_COMMITTED");
    expect(lbl("last_fence").length).toBe(1);
    expect(lbl("scheduler lease").length).toBe(1);
    expect(lbl("driver lease").length).toBe(1);
  });

  it("scheduler BLOCKED + unattributed fault → block owns the headline", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({
        queue_state: "BLOCKED_RETRY_EXHAUSTED", blocked_reason: "RETRY_LIMIT_REACHED",
      }),
      driver: drv({ last_result: { fault: "EXECUTION_FAILED" }, last_fence: 4 }),
    }));
    expect(s.headline.visual).toBe("blocked");
    expect(s.headline.label).toContain("RETRY");
    expect(s.nodes.find((n) => n.id === "br_fault")!.historical).toBe(true);
  });

  it("lease observations disagree + fault → no invented attribution", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({ queue_state: "CLAIMED", claimed_generation: 7, lease: LIVE9 }),
      driver: drv({
        last_result: { fault: "EXECUTION_FAILED" },
        last_fence: 9,
        lease: { state: "SETTLED", fence: 8, expires_at: null },
      }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.historical).toBe(true);
    expect(s.headline.visual).not.toBe("failed");
    /* admission inconsistency stays inconsistent too */
    expect(s.nodes.find((n) => n.id === "admission")!.status)
      .toBe("UNKNOWN / INCONSISTENT");
  });

  it("no fault + historical denials → historical diagnostic only", () => {
    const s = deriveLoopSnapshot(inputs({
      driver: drv({ denials: [{ at: "x", fence: 3, label: "BUDGET" }] }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("upcoming");
    expect(f.status).toContain("past denial");
    expect(f.detail).toContain("Driver activity panel");
  });

  it("valid active admission without fault → no false failure edge", () => {
    const s = deriveLoopSnapshot(inputs({
      scheduler: sch({ queue_state: "CLAIMED", claimed_generation: 7, lease: LIVE9 }),
      driver: drv({
        admissions: [{ at: "x", fence: 9, generation: 7, usage: null }],
        last_result: { fault: null },
        lease: { ...LIVE9 },
      }),
    }));
    expect(s.nodes.find((n) => n.id === "admission")!.visual).toBe("active");
    expect(s.nodes.find((n) => n.id === "br_fault")!.visual).toBe("upcoming");
    expect(s.edges.find((e) => e.to === "br_fault")!.active).toBe(false);
  });

  it("unattributed fault → diagnostic node visible, edge not an execution path", () => {
    const s = deriveLoopSnapshot(inputs({
      driver: drv({ last_result: { fault: "DENIAL_PERSISTENT" }, last_fence: 4 }),
    }));
    const f = s.nodes.find((n) => n.id === "br_fault")!;
    expect(f.visual).toBe("failed");            // diagnostic severity stays visible
    expect(f.historical).toBe(true);
    expect(s.edges.find((e) => e.to === "br_fault")!.active).toBe(false);
  });
});
