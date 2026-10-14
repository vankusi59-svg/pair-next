/**
 * Governed async replan generation — durable candidate staging that
 * bridges the ASYNCHRONOUS Planner Pool to the SYNCHRONOUS
 * RuntimePlanner contract used by `MissionRuntime.runReplan`.
 *
 * Problem: `MissionRuntime` ticks are sync; the canonical LLM planner
 * composition (`runPlannerFailover` + cost admission + planner-run
 * evidence) is async. Production therefore wired `replanProvider: null`
 * and every governed REPLAN failed closed as
 * FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE.
 *
 * Bridge (P16, feature-flagged `PAIR_ASYNC_REPLAN_PROVIDER=1`):
 *
 *   tick (sync, inside the RuntimePlanner REPLAN call)
 *     → ReplanGenerationService.requestCandidate(input)
 *         deterministic generation identity
 *           digest(recovery_id, attempt_index)
 *         bound to mission + recovery decision + superseded plan +
 *           failure-context snapshot + candidate slot index
 *         absent → mint PENDING row → throw REPLAN_GENERATION_PENDING
 *         PENDING/LEASED → throw REPLAN_GENERATION_PENDING
 *         FAILED → throw mapped FAIL_CLOSED_REPLAN_PROVIDER_*
 *         STAGED → serve the staged canonical candidate verbatim
 *
 *   driver (async, from the supervisor's existing periodic sweep)
 *     → reconcile()  — cancel rows whose recovery chain moved on,
 *                      flip rows past their absolute deadline,
 *                      mark served slots CONSUMED
 *     → claimNext()  — ONE durable CAS lease (owner_id + claim_epoch +
 *                      lease_expires_at, APRE-style) per generation row
 *     → generate()   — the SAME runPlannerFailover composition (injected;
 *                      model qualification + cost admission + planner-run
 *                      evidence all live in the injected seam)
 *     → settle()     — STAGED {candidate} or FAILED {typed outcome}
 *                      guarded by exact lease (owner, epoch) — stale
 *                      writes are dropped, never stomped
 *
 * REPLAN_GENERATION_PENDING is deliberately NOT a FAIL_CLOSED_* code:
 * pending is a wait state, not a failure — `runReplan` returns without
 * consuming a `MAX_REPLAN_CANDIDATES_PER_DECISION` slot, the runtime
 * stays REPLANNING, and the deadline bounds the wait.
 *
 * Generation failures map back onto the existing
 * FAIL_CLOSED_REPLAN_PROVIDER_* prefix, so provider unavailability /
 * timeout / exhaustion / cost-admission rejection keep today's
 * REPLAN-infeasible → fresh RecoveryController decision semantics and
 * never consume a candidate slot.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import {
  REPLAN_GENERATION_PENDING,
  ReplanAttemptLedger,
  replanAttemptId,
} from "./plan-feasibility.js";
import type { PairEvidenceStore } from "./store.js";
import type { RuntimePlannerInput } from "./mission-runtime.js";

export const REPLAN_GENERATION_CONTRACT = "pair-replan-generation.v1";
export const REPLAN_GENERATION_ENTITY = "replan_generation";

/** Max CAS lease acquisitions per generation row — bounds reclaim loops. */
export const REPLAN_GENERATION_MAX_LEASES = 2;
/** Bound on durable context snapshot fields (mirrors replan_context). */
const MAX_CONTEXT_FIELD = 512;
const MAX_REJECTED_DIGESTS = 16;

const TERMINAL_GENERATION = new Set<ReplanGenerationStatus>([
  "FAILED",
  "CONSUMED",
  "CANCELLED",
]);

/** Terminal mission_runtime states — a generation whose mission has
 *  settled can never be consumed; reconcile cancels it. */
const TERMINAL_RUNTIME_STATES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABORTED",
]);

export type ReplanGenerationStatus =
  | "PENDING"
  | "LEASED"
  | "STAGED"
  | "FAILED"
  | "CONSUMED"
  | "CANCELLED";

/** Typed terminal generation outcomes — distinct from candidate
 *  rejections (which live on the replan_attempt ledger) and from
 *  provider-produced invalid candidates. */
