/**
 * operational-query — Phase 1: read-only operational status for PAIR Chat.
 *
 * WHAT IT IS
 * ------------
 * The ONE governed read seam behind the conversational `observeOperatorContext`
 * hook. It composes bounded, authorized canonical evidence into a STATUS
 * envelope the conversation model may cite — it NEVER mutates canonical
 * state, NEVER creates missions/plans/drafts, and NEVER lets the model
 * touch the store. The model summarizes the envelope; the envelope is
 * derived only from canonical rows and the existing Mission Control read
 * projections.
 *
 * AUTHORIZATION MODEL (approved Phase-1 policy, audit-R2 hardened)
 * --------------------------------------------------------------
 *   admin    — the separate PAIR_MC_ADMIN_TOKEN credential, minted into a
 *              `ConversationPrincipal` at the HTTP boundary (bearer only).
 *              May read ALL operational state (global infra + every scope).
 *   operator — an MC-token caller carrying `x-operator-id`. The id is a
 *              CLAIMED identity and NOT verified authentication: scoped
 *              rows (claimed session ownership, BUSINESS_CREATED actor
 *              chains, objective owner_authority_id) prove things about a
 *              claimed id but never prove WHO is asking — so every scoped
 *              section is denied with `UNVERIFIED_IDENTITY`. Global-infra
 *              sections stay `INSUFFICIENT_AUTHORITY`. A future verified-
 *              identity mechanism can re-open scoped reads; until then the
 *              audit-mandated posture is default-deny.
 *   telegram — a `telegram:<chat_id>` ingress identity. Audit R2-F1: the
 *              ingress route authenticates only that the caller-proclaimed
 *              operator id EQUALS `telegram:<chat_id>` — it proves channel
 *              equality, not Telegram sender authenticity, and no
 *              explicit verifiable read grant exists for chat ids yet.
 *              So telegram is UNVERIFIED for operational data too: every
 *              scoped section is denied `UNVERIFIED_IDENTITY` (explicit
 *              grants are Phase 5 work). Telegram can never become admin.
 *   Default deny: where no canonical authority chain exists the section is
 *   reported `unavailable` — never widened, never guessed.
 *
 * HONESTY CONTRACT
 * ----------------
 * Every envelope carries `asof`, typed `unavailable[]` (authority or
 * evidence gaps), `integrity[]` (canonical-read failures, surfaced not
 * hidden), `sections_omitted[]`/`sections_truncated[]` for bound drops.
 * Cost keeps held/committed/settled microusd distinct and reports
 * unpriced_dispatches — unpriced is never rendered as zero.
 */

import crypto from "node:crypto";

import { utcnow } from "./canonical.js";
import { PairError } from "./errors.js";
import { CONVERSATION_STATUS_MAX_CHARS } from "./conversation-reasoning.js";
import type {
  ConversationPrincipal,
  OperatorContextRequest,
} from "./conversation-reasoning.js";
import type { PairEvidenceStore } from "./store.js";
import type {
  ConvReadGrantEffectiveScope,
  ConversationReadGrantService,
} from "./conversation-read-grant.js";

/* ------------------------------------------------------------------ *
 *  credential classification (HTTP boundary helper)                    *
 * ------------------------------------------------------------------ */

export type RequestAuthClass = "admin" | "operator" | "anonymous";

/** Constant-time credential compare — lengths differ → false without
 *  leaking prefix agreement through timing. */
function safeEqualSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Classify the presented API credential at the request boundary.
 *
 * - `admin` requires the SEPARATE admin token; when `adminToken` equals
 *   `authToken` the admin lane is disabled outright — the MC token can
 *   never be a self-admin credential even under misconfiguration.
 * - `operator` = the MC bearer token (scoped; never admin).
 * - `anonymous` = anything else (401'd by the MC gate when configured;
 *   in gateless local dev it maps to the scoped `operator` principal —
 *   identity remains a claim and scope stays evidence-proven).
 */
