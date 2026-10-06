/**
 * CapabilityRouter — the single PAIR-owned executor-selection authority.
 *
 * Port of donor capability_router.py (a557df2): a deterministic 12-step
 * eligibility pipeline. It *selects only* — never dispatches, never mutates
 * mission state, never bypasses GovernedTaskGate.
 *
 * Filter order (frozen):
 *  1. registered/enabled           7. permission compatibility
 *  2. bound adapter (DISPATCH)     8. workspace compatibility
 *  3. required capabilities        9. transport qualified
 *  4. health usable               10. concurrency slot (DISPATCH)
 *  5. live qualification          11. quota/rate-limit state
 *     (DISPATCH only)             12. deterministic tie-break
 *  6. auth state acceptable
 *
 * Modes: PLAN — registry-level steps (1,3,4,7,8,9,11) for plan-time routing;
 * DISPATCH — every step, with live adapter requalification.
 * Every decision persists a digestible receipt via the evidence store.
 */

import { digest, newId, utcnow } from "./canonical.js";
import type { ExecutorAdapter } from "./adapter.js";
import type { VerifiedExperienceRoutingAdvisor } from "./experience-advisors.js";
import { IntegrityError } from "./errors.js";
import { ExecutorRegistry, QUALIFIED_TRANSPORTS, TRANSPORT_AUTOMATON_WORKER_POOL, TRANSPORT_SUBPROCESS_WORKER, TRANSPORT_UNKNOWN, CANONICAL_IDENTITIES } from "./executor-registry.js";
import type { PairControlPlane } from "./service.js";

export const ROUTING_POLICY_VERSION = "pair.os.vnext.capability-routing.v1";

/* ── EXECUTOR_SUITABILITY_V1_ACCOUNT_FIRST ─────────────────────────────
 * Economic classification of the governed workforce: account/session
 * executors are the DEFAULT general workforce; metered-API executors are
 * general-purpose fallback only. A metered executor must never outrank a
 * hard-eligible account executor on routing_priority, verified-experience
 * score, or the deterministic tie-break — it may only win when no account
 * executor survives hard eligibility (capability/health/quota/workspace)
 * or through the existing bounded recovery reroute path.
 *
 * PAIR_NATIVE keeps its distinct semantics: it is NATIVE class, never
 * swept into the account-vs-metered comparison — it stays in the
 * non-account tier and keeps its legacy ordering there. An executor not
 * declared below conservatively classifies as NON-ACCOUNT: it never
 * receives the account-first boost.
 */
export type ExecutorEconomicClass = "ACCOUNT_SESSION" | "METERED_API" | "NATIVE";
export const EXECUTOR_ECONOMIC_CLASS: Readonly<Record<string, ExecutorEconomicClass>> = {
  CODEX: "ACCOUNT_SESSION",
  DEVIN: "ACCOUNT_SESSION",
  DEEPSEEK_HARNESS: "METERED_API",
  PAIR_NATIVE: "NATIVE",
};

const ACCOUNT_TIER = 0;
const NON_ACCOUNT_TIER = 1;
const accountTierOf = (executorId: string): number =>
  EXECUTOR_ECONOMIC_CLASS[executorId] === "ACCOUNT_SESSION"
    ? ACCOUNT_TIER
    : NON_ACCOUNT_TIER;

export type TaskSuitability = "DEVIN_PREFERRED" | "CODEX_PREFERRED" | "NEUTRAL";

/** Remote-lane capabilities — only account executors declare them today;
 *  they encapsulate repo-scale/autonomous execution on the remote side. */
const REMOTE_LANE_CAPS = new Set([
  "REMOTE_CLOUD_TASK_EXECUTION",
  "AUTONOMOUS_CODE_EXECUTION",
]);
/** Local implementation-lane capabilities — focused code/script work. */
const IMPL_LANE_CAPS = new Set([
  "CODE_GENERATION",
  "CODE_EDITING",
  "SHELL_EXECUTION",
  "PYTHON_EXECUTION",
  "FILE_OPERATIONS",
]);

/** Bounded deterministic task→executor-shape classifier: capability-based
 *  only, no instruction parsing. Remote-lane or network-only tasks prefer
 *  the remote/long-running account executor (DEVIN); implementation-lane
 *  tasks prefer the focused local account executor (CODEX); anything else
 *  is NEUTRAL and falls back to intra-tier priority order. */