export type ReplanGenerationOutcome =
  | "PROVIDER_UNAVAILABLE"
  | "EXHAUSTED"
  | "TIMEOUT"
  | "ADMISSION_REJECTED"
  | "GENERATION_FAILED";

/** Bounded snapshot of the RuntimePlannerInput.replan_context minted by
 *  runReplan — persisted verbatim so the async generation re-proves the
 *  exact failure identity it was requested for. */
export interface ReplanContextSnapshot {
  recovery_id: string;
  failure_signature: string | null;
  failure_class: string;
  dependency_reason?: string | null;
  failed_task_key?: string | null;
  failed_plan_semantic_digest: string | null;
  rejected_semantic_digests: string[];
}

// Type alias (not interface) so the record satisfies the store's
// Record<string, unknown> constraint via its implicit index signature —
// same durable-row convention as ReplanAttemptRecord's cast sites.
export type ReplanGenerationRecord = {
  entity_type: typeof REPLAN_GENERATION_ENTITY;
  contract: string;
  replan_generation_id: string;
  mission_id: string;
  recovery_id: string;
  /** Candidate slot index this generation feeds — equals
   *  ledger.attemptsUsed(recovery_id) at request time. */
  attempt_index: number;
  /** The replan_attempt id this generation's candidate will be recorded
   *  under once staged + served — precomputed for linkage. */
  replan_attempt_id: string;
  /** plan_id active at request time — the superseded revision the
   *  candidate replaces. Bound so a stale staged candidate can never
   *  serve after the plan advanced. */
  superseded_plan_id: string | null;
  /** digest() over the exact request signature — re-requests under a
   *  different context/mission/plan are a binding violation. */
  context_digest: string;
  replan_context: ReplanContextSnapshot;
  status: ReplanGenerationStatus;
  /** Durable CAS lease (APRE-style): owner + monotonic epoch + expiry.
   *  settle() requires an exact (owner_id, lease_epoch) match so a
   *  superseded or concurrent writer's result is dropped, not applied. */
  lease_owner_id: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  lease_count: number;
  /** Absolute wall-clock deadline for the whole generation — bounds
   *  PENDING and bounds the async provider call inside the driver. */
  deadline_at: string;
  /** planner_run_id of the production planner_run evidence row. */
  planner_run_id: string | null;
  staged_candidate: {
    tasks: Array<Record<string, unknown>>;
    plan_source: string;
  } | null;
  outcome: { kind: ReplanGenerationOutcome; code: string | null } | null;
  created_at: string;
  version: number;
};

/** Canonical Objective lineage for planner cost admission on a REPLAN
 *  generation: mission.bound_open_id → work_open_binding.work_item_id.
 *  A mission that claims an objective binding whose lineage row is
 *  missing is BROKEN lineage — fail closed (FAIL_CLOSED_COST_*), never
 *  silently scoped NONE. Mirrors cost.ts's mission-scoped walk. */
export function replanWorkItemId(
  store: {
    tryGet: (
      entityType: string,
      entityId: string,
    ) => (Record<string, unknown> & { version: number }) | null;
  },
  mission: Record<string, unknown>,
): string | null {
  const openId = mission.bound_open_id;
  if (openId == null || String(openId) === "") return null;
  const binding = store.tryGet("work_open_binding", String(openId));
  if (binding == null || binding.work_item_id == null) {
    throw new PolicyError(
      "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED",
      `mission ${String(mission.mission_id)}: bound_open_id ${String(openId)} lineage unresolvable`,
    );
  }
  return String(binding.work_item_id);
}

/** Deterministic generation identity: one durable row per
 *  (recovery decision, candidate slot). Two sync ticks requesting the
 *  same slot converge on this exact id — single-flight by identity. */
export function replanGenerationId(
  recoveryId: string,
  attemptIndex: number,
): string {
  return `RPG_${digest(`${REPLAN_GENERATION_CONTRACT}|${recoveryId}|${attemptIndex}`).slice(0, 24)}`;
}

