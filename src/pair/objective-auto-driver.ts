/**
 * P15.10-C — the governed AUTONOMOUS OBJECTIVE DRIVER.
 *
 * Closes the P15.10-B RECONCILE_ONLY gap. The driver is a bounded
 * consumer over the EXISTING durable authority chain:
 *
 *   canonical event → auto-wakeup intake → WAKE_STATE pending
 *     → fair scheduler claim (lease + fence, CAS, authority rebind)
 *       → THIS driver: delegated admission (policy effective +
 *         caps + cost bound + global halt) → runObjectivePass
 *           (existing P15.6 controller, owner-delegated actor)
 *             → scheduler.settle(outcome) → outcomeContinuation.
 *
 * AUTHORITY MODEL:
 *  - The ONLY authorization is the owner's own `objective_auto_policy`
 *    row in state ENABLED whose live `evaluate()` re-proves binding +
 *    terms + expiry + objective/business lifecycle. A stored ENABLED
 *    row is re-proven at every boundary; nothing is trusted from
 *    memory or from a previous pass.
 *  - The driver acts as `DRIVER_ACTOR` — a distinct delegated
 *    identity recorded as `operator:objective-auto-driver` provenance
 *    on every downstream authority write. It never impersonates the
 *    owner: "no fake owner strings".
 *  - Revalidation points: claim (inside scheduler.claim), admission
 *    (evaluate + caps + halt atomically under CAS), inside the pass
 *    via `authority_gate` (before the CEO model call, each review
 *    commit, allocation, openWorkItem, delegated-child reconcile),
 *    and settlement (currentLease + requireCurrent re-prove again).
 *
 * COST MODEL:
 *  - Usage is DERIVED from canonical evidence at every admission —
 *    never from mutable counters: driver-attributed CEO attempts
 *    (started_by), driver-opened work bindings (created_by), and
 *    P13 cost_reservation microusd attributed through the
 *    mission → bound_open → work_item → allocation → objective
 *    lineage.
 *  - A pass can consume at most ONE runCycle (≤
 *    CEO_MAX_ATTEMPTS_PER_OBSERVATION attempts) and at most ONE new
 *    mission dispatch. Admission reserves exactly those bounds under
 *    an atomic check-and-write; unknown or unprovable monetary cost
 *    never silently becomes zero — the pass is denied with
 *    COST_BINDING_UNVERIFIED.
 *  - Global cost halt (PAIR_COST_HALT=1 or the runtime halt file)
 *    blocks every new autonomous cost action.
 */

import { utcnow } from "./canonical.js";
import { IntegrityError, NotFoundError } from "./errors.js";
import { DriverDenial, type DriverFaultLabel } from "./objective-driver-fault.js";
import type { ObjectiveCapabilityGapService } from "./objective-capability-gap.js";
import { isSqliteContentionError } from "./store.js";
import type { PairEvidenceStore } from "./store.js";
import type { ObjectiveAuthorityService } from "./objective-authority.js";
import type { ObjectiveAutoPolicyService } from "./objective-auto-policy.js";
import {
  LEASE_MAX_LIFETIME_CAP_MS,
  LEASE_STATE,
  SCHEDULER_CURSOR,
  SCHEDULER_RECEIPT,
  WAKE_STATE,
  faultCode,
  readSchedulerRow,
  sanitizeFaultReason,
  writeSchedulerRow,
} from "./objective-auto-scheduler.js";
import type {
  LeaseHandle,
  ObjectiveAutoScheduler,
} from "./objective-auto-scheduler.js";
import type { OperatingPassResult } from "./objective-operating-loop.js";
import { CEO_DECISION_ATTEMPT_ENTITY, CEO_MAX_ATTEMPTS_PER_OBSERVATION } from "./ceo-planning-cycle.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { REJECTED_ROUTE_HEALTH } from "./route-registry.js";
import { providerEntryId } from "./provider-catalog.js";
import {
  CODEX_CLI_PROVIDER_ID,
  codexChatgptSessionProven,
} from "./codex-cli-transport.js";
import { CODEX_EXECUTOR_ID } from "./codex-adapter.js";
import {
  WORKFORCE_ALLOCATION_ENTITY,
  assertCanonicalWorkforceAllocationProvenance,
} from "./workforce-allocation-evidence.js";

import { DRIVER_ACTOR } from "./work-open-binding.js";
export { DRIVER_ACTOR };
export const DRIVER_STATE = "objective_auto_driver_state";
export const DRIVER_SCHEMA = "pair.os.vnext.objective-auto-driver.v1";
/** How many passes one driver tick may drain; bounded so a tick always
 *  finishes and fairness (persisted rank order) is visited every pass. */
export const DRIVER_MAX_PASSES_PER_TICK = 4;
/** P15.10-C R1: lease heartbeat cadence — renew every 20s against the
 *  fixed 60s lease TTL so an awaited pass (CEO model call up to the
 *  configured 900s bound) keeps its exclusive authority. */
export const DRIVER_HEARTBEAT_MS = 20_000;
/** P15.10-C R1: bounded finalization allowance added to the CEO timeout
 *  when binding lease max_lifetime at claim — covers settle/commit
 *  work after the model resolves, never an unconditional TTL raise. */
export const DRIVER_FINALIZATION_ALLOWANCE_MS = 60_000;
/** P15.10-C R1: sane bounds for an injected CEO timeout — mirrors
 *  PAIR_CEO_CLI_TIMEOUT_MS validation (5000..900000). */
const CEO_TIMEOUT_MIN_MS = 5_000;
const CEO_TIMEOUT_MAX_MS = 900_000;
/** Bounded history kept in the durable driver state row. */
const HISTORY_LIMIT = 32;

type Row = Record<string, unknown> & { version: number };

/* Public DriverDenial API retained; class lives in the shared module. */
export { DriverDenial, DRIVER_FAULT_LABELS } from "./objective-driver-fault.js";
export type { DriverFaultLabel } from "./objective-driver-fault.js";

function invalid(reason: string): never {
  throw new IntegrityError("FAIL_CLOSED_OBJECTIVE_AUTO_DRIVER", reason);
}

