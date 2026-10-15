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
import { CODEX_EXECUTOR_ID } from "./codex-adapter.js";
import { assertCanonicalObjectiveBudget } from "./objective-authority.js";
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

/** Phase C — canonical executor identity for LLM Planner Pool provider
 *  invocations that are NOT the codex_cli transport (codex_cli planner
 *  calls carry CODEX_EXECUTOR_ID — the real governed executor class).
 *  An executor cost_profile with ref_id "PAIR_PLANNER" prices generic
 *  planner calls; model profiles (ref_id = model_entry_id) always win. */
export const PLANNER_EXECUTOR_ID = "PAIR_PLANNER";

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
    // R4 §2: a caller-supplied cost_policy_id is THE create identity —
    // honored exactly, never silently replaced by a generated id.
    const id = input.cost_policy_id ? String(input.cost_policy_id) : newId("CPO");
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

  /** R3 §3 + R4 §2: create is INSERT-ONLY, enforced atomically at the
   *  storage CAS boundary — the check+insert run inside one BEGIN
   *  IMMEDIATE transaction and the write itself expects version 0, so a
   *  racing creator's commit turns into FAIL_CLOSED_COST_POLICY_EXISTS
   *  and can never silently update the winner's row. */
  createCostPolicy(input: Record<string, unknown>, actor: string): Record<string, unknown> {
    try {
      return this.store.immediate(() => this.upsertCostPolicy(input, actor, 0));
    } catch (e) {
      if (e instanceof IntegrityError && e.code === "FAIL_CLOSED_VERSION_CONFLICT") {
        throw new IntegrityError(
          "FAIL_CLOSED_COST_POLICY_EXISTS",
          `${String(input.cost_policy_id ?? "")} — use /api/cost-policies/update with expected_version`,
        );
      }
      throw e;
    }
  }

  /** R1 §6: an update must never silently create — the id is required
   *  and must resolve to the canonical row. */
  updateCostPolicy(
    input: Record<string, unknown>,
    actor: string,
    expectedVersion: number,
  ): Record<string, unknown> {
    const id = String(input.cost_policy_id ?? "");
    if (!id || !this.store.tryGet("cost_policy", id)) {
      throw new IntegrityError("FAIL_CLOSED_COST_POLICY_NOT_FOUND", id);
    }
    return this.upsertCostPolicy({ ...input, cost_policy_id: id }, actor, expectedVersion);
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

  /** R3 §3 + R4 §2: create is INSERT-ONLY, enforced atomically at the
   *  storage CAS boundary — the deterministic (ref_type, ref_id) identity
   *  either inserts fresh or fails FAIL_CLOSED_COST_PROFILE_EXISTS; a
   *  concurrent create can never become an update of the winner's row. */
  createCostProfile(input: Record<string, unknown>, actor: string): Record<string, unknown> {
    try {
      return this.store.immediate(() => this.upsertCostProfile(input, actor, 0));
    } catch (e) {
      if (e instanceof IntegrityError && e.code === "FAIL_CLOSED_VERSION_CONFLICT") {
        const refType = String(input.ref_type ?? "");
        const refId = String(input.ref_id ?? "");
        throw new IntegrityError(
          "FAIL_CLOSED_COST_PROFILE_EXISTS",
          `${refType}:${refId} — use /api/cost-profiles/update with expected_version`,
        );
      }
      throw e;
    }
  }

  /** R1 §6: update resolves the ref identity — it must already exist. */
  updateCostProfile(
    input: Record<string, unknown>,
    actor: string,
    expectedVersion: number,
  ): Record<string, unknown> {
    const refType = String(input.ref_type ?? "");
    const refId = String(input.ref_id ?? "");
    const id = `CPRO_${refType}_${digest(`${refType}:${refId}`).slice(0, 20)}`;
    if (!this.store.tryGet("cost_profile", id)) {
      throw new IntegrityError("FAIL_CLOSED_COST_PROFILE_NOT_FOUND", id);
    }
    return this.upsertCostProfile(input, actor, expectedVersion);
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
    // R1 §2 + R2 §3 boundedness: a positive reserve_microusd is the only
    // ceiling; a positive stated fixed fee with no metered rates is a
    // bounded charge. "0 supplied" — reserve 0/absent, or fixed_microusd=0
    // with no rates — is NOT a conservative bound for a metered call:
    // it stays unbounded and fails closed under a hard policy. A truly
    // free route belongs under FREE/UNMETERED, not METERED_API.
    const reserve = Number(profile.reserve_microusd ?? 0);
    const hasRates =
      Number(profile.input_microusd_per_mtok ?? 0) > 0 ||
      Number(profile.output_microusd_per_mtok ?? 0) > 0;
    const statedFixed = Number(profile.fixed_microusd ?? 0);
    const bounded = reserve > 0 || (!hasRates && statedFixed > 0);
    return { mode, profile, unbounded: !bounded };
  }

  private modelRefForRoute(routeId: string): string | null {
    const route = this.store.tryGet("route", routeId);
    const mid = route?.model_entry_id ?? route?.model_id ?? null;
    return mid ? String(mid) : null;
  }

  private reserveAmount(profile: Record<string, unknown> | null): number {
    if (!profile) return 0;
    const reserve = Number(profile.reserve_microusd ?? 0);
    if (reserve > 0) return reserve;
    return Number(profile.fixed_microusd ?? 0);
  }

  /** Canonical digest of the pricing fields pinned into a reservation. */
  private profilePinDigest(
    profile: Record<string, unknown>,
    reservationFields: Record<string, unknown>,
  ): string {
    return digest({
      cost_profile_id: profile.cost_profile_id,
      version: Number(profile.version),
      billing_mode: profile.billing_mode,
      fixed_microusd: reservationFields.profile_fixed_microusd ?? null,
      input_microusd_per_mtok: reservationFields.profile_input_microusd_per_mtok ?? null,
      output_microusd_per_mtok: reservationFields.profile_output_microusd_per_mtok ?? null,
      reserve_microusd: reservationFields.profile_reserve_microusd ?? null,
      currency: "USD",
      effective_at: reservationFields.pricing_effective_at ?? null,
    });
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

  /* ---------------- P15.10-C R3 — objective-scope lineage ---------------
   * The objective budget cap binds at THIS reservation boundary, with
   * the governed task's real route/executor identity. Canonical lineage
   * (all reads inside the caller's transaction):
   *   mission.bound_open_id → work_open_binding.work_item_id →
   *   workforce_allocation (workstream or delegated child) → objective
   *   → objective_auto_policy limits.budget_microusd_cap. */
  /** R4 F2-A: returns the objective scope, "BROKEN" when the mission
   *  claims an objective binding whose canonical lineage is missing or
   *  contradictory (never silently treated as a manual mission), or
   *  null when no objective claim exists at all. The work_item's own
   *  objective_id is the binding-claim authority; the allocation row
   *  is the objective linkage authority. */
  private objectiveScopeFor(missionId: string):
      { objective_id: string; cap: number | null } | "BROKEN" | null {
    const mission = this.store.tryGet("mission", missionId);
    const openId = mission?.bound_open_id;
    if (!openId) return null; // no binding claim → genuinely manual
    const wob = this.store.tryGet("work_open_binding", String(openId));
    if (!wob) return "BROKEN"; // binding claimed but the binding row is gone
    const wi = wob.work_item_id;
    if (!wi) return "BROKEN";
    return this.objectiveScopeForWorkItemId(String(wi));
  }

  /** Phase C — the same canonical lineage walk, entered at the work
   *  item: shared by mission-scoped reservations (via work_open_binding)
   *  and by pre-mission planner invocations (delegated opens, where the
   *  mission does not exist yet). */
  private objectiveScopeForWorkItemId(wi: string):
      { objective_id: string; cap: number | null } | "BROKEN" | null {
    // Binding-claim authority: the work_item's own objective_id, or the
    // objective_id inherited through its parent chain (delegated
    // children carry parent_work_item_id, not their own marker). Walk
    // at most 8 hops; a cycle or a mid-chain missing parent means the
    // graph contradicts itself → BROKEN.
    let claimed: string | null = null;
    let cur: string | null = String(wi);
    const seen = new Set<string>();
    let leafExists = false;
    for (let hop = 0; cur && hop < 8; hop++) {
      if (seen.has(cur)) return "BROKEN";
      seen.add(cur);
      const item = this.store.tryGet("work_item", cur) as Record<string, unknown> | null;
      if (!item) {
        if (hop === 0) break; // leaf missing — undecidable here, allocs decide below
        return "BROKEN";      // parent pointer to a deleted row = tampered graph
      }
      if (hop === 0) leafExists = true;
      const oid = String(item.objective_id ?? "");
      if (oid) { claimed = oid; break; }
      cur = item.parent_work_item_id ? String(item.parent_work_item_id) : null;
    }
    const allocs = (this.store.list("workforce_allocation") as Array<Record<string, unknown>>)
      .filter((a) => String(a.workstream_work_item_id ?? "") === String(wi) ||
                    String(a.delegated_child_work_item_id ?? "") === String(wi));
    if (allocs.length === 0) {
      // No objective linkage anywhere: an item that CLAIMS an
      // objective (or one that cannot be resolved at all) is broken
      // lineage, not a manual mission.
      return (claimed !== null || !leafExists) ? "BROKEN" : null;
    }
    const a = claimed !== null
      ? allocs.find((x) => String(x.objective_id) === claimed)
      : allocs[0]!;
    if (!a) return "BROKEN"; // allocation exists but for a different objective → mismatch
    const oid = String(a.objective_id);
    const pol = this.store.tryGet("objective_auto_policy", `oap:${oid}`);
    const cap = (pol?.limits as Record<string, unknown> | null | undefined)
      ?.budget_microusd_cap;
    return { objective_id: oid, cap: cap == null ? null : Number(cap) };
  }

  /** Phase C — public objective-scope read for the shared
   *  planner-admission seam (a delegated open's lineage resolved BEFORE
   *  its mission exists). Same verdicts as the mission-scoped walk. */
  objectiveScopeForWorkItem(
    workItemId: string,
  ): { objective_id: string; cap: number | null } | "BROKEN" | null {
    return this.objectiveScopeForWorkItemId(workItemId);
  }

  /** Sum of every live reservation traceable to the objective — HELD /
   *  COMMITTED at reserved, SETTLED at settled, RELEASED skipped. */
  private objectiveAttributedMicrousd(objectiveId: string, reservations: Array<Record<string, unknown>>): number {
    const wis = new Set<string>();
    for (const a of this.store.list("workforce_allocation")) {
      if (String(a.objective_id) === objectiveId) {
        if (a.workstream_work_item_id) wis.add(String(a.workstream_work_item_id));
        if (a.delegated_child_work_item_id) wis.add(String(a.delegated_child_work_item_id));
      }
    }
    const mids = new Set<string>();
    for (const wob of this.store.list("work_open_binding")) {
      if (wis.has(String(wob.work_item_id ?? "")) && wob.mission_id) {
        mids.add(String(wob.mission_id));
      }
    }
    let total = 0;
    for (const r of reservations) {
      const st = String(r.status);
      if (st === "RELEASED") continue;
      const amount = st === "SETTLED"
        ? Number(r.settled_microusd ?? 0)
        : Number(r.reserved_microusd ?? 0);
      if (mids.has(String(r.mission_id ?? ""))) { total += amount; continue; }
      // Phase C — planner invocations attribute through the delegated
      // work item they planned for; no mission exists yet, and a
      // planner row can never alias a governed-task reservation
      // (different identity fields → never double-counted).
      if (r.planner_run_id != null && wis.has(String(r.work_item_id ?? ""))) {
        total += amount;
      }
    }
    return total;
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
    const mission = params.mission;
    const missionId = String(mission.mission_id);
    const md = (mission.metadata ?? {}) as Record<string, unknown>;
    // R3 §1: the pinned business_context (resolved from the canonical
    // org_agent at mission start) is the monetary scope authority —
    // caller-writable business_id/department fields are never trusted.
    // Missions created before pinning fall back to the legacy fields.
    const bc = (md.business_context ?? null) as Record<string, unknown> | null;
    const businessId = String(bc?.business_id ?? md.business_id ?? "");
    const department = String(bc?.department ?? md.department ?? "");
    const agentId = bc?.org_agent_id != null ? String(bc.org_agent_id) : md.org_agent_id ? String(md.org_agent_id) : "";
    const routeId = params.task.selected_route_id ? String(params.task.selected_route_id) : null;
    // R1 §1: a PROVEN historical charge (COMMITTED/SETTLED) is idempotently
    // adopted — it is never a new dispatch, so it needs no new authority.
    if (existing && (String(existing.status) === "COMMITTED" || String(existing.status) === "SETTLED")) {
      return existing;
    }
    // A leftover HELD row means the previous attempt's outcome is
    // ambiguous — reconcile derives truth from canonical evidence; it is
    // NEVER authority for a new dispatch. Fail closed until resolved.
    if (existing && String(existing.status) === "HELD") {
      this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
        reason: "FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS",
        governed_task_id: governedTaskId,
      });
      throw new PolicyError("FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS", governedTaskId);
    }
    // From here: no reservation, or a RELEASED one (proven no-dispatch).
    // A RELEASED reservation reused for a NEW dispatch must pass the
    // complete CURRENT cost decision again — halt, billing, policy caps
    // and re-pricing all apply at retry time.
    const reusingReleased = existing && String(existing.status) === "RELEASED";
    // F2-B R4: this pre-txn resolution is an ADVISORY snapshot only —
    // the authoritative pricing identity is re-resolved inside the
    // atomic check-and-reserve transaction below so a concurrent
    // profile/route edit can never slip spending authority through
    // a stale price.
    const billingPre = this.billingFor(params.executorId, routeId);

    // §18: halt blocks cost-bearing NEW dispatch (METERED_API and UNKNOWN —
    // UNKNOWN may carry cost). FREE/SUBSCRIPTION/UNMETERED remain allowed.
    if (this.haltActive() && (billingPre.mode === "METERED_API" || billingPre.mode === "UNKNOWN")) {
      this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
        reason: "FAIL_CLOSED_COST_HALT",
        governed_task_id: governedTaskId,
        billing_mode: billingPre.mode,
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

    // §9 + R2 §2: a hard monetary policy cannot be enforced against an
    // unbounded METERED_API cost, and it cannot be enforced against an
    // UNKNOWN billing mode at all — UNKNOWN may be a paid external route,
    // so a hard cap requires knowing the cost shape. Fail closed; never
    // fabricate $0.
    if (billingPre.mode === "UNKNOWN" && hard.length > 0) {
      this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
        reason: "FAIL_CLOSED_COST_UNKNOWN",
        governed_task_id: governedTaskId,
        policy_ids: hard.map((p) => p.cost_policy_id),
      });
      throw new PolicyError("FAIL_CLOSED_COST_UNKNOWN", governedTaskId);
    }
    if (billingPre.mode === "METERED_API" && billingPre.unbounded && hard.length > 0) {
      this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
        reason: "FAIL_CLOSED_COST_UNBOUNDED",
        governed_task_id: governedTaskId,
        policy_ids: hard.map((p) => p.cost_policy_id),
      });
      throw new PolicyError("FAIL_CLOSED_COST_UNBOUNDED", governedTaskId);
    }

    const outcome = this.store.immediate(() => {
      // F2-B R4: pricing identity + amount are re-resolved INSIDE the
      // atomic transaction — the advisory outer read is never trusted.
      const billing = this.billingFor(params.executorId, routeId);
      const requested = billing.unbounded ? 0 : this.reserveAmount(billing.profile);
      const reservations = this.store.list("cost_reservation");
      const violations: Array<Record<string, unknown>> = [];
      const warnings: Array<Record<string, unknown>> = [];
      // In-txn pricing deny paths (mirror the advisory pre-checks): a
      // profile that flipped to UNKNOWN/unbounded between the outer
      // read and this txn still fails closed.
      if (billing.mode === "UNKNOWN" && hard.length > 0) {
        violations.push({
          scope_type: "pricing", scope_id: routeId ?? params.executorId,
          reason: "FAIL_CLOSED_COST_UNKNOWN",
          used_microusd: null, requested_microusd: null, max_microusd: null,
        });
      }
      if (billing.mode === "METERED_API" && billing.unbounded && hard.length > 0) {
        violations.push({
          scope_type: "pricing", scope_id: routeId ?? params.executorId,
          reason: "FAIL_CLOSED_COST_UNBOUNDED",
          used_microusd: null, requested_microusd: null, max_microusd: null,
        });
      }
      // F2-C R4: the governed-task reservation slot is re-checked
      // inside the transaction — a sibling connection that committed
      // this resId between the outer fast-path and here is adopted,
      // denied, or re-held exactly once, never double-counted.
      const existingNow = this.store.tryGet("cost_reservation", resId);
      const inTxnStatus = existingNow ? String(existingNow.status) : null;
      if (inTxnStatus === "COMMITTED" || inTxnStatus === "SETTLED") {
        return { violations: [], warnings: [], saved: existingNow };
      }
      if (inTxnStatus === "HELD" && !reusingReleased) {
        return { violations: [{ scope_type: "reservation", scope_id: resId,
          reason: "FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS",
          used_microusd: null, requested_microusd: null, max_microusd: null }],
          warnings: [], saved: null };
      }
      // FINAL HOTFIX — halt re-checked against the AUTHORITATIVE
      // in-txn billing: the advisory check above can see FREE while a
      // concurrent edit flipped the profile to METERED_API/UNKNOWN in
      // the gap; the halt must still block the cost-bearing dispatch.
      // Adoption of an already-committed reservation above is not new
      // spend and stays allowed under halt. FREE/SUBSCRIPTION/
      // UNMETERED semantics are unchanged.
      if (this.haltActive() &&
          (billing.mode === "METERED_API" || billing.mode === "UNKNOWN")) {
        violations.push({
          scope_type: "pricing", scope_id: routeId ?? params.executorId,
          reason: "FAIL_CLOSED_COST_HALT",
          used_microusd: null, requested_microusd: null, max_microusd: null,
        });
      }
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
      // P15.10-C R3 F2 — objective-level budget authority at the REAL
      // pre-spend boundary. The driver's admission-time bound is only a
      // preliminary check: the reservation THIS governed task creates
      // has a concrete route/model identity, so the objective cap binds
      // it here — inside the same atomic check-and-reserve transaction,
      // against lineage resolved fresh (never the caller's snapshot).
      const objScope = this.objectiveScopeFor(missionId);
      if (objScope === "BROKEN") {
        // F2-A R4: the mission carries an objective-binding claim
        // (bound_open_id) but the canonical lineage cannot be resolved
        // or contradicts itself — never treated as a manual mission.
        violations.push({
          scope_type: "objective",
          scope_id: "UNRESOLVED",
          reason: "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED",
          used_microusd: null, requested_microusd: null, max_microusd: null,
        });
      } else if (objScope && objScope.cap !== null) {
        if (billing.mode === "UNKNOWN" || billing.unbounded) {
          // An unprovable charge under an objective cap is never $0.
          violations.push({
            scope_type: "objective",
            scope_id: objScope.objective_id,
            reason: "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED",
            used_microusd: null,
            requested_microusd: requested,
            max_microusd: objScope.cap,
          });
        } else {
          const attributed = this.objectiveAttributedMicrousd(objScope.objective_id, reservations);
          if (attributed + requested > objScope.cap) {
            violations.push({
              scope_type: "objective",
              scope_id: objScope.objective_id,
              reason: "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED",
              used_microusd: attributed,
              requested_microusd: requested,
              max_microusd: objScope.cap,
            });
          }
        }
      }
      if (violations.length) return { violations, warnings, saved: null };
      // R1 §2: pin the authoritative pricing evidence into the
      // reservation at authorization time — settlement later uses THIS
      // snapshot, never a mutable later profile row.
      const profile = billing.profile;
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
        cost_profile_id: profile ? String(profile.cost_profile_id) : null,
        cost_profile_version: profile ? Number(profile.version) : null,
        cost_profile_digest: null as string | null,
        profile_fixed_microusd: profile?.fixed_microusd ?? null,
        profile_input_microusd_per_mtok: profile?.input_microusd_per_mtok ?? null,
        profile_output_microusd_per_mtok: profile?.output_microusd_per_mtok ?? null,
        profile_reserve_microusd: profile?.reserve_microusd ?? null,
        pricing_source: profile ? String(profile.source ?? "") : null,
        pricing_effective_at: profile ? String(profile.effective_at ?? "") : null,
        currency: "USD",
        reserved_microusd: requested,
        settled_microusd: null,
        usage_state: null,
        unbounded: billing.unbounded,
        status: "HELD",
        created_at: utcnow(),
        updated_at: utcnow(),
        version: 0,
      };
      row.cost_profile_digest = profile ? this.profilePinDigest(profile, row) : null;
      // Re-hold of a RELEASED row happens inside the same txn: CAS on the
      // in-txn row's version — a concurrent mutation loses and aborts.
      if (reusingReleased) {
        const fresh = this.store.tryGet("cost_reservation", resId);
        if (fresh && String(fresh.status) === "RELEASED") {
          const rehold = { ...row, version: Number(fresh.version) };
          return {
            violations: [],
            warnings,
            saved: this.store.put("cost_reservation", resId, rehold, Number(fresh.version)),
          };
        }
        if (fresh && (String(fresh.status) === "COMMITTED" || String(fresh.status) === "SETTLED")) {
          return { violations: [], warnings, saved: fresh }; // proven charge — adopt
        }
        return { violations: [], warnings, saved: null, ambiguous: true };
      }
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
        if (v.cost_policy_id != null) {
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
        }
        this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
          reason: String(v.reason ?? "FAIL_CLOSED_COST_BUDGET_EXCEEDED"),
          governed_task_id: governedTaskId,
          cost_policy_id: v.cost_policy_id ?? null,
          objective_id: v.scope_type === "objective" ? v.scope_id : null,
          used_microusd: v.used_microusd,
          requested_microusd: v.requested_microusd,
          max_microusd: v.max_microusd,
        });
      }
      const v = outcome.violations[0];
      throw new PolicyError(
        String(v.reason ?? "FAIL_CLOSED_COST_BUDGET_EXCEEDED"),
        `${String(v.scope_type)}:${String(v.scope_id)} ${String(v.used_microusd)}+${String(v.requested_microusd)}>${String(v.max_microusd)}`,
      );
    }
    if (!outcome.saved) {
      // The RELEASED row raced into a non-adoptable state mid-txn.
      this.store.appendEvidence(missionId, "COST_DISPATCH_DENIED", {
        reason: "FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS",
        governed_task_id: governedTaskId,
      });
      throw new PolicyError("FAIL_CLOSED_COST_RESERVATION_AMBIGUOUS", governedTaskId);
    }
    return outcome.saved;
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
      // R1 §2: settle from the pricing snapshot PINNED in the reservation —
      // never a mutable later cost_profile row. If the pinned digest no
      // longer verifies against the stored fields, degrade to unknown
      // usage (COMMITTED at reserved max — never under-count).
      const pinOk =
        !r.cost_profile_digest ||
        this.profilePinDigest(
          {
            cost_profile_id: r.cost_profile_id,
            version: r.cost_profile_version,
            billing_mode: r.billing_mode,
          },
          r,
        ) === String(r.cost_profile_digest);
      const inRate = pinOk ? Number(r.profile_input_microusd_per_mtok ?? 0) : 0;
      const outRate = pinOk ? Number(r.profile_output_microusd_per_mtok ?? 0) : 0;
      if (pinOk && (inRate > 0 || outRate > 0)) {
        actual =
          Number(r.profile_fixed_microusd ?? 0) +
          Math.ceil((Number(result.input_tokens) * inRate) / 1_000_000) +
          Math.ceil((Number(result.output_tokens) * outRate) / 1_000_000);
      }
    }
    this.settle(governedTaskId, actual);
  }

  /* ---------------- Phase C — planner invocation governance --------------
   * The LLM Planner Pool spends provider requests BEFORE any mission or
   * governed task exists. When a delegated open carries objective
   * lineage, the SAME cap binds at this pre-spend boundary — atomically
   * inside one check-and-reserve transaction against lineage resolved
   * fresh (never the caller's snapshot). Planner reservations use the
   * same HELD → COMMITTED → SETTLED / RELEASED lifecycle with the
   * planner_run as their canonical evidence anchor. */

  /** Resolve planner pricing for ONE pool candidate through the
   *  canonical profile chain: model profile (ref_id = model_entry_id —
   *  the same identity planner_attempt rows bind) → executor profile
   *  (codex_cli transport → CODEX_EXECUTOR_ID, the real governed
   *  executor class; every other planner transport →
   *  PLANNER_EXECUTOR_ID) → UNKNOWN. UNKNOWN is never coerced to FREE. */
  billingForPlanner(candidate: {
    model_entry_id: string;
    transport?: string;
  }): { mode: BillingMode; profile: Record<string, unknown> | null; unbounded: boolean } {
    const profile =
      this.profileFor("model", String(candidate.model_entry_id)) ??
      this.profileFor(
        "executor",
        candidate.transport === "codex_cli" ? CODEX_EXECUTOR_ID : PLANNER_EXECUTOR_ID,
      );
    if (!profile) {
      return { mode: "UNKNOWN", profile: null, unbounded: true };
    }
    const mode = String(profile.billing_mode) as BillingMode;
    if (mode !== "METERED_API") return { mode, profile, unbounded: false };
    const reserve = Number(profile.reserve_microusd ?? 0);
    const hasRates =
      Number(profile.input_microusd_per_mtok ?? 0) > 0 ||
      Number(profile.output_microusd_per_mtok ?? 0) > 0;
    const statedFixed = Number(profile.fixed_microusd ?? 0);
    const bounded = reserve > 0 || (!hasRates && statedFixed > 0);
    return { mode, profile, unbounded: !bounded };
  }

  /** Bounded per-provider-request charge for a candidate's resolved
   *  profile (reserve_microusd wins, else stated fixed fee). */
  plannerRequestBoundMicrousd(candidate: {
    model_entry_id: string;
    transport?: string;
  }): { per_request_microusd: number; billing: { mode: BillingMode; unbounded: boolean } } {
    const billing = this.billingForPlanner(candidate);
    return {
      per_request_microusd: billing.unbounded ? 0 : this.reserveAmount(billing.profile),
      billing: { mode: billing.mode, unbounded: billing.unbounded },
    };
  }

  /**
   * Atomic pre-call budget admission for a planner run. Called AFTER
   * beginPlannerRun (the run row is the evidence anchor) and BEFORE the
   * first candidate invocation:
   *   work_item_id absent        → no objective lineage possible →
   *                                scope NONE, no reservation.
   *   lineage BROKEN             → FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED.
   *   no objective claim         → scope NONE, no reservation.
   *   cap present + unprovable   → FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED.
   *   attributed + est > cap     → FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED.
   *   otherwise                  → one HELD planner reservation
   *                                (CRSV_PLN_<run>) pinning the bounded
   *                                envelope — idempotent on replay.
   * The reservation counts toward the SAME objectiveAttributedMicrousd
   * the governed tasks draw from, so concurrent planner runs and task
   * dispatches can never silently exceed the objective budget together.
   */
  admitPlannerInvocation(input: {
    planner_run_id: string;
    /** Delegated-open identity — resolves the objective lineage. */
    work_item_id?: string | null;
    /** Bounded envelope: Σ per-request bound × request-count bound over
     *  every eligible candidate (INITIAL internal calls + REASK). */
    est_microusd: number;
    /** Any candidate's pricing UNKNOWN or METERED_API-unbounded. */
    unbounded_unknown?: boolean;
    candidates?: number;
    actor?: string;
  }): { reservation_id: string | null; scope: "NONE" | "UNCAPPED" | "CAPPED"; objective_id: string | null } {
    const est = assertMicrousd("est_microusd", input.est_microusd);
    const wi = input.work_item_id != null ? String(input.work_item_id) : null;
    if (!wi) {
      return { reservation_id: null, scope: "NONE", objective_id: null };
    }
    const scope = this.objectiveScopeForWorkItemId(wi);
    if (scope === "BROKEN") {
      throw new PolicyError(
        "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED",
        `planner admission for ${wi}: broken objective lineage`,
      );
    }
    if (!scope) {
      return { reservation_id: null, scope: "NONE", objective_id: null };
    }
    const resId = `CRSV_PLN_${String(input.planner_run_id)}`;
    return this.store.immediate(() => {
      const existing = this.store.tryGet("cost_reservation", resId);
      if (existing) {
        // Idempotent replay — the committed row is the authority.
        return {
          reservation_id: resId,
          scope: scope.cap !== null ? "CAPPED" : "UNCAPPED",
          objective_id: scope.objective_id,
        };
      }
      /* AUDIT R2-F2 — canonical Objective budget authority. The
       * auto-policy cap (limits.budget_microusd_cap) is only ONE of the
       * two budget authorities; PR #117's canonical authority is the
       * objective row's own budget{ceiling,consumed} proven by the
       * strict spend-ledger reconciliation. When the objective row
       * exists, this seam enforces it INSIDE the reservation txn — a
       * fresh read at reserve time, so a budget amended while an async
       * generation is in flight applies to the next admission.
       *   - ceiling ≤ 0 → OBJECTIVE_ZERO_BUDGET: a hard bound, NEVER
       *     uncapped/exhausted — blocks every spend-bearing envelope
       *     (est>0 or unprovable). A provable $0 envelope is the
       *     explicitly-authorized continuation: it can never spend, so
       *     it needs no budget — same zero-cap treatment as the
       *     policy-cap seam.
       *   - ceiling > 0 → EXHAUSTED/headroom: unbounded envelopes
       *     cannot be proven within the remaining budget; a bounded
       *     envelope must fit consumed+outstanding+est ≤ ceiling
       *     (R3 — HELD/COMMITTED reservations encumber the remaining
       *     ceiling inside this same txn).
       * An absent objective row leaves the lineage exactly as before
       * — the auto-policy cap remains the resolved authority
       * (existing seam semantics are unchanged there). */
      const objRow = this.store.tryGet("objective", scope.objective_id) as
        | (Record<string, unknown> & { version: number })
        | null;
      if (objRow) {
        try {
          assertCanonicalObjectiveBudget(this.store, objRow);
        } catch {
          throw new PolicyError(
            "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED",
            `planner admission for ${wi}: canonical objective ` +
              `${scope.objective_id} budget authority unprovable`,
          );
        }
        const budget = objRow.budget as Record<string, unknown>;
        const ceiling = Number(budget.ceiling_microusd);
        const consumed = Number(budget.consumed_microusd);
        if (ceiling <= 0) {
          if (est > 0 || input.unbounded_unknown === true) {
            this.store.event({
              entity_type: "objective",
              entity_id: scope.objective_id,
              event_type: "COST_OBJECTIVE_ZERO_BUDGET",
              actor: "PAIR_COST_GOVERNANCE",
              metadata: {
                scope_type: "objective",
                scope_id: scope.objective_id,
                requested_microusd: est,
                planner_run_id: String(input.planner_run_id),
              },
            });
            throw new PolicyError(
              "FAIL_CLOSED_COST_OBJECTIVE_ZERO_BUDGET",
              `objective:${scope.objective_id} canonical ceiling=0 — new spend-bearing work is hard-blocked`,
            );
          }
        } else {
          if (input.unbounded_unknown === true) {
            throw new PolicyError(
              "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED",
              `planner pricing unbounded under objective ${scope.objective_id} canonical budget ceiling`,
            );
          }
          /* AUDIT R3 — consumed alone is NOT the used budget:
           * outstanding HELD/COMMITTED reservations already encumber
           * the remaining ceiling, and this check must reconcile them
           * inside the same atomic admission txn or two 80µ planners
           * both pass under ceiling=100. RELEASED rows carry no
           * encumbrance. SETTLED rows need care: their spend is a REAL
           * liability, but settlePlannerInvocation/settleFromResult can
           * settle without any canonical spend event landing — so a
           * settled row is excluded ONLY when its actual cost is provably
           * inside consumed_microusd. The canonical correlation is
           * spend_key === reservation_id in the strict-proven
           * applied_spend_keys ledger (accountBudget is key-idempotent;
           * the reservation id is its natural idempotent key). A settled
           * row without that key keeps its settled liability. */
          const allRes = this.store.list("cost_reservation") as Array<Record<string, unknown>>;
          const outstanding = this.objectiveAttributedMicrousd(
            scope.objective_id,
            allRes.filter((r) => {
              const st = String(r.status);
              return st === "HELD" || st === "COMMITTED";
            }),
          );
          const accountedKeys = new Set(
            ((objRow.applied_spend_keys ?? []) as Array<Record<string, unknown>>)
              .map((e) => String(e.key)),
          );
          const unaccountedSettled = this.objectiveAttributedMicrousd(
            scope.objective_id,
            allRes.filter((r) =>
              String(r.status) === "SETTLED" &&
              !accountedKeys.has(String(r.reservation_id ?? ""))),
          );
          const used = consumed + outstanding + unaccountedSettled;
          if (used + est > ceiling) {
            this.store.event({
              entity_type: "objective",
              entity_id: scope.objective_id,
              event_type: "COST_BUDGET_EXCEEDED",
              actor: "PAIR_COST_GOVERNANCE",
              metadata: {
                scope_type: "objective",
                scope_id: scope.objective_id,
                consumed_microusd: consumed,
                outstanding_reserved_microusd: outstanding,
                unaccounted_settled_microusd: unaccountedSettled,
                used_microusd: used,
                requested_microusd: est,
                max_microusd: ceiling,
                planner_run_id: String(input.planner_run_id),
              },
            });
            throw new PolicyError(
              "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED",
              `objective:${scope.objective_id} canonical ${consumed}+${outstanding}outstanding+${unaccountedSettled}settled_unaccounted+${est}>${ceiling}`,
            );
          }
        }
      }
      if (input.unbounded_unknown && scope.cap !== null) {
        // An unprovable charge under an objective cap is never $0.
        throw new PolicyError(
          "FAIL_CLOSED_COST_OBJECTIVE_UNVERIFIED",
          `planner pricing unbounded under objective ${scope.objective_id} cap`,
        );
      }
      if (this.haltActive() && est > 0) {
        throw new PolicyError("FAIL_CLOSED_COST_HALT", `planner run ${String(input.planner_run_id)}`);
      }
      if (scope.cap !== null) {
        const attributed = this.objectiveAttributedMicrousd(
          scope.objective_id,
          this.store.list("cost_reservation"),
        );
        if (attributed + est > scope.cap) {
          this.store.event({
            entity_type: "objective",
            entity_id: scope.objective_id,
            event_type: "COST_BUDGET_EXCEEDED",
            actor: "PAIR_COST_GOVERNANCE",
            metadata: {
              scope_type: "objective",
              scope_id: scope.objective_id,
              used_microusd: attributed,
              requested_microusd: est,
              max_microusd: scope.cap,
              planner_run_id: String(input.planner_run_id),
            },
          });
          throw new PolicyError(
            "FAIL_CLOSED_COST_OBJECTIVE_BUDGET_EXCEEDED",
            `objective:${scope.objective_id} ${attributed}+${est}>${scope.cap}`,
          );
        }
      }
      const wRow = this.store.tryGet("work_item", wi) as Record<string, unknown> | null;
      const row = {
        schema: COST_SCHEMA,
        reservation_id: resId,
        governed_task_id: null,
        planner_run_id: String(input.planner_run_id),
        attribution: "planner",
        work_item_id: wi,
        objective_id: scope.objective_id,
        mission_id: null,
        task_id: null,
        executor_id: null,
        route_id: null,
        business_id: wRow?.business_id != null ? String(wRow.business_id) : null,
        department: wRow?.department != null ? String(wRow.department) : null,
        agent_id: null,
        billing_mode: est > 0 ? "METERED_API" : "UNMETERED",
        cost_profile_id: null,
        cost_profile_version: null,
        cost_profile_digest: null,
        profile_fixed_microusd: null,
        profile_input_microusd_per_mtok: null,
        profile_output_microusd_per_mtok: null,
        profile_reserve_microusd: null,
        pricing_source: "planner_envelope",
        pricing_effective_at: utcnow(),
        currency: "USD",
        reserved_microusd: est,
        settled_microusd: null,
        usage_state: null,
        unbounded: input.unbounded_unknown === true,
        status: "HELD",
        created_at: utcnow(),
        updated_at: utcnow(),
        version: 0,
      };
      this.store.put("cost_reservation", resId, row, 0);
      return {
        reservation_id: resId,
        scope: scope.cap !== null ? "CAPPED" : "UNCAPPED",
        objective_id: scope.objective_id,
      };
    });
  }

  /**
   * Settle a planner-run reservation from the run's canonical outcome:
   *   "NO_CALLS"    — the run provably made ZERO provider requests
   *                   (no STARTED attempt ever invoked planFn) → RELEASED.
   *   "CALLS_MADE"  — at least one provider request may have spent;
   *                   actual_microusd settles exactly, unknown usage
   *                   stays COMMITTED at reserved max (never under-count).
   */
  settlePlannerInvocation(
    reservationId: string,
    outcome: "CALLS_MADE" | "NO_CALLS",
    actualMicrousd?: number | null,
  ): void {
    const r = this.store.tryGet("cost_reservation", reservationId);
    if (!r || r.planner_run_id == null) return;
    if (String(r.status) === "RELEASED" || String(r.status) === "SETTLED") return;
    if (outcome === "NO_CALLS") {
      this.transitionIfCurrent(reservationId, ["HELD"], "RELEASED");
      return;
    }
    if (actualMicrousd != null) {
      assertMicrousd("actual_microusd", actualMicrousd);
      this.transitionIfCurrent(reservationId, ["HELD", "COMMITTED"], "SETTLED", {
        settled_microusd: actualMicrousd,
        usage_state: "ACTUAL_SETTLED",
      });
      return;
    }
    this.transitionIfCurrent(reservationId, ["HELD", "COMMITTED"], "COMMITTED", {
      usage_state: "ACTUAL_USAGE_UNKNOWN",
    });
  }

  /**
   * Sweep planner-run reservations: a HELD row settles from its
   * canonical planner_run row — RUNNING stays HELD (still in flight, or
   * crashed mid-call — never guessed); a terminal run with proven
   * provider requests → COMMITTED at reserved; a terminal run with
   * zero proven provider requests proves no spend → RELEASED; a missing
   * run row stays conservatively HELD. Mirrors reconcileForTask's
   * evidence-only rule.
   *
   * AUDIT R1 F4 — the discriminator is `provider_requests` (transport-
   * reported requests that PROVABLY initiated), never the STARTED
   * attempt-row count: an eligibility-rejected attempt that never
   * reached a provider provably spent nothing → RELEASED. Run rows
   * predating the F4 field fall back to the conservative attempts>0
   * semantics (never under-count ambiguous legacy evidence).
   */
  reconcilePlannerInvocations(): number {
    let touched = 0;
    for (const r of this.store.list("cost_reservation")) {
      if (r.planner_run_id == null || String(r.status) !== "HELD") continue;
      const run = this.store.tryGet("planner_run", String(r.planner_run_id));
      if (!run || String(run.state) === "RUNNING") continue;
      const resId = String(r.reservation_id);
      if (Number(run.provider_requests ?? run.attempts ?? 0) > 0) {
        this.transitionIfCurrent(resId, ["HELD"], "COMMITTED", {
          usage_state: "ACTUAL_USAGE_UNKNOWN",
        });
      } else {
        this.transitionIfCurrent(resId, ["HELD"], "RELEASED");
      }
      touched += 1;
    }
    return touched;
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
    // Phase C — planner-run reservations reconcile from their canonical
    // planner_run evidence (terminal+proven provider requests →
    // COMMITTED, terminal+0 → RELEASED, RUNNING/missing → stays HELD).
    touched += this.reconcilePlannerInvocations();
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
