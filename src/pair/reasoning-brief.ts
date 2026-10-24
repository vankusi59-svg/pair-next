/**
 * P16-B — Strategic ReasoningBrief contract (BRAIN).
 *
 *  The ReasoningBrief is the Brain's deterministic strategic-reading
 *  document: it composes evidence-linked FACTS, candidate HYPOTHESES,
 *  an honest confidence envelope, governed OPTIONS (with tradeoffs),
 *  and the MISSING INFORMATION a reasoner must not pretend to know —
 *  ALL derived from the canonical BrainContext (P16-A), plus a
 *  read-only `reasoner` eligibility projection naming the configured
 *  model lane (catalog + qualification reuse, NEVER an invocation).
 *
 *  Invariants:
 *  - ADVISORY ONLY. This service performs ZERO writes, ZERO model
 *    invocations, and mints NO authority. Options are named candidate
 *    moves that existing authority surfaces may commit — the brief is
 *    never a Planner, Router, or execution authority (INV_MISSION_001).
 *  - DETERMINISTIC: identical canonical state yields an identical
 *    brief_digest. Volatile inputs (asof, actor, reasoner eligibility
 *    gates) are excluded — eligibility is deterministic on canonical
 *    MODEL-CATALOG state which lives outside context_digest's scope,
 *    so digesting it would let a catalog mutation move brief_digest
 *    while context_digest stands still. context_digest pins the exact
 *    BrainContext snapshot — P16-C's stale-check anchor.
 *  - EVIDENCE-LINKED: every fact carries provenance
 *    (CANONICAL | PROVEN | PROJECTED | UNVERIFIED) and the context
 *    section names it was read from. Claims the canonical re-proof
 *    could not verify degrade to UNVERIFIED — never smoothed over.
 *  - INHERITED GATES: owner/scope/budget/fail-closed come from
 *    BrainContextService.contextFor verbatim — there is exactly ONE
 *    read path. The brief adds ZERO canonical reads for composition.
 *    The reasoner projection is a bounded catalog read outside the
 *    context budget BY DESIGN: model_entry + provider + fixed receipt
 *    gates + the model_role_assignment table — bounded by table size,
 *    never unbounded user data.
 */