function fields(row: Row): Row {
  const { version, entity_type: _type, entity_id: _id, ...rest } = row;
  return { ...rest, version };
}

/** Canonically-derived usage for one objective — recomputed from
 *  durable evidence at every admission; nothing is trusted from a
 *  stored total. */
export interface DriverUsage {
  /** Driver-attributed CEO attempts (each STARTED attempt = a real
   *  model invocation — counted conservatively even if it failed). */
  ceo_calls: number;
  /** Driver-attributed bound missions (work_open_binding created_by
   *  the driver actor AND pinned inside an objective allocation). */
  missions: number;
  mission_ids: string[];
  /** Σ microusd over attributed cost_reservations: HELD/COMMITTED count
   *  at reserved max, SETTLED at actual — in-flight liability counts. */
  microusd: number;
  /** An attributed reservation whose monetary bound cannot be proven
   *  (unbounded profile or UNKNOWN billing). Never treated as zero —
   *  the objective's cost binding is unverified and admission fails. */
  cost_unverified: boolean;
}

export interface DriverDeps {
  store: PairEvidenceStore;
  objectives: ObjectiveAuthorityService;
  policy: ObjectiveAutoPolicyService;
  scheduler: ObjectiveAutoScheduler;
  /** The pass runner — production wires
   *  createDefaultObjectiveOperatingService().service.runObjectivePass;
   *  tests inject a deterministic double that honors the same contract. */
  runPass: (input: {
    objective_id: string;
    actor: string;
    authority_gate: () => void;
    /** AUDIT R1 F5 — absolute epoch bound for any delegated planning
     *  inside this pass, derived from the claimed lease's canonical
     *  started_at + max_lifetime_ms minus the finalization allowance.
     *  Always supplied by the driver; forwarded into the planner
     *  invocation's deadline pin so paid planning can never outlive
     *  the lease that authorizes it. */
    planning_deadline_epoch_ms: number;
  }) => Promise<OperatingPassResult>;
  /** The deployment's DECLARED autonomous executor ids — production
   *  wires AUTONOMOUS_EXECUTOR_IDS (CODEX + PAIR_NATIVE). Membership is
   *  re-proven against live canonical Executor/Route/Binding rows on
   *  every envelope derivation; a listed id that is disabled,
   *  unqualified or auth-blocked simply contributes no supply. The
   *  canonical backstop for driver-attributed dispatches (absolute
   *  AUTONOMOUS_EXECUTOR_IDS gate) lives inside assertAndReserve. */
  executors: string[];
  /** billingFor seam from the P13 cost service. */
  billingFor: (
    executorId: string,
    routeId: string | null,
  ) => { mode: string; profile: Record<string, unknown> | null; unbounded: boolean };
  /** Global cost halt — PAIR_COST_HALT=1 || COST_HALT_FILE exists. */
  costHaltActive: () => boolean;
  workerId: string;
  bootId: string;
  now?: () => number;
  maxPassesPerTick?: number;
  /** P15.10-C R1: heartbeat renew interval. Default DRIVER_HEARTBEAT_MS;
   *  `0` disables the heartbeat entirely (deterministic tests only —
   *  production never wires 0). */
  heartbeatMs?: number;
  /** P15.10-C R1: the CEO invocation timeout this driver's awaited
   *  passes may run. Bound-validated at construction (5000..900000);
   *  claim-time lease max_lifetime = ceoTimeout + finalization
   *  allowance, capped at LEASE_MAX_LIFETIME_CAP_MS. Default 300_000
   *  (the PAIR_CEO_CLI_TIMEOUT_MS default). */
  ceoTimeoutMs?: number;
  /** P15.10-C R1 F1-D: before admitting a pass the driver reconciles
   *  STARTED/UNKNOWN CEO attempts scoped to this objective — a restart
   *  can never re-invoke a model call the previous worker already
   *  made; recovery resolves through canonical settle anchors only.
   *  Production wires ceoCycle.reconcileStaleAttempts. */
  reconcileStaleAttempts?: (objectiveId: string) => void;
  /** P16-E — capability-gap advisory projection: every durable
   *  DriverDenial (admission AND mid-pass) is classified into the
   *  canonical objective_capability_gap row, and a settled pass closes
   *  it. Optional + observability-only: a projection fault can never
   *  mask the denial or block the settle it annotates — the driver
   *  wraps every call in try{} exactly like recordDenial. */
  capabilityGaps?: Pick<ObjectiveCapabilityGapService,
    "recordGap" | "resolveGap" | "gapFor">;
}

interface LeaseRow {
  state: string;
  fence: number;
  token_hash: string | null;
  expires_at: number | null;
}

export class ObjectiveAutoDriverService {
  private readonly now: () => number;
  private readonly maxPassesPerTick: number;
  private readonly heartbeatMs: number;
  private readonly ceoTimeoutMs: number;

  constructor(private readonly deps: DriverDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.maxPassesPerTick = Math.max(
      1, Math.min(DRIVER_MAX_PASSES_PER_TICK, deps.maxPassesPerTick ?? 1));
    this.heartbeatMs = deps.heartbeatMs ?? DRIVER_HEARTBEAT_MS;
    if (!Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 0) {
      invalid("invalid heartbeatMs");
    }
    this.ceoTimeoutMs = deps.ceoTimeoutMs ?? 300_000;
    if (!Number.isFinite(this.ceoTimeoutMs) ||
        this.ceoTimeoutMs < CEO_TIMEOUT_MIN_MS ||
        this.ceoTimeoutMs > CEO_TIMEOUT_MAX_MS) {
      invalid("invalid ceoTimeoutMs bound");
    }
  }

  /** P15.10-C R1 F1-B: lease lifetime bound decided AT CLAIM from the
   *  validated CEO timeout + bounded finalization allowance — never a
   *  global TTL raise, never infinite renewal, never unvalidated. */
  private leaseLifetimeBoundMs(): number {
    return Math.min(
      this.ceoTimeoutMs + DRIVER_FINALIZATION_ALLOWANCE_MS,
      LEASE_MAX_LIFETIME_CAP_MS);
  }

