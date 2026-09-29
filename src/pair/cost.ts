/**
 * P13 cost governance — atomic monetary authority for NEW external
 * dispatch. Distinct from P11 `budget_policy` (mission COUNT budgets);
 * this module governs money: integer microusd only, never floats.
 *
 * Entities (all canonical, secret-free):
 *   cost_policy      — scoped hard/soft monetary caps
 *   cost_profile     — versioned pricing evidence per route/model/executor
 *   cost_reservation — per-governed-task spend reservation lifecycle
 *
 * Lifecycle: HELD → COMMITTED → SETTLED, or HELD → RELEASED.
 * Reservation identity is the governed task (`CRSV_<governedTaskId>`):
 * the same governed dispatch can never be charged twice, a historical
 * execution never creates a new reservation, and crash reconciliation
 * derives state only from canonical evidence (intent / execution /
 * dispatch_evidence), never from memory or TTL.
 */
import fs from "node:fs";
import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { PairControlPlane } from "./service.js";

export const COST_SCHEMA = "pair.os.vnext.cost.v1";
export const BILLING_MODES = [
  "METERED_API",
  "SUBSCRIPTION",
  "FREE",
  "UNMETERED",
  "UNKNOWN",
] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const COST_PERIODS = ["DAY", "WEEK", "MONTH", "MISSION_LIFETIME"] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];

export const COST_SCOPES = ["business", "department", "agent", "mission"] as const;
export type CostScope = (typeof COST_SCOPES)[number];

export const RESERVATION_STATES = ["HELD", "COMMITTED", "SETTLED", "RELEASED"] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

const POLICY_KEYS = new Set([
  "scope_type",
  "scope_id",
  "period",
  "max_microusd",
  "hard_stop",
  "warning_threshold_pct",
  "enabled",
]);

const PROFILE_KEYS = new Set([
  "ref_type",
  "ref_id",
  "provider_id",
  "model_entry_id",
  "route_id",
  "billing_mode",
  "fixed_microusd",
  "input_microusd_per_mtok",
  "output_microusd_per_mtok",
  "reserve_microusd",
  "currency",
  "source",
  "effective_at",
  "status",
]);

function assertMicrousd(field: string, value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new IntegrityError("FAIL_CLOSED_COST_AMOUNT_INVALID", `${field}=${String(value)}`);
  }
  return n;
}

function costPeriodStart(period: CostPeriod, now: Date): string {
  if (period === "MISSION_LIFETIME") return "";
  if (period === "DAY") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  if (period === "MONTH") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString();
}

export class CostService {
  constructor(
    private readonly service: PairControlPlane,
    private readonly deps: { costHaltFile?: string | null } = {},
  ) {}

  private get store(): PairEvidenceStore {
    return this.service.store;
  }

  /* ---------------- cost_policy ------------------------------------------ */

