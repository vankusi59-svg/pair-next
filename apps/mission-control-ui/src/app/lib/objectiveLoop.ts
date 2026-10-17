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
  /* R3-F2 — durable history, NOT a current-cycle condition. Historical
     nodes may keep their diagnostic colour but never drive the
     aggregate headline or an active edge. */
  historical?: boolean;
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
  /* R1-F3 — a pending wake is proven ONLY by generation semantics:
     pending_generation ahead of claimed_generation = unconsumed work.
     pending_reasons are descriptive metadata that can persist after
     the generation was claimed — never independent proof of a live
     wake. */
  const pendGen = d.pending_generation ?? null;
  const claimGen = d.claimed_generation ?? null;
  const unconsumed =
    pendGen !== null && (claimGen === null || pendGen > claimGen);
  const blocked =
    (d.queue_state ?? "").startsWith("BLOCKED") || d.queue_state === "QUARANTINED";
  if (unconsumed && blocked)
    return mk("wake", "DURABLE WAKE", "waiting", `gen ${pendGen} pending — queue blocked`, e, false,
      "Unconsumed wake generation exists but the queue is blocked — not healthy execution.");
  if (unconsumed)
    return mk("wake", "DURABLE WAKE", "active", `wake pending · gen ${pendGen}`, e, false,
      "A durable wake generation is pending consumption.");
  if (claimGen !== null && claimGen > 0)
    return mk("wake", "DURABLE WAKE", "proven", "consumed", e, false,
      "The recorded wake generation was already claimed — reasons below are historical, not a live wake.");
  if ((d.pending_reasons ?? []).length > 0)
    return mk("wake", "DURABLE WAKE", "unknown", "unverified wake", e, false,
      "Wake reasons exist without generation authority — descriptive only, no actionable wake proven.");
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
    ev("lease", d.lease ? `${d.lease.state} · fence ${d.lease.fence}` : "none",
      "auto-scheduler"),
  ];
  if (d.scheduler_ready === false)
    return mk("scheduler", "SCHEDULER", "failed", "not ready", e);
  const q = d.queue_state ?? "";
  /* R1-F4 / R2-F3 — presentation must reconcile queue AND lease: a
     queue WAITING_CONSUMER while a confirmed lease is held means the
     queue awaits the next consumer cycle, not that nothing is claimed.
     An active-state lease without a valid future expiry is explicitly
     unverified — never narrated as "lease held". */
  const leaseHeld = leaseConfirmedActive(d.lease, i.nowMs);
  const leaseUnverified =
    leaseActive(d.lease) && !leaseHeld ? leaseExpiryVerdict(d.lease, i.nowMs) : null;
  if (q === "UNREGISTERED")
    return mk("scheduler", "SCHEDULER", "upcoming", "unregistered", e);
  if (q.startsWith("BLOCKED") || q === "QUARANTINED")
    return mk("scheduler", "SCHEDULER", "blocked", q, e, false,
      d.blocked_reason ?? (q === "QUARANTINED" ? "quarantined" : undefined));
  if (q === "CLAIMED" || q === "EXECUTING" || q === "IN_PROGRESS")
    return mk("scheduler", "SCHEDULER", "active", q, e);
  if (q === "WAITING_CONSUMER" && leaseHeld)
    return mk("scheduler", "SCHEDULER", "waiting",
      `WAITING_CONSUMER · lease held fence ${d.lease!.fence}`, e, false,
      "Queue waits for the next consumer while a claim is in flight — distinct states, both observed.");
  if (q === "WAITING_CONSUMER" && leaseUnverified)
    return mk("scheduler", "SCHEDULER", "waiting",
      `WAITING_CONSUMER · lease unverified (${leaseUnverified === "expired" ? "expiry observed" : "expiry unconfirmed"})`, e, false,
      "Queue waits for a consumer; the active-state lease lacks a valid future expiry — not presented as held.");
  if (q === "WAITING_CONSUMER" || q === "WAITING" || q === "WAITING_EVIDENCE" || q === "IDLE")
    return mk("scheduler", "SCHEDULER", "waiting", q, e);
  return mk("scheduler", "SCHEDULER", "waiting", q || UNKNOWN_STATUS, e);
}

/* R1-F6 / R2-F3 — lease expiry arrives as server epoch ms (or null);
   compare numerically. The check is observational — the browser clock
   only reports what it saw, never authority. R2-F3: an ACTIVE-state
   lease WITHOUT a valid future expiry is never presented as a
   confirmed current claim. */