  /** P15.10-C R1 F1-A: bounded lease heartbeat. Started ONLY after a
   *  valid claim; every renewal re-proves token/fence/worker-boot
   *  identity/generation/expiry/policy inside scheduler.renew — the
   *  heartbeat itself never creates authority. Retryable DB
   *  contention defers to the next tick; any other failure marks the
   *  worker unauthorized (it is NEVER assumed the external model call
   *  stopped). stop() in `finally` guarantees no timer leaks past
   *  settle/release/exception. */
  private startHeartbeat(handle: LeaseHandle): {
    fault: () => unknown;
    stop: () => void;
  } {
    let stopped = false;
    let lost: unknown = null;
    const timer = setInterval(() => {
      if (stopped) return;
      try {
        this.deps.scheduler.renew(handle);
      } catch (e) {
        if (isSqliteContentionError(e)) return; // retryable — next tick
        stopped = true;
        lost = e;
        clearInterval(timer);
      }
    }, this.heartbeatMs);
    timer.unref();
    return {
      fault: () => lost,
      stop: () => { stopped = true; clearInterval(timer); },
    };
  }

  private instant(): number {
    const n = this.now();
    if (!Number.isSafeInteger(n) || n < 0) invalid("invalid trusted clock");
    return n;
  }

  private stateId(objectiveId: string): string {
    return `auto-driver-state:${objectiveId}`;
  }

  private readState(objectiveId: string): Row | null {
    return readSchedulerRow<Row>(this.deps.store, DRIVER_STATE, this.stateId(objectiveId));
  }

  private writeState(objectiveId: string, patch: Record<string, unknown>, op: string, key: string): Row {
    const prev = this.readState(objectiveId);
    const admissions = [
      ...((prev?.admissions as Array<Record<string, unknown>> | undefined) ?? []),
      ...(patch.admissions as Array<Record<string, unknown>> | undefined ?? []),
    ].slice(-HISTORY_LIMIT);
    const denials = [
      ...((prev?.denials as Array<Record<string, unknown>> | undefined) ?? []),
      ...(patch.denials as Array<Record<string, unknown>> | undefined ?? []),
    ].slice(-HISTORY_LIMIT);
    return writeSchedulerRow<Row>(this.deps.store, DRIVER_STATE, this.stateId(objectiveId), {
      ...(prev ? fields(prev) : {}),
      objective_id: objectiveId,
      admissions,
      denials,
      last_outcome: patch.last_outcome ?? prev?.last_outcome ?? null,
      last_fence: patch.last_fence ?? prev?.last_fence ?? null,
      last_result: patch.last_result ?? prev?.last_result ?? null,
      updated_at: utcnow(),
    }, op, key);
  }

  /** P15.10-C R3 F3 — truthful objective-level readiness: the driver
   *  being WIRED is a deployment fact, not proof the objective can be
   *  driven. Runnable is derived only from canonical evidence: scheduler
   *  cursor READY, policy effective, queue not quarantined/blocked,
   *  provable cost binding + budget room under a money cap. Owner
   *  revalidation runs first — a non-owner never learns readiness. */
  readiness(objectiveId: string, actor: string): Record<string, unknown> {
    return this.deps.store.immediate(() => {
      const st = this.deps.policy.status(objectiveId, actor); // owner proof
      const reasons = new Set<string>();
      const push = (r: string | null | undefined) => { if (r) reasons.add(r); };
      const cursor = readSchedulerRow<Row>(this.deps.store, SCHEDULER_CURSOR, "LOCAL_PAIR_DB");
      if (!cursor || cursor.health !== "READY") push("SCHEDULER_NOT_READY");
      if (!st.effective) push("POLICY_NOT_EFFECTIVE");
      // R4 F3 — objective-level runnable truth comes from the scheduler's
      // OWN claim predicate (queue state, pending generation, next_due,
      // cooldown, authority pins, active lease), never a re-implemented
      // check in the driver.
      const claim = this.deps.scheduler.claimable(objectiveId);
      if (!claim.eligible) push(String(claim.reason));
      // PR #121 — the separate canonical Objective budget authority:
      // ceiling ≤ 0 forbids NEW spend-bearing work entirely (assertAnd-
      // Reserve hard-blocks it as OBJECTIVE_ZERO_BUDGET), so readiness
      // must say so truthfully rather than pretending the pass is free.
      const obj = this.deps.objectives.get(objectiveId);
      if (Number((obj.budget as Record<string, unknown> | undefined)
          ?.ceiling_microusd ?? 0) <= 0) {
        push("OBJECTIVE_ZERO_BUDGET");
      }
      const limits = st.limits as { budget_microusd_cap?: number } | null;
      const cap = limits?.budget_microusd_cap;
      // Executor availability is objective-level truth regardless of a
      // money cap — with no eligible autonomous executor nothing the
      // CEO plans can ever be dispatched.
      const env = this.dispatchCostEnvelope();
      if (!env.executorAvailable) push("EXECUTOR_UNAVAILABLE");
      // AUDIT R1 F4 — the CEO runs on the codex-cli subscription lane
      // no matter WHICH executors can take tasks: its binding + live
      // session are proven here, independently of executor supply. A
      // PAIR_NATIVE-only fleet is never proof the CEO can run.
      const ceoBilling = this.deps.billingFor(CODEX_EXECUTOR_ID, null);
      if (!(ceoBilling.mode === "SUBSCRIPTION" &&
            ceoBilling.profile != null && !ceoBilling.unbounded)) {
        push("COST_BINDING_UNVERIFIED");
      } else if (!this.codexSubscriptionAuthProven()) {
        push("SUBSCRIPTION_AUTH_UNVERIFIED");
      }
      // AUDIT R1 F2 — subscription-only is unconditional: envelope
      // reasons and metered-pairing presence are readiness truth under
      // an absent, zero or positive monetary cap alike.
      for (const r of env.reasons) push(r);
      if (env.metered) push("METERED_ROUTE_FORBIDDEN");
      if (cap != null) {
        const usage = this.usage(objectiveId);
        if (usage.cost_unverified) push("COST_UNVERIFIED");
        if (env.bound !== null &&
            usage.microusd + env.bound > cap) {
          push("BUDGET_EXHAUSTED");
        }
      }
      return {
        // Both the canonical readiness record (integrated/runnable/
        // reasons) and the exact shape scheduler.status consumes —
        // this object feeds the status projection directly.
        enabled: true,
        integrated: true,
        driver_missing: [],
        runnable: reasons.size === 0,
        objective_runnable: reasons.size === 0,
        reasons: [...reasons],
      };
    });
  }

