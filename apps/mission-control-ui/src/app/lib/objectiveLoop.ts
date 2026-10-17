/* Objective Autonomous Loop — pure presentation-derivation layer.

   Converts four independent owner-scoped observations (cockpit,
   auto-policy, auto-scheduler, auto-driver) into a node/edge flowchart
   snapshot. The derive functions are PURE and DETERMINISTIC: same inputs
   → same snapshot, no Date.now()/random calls inside (nowMs is injected).

   Authority rules implemented here (task §5):
   A — current vs historical: durable history is rendered "observed
       earlier", never as current-cycle progress.
   B — claim vs admission: an active lease proves a claim only;
       ADMITTED requires an admission record matching the same
       fence/generation.
   C — planner/CEO substages: only canonical observations count;
       unknown → "NOT OBSERVED".
   D — settlement: no per-cycle settle proof is exposed → settlement
       stays unobserved unless evidence says otherwise.
   E — faults: last_result.fault, denials, queue blockers and
       last_outcome are reported separately; a fresh fault can coexist
       with an older success.
   F — the four reads are not atomic; nothing here asserts cross-
       endpoint ordering beyond explicit fence/generation correlation.
   G — next_due (epoch ms), lease expiry and policy expiry are shown
       as separate concepts; no synthetic ETA. */

import type {
  AutoDriverStatus,
  AutoPolicyStatus,
  AutoSchedulerStatus,
} from "../../types";
import type { CockpitPayload } from "../types";

/* ---------------- tri-state per endpoint read ---------------- */

export type EpRead<T> =
  | { kind: "ready"; data: T; atMs: number }
  | { kind: "error"; status: number | null; code: string }
  | { kind: "missing" };

export const epReady = <T>(data: T, atMs: number): EpRead<T> => ({
  kind: "ready",
  data,
  atMs,
});
export const epError = (status: number | null, code: string): EpRead<never> => ({
  kind: "error",
  status,
  code,
});
export const epMissing = <T>(): EpRead<T> => ({ kind: "missing" });

/* ---------------- graph model ---------------- */

export type LoopVisual =
  | "proven" // green — observed completion evidence (may be historical)
  | "active" // blue — currently active, observed
  | "waiting" // amber — waiting / retry / scheduled
  | "blocked" // red — blocked by policy/authority/fault
  | "failed" // red — failed observation
  | "upcoming" // gray — not reached / inactive / absent
  | "unknown"; // neutral — endpoint unavailable or data insufficient

export type LoopNodeId =
  | "policy"
  | "wake"
  | "scheduler"
  | "claim"
  | "admission"
  | "pass"
  | "ceo"
  | "alloc"
  | "planner"
  | "mission"
  | "exec"
  | "evidence"
  | "review"
  | "settle"
  | "continuation"
  | "br_blocked"
  | "br_waiting"
  | "br_retry"
  | "br_fault"
  | "br_owner";

export type LoopSource =
  | "cockpit"
  | "auto-policy"
  | "auto-scheduler"
  | "auto-driver";

export interface LoopEvidence {
  label: string;
  value: string;
  source: LoopSource;
  /* observed = raw endpoint field; derived = presentation computation;
     absent = explicitly reported as not available. */
  kind: "observed" | "derived" | "absent";
}

export interface LoopNodeState {
  id: LoopNodeId;
  title: string;
  visual: LoopVisual;
  /* short textual status rendered on the node — colour is never the
     only status indicator. */
  status: string;
  detail?: string;
  evidence: LoopEvidence[];
  branch: boolean; // conditional side-branch node
}

export interface LoopEdge {
  from: LoopNodeId;
  to: LoopNodeId;
  kind: "spine" | "loop" | "branch";
  /* active = observed current-cycle flow towards `to`; never simulated. */
  active: boolean;
}

export interface LoopFreshness {
  source: LoopSource;
  state: "ok" | "error" | "missing";
  atMs: number | null;
  note?: string;
}

export interface LoopSnapshot {
  nodes: LoopNodeState[];
  edges: LoopEdge[];
  headline: { visual: LoopVisual; label: string; detail?: string };
  freshness: LoopFreshness[];
  /* false when cockpit.observation_error is non-null — cockpit-derived
     progress must not be presented as verified. */
  observationVerified: boolean;
  observationError: string | null;
}

export interface LoopInputs {
  objectiveId: string;
  nowMs: number;
  cockpit: EpRead<CockpitPayload>;
  policy: EpRead<AutoPolicyStatus>;
  scheduler: EpRead<AutoSchedulerStatus>;
  driver: EpRead<AutoDriverStatus>;
}

/* ---------------- safe formatting ---------------- */

const NA = "not available";

/* Render a timestamp that may be ISO string, epoch-ms number, null,
   or garbage — never throws, never lies. */