type LeaseShape = {
  state: string;
  fence: number | null;
  expires_at: number | string | null;
} | null;

function leaseActive(l: LeaseShape): boolean {
  return !!l && (l.state === "ACTIVE" || l.state === "CLAIMED" || l.state === "HELD");
}

type LeaseExpiry = "none" | "invalid" | "future" | "expired";

/* Classification of the expiry field alone, independent of lease
   state: none = field absent; invalid = present but unparseable or
   non-positive epoch ms (NaN, Infinity, <= 0); future/expired = valid
   epoch compared against the observation clock. */
function leaseExpiryVerdict(l: LeaseShape, nowMs: number): LeaseExpiry {
  if (!l || l.expires_at === null || l.expires_at === undefined) return "none";
  const ms =
    typeof l.expires_at === "number"
      ? l.expires_at
      : Date.parse(String(l.expires_at));
  if (!Number.isFinite(ms) || ms <= 0) return "invalid";
  return ms > nowMs ? "future" : "expired";
}

/* Confirmed-current claim requires ALL of: recognized active state,
   valid finite epoch-ms expiry, expiry strictly after nowMs. */
function leaseConfirmedActive(l: LeaseShape, nowMs: number): boolean {
  return leaseActive(l) && leaseExpiryVerdict(l, nowMs) === "future";
}

/* R2-F1 — the scheduler lease and the driver lease are independent
   reads, not one atomic snapshot. A material divergence (different
   fence, or active-state vs terminal-state split) means current
   admission cannot be verified — but it is an OBSERVATION_INCONSISTENT
   condition (benign mid-transition reads included), not a canonical
   integrity fault. */
function leaseObservationConflict(a: LeaseShape, b: LeaseShape): string | null {
  if (!a || !b) return null;
  const bits: string[] = [];
  if (a.fence !== null && b.fence !== null && a.fence !== b.fence)
    bits.push(`fence ${a.fence} vs ${b.fence}`);
  if (leaseActive(a) !== leaseActive(b))
    bits.push(`state ${a.state} vs ${b.state}`);
  return bits.length ? bits.join(" · ") : null;
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
  /* R2-F3 — an active-state lease claims current ownership ONLY with a
     valid future epoch expiry. Absent/invalid expiry → unverified, not
     active. This is observational confidence, never server-side proof. */
  if (leaseActive(l)) {
    const x = leaseExpiryVerdict(l, i.nowMs);
    if (x === "future")
      return mk("claim", "CLAIM / LEASE", "active", `claimed · fence ${l.fence ?? "?"}`, e, false,
        "Active scheduler claim — this alone does NOT prove driver admission (rule B).");
    if (x === "expired")
      return mk("claim", "CLAIM / LEASE", "waiting", "lease expiry observed", e, false,
        "Server lease expiry precedes the observation clock — current ownership unconfirmed (observational check).");
    return mk("claim", "CLAIM / LEASE", "unknown", "unverified lease", e, false,
      x === "invalid"
        ? "Lease state is active but expires_at is not a valid positive epoch-ms timestamp — current ownership unverified."
        : "Lease state is active but carries no expiry — current ownership unverified (observational).");
  }
  if (l.state === "EXPIRED" || l.state === "INVALIDATED")
    return mk("claim", "CLAIM / LEASE", "waiting", `lease ${l.state.toLowerCase()}`, e);
  if (l.state === "SETTLED")
    return mk("claim", "CLAIM / LEASE", "upcoming", `settled · fence ${l.fence ?? "—"}`, e, false,
      "Settled lease — the claim cycle is over; not an active claim.");
  return mk("claim", "CLAIM / LEASE", "upcoming", `${String(l.state).toLowerCase()} · fence ${l.fence ?? "—"}`, e);
}

/* R1-F1 — admission/claim correlation. An admission is "correlated"
   ONLY when the scheduler lease is currently held (and not observed
   expired) AND the admission carries the same fence AND the same
   generation as the scheduler's claimed generation. A generation that
   contradicts the claimed generation means the record belongs to an
   earlier cycle — it is historical, never a fence-only fallback. */