  /** Read-only status — never mutates. Owner-scoped: the policy
   *  status call re-proves actor === owner_authority_id and throws
   *  FAIL_CLOSED_POLICY_FORBIDDEN before any driver state is read. */
  status(objectiveId: string, actor: string): Record<string, unknown> {
    return this.deps.store.immediate(() => {
      this.deps.policy.status(objectiveId, actor); // owner proof
      const st = this.readState(objectiveId);
      const lease = readSchedulerRow<Row>(this.deps.store, LEASE_STATE, objectiveId) as
        unknown as LeaseRow | null;
      return {
        objective_id: objectiveId,
        enabled: true,
        last_outcome: st?.last_outcome ?? null,
        last_result: st?.last_result ?? null,
        last_fence: st?.last_fence ?? null,
        admissions: (st?.admissions as unknown[])?.slice(-8) ?? [],
        denials: (st?.denials as unknown[])?.slice(-8) ?? [],
        capability_gap: this.gapForStatus(objectiveId),
        lease: lease
          ? { state: lease.state, fence: lease.fence, expires_at: lease.expires_at }
          : null,
      };
    });
  }

  /** P15.9-A1 R1 F1 — read-only status: identical projection to
   *  status() but the owner proof goes through policy.statusReadOnly,
   *  so NO lazy expiry write can be triggered by a GET. Driver state
   *  itself carries no expiry semantics — only the policy call wrote. */
  statusReadOnly(objectiveId: string, actor: string): Record<string, unknown> {
    return this.deps.store.immediate(() => {
      this.deps.policy.statusReadOnly(objectiveId, actor); // owner proof, no writes
      const st = this.readState(objectiveId);
      const lease = readSchedulerRow<Row>(this.deps.store, LEASE_STATE, objectiveId) as
        unknown as LeaseRow | null;
      return {
        objective_id: objectiveId,
        enabled: true,
        last_outcome: st?.last_outcome ?? null,
        last_result: st?.last_result ?? null,
        last_fence: st?.last_fence ?? null,
        admissions: (st?.admissions as unknown[])?.slice(-8) ?? [],
        denials: (st?.denials as unknown[])?.slice(-8) ?? [],
        capability_gap: this.gapForStatus(objectiveId),
        lease: lease
          ? { state: lease.state, fence: lease.fence, expires_at: lease.expires_at }
          : null,
      };
    });
  }

  /** Deployment-level status for readiness projections. */
  driverStatus(): Record<string, unknown> {
    return {
      enabled: true,
      worker_id: this.deps.workerId,
      boot_id: this.deps.bootId,
      max_passes_per_tick: this.maxPassesPerTick,
      autonomous_executors: [...this.deps.executors],
    };
  }

  /* ---------------- canonical usage derivation ----------------------- */

  private allocationsFor(objectiveId: string): Set<string> {
    const ids = new Set<string>();
    const rows = this.deps.store.list(WORKFORCE_ALLOCATION_ENTITY) as Row[];
    for (const row of rows) {
      if (String(row.objective_id ?? "") !== objectiveId) continue;
      assertCanonicalWorkforceAllocationProvenance(this.deps.store, row);
      ids.add(String(row.workstream_work_item_id));
      ids.add(String(row.delegated_child_work_item_id));
    }
    return ids;
  }

  /** Derive everything the caps bind, from canonical evidence only. */
  usage(objectiveId: string): DriverUsage {
    const attempts = (this.deps.store.list(CEO_DECISION_ATTEMPT_ENTITY) as Row[]).filter(
      (a) => String(a.objective_id) === objectiveId &&
             String(a.started_by) === DRIVER_ACTOR);
    const workItems = this.allocationsFor(objectiveId);
    const missionIds = new Set<string>();
    for (const wob of this.deps.store.list("work_open_binding") as Row[]) {
      if (String(wob.created_by) !== DRIVER_ACTOR) continue;
      if (!workItems.has(String(wob.work_item_id))) continue;
      missionIds.add(String(wob.mission_id));
    }
    let microusd = 0;
    let unverified = false;
    for (const r of this.deps.store.list("cost_reservation") as Row[]) {
      if (!missionIds.has(String(r.mission_id))) continue;
      const st = String(r.status);
      if (st === "RELEASED") continue;
      if (r.unbounded === true || String(r.billing_mode) === "UNKNOWN") {
        unverified = true;
      }
      microusd += st === "SETTLED"
        ? Number(r.settled_microusd ?? 0)
        : Number(r.reserved_microusd ?? 0);
    }
    return {
      ceo_calls: attempts.length,
      missions: missionIds.size,
      mission_ids: [...missionIds],
      microusd,
      cost_unverified: unverified,
    };
  }