export function fmtTs(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return NA;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "invalid timestamp" : d.toISOString();
}

/* Relative description for an epoch-ms checkpoint. Null = absent, NOT
   "due now" (rule G). */
export function fmtDue(nextDue: number | null | undefined, nowMs: number): string {
  if (nextDue === null || nextDue === undefined || !Number.isFinite(nextDue))
    return "none scheduled";
  const ms = nextDue - nowMs;
  const iso = fmtTs(nextDue);
  if (ms <= 0) return `due now (${iso})`;
  const s = Math.round(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `due in ${mm}m ${String(ss).padStart(2, "0")}s (${iso})`;
}

/* Polling guard (rule F + stale-response protection): apply a response
   only when it is newer than the last applied observation for the same
   endpoint+objective pair. */
export function shouldApplyResponse(lastAppliedMs: number, responseAtMs: number): boolean {
  return responseAtMs > lastAppliedMs;
}

/* ---------------- evidence builders ---------------- */

const ev = (
  label: string,
  value: unknown,
  source: LoopSource,
  kind: LoopEvidence["kind"] = "observed",
): LoopEvidence => ({
  label,
  value:
    value === null || value === undefined || value === ""
      ? NA
      : String(value),
  source,
  kind,
});

const absent = (label: string, source: LoopSource): LoopEvidence =>
  ev(label, NA, source, "absent");

const UNKNOWN_STATUS = "NOT OBSERVED";

/* ---------------- node derivation ---------------- */

function derivePolicy(i: LoopInputs): LoopNodeState {
  const e: LoopEvidence[] = [];
  const ck = i.cockpit;
  if (ck.kind === "ready") {
    e.push(ev("objective status", ck.data.objective.status, "cockpit"));
  }
  const p = i.policy;
  if (p.kind === "missing")
    return mk("policy", "OBJECTIVE / POLICY", "unknown", UNKNOWN_STATUS, [
      ...e,
      absent("policy read", "auto-policy"),
    ]);
  if (p.kind === "error")
    return mk("policy", "OBJECTIVE / POLICY", "unknown", UNKNOWN_STATUS, [
      ...e,
      ev("read error", `HTTP ${p.status ?? "—"} · ${p.code}`, "auto-policy", "absent"),
    ]);
  const d = p.data;
  e.push(
    ev("policy state", d.state, "auto-policy"),
    ev("effective", d.effective, "auto-policy"),
    ev("policy_version", d.policy_version, "auto-policy"),
    ev("expires_at", fmtTs(d.expires_at), "auto-policy"),
  );
  if (d.reasons?.length) e.push(ev("reasons", d.reasons.join(", "), "auto-policy"));
  if (!d.configured)
    return mk("policy", "OBJECTIVE / POLICY", "upcoming", "no auto-policy", e, false,
      "No auto-policy is configured for this objective — the autonomous loop is dormant.");
  if (d.state === "HALTED" || d.state === "REVOKED")
    return mk("policy", "OBJECTIVE / POLICY", "blocked", d.state, e, false,
      d.halt ? `halted ${fmtTs(d.halt.at)} — ${d.halt.reason}` : undefined);
  if (d.effective)
    return mk("policy", "OBJECTIVE / POLICY", "proven", "effective", e);
  const status =
    d.state === "DISABLED" ? "disabled"
    : d.state === "PAUSED" ? "paused"
    : d.state === "EXPIRED" ? "expired — re-arm needed"
    : "not effective";
  return mk("policy", "OBJECTIVE / POLICY", "upcoming", status, e);
}

function deriveWake(i: LoopInputs): LoopNodeState {
  const s = i.scheduler;
  if (s.kind !== "ready")
    return mk("wake", "DURABLE WAKE", "unknown", UNKNOWN_STATUS,
      [absent("scheduler read", "auto-scheduler")]);
  const d = s.data;
  const e: LoopEvidence[] = [
    ev("pending_reasons", d.pending_reasons?.join(", ") || "none", "auto-scheduler"),
    ev("pending_generation", d.pending_generation, "auto-scheduler"),
    ev("claimed_generation", d.claimed_generation, "auto-scheduler"),
    ev("source_refs", d.source_refs?.join(", ") || "none", "auto-scheduler"),
    ev("coalesced_count", d.coalesced_count, "auto-scheduler"),
  ];
  const pending = (d.pending_reasons ?? []).length > 0;
  const pendNew =
    d.pending_generation !== null &&
    d.pending_generation !== undefined &&
    (d.claimed_generation === null ||
      d.claimed_generation === undefined ||
      d.pending_generation > d.claimed_generation);
  if (pending || pendNew)
    return mk("wake", "DURABLE WAKE", "active", "wake pending", e, false,
      "A durable wake observation is pending consumption.");
  if (d.claimed_generation !== null && d.claimed_generation !== undefined)
    return mk("wake", "DURABLE WAKE", "proven", "consumed", e, false,
      "A wake generation was claimed earlier — historical, not a live wake.");
  return mk("wake", "DURABLE WAKE", "upcoming", "none observed", e);
}

function deriveScheduler(i: LoopInputs): LoopNodeState {
  const s = i.scheduler;
  if (s.kind === "missing")
    return mk("scheduler", "SCHEDULER", "unknown", UNKNOWN_STATUS,
      [absent("scheduler read", "auto-scheduler")]);
  if (s.kind === "error")
    return mk("scheduler", "SCHEDULER", "unknown", UNKNOWN_STATUS, [
      ev("read error", `HTTP ${s.status ?? "—"} · ${s.code}`, "auto-scheduler", "absent"),
    ]);
  const d = s.data;
  const e: LoopEvidence[] = [
    ev("queue_state", d.queue_state, "auto-scheduler"),
    ev("scheduler_ready", d.scheduler_ready, "auto-scheduler"),
    ev("consumer_ready", d.consumer_ready, "auto-scheduler"),
    ev("driver_ready", d.driver_ready, "auto-scheduler"),
    ev("driver_integrated", d.driver_integrated, "auto-scheduler"),
    ev("driver_missing", d.driver_missing?.join(", ") || "none", "auto-scheduler"),
    ev("wait_kind", d.wait_kind, "auto-scheduler"),
    ev("blocked_reason", d.blocked_reason, "auto-scheduler"),
    ev("retry_count", d.retry_count, "auto-scheduler"),
    ev("catchup_state", d.catchup_state, "auto-scheduler"),
    ev("next_due", fmtDue(d.next_due, i.nowMs), "auto-scheduler"),
  ];
  if (d.scheduler_ready === false)
    return mk("scheduler", "SCHEDULER", "failed", "not ready", e);
  const q = d.queue_state ?? "";
  if (q.startsWith("BLOCKED"))
    return mk("scheduler", "SCHEDULER", "blocked", q, e, false, d.blocked_reason ?? undefined);
  if (q === "CLAIMED" || q === "EXECUTING" || q === "IN_PROGRESS")
    return mk("scheduler", "SCHEDULER", "active", q, e);
  if (q === "WAITING_CONSUMER" || q === "WAITING" || q === "IDLE")
    return mk("scheduler", "SCHEDULER", "waiting", q, e);
  return mk("scheduler", "SCHEDULER", "waiting", q || UNKNOWN_STATUS, e);
}

function deriveClaim(i: LoopInputs): LoopNodeState {
  const s = i.scheduler;
  if (s.kind !== "ready")
    return mk("claim", "CLAIM / LEASE", "unknown", UNKNOWN_STATUS,
      [absent("scheduler read", "auto-scheduler")]);
  const l = s.data.lease;
  if (!l)
    return mk("claim", "CLAIM / LEASE", "upcoming", "no lease",
      [absent("lease", "auto-scheduler")]);
  const e: LoopEvidence[] = [
    ev("lease state", l.state, "auto-scheduler"),
    ev("fence", l.fence, "auto-scheduler"),
    ev("expires_at", fmtTs(l.expires_at), "auto-scheduler"),
  ];
  if (l.state === "CLAIMED" || l.state === "HELD" || l.state === "ACTIVE")
    return mk("claim", "CLAIM / LEASE", "active", `claimed · fence ${l.fence ?? "?"}`, e, false,
      "Active scheduler claim — this alone does NOT prove driver admission (rule B).");
  if (l.state === "EXPIRED")
    return mk("claim", "CLAIM / LEASE", "waiting", "lease expired", e);
  return mk("claim", "CLAIM / LEASE", "upcoming", `${String(l.state).toLowerCase()} · fence ${l.fence ?? "—"}`, e);
}

/* Rule B core: find an admission that correlates with the current
   claim — same fence, and when generations exist, same generation. */
export function matchingAdmission(
  driver: AutoDriverStatus | null,
  lease: { fence: number | null } | null,
  claimedGeneration: number | null,
): AutoDriverStatus["admissions"][number] | null {
  if (!driver || !lease || lease.fence === null || lease.fence === undefined)
    return null;
  const sameFence = driver.admissions.filter((a) => a.fence === lease.fence);
  if (!sameFence.length) return null;
  if (claimedGeneration !== null && claimedGeneration !== undefined) {
    const g = sameFence.find((a) => a.generation === claimedGeneration);
    if (g) return g;
  }
  return sameFence[0];
}

function deriveAdmission(i: LoopInputs): LoopNodeState {
  const d = i.driver;
  if (d.kind === "missing")
    return mk("admission", "DRIVER ADMISSION", "unknown", UNKNOWN_STATUS,
      [absent("driver read", "auto-driver")]);
  if (d.kind === "error")
    return mk("admission", "DRIVER ADMISSION", "unknown", UNKNOWN_STATUS, [
      ev("read error", `HTTP ${d.status ?? "—"} · ${d.code}`, "auto-driver", "absent"),
    ]);
  const dd = d.data;
  const schedLease = i.scheduler.kind === "ready" ? i.scheduler.data.lease : null;
  const claimedGen = i.scheduler.kind === "ready" ? i.scheduler.data.claimed_generation : null;
  const lease = dd.lease ?? schedLease;
  const match = matchingAdmission(dd, schedLease, claimedGen);
  const last = dd.admissions?.length ? dd.admissions[dd.admissions.length - 1] : null;
  const e: LoopEvidence[] = [
    ev("driver enabled", dd.enabled, "auto-driver"),
    ev("admissions", dd.admissions?.length ?? 0, "auto-driver"),
    ev("last_fence", dd.last_fence, "auto-driver"),
    ev("matched admission", match ? `fence ${match.fence} · gen ${match.generation}` : NA, "auto-driver", "derived"),
    ev("lease", lease ? `${lease.state} · fence ${lease.fence}` : NA, "auto-driver"),
  ];
  if (dd.enabled === false)
    return mk("admission", "DRIVER ADMISSION", "upcoming", "driver disabled", e);
  if (match)
    return mk("admission", "DRIVER ADMISSION", "active",
      `admitted · fence ${match.fence}`, e, false,
      `Admission correlates with the current claim (fence ${match.fence}).`);
  if (last)
    return mk("admission", "DRIVER ADMISSION", "proven",
      `last fence ${last.fence}`, e, false,
      "Admissions exist but none correlate with a current claim — historical record only (rule B).");
  return mk("admission", "DRIVER ADMISSION", "upcoming", "none observed", e);
}

function derivePass(i: LoopInputs): LoopNodeState {
  const d = i.driver;
  if (d.kind !== "ready")
    return mk("pass", "OPERATING PASS", "unknown", UNKNOWN_STATUS,
      [absent("driver read", "auto-driver")]);
  const dd = d.data;
  const schedLease = i.scheduler.kind === "ready" ? i.scheduler.data.lease : null;
  const claimedGen = i.scheduler.kind === "ready" ? i.scheduler.data.claimed_generation : null;
  const match = matchingAdmission(dd, schedLease, claimedGen);
  const e: LoopEvidence[] = [
    ev("last_outcome", dd.last_outcome, "auto-driver"),
    ev("last_result.fault", dd.last_result?.fault, "auto-driver"),
    ev("last_fence", dd.last_fence, "auto-driver"),
    ev("denials", dd.denials?.length ?? 0, "auto-driver"),
  ];
  if (match)
    return mk("pass", "OPERATING PASS", "active", "in progress", e, false,
      `Pass admitted at ${fmtTs(match.at)} — usage counters are admission-time snapshots.`);
  if (dd.last_fence !== null && dd.last_fence !== undefined)
    return mk("pass", "OPERATING PASS", "proven", `last fence ${dd.last_fence}`, e, false,
      "A driver pass was recorded earlier — not evidence of a current pass (rule A).");
  return mk("pass", "OPERATING PASS", "upcoming", "none observed", e);
}

function deriveCeo(i: LoopInputs): LoopNodeState {
  const d = i.driver;
  if (d.kind !== "ready")
    return mk("ceo", "CEO DECISION", "unknown", UNKNOWN_STATUS,
      [absent("driver read", "auto-driver")]);
  const dd = d.data;
  const last = dd.admissions?.length ? dd.admissions[dd.admissions.length - 1] : null;
  const ceoCalls = last?.usage?.ceo_calls ?? null;
  const e: LoopEvidence[] = [
    ev("ceo_calls (last admission)", ceoCalls, "auto-driver"),
    ev("admission at", fmtTs(last?.at), "auto-driver"),
    ev("admissions", dd.admissions?.length ?? 0, "auto-driver"),
  ];
  if (ceoCalls !== null && ceoCalls > 0)
    return mk("ceo", "CEO DECISION", "proven", `${ceoCalls} call(s) observed`, e, false,
      "CEO calls were counted at the last admission — historical usage, not a live pass (rule C).");
  if (dd.admissions?.length)
    return mk("ceo", "CEO DECISION", "upcoming", "no ceo calls counted", e);
  return mk("ceo", "CEO DECISION", "upcoming", UNKNOWN_STATUS, e, false,
    "No admission usage observed; CEO substage telemetry is not exposed.");
}

function deriveAlloc(i: LoopInputs): LoopNodeState {
  const c = i.cockpit;
  if (c.kind !== "ready")
    return mk("alloc", "WORKSTREAM ALLOCATION", "unknown", UNKNOWN_STATUS, [
      c.kind === "error"
        ? ev("read error", `HTTP ${c.status ?? "—"} · ${c.code}`, "cockpit", "absent")
        : absent("cockpit read", "cockpit"),
    ]);
  const ws = c.data.workstreams ?? [];
  const allocated = ws.filter(
    (w) => w.allocation_state === "ALLOCATED" || !!w.delegated_child,
  );
  const e: LoopEvidence[] = [
    ev("workstreams", ws.length, "cockpit"),
    ev("allocated", allocated.length, "cockpit"),
    ...allocated.slice(0, 4).map((w) =>
      ev(`ws ${w.workstream_key}`,
        `${w.workstream_status} · ${w.allocation_state}${w.delegated_child ? ` · child ${w.delegated_child.status}` : ""}`,
        "cockpit"),
    ),
  ];
  if (allocated.length)
    return mk("alloc", "WORKSTREAM ALLOCATION", "proven", `${allocated.length} allocated`, e, false,
      "Allocations are durable facts — they do not prove the current pass is running (rule A).");
  if (ws.length)
    return mk("alloc", "WORKSTREAM ALLOCATION", "waiting", `${ws.length} workstream(s) unallocated`, e);
  return mk("alloc", "WORKSTREAM ALLOCATION", "upcoming", "no workstreams", e);
}

function derivePlanner(i: LoopInputs): LoopNodeState {
  const c = i.cockpit;
  if (c.kind !== "ready")
    return mk("planner", "PLANNER", "unknown", UNKNOWN_STATUS,
      [absent("cockpit read", "cockpit")]);
  const ws = c.data.workstreams ?? [];
  const withMission = ws.filter((w) => w.delegated_child?.bound_mission);
  const ready = ws.filter((w) => w.delegated_child && !w.delegated_child.bound_mission);
  const e: LoopEvidence[] = [
    ev("bound plans", withMission.length, "cockpit"),
    ev("delegated children", ws.filter((w) => w.delegated_child).length, "cockpit"),
    absent("planner invocation telemetry", "cockpit"),
  ];
  if (withMission.length)
    return mk("planner", "PLANNER", "proven",
      `${withMission.length} bound mission(s)`, e, false,
      "Bound missions prove a plan committed earlier — planner invocations themselves are not exposed (rule C).");
  if (ready.length)
    return mk("planner", "PLANNER", "waiting", "delegated child awaiting mission", e);
  return mk("planner", "PLANNER", "unknown", UNKNOWN_STATUS, e, false,
    "Planner activity is not observable through owner-scoped reads.");
}

function deriveMission(i: LoopInputs): LoopNodeState {
  const c = i.cockpit;
  if (c.kind !== "ready")
    return mk("mission", "MISSION OPEN", "unknown", UNKNOWN_STATUS,
      [absent("cockpit read", "cockpit")]);
  const ms = c.data.missions ?? [];
  const e: LoopEvidence[] = [
    ev("missions", ms.length, "cockpit"),
    ...ms.slice(0, 4).map((m) =>
      ev(m.mission_id, `${m.status}${m.runtime_state ? ` · ${m.runtime_state}` : ""}`, "cockpit"),
    ),
  ];
  const running = ms.filter((m) => m.status === "RUNNING" || m.runtime_state === "RUNNING");
  const failed = ms.filter((m) => m.status === "FAILED" || m.status === "CANCELLED");
  const completed = ms.filter((m) => m.status === "COMPLETED");
  if (running.length)
    return mk("mission", "MISSION OPEN", "active", `${running.length} running`, e);
  if (failed.length && !completed.length)
    return mk("mission", "MISSION OPEN", "failed", `${failed.length} failed`, e);
  if (completed.length)
    return mk("mission", "MISSION OPEN", "proven", `${completed.length} completed`, e, false,
      "Completed missions are historical evidence — not proof a mission is open now (rule A).");
  if (ms.length)
    return mk("mission", "MISSION OPEN", "waiting", `${ms[0].status}`, e);
  return mk("mission", "MISSION OPEN", "upcoming", "no missions", e);
}

function deriveExec(i: LoopInputs): LoopNodeState {
  const c = i.cockpit;
  if (c.kind !== "ready")
    return mk("exec", "EXECUTION", "unknown", UNKNOWN_STATUS,
      [absent("cockpit read", "cockpit")]);
  const ms = c.data.missions ?? [];
  const running = ms.filter((m) => m.runtime_state === "RUNNING");
  const e: LoopEvidence[] = [
    ev("runtime RUNNING", running.length, "cockpit"),
    ...running.slice(0, 3).map((m) => ev(m.mission_id, m.runtime_state, "cockpit")),
  ];
  if (running.length)
    return mk("exec", "EXECUTION", "active", `${running.length} executing`, e);
  if (ms.length)
    return mk("exec", "EXECUTION", "upcoming", "no active runtime", e, false,
      "A bound/closed mission is not proof the executor is running now (rule C).");
  return mk("exec", "EXECUTION", "upcoming", "none observed", e);
}

function deriveEvidence(i: LoopInputs): LoopNodeState {
  const c = i.cockpit;
  if (c.kind !== "ready")
    return mk("evidence", "ARTIFACTS / EVIDENCE", "unknown", UNKNOWN_STATUS,
      [absent("cockpit read", "cockpit")]);
  const d = c.data;
  if (d.observation_error)
    return mk("evidence", "ARTIFACTS / EVIDENCE", "unknown", "unverified", [
      ev("observation_error", d.observation_error, "cockpit", "absent"),
    ], false,
      "Cockpit observation is unverified — artifact claims are not presented as evidence.");
  const arts = d.artifacts ?? [];
  const verified = arts.filter((a) => a.state === "VERIFIED" || a.state === "ACCEPTED");
  const e: LoopEvidence[] = [
    ev("artifacts", arts.length, "cockpit"),
    ev("verified", verified.length, "cockpit"),
    ev("dropped_unverified", d.artifacts_dropped_unverified, "cockpit"),
    ...verified.slice(0, 3).map((a) =>
      ev(a.logical_name, `${a.state} · ${a.artifact_id}`, "cockpit"),
    ),
  ];
  if (verified.length)
    return mk("evidence", "ARTIFACTS / EVIDENCE", "proven", `${verified.length} verified`, e, false,
      "Verified artifacts are durable history — not evidence the current cycle reached EVIDENCE (rule A).");
  if (arts.length)
    return mk("evidence", "ARTIFACTS / EVIDENCE", "waiting", `${arts.length} unverified`, e);
  return mk("evidence", "ARTIFACTS / EVIDENCE", "upcoming", "none observed", e);
}

function deriveReview(i: LoopInputs): LoopNodeState {
  const c = i.cockpit;
  if (c.kind !== "ready")
    return mk("review", "REVIEW / VERIFICATION", "unknown", UNKNOWN_STATUS,
      [absent("cockpit read", "cockpit")]);
  const d = c.data;
  const r = d.latest_review;
  const e: LoopEvidence[] = [
    ev("latest outcome", r?.outcome, "cockpit"),
    ev("review_count", d.review_count, "cockpit"),
    ev("all_targets_met", d.kpi_summary?.all_targets_met, "cockpit"),
    ev("owner_action_required", d.lifecycle?.owner_action_required, "cockpit"),
  ];
  if (d.lifecycle?.owner_action_required)
    return mk("review", "REVIEW / VERIFICATION", "waiting", "owner action required", e);
  if (r)
    return mk("review", "REVIEW / VERIFICATION", "proven", r.outcome, e, false,
      `review ${r.review_id} · ${fmtTs(r.created_at)}`);
  return mk("review", "REVIEW / VERIFICATION", "upcoming", "no reviews", e);
}

function deriveSettle(i: LoopInputs): LoopNodeState {
  /* Rule D — no owner-scoped field proves per-cycle settlement. */
  const s = i.scheduler;
  const e: LoopEvidence[] = [
    absent("settlement proof", "auto-scheduler"),
  ];
  if (s.kind === "ready") {
    e.push(
      ev("queue_state", s.data.queue_state, "auto-scheduler"),
      ev("catchup_state", s.data.catchup_state, "auto-scheduler"),
    );
  }
  return mk("settle", "SCHEDULER SETTLEMENT", "unknown", "not observable", e, false,
    "Owner-scoped endpoints expose no per-cycle settlement proof — shown unobserved rather than fabricated (rule D).");
}

function deriveContinuation(i: LoopInputs): LoopNodeState {
  const s = i.scheduler;
  if (s.kind !== "ready")
    return mk("continuation", "CONTINUATION", "unknown", UNKNOWN_STATUS,
      [absent("scheduler read", "auto-scheduler")]);
  const d = s.data;
  const e: LoopEvidence[] = [
    ev("next_due", fmtDue(d.next_due, i.nowMs), "auto-scheduler"),
    ev("checkpoint_digest", d.checkpoint_digest, "auto-scheduler"),
    ev("catchup_state", d.catchup_state, "auto-scheduler"),
  ];
  if (d.next_due !== null && d.next_due !== undefined && Number.isFinite(d.next_due))
    return mk("continuation", "CONTINUATION", "waiting", fmtDue(d.next_due, i.nowMs), e, false,
      "Due checkpoint is a scheduler concept — not necessarily the next driver tick (rule G).");
  return mk("continuation", "CONTINUATION", "upcoming", "no checkpoint", e);
}

/* ---------------- conditional branches ---------------- */

function deriveBranches(i: LoopInputs): LoopNodeState[] {
  const s = i.scheduler;
  const d = i.driver;
  const c = i.cockpit;

  // BLOCKED — queue-level block or authority blocker
  let brBlocked: LoopNodeState;
  if (s.kind === "ready" && ((s.data.queue_state ?? "").startsWith("BLOCKED") || s.data.blocked_reason))
    brBlocked = mk("br_blocked", "BLOCKED", "blocked", s.data.blocked_reason ?? s.data.queue_state,
      [ev("queue_state", s.data.queue_state, "auto-scheduler"),
       ev("blocked_reason", s.data.blocked_reason, "auto-scheduler")]);
  else
    brBlocked = mk("br_blocked", "BLOCKED", "upcoming", "not blocked",
      [absent("block evidence", "auto-scheduler")]);

  // WAITING — consumer wait / due checkpoint pending
  let brWaiting: LoopNodeState;
  if (s.kind === "ready" && (s.data.queue_state === "WAITING_CONSUMER" || s.data.wait_kind))
    brWaiting = mk("br_waiting", "WAITING", "waiting", s.data.wait_kind ?? s.data.queue_state,
      [ev("wait_kind", s.data.wait_kind, "auto-scheduler"),
       ev("queue_state", s.data.queue_state, "auto-scheduler"),
       ev("next_due", fmtDue(s.data.next_due, i.nowMs), "auto-scheduler")]);
  else
    brWaiting = mk("br_waiting", "WAITING", "upcoming", "not waiting",
      [absent("wait evidence", "auto-scheduler")]);

  // RETRY / BACKOFF
  let brRetry: LoopNodeState;
  if (s.kind === "ready" && (s.data.retry_count ?? 0) > 0)
    brRetry = mk("br_retry", "RETRY / BACKOFF", "waiting", `retry ${s.data.retry_count}`,
      [ev("retry_count", s.data.retry_count, "auto-scheduler"),
       ev("next_due", fmtDue(s.data.next_due, i.nowMs), "auto-scheduler")]);
  else
    brRetry = mk("br_retry", "RETRY / BACKOFF", "upcoming", "no retries",
      [absent("retry evidence", "auto-scheduler")]);

  // DENIED / FAULT — rule E: fault, denials and outcome are distinct
  let brFault: LoopNodeState;
  if (d.kind === "ready" && (d.data.last_result?.fault || (d.data.denials?.length ?? 0) > 0)) {
    const e: LoopEvidence[] = [
      ev("last_result.fault", d.data.last_result?.fault, "auto-driver"),
      ev("denials", d.data.denials?.length ?? 0, "auto-driver"),
      ev("last_outcome", d.data.last_outcome, "auto-driver"),
    ];
    brFault = mk("br_fault", "DENIED / FAULT", "failed",
      d.data.last_result?.fault ?? `${d.data.denials.length} denial(s)`, e, false,
      "A fresh fault may coexist with an older successful last_outcome (rule E).");
  } else
    brFault = mk("br_fault", "DENIED / FAULT", "upcoming", "no fault",
      [absent("fault evidence", "auto-driver")]);

  // OWNER ACTION REQUIRED — either source may flag it
  const ownerSched = s.kind === "ready" && s.data.owner_action_required === true;
  const ownerCockpit = c.kind === "ready" && c.data.lifecycle?.owner_action_required === true;
  const brOwner = ownerSched || ownerCockpit
    ? mk("br_owner", "OWNER ACTION", "waiting", "action required", [
        ev("scheduler flag", ownerSched, "auto-scheduler"),
        ev("cockpit flag", ownerCockpit, "cockpit"),
      ])
    : mk("br_owner", "OWNER ACTION", "upcoming", "none", [
        absent("owner-action evidence", "auto-scheduler"),
      ]);

  return [brBlocked, brWaiting, brRetry, brFault, brOwner];
}

/* ---------------- snapshot assembly ---------------- */

function mk(
  id: LoopNodeId,
  title: string,
  visual: LoopVisual,
  status: string,
  evidence: LoopEvidence[],
  branch = false,
  detail?: string,
): LoopNodeState {
  return { id, title, visual, status, evidence, branch, detail };
}

const SPINE: LoopNodeId[] = [
  "policy", "wake", "scheduler", "claim", "admission", "pass", "ceo",
  "alloc", "planner", "mission", "exec", "evidence", "review", "settle",
  "continuation",
];

const BRANCH_ATTACH: Record<string, LoopNodeId> = {
  br_blocked: "scheduler",
  br_waiting: "scheduler",
  br_retry: "scheduler",
  br_fault: "admission",
  br_owner: "scheduler",
};

export function deriveLoopSnapshot(i: LoopInputs): LoopSnapshot {
  /* Identity guard — a read for a different objective is an error, not
     data (route/business switch safety). */
  const badId = (kind: string): EpRead<never> => epError(null, `IDENTITY_MISMATCH_${kind}`);
  const ck: EpRead<CockpitPayload> =
    i.cockpit.kind === "ready" && i.cockpit.data.objective.objective_id !== i.objectiveId
      ? badId("COCKPIT") : i.cockpit;
  const sc: EpRead<AutoSchedulerStatus> =
    i.scheduler.kind === "ready" && i.scheduler.data.objective_id !== i.objectiveId
      ? badId("SCHEDULER") : i.scheduler;
  const dr: EpRead<AutoDriverStatus> =
    i.driver.kind === "ready" && i.driver.data.objective_id !== i.objectiveId
      ? badId("DRIVER") : i.driver;
  const po: EpRead<AutoPolicyStatus> =
    i.policy.kind === "ready" && i.policy.data.objective_id !== i.objectiveId
      ? badId("POLICY") : i.policy;
  const j: LoopInputs = { ...i, cockpit: ck, scheduler: sc, driver: dr, policy: po };

  const nodes: LoopNodeState[] = [
    derivePolicy(j),
    deriveWake(j),
    deriveScheduler(j),
    deriveClaim(j),
    deriveAdmission(j),
    derivePass(j),
    deriveCeo(j),
    deriveAlloc(j),
    derivePlanner(j),
    deriveMission(j),
    deriveExec(j),
    deriveEvidence(j),
    deriveReview(j),
    deriveSettle(j),
    deriveContinuation(j),
    ...deriveBranches(j),
  ];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const at = (id: LoopNodeId) => byId.get(id)!;
  const edges: LoopEdge[] = [];
  for (let k = 0; k < SPINE.length - 1; k++) {
    const to = at(SPINE[k + 1]);
    edges.push({
      from: SPINE[k],
      to: SPINE[k + 1],
      kind: "spine",
      active: to.visual === "active",
    });
  }
  edges.push({
    from: "continuation",
    to: "wake",
    kind: "loop",
    active: at("continuation").visual === "active" || at("wake").visual === "active",
  });
  for (const [br, src] of Object.entries(BRANCH_ATTACH)) {
    const n = at(br as LoopNodeId);
    edges.push({
      from: src,
      to: br as LoopNodeId,
      kind: "branch",
      active: n.visual === "blocked" || n.visual === "waiting" || n.visual === "failed",
    });
  }

  /* headline — most significant observed condition wins. */
  const activeN = nodes.filter((n) => n.visual === "active").length;
  const badN = nodes.filter((n) => n.visual === "blocked" || n.visual === "failed");
  const unknownN = nodes.filter((n) => n.visual === "unknown").length;
  const waitingN = nodes.filter((n) => n.visual === "waiting").length;
  const obsErr = ck.kind === "ready" ? ck.data.observation_error : null;
  let headline: LoopSnapshot["headline"];
  if (badN.length)
    headline = {
      visual: badN.some((n) => n.visual === "blocked") ? "blocked" : "failed",
      label: badN[0].status,
      detail: badN[0].title,
    };
  else if (activeN)
    headline = { visual: "active", label: `${activeN} node(s) active`, detail: at(
      (nodes.find((n) => n.visual === "active"))!.id).status };
  else if (waitingN)
    headline = { visual: "waiting", label: "waiting", detail:
      nodes.find((n) => n.visual === "waiting")?.status };
  else if (unknownN >= SPINE.length - 2)
    headline = { visual: "unknown", label: "observation unavailable" };
  else
    headline = { visual: "upcoming", label: "idle — no observed activity" };

  const freshness: LoopFreshness[] = (
    [
      ["cockpit", ck],
      ["auto-policy", po],
      ["auto-scheduler", sc],
      ["auto-driver", dr],
    ] as [LoopSource, EpRead<unknown>][]
  ).map(([source, r]) =>
    r.kind === "ready"
      ? { source, state: "ok" as const, atMs: r.atMs }
      : r.kind === "error"
        ? { source, state: "error" as const, atMs: null,
            note: r.status === null ? r.code : `HTTP ${r.status} · ${r.code}` }
        : { source, state: "missing" as const, atMs: null },
  );

  return {
    nodes,
    edges,
    headline,
    freshness,
    observationVerified: obsErr === null || obsErr === undefined,
    observationError: obsErr ?? null,
  };
}

/* Inspector view-model for a clicked node — keeps detail consistent
   with the displayed snapshot. */
export function nodeInspector(
  snap: LoopSnapshot,
  id: LoopNodeId,
): LoopNodeState | null {
  return snap.nodes.find((n) => n.id === id) ?? null;
}