  upsertCostPolicy(
    input: Record<string, unknown>,
    actor: string,
    expectedVersion?: number,
  ): Record<string, unknown> {
    for (const k of Object.keys(input)) {
      if (!POLICY_KEYS.has(k) && k !== "cost_policy_id" && k !== "business_id") {
        throw new IntegrityError("FAIL_CLOSED_COST_POLICY_FIELDS", k);
      }
    }
    const businessId = String(input.business_id ?? "");
    const scopeType = String(input.scope_type ?? "") as CostScope;
    const scopeId = String(input.scope_id ?? "");
    const period = String(input.period ?? "") as CostPeriod;
    const maxMicrousd = assertMicrousd("max_microusd", input.max_microusd);
    if (!(maxMicrousd > 0)) {
      throw new IntegrityError("FAIL_CLOSED_COST_MAX", String(input.max_microusd));
    }
    if (!businessId) {
      throw new IntegrityError("FAIL_CLOSED_COST_SCOPE_BUSINESS", "business_id required");
    }
    if (!this.store.tryGet("business", businessId)) {
      throw new IntegrityError("FAIL_CLOSED_COST_BUSINESS_UNKNOWN", businessId);
    }
    if (!COST_SCOPES.includes(scopeType)) {
      throw new IntegrityError("FAIL_CLOSED_COST_SCOPE_TYPE", scopeType);
    }
    if (!scopeId) throw new IntegrityError("FAIL_CLOSED_COST_SCOPE_ID", "scope_id required");
    if (!COST_PERIODS.includes(period)) {
      throw new IntegrityError("FAIL_CLOSED_COST_PERIOD", period);
    }
    if (scopeType === "mission" && period !== "MISSION_LIFETIME") {
      throw new IntegrityError("FAIL_CLOSED_COST_PERIOD", `${scopeType}:${period}`);
    }
    // Dangling/cross-business scope references fail closed.
    if (scopeType === "agent") {
      const agent = this.store.tryGet("org_agent", scopeId);
      if (!agent) throw new IntegrityError("FAIL_CLOSED_COST_SCOPE_DANGLING", scopeId);
      if (String(agent.business_id) !== businessId) {
        throw new IntegrityError("FAIL_CLOSED_COST_CROSS_BUSINESS", scopeId);
      }
    } else if (scopeType === "mission") {
      const mission = this.store.tryGet("mission", scopeId);
      if (!mission) throw new IntegrityError("FAIL_CLOSED_COST_SCOPE_DANGLING", scopeId);
      const mb = (mission.metadata as Record<string, unknown> | undefined)?.business_id;
      if (String(mb ?? "") !== businessId) {
        throw new IntegrityError("FAIL_CLOSED_COST_CROSS_BUSINESS", scopeId);
      }
    } else if (scopeType === "department") {
      // Departments exist only through agents — a department with no agent
      // of this business is a dangling reference.
      const has = this.store
        .list("org_agent")
        .some((a) => String(a.business_id) === businessId && String(a.department ?? "") === scopeId);
      if (!has) throw new IntegrityError("FAIL_CLOSED_COST_SCOPE_DANGLING", scopeId);
    }
    const warn =
      input.warning_threshold_pct == null
        ? null
        : Number(input.warning_threshold_pct);
    if (warn != null && (!(warn > 0) || warn > 100)) {
      throw new IntegrityError("FAIL_CLOSED_COST_WARNING_THRESHOLD", String(warn));
    }
    const id =
      input.cost_policy_id && this.store.tryGet("cost_policy", String(input.cost_policy_id))
        ? String(input.cost_policy_id)
        : newId("CPO");
    const existing = this.store.tryGet("cost_policy", id);
    const row = {
      schema: COST_SCHEMA,
      cost_policy_id: id,
      business_id: businessId,
      scope_type: scopeType,
      scope_id: scopeId,
      period,
      max_microusd: maxMicrousd,
      hard_stop: input.hard_stop !== false,
      warning_threshold_pct: warn,
      enabled: input.enabled !== false,
      actor,
      created_at: existing ? String(existing.created_at) : utcnow(),
      updated_at: utcnow(),
      version: existing ? Number(existing.version) : 0,
    };
    const saved = this.store.put(
      "cost_policy",
      id,
      row,
      expectedVersion !== undefined ? expectedVersion : Number(row.version),
    );
    this.store.event({
      entity_type: "cost_policy",
      entity_id: id,
      event_type: existing ? "COST_POLICY_UPDATED" : "COST_POLICY_CREATED",
      actor,
      metadata: {
        scope_type: scopeType,
        scope_id: scopeId,
        period,
        max_microusd: maxMicrousd,
        enabled: row.enabled,
      },
    });
    return saved;
  }

  listCostPolicies(businessId?: string): Array<Record<string, unknown>> {
    const all = this.store.list("cost_policy");
    return businessId ? all.filter((p) => String(p.business_id) === businessId) : all;
  }

  /* ---------------- cost_profile ----------------------------------------- */