  /** PR #121 — autonomous supply derived from canonical
   *  Executor/Route/Binding state, re-read at every call (never a
   *  boot-time snapshot). The configured `deps.executors` list is only
   *  the deployment's declared intent: an executor enters the envelope
   *  only while its canonical row proves ENABLED + READY + AVAILABLE +
   *  QUALIFIED + auth-acceptable + not quota/rate hard-blocked. A route
   *  enters only through a QUALIFIED executor_supply_binding while the
   *  route itself is enabled, never-rejected and live — disabled,
   *  unqualified and unrelated routes can no longer poison (or
   *  silently shrink) the cost envelope. Recoverable states
   *  (QUOTA_EXHAUSTED/COOLDOWN eligibility, DECLARED qualification)
   *  are deliberately OVER-included: the bound may never under-count a
   *  dispatch that could still happen. */
  private dispatchSupply(): {
    pairings: Array<{ executor_id: string; route_id: string | null }>;
    eligible: string[];
  } {
    const pairings: Array<{ executor_id: string; route_id: string | null }> = [];
    const eligible: string[] = [];
    const bindings = this.deps.store.list("executor_supply_binding") as Row[];
    for (const executorId of this.deps.executors) {
      const rec = this.deps.store.tryGet("executor", executorId);
      const md = (rec?.metadata ?? {}) as Record<string, unknown>;
      const ok = rec != null &&
        String(rec.status) === "ENABLED" &&
        ExecutorRegistry.availabilityState(rec) === "AVAILABLE" &&
        String(md.qualification_state ?? "") === "QUALIFIED" &&
        ExecutorRegistry.authState(md) !== "AUTH_REQUIRED" &&
        String(md.quota_state ?? "") !== "QUOTA_EXHAUSTED" &&
        !["RATE_LIMITED", "COOLDOWN"].includes(String(md.rate_limit_state ?? ""));
      if (!ok) continue;
      eligible.push(executorId);
      pairings.push({ executor_id: executorId, route_id: null });
      for (const b of bindings) {
        if (String(b.executor_id) !== executorId) continue;
        if (String(b.qualification_state) !== "QUALIFIED") continue;
        const route = this.deps.store.tryGet("route", String(b.route_id));
        if (!route || route.enabled !== true) continue;
        if (String(route.qualification_state) === "FAIL_CLOSED") continue;
        if (["DISABLED", "RETIRED"].includes(String(route.eligibility_state))) continue;
        const health = String(
          (route.health as Record<string, unknown> | undefined)?.state ?? "");
        if (REJECTED_ROUTE_HEALTH.has(health)) continue;
        pairings.push({ executor_id: executorId, route_id: String(b.route_id) });
      }
    }
    return { pairings, eligible };
  }

  /** The codex-cli pairing is the ChatGPT SUBSCRIPTION transport — its
   *  $0 billing is provable only while BOTH hold: (a) the provider row
   *  carries a live authenticated session (probe-derived AUTH_OK), and
   *  (b) AUDIT R2 F1 — the persisted session file itself resolves to
   *  ChatGPT auth mode at THIS moment: a stored OPENAI_API_KEY in
   *  auth.json is metered API-key billing even with no env keys, a
   *  missing file is no session, and an ambiguous shape is unproven —
   *  all fail closed. Neither the row alone nor file existence alone
   *  is proof; the live re-read is re-run at every gate call. */
  private codexSubscriptionAuthProven(): boolean {
    const p = this.deps.store.tryGet(
      "provider", providerEntryId(CODEX_CLI_PROVIDER_ID));
    return String(p?.auth_state ?? "") === "AUTH_OK" &&
      codexChatgptSessionProven(undefined);
  }

  /** AUDIT R1 F4 + R2 F1 — the complete CEO subscription authority:
   *  ACTIVE SUBSCRIPTION billing identity on the codex-cli lane AND a
   *  proven ChatGPT-mode session — checked independently of which
   *  executors can take tasks (a PAIR_NATIVE-only supply never implies
   *  the CEO can run). */
  private ceoSubscriptionProven(): boolean {
    const b = this.deps.billingFor(CODEX_EXECUTOR_ID, null);
    return b.mode === "SUBSCRIPTION" &&
      b.profile != null && !b.unbounded &&
      this.codexSubscriptionAuthProven();
  }

  /** PR #121 — provable cost envelope over the canonical autonomous
   *  supply. billingFor resolves route profile → model profile →
   *  executor profile, so a pricier route override still binds (R3 F2).
   *  - UNKNOWN / unbounded on ANY reachable pairing → unprovable.
   *  - METERED_API → real bound math (legitimate only under a positive
   *    cap; under cap 0 it denies through arithmetic + METERED_ROUTE_
   *    FORBIDDEN readiness).
   *  - SUBSCRIPTION / FREE / UNMETERED → $0, EXCEPT codex-cli where the
   *    only honest $0 is an ACTIVE SUBSCRIPTION profile plus a proven
   *    authenticated session — anything weaker is contradictory and
   *    fails closed instead of pretending zero-cost.
   *  Admission stays a PRELIMINARY check — the real enforcement lives
   *  inside assertAndReserve per governed task. */
  private dispatchCostEnvelope(): {
    bound: number | null;
    reasons: string[];
    metered: boolean;
    executorAvailable: boolean;
  } {
    const supply = this.dispatchSupply();
    const reasons = new Set<string>();
    let bound: number | null = 0;
    let metered = false;
    for (const p of supply.pairings) {
      const b = this.deps.billingFor(p.executor_id, p.route_id);
      if (b.mode === "UNKNOWN" || b.unbounded) {
        reasons.add("COST_BINDING_UNVERIFIED");
        bound = null;
        continue;
      }
      if (b.mode === "METERED_API") {
        metered = true;
        const reserve = Number(b.profile?.reserve_microusd ?? 0);
        const fixed = Number(b.profile?.fixed_microusd ?? 0);
        bound = bound === null ? null
          : Math.max(bound, reserve > 0 ? reserve : fixed);
        continue;
      }
      if (p.executor_id === CODEX_EXECUTOR_ID) {
        if (b.mode !== "SUBSCRIPTION") {
          reasons.add("COST_BINDING_UNVERIFIED");
          bound = null;
        } else if (!this.codexSubscriptionAuthProven()) {
          reasons.add("SUBSCRIPTION_AUTH_UNVERIFIED");
          bound = null;
        }
      }
      // else SUBSCRIPTION/FREE/UNMETERED on non-codex: provable $0.
    }
    if (supply.eligible.length === 0) reasons.add("EXECUTOR_UNAVAILABLE");
    return {
      bound,
      reasons: [...reasons],
      metered,
      executorAvailable: supply.eligible.length > 0,
    };
  }

  /* ---------------- admission (C1 + C2) ------------------------------ */