export type AdmissionVerdict =
  | "correlated"   // exact fence+generation under a live claim
  | "historical"   // admission exists but the claim cycle is over
  | "contradicted" // fence matches, generation does not
  | "inconsistent" // scheduler vs driver lease observations materially conflict
  | "unverifiable" // correlation inputs missing — not confirmable
  | "none";        // no admission record for this fence

export interface AdmissionCorrelation {
  verdict: AdmissionVerdict;
  admission: AutoDriverStatus["admissions"][number] | null;
  reason: string;
}

export function correlateAdmission(
  driver: AutoDriverStatus,
  lease: LeaseShape,
  claimedGeneration: number | null,
  nowMs: number,
): AdmissionCorrelation {
  if (!lease || lease.fence === null || lease.fence === undefined) {
    /* R2-F1 — the driver read reporting its own lease while the
       scheduler reports none is a material divergence of independent
       observations: unverifiable, never silently "no admission". */
    if (driver.lease && driver.lease.fence !== null && driver.lease.fence !== undefined)
      return {
        verdict: "inconsistent",
        admission: null,
        reason: "OBSERVATION_INCONSISTENT — driver reports a lease the scheduler does not; independent reads, not an integrity fault",
      };
    return { verdict: "none", admission: null, reason: "no claim fence to correlate" };
  }
  const sameFence = (driver.admissions ?? []).filter((a) => a.fence === lease.fence);
  if (!leaseActive(lease))
    /* A terminal scheduler lease means no current claim can be
       asserted regardless of what the (possibly lagging) driver read
       reports — matching records stay historical. */
    return {
      verdict: sameFence.length ? "historical" : "none",
      admission: sameFence[sameFence.length - 1] ?? null,
      reason: `lease ${lease.state} — matching records are a previous cycle, not current work`,
    };
  /* R2-F1 — the two lease observations are independent reads. While
     the scheduler claims a live lease, a material divergence in the
     driver read makes current admission unverifiable: reported as
     OBSERVATION_INCONSISTENT (possibly a benign mid-transition pair of
     reads), never as corruption. */
  const conflict = leaseObservationConflict(lease, driver.lease ?? null);
  if (conflict)
    return {
      verdict: "inconsistent",
      admission: sameFence[sameFence.length - 1] ?? null,
      reason: `OBSERVATION_INCONSISTENT — scheduler vs driver lease (${conflict}); independent reads, not an integrity fault`,
    };
  /* R2-F3 — an active-state lease still needs a valid future expiry
     before any current-cycle admission can be correlated. */
  const x = leaseExpiryVerdict(lease, nowMs);
  if (x !== "future")
    return {
      verdict: "unverifiable",
      admission: sameFence[sameFence.length - 1] ?? null,
      reason: x === "expired"
        ? "lease expiry precedes the observation clock — current ownership unconfirmed"
        : x === "invalid"
          ? "lease expires_at is not a valid epoch-ms timestamp — current ownership unverified"
          : "active-state lease carries no expiry — current ownership unverified",
    };
  const hasGen = claimedGeneration !== null && claimedGeneration !== undefined;
  if (hasGen) {
    const exact = sameFence.find((a) => a.generation === claimedGeneration);
    if (exact)
      return {
        verdict: "correlated",
        admission: exact,
        reason: `exact correlation — fence ${lease.fence} · generation ${claimedGeneration}`,
      };
    if (sameFence.length)
      return {
        verdict: "contradicted",
        admission: sameFence[sameFence.length - 1],
        reason: `fence ${lease.fence} records carry different generation(s) — earlier cycle, not current`,
      };
    return { verdict: "none", admission: null, reason: "claim held — no admission record for this fence" };
  }
  if (sameFence.length)
    return {
      verdict: "unverifiable",
      admission: sameFence[sameFence.length - 1],
      reason: "admission record exists but generation correlation inputs are missing",
    };
  return { verdict: "none", admission: null, reason: "claim held — no admission record for this fence" };
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
  const corr = correlateAdmission(dd, schedLease, claimedGen, i.nowMs);
  const last = dd.admissions?.length ? dd.admissions[dd.admissions.length - 1] : null;
  /* R2-F1 — both lease observations are shown separately so a material
     divergence stays diagnosable instead of being merged silently. */
  const e: LoopEvidence[] = [
    ev("driver enabled", dd.enabled, "auto-driver"),
    ev("admissions", dd.admissions?.length ?? 0, "auto-driver"),
    ev("last_fence", dd.last_fence, "auto-driver"),
    ev("correlation", corr.verdict, "auto-driver", "derived"),
    ev("matched admission",
      corr.admission ? `fence ${corr.admission.fence} · gen ${corr.admission.generation}` : NA,
      "auto-driver", "derived"),
    ev("claimed_generation", claimedGen, "auto-scheduler"),
    ev("scheduler lease",
      schedLease ? `${schedLease.state} · fence ${schedLease.fence}` : "none", "auto-scheduler"),
    ev("driver lease",
      dd.lease ? `${dd.lease.state} · fence ${dd.lease.fence}` : "none", "auto-driver"),
  ];
  if (dd.enabled === false)
    return mk("admission", "DRIVER ADMISSION", "upcoming", "driver disabled", e);
  if (corr.verdict === "correlated")
    return mk("admission", "DRIVER ADMISSION", "active",
      `admitted · fence ${corr.admission!.fence}`, e, false, corr.reason);
  if (corr.verdict === "unverifiable")
    return mk("admission", "DRIVER ADMISSION", "unknown", "unverified", e, false, corr.reason);
  /* R2-F1 — contradicted and inconsistent are NOT verified history:
     fence matched but generation/lease observations disagree. Render
     UNKNOWN / INCONSISTENT with the conflicting values retained. */
  if (corr.verdict === "contradicted" || corr.verdict === "inconsistent")
    return mk("admission", "DRIVER ADMISSION", "unknown",
      "UNKNOWN / INCONSISTENT", e, false, corr.reason);
  if (corr.verdict === "historical")
    return mk("admission", "DRIVER ADMISSION", "proven",
      `historical · fence ${corr.admission?.fence ?? "—"}`, e, false, corr.reason);
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
  const corr = correlateAdmission(dd, schedLease, claimedGen, i.nowMs);
  const e: LoopEvidence[] = [
    ev("last_outcome", dd.last_outcome, "auto-driver"),
    ev("last_result.fault", dd.last_result?.fault, "auto-driver"),
    ev("last_fence", dd.last_fence, "auto-driver"),
    ev("denials", dd.denials?.length ?? 0, "auto-driver"),
    ev("correlation", corr.verdict, "auto-driver", "derived"),
  ];
  /* R1-F1 — an admission record alone cannot prove a pass is running;
     admit and execute are distinct phases. R2-F1 — a contradicted or
     inconsistent admission correlation produces NO pass inference at
     all, not even a historical-looking one. */
  if (corr.verdict === "correlated")
    return mk("pass", "OPERATING PASS", "waiting", "ADMITTED / PASS STATUS UNKNOWN", e, false,
      `Admission correlated at ${fmtTs(corr.admission!.at)} — pass execution itself is not observable through these reads.`);
  if (corr.verdict === "contradicted" || corr.verdict === "inconsistent")
    return mk("pass", "OPERATING PASS", "unknown", "unverified", e, false, corr.reason);
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
    return mk("mission", "MISSION OPEN", "failed", `${failed.length} failed`, e, false,
      "Recorded mission terminal status — a cockpit observation of mission records.");
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
  /* R1-F5 — every conditional node carries branch=true so the
     hide-inactive-branches toggle can reliably filter them. */
  const B = true;

  // BLOCKED — queue-level block or authority blocker
  let brBlocked: LoopNodeState;
  if (s.kind === "ready" && ((s.data.queue_state ?? "").startsWith("BLOCKED") || s.data.queue_state === "QUARANTINED" || s.data.blocked_reason))
    brBlocked = mk("br_blocked", "BLOCKED", "blocked", s.data.blocked_reason ?? s.data.queue_state,
      [ev("queue_state", s.data.queue_state, "auto-scheduler"),
       ev("blocked_reason", s.data.blocked_reason, "auto-scheduler")], B);
  else
    brBlocked = mk("br_blocked", "BLOCKED", "upcoming", "not blocked",
      [absent("block evidence", "auto-scheduler")], B);

  // WAITING — consumer wait / due checkpoint pending
  let brWaiting: LoopNodeState;
  if (s.kind === "ready" && (s.data.queue_state === "WAITING_CONSUMER" || s.data.queue_state === "WAITING_EVIDENCE" || s.data.wait_kind))
    brWaiting = mk("br_waiting", "WAITING", "waiting", s.data.wait_kind ?? s.data.queue_state,
      [ev("wait_kind", s.data.wait_kind, "auto-scheduler"),
       ev("queue_state", s.data.queue_state, "auto-scheduler"),
       ev("next_due", fmtDue(s.data.next_due, i.nowMs), "auto-scheduler")], B);
  else
    brWaiting = mk("br_waiting", "WAITING", "upcoming", "not waiting",
      [absent("wait evidence", "auto-scheduler")], B);

  // RETRY / BACKOFF
  let brRetry: LoopNodeState;
  if (s.kind === "ready" && (s.data.retry_count ?? 0) > 0)
    brRetry = mk("br_retry", "RETRY / BACKOFF", "waiting", `retry ${s.data.retry_count}`,
      [ev("retry_count", s.data.retry_count, "auto-scheduler"),
       ev("next_due", fmtDue(s.data.next_due, i.nowMs), "auto-scheduler")], B);
  else
    brRetry = mk("br_retry", "RETRY / BACKOFF", "upcoming", "no retries",
      [absent("retry evidence", "auto-scheduler")], B);

  // DENIED / FAULT — rule E + R3-F2: three distinct concepts —
  //   (a) a fault correlated to the CURRENT claim fence → current
  //       failure, prominent and headline-driving;
  //   (b) a recorded fault without current-fence correlation →
  //       "latest recorded fault", red but explicitly historical —
  //       never drives the headline as a current failure;
  //   (c) denials alone are bounded admission history → neutral
  //       "past denials" diagnostic, never a current FAILED.
  let brFault: LoopNodeState;
  const dd = d.kind === "ready" ? d.data : null;
  const faultCode = dd?.last_result?.fault ?? null;
  const denialCount = dd?.denials?.length ?? 0;
  if (faultCode && dd) {
    const schedLease = s.kind === "ready" ? s.data.lease : null;
    const claimFence =
      leaseConfirmedActive(schedLease, i.nowMs) ? schedLease!.fence : null;
    /* Currency is provable only when a confirmed live claim exists AND
       the faulted pass fence equals it. last_fence null, a different
       fence, or no live claim → ambiguous → historical (never assume
       the fault belongs to the current cycle). */
    const current = claimFence !== null && dd.last_fence === claimFence;
    const e: LoopEvidence[] = [
      ev("last_result.fault", faultCode, "auto-driver"),
      ev("last_fence", dd.last_fence, "auto-driver"),
      ev("current claim fence", claimFence, "auto-scheduler"),
      ev("denials", denialCount, "auto-driver"),
      ev("last_outcome", dd.last_outcome, "auto-driver"),
    ];
    brFault = mk("br_fault", "DENIED / FAULT", "failed",
      current ? faultCode : `${faultCode} · prior cycle`, e, B,
      current
        ? "Fault recorded on the fence matching the current confirmed claim (rule E)."
        : "Latest recorded fault — no current-cycle fence correlation; a fresh fault may coexist with an older successful last_outcome (rule E).");
    if (!current) brFault.historical = true;
  } else if (denialCount > 0) {
    brFault = mk("br_fault", "DENIED / FAULT", "upcoming",
      `${denialCount} past denial(s) · historical`,
      [
        ev("denials", denialCount, "auto-driver"),
        ev("last_result.fault", null, "auto-driver"),
        ev("last_outcome", dd?.last_outcome ?? null, "auto-driver"),
      ], B,
      "Denial records are bounded admission history — without a recorded fault they are a diagnostic, not a current failure (rule E).");
    brFault.historical = true;
  } else
    brFault = mk("br_fault", "DENIED / FAULT", "upcoming", "no fault",
      [absent("fault evidence", "auto-driver")], B);

  // OWNER ACTION REQUIRED — either source may flag it. R2-F2: the
  // cockpit flag is a cockpit-derived claim — when cockpit observation
  // integrity failed it is unverified evidence, not a verified
  // action-required condition. The scheduler flag is independently
  // verified and is never downgraded by cockpit state.
  const obsBad =
    c.kind === "ready" && c.data.observation_error !== null && c.data.observation_error !== undefined;
  const ownerSched = s.kind === "ready" && s.data.owner_action_required === true;
  const ownerCockpitRaw = c.kind === "ready" && c.data.lifecycle?.owner_action_required === true;
  const ownerCockpit = ownerCockpitRaw && !obsBad;
  let brOwner: LoopNodeState;
  if (ownerSched || ownerCockpit)
    brOwner = mk("br_owner", "OWNER ACTION", "waiting",
      `action required · ${[ownerSched ? "scheduler" : null, ownerCockpit ? "cockpit" : null].filter(Boolean).join(" + ")}`,
      [
        ev("scheduler flag", ownerSched, "auto-scheduler"),
        ev("cockpit flag", ownerCockpit, "cockpit"),
        ...(ownerCockpitRaw && obsBad
          ? [ev("cockpit flag (raw, unverified)", true, "cockpit", "absent"),
             ev("observation_error", c.kind === "ready" ? c.data.observation_error : null, "cockpit", "absent")]
          : []),
      ], B);
  else if (ownerCockpitRaw && obsBad)
    brOwner = mk("br_owner", "OWNER ACTION", "unknown", "unverified", [
      ev("scheduler flag", ownerSched, "auto-scheduler"),
      ev("cockpit flag (raw, unverified)", true, "cockpit", "absent"),
      ev("observation_error", c.kind === "ready" ? c.data.observation_error : null, "cockpit", "absent"),
    ], B,
      "Cockpit reports owner action but its observation failed integrity — shown unverified, not action-required.");
  else
    brOwner = mk("br_owner", "OWNER ACTION", "upcoming", "none", [
      absent("owner-action evidence", "auto-scheduler"),
    ], B);

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

/* Nodes whose positive/progress claims derive from the cockpit read —
   all of them fall under observation-integrity gating (R1-F2). */
const COCKPIT_CLAIM_NODES = new Set<LoopNodeId>([
  "alloc", "planner", "mission", "exec", "evidence", "review",
]);

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

  /* R1-F2 / R3-F1 — cockpit observation-integrity gating. When the
     canonical observation reports an integrity error, EVERY
     cockpit-derived operational assertion is downgraded to
     unverified — positive (proven/active/waiting) AND negative
     (failed/blocked). An unverified read cannot claim the mission
     FAILED any more than it can claim it RUNNING. Scheduler/driver/
     policy observations come from their own endpoints and remain
     independently valid. The raw claims stay in each node's evidence
     as explicitly unverified cockpit data. */
  const obsErr = ck.kind === "ready" ? ck.data.observation_error : null;
  const obsBad = obsErr !== null && obsErr !== undefined;
  if (obsBad) {
    for (const n of nodes) {
      if (!COCKPIT_CLAIM_NODES.has(n.id)) continue;
      if (n.visual !== "upcoming" && n.visual !== "unknown") {
        n.visual = "unknown";
        n.status = "unverified";
        n.detail =
          "Cockpit observation integrity failed — this claim is shown as unverified, never as evidence.";
        n.evidence = [
          ev("observation_error", obsErr, "cockpit", "absent"),
          ...n.evidence,
        ];
      }
    }
  }

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
      /* R3-F2 — historical diagnostic nodes never get an active edge */
      active: !n.historical &&
        (n.visual === "blocked" || n.visual === "waiting" || n.visual === "failed"),
    });
  }

  /* headline — most significant observed condition wins; an integrity
     failure is surfaced alongside whatever the independent endpoints
     still prove, never used to claim verified execution. R3-F2:
     historical nodes keep their diagnostic colour but never drive
     the headline as a current failure. */
  const activeN = nodes.filter((n) => n.visual === "active").length;
  const badN = nodes.filter(
    (n) => !n.historical && (n.visual === "blocked" || n.visual === "failed"));
  const unknownN = nodes.filter((n) => n.visual === "unknown").length;
  const waitingN = nodes.filter((n) => n.visual === "waiting").length;
  const obsNote = obsBad ? " · cockpit claims unverified" : "";
  let headline: LoopSnapshot["headline"];
  if (badN.length)
    headline = {
      visual: badN.some((n) => n.visual === "blocked") ? "blocked" : "failed",
      label: badN[0].status,
      detail: badN[0].title + obsNote,
    };
  else if (activeN)
    headline = { visual: "active", label: `${activeN} node(s) active`, detail: at(
      (nodes.find((n) => n.visual === "active"))!.id).status + obsNote };
  else if (waitingN)
    headline = { visual: "waiting", label: "waiting", detail:
      (nodes.find((n) => n.visual === "waiting")?.status ?? "") + obsNote };
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