  upsertCostProfile(
    input: Record<string, unknown>,
    actor: string,
    expectedVersion?: number,
  ): Record<string, unknown> {
    for (const k of Object.keys(input)) {
      if (!PROFILE_KEYS.has(k)) {
        throw new IntegrityError("FAIL_CLOSED_COST_PROFILE_FIELDS", k);
      }
    }
    const refType = String(input.ref_type ?? "");
    const refId = String(input.ref_id ?? "");
    const billingMode = String(input.billing_mode ?? "") as BillingMode;
    if (!["route", "model", "executor"].includes(refType)) {
      throw new IntegrityError("FAIL_CLOSED_COST_PROFILE_REF", refType);
    }
    if (!refId) throw new IntegrityError("FAIL_CLOSED_COST_PROFILE_REF", "ref_id required");
    if (!BILLING_MODES.includes(billingMode)) {
      throw new IntegrityError("FAIL_CLOSED_COST_BILLING_MODE", billingMode);
    }
    const currency = String(input.currency ?? "USD");
    if (currency !== "USD") {
      // §6: non-USD requires canonical conversion evidence — none exists.
      throw new IntegrityError("FAIL_CLOSED_COST_CURRENCY", currency);
    }
    for (const f of [
      "fixed_microusd",
      "input_microusd_per_mtok",
      "output_microusd_per_mtok",
      "reserve_microusd",
    ]) {
      if (input[f] != null) assertMicrousd(f, input[f]);
    }
    const id = `CPRO_${refType}_${digest(`${refType}:${refId}`).slice(0, 20)}`;
    const existing = this.store.tryGet("cost_profile", id);
    const row = {
      schema: COST_SCHEMA,
      cost_profile_id: id,
      ref_type: refType,
      ref_id: refId,
      provider_id: input.provider_id ?? null,
      model_entry_id: input.model_entry_id ?? null,
      route_id: input.route_id ?? (refType === "route" ? refId : null),
      billing_mode: billingMode,
      fixed_microusd: input.fixed_microusd ?? null,
      input_microusd_per_mtok: input.input_microusd_per_mtok ?? null,
      output_microusd_per_mtok: input.output_microusd_per_mtok ?? null,
      reserve_microusd: input.reserve_microusd ?? null,
      currency: "USD",
      source: String(input.source ?? actor),
      effective_at: String(input.effective_at ?? utcnow()),
      status: input.status ?? "ACTIVE",
      created_at: existing ? String(existing.created_at) : utcnow(),
      updated_at: utcnow(),
      version: existing ? Number(existing.version) : 0,
    };
    const saved = this.store.put(
      "cost_profile",
      id,
      row,
      expectedVersion !== undefined ? expectedVersion : Number(row.version),
    );
    this.store.event({
      entity_type: "cost_profile",
      entity_id: id,
      event_type: existing ? "COST_PROFILE_UPDATED" : "COST_PROFILE_CREATED",
      actor,
      metadata: { ref_type: refType, ref_id: refId, billing_mode: billingMode },
    });
    return saved;
  }

  listCostProfiles(): Array<Record<string, unknown>> {
    return this.store.list("cost_profile");
  }

  private profileFor(refType: string, refId: string | null | undefined) {
    if (!refId) return null;
    const id = `CPRO_${refType}_${digest(`${refType}:${refId}`).slice(0, 20)}`;
    const p = this.store.tryGet("cost_profile", id);
    return p && String(p.status) === "ACTIVE" ? p : null;
  }

  /**
   * Resolve the billing mode for a dispatch: route profile → model profile
   * → executor profile → executor defaults (PAIR_NATIVE = UNMETERED) →
   * UNKNOWN. UNKNOWN is never coerced to FREE.
   */
  billingFor(
    executorId: string,
    routeId: string | null,
  ): { mode: BillingMode; profile: Record<string, unknown> | null; unbounded: boolean } {
    const profile =
      this.profileFor("route", routeId) ??
      this.profileFor("model", routeId ? this.modelRefForRoute(routeId) : null) ??
      this.profileFor("executor", executorId);
    if (!profile) {
      const mode: BillingMode = executorId === "PAIR_NATIVE" ? "UNMETERED" : "UNKNOWN";
      return { mode, profile: null, unbounded: mode === "UNKNOWN" };
    }
    const mode = String(profile.billing_mode) as BillingMode;
    if (mode !== "METERED_API") return { mode, profile, unbounded: false };
    const bounded = profile.reserve_microusd != null || profile.fixed_microusd != null;
    return { mode, profile, unbounded: !bounded };
  }

  private modelRefForRoute(routeId: string): string | null {
    const route = this.store.tryGet("route", routeId);
    const mid = route?.model_entry_id ?? route?.model_id ?? null;
    return mid ? String(mid) : null;
  }