  /**
   * Atomic delegated admission: policy effective → global halt →
   * canonical usage vs caps → CAS admission receipt. Runs inside the
   * caller's lease; every re-check happens in ONE transaction so a
   * concurrent cap/policy change cannot slip through.
   */
  private admit(handle: LeaseHandle): void {
    this.deps.store.immediate(() => {
      const objectiveId = handle.objective_id;
      const st = this.deps.policy.evaluate(objectiveId);
      if (!st.effective) {
        throw new DriverDenial("DRIVER_AUTHORITY_LOST",
          `policy not effective: ${st.reasons.join(",")}`, false);
      }
      const receiptId = `auto-driver-admit:${objectiveId}:${handle.fence}`;
      if (readSchedulerRow<Row>(this.deps.store, SCHEDULER_RECEIPT, receiptId)) {
        return; // idempotent replay of THIS lease's admission
      }
      if (this.deps.costHaltActive()) {
        throw new DriverDenial("DRIVER_COST_HALTED", "global cost halt active", true);
      }
      const usage = this.usage(objectiveId);
      const limits = st.limits;
      if (limits?.max_ceo_calls != null &&
          usage.ceo_calls + CEO_MAX_ATTEMPTS_PER_OBSERVATION > limits.max_ceo_calls) {
        throw new DriverDenial("DRIVER_CAP_EXHAUSTED",
          `max_ceo_calls ${usage.ceo_calls}+${CEO_MAX_ATTEMPTS_PER_OBSERVATION}>${limits.max_ceo_calls}`, false);
      }
      if (limits?.max_missions != null && usage.missions + 1 > limits.max_missions) {
        throw new DriverDenial("DRIVER_CAP_EXHAUSTED",
          `max_missions ${usage.missions}+1>${limits.max_missions}`, false);
      }
      let dispatchBound: number | null = null;
      // AUDIT R1 F2 — subscription-only is UNCONDITIONAL: the provable
      // cost envelope is required under an absent, zero or positive
      // monetary cap alike. The cap binds what is allowed; it is not
      // itself the metered gate.
      if (usage.cost_unverified) {
        throw new DriverDenial("DRIVER_COST_UNVERIFIED",
          "attributed dispatch has unbounded/unknown cost", false);
      }
      // Envelope re-derived from LIVE canonical executor/route/binding
      // state inside this same atomic admission tx: a toggle, unqualify
      // or profile flip since the claim cannot slip through.
      const env = this.dispatchCostEnvelope();
      if (env.metered) {
        // Any reachable METERED_API pairing could settle positive —
        // forbidden for autonomous work regardless of the money cap.
        throw new DriverDenial("DRIVER_METERED_FORBIDDEN",
          "autonomous supply includes a metered billing pairing", false);
      }
      // AUDIT R1 F4 — the CEO invocation itself is subscription-only:
      // prove the codex-cli billing identity + live ChatGPT session
      // authority INDEPENDENTLY of which executors can take tasks. A
      // PAIR_NATIVE-only supply never authorizes a metered-CEO fallback.
      // R2: this precedes the generic envelope-bound denial so an
      // auth-mode failure reports its precise label.
      if (!this.ceoSubscriptionProven()) {
        throw new DriverDenial("DRIVER_SUBSCRIPTION_UNVERIFIED",
          "codex-cli CEO subscription binding/session not proven", false);
      }
      if (env.bound === null) {
        throw new DriverDenial("DRIVER_COST_UNVERIFIED",
          "cannot prove non-metered dispatch billing", false);
      }
      dispatchBound = env.bound;
      if (limits?.budget_microusd_cap != null &&
          usage.microusd + dispatchBound > limits.budget_microusd_cap) {
        throw new DriverDenial("DRIVER_CAP_EXHAUSTED",
          `budget ${usage.microusd}+${dispatchBound}>${limits.budget_microusd_cap}`, false);
      }
      writeSchedulerRow(this.deps.store, SCHEDULER_RECEIPT, receiptId, {
        objective_id: objectiveId,
        operation: "DRIVER_ADMISSION",
        fence: handle.fence,
        claimed_generation: handle.claimed_generation,
        checkpoint_digest: handle.checkpoint_digest,
        policy_version: st.policy_version,
        terms_digest: st.terms_digest_binding,
        owner_authority_id: st.owner_authority_id,
        reserved_ceo_calls: CEO_MAX_ATTEMPTS_PER_OBSERVATION,
        reserved_missions: 1,
        dispatch_bound_microusd: dispatchBound,
        usage_snapshot: {
          ceo_calls: usage.ceo_calls,
          missions: usage.missions,
          microusd: usage.microusd,
        },
      }, "DRIVER_ADMISSION", receiptId);
      this.writeState(objectiveId, {
        admissions: [{
          at: utcnow(), fence: handle.fence,
          generation: handle.claimed_generation,
          usage: { ceo_calls: usage.ceo_calls, missions: usage.missions,
            microusd: usage.microusd },
        }],
      }, "ADMIT", receiptId);
    });
  }

  /**
   * The gate the pass fires before every external authority crossing —
   * narrow re-proof, never a new authority: lease still ACTIVE at THIS
   * fence (stale worker fenced out), policy still effective (revoke /
   * pause / terms drift), global halt still off.
   */
  private authorityGate(handle: LeaseHandle): () => void {
    return () => {
      // P15.10-C R2 F1.1: the commit guard must re-prove the CLAIMED
      // authorization — state, fence, worker/boot, token, generation,
      // checkpoint, expiry, absolute lifetime, and the captured
      // policy_version / terms_digest / owner / objective_version pins —
      // through the scheduler's single canonical lease assertion. A
      // PAUSE→RESUME lands an effective policy at version V+2 that is
      // NOT the version this worker was claimed under.
      try {
        this.deps.scheduler.assertLeaseAuthority(handle);
      } catch (e) {
        throw new DriverDenial("DRIVER_AUTHORITY_LOST",
          `lease authority lost mid-pass: ${e instanceof Error ? e.message : e}`, false);
      }
      const st = this.deps.policy.evaluate(handle.objective_id);
      if (!st.effective) {
        throw new DriverDenial("DRIVER_AUTHORITY_LOST",
          `policy revoked mid-pass: ${st.reasons.join(",")}`, false);
      }
      if (this.deps.costHaltActive()) {
        throw new DriverDenial("DRIVER_COST_HALTED", "cost halt asserted mid-pass", true);
      }
      // AUDIT R2 F1 — the subscription session is re-proven at EVERY
      // external authority crossing (CEO call, planner call, review
      // commit, allocation, openWorkItem): a `codex logout` or
      // `login --with-api-key` between admission and the next
      // invocation flips the live auth mode to API_KEY/UNAUTHENTICATED
      // and this gate stops the pass before another subscription
      // invocation is attempted. Non-transient — operator action is
      // required to restore ChatGPT auth.
      if (!this.ceoSubscriptionProven()) {
        throw new DriverDenial("DRIVER_SUBSCRIPTION_UNVERIFIED",
          "codex-cli subscription authority lost mid-pass", false);
      }
    };
  }