import { digest, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import { BrainContextService } from "./brain-context.js";
import { TERMINAL_OBJECTIVE_STATUSES, type ObjectiveStatus } from "./objective-authority.js";
import { assertCeoModelUsable } from "./ceo-planning-cycle.js";
import { resolveCeoModelTransport, type CeoModelTransport } from "./ceo-decision.js";

export const REASONING_BRIEF_SCHEMA = "pair.os.vnext.reasoning-brief.v1";

/* Hard caps — the brief is a bounded document, never a data channel. */
export const BRIEF_MAX_FACTS = 32;
export const BRIEF_MAX_HYPOTHESES = 12;
export const BRIEF_MAX_OPTIONS = 12;
export const BRIEF_MAX_GAPS = 32;

export type FactProvenance = "CANONICAL" | "PROVEN" | "PROJECTED" | "UNVERIFIED";

export interface BriefFact {
  /** Stable machine predicate, e.g. OBJECTIVE_STATUS. */
  predicate: string;
  /** Subject the fact is about (objective id, kpi id, workstream key). */
  subject: string;
  /** Canonical value — a primitive or a small frozen projection. */
  value: unknown;
  provenance: FactProvenance;
  /** BrainContext section names the fact was composed from. */
  sections: string[];
}

export interface BriefHypothesis {
  /** Stable machine id, e.g. MEASUREMENT_LEADS_EXECUTION. */
  id: string;
  detail: string;
  /** Fact predicates the hypothesis rests on (empty = none). */
  rests_on: string[];
}

export type BriefOptionKind = "CEO_DECISION" | "OWNER_ACTION" | "POLICY_CONTROL" | "AWAIT";

export interface BriefOption {
  /** Stable machine id, e.g. CEO_INITIALIZE_WORKSTREAMS. */
  id: string;
  kind: BriefOptionKind;
  /** The EXISTING authority channel that could commit this move —
   *  never a command. e.g. "CEO_CYCLE" | "owner-console routes" |
   *  "policy-configure route". */
  authority_channel: string;
  rationale: string;
  rests_on: string[];
  tradeoff: string;
}

export interface BriefGap {
  code: string;
  detail: string;
}

export type ReasonerEligibility =
  | "QUALIFIED"
  | "UNQUALIFIED"
  | "UNRESOLVED"
  | "NOT_CONFIGURED";

export interface BriefReasoner {
  /** Configured model_entry for the reasoning lane, or null. */
  model_entry_id: string | null;
  eligibility: ReasonerEligibility;
  /** Canonical transport identity when the entry resolves. */
  transport: Pick<
    CeoModelTransport,
    "provider_id" | "provider_family" | "model_id" | "protocol_family"
  > | null;
  /** IntegrityError code when eligibility is not QUALIFIED. */
  failure_code: string | null;
}

export type BriefConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface ReasoningBrief {
  schema_version: string;
  kind: "REASONING_BRIEF";
  objective_id: string;
  business_id: string;
  /** Caller — read identity, NOT brief content (excluded from digest). */
  actor: string;
  asof: string;
  /** Digest pin of the exact BrainContext this brief derives from —
   *  a consumer can re-read context and detect staleness. */
  context_digest: string;
  facts: BriefFact[];
  hypotheses: BriefHypothesis[];
  options: BriefOption[];
  missing_information: BriefGap[];
  confidence: BriefConfidence;
  reasoner: BriefReasoner;
  /** Advisory marker — schema-level constant, not a field models set. */
  authority: "ADVISORY_ONLY";
  /** Canonical-content digest — stable across clock/identity reads on
   *  unchanged canonical state (see module docstring). */
  brief_digest: string;
}

export interface ReasoningBriefDeps {
  /** The ONE canonical read path — contextFor carries the owner
   *  gate, scope check, read budget and fail-closed strict reads. */
  brain: BrainContextService;
  /** Configured reasoning model_entry to report on. Optional — a
   *  brief without a configured reasoner reports NOT_CONFIGURED
   *  rather than fabricating availability. */
  model_entry_id?: string;
}

export interface ReasoningBriefOpts {
  business_id?: string;
  read_budget?: { entities: number; events: number };
}

/* Expected absences are canonical state, not reliability gaps — they
   name surfaces not yet wired (memory/experience tenancy) or pre-
   lifecycle states (no binding yet), so they don't degrade confidence.
   EXACT match on the code (gapOf already isolates it from detail) —
   a prefix match would silently classify any future same-prefix code
   as expected. */
const EXPECTED_GAP_CODES = new Set([
  "BINDING_ABSENT",
  "SCOPE_BINDING_ABSENT",
  "ARTIFACT_AUTHORITY_NOT_WIRED",
  "AUTO_POLICY_NOT_WIRED",
  "AUTO_DRIVER_NOT_WIRED",
]);

function isExpectedGap(code: string): boolean {
  return EXPECTED_GAP_CODES.has(code);
}

/* Clock-derived auto-policy fields — statusReadOnly computes them
   from now() (effective/expiry_pending flip at a policy-expiry
   instant on byte-identical canonical rows). The fact VALUE keeps
   them visible for consumers; the brief_digest strips them exactly
   like P16-A's stripVolatile, so a clock flip can never fake a
   state change. */
const VOLATILE_POLICY_KEYS = new Set(["effective", "expiry_pending"]);

function stripPolicyVolatile(v: unknown): unknown {
  const o = { ...(v as Record<string, unknown>) };
  for (const k of VOLATILE_POLICY_KEYS) delete o[k];
  return o;
}

/** Split "CODE:detail" entries into typed gaps (detail optional). */
function gapOf(entry: string): BriefGap {
  const i = entry.indexOf(":");
  return i === -1
    ? { code: entry, detail: "" }
    : { code: entry.slice(0, i), detail: entry.slice(i + 1) };
}

export class ReasoningBriefService {
  constructor(
    private readonly store: PairEvidenceStore,
    private readonly deps: ReasoningBriefDeps,
  ) {}

  /**
   * The only public read — owner-gated, scope-checked and bounded by
   * the wrapped contextFor call. Composition adds ZERO canonical
   * reads; the reasoner projection is a bounded catalog tryGet set.
   * Any authority/integrity/budget violation propagates fail-closed.
   */
  briefFor(
    objectiveId: string,
    actor: string,
    opts?: ReasoningBriefOpts,
  ): ReasoningBrief {
    const ctx = this.deps.brain.contextFor(objectiveId, actor, opts);
    const facts = this.facts(ctx);
    const hypotheses = this.hypotheses(ctx, facts);
    const options = this.options(ctx, facts);
    const missing = this.missingInformation(ctx);
    const confidence = this.confidence(ctx, facts, missing);
    const reasoner = this.reasoner();

    /* Deterministic bounds — truncations are REPORTED, never silent.
       Markers are appended AFTER the data cap so they can never be
       truncated away, and a missing_information overflow emits its own
       marker computed at slice time (not pushed into a consumed list). */
    const markers: BriefGap[] = [];
    const cap = <T>(list: T[], max: number, name: string): T[] => {
      if (list.length <= max) return list;
      markers.push({ code: "BRIEF_TRUNCATED", detail: `${name}:${list.length - max} dropped` });
      return list.slice(0, max);
    };
    const factsB = cap(facts, BRIEF_MAX_FACTS, "facts");
    const hypB = cap(hypotheses, BRIEF_MAX_HYPOTHESES, "hypotheses");
    const optB = cap(options, BRIEF_MAX_OPTIONS, "options");
    const gapB = [
      ...cap(missing, BRIEF_MAX_GAPS, "missing_information"),
      ...markers,
    ];

    const brief: Omit<ReasoningBrief, "brief_digest"> = {
      schema_version: REASONING_BRIEF_SCHEMA,
      kind: "REASONING_BRIEF",
      objective_id: ctx.objective_id,
      business_id: ctx.business_id,
      actor,
      asof: utcnow(),
      context_digest: ctx.context_digest,
      facts: factsB,
      hypotheses: hypB,
      options: optB,
      missing_information: gapB,
      confidence,
      reasoner,
      authority: "ADVISORY_ONLY",
    };
    return {
      ...brief,
      brief_digest: digest({
        schema_version: REASONING_BRIEF_SCHEMA,
        kind: "REASONING_BRIEF",
        objective_id: brief.objective_id,
        business_id: brief.business_id,
        context_digest: brief.context_digest,
        // Digest the volatile-stripped projection of AUTO_POLICY
        // facts — the live clock fields stay visible in the value.
        facts: brief.facts.map((f) =>
          f.predicate === "AUTO_POLICY"
            ? { ...f, value: stripPolicyVolatile(f.value) }
            : f),
        hypotheses: brief.hypotheses,
        options: brief.options,
        missing_information: brief.missing_information,
        confidence: brief.confidence,
        // Out-of-scope-by-construction: eligibility gates read MODEL-
        // CATALOG state (outside context_digest's scope) — only the
        // configured binding is canonical brief content.
        reasoner: { model_entry_id: reasoner.model_entry_id },
      }),
    };
  }

  // ------------------------------------------------------------------
  // Deterministic composition — every fact names its sections and its
  // provenance tier; nothing here fabricates a claim.
  // ------------------------------------------------------------------

  private facts(ctx: ReturnType<BrainContextService["contextFor"]>): BriefFact[] {
    const out: BriefFact[] = [];
    const val = (name: string): Record<string, unknown> =>
      (ctx.sections[name]?.value ?? {}) as Record<string, unknown>;
    const o = val("objective");
    const lifecycle = val("lifecycle");
    const observation = val("observation");
    const reviews = val("reviews");
    const autonomy = val("autonomy");
    const artifacts = val("artifacts");

    // -- objective identity/state (canonical row, strict-verified) --
    const oid = ctx.objective_id;
    out.push({
      predicate: "OBJECTIVE_STATUS",
      subject: oid,
      value: { status: o.status, terms_version: o.terms_version, version: o.version },
      provenance: "CANONICAL",
      sections: ["objective"],
    });
    /* Provenance tiers derive from the context's OWN integrity
       signal: proveClaims() re-proves the KPI progress + budget
       ledger chains directly — independent of whether the strict
       observation composed. The cockpit's obsOk-derived
       canonically_proven flag means "observation composed", which
       conflates the two — a pre-INITIALIZE objective whose claims
       re-proof passed would be misread UNVERIFIED. */
    const unprovenKpiIds = new Set(
      ctx.integrity
        .filter((i) => i.startsWith("KPI_PROGRESS_UNPROVEN:"))
        .map((i) => i.slice("KPI_PROGRESS_UNPROVEN:".length)),
    );
    const budgetUnproven = ctx.integrity.includes("BUDGET_LEDGER_UNPROVEN");

    const budget = (o.budget ?? {}) as Record<string, unknown>;
    out.push({
      predicate: "OBJECTIVE_BUDGET",
      subject: oid,
      value: {
        ceiling_microusd: budget.ceiling_microusd,
        consumed_microusd: budget.consumed_microusd,
      },
      // The spend claim is PROVEN when the ledger re-proof ran — the
      // cockpit flag additionally requires observation composition.
      provenance: budgetUnproven ? "UNVERIFIED" : "PROVEN",
      sections: ["objective"],
    });

    // -- binding presence: null is only "absent" when the strict
    //    observation COMPOSED; under observation_error it is
    //    unobservable — never reported as canonically absent. --
    const obsError = observation.observation_error as string | null;
    const binding = observation.binding as Record<string, unknown> | null;
    out.push({
      predicate: "BINDING",
      subject: oid,
      value: binding
        ? { binding_id: binding.binding_id, binding_digest: binding.binding_digest }
        : null,
      provenance: obsError === null ? "CANONICAL" : "UNVERIFIED",
      sections: ["observation"],
    });

    // -- KPI measurements: PROVEN only when the progress chain re-proved --
    for (const k of (o.kpis as Array<Record<string, unknown>> | undefined) ?? []) {
      out.push({
        predicate: "KPI_MEASUREMENT",
        subject: String(k.kpi_id),
        value: {
          name: k.name,
          direction: k.direction,
          baseline: k.baseline,
          target: k.target,
          current: k.current,
          assessment: k.assessment,
        },
        provenance: unprovenKpiIds.has(String(k.kpi_id)) ? "UNVERIFIED" : "PROVEN",
        sections: ["objective"],
      });
    }
    if (obsError !== null) {
      out.push({
        predicate: "OBSERVATION_FAILED",
        subject: oid,
        value: { code: obsError },
        provenance: "UNVERIFIED",
        sections: ["observation"],
      });
    } else if (binding) {
      // kpi_summary is a strict-observation projection — only honest
      // when the observation itself re-proved.
      const ks = observation.kpi_summary as Record<string, unknown> | undefined;
      if (ks) {
        out.push({
          predicate: "KPI_SUMMARY",
          subject: oid,
          value: ks,
          provenance: "PROJECTED",
          sections: ["observation"],
        });
      }
    }

    // -- workstreams (canonical status + proven completion bit) --
    for (const w of (observation.workstreams as Array<Record<string, unknown>> | undefined) ?? []) {
      out.push({
        predicate: "WORKSTREAM_STATE",
        subject: String(w.workstream_key),
        value: {
          workstream_status: w.workstream_status,
          completion_proven: w.completion_proven,
          allocation_state: w.allocation_state,
          delegated_child: w.delegated_child
            ? {
                status: (w.delegated_child as Record<string, unknown>).status,
                completion_proven:
                  (w.delegated_child as Record<string, unknown>).completion_proven,
                lifecycle_class:
                  (w.delegated_child as Record<string, unknown>).lifecycle_class,
              }
            : null,
        },
        provenance: w.completion_proven === true ? "PROVEN" : "CANONICAL",
        sections: ["observation"],
      });
    }

    // -- lifecycle + latest review (review row is canonical; the
    //    summary shape is a projection of it) --
    out.push({
      predicate: "LIFECYCLE",
      subject: oid,
      value: lifecycle,
      provenance: "PROJECTED",
      sections: ["lifecycle"],
    });
    const latest = reviews.latest_review as Record<string, unknown> | null;
    if (latest) {
      out.push({
        predicate: "LATEST_REVIEW",
        subject: oid,
        value: {
          review_id: latest.review_id,
          outcome: latest.outcome,
          owner_action_required: latest.owner_action_required,
          wait_reason: latest.wait_reason,
          recommended_status: latest.recommended_status,
        },
        provenance: "CANONICAL",
        sections: ["reviews"],
      });
    }

    // -- autonomy surfaces (stored row = canonical; effective/reasons
    //    are clock-derived projections — the whole fact is PROJECTED) --
    const policy = autonomy.auto_policy as Record<string, unknown> | null;
    if (policy) {
      out.push({
        predicate: "AUTO_POLICY",
        subject: oid,
        value: {
          configured: policy.configured,
          state: policy.state,
          effective: policy.effective,
          expiry_pending: policy.expiry_pending ?? false,
          terms_current: policy.terms_current,
          halt: policy.halt,
        },
        provenance: "PROJECTED",
        sections: ["autonomy"],
      });
    }

    // -- artifact evidence (verified list is re-proven NOW) --
    out.push({
      predicate: "ARTIFACTS",
      subject: oid,
      value: {
        verified_count: ((artifacts.artifacts as unknown[]) ?? []).length,
        dropped_unverified: artifacts.artifacts_dropped_unverified ?? 0,
        truncated: artifacts.artifacts_truncated === true,
      },
      provenance: "CANONICAL",
      sections: ["artifacts"],
    });

    return out;
  }

  private hypotheses(
    ctx: ReturnType<BrainContextService["contextFor"]>,
    facts: BriefFact[],
  ): BriefHypothesis[] {
    const out: BriefHypothesis[] = [];
    const has = (p: string) => facts.some((f) => f.predicate === p);
    const observation = (ctx.sections.observation?.value ?? {}) as Record<string, unknown>;
    const lifecycle = (ctx.sections.lifecycle?.value ?? {}) as Record<string, unknown>;
    const autonomy = (ctx.sections.autonomy?.value ?? {}) as Record<string, unknown>;
    const policy = (autonomy.auto_policy ?? null) as Record<string, unknown> | null;
    const workstreams = (observation.workstreams ?? []) as Array<Record<string, unknown>>;
    const obsError = observation.observation_error as string | null;

    // Binding absence is only a claim when the observation COMPOSED —
    // under observation_error the binding is unobservable, not absent.
    if (
      obsError === null &&
      (!has("BINDING") || facts.find((f) => f.predicate === "BINDING")?.value === null)
    ) {
      out.push({
        id: "PRE_DECOMPOSITION",
        detail: "objective has no canonical workstream binding — no operational progress is possible until INITIALIZE commits one",
        rests_on: ["BINDING"],
      });
    }
    if (
      lifecycle.all_targets_met === true &&
      workstreams.some((w) => w.completion_proven !== true)
    ) {
      out.push({
        id: "MEASUREMENT_LEADS_EXECUTION",
        detail: "all KPI targets read met while canonical workstream completion is unproven — measurement may lead execution sync, or completion evidence is outstanding",
        rests_on: ["KPI_SUMMARY", "WORKSTREAM_STATE"],
      });
    }
    if (obsError !== null) {
      out.push({
        id: "OBSERVATION_AUTHORITY_CLOSED",
        detail: `strict observation fails closed (${obsError}) — delegated authority likely ended or a canonical re-proof failed; current progress is historical, not verifiable now`,
        rests_on: ["OBSERVATION_FAILED"],
      });
    }
    if (ctx.integrity.length > 0) {
      out.push({
        id: "INTEGRITY_GAPS_PRESENT",
        detail: `${ctx.integrity.length} integrity note(s) — parts of canonical state could not be re-proven this read`,
        rests_on: [],
      });
    }
    /* Canonical gating ONLY — state/configured/halt are stored row
       fields; effective/expiry_pending are clock-derived projections
       that must never move the digest (a lapsed window is still
       row-ENABLED until the lazy EXPIRED commit makes it canonical). */
    if (policy && policy.configured === true && policy.state !== "ENABLED") {
      out.push({
        id: "POLICY_NOT_ENABLED",
        detail: `auto-policy is configured but state is ${String(policy.state)} — no autonomous passes are authorized`,
        rests_on: ["AUTO_POLICY"],
      });
    }
    if (
      policy?.state === "ENABLED" &&
      lifecycle.owner_action_required === true &&
      autonomy.auto_driver != null // no driver exists to be blocked when unwired
    ) {
      out.push({
        id: "OWNER_GATE_BLOCKS_AUTONOMY",
        detail: "an adaptive review requires owner action — the auto-driver cannot pass until the owner resolves it",
        rests_on: ["AUTO_POLICY", "LATEST_REVIEW"],
      });
    }
    const ks = observation.kpi_summary as Record<string, unknown> | undefined;
    if (ks && Number(ks.gap_kpi_count ?? 0) > 0) {
      out.push({
        id: "KPI_GAPS_OPEN",
        detail: `${Number(ks.gap_kpi_count)} KPI(s) are unmet — objective is not near its success envelope`,
        rests_on: ["KPI_SUMMARY"],
      });
    }
    return out;
  }

  private options(
    ctx: ReturnType<BrainContextService["contextFor"]>,
    facts: BriefFact[],
  ): BriefOption[] {
    const out: BriefOption[] = [];
    const o = (ctx.sections.objective?.value ?? {}) as Record<string, unknown>;
    const lifecycle = (ctx.sections.lifecycle?.value ?? {}) as Record<string, unknown>;
    const autonomy = (ctx.sections.autonomy?.value ?? {}) as Record<string, unknown>;
    const policy = (autonomy.auto_policy ?? null) as Record<string, unknown> | null;
    const status = String(o.status ?? "");
    const terminal = TERMINAL_OBJECTIVE_STATUSES.has(status as ObjectiveStatus);
    const bindingFact = facts.find((f) => f.predicate === "BINDING");
    const hasBinding = bindingFact?.value !== null && bindingFact?.value !== undefined;
    const wsCount = facts.filter((f) => f.predicate === "WORKSTREAM_STATE").length;
    const unprovenKpi = facts.some(
      (f) => f.predicate === "KPI_MEASUREMENT" && f.provenance === "UNVERIFIED",
    );

    const obsErrorOpt = ((ctx.sections.observation?.value ?? {}) as Record<string, unknown>)
      .observation_error as string | null;
    if (!terminal) {
      // INITIALIZE/PRIORITIZE need an observable binding truth — under
      // observation_error "absent" is unknowable, not true. (Defense-
      // in-depth: obsError today implies terminal via the same
      // classifier, so this branch is belt-and-suspenders, kept so a
      // future non-terminal obsError can't smuggle options.)
      if (obsErrorOpt !== null) {
        // unobservable — no decomposition option is honest
      } else if (!hasBinding) {
        out.push({
          id: "CEO_INITIALIZE_WORKSTREAMS",
          kind: "CEO_DECISION",
          authority_channel: "CEO_CYCLE",
          rationale: "no canonical binding exists — the CEO decision lane can commit an initial decomposition",
          rests_on: ["BINDING"],
          tradeoff: "commits binding_digest + terms pin; a wrong decomposition costs a governed amendment/re-bind, not a silent retry",
        });
      } else if (wsCount > 0) {
        out.push({
          id: "CEO_PRIORITIZE_EXISTING",
          kind: "CEO_DECISION",
          authority_channel: "CEO_CYCLE",
          rationale: `${wsCount} canonical workstream(s) exist — the CEO lane can re-rank the full ordering`,
          rests_on: ["BINDING", "WORKSTREAM_STATE"],
          tradeoff: "re-ranking does not re-open proven-complete workstreams; a ranking that deprioritizes blocked work only delays the critical path",
        });
      }
      if (lifecycle.owner_action_required === true) {
        out.push({
          id: "OWNER_REVIEW_SIGNOFF",
          kind: "OWNER_ACTION",
          authority_channel: "owner-console routes",
          rationale: "the latest adaptive review is waiting on an owner decision — every driver pass stays blocked until it resolves",
          rests_on: ["LATEST_REVIEW", "LIFECYCLE"],
          tradeoff: "signing off commits the review outcome into canonical state; deferring keeps autonomy frozen",
        });
      }
      /* Currently unreachable in practice — KPI_PROGRESS_UNPROVEN is
         only emitted via the classified legitimate terminal-grant-end
         path, and terminal objectives emit zero options above. Kept
         deliberately: if a future non-terminal unproven classification
         lands, the governed move is already named honestly. */
      if (unprovenKpi) {
        out.push({
          id: "OWNER_RECORD_PROGRESS",
          kind: "OWNER_ACTION",
          authority_channel: "owner-console routes",
          rationale: "KPI progress could not be canonically re-proven this read (e.g. verifier grant ended) — a fresh owner measurement re-binds the chain",
          rests_on: ["KPI_MEASUREMENT"],
          tradeoff: "owner-attested measurement is evidence, not delegated verification — it records truth but cannot mint MET",
        });
      }
      if (policy) {
        // Every non-enabled state with a legal owner recovery move is
        // named (TRANSITIONS table, objective-auto-policy): omitting
        // one would hide the governed move from the reasoner. REVOKED
        // has no legal path back — correctly no option.
        if (policy.configured !== true) {
          out.push({
            id: "OWNER_CONFIGURE_POLICY",
            kind: "POLICY_CONTROL",
            authority_channel: "policy-configure route",
            rationale: "no auto-policy is configured — autonomous passes require an owner-approved policy envelope",
            rests_on: ["AUTO_POLICY"],
            tradeoff: "configuring creates the envelope; nothing runs until the owner also enables it",
          });
        } else if (policy.state === "DISABLED") {
          out.push({
            id: "OWNER_ENABLE_POLICY",
            kind: "POLICY_CONTROL",
            authority_channel: "policy-enable route",
            rationale: "auto-policy exists but is DISABLED — enabling is the owner-gated step that authorizes driver passes",
            rests_on: ["AUTO_POLICY"],
            tradeoff: "enabling authorizes bounded autonomy within the configured limits; the digest pin means any terms bump re-gates it",
          });
        } else if (policy.state === "PAUSED") {
          out.push({
            id: "OWNER_RESUME_POLICY",
            kind: "POLICY_CONTROL",
            authority_channel: "policy-resume route",
            rationale: "auto-policy is PAUSED — resume is a legal owner transition back to ENABLED (enable also reaches ENABLED and additionally rebinds terms_digest_binding)",
            rests_on: ["AUTO_POLICY"],
            // Gating on expiry_pending would reintroduce clock
            // volatility into the digest — honesty lives in the text.
            tradeoff: "resume reauthorizes bounded autonomy under the existing envelope — but if the authorization window already lapsed (expiry_pending), resume fail-closes and the completable path is disable → configure → enable",
          });
        } else if (policy.state === "EXPIRED") {
          out.push({
            id: "OWNER_RECONFIGURE_POLICY",
            kind: "POLICY_CONTROL",
            authority_channel: "policy-configure route",
            rationale: "auto-policy EXPIRED — only a fresh configure re-arms it (new authorization window + limits)",
            rests_on: ["AUTO_POLICY"],
            tradeoff: "re-arming is a NEW owner authorization, not a renewal — limits must be re-stated deliberately",
          });
        } else if (policy.state === "HALTED") {
          out.push({
            id: "OWNER_RESET_HALT",
            kind: "POLICY_CONTROL",
            authority_channel: "policy-reset_halt route",
            rationale: "auto-policy is HALTED — reset_halt is the halt-specific recovery transition that preserves the re-arm path (disable/revoke are also legal but read as abandonment)",
            rests_on: ["AUTO_POLICY"],
            tradeoff: "a halt marks a safety stop — resetting without understanding the halt reason defeats its purpose",
          });
        }
      }
      // WAIT is always a candidate — the canonical CEO vocabulary's
      // honest answer when no strategic move is justified now.
      out.push({
        id: "WAIT",
        kind: "AWAIT",
        authority_channel: "CEO_CYCLE",
        rationale: "no strategic action is justified now — observation continues under the existing envelope",
        rests_on: [],
        tradeoff: "waiting costs observation budget only; acting without an evidence gap would be authority without justification",
      });
    }
    return out;
  }

  private missingInformation(ctx: ReturnType<BrainContextService["contextFor"]>): BriefGap[] {
    return [
      ...ctx.unavailable.map(gapOf),
      ...ctx.integrity.map((i) => ({ code: "INTEGRITY", detail: i })),
    ];
  }

  private confidence(
    ctx: ReturnType<BrainContextService["contextFor"]>,
    facts: BriefFact[],
    missing: BriefGap[],
  ): BriefConfidence {
    if (ctx.integrity.length > 0 || facts.some((f) => f.predicate === "OBSERVATION_FAILED")) {
      return "LOW";
    }
    if (missing.some((g) => !isExpectedGap(g.code))) return "MEDIUM";
    if (facts.some((f) => f.provenance === "UNVERIFIED")) return "MEDIUM";
    return "HIGH";
  }

  /**
   * Read-only eligibility projection — the SAME gate the CEO cycle
   * runs, in the SAME order (resolveCeoModelTransport then
   * assertCeoModelUsable), reported rather than thrown. NEVER invokes.
   * Bounded catalog read (model/provider/receipt tryGets + the
   * model_role_assignment table — bounded by table size); a bad model
   * config is an answer, not a failure.
   */
  private reasoner(): BriefReasoner {
    const id = this.deps.model_entry_id;
    if (id === undefined || id === null || id === "") {
      return {
        model_entry_id: null,
        eligibility: "NOT_CONFIGURED",
        transport: null,
        failure_code: null,
      };
    }
    /* The canonical CEO gate is BOTH calls in THIS order — the cycle
       resolves transport before usability (ceo-planning-cycle
       :759-761). A resolved-but-ineligible entry reports UNQUALIFIED
       with its transport identity; an unresolvable entry is
       UNRESOLVED. Non-IntegrityError failures (corrupt store, bugs)
       propagate fail-closed — never masked as an eligibility answer. */
    let transport: BriefReasoner["transport"];
    try {
      const t = resolveCeoModelTransport(this.store, id);
      transport = {
        provider_id: t.provider_id,
        provider_family: t.provider_family,
        model_id: t.model_id,
        protocol_family: t.protocol_family,
      };
    } catch (err) {
      if (!(err instanceof IntegrityError)) throw err;
      return {
        model_entry_id: id,
        eligibility: "UNRESOLVED",
        transport: null,
        failure_code: String(err.code),
      };
    }
    try {
      assertCeoModelUsable(this.store, id);
      return { model_entry_id: id, eligibility: "QUALIFIED", transport, failure_code: null };
    } catch (err) {
      if (!(err instanceof IntegrityError)) throw err;
      const code = String(err.code);
      return {
        model_entry_id: id,
        eligibility: code.includes("UNRESOLVED") ? "UNRESOLVED" : "UNQUALIFIED",
        transport,
        failure_code: code,
      };
    }
  }
}