export function taskSuitability(caps: ReadonlySet<string>): TaskSuitability {
  for (const c of caps) if (REMOTE_LANE_CAPS.has(c)) return "DEVIN_PREFERRED";
  for (const c of caps) if (IMPL_LANE_CAPS.has(c)) return "CODEX_PREFERRED";
  if (caps.has("NETWORK_ACCESS")) return "DEVIN_PREFERRED";
  return "NEUTRAL";
}

/** Vastly exceeds EXPERIENCE_SCORE_WEIGHTS.MAX_ADJUSTMENT (40) so a
 *  suitability ordering can never be flipped by verified-experience
 *  adjustment — VE only re-orders candidates of equal suitability rank
 *  inside the same economic tier. */
const SUITABILITY_BASE_GAP = 1000;

function suitabilityRank(executorId: string, suitability: TaskSuitability): number {
  if (suitability === "NEUTRAL") return 0;
  const preferred = suitability === "DEVIN_PREFERRED" ? "DEVIN" : "CODEX";
  return executorId === preferred ? 0 : 1;
}

const EXECUTION_TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const AUTH_REJECTED = new Set(["AUTH_REQUIRED", "UNAUTHENTICATED", "EXPIRED", "NONE", "DENIED"]);
const QUOTA_REJECTED = new Set(["EXHAUSTED", "DEPLETED", "BLOCKED"]);
const RATE_LIMIT_REJECTED = new Set(["LIMITED", "THROTTLED", "BLOCKED", "EXHAUSTED"]);
/** SUBPROCESS_WORKER-style transports may only be claimed by canonical identities. */
const RESTRICTED_TRANSPORTS = new Set([TRANSPORT_SUBPROCESS_WORKER, TRANSPORT_AUTOMATON_WORKER_POOL]);
const REQUIRED_WORKSPACE_MODE = "EXPLICIT_WORKSPACE";

export type RoutingMode = "PLAN" | "DISPATCH";

export class CapabilityRouter {
  readonly registry: ExecutorRegistry;

  constructor(
    private readonly service: PairControlPlane,
    registry?: ExecutorRegistry,
  ) {
    this.registry = registry ?? new ExecutorRegistry(service);
  }

  private get store() {
    return this.service.store;
  }

  private activeExecutions(executorId: string): number {
    return this.store
      .list("executor_execution")
      .filter(
        (e) =>
          e.executor_id === executorId &&
          !EXECUTION_TERMINAL.has(String(e.execution_state)),
      ).length;
  }