  /* ---------------- one driven pass ---------------------------------- */

  private async driveOne(objectiveId: string): Promise<Record<string, unknown>> {
    const opportunity = `drive:${objectiveId}:${this.instant()}`;
    let handle: LeaseHandle;
    try {
      handle = this.deps.scheduler.claim(
        objectiveId, this.deps.workerId, this.deps.bootId, opportunity,
        { max_lifetime_ms: this.leaseLifetimeBoundMs() });
    } catch (e) {
      // Claim refusal is never an objective fault — the durable reason
      // (cooldown, race loser, retry exhaustion, roster cap, global
      // rate) already lives in the queue/lease rows. Skip; the next
      // fair visit re-derives eligibility.
      return { objective_id: objectiveId, skipped: true, fault: faultCode(e) };
    }
    const opId = `drive-pass:${objectiveId}:${handle.fence}`;
    // AUDIT R1 F5 — the pass's absolute planning deadline, derived from
    // the SAME durable lease row the scheduler's lifetime gate enforces:
    // started_at + max_lifetime_ms is the canonical authority bound, and
    // the bounded finalization allowance is reserved for settle/commit.
    // Threaded down into prepareDelegatedPlan → planExpander.deadlineMs
    // so a planner run inside this pass can never outlive the lease —
    // a too-long invocation fails PLANNER_DEADLINE (fail-closed) instead
    // of running unauthorized after the lifetime gate kills the lease.
    const leaseRow = readSchedulerRow<Row>(
      this.deps.store, LEASE_STATE, objectiveId);
    const planningDeadlineEpochMs =
      Number(leaseRow?.started_at ?? this.instant()) +
      Number(leaseRow?.max_lifetime_ms ?? this.leaseLifetimeBoundMs()) -
      DRIVER_FINALIZATION_ALLOWANCE_MS;
    try {
      // F1-D: reconcile any STARTED/UNKNOWN CEO attempt the previous
      // worker left behind BEFORE admitting a new pass — never a
      // blind re-invocation.
      this.deps.reconcileStaleAttempts?.(objectiveId);
      this.admit(handle);
    } catch (e) {
      if (e instanceof DriverDenial) {
        this.recordDenial(objectiveId, handle, e);
        if (e.transient) {
          this.tryRelease(handle, opId);
        } else {
          this.tryQuarantine(objectiveId, e.label);
          this.tryRelease(handle, opId);
        }
        return { objective_id: objectiveId, denied: e.label, transient: e.transient };
      }
      // Unexpected admission fault — release into bounded retry, never
      // quarantine an unproven failure. The driver itself classifies it
      // DRIVER_PASS_FAULT — project it so the advisory is not blind to
      // genuine execution-layer breakage.
      this.noteGap(objectiveId, { label: "DRIVER_PASS_FAULT", transient: true },
        handle.fence);
      this.tryRelease(handle, opId);
      return { objective_id: objectiveId, denied: "DRIVER_PASS_FAULT",
        transient: true, fault: faultCode(e) };
    }
    // F1-A: heartbeat starts only after the valid claim; it stops in
    // `finally` — never before claim, never past settle/release/fault.
    const hb = this.heartbeatMs === 0
      ? { fault: () => null as unknown, stop: () => {} }
      : this.startHeartbeat(handle);
    let result: OperatingPassResult;
    try {
      result = await this.deps.runPass({
        objective_id: objectiveId,
        actor: DRIVER_ACTOR,
        authority_gate: this.authorityGate(handle),
        planning_deadline_epoch_ms: planningDeadlineEpochMs,
      });
      // F1-A: a renewal fault means this worker is deemed unauthorized
      // — the outcome is never settled under a lost lease.
      const hbFault = hb.fault();
      if (hbFault !== null) {
        throw new DriverDenial("DRIVER_AUTHORITY_LOST",
          `lease heartbeat lost mid-pass: ${faultCode(hbFault)}`, false);
      }
    } catch (e) {
      // Pass aborted — fail closed. The claimed generation stays
      // unsettled for a later reclaim UNLESS the fault is durable:
      // canonical settle was never reached, so release with backoff or
      // quarantine a permanent fault.
      this.writeState(objectiveId, {
        last_fence: handle.fence,
        last_result: { fault: faultCode(e) },
      }, "PASS_FAULT", opId);
      if (e instanceof DriverDenial) {
        this.noteGap(objectiveId, e, handle.fence);
        if (!e.transient) this.tryQuarantine(objectiveId, e.label);
      } else {
        // Untyped mid-pass fault — the durable state row already labels
        // it PASS_FAULT; project the same closed vocabulary into the gap.
        this.noteGap(objectiveId, { label: "DRIVER_PASS_FAULT", transient: true },
          handle.fence);
      }
      this.tryRelease(handle, opId);
      return {
        objective_id: objectiveId,
        outcome: "FAULT",
        fault: faultCode(e),
      };
    } finally {
      hb.stop();
    }
    try {
      this.deps.scheduler.settle(handle, result.outcome, opId);
    } catch (e) {
      // Authority drifted between pass and settle — the lease proof
      // re-validates inside settle; release fails the same way and the
      // stale lease is reaped by expiry + rebind invalidation.
      this.tryRelease(handle, `${opId}:settle-failed`);
      this.writeState(objectiveId, {
        last_fence: handle.fence,
        last_result: { fault: faultCode(e), during: "SETTLE" },
      }, "SETTLE_FAULT", opId);
      return { objective_id: objectiveId, outcome: result.outcome, settled: false,
        fault: faultCode(e) };
    }
    this.writeState(objectiveId, {
      last_outcome: result.outcome,
      last_fence: handle.fence,
      last_result: {
        outcome: result.outcome,
        mission_id: result.mission_id ?? null,
        ceo_decision_id: result.ceo_decision_id ?? null,
        review_id: result.review_id ?? null,
        detail: result.detail ?? null,
      },
    }, "SETTLED", opId);
    // P16-E — a settled pass proves the capability chain end-to-end;
    // close the gap projection. try{} like every advisory write.
    try { this.deps.capabilityGaps?.resolveGap(objectiveId); }
    catch { /* advisory only — never mask the settle */ }
    return { objective_id: objectiveId, outcome: result.outcome, settled: true };
  }