/** Maps a terminal generation outcome onto the existing
 *  FAIL_CLOSED_REPLAN_PROVIDER_* code family so runReplan's exhaustion
 *  path is unchanged — a generation failure is an infeasible REPLAN
 *  action, never a candidate rejection and never a runtime defect. */
export function replanProviderCodeForOutcome(
  outcome: ReplanGenerationOutcome | null | undefined,
): string {
  switch (outcome) {
    case "PROVIDER_UNAVAILABLE":
      return "FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE";
    case "TIMEOUT":
      return "FAIL_CLOSED_REPLAN_PROVIDER_TIMEOUT";
    case "EXHAUSTED":
      return "FAIL_CLOSED_REPLAN_PROVIDER_EXHAUSTED";
    case "ADMISSION_REJECTED":
      return "FAIL_CLOSED_REPLAN_PROVIDER_ADMISSION";
    case "GENERATION_FAILED":
    default:
      return "FAIL_CLOSED_REPLAN_PROVIDER_INFEASIBLE";
  }
}

/** Classifies a thrown provider-pool error into a typed generation
 *  outcome. Any FAIL_CLOSED_COST_* family (objective budget, lineage,
 *  capacity admission) is an admission rejection; the pool's terminal
 *  codes map verbatim; everything else is an undifferentiated
 *  generation failure. */
export function classifyReplanGenerationFailure(
  err: unknown,
): { kind: ReplanGenerationOutcome; code: string | null } {
  const code = String((err as { code?: unknown })?.code ?? "");
  if (code === "FAIL_CLOSED_PLANNER_NO_ELIGIBLE") {
    return { kind: "PROVIDER_UNAVAILABLE", code };
  }
  if (code === "FAIL_CLOSED_PLANNER_DEADLINE") {
    return { kind: "TIMEOUT", code };
  }
  if (code === "FAIL_CLOSED_PLANNER_EXHAUSTED") {
    return { kind: "EXHAUSTED", code };
  }
  if (code.startsWith("FAIL_CLOSED_COST_")) {
    return { kind: "ADMISSION_REJECTED", code };
  }
  return { kind: "GENERATION_FAILED", code: code || null };
}

function boundString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length > MAX_CONTEXT_FIELD ? s.slice(0, MAX_CONTEXT_FIELD) : s;
}

/** Snapshot the request's replan_context into the bounded durable
 *  shape — the exact failure identity the generation was requested
 *  for. Anything outside this shape is not authority. */
export function snapshotReplanContext(
  ctx: NonNullable<RuntimePlannerInput["replan_context"]>,
): ReplanContextSnapshot {
  const out: ReplanContextSnapshot = {
    recovery_id: String(ctx.recovery_id),
    failure_signature: boundString(ctx.failure_signature),
    failure_class: boundString(ctx.failure_class) ?? "",
    dependency_reason: boundString(ctx.dependency_reason ?? null),
    failed_task_key: boundString(ctx.failed_task_key ?? null),
    failed_plan_semantic_digest: boundString(ctx.failed_plan_semantic_digest),
    rejected_semantic_digests: Array.isArray(ctx.rejected_semantic_digests)
      ? ctx.rejected_semantic_digests
          .slice(0, MAX_REJECTED_DIGESTS)
          .map((d) => boundString(d) ?? "")
      : [],
  };
  return out;
}

function contextDigest(args: {
  mission_id: string;
  recovery_id: string;
  attempt_index: number;
  superseded_plan_id: string | null;
  replan_context: ReplanContextSnapshot;
}): string {
  return digest({
    contract: REPLAN_GENERATION_CONTRACT,
    mission_id: args.mission_id,
    recovery_id: args.recovery_id,
    attempt_index: args.attempt_index,
    superseded_plan_id: args.superseded_plan_id,
    replan_context: args.replan_context,
  });
}

function isoAfter(nowMs: number, deltaMs: number): string {
  return new Date(nowMs + deltaMs).toISOString();
}

/**
 * The durable generation seam. Holds NO governance authority of its own:
 * every candidate re-enters `runReplan` through the same committed
 * gates (validatePlanProposal, bindPlanExternalInputs, assertPlanDataflow,
 * semantic dedup, PREPARED → atomic commit).
 */