  /** Per-executor evaluation — deterministic, ordered reason codes. */
  private evaluate(
    record: Record<string, unknown>,
    opts: {
      requiredCapabilities: Set<string>;
      requiredPermissions: Set<string>;
      adapters?: Map<string, ExecutorAdapter>;
      mode: RoutingMode;
    },
  ): { descriptor: Record<string, unknown>; reasons: string[] } {
    const descriptor = this.registry.normalizeDescriptor(record);
    const executorId = String(descriptor.executor_id);
    const reasons: string[] = [];
    const live = opts.mode === "DISPATCH";

    // 1. registered/enabled
    if (record.status === "DISABLED") reasons.push("EXECUTOR_DISABLED");

    // 2. bound adapter exists (dispatch-time only)
    let adapter: ExecutorAdapter | undefined;
    if (live) {
      adapter = opts.adapters?.get(executorId);
      if (!adapter) reasons.push("ADAPTER_NOT_BOUND");
    }

    // 3. required capabilities satisfied
    const caps = new Set((descriptor.capabilities as string[]) ?? []);
    const missing = [...opts.requiredCapabilities].filter((c) => !caps.has(c));
    if (missing.length) reasons.push(`MISSING_CAPABILITIES:${missing.sort().join(",")}`);

    // 4. health usable
    if (descriptor.health_state !== "READY") reasons.push(`HEALTH_${descriptor.health_state}`);

    // 5. live adapter requalification (dispatch-time only, after hard gates)
    let qualification: Record<string, unknown> = {};
    if (live && adapter && !reasons.length) {
      try {
        qualification = adapter.qualify() ?? {};
      } catch (error) {
        qualification = {
          qualified: false,
          dispatch_enabled: false,
          reasons: [(error as { code?: string }).code ?? String(error)],
        };
      }
      if (qualification.qualified !== true || qualification.dispatch_enabled !== true) {
        const qreasons =
          (qualification.reasons as string[] | undefined) ??
          [String(qualification.state ?? "EXECUTOR_UNQUALIFIED")];
        reasons.push(...qreasons.map(String));
      }
    }

    // 5b. PRV2-A R1.B — live eligibility proof for dynamically-claimed
    // capabilities: at DISPATCH a NETWORK_ACCESS task may only be served
    // by an executor whose CURRENT capability declaration includes it
    // (Codex resolves it per dispatch from PAIR_CODEX_NETWORK, so the
    // CNI-1 kill-switch stays authoritative). A static registry claim
    // alone never suffices — a stale registration fails closed here.
    if (
      live &&
      adapter &&
      opts.requiredCapabilities.has("NETWORK_ACCESS") &&
      !reasons.length
    ) {
      const liveOut = adapter.capabilities?.() ?? {};
      const liveCaps = new Set(
        (
          (liveOut.capability_ids as string[] | undefined) ??
          (liveOut.capabilities as string[] | undefined) ??
          []
        ).map(String),
      );
      if (!liveCaps.has("NETWORK_ACCESS")) {
        reasons.push("MISSING_LIVE_CAPABILITIES:NETWORK_ACCESS");
      }
    }

    // 6. auth state acceptable
    const authState = String(descriptor.auth_state);
    if (AUTH_REJECTED.has(authState)) reasons.push(`AUTH_UNAVAILABLE:${authState}`);

    // 7. permission compatibility
    const permissionModes = new Set(
      ((descriptor.permission_modes as string[]) ?? []).map((p) => p.toUpperCase()),
    );
    const permMissing = [...opts.requiredPermissions].filter(
      (p) => !permissionModes.has(p.toUpperCase()),
    );
    if (permMissing.length) {
      reasons.push(`PERMISSION_INCOMPATIBLE:${permMissing.sort().join(",")}`);
    }

    // 8. workspace compatibility — governed tasks bind explicit workspaces
    const workspaceModes = new Set(
      ((descriptor.workspace_modes as string[]) ?? []).map((m) => m.toUpperCase()),
    );
    if (!workspaceModes.has(REQUIRED_WORKSPACE_MODE)) {
      reasons.push(
        `WORKSPACE_INCOMPATIBLE:${[...workspaceModes].sort().join(",") || "NONE_DECLARED"}`,
      );
    }

    // 9. transport qualified; restricted transports only via canonical identity
    const transportType = String(descriptor.transport_type ?? TRANSPORT_UNKNOWN);
    if (!QUALIFIED_TRANSPORTS.has(transportType)) {
      reasons.push(`TRANSPORT_UNKNOWN:${transportType}`);
    } else if (
      RESTRICTED_TRANSPORTS.has(transportType) &&
      CANONICAL_IDENTITIES[executorId]?.transport_type !== transportType
    ) {
      reasons.push(`TRANSPORT_NOT_ENROLLED:${executorId}`);
    } else if (live && qualification.transport) {
      const t = qualification.transport as Record<string, unknown>;
      if (t.qualified === false) {
        reasons.push(`TRANSPORT_UNQUALIFIED:${t.reason ?? t.type ?? transportType}`);
      }
    }

    // 10. concurrency slot (dispatch-time only)
    if (live) {
      const maxConcurrency = Number(descriptor.max_concurrency) || 1;
      const active = this.activeExecutions(executorId);
      if (active >= maxConcurrency) reasons.push(`CAPACITY_EXHAUSTED:${active}/${maxConcurrency}`);
    }

    // 11. quota / rate-limit state
    if (QUOTA_REJECTED.has(String(descriptor.quota_state))) {
      reasons.push(`QUOTA_EXHAUSTED:${descriptor.quota_state}`);
    }
    if (RATE_LIMIT_REJECTED.has(String(descriptor.rate_limit_state))) {
      reasons.push(`RATE_LIMITED:${descriptor.rate_limit_state}`);
    }

    return { descriptor, reasons };
  }