  private reserveAmount(profile: Record<string, unknown> | null): number {
    if (!profile) return 0;
    if (profile.reserve_microusd != null) return Number(profile.reserve_microusd);
    if (profile.fixed_microusd != null) return Number(profile.fixed_microusd);
    return 0;
  }

  /** Cost halt: PAIR_COST_HALT=1 or the runtime halt file. */
  private haltActive(): boolean {
    return (
      process.env.PAIR_COST_HALT === "1" ||
      (this.deps.costHaltFile ? !!this.deps.costHaltFile && this.fileExists(this.deps.costHaltFile) : false)
    );
  }

  private fileExists(p: string): boolean {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }

  /* ---------------- atomic pre-dispatch authority ------------------------ */

  /**
   * P13 §14: called AFTER assertAgentExecutionAllowed and BEFORE a NEW
   * adapter.dispatch — one atomic check-and-hold inside BEGIN IMMEDIATE.
   * Returns the canonical HELD reservation (idempotent per governed task).
   * Never called for proven historical dispatches.
   */
  assertAndReserve(params: {
    mission: Record<string, unknown>;
    task: Record<string, unknown>;
    governedTask: Record<string, unknown>;
    executorId: string;
  }): Record<string, unknown> {
    const governedTaskId = String(params.governedTask.governed_task_id);
    const resId = `CRSV_${governedTaskId}`;
    const existing = this.store.tryGet("cost_reservation", resId);
    if (existing && String(existing.status) !== "RELEASED") {
      return existing; // same governed dispatch → same canonical reservation
    }
    if (existing && String(existing.status) === "RELEASED") {
      // Retry after a proven no-dispatch release: re-hold the same
      // canonical reservation rather than minting a second charge.
      return this.transitionIfCurrent(resId, ["RELEASED"], "HELD", {
        updated_at: utcnow(),
      }) as Record<string, unknown>;
    }
    const mission = params.mission;
    const md = (mission.metadata ?? {}) as Record<string, unknown>;
    const businessId = String(md.business_id ?? "");
    const department = String(md.department ?? "");
    const agentId = md.org_agent_id ? String(md.org_agent_id) : "";
    const missionId = String(mission.mission_id);
    const routeId = params.task.selected_route_id ? String(params.task.selected_route_id) : null;
    const billing = this.billingFor(params.executorId, routeId);

    // §18: halt blocks cost-bearing NEW dispatch (METERED_API and UNKNOWN —
    // UNKNOWN may carry cost). FREE/SUBSCRIPTION/UNMETERED remain allowed.
    if (this.haltActive() && (billing.mode === "METERED_API" || billing.mode === "UNKNOWN")) {
      this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
        reason: "FAIL_CLOSED_COST_HALT",
        governed_task_id: governedTaskId,
        billing_mode: billing.mode,
      });
      throw new PolicyError("FAIL_CLOSED_COST_HALT", governedTaskId);
    }

    const policies = this.listCostPolicies().filter((p) => p.enabled !== false);
    const applicable = policies.filter(
      (p) =>
        String(p.business_id) === businessId &&
        ((p.scope_type === "business" && p.scope_id === businessId) ||
          (p.scope_type === "department" && p.scope_id === department) ||
          (p.scope_type === "agent" && p.scope_id === agentId) ||
          (p.scope_type === "mission" && p.scope_id === missionId)),
    );
    const hard = applicable.filter((p) => p.hard_stop !== false);

    // §9: a hard policy cannot be enforced against an unbounded METERED
    // cost — fail closed rather than guess.
    if (billing.mode === "METERED_API" && billing.unbounded && hard.length > 0) {
      this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
        reason: "FAIL_CLOSED_COST_UNBOUNDED",
        governed_task_id: governedTaskId,
        policy_ids: hard.map((p) => p.cost_policy_id),
      });
      throw new PolicyError("FAIL_CLOSED_COST_UNBOUNDED", governedTaskId);
    }

    const requested = billing.unbounded ? 0 : this.reserveAmount(billing.profile);

    const outcome = this.store.immediate(() => {
      const reservations = this.store.list("cost_reservation");
      const violations: Array<Record<string, unknown>> = [];
      const warnings: Array<Record<string, unknown>> = [];
      for (const p of applicable) {
        const since = costPeriodStart(p.period as CostPeriod, new Date());
        const matches = (r: Record<string, unknown>) => {
          if (String(r.business_id ?? "") !== String(p.business_id)) return false;
          if (since && String(r.created_at ?? "") < since) return false;
          const st = String(r.status);
          if (st !== "HELD" && st !== "COMMITTED" && st !== "SETTLED") return false;
          switch (p.scope_type) {
            case "business":
              return true;
            case "department":
              return String(r.department ?? "") === String(p.scope_id);
            case "agent":
              return String(r.agent_id ?? "") === String(p.scope_id);
            case "mission":
              return String(r.mission_id ?? "") === String(p.scope_id);
            default:
              return false;
          }
        };
        const used = reservations
          .filter(matches)
          .reduce(
            (acc, r) =>
              acc +
              Number(
                String(r.status) === "SETTLED" ? r.settled_microusd : r.reserved_microusd,
              ),
            0,
          );
        const after = used + requested;
        const max = Number(p.max_microusd);
        if (p.hard_stop !== false && after > max) {
          violations.push({
            cost_policy_id: p.cost_policy_id,
            scope_type: p.scope_type,
            scope_id: p.scope_id,
            used_microusd: used,
            requested_microusd: requested,
            max_microusd: max,
          });
          continue;
        }
        if (
          p.warning_threshold_pct != null &&
          used + requested > (Number(p.warning_threshold_pct) / 100) * max &&
          used <= (Number(p.warning_threshold_pct) / 100) * max
        ) {
          warnings.push({
            cost_policy_id: p.cost_policy_id,
            scope_type: p.scope_type,
            scope_id: p.scope_id,
            used_microusd: used + requested,
            max_microusd: max,
          });
        }
      }
      if (violations.length) return { violations, warnings, saved: null };
      const row = {
        schema: COST_SCHEMA,
        reservation_id: resId,
        governed_task_id: governedTaskId,
        mission_id: missionId,
        task_id: String(params.governedTask.task_id),
        executor_id: params.executorId,
        route_id: routeId,
        business_id: businessId || null,
        department: department || null,
        agent_id: agentId || null,
        billing_mode: billing.mode,
        cost_profile_id: billing.profile ? String(billing.profile.cost_profile_id) : null,
        reserved_microusd: requested,
        settled_microusd: null,
        usage_state: null,
        unbounded: billing.unbounded,
        status: "HELD",
        created_at: utcnow(),
        updated_at: utcnow(),
        version: 0,
      };
      const saved = this.store.put("cost_reservation", resId, row, 0);
      return { violations: [], warnings, saved };
    });

    for (const w of outcome.warnings) {
      this.store.appendEvidence(missionId, "COST_BUDGET_WARNING", {
        cost_policy_id: w.cost_policy_id,
        used_microusd: w.used_microusd,
        max_microusd: w.max_microusd,
        governed_task_id: governedTaskId,
      });
    }
    if (outcome.violations.length) {
      for (const v of outcome.violations) {
        this.store.event({
          entity_type: "cost_policy",
          entity_id: String(v.cost_policy_id),
          event_type: "COST_BUDGET_EXCEEDED",
          actor: "PAIR_COST_GOVERNANCE",
          metadata: {
            scope_type: v.scope_type,
            scope_id: v.scope_id,
            used_microusd: v.used_microusd,
            requested_microusd: v.requested_microusd,
            max_microusd: v.max_microusd,
          },
        });
        this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
          reason: "FAIL_CLOSED_COST_BUDGET_EXCEEDED",
          governed_task_id: governedTaskId,
          cost_policy_id: v.cost_policy_id,
          used_microusd: v.used_microusd,
          requested_microusd: v.requested_microusd,
          max_microusd: v.max_microusd,
        });
      }
      const v = outcome.violations[0];
      throw new PolicyError(
        "FAIL_CLOSED_COST_BUDGET_EXCEEDED",
        `${String(v.scope_type)}:${String(v.scope_id)} ${String(v.used_microusd)}+${String(v.requested_microusd)}>${String(v.max_microusd)}`,
      );
    }
    return outcome.saved as Record<string, unknown>;
  }

  /* ---------------- lifecycle -------------------------------------------- */

  private transition(
    reservation: Record<string, unknown>,
    to: ReservationState,
    patch: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const next = {
      ...reservation,
      ...patch,
      status: to,
      updated_at: utcnow(),
    };
    const saved = this.store.put(
      "cost_reservation",
      String(reservation.reservation_id),
      next,
      Number(reservation.version),
    );
    this.store.event({
      entity_type: "cost_reservation",
      entity_id: String(reservation.reservation_id),
      event_type: `COST_RESERVATION_${to}`,
      old_state: String(reservation.status),
      new_state: to,
      actor: "PAIR_COST_GOVERNANCE",
      metadata: { governed_task_id: reservation.governed_task_id },
    });
    return saved;
  }

  private transitionIfCurrent(
    resId: string,
    expect: ReservationState[],
    to: ReservationState,
    patch: Record<string, unknown> = {},
  ): Record<string, unknown> | null {
    const r = this.store.tryGet("cost_reservation", resId);
    if (!r || !expect.includes(String(r.status) as ReservationState)) return r;
    try {
      return this.transition(r, to, patch);
    } catch (e) {
      // CAS loser — adopt the canonical committed row.
      if ((e as { code?: string }).code === "FAIL_CLOSED_VERSION_CONFLICT") {
        return this.store.get("cost_reservation", resId);
      }
      throw e;
    }
  }

  /** Proven external dispatch → capacity can no longer be released. */
  markCommitted(governedTaskId: string): void {
    this.transitionIfCurrent(`CRSV_${governedTaskId}`, ["HELD"], "COMMITTED");
  }

  /** Proven that NO external dispatch happened → free the capacity. */
  markReleased(governedTaskId: string): void {
    this.transitionIfCurrent(`CRSV_${governedTaskId}`, ["HELD"], "RELEASED");
  }

  /**
   * §16 settlement: actual usage in microusd settles exactly; unknown
   * actual usage stays COMMITTED at reserved maximum — a hard budget is
   * never under-counted.
   */
  settle(governedTaskId: string, actualMicrousd?: number | null): Record<string, unknown> | null {
    const resId = `CRSV_${governedTaskId}`;
    const r = this.store.tryGet("cost_reservation", resId);
    if (!r || String(r.status) === "RELEASED" || String(r.status) === "SETTLED") return r;
    if (actualMicrousd != null) {
      assertMicrousd("actual_microusd", actualMicrousd);
      return this.transitionIfCurrent(resId, ["HELD", "COMMITTED"], "SETTLED", {
        settled_microusd: actualMicrousd,
        usage_state: "ACTUAL_SETTLED",
      });
    }
    return this.transitionIfCurrent(resId, ["HELD", "COMMITTED"], "COMMITTED", {
      usage_state: "ACTUAL_USAGE_UNKNOWN",
    });
  }

  /**
   * §16 settlement from adapter-proven result: an explicit cost figure
   * settles exactly; token counts settle via the reservation's versioned
   * profile; nothing provable stays COMMITTED at reserved maximum with
   * ACTUAL_USAGE_UNKNOWN — never under-counted.
   */
  settleFromResult(governedTaskId: string, result: Record<string, unknown>): void {
    const resId = `CRSV_${governedTaskId}`;
    const r = this.store.tryGet("cost_reservation", resId);
    if (!r || String(r.status) === "RELEASED" || String(r.status) === "SETTLED") return;
    let actual: number | null = null;
    const direct = result.actual_microusd ?? result.cost_microusd;
    if (direct != null && Number.isInteger(Number(direct)) && Number(direct) >= 0) {
      actual = Number(direct);
    } else if (
      r.cost_profile_id &&
      Number.isInteger(Number(result.input_tokens)) &&
      Number.isInteger(Number(result.output_tokens))
    ) {
      const profile = this.store.tryGet("cost_profile", String(r.cost_profile_id));
      if (
        profile &&
        (profile.input_microusd_per_mtok != null || profile.output_microusd_per_mtok != null)
      ) {
        actual =
          Number(profile.fixed_microusd ?? 0) +
          Math.ceil((Number(result.input_tokens) * Number(profile.input_microusd_per_mtok ?? 0)) / 1_000_000) +
          Math.ceil((Number(result.output_tokens) * Number(profile.output_microusd_per_mtok ?? 0)) / 1_000_000);
      }
    }
    this.settle(governedTaskId, actual);
  }

  /* ---------------- crash / reconciliation ------------------------------- */

  /**
   * §15/§38: reconcile ONE governed task's reservation from canonical
   * evidence only — never memory, never TTL.
   *   intent EXECUTION_PERSISTED          → COMMITTED
   *   INTENT_RECORDED + proven dispatch   → COMMITTED
   *   INTENT_RECORDED + proven NO dispatch→ RELEASED
   *   intent absent                       → RELEASED (dispatch never began)
   *   INTENT_RECORDED, evidence absent    → HELD (ambiguous — stays reserved)
   */
  reconcileForTask(governedTaskId: string, adapter?: { dispatch_evidence?: (id: string) => { dispatched?: boolean } | undefined }): void {
    const resId = `CRSV_${governedTaskId}`;
    const r = this.store.tryGet("cost_reservation", resId);
    if (!r || String(r.status) === "SETTLED" || String(r.status) === "RELEASED") return;
    const intent = this.store.tryGet("executor_dispatch_intent", `INTENT_${governedTaskId}`);
    if (!intent) {
      this.transitionIfCurrent(resId, ["HELD"], "RELEASED");
      return;
    }
    if (String(intent.state) === "EXECUTION_PERSISTED") {
      this.transitionIfCurrent(resId, ["HELD"], "COMMITTED");
      return;
    }
    const ev = adapter?.dispatch_evidence?.(governedTaskId);
    if (ev?.dispatched === true) {
      this.transitionIfCurrent(resId, ["HELD"], "COMMITTED");
    } else if (ev && ev.dispatched === false) {
      this.transitionIfCurrent(resId, ["HELD"], "RELEASED");
    }
    // evidence absent/ambiguous → remains conservatively HELD.
  }

  /** Sweep all live reservations; adapter evidence unavailable → HELD rows
   *  with a recorded intent stay conservative until a dispatch-path
   *  reconcile can consult the adapter. */
  reconcileAll(adapters?: Map<string, { dispatch_evidence?: (id: string) => { dispatched?: boolean } | undefined }>): number {
    let touched = 0;
    for (const r of this.store.list("cost_reservation")) {
      const st = String(r.status);
      if (st !== "HELD" && st !== "COMMITTED") continue;
      const gtid = String(r.governed_task_id);
      const adapter = adapters?.get(String(r.executor_id));
      const before = String(this.store.tryGet("cost_reservation", `CRSV_${gtid}`)?.status ?? "");
      this.reconcileForTask(gtid, adapter);
      const after = String(this.store.tryGet("cost_reservation", `CRSV_${gtid}`)?.status ?? "");
      if (before !== after) touched += 1;
    }
    return touched;
  }

  /* ---------------- read model ------------------------------------------- */

  position(): Record<string, unknown> {
    const reservations = this.store.list("cost_reservation");
    const byStatus = (s: string) => reservations.filter((r) => String(r.status) === s);
    const sum = (rows: Array<Record<string, unknown>>, field: string) =>
      rows.reduce((a, r) => a + Number(r[field] ?? 0), 0);
    const byBilling: Record<string, number> = {};
    for (const r of reservations) {
      const m = String(r.billing_mode);
      byBilling[m] = (byBilling[m] ?? 0) + 1;
    }
    const held = byStatus("HELD");
    const committed = byStatus("COMMITTED");
    const settled = byStatus("SETTLED");
    return {
      policies: this.listCostPolicies(),
      profiles: this.listCostProfiles(),
      reservations_held: held,
      reservations_committed: committed,
      held_microusd: sum(held, "reserved_microusd"),
      committed_microusd: sum(committed, "reserved_microusd"),
      settled_microusd: sum(settled, "settled_microusd"),
      billing_mode_breakdown: byBilling,
      unpriced_dispatches: reservations.filter((r) => r.unbounded === true).length,
      cost_halt: this.haltActive(),
    };
  }
}