export class ReplanGenerationService {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly opts: { deadlineMs?: number } = {},
  ) {}

  private ledger(): ReplanAttemptLedger {
    return new ReplanAttemptLedger(this.store);
  }

  /**
   * The synchronous bridge — wired as ServePlannerDeps.replanProvider.
   * Returns the staged canonical candidate when one is durably ready;
   * otherwise throws REPLAN_GENERATION_PENDING (in flight) or a mapped
   * FAIL_CLOSED_REPLAN_PROVIDER_* code (terminal generation failure).
   */
  requestCandidate(input: RuntimePlannerInput): {
    tasks: Array<Record<string, unknown>>;
    canonical: true;
    plan_source: string;
    planner_run_id: string | null;
  } {
    const ctx = input.replan_context;
    if (ctx == null || typeof ctx.recovery_id !== "string" || !ctx.recovery_id) {
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_GENERATION_CONTEXT",
        "replan_context missing recovery identity",
      );
    }
    const missionId = String(input.mission?.mission_id ?? "");
    if (!missionId) {
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_GENERATION_CONTEXT",
        "mission identity missing",
      );
    }
    const recoveryId = ctx.recovery_id;
    const ledger = this.ledger();
    const attemptIndex = ledger.attemptsUsed(recoveryId);
    const id = replanGenerationId(recoveryId, attemptIndex);
    const row = this.store.tryGet<ReplanGenerationRecord>(
      REPLAN_GENERATION_ENTITY,
      id,
    );
    if (row == null) {
      const supersededPlanId =
        input.mission?.plan_id != null ? String(input.mission.plan_id) : null;
      const snapshot = snapshotReplanContext(ctx);
      const deadlineMs = this.opts.deadlineMs ?? 1_800_000;
      const now = Date.now();
      const record: ReplanGenerationRecord = {
        entity_type: REPLAN_GENERATION_ENTITY,
        contract: REPLAN_GENERATION_CONTRACT,
        replan_generation_id: id,
        mission_id: missionId,
        recovery_id: recoveryId,
        attempt_index: attemptIndex,
        replan_attempt_id: replanAttemptId(recoveryId, attemptIndex),
        superseded_plan_id: supersededPlanId,
        context_digest: contextDigest({
          mission_id: missionId,
          recovery_id: recoveryId,
          attempt_index: attemptIndex,
          superseded_plan_id: supersededPlanId,
          replan_context: snapshot,
        }),
        replan_context: snapshot,
        status: "PENDING",
        lease_owner_id: null,
        lease_epoch: 0,
        lease_expires_at: null,
        lease_count: 0,
        deadline_at: isoAfter(now, deadlineMs),
        planner_run_id: null,
        staged_candidate: null,
        outcome: null,
        created_at: utcnow(),
        version: 0,
      };
      try {
        this.store.immediate(() => {
          this.store.put(REPLAN_GENERATION_ENTITY, id, record, 0);
          this.store.event({
            entity_type: REPLAN_GENERATION_ENTITY,
            entity_id: id,
            event_type: "REPLAN_GENERATION_REQUESTED",
            old_state: null,
            new_state: "PENDING",
            actor: "PAIR_REPLAN_GENERATION",
            metadata: {
              mission_id: missionId,
              recovery_id: recoveryId,
              attempt_index: attemptIndex,
              replan_attempt_id: record.replan_attempt_id,
              superseded_plan_id: supersededPlanId,
            },
          });
        });
      } catch (err) {
        // Lost a durable create race — re-read the authoritative row and
        // verify it binds the SAME request signature before deciding.
        const existing = this.store.tryGet<ReplanGenerationRecord>(
          REPLAN_GENERATION_ENTITY,
          id,
        );
        if (existing == null) throw err;
        this.assertBinding(existing, input, attemptIndex);
        return this.serveOrThrow(existing);
      }
      throw new PolicyError(REPLAN_GENERATION_PENDING, `${id}:requested`);
    }
    this.assertBinding(row, input, attemptIndex);
    return this.serveOrThrow(row);
  }

  /** Exact-identity proof: a re-request under a different mission /
   *  recovery / slot / superseded revision / failure-context snapshot is
   *  a binding violation, not a new generation. */
  private assertBinding(
    row: ReplanGenerationRecord,
    input: RuntimePlannerInput,
    attemptIndex: number,
  ): void {
    const ctx = input.replan_context!;
    const supersededPlanId =
      input.mission?.plan_id != null ? String(input.mission.plan_id) : null;
    const snapshot = snapshotReplanContext(ctx);
    const expected = contextDigest({
      mission_id: String(input.mission?.mission_id ?? ""),
      recovery_id: ctx.recovery_id,
      attempt_index: attemptIndex,
      superseded_plan_id: supersededPlanId,
      replan_context: snapshot,
    });
    if (
      row.mission_id !== String(input.mission?.mission_id ?? "") ||
      row.recovery_id !== ctx.recovery_id ||
      row.attempt_index !== attemptIndex ||
      row.superseded_plan_id !== supersededPlanId ||
      row.context_digest !== expected
    ) {
      throw new IntegrityError(
        "FAIL_CLOSED_REPLAN_GENERATION_BINDING",
        `${row.replan_generation_id}`,
      );
    }
  }

  private serveOrThrow(row: ReplanGenerationRecord): {
    tasks: Array<Record<string, unknown>>;
    canonical: true;
    plan_source: string;
    planner_run_id: string | null;
  } {
    switch (row.status) {
      case "STAGED": {
        const staged = row.staged_candidate;
        if (staged == null || !Array.isArray(staged.tasks) || !staged.tasks.length) {
          throw new IntegrityError(
            "FAIL_CLOSED_REPLAN_GENERATION_STAGED",
            `${row.replan_generation_id}:empty`,
          );
        }
        return {
          tasks: staged.tasks,
          canonical: true,
          plan_source: staged.plan_source,
          planner_run_id: row.planner_run_id,
        };
      }
      case "FAILED": {
        const code = replanProviderCodeForOutcome(row.outcome?.kind);
        throw new IntegrityError(
          code,
          `${row.replan_generation_id}:${row.outcome?.kind ?? "GENERATION_FAILED"}:${row.outcome?.code ?? ""}`,
        );
      }
      case "CANCELLED":
        throw new IntegrityError(
          "FAIL_CLOSED_REPLAN_PROVIDER_UNAVAILABLE",
          `${row.replan_generation_id}:generation_cancelled`,
        );
      case "CONSUMED":
        // The slot already resolved — runReplan short-circuits on the
        // replan_attempt row before calling the provider; reaching this
        // means the durable ledger was bypassed.
        throw new IntegrityError(
          "FAIL_CLOSED_REPLAN_GENERATION_CONSUMED",
          row.replan_generation_id,
        );
      case "PENDING":
      case "LEASED":
      default:
        throw new PolicyError(
          REPLAN_GENERATION_PENDING,
          `${row.replan_generation_id}:${String(row.status).toLowerCase()}`,
        );
    }
  }

  /** The generation is still wanted iff the mission's runtime row exists,
   *  is non-terminal, and pending_recovery still names THIS recovery. */
  private wanted(row: ReplanGenerationRecord): boolean {
    const rt = this.store.tryGet<Record<string, unknown>>(
      "mission_runtime",
      `MRT_${row.mission_id}`,
    );
    if (rt == null) return false;
    if (TERMINAL_RUNTIME_STATES.has(String(rt.state ?? ""))) return false;
    const pending = rt.pending_recovery as Record<string, unknown> | null | undefined;
    return String(pending?.recovery_id ?? "") === row.recovery_id;
  }

  /** The replan_attempt slot this generation feeds is durably resolved. */
  private slotResolved(row: ReplanGenerationRecord): boolean {
    return (
      this.store.tryGet("replan_attempt", row.replan_attempt_id) != null
    );
  }

  private transition(
    row: ReplanGenerationRecord,
    to: ReplanGenerationStatus,
    reason: string,
    outcome?: { kind: ReplanGenerationOutcome; code: string | null },
  ): void {
    const updated: ReplanGenerationRecord = {
      ...row,
      status: to,
      outcome: outcome ?? row.outcome,
    };
    this.store.put(
      REPLAN_GENERATION_ENTITY,
      row.replan_generation_id,
      updated,
      Number(row.version),
    );
    this.store.event({
      entity_type: REPLAN_GENERATION_ENTITY,
      entity_id: row.replan_generation_id,
      event_type: `REPLAN_GENERATION_${to}`,
      old_state: String(row.status),
      new_state: to,
      actor: "PAIR_REPLAN_GENERATION",
      metadata: {
        mission_id: row.mission_id,
        recovery_id: row.recovery_id,
        attempt_index: row.attempt_index,
        reason,
        outcome: outcome ?? null,
      },
    });
  }

  /**
   * Driver-side sweep bookkeeping — reconciles every live generation
   * row against current mission/recovery state. Cancellable rows that
   * lost their recovery chain are CANCELLED; rows past their absolute
   * deadline FAIL (TIMEOUT); served slots become CONSUMED. Called at the
   * top of every driver sweep and safe to call standalone.
   */
  reconcile(args: { nowMs: number }): {
    cancelled: number;
    failed: number;
    consumed: number;
  } {
    const counts = { cancelled: 0, failed: 0, consumed: 0 };
    this.store.immediate(() => {
      const rows = this.store
        .list<ReplanGenerationRecord>(REPLAN_GENERATION_ENTITY)
        .filter((r) => !TERMINAL_GENERATION.has(r.status));
      for (const row of rows) {
        if (this.slotResolved(row)) {
          const to = row.status === "STAGED" ? "CONSUMED" : "CANCELLED";
          this.transition(row, to, "slot_resolved");
          if (to === "CONSUMED") counts.consumed++;
          else counts.cancelled++;
          continue;
        }
        if (!this.wanted(row)) {
          this.transition(row, "CANCELLED", "recovery_chain_moved");
          counts.cancelled++;
          continue;
        }
        if (args.nowMs >= Date.parse(row.deadline_at)) {
          this.transition(row, "FAILED", "deadline_exceeded", {
            kind: "TIMEOUT",
            code: "REPLAN_GENERATION_DEADLINE",
          });
          counts.failed++;
        }
      }
    });
    return counts;
  }

  /**
   * Claim the next due generation row under a bounded durable CAS lease.
   * Returns the claimed row or null when nothing is due. A row is
   * claimable when PENDING or when its lease has expired (crashed /
   * stalled owner); a live unexpired lease is single-flight.
   */
  claimNext(args: {
    owner_id: string;
    lease_ms: number;
    now_ms: number;
  }): ReplanGenerationRecord | null {
    return this.store.immediate(() => {
      const rows = this.store
        .list<ReplanGenerationRecord>(REPLAN_GENERATION_ENTITY)
        .filter(
          (r) =>
            r.status === "PENDING" ||
            (r.status === "LEASED" &&
              Date.parse(String(r.lease_expires_at ?? "")) <= args.now_ms),
        )
        .sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at)),
        );
      for (const row of rows) {
        const fresh = this.store.tryGet<ReplanGenerationRecord>(
          REPLAN_GENERATION_ENTITY,
          row.replan_generation_id,
        );
        if (fresh == null) continue;
        if (this.slotResolved(fresh)) {
          this.transition(
            fresh,
            fresh.status === "STAGED" ? "CONSUMED" : "CANCELLED",
            "slot_resolved",
          );
          continue;
        }
        if (!this.wanted(fresh)) {
          this.transition(fresh, "CANCELLED", "recovery_chain_moved");
          continue;
        }
        if (args.now_ms >= Date.parse(fresh.deadline_at)) {
          this.transition(fresh, "FAILED", "deadline_exceeded", {
            kind: "TIMEOUT",
            code: "REPLAN_GENERATION_DEADLINE",
          });
          continue;
        }
        if (fresh.lease_count >= REPLAN_GENERATION_MAX_LEASES) {
          this.transition(fresh, "FAILED", "lease_exhausted", {
            kind: "GENERATION_FAILED",
            code: "REPLAN_GENERATION_LEASE_EXHAUSTED",
          });
          continue;
        }
        if (
          fresh.status === "LEASED" &&
          Date.parse(String(fresh.lease_expires_at ?? "")) > args.now_ms
        ) {
          continue; // another owner's live lease — single-flight holds
        }
        const leaseUntil = isoAfter(
          args.now_ms,
          Math.min(
            args.lease_ms,
            Math.max(0, Date.parse(fresh.deadline_at) - args.now_ms),
          ),
        );
        const updated: ReplanGenerationRecord = {
          ...fresh,
          status: "LEASED",
          lease_owner_id: String(args.owner_id),
          lease_epoch: Number(fresh.lease_epoch ?? 0) + 1,
          lease_expires_at: leaseUntil,
          lease_count: Number(fresh.lease_count ?? 0) + 1,
        };
        this.store.put(
          REPLAN_GENERATION_ENTITY,
          fresh.replan_generation_id,
          updated,
          Number(fresh.version),
        );
        this.store.event({
          entity_type: REPLAN_GENERATION_ENTITY,
          entity_id: fresh.replan_generation_id,
          event_type: "REPLAN_GENERATION_LEASED",
          old_state: String(fresh.status),
          new_state: "LEASED",
          actor: "PAIR_REPLAN_GENERATION",
          metadata: {
            mission_id: fresh.mission_id,
            recovery_id: fresh.recovery_id,
            attempt_index: fresh.attempt_index,
            owner_id: String(args.owner_id),
            lease_epoch: updated.lease_epoch,
            lease_expires_at: leaseUntil,
          },
        });
        return updated;
      }
      return null;
    });
  }

  /**
   * Settle a claimed row — exact (owner_id, lease_epoch) match required.
   * Returns false when the row has moved on (cancelled, re-claimed under
   * a newer epoch, or already terminal) — the caller's result is dropped,
   * never applied.
   */
  settle(
    generationId: string,
    ownerId: string,
    leaseEpoch: number,
    result:
      | {
          status: "STAGED";
          candidate: {
            tasks: Array<Record<string, unknown>>;
            plan_source?: string;
          };
          planner_run_id?: string | null;
        }
      | {
          status: "FAILED";
          outcome: { kind: ReplanGenerationOutcome; code: string | null };
          planner_run_id?: string | null;
        },
  ): boolean {
    return this.store.immediate(() => {
      const row = this.store.tryGet<ReplanGenerationRecord>(
        REPLAN_GENERATION_ENTITY,
        generationId,
      );
      if (
        row == null ||
        row.status !== "LEASED" ||
        String(row.lease_owner_id) !== ownerId ||
        Number(row.lease_epoch) !== leaseEpoch
      ) {
        return false;
      }
      const updated: ReplanGenerationRecord = {
        ...row,
        status: result.status,
        staged_candidate:
          result.status === "STAGED"
            ? {
                tasks: result.candidate.tasks,
                plan_source: result.candidate.plan_source ?? "LLM",
              }
            : row.staged_candidate,
        outcome:
          result.status === "FAILED"
            ? { kind: result.outcome.kind, code: result.outcome.code }
            : row.outcome,
        planner_run_id:
          result.planner_run_id != null
            ? String(result.planner_run_id)
            : row.planner_run_id,
        lease_expires_at: null,
      };
      this.store.put(
        REPLAN_GENERATION_ENTITY,
        generationId,
        updated,
        Number(row.version),
      );
      this.store.event({
        entity_type: REPLAN_GENERATION_ENTITY,
        entity_id: generationId,
        event_type:
          result.status === "STAGED"
            ? "REPLAN_GENERATION_STAGED"
            : "REPLAN_GENERATION_FAILED",
        old_state: "LEASED",
        new_state: result.status,
        actor: "PAIR_REPLAN_GENERATION",
        metadata: {
          mission_id: row.mission_id,
          recovery_id: row.recovery_id,
          attempt_index: row.attempt_index,
          owner_id: ownerId,
          lease_epoch: leaseEpoch,
          planner_run_id: updated.planner_run_id,
          outcome: updated.outcome,
        },
      });
      return true;
    });
  }

  /** Fetch a row for driver-side inspection. */
  get(generationId: string): ReplanGenerationRecord | null {
    return this.store.tryGet<ReplanGenerationRecord>(
      REPLAN_GENERATION_ENTITY,
      generationId,
    );
  }
}