  /**
   * Evaluate all registered executors and select deterministically.
   * Persisted as an append-only `routing_decision` receipt + evidence event.
   */
  route(
    task: Record<string, unknown>,
    opts: {
      executors?: Array<Record<string, unknown>>;
      adapters?: Map<string, ExecutorAdapter>;
      requiredPermissions?: Set<string>;
      excludedExecutors?: Record<string, string>;
      mode?: RoutingMode;
      correlationId?: string;
      persist?: boolean;
      actor?: string;
      routingAdvisor?: VerifiedExperienceRoutingAdvisor;
      environment?: Record<string, unknown>;
      /** P12: agent-contract executor preference, ordered — reorders inside
       *  the hard-eligible set only; it can never make an executor eligible. */
      preferredExecutors?: string[];
    } = {},
  ): Record<string, unknown> {
    const mode = opts.mode ?? "PLAN";
    if (mode !== "PLAN" && mode !== "DISPATCH") {
      throw new IntegrityError("FAIL_CLOSED_ROUTING_MODE", String(mode));
    }
    const executors = opts.executors ?? this.service.listExecutors();
    const requiredCapabilities = new Set(
      ((task.required_capabilities as string[]) ?? []).map(String),
    );
    const taskMeta = (task.metadata as Record<string, unknown>) ?? {};
    const requiredPermissions =
      opts.requiredPermissions ??
      new Set(((taskMeta.permissions as string[]) ?? []).map((p) => String(p).toUpperCase()));

    const eligible: Array<Record<string, unknown>> = [];
    const rejected: Array<Record<string, unknown>> = [];
    const descriptorDigests: Record<string, unknown> = {};

    for (const record of executors) {
      const { descriptor, reasons } = this.evaluate(record, {
        requiredCapabilities,
        requiredPermissions,
        adapters: opts.adapters,
        mode,
      });
      descriptorDigests[String(descriptor.executor_id)] = descriptor.descriptor_digest;
      const constraint = opts.excludedExecutors?.[String(descriptor.executor_id)];
      if (constraint) reasons.push(`INDEPENDENT_EXECUTOR_CONSTRAINT:${constraint}`);
      if (reasons.length) {
        rejected.push({ executor_id: descriptor.executor_id, reasons });
      } else {
        eligible.push(descriptor);
      }
    }

    // 12. EXECUTOR_SUITABILITY_V1 — deterministic ordering inside the
    // hard-eligible set ONLY: economic tier (account-session first) →
    // task-suitability rank → routing_priority → executor-id tie-break.
    // Suitability never admits, removes, or resurrects a candidate.
    const suitability = taskSuitability(requiredCapabilities);
    eligible.sort(
      (a, b) =>
        accountTierOf(String(a.executor_id)) - accountTierOf(String(b.executor_id)) ||
        suitabilityRank(String(a.executor_id), suitability) -
          suitabilityRank(String(b.executor_id), suitability) ||
        (Number(a.routing_priority) || 100) - (Number(b.routing_priority) || 100) ||
        String(a.executor_id).localeCompare(String(b.executor_id)),
    );
    // P12: contract executor preference is a deterministic reorder inside
    // the eligible set — bounded per economic tier since SUITABILITY_V1:
    // a preferred executor leads within its own tier segment but cannot
    // vault a metered executor above a hard-eligible account executor.
    // It never admits a rejected executor. Advisors may still re-rank the
    // reordered set below.
    const contractPreferred = (opts.preferredExecutors ?? []).filter((id) =>
      eligible.some((d) => String(d.executor_id) === id),
    );
    for (const id of [...contractPreferred].reverse()) {
      const idx = eligible.findIndex((d) => String(d.executor_id) === id);
      if (idx < 0) continue;
      const tier = accountTierOf(id);
      const tierStart = eligible.findIndex(
        (d) => accountTierOf(String(d.executor_id)) === tier,
      );
      eligible.splice(tierStart < 0 ? idx : tierStart, 0, ...eligible.splice(idx, 1));
    }
    // P7: advisory re-rank runs strictly INSIDE the hard-eligible set — it can
    // never add, remove, or resurrect a candidate, only reorder by bounded
    // verified-experience adjustment. No advisor → identical P6 baseline.
    let selected = eligible.length ? String(eligible[0].executor_id) : null;
    let advisorReceipt: Record<string, unknown> | null = null;
    if (opts.routingAdvisor && eligible.length >= 1) {
      // SUITABILITY_V1 — verified-experience adjustment stays bounded to the
      // top economic tier: a metered executor can never be experience-
      // promoted above a hard-eligible account executor. The advisor pool
      // is the top-tier segment; each member's effective base carries the
      // suitability gap so VE may tie-break/reorder only within equal
      // suitability ranks (gap ≫ MAX_ADJUSTMENT).
      const topTier = accountTierOf(String(eligible[0].executor_id));
      const advisorPool: Array<Record<string, unknown>> = eligible
        .filter((d) => accountTierOf(String(d.executor_id)) === topTier)
        .map((d) => ({
          ...d,
          routing_priority:
            suitabilityRank(String(d.executor_id), suitability) * SUITABILITY_BASE_GAP +
            (Number(d.routing_priority) || 100),
        }));
      advisorReceipt = opts.routingAdvisor.advise({
        eligible: advisorPool,
        task,
        environment: opts.environment,
        correlation_id: opts.correlationId,
        persist: opts.persist !== false,
      });
      const advised = String(advisorReceipt.selected ?? "");
      if (advised && advisorPool.some((d) => String(d.executor_id) === advised)) {
        selected = advised;
      } else {
        selected = eligible.length ? String(eligible[0].executor_id) : null;
      }
    }

    const decision: Record<string, unknown> = {
      routing_decision_id: newId("RTE"),
      task_id: task.task_id ?? null,
      mission_id: task.mission_id ?? null,
      required_capabilities: [...requiredCapabilities].sort(),
      required_permissions: [...requiredPermissions].sort(),
      executor_exclusions: opts.excludedExecutors ?? {},
      agent_preferred_executors: contractPreferred,
      evaluation_mode: mode,
      eligible_executors: eligible.map((d) => d.executor_id),
      rejected_executors: rejected,
      selected_executor: selected,
      descriptor_digests: descriptorDigests,
      policy_version: ROUTING_POLICY_VERSION,
      timestamp: utcnow(),
      correlation_id: opts.correlationId ?? null,
      advisor_decision_id: advisorReceipt
        ? String(advisorReceipt.advisor_decision_id)
        : null,
      adaptive_mode: advisorReceipt ? String(advisorReceipt.mode) : null,
      score_version: advisorReceipt
        ? String(advisorReceipt.score_version)
        : null,
      // SUITABILITY_V1 — evidence of the economic/suitability layer applied
      // to this decision (empty → legacy ordering could not be expressed).
      task_suitability: suitability,
      economic_policy: "ACCOUNT_FIRST",
    };
    const digestBody: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(decision)) {
      if (!["routing_decision_id", "timestamp", "decision_digest"].includes(k)) {
        digestBody[k] = v;
      }
    }
    decision.decision_digest = digest(digestBody);

    if (opts.persist !== false) {
      this.store.put("routing_decision", String(decision.routing_decision_id), decision, 0);
      this.store.event({
        entity_type: "routing_decision",
        entity_id: String(decision.routing_decision_id),
        event_type: "ROUTING_DECISION_RECORDED",
        new_state: selected ?? "NO_ELIGIBLE_EXECUTOR",
        actor: opts.actor ?? "PAIR_CAPABILITY_ROUTER",
        correlation_id: opts.correlationId,
      });
      if (task.mission_id) {
        this.store.appendEvidence(String(task.mission_id), "ROUTING_DECISION", {
          routing_decision_id: decision.routing_decision_id,
          decision_digest: decision.decision_digest,
          selected_executor: selected,
          eligible: decision.eligible_executors,
          rejected: rejected,
          mode,
        });
      }
    }
    return decision;
  }

  /** Recompute a stored decision's digest — tamper detection on read. */
  verifyDecisionDigest(decision: Record<string, unknown>): boolean {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(decision)) {
      if (!["routing_decision_id", "timestamp", "decision_digest", "version", "entity_type", "entity_id"].includes(k)) {
        body[k] = v;
      }
    }
    return digest(body) === decision.decision_digest;
  }
}