  private recordDenial(objectiveId: string, handle: LeaseHandle, e: DriverDenial): void {
    try {
      this.writeState(objectiveId, {
        last_fence: handle.fence,
        denials: [{ at: utcnow(), fence: handle.fence, label: e.label }],
      }, "DENIED", `${objectiveId}:${handle.fence}:${e.label}`);
      this.deps.capabilityGaps?.recordGap({
        objective_id: objectiveId, label: e.label,
        transient: e.transient, fence: handle.fence,
      });
    } catch { /* driver state is observability only — never mask the denial */ }
  }

  /** Mid-pass DriverDenials never reach recordDenial (the admit catch
   *  owns it) but carry the same closed-vocabulary fault — the gap
   *  projection must see them or a mid-pass AUTHORITY_LOST would leave
   *  the advisory surface blind to the real blocker. The unexpected-
   *  fault paths also report through here as DRIVER_PASS_FAULT — the
   *  same label the driver's own denial/result strings already use, so
   *  the advisory covers every path the driver itself classifies. */
  private noteGap(objectiveId: string,
    e: { label: DriverFaultLabel; transient: boolean }, fence: number): void {
    try {
      this.deps.capabilityGaps?.recordGap({
        objective_id: objectiveId, label: e.label,
        transient: e.transient, fence,
      });
    } catch { /* advisory only — never mask the fault */ }
  }

  /** Status-read seam: gapFor must never throw into the owner status
   *  read — a hostile or failing seam impl degrades to the same
   *  UNVERIFIED marker the service itself uses, never a 500, never
   *  fabricated data. */
  private gapForStatus(objectiveId: string): Record<string, unknown> | null {
    try {
      return this.deps.capabilityGaps?.gapFor(objectiveId) ?? null;
    } catch {
      return {
        state: "UNVERIFIED",
        reason: "FAIL_CLOSED_CAPABILITY_GAP_TAMPERED",
        objective_id: objectiveId,
      };
    }
  }

  private tryRelease(handle: LeaseHandle, opId: string): void {
    try {
      this.deps.scheduler.release(handle, opId);
    } catch {
      // A lost-lease release is already fail-closed; lease expiry +
      // requireRebind invalidation reap it durably.
    }
  }

  private tryQuarantine(objectiveId: string, reason: string): void {
    try {
      this.deps.scheduler.quarantine(objectiveId, sanitizeFaultReason(reason));
    } catch { /* the durable denial is in driver_state already */ }
  }

  /**
   * ONE bounded tick: reap stale leases, then drive up to
   * maxPassesPerTick fair candidates. Sequential by construction —
   * cross-process exclusion is the lease fence, never process state.
   */
  async tick(): Promise<{ driven: Array<Record<string, unknown>>; idle: boolean }> {
    this.deps.scheduler.reconcileLeases();
    const driven: Array<Record<string, unknown>> = [];
    for (let i = 0; i < this.maxPassesPerTick; i++) {
      const candidate = this.deps.scheduler.nextFairCandidate();
      if (!candidate) break;
      try {
        driven.push(await this.driveOne(candidate));
      } catch (e) {
        // Unexpected drive-level fault outside the handled paths —
        // the queue row keeps its durable state; next tick retries
        // under the same authority re-proofs. Never quarantine an
        // unproven failure.
        driven.push({ objective_id: candidate, outcome: "FAULT", fault: faultCode(e) });
      }
    }
    return { driven, idle: driven.length === 0 };
  }
}

/** Runtime wrapper — same shape as ObjectiveAutoReconcileRuntime: an
 *  interval that never overlaps inside one process and persists only
 *  through canonical state. */
export class ObjectiveAutoDriverRuntime {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inTick = false;
  lastError: string | null = null;
  lastTickAt: number | null = null;

  constructor(
    private readonly driver: ObjectiveAutoDriverService,
    private readonly intervalMs = 5_000,
    private readonly onError?: (e: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.safeTick();
    this.timer = setInterval(() => void this.safeTick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async safeTick(): Promise<void> {
    if (this.inTick) return;
    this.inTick = true;
    try {
      await this.driver.tick();
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e instanceof Error ? e.message : e).slice(0, 512);
      this.onError?.(e);
    } finally {
      this.inTick = false;
      this.lastTickAt = Date.now();
    }
  }
}

/** Composition seam — mirrors createObjectiveAutoReconcile. */
export function createObjectiveAutoDriver(deps: DriverDeps & {
  intervalMs?: number;
  onError?: (e: unknown) => void;
}): {
  driver: ObjectiveAutoDriverService;
  runtime: ObjectiveAutoDriverRuntime;
} {
  const driver = new ObjectiveAutoDriverService(deps);
  const runtime = new ObjectiveAutoDriverRuntime(driver, deps.intervalMs, deps.onError);
  return { driver, runtime };
}

export { sanitizeFaultReason, NotFoundError };