export function classifyRequestCredential(args: {
  credential: string;
  authToken?: string;
  adminToken?: string;
}): RequestAuthClass {
  const adminEnabled =
    typeof args.adminToken === "string" &&
    args.adminToken !== "" &&
    args.adminToken !== args.authToken;
  if (
    adminEnabled &&
    args.credential !== "" &&
    safeEqualSecret(args.credential, String(args.adminToken))
  ) {
    return "admin";
  }
  if (
    typeof args.authToken === "string" &&
    args.authToken !== "" &&
    safeEqualSecret(args.credential, args.authToken)
  ) {
    return "operator";
  }
  return "anonymous";
}

/* ------------------------------------------------------------------ *
 *  intent classification — deterministic weighted bilingual lexicon    *
 * ------------------------------------------------------------------ */

export type OperationalIntent =
  | "ACTIVE_WORK"
  | "PROVIDER_STATUS"
  | "ATTENTION"
  | "COST"
  | "GENERIC";

/** Normalize for matching: lowercase, strip Vietnamese diacritics via
 *  NFD decomposition, drop punctuation, collapse whitespace — so
 *  "đang làm gì" and "dang lam gi" hit the same phrase. Matching is
 *  phrase-substring based, never single-token. */
function normalizeQueryText(text: string): string {
  return ` ${String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** Weighted phrase cues per intent (unaccented Vi + En). A cue must be a
 *  phrase or domain term — never a bare function word — so ordinary
 *  conversation does not trigger operational fetches. */
const INTENT_PHRASES: Record<
  Exclude<OperationalIntent, "GENERIC">,
  Array<[phrase: string, weight: number]>
> = {
  ACTIVE_WORK: [
    ["what is pair doing", 3], ["what is pair working", 3],
    ["pair dang lam gi", 3], ["pair dang chay", 3],
    ["what missions", 2.5], ["which missions", 2.5], ["active mission", 2.5],
    ["mission nao", 2.5], ["mission dang", 2.5],
    ["what is running", 2.5], ["currently running", 2.5], ["dang chay gi", 2.5],
    ["nhiem vu nao", 2.5], ["dang thuc hien", 2.5],
    ["running task", 2], ["dang xu ly", 2],
  ],
  PROVIDER_STATUS: [
    ["provider", 2], ["executor", 2],
    ["which model", 2.5], ["model nao", 2.5], ["mo hinh nao", 2.5],
    ["authenticated", 2], ["xac thuc", 2],
    ["available", 1.5], ["kha dung", 2], ["con song", 2],
    ["healthy", 1.5], ["health", 1.5], ["suc khoe", 2],
    ["routable", 2], ["route", 1],
  ],
  ATTENTION: [
    ["needs my attention", 3], ["can toi xu ly", 3], ["can xu ly", 2.5],
    ["pending approval", 2.5], ["cho duyet", 2.5], ["can duyet", 2.5],
    ["blocker", 2], ["bi ket", 2.5], ["bi block", 2.5], ["stuck", 2],
    ["any errors", 2], ["loi nao", 2], ["co loi", 2], ["co gi can", 2],
    ["requires me", 2], ["requires my", 2], ["waiting on me", 2.5],
  ],
  COST: [
    ["bao nhieu tien", 3], ["ton bao nhieu", 3], ["da tieu", 2.5],
    ["chi phi", 2.5], ["ngan sach", 2.5],
    ["cost", 2], ["spend", 2], ["spent", 2], ["spending", 2],
    ["budget", 2], ["how much", 2], ["reserved", 1.5],
    ["reservation", 1.5],
  ],
};

const INTENT_ORDER: Array<Exclude<OperationalIntent, "GENERIC">> = [
  "ACTIVE_WORK",
  "PROVIDER_STATUS",
  "ATTENTION",
  "COST",
];

/** Minimum score for a phrase match to select an intent. Below it the
 *  question gets the GENERIC base envelope — the model still answers
 *  honestly from whatever evidence exists. */
const INTENT_MIN_SCORE = 2;

/** Returns EVERY intent at/above the score floor — a mixed question
 *  ("providers and spend?") fetches the union of its sections, still
 *  per-section bounded. Empty → ["GENERIC"] (the base envelope). */
export function classifyOperationalIntents(text: string): OperationalIntent[] {
  const norm = normalizeQueryText(text);
  const out: OperationalIntent[] = [];
  for (const intent of INTENT_ORDER) {
    let score = 0;
    for (const [phrase, weight] of INTENT_PHRASES[intent]) {
      if (norm.includes(` ${phrase} `) || norm.includes(`${phrase} `) || norm.includes(` ${phrase}`)) {
        score += weight;
      }
    }
    if (score >= INTENT_MIN_SCORE) out.push(intent);
  }
  return out.length === 0 ? ["GENERIC"] : out;
}

/* ------------------------------------------------------------------ *
 *  envelope constants                                                   *
 * ------------------------------------------------------------------ */

/** Per-section item caps — applied BEFORE serialization so the envelope
 *  is always valid JSON and never a truncated fragment. */
const SECTION_ITEM_CAP: Record<string, number> = {
  active_missions: 8,
  running_executions: 8,
  providers: 12,
  executors: 12,
  pending_approvals: 8,
  blocked_work_items: 8,
  degraded_subsystems: 8,
  waiting_missions: 8,
  objectives_owned: 10,
  objective_spend: 12,
};

/** Drop order when the serialized envelope exceeds the char bound —
 *  least-question-relevant sections go first. */
const SECTION_DROP_ORDER = [
  "objectives_owned",
  "providers",
  "executors",
  "running_executions",
  "attention",
  "cost",
  "active_missions",
];

/** Terminal mission_runtime states — active = everything else (plus a
 *  mission with no runtime row, reported honestly as UNKNOWN). */
const TERMINAL_RUNTIME = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABORTED",
]);
const TERMINAL_EXECUTION = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

const INSUFFICIENT_AUTHORITY = "INSUFFICIENT_AUTHORITY";
const INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE";
/** R1-F1 — the caller's claimed identity cannot be verified
 *  (x-operator-id is a claim, never authentication): every scoped
 *  section defaults to this denial. Distinct from INSUFFICIENT_AUTHORITY
 *  so the model can say "I can't verify who you are" honestly. */
const UNVERIFIED_IDENTITY = "UNVERIFIED_IDENTITY";

/* ------------------------------------------------------------------ *
 *  bounded item helpers                                                 *
 * ------------------------------------------------------------------ */

/** Clip an untrusted string for the envelope: strip control characters
 *  (no newlines breaking the STATUS block) and cap length. */
function clip(value: unknown, max = 140): string {
  const s = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function capItems<T>(
  items: T[],
  capKey: string,
): { items: T[]; total: number; truncated: boolean } {
  const cap = SECTION_ITEM_CAP[capKey] ?? 8;
  return {
    items: items.slice(0, cap),
    total: items.length,
    truncated: items.length > cap,
  };
}

/* ------------------------------------------------------------------ *
 *  the service                                                          *
 * ------------------------------------------------------------------ */

interface OperatorScope {
  /** `operator:<id>` canonical actor + the raw operator id — both forms
   *  appear canonically (owner_authority_id/event actor vs session and
   *  draft owner_operator_id). */
  actors: Set<string>;
  objectiveIds: Set<string>;
  businessIds: Set<string>;
  missionIds: Set<string>;
}

/** The read-only projection surface the query service composes over —
 *  structurally the MissionControl facade; declared minimally so the
 *  contract is exactly "canonical reads, no mutation surface". */
export interface OperationalReadSurface {
  missions(): Array<Record<string, unknown>>;
  providers(): { providers: Array<Record<string, unknown>>; qualifications?: unknown };
  routing(): {
    executors?: Array<Record<string, unknown>>;
    routable?: unknown;
    [k: string]: unknown;
  };
  approvals(): Array<Record<string, unknown>>;
  health(): Record<string, { state?: string; detail?: string }>;
  cost(): Record<string, unknown>;
}

export interface OperationalQueryDeps {
  store: PairEvidenceStore;
  /** Mission Control read facade — providers/models/routes/routing/
   *  recovery/approvals/health/metrics/cost projections. */
  control: OperationalReadSurface;
  /** Envelope bound (default CONVERSATION_STATUS_MAX_CHARS). */
  status_max_chars?: number;
  /** P16-D — the canonical verified-read-grant service. When wired,
   *  operator/telegram principals carrying an ENABLED + unexpired grant
   *  for their canonical principal_ref are verified for the scoped
   *  sections the grant vouches; without it every non-admin principal
   *  stays UNVERIFIED_IDENTITY (unchanged default-deny). */
  readGrants?: Pick<ConversationReadGrantService, "scopeForPrincipal">;
  /** TEST seam — deterministic asof. */
  now?: () => string;
}

export class OperationalQueryService {
  constructor(private readonly deps: OperationalQueryDeps) {}

  /** The `observeOperatorContext` implementation — builds the authorized,
   *  bounded STATUS envelope for one turn. Never throws: a catastrophic
   *  failure degrades to an integrity-marked envelope so the model can
   *  report the gap honestly instead of fabricating state. */
  statusForConversation(ctx: OperatorContextRequest): Record<string, unknown> {
    const asof = this.deps.now?.() ?? utcnow();
    try {
      const envelope = this.buildEnvelope(ctx, asof);
      return this.boundEnvelope(envelope);
    } catch (e) {
      return {
        asof,
        principal: {
          kind: ctx.principal.kind,
          operator_id: ctx.principal.operator_id,
        },
        intents: ["GENERIC"],
        sections: {},
        unavailable: [],
        integrity: [
          {
            section: "*",
            error: e instanceof PairError ? e.code : "OPERATIONAL_QUERY_FAILED",
          },
        ],
        sections_omitted: [],
        sections_truncated: [],
      };
    }
  }

  /* ---------------- authorization scope ------------------------------ */

  /** Canonical proof of what a scoped actor ref may see. Derived fresh
   *  per turn from canonical rows only — a message mentioning an entity
   *  never grants access. The ref may be a raw claim ("alice") or a
   *  canonical `operator:<id>`; both forms are tried. */
  private scopeForActorRef(actorRef: string): OperatorScope {
    const raw = String(actorRef);
    const actors = new Set<string>([raw, canonicalOperatorActor(raw)]);
    // Canonical refs also try their BARE form — some canonical surfaces
    // (conversation_mission_draft.owner_operator_id) store the raw claim
    // ("alice") rather than `operator:alice`; dropping it would silently
    // under-serve a footprint grant versus the claim's own view.
    if (raw.startsWith("operator:")) actors.add(raw.slice("operator:".length));
    const objectiveIds = new Set<string>();
    const businessIds = new Set<string>();
    const missionIds = new Set<string>();

    for (const o of this.deps.store.list("objective")) {
      if (actors.has(String(o.owner_authority_id ?? ""))) {
        objectiveIds.add(String(o.objective_id));
        businessIds.add(String(o.business_id));
      }
    }
    for (const ev of this.deps.store.listEvents("business")) {
      if (
        String(ev.event_type) === "BUSINESS_CREATED" &&
        actors.has(String(ev.actor ?? ""))
      ) {
        businessIds.add(String(ev.entity_id));
      }
    }
    // Missions proven through the operator's own conversation drafts.
    for (const d of this.deps.store.list("conversation_mission_draft")) {
      if (actors.has(String(d.owner_operator_id ?? "")) && d.mission_id) {
        missionIds.add(String(d.mission_id));
      }
    }
    for (const mid of this.missionsForBusinesses(businessIds)) {
      missionIds.add(mid);
    }
    return { actors, objectiveIds, businessIds, missionIds };
  }

  /** Missions bound to an accessible business via the canonical
   *  work_open_binding chain (bound_open_id → binding.business_id). */
  private missionsForBusinesses(businessIds: Set<string>): Set<string> {
    const missionIds = new Set<string>();
    const bindingBusinessByMission = new Map<string, string>();
    for (const b of this.deps.store.list("work_open_binding")) {
      if (b.mission_id) {
        bindingBusinessByMission.set(String(b.mission_id), String(b.business_id));
      }
    }
    for (const m of this.deps.store.list("mission")) {
      const businessId = bindingBusinessByMission.get(String(m.mission_id));
      if (businessId !== undefined && businessIds.has(businessId)) {
        missionIds.add(String(m.mission_id));
      }
    }
    return missionIds;
  }

  /** P16-D — the OperatorScope a set of verified read grants vouches:
   *  declared objective/business ids exactly (no implied expansion), plus
   *  the full derived footprint of every own_footprint operator_ref, plus
   *  binding-chain missions on the unioned businesses. */
  private scopeForGrants(grants: ConvReadGrantEffectiveScope): OperatorScope {
    const actors = new Set<string>();
    const objectiveIds = new Set<string>(grants.objective_ids);
    const businessIds = new Set<string>(grants.business_ids);
    const missionIds = new Set<string>();
    for (const ref of grants.operator_refs) {
      const s = this.scopeForActorRef(ref);
      for (const x of s.actors) actors.add(x);
      for (const x of s.objectiveIds) objectiveIds.add(x);
      for (const x of s.businessIds) businessIds.add(x);
      for (const x of s.missionIds) missionIds.add(x);
    }
    for (const mid of this.missionsForBusinesses(businessIds)) {
      missionIds.add(mid);
    }
    return { actors, objectiveIds, businessIds, missionIds };
  }

  /* ---------------- section composers -------------------------------- */

  private buildEnvelope(
    ctx: OperatorContextRequest,
    asof: string,
  ): Record<string, unknown> {
    const isAdmin = ctx.principal.kind === "admin";
    const sections: Record<string, unknown> = {};
    const unavailable: Array<{ section: string; reason: string }> = [];
    const integrity: Array<{ section: string; error: string }> = [];

    // R1-F1 + R2-F1 — `operator` is a caller claim and `telegram` proves
    // only chat-id equality: neither is verified sender identity. P16-D —
    // an explicit canonical read grant can vouch a non-admin principal for
    // bounded scoped reads; without one (or when the grant service is not
    // wired, or grant resolution fails) the principal stays UNVERIFIED.
    let grantScope: OperatorScope | null = null;
    if (!isAdmin && this.deps.readGrants) {
      try {
        const principalRef =
          ctx.principal.kind === "telegram"
            ? String(ctx.principal.operator_id)
            : canonicalOperatorActor(String(ctx.principal.operator_id));
        const effective = this.deps.readGrants.scopeForPrincipal(principalRef);
        if (effective) grantScope = this.scopeForGrants(effective);
      } catch (e) {
        // Fail closed — grant-resolution failure denies the scope and is
        // recorded as an integrity note, never served as data.
        integrity.push({
          section: "authorization",
          error: e instanceof PairError ? e.code : "READ_FAILED",
        });
      }
    }
    const verified = isAdmin || grantScope !== null;
    const intents = classifyOperationalIntents(ctx.latest_message.body);
    /** Section selector — intent keys plus the scope-context pseudo-section
     *  `objectives_owned` that grounds scoped principals. */
    const want = new Set<string>(intents);
    if (want.has("GENERIC")) {
      want.delete("GENERIC");
      want.add("ACTIVE_WORK");
      want.add("ATTENTION");
    }

    // Non-admin principals always get the (denied) own-footprint context —
    // what makes an empty global answer honest, not just empty.
    if (!isAdmin) want.add("objectives_owned");

    /** Unverified principals see an explicit denial on every requested
     *  section — never silent emptiness, never foreign data. */
    const deny = (name: string) => {
      unavailable.push({
        section: name,
        reason: verified ? INSUFFICIENT_AUTHORITY : UNVERIFIED_IDENTITY,
      });
    };

    // Admin reads stay unscoped (null); granted principals read exactly the
    // vouched scope. Unverified principals never reach a section composer.
    const scope = grantScope;

    const guarded = (name: string, fn: () => unknown) => {
      try {
        const v = fn();
        if (v !== undefined) sections[name] = v;
      } catch (e) {
        // Typed codes only — raw error text may carry paths/config detail
        // and must never reach the model-visible envelope.
        integrity.push({
          section: name,
          error: e instanceof PairError ? e.code : "READ_FAILED",
        });
      }
    };

    if (want.has("ACTIVE_WORK")) {
      if (!verified) {
        deny("active_missions");
        deny("running_executions");
      } else {
        guarded("active_missions", () => this.activeMissions(scope));
        guarded("running_executions", () => this.runningExecutions(scope));
      }
    }
    if (want.has("PROVIDER_STATUS")) {
      if (isAdmin) {
        guarded("providers", () => this.providers());
        guarded("executors", () => this.executors());
      } else {
        deny("providers");
        deny("executors");
      }
    }
    if (want.has("ATTENTION")) {
      if (!verified) deny("attention");
      else guarded("attention", () => this.attention(isAdmin, scope));
    }
    if (want.has("COST")) {
      if (!verified) deny("cost");
      else guarded("cost", () => this.cost(isAdmin, scope));
    }
    if (want.has("objectives_owned")) {
      if (!verified) deny("objectives_owned");
      else guarded("objectives_owned", () => this.ownedObjectives(scope!));
    }

    return {
      asof,
      principal: {
        kind: ctx.principal.kind,
        operator_id: ctx.principal.operator_id,
      },
      intents,
      sections,
      unavailable,
      integrity,
      sections_omitted: [] as string[],
      sections_truncated: [] as string[],
    };
  }

  private activeMissions(scope: OperatorScope | null): unknown {
    const missions = this.deps.control.missions();
    const items = missions
      .filter((m) => {
        const state = String(m.runtime_state ?? "UNKNOWN");
        return !TERMINAL_RUNTIME.has(state);
      })
      .filter((m) => scope === null || scope.missionIds.has(String(m.mission_id)))
      .map((m) => ({
        mission_id: String(m.mission_id),
        runtime_state: String(m.runtime_state ?? "UNKNOWN"),
        project_id: clip(m.project_id, 80),
        created_at: clip(m.created_at, 40),
        ...(m.bound_open_id ? { bound_open_id: clip(m.bound_open_id, 80) } : {}),
      }));
    const capped = capItems(items, "active_missions");
    return { ...capped, terminal_states: [...TERMINAL_RUNTIME] };
  }

  private runningExecutions(scope: OperatorScope | null): unknown {
    const items = this.deps.store
      .list("executor_execution")
      .filter((e) => !TERMINAL_EXECUTION.has(String(e.execution_state ?? "")))
      .filter((e) => scope === null || scope.missionIds.has(String(e.mission_id)))
      .map((e) => ({
        execution_id: String(e.execution_id),
        mission_id: String(e.mission_id ?? ""),
        task_id: clip(e.task_id, 80),
        executor_id: clip(e.executor_id, 80),
        execution_state: String(e.execution_state ?? "UNKNOWN"),
        created_at: clip(e.created_at, 40),
      }));
    return capItems(items, "running_executions");
  }

  private providers(): unknown {
    const rows = this.deps.control.providers().providers as Array<
      Record<string, unknown>
    >;
    const items = rows.map((p) => ({
      provider_id: clip(p.provider_id, 80),
      lifecycle_state: String(p.lifecycle_state ?? "UNKNOWN"),
      auth_state: String(p.auth_state ?? "UNKNOWN"),
      probe_state: String(p.probe_state ?? "UNKNOWN"),
      health_state: String(p.health_state ?? "UNKNOWN"),
      credential_status: String(p.credential_status ?? "unavailable"),
    }));
    return capItems(items, "providers");
  }

  private executors(): unknown {
    const routing = this.deps.control.routing() as {
      executors?: Array<Record<string, unknown>>;
      routable?: unknown;
    };
    // RoutableRow lists EVERY executor with per-gate results — only the
    // `routable === true` ones are actually servable; carry the first
    // failing gate as the honest reason for the rest.
    const routableIds = new Set<string>();
    const notRoutable = new Map<string, string>();
    const rt = routing.routable;
    for (const r of Array.isArray(rt) ? rt : []) {
      const row = r as Record<string, unknown>;
      if (!row.executor_id) continue;
      if (row.routable === true) routableIds.add(String(row.executor_id));
      else if (row.reason_not_routable) {
        notRoutable.set(String(row.executor_id), clip(row.reason_not_routable, 60));
      }
    }
    const items = (routing.executors ?? []).map((e) => {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      const pick = (k: string) => String(e[k] ?? meta[k] ?? "UNKNOWN");
      const id = String(e.executor_id);
      return {
        executor_id: id,
        availability_state: pick("availability_state"),
        health_state: pick("health_state"),
        auth_state: pick("auth_state"),
        qualification_state: pick("qualification_state"),
        routable: routableIds.has(id),
        ...(notRoutable.has(id)
          ? { reason_not_routable: notRoutable.get(id) }
          : {}),
      };
    });
    return capItems(items, "executors");
  }

  private attention(isAdmin: boolean, scope: OperatorScope | null): unknown {
    const inScope = (missionId: unknown) =>
      scope === null || scope.missionIds.has(String(missionId));
    const approvals = (this.deps.control.approvals() as Array<Record<string, unknown>>)
      .filter((a) => String(a.status ?? "") === "PENDING")
      .filter((a) => inScope(a.mission_id))
      .map((a) => ({
        approval_id: String(a.approval_id ?? a.id ?? ""),
        mission_id: String(a.mission_id ?? ""),
        scope_kind: clip(
          (a.scope as Record<string, unknown> | undefined)?.kind ??
            (a.scope_snapshot as Record<string, unknown> | undefined)?.kind,
          60,
        ),
      }));
    const blocked = this.deps.store
      .list("work_item")
      .filter((w) => String(w.status ?? "") === "BLOCKED")
      .filter((w) => scope === null || scope.businessIds.has(String(w.business_id)))
      .map((w) => ({
        work_item_id: String(w.work_item_id),
        business_id: String(w.business_id ?? ""),
        blocked_code: clip(w.blocked_code, 60),
        title: clip(w.title, 80),
      }));
    const waitingMissions = this.deps.control
      .missions()
      .filter(
        (m) =>
          String(m.runtime_state ?? "") === "WAITING_APPROVAL" &&
          inScope(m.mission_id),
      )
      .map((m) => String(m.mission_id));

    const out: Record<string, unknown> = {
      pending_approvals: capItems(approvals, "pending_approvals"),
      blocked_work_items: capItems(blocked, "blocked_work_items"),
      waiting_missions: capItems(waitingMissions, "waiting_missions"),
    };
    if (isAdmin) {
      const health = this.deps.control.health() as Record<
        string,
        { state?: string; detail?: string }
      >;
      const degraded = Object.entries(health)
        .filter(([, h]) => String(h.state ?? "READY") !== "READY")
        .map(([name, h]) => ({
          subsystem: name,
          state: String(h.state ?? "UNKNOWN"),
          detail: clip(h.detail, 80),
        }));
      out.degraded_subsystems = capItems(degraded, "degraded_subsystems");
    } else {
      out.degraded_subsystems = { unavailable: INSUFFICIENT_AUTHORITY };
    }
    return out;
  }

  private cost(isAdmin: boolean, scope: OperatorScope | null): unknown {
    if (!isAdmin) {
      // Scoped operators see spend proven through their own objectives —
      // the global reservation position is admin-only evidence.
      const entries = this.deps.store
        .list("objective")
        .filter((o) => scope!.objectiveIds.has(String(o.objective_id)))
        .map((o) => {
          const budget = (o.budget ?? {}) as Record<string, unknown>;
          return {
            objective_id: String(o.objective_id),
            business_id: String(o.business_id ?? ""),
            consumed_microusd: Number(budget.consumed_microusd ?? 0),
            ceiling_microusd: Number(budget.ceiling_microusd ?? 0),
          };
        });
      return {
        scope: "owned_objectives",
        global_position: `unavailable:${INSUFFICIENT_AUTHORITY}`,
        objective_spend: capItems(entries, "objective_spend"),
      };
    }
    const c = this.deps.control.cost() as Record<string, unknown>;
    const monetary = (c.monetary ?? {}) as Record<string, unknown>;
    if (Object.keys(monetary).length === 0) {
      return { status: INSUFFICIENT_EVIDENCE };
    }
    return {
      scope: "global",
      held_microusd: Number(monetary.held_microusd ?? 0),
      committed_microusd: Number(monetary.committed_microusd ?? 0),
      settled_microusd: Number(monetary.settled_microusd ?? 0),
      unpriced_dispatches: Number(monetary.unpriced_dispatches ?? 0),
      cost_halt: c.cost_halt === true,
      remote_dispatches_today: Number(c.remote_dispatches_today ?? 0),
      remote_daily_limit: Number(c.remote_daily_limit ?? 0),
      reservations_held: Array.isArray(monetary.reservations_held)
        ? monetary.reservations_held.length
        : 0,
      reservations_committed: Array.isArray(monetary.reservations_committed)
        ? monetary.reservations_committed.length
        : 0,
      billing_mode_breakdown: monetary.billing_mode_breakdown ?? {},
    };
  }

  private ownedObjectives(scope: OperatorScope): unknown {
    const items = this.deps.store
      .list("objective")
      .filter((o) => scope.objectiveIds.has(String(o.objective_id)))
      .map((o) => ({
        objective_id: String(o.objective_id),
        business_id: String(o.business_id ?? ""),
        status: String(o.status ?? "UNKNOWN"),
        title: clip(o.title, 80),
      }));
    return capItems(items, "objectives_owned");
  }

  /* ---------------- envelope bounding --------------------------------- */

  /** Section caps were applied per-item already; this drops whole
   *  sections until the serialized envelope fits — output is ALWAYS
   *  valid JSON, never a sliced fragment. */
  private boundEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
    const bound = Math.max(
      256,
      this.deps.status_max_chars ?? CONVERSATION_STATUS_MAX_CHARS,
    );
    const sections = envelope.sections as Record<string, unknown>;
    const omitted = envelope.sections_omitted as string[];
    for (const name of SECTION_DROP_ORDER) {
      if (JSON.stringify(envelope).length <= bound) return envelope;
      if (name in sections) {
        delete sections[name];
        omitted.push(name);
      }
    }
    if (JSON.stringify(envelope).length <= bound) return envelope;
    // Last resort — emit the honest minimal skeleton.
    return {
      asof: envelope.asof,
      principal: envelope.principal,
      intents: envelope.intents,
      sections: {},
      unavailable: [
        ...(envelope.unavailable as Array<unknown>),
        { section: "*", reason: INSUFFICIENT_EVIDENCE },
      ],
      integrity: envelope.integrity,
      sections_omitted: [
        ...Object.keys(sections),
        ...omitted,
      ],
      sections_truncated: envelope.sections_truncated,
    };
  }
}

/** Canonical actor form used by owner_authority_id and event actors:
 *  `alice` → `operator:alice`; `operator:alice` stays as-is (the same
 *  once-only rule as objective-authority). */
export function canonicalOperatorActor(operatorId: string): string {
  const raw = String(operatorId);
  return raw.startsWith("operator:") ? raw : `operator:${raw}`;
}