export interface ReplanGenerationDriverDeps {
  service: ReplanGenerationService;
  /** The injected async seam — in production this is the SAME
   *  runPlannerFailover composition used by initial planning, with
   *  cost admission + planner-run evidence + model qualification.
   *  Must reject with a PairError carrying a FAIL_CLOSED_* code; the
   *  driver classifies it onto a typed generation outcome. */
  generate: (
    gen: ReplanGenerationRecord,
  ) => Promise<{
    tasks: Array<Record<string, unknown>>;
    planner_run_id?: string | null;
  }>;
  /** Durable owner identity — e.g. `replan-generation:<pid>`. */
  owner_id: string;
  /** Lease duration — must exceed the worst-case in-flight provider
   *  call so a healthy owner never loses its lease mid-run. */
  lease_ms: number;
  /** Max rows claimed per sweep — keeps the periodic driver bounded. */
  max_claims_per_sweep?: number;
  now_ms?: () => number;
}

/**
 * The periodic async driver. One sweep: reconcile → claim up to the
 * bound → for each claimed row run the injected async pool → settle
 * STAGED or FAILED. Safe under overlapping invocations because the
 * durable CAS lease + epoch is the single-flight authority.
 */
export function makeReplanGenerationDriver(
  deps: ReplanGenerationDriverDeps,
): () => Promise<{
  claimed: string[];
  staged: string[];
  failed: string[];
  cancelled: number;
  consumed: number;
}> {
  const nowMs = deps.now_ms ?? (() => Date.now());
  const bound = Math.max(
    1,
    Math.min(Number(deps.max_claims_per_sweep ?? 4), 16),
  );
  return async function sweep() {
    const rec = deps.service.reconcile({ nowMs: nowMs() });
    const out = {
      claimed: [] as string[],
      staged: [] as string[],
      failed: [] as string[],
      cancelled: rec.cancelled,
      consumed: rec.consumed,
    };
    for (let i = 0; i < bound; i++) {
      const gen = deps.service.claimNext({
        owner_id: deps.owner_id,
        lease_ms: deps.lease_ms,
        now_ms: nowMs(),
      });
      if (gen == null) break;
      out.claimed.push(gen.replan_generation_id);
      try {
        const res = await deps.generate(gen);
        const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
        const applied = deps.service.settle(
          gen.replan_generation_id,
          deps.owner_id,
          Number(gen.lease_epoch),
          tasks.length
            ? {
                status: "STAGED",
                candidate: { tasks, plan_source: "LLM" },
                planner_run_id: res.planner_run_id ?? null,
              }
            : {
                // A provider "winner" with no tasks is a generation
                // failure, never a staged candidate — the REPLAN goes
                // infeasible, no slot is consumed.
                status: "FAILED",
                outcome: {
                  kind: "GENERATION_FAILED",
                  code: "REPLAN_GENERATION_EMPTY_CANDIDATE",
                },
                planner_run_id: res?.planner_run_id ?? null,
              },
        );
        if (applied) {
          (tasks.length ? out.staged : out.failed).push(
            gen.replan_generation_id,
          );
        }
      } catch (err) {
        const outcome = classifyReplanGenerationFailure(err);
        const plannerRunId =
          (err as { planner_run_id?: unknown })?.planner_run_id != null
            ? String((err as { planner_run_id?: unknown }).planner_run_id)
            : null;
        const applied = deps.service.settle(
          gen.replan_generation_id,
          deps.owner_id,
          Number(gen.lease_epoch),
          { status: "FAILED", outcome, planner_run_id: plannerRunId },
        );
        if (applied) out.failed.push(gen.replan_generation_id);
      }
    }
    return out;
  };
}
