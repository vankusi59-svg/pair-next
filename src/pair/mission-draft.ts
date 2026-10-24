/**
 * P15.8-C — Mission Draft + governed conversational confirmation.
 *
 * Drafts are the ONLY bridge between conversation mode and mission
 * authority: Conversation → Mission Draft → explicit operator
 * confirmation → the CANONICAL plan-preview/confirm pipeline
 * (`createPlanPreview` → `confirmPlanPreview`). A conversation message —
 * "OK", "làm đi", "yes" — is never execution authority by itself; the
 * ack path only resolves WHICH single pending draft the operator means,
 * and the actual submission still runs this module's confirmation
 * operation with digest-bound intent.
 *
 * Exactly-once (§7): the draft's own durable state machine is the
 * linearization point.
 *
 *   PENDING_CONFIRMATION ──(claim CAS)──▶ SUBMITTING ──(settle)──▶ CONFIRMED
 *        │                                    │                      │
 *        ├─→ REJECTED                          │ preview pinned once  │ mission_id receipt
 *        └─→ EXPIRED                            │ (CAS; losers adopt)  │
 *
 * claim → createPlanPreview (planner runs OUTSIDE the txn, only AFTER
 * confirmation authority is proven) → pin preview CAS → confirmPlanPreview
 * (its own atomic txn mints the mission + consumes the preview) → settle.
 *
 * Crash windows:
 *   post-claim/pre-pin   → retry re-runs createPlanPreview (a preview is
 *                          not a mission; orphaned READY previews expire).
 *   post-pin/pre-confirm → retry confirms the SAME pinned preview — the
 *                          planner is never invoked twice for a bound draft.
 *   post-mission/pre-settle → preview is CONSUMED; confirmPlanPreview's
 *                          ALREADY_CONSUMED replay returns the existing
 *                          mission_id — settle writes the receipt, zero
 *                          new missions and zero new planner calls.
 *   post-settle          → CONFIRMED + mission_id → pure receipt replay.
 *
 * If a racing claim pinned a different preview first, the pin CAS loses
 * and that caller adopts the pinned preview — one preview, one mission.
 */
import {
  canonicalWorkspacePath,
  digest,
  isCanonicalRiskCeiling,
  isCanonicalWorkspacePath,
  newId,
  utcnow,
} from "./canonical.js";
import { IntegrityError, PolicyError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type { ConversationSessionService } from "./conversation-session.js";
import type { MissionControl } from "./mission-control.js";
import type { DelegatedPlanExpander } from "./business.js";

export const MISSION_DRAFT_ENTITY = "conversation_mission_draft";
export const MISSION_DRAFT_SCHEMA = "pair.os.vnext.conversation-mission-draft.v1";

export const MISSION_DRAFT_STATES = [
  "PENDING_CONFIRMATION",
  "SUBMITTING",
  "CONFIRMED",
  "REJECTED",
  "EXPIRED",
  // R1.B — the pinned preview's canonical TTL lapsed while the draft
  // was claimed; terminal and truthful: the presented confirmation is
  // spent. A new draft is required — nothing replans silently.
  "SUBMISSION_EXPIRED",
] as const;
export type MissionDraftState = (typeof MISSION_DRAFT_STATES)[number];

export const MISSION_DRAFT_MAX_GOAL_CHARS = 8000;
export const MISSION_DRAFT_MAX_CONSTRAINT_ITEMS = 32;
export const MISSION_DRAFT_MAX_PENDING_PER_SESSION = 8;
export const MISSION_DRAFT_MAX_PER_SESSION = 64;
export const MISSION_DRAFT_DEFAULT_TTL_S = 3600;

export const MISSION_DRAFT_CONFIRM_KINDS = ["explicit", "ack"] as const;

export interface MissionDraftRow {
  schema_version: string;
  draft_id: string;
  session_id: string;
  owner_operator_id: string;
  project_id: string;
  goal: string;
  granted_permissions: string[];
  authorized_workspaces: string[] | null; // null = inherit project root at preview
  risk_ceiling: string | null;            // null = canonical default at preview
  draft_digest: string;
  state: MissionDraftState;
  created_at: string;
  expires_at: string;
  client_request_id: string | null;
  supersedes_draft_id: string | null;
  claimed_at: string | null;
  confirmation_kind: string | null;
  preview_id: string | null;
  plan_digest: string | null;
  mission_id: string | null;
  submitted_at: string | null;
  correlation_id: string | null;
}

/** Terms digest — binds the exact proposal the operator was shown. State
 *  and receipt fields are deliberately outside it: the digest is the
 *  identity the confirmation targets, never the outcome. */
export function missionDraftDigest(row: {
  draft_id: string;
  session_id: string;
  owner_operator_id: string;
  project_id: string;
  goal: string;
  granted_permissions: unknown[];
  authorized_workspaces: unknown[] | null;
  risk_ceiling: unknown;
}): string {
  return digest({
    contract: "pair-conversation-mission-draft.v1",
    draft_id: row.draft_id,
    session_id: row.session_id,
    owner_operator_id: row.owner_operator_id,
    project_id: row.project_id,
    goal: row.goal,
    granted_permissions: row.granted_permissions,
    authorized_workspaces: row.authorized_workspaces,
    risk_ceiling: row.risk_ceiling ?? null,
  });
}

/** Deterministic draft identity for caller request ids — a retried
 *  create converges onto the committed draft instead of duplicating. */
export function missionDraftIdFor(sessionId: string, clientRequestId: string): string {
  return `MDR_${digest(`conversation-draft-id:${sessionId}:${clientRequestId}`).slice(0, 26)}`;
}

function assertDraftField(field: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_DRAFT_FIELD", `${field} invalid`);
  }
  return v;
}

function assertStrList(field: string, v: unknown, max: number): string[] {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || !x.trim())) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_DRAFT_FIELD", `${field} invalid`);
  }
  return v.map((x) => String(x));
}

export class MissionDraftService {
  /** Per-draft serialization — concurrent confirms/creates queue so the
   *  claim → pin → confirm → settle chain never interleaves mid-turn.
   *  Cross-process races still converge via the state machine + preview
   *  consume CAS (see file header). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      conversation: ConversationSessionService;
      /** Governed submission path — the service calls ONLY
       *  createPlanPreview + confirmPlanPreview on it, after draft
       *  confirmation authority is proven. */
      control: MissionControl;
      /** Phase C — the ONE shared async LLM Planner Pool seam (the same
       *  expander the API preview/submit edge, schedules and delegated
       *  opens use). Absent → confirm fails closed FAIL_CLOSED_NO_PLANNER:
       *  zero provider calls, zero fabricated planner_run evidence, the
       *  draft stays SUBMITTING for an honest retry. */
      planExpander?: DelegatedPlanExpander;
      store: PairEvidenceStore;
      draft_ttl_s?: number;
      now?: () => string;
    },
  ) {}

  /* ------------------------------------------------------------------ */
  /* Canonical reads                                                     */
  /* ------------------------------------------------------------------ */

  private assertCanonicalDraft(row: Record<string, unknown>): void {
    if (String(row.schema_version) !== MISSION_DRAFT_SCHEMA) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_DRAFT_SCHEMA",
        `${String(row.draft_id ?? row.entity_id)}:${String(row.schema_version ?? "absent")}`,
      );
    }
    for (const f of [
      "draft_id", "session_id", "owner_operator_id",
      "project_id", "goal", "draft_digest", "state", "created_at", "expires_at",
    ]) {
      assertDraftField(f, row[f]);
    }
    if (!(MISSION_DRAFT_STATES as readonly string[]).includes(String(row.state))) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_DRAFT_INTEGRITY", `state=${String(row.state)}`);
    }
    const rebuilt = missionDraftDigest({
      draft_id: String(row.draft_id),
      session_id: String(row.session_id),
      owner_operator_id: String(row.owner_operator_id),
      project_id: String(row.project_id),
      goal: String(row.goal),
      granted_permissions: (row.granted_permissions as unknown[]) ?? [],
      authorized_workspaces: (row.authorized_workspaces as unknown[] | null) ?? null,
      risk_ceiling: row.risk_ceiling ?? null,
    });
    if (rebuilt !== row.draft_digest) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_DRAFT_DIGEST", String(row.draft_id));
    }
  }

  private canonicalDraft(draftId: string): MissionDraftRow & { version: number } {
    const raw = this.deps.store.get(MISSION_DRAFT_ENTITY, draftId);
    this.assertCanonicalDraft(raw);
    if (String(raw.draft_id) !== String(draftId)) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_DRAFT_INTEGRITY",
        `entity ${draftId} payload ${String(raw.draft_id)}`,
      );
    }
    return raw as unknown as MissionDraftRow & { version: number };
  }

  /** Owner gate + session validity for every draft operation. */
  private sessionGate(sessionId: string, operatorId: string) {
    const session = this.deps.conversation.getSession(sessionId, operatorId);
    if (session.entry_mode !== "CONVERSATION") {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_DRAFT_SESSION",
        `session ${sessionId} entry_mode ${String(session.entry_mode)}`,
      );
    }
    if (session.state !== "OPEN") {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_DRAFT_SESSION_CLOSED",
        `session ${sessionId} is ${String(session.state)}`,
      );
    }
    return session;
  }

  /** Lazy expiry: a PENDING draft past its ttl transitions durably to
   *  EXPIRED inside the caller's transaction. Returns the live row. */
  private expireIfDue(row: MissionDraftRow & { version: number }, now: string): MissionDraftRow & { version: number } {
    if (row.state !== "PENDING_CONFIRMATION" || now <= row.expires_at) return row;
    const next = { ...row, state: "EXPIRED" as const };
    const saved = this.deps.store.put(
      MISSION_DRAFT_ENTITY, row.draft_id, next, Number(row.version ?? 0),
    );
    this.deps.store.event({
      entity_type: MISSION_DRAFT_ENTITY,
      entity_id: row.draft_id,
      event_type: "MISSION_DRAFT_EXPIRED",
      old_state: "PENDING_CONFIRMATION",
      new_state: "EXPIRED",
      actor: "conversation-mission-draft",
      metadata: { draft_id: row.draft_id, session_id: row.session_id },
    });
    return saved as unknown as MissionDraftRow & { version: number };
  }

  /* ------------------------------------------------------------------ */
  /* Draft lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  /** Mint a PENDING_CONFIRMATION draft. NEVER starts a mission — a
   *  draft is a presentation, not a capability. Untrusted fields are
   *  canonicalized at creation or the create fails closed; fields the
   *  caller cannot supply canonically (e.g. an unknown project) are
   *  rejected so the conversation can ask for clarification instead of
   *  persisting an unconfirmable proposal. */
  createDraft(input: {
    session_id: string;
    operator_id: string;
    project_id: string;
    goal: string;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
    client_request_id?: string;
    supersedes_draft_id?: string;
    correlation_id?: string;
  }): MissionDraftRow {
    const sessionId = assertDraftField("session_id", input.session_id);
    const operatorId = assertDraftField("operator_id", input.operator_id);
    this.sessionGate(sessionId, operatorId);

    const projectId = assertDraftField("project_id", input.project_id);
    const goal = assertDraftField("goal", input.goal);
    if (goal.length > MISSION_DRAFT_MAX_GOAL_CHARS) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_DRAFT_LIMIT:goal_chars",
        `${goal.length}>${MISSION_DRAFT_MAX_GOAL_CHARS}`,
      );
    }
    // A proposal may DESCRIBE authority — it cannot fabricate it. The
    // project must exist canonically; workspaces/risk canonicalize now
    // or the draft is never persistable.
    if (!this.deps.store.tryGet("project", projectId)) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_DRAFT_PROJECT",
        `project:${projectId} is not a canonical project`,
      );
    }
    const permissions = assertStrList(
      "granted_permissions", input.granted_permissions ?? [], MISSION_DRAFT_MAX_CONSTRAINT_ITEMS);
    const workspaces = input.authorized_workspaces == null
      ? null
      : assertStrList("authorized_workspaces", input.authorized_workspaces, MISSION_DRAFT_MAX_CONSTRAINT_ITEMS)
          .map((w) => canonicalWorkspacePath(w));
    const risk = input.risk_ceiling == null
      ? null
      : (isCanonicalRiskCeiling(input.risk_ceiling)
          ? input.risk_ceiling
          : (() => {
              throw new IntegrityError(
                "FAIL_CLOSED_CONVERSATION_DRAFT_FIELD",
                `risk_ceiling ${JSON.stringify(input.risk_ceiling)} is not canonical`,
              );
            })());
    const reqId = input.client_request_id == null ? null : assertDraftField("client_request_id", input.client_request_id);
    const supersedes = input.supersedes_draft_id == null ? null : assertDraftField("supersedes_draft_id", input.supersedes_draft_id);

    return this.deps.store.immediate(() => {
      const nowFn = this.deps.now ?? utcnow;
      const now = nowFn();
      const existing = this.deps.store.list(MISSION_DRAFT_ENTITY)
        .filter((d) => String(d.session_id) === sessionId);
      if (existing.length >= MISSION_DRAFT_MAX_PER_SESSION) {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_LIMIT:drafts_per_session",
          `${existing.length}>=${MISSION_DRAFT_MAX_PER_SESSION}`,
        );
      }
      const pending = existing.filter((d) => String(d.state) === "PENDING_CONFIRMATION");
      if (pending.length >= MISSION_DRAFT_MAX_PENDING_PER_SESSION) {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_LIMIT:pending_per_session",
          `${pending.length}>=${MISSION_DRAFT_MAX_PENDING_PER_SESSION}`,
        );
      }
      const draftId = reqId ? missionDraftIdFor(sessionId, reqId) : newId("MDR");
      if (reqId) {
        const raced = this.deps.store.tryGet(MISSION_DRAFT_ENTITY, draftId);
        if (raced) {
          this.assertCanonicalDraft(raced);
          const same =
            String(raced.project_id) === projectId &&
            String(raced.goal) === goal &&
            JSON.stringify(raced.granted_permissions ?? []) === JSON.stringify(permissions) &&
            JSON.stringify(raced.authorized_workspaces ?? null) === JSON.stringify(workspaces) &&
            String(raced.risk_ceiling ?? null) === String(risk ?? null) &&
            String(raced.owner_operator_id) === operatorId;
          if (same) return raced as unknown as MissionDraftRow;
          throw new IntegrityError(
            "FAIL_CLOSED_CONVERSATION_DRAFT_IDEMPOTENCY_CONFLICT",
            `client_request_id ${reqId} bound to different terms`,
          );
        }
      }
      if (supersedes) {
        const old = this.canonicalDraft(supersedes);
        if (String(old.session_id) !== sessionId || String(old.owner_operator_id) !== operatorId) {
          throw new IntegrityError(
            "FAIL_CLOSED_CONVERSATION_DRAFT_MEMBERSHIP",
            `supersedes ${supersedes} not in this session`,
          );
        }
        // Revision invalidates the presented terms — the old draft is
        // terminally REJECTED in the SAME transaction the new draft is
        // minted in, so its digest can never be confirmed anymore.
        if (old.state === "PENDING_CONFIRMATION") {
          this.deps.store.put(MISSION_DRAFT_ENTITY, supersedes,
            { ...old, state: "REJECTED" } as unknown as Record<string, unknown>,
            Number(old.version ?? 0));
          this.deps.store.event({
            entity_type: MISSION_DRAFT_ENTITY,
            entity_id: supersedes,
            event_type: "MISSION_DRAFT_REJECTED",
            old_state: "PENDING_CONFIRMATION",
            new_state: "REJECTED",
            actor: `operator:${operatorId}`,
            metadata: {
              draft_id: supersedes, session_id: sessionId,
              reason: "superseded", by_draft_id: draftId,
            },
          });
        }
      }
      const row: MissionDraftRow = {
        schema_version: MISSION_DRAFT_SCHEMA,
        draft_id: draftId,
        session_id: sessionId,
        owner_operator_id: operatorId,
        project_id: projectId,
        goal,
        granted_permissions: permissions,
        authorized_workspaces: workspaces,
        risk_ceiling: risk,
        draft_digest: missionDraftDigest({
          draft_id: draftId, session_id: sessionId, owner_operator_id: operatorId,
          project_id: projectId, goal,
          granted_permissions: permissions,
          authorized_workspaces: workspaces,
          risk_ceiling: risk,
        }),
        state: "PENDING_CONFIRMATION",
        created_at: now,
        expires_at: new Date(Date.parse(now) + this.ttlS() * 1000).toISOString(),
        client_request_id: reqId,
        supersedes_draft_id: supersedes,
        claimed_at: null,
        confirmation_kind: null,
        preview_id: null,
        plan_digest: null,
        mission_id: null,
        submitted_at: null,
        correlation_id: input.correlation_id == null ? null : String(input.correlation_id).slice(0, 128),
      };
      const saved = this.deps.store.put(
        MISSION_DRAFT_ENTITY, draftId, row as unknown as Record<string, unknown>, 0);
      this.deps.store.event({
        entity_type: MISSION_DRAFT_ENTITY,
        entity_id: draftId,
        event_type: "MISSION_DRAFT_CREATED",
        new_state: "PENDING_CONFIRMATION",
        actor: `operator:${operatorId}`,
        metadata: {
          draft_id: draftId,
          session_id: sessionId,
          project_id: projectId,
          goal_chars: goal.length,
          supersedes_draft_id: supersedes,
          expires_at: row.expires_at,
          correlation_id: row.correlation_id,
        },
      });
      return saved as unknown as MissionDraftRow;
    });
  }

  getDraft(input: { session_id: string; operator_id: string; draft_id: string }): MissionDraftRow {
    const sessionId = assertDraftField("session_id", input.session_id);
    const operatorId = assertDraftField("operator_id", input.operator_id);
    this.sessionGate(sessionId, operatorId);
    const row = this.canonicalDraft(assertDraftField("draft_id", input.draft_id));
    if (String(row.session_id) !== sessionId) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_DRAFT_MEMBERSHIP", `draft ${row.draft_id} not in session ${sessionId}`);
    }
    return this.deps.store.immediate(() => this.expireIfDue(row, (this.deps.now ?? utcnow)()));
  }

  listDrafts(input: { session_id: string; operator_id: string; state?: string }): MissionDraftRow[] {
    const sessionId = assertDraftField("session_id", input.session_id);
    const operatorId = assertDraftField("operator_id", input.operator_id);
    this.sessionGate(sessionId, operatorId);
    const rows = this.deps.store.list(MISSION_DRAFT_ENTITY)
      .filter((d) => String(d.session_id) === sessionId);
    for (const r of rows) this.assertCanonicalDraft(r);
    const now = (this.deps.now ?? utcnow)();
    // Lazily expire pending rows durably — reads must report honest state.
    return this.deps.store.immediate(() =>
      rows.map((r) =>
        this.expireIfDue(r as unknown as MissionDraftRow & { version: number }, now),
      ).filter((r) => input.state == null || String(r.state) === input.state)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) ||
                       String(a.draft_id).localeCompare(String(b.draft_id))),
    ) as unknown as MissionDraftRow[];
  }

  /** Reject the presented terms — terminal, never confirmable again.
   *  Revision = reject the old draft + create a NEW immutable draft
   *  (`supersedes_draft_id` provenance), so a presented digest can never
   *  be silently re-targeted. */
  rejectDraft(input: {
    session_id: string;
    operator_id: string;
    draft_id: string;
    correlation_id?: string;
  }): MissionDraftRow {
    const sessionId = assertDraftField("session_id", input.session_id);
    const operatorId = assertDraftField("operator_id", input.operator_id);
    this.sessionGate(sessionId, operatorId);
    const draftId = assertDraftField("draft_id", input.draft_id);
    return this.deps.store.immediate(() => {
      const row = this.canonicalDraft(draftId);
      if (String(row.session_id) !== sessionId || String(row.owner_operator_id) !== operatorId) {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_MEMBERSHIP", `draft ${draftId} not owned by ${operatorId}`);
      }
      const live = this.expireIfDue(row, (this.deps.now ?? utcnow)());
      if (live.state === "REJECTED") return live; // replay converges
      if (live.state !== "PENDING_CONFIRMATION") {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_STATE",
          `draft ${draftId} state ${live.state} cannot be rejected`,
        );
      }
      const next = { ...live, state: "REJECTED" as const };
      const saved = this.deps.store.put(
        MISSION_DRAFT_ENTITY, draftId, next, Number(live.version ?? 0));
      this.deps.store.event({
        entity_type: MISSION_DRAFT_ENTITY,
        entity_id: draftId,
        event_type: "MISSION_DRAFT_REJECTED",
        old_state: "PENDING_CONFIRMATION",
        new_state: "REJECTED",
        actor: `operator:${operatorId}`,
        metadata: { draft_id: draftId, session_id: sessionId },
      });
      return saved as unknown as MissionDraftRow;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Natural-language acknowledgement contract (§5)                      */
  /* ------------------------------------------------------------------ */

  /** Deterministic ack resolution: "OK"/"làm đi" binds a draft ONLY when
   *  exactly one live pending draft exists in this session. Zero →
   *  absent; more than one → AMBIGUOUS (the caller must ask which).
   *  Returns the exact identity the subsequent confirmDraft must target —
   *  never confirms by itself. Ordinary chat without a uniquely bound
   *  proposal stays conversation only. */
  resolveAcknowledgement(input: {
    session_id: string;
    operator_id: string;
  }): { draft_id: string; draft_digest: string } {
    const pending = this.listDrafts(input).filter((d) => d.state === "PENDING_CONFIRMATION");
    if (pending.length === 0) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_ACK_NONE",
        `no pending draft in session ${input.session_id}`,
      );
    }
    if (pending.length > 1) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_ACK_AMBIGUOUS",
        `${pending.length} pending drafts — acknowledgement cannot pick`,
      );
    }
    const d = pending[0]!;
    return { draft_id: d.draft_id, draft_digest: d.draft_digest };
  }

  /* ------------------------------------------------------------------ */
  /* Explicit confirmation → governed submission                         */
  /* ------------------------------------------------------------------ */

  async confirmDraft(input: {
    session_id: string;
    operator_id: string;
    draft_id: string;
    /** The exact digest the operator was presented — confirmation binds
     *  THIS proposal, never whatever the row may have drifted into. */
    expected_digest: string;
    /** "explicit" = API confirmation; "ack" = resolved natural-language
     *  acknowledgement routed through resolveAcknowledgement first. */
    kind?: string;
  }): Promise<{ draft: MissionDraftRow; mission_id: string; mission: Record<string, unknown>; reused: boolean }> {
    const sessionId = assertDraftField("session_id", input.session_id);
    const draftId = assertDraftField("draft_id", input.draft_id);
    const kind = input.kind ?? "explicit";
    if (!(MISSION_DRAFT_CONFIRM_KINDS as readonly string[]).includes(kind)) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_DRAFT_FIELD", `kind ${kind} invalid`);
    }
    return this.locked(`${sessionId}:${draftId}`, () =>
      this.confirmInner({ ...input, session_id: sessionId, draft_id: draftId, kind }));
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const mine = tail.then(() => gate);
    this.locks.set(key, mine);
    await tail;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === mine) this.locks.delete(key);
    }
  }

  private async confirmInner(input: {
    session_id: string;
    operator_id: string;
    draft_id: string;
    expected_digest: string;
    kind: string;
  }): Promise<{ draft: MissionDraftRow; mission_id: string; mission: Record<string, unknown>; reused: boolean }> {
    const sessionId = input.session_id;
    const operatorId = assertDraftField("operator_id", input.operator_id);
    const draftId = input.draft_id;

    /* ---- Txn A — confirmation authority + claim --------------------- */
    const gate = this.deps.store.immediate(() => {
      this.sessionGate(sessionId, operatorId);              // 1+2: owner + OPEN/CONVERSATION
      const row0 = this.canonicalDraft(draftId);
      if (String(row0.session_id) !== sessionId ||          // 3: membership
          String(row0.owner_operator_id) !== operatorId) {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_MEMBERSHIP", `draft ${draftId} not bound to ${sessionId}/${operatorId}`);
      }
      // 6: digest authority FIRST — a mismatch is a tamper signal even on
      // an already-confirmed draft.
      const expected = assertDraftField("expected_digest", input.expected_digest);
      if (String(row0.draft_digest) !== expected) {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_DIGEST_MISMATCH",
          `expected ${input.expected_digest.slice(0, 16)}`,
        );
      }
      const row = this.expireIfDue(row0, (this.deps.now ?? utcnow)()); // 5: expiry
      if (row.state === "CONFIRMED" && row.mission_id) {
        return { mode: "receipt" as const, row };
      }
      if (row.state === "SUBMITTING") {
        // 8: a prior claim exists — join its replay path instead of
        // claiming twice. The pinned preview / consumed mission decides.
        return { mode: "resume" as const, row };
      }
      if (row.state !== "PENDING_CONFIRMATION") {           // 4: confirmable
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_STATE",
          `draft ${draftId} state ${row.state} is not confirmable`,
        );
      }
      if (input.kind === "ack") {
        // R1.A — ack uniqueness is enforced AT the authority boundary,
        // not by Phase D/E callers: exactly ONE live pending draft may
        // exist for this session+owner and it must be the named draft.
        // kind:"explicit" never enters this path. Runs inside the claim
        // txn AFTER the named draft is proven PENDING — receipt/resume
        // replays above never need uniqueness.
        const now = (this.deps.now ?? utcnow)();
        const pending = this.deps.store.list(MISSION_DRAFT_ENTITY)
          .filter((d) =>
            String(d.session_id) === sessionId &&
            String(d.owner_operator_id) === operatorId)
          .map((d) => {
            this.assertCanonicalDraft(d);
            return this.expireIfDue(
              d as unknown as MissionDraftRow & { version: number }, now);
          })
          .filter((d) => String(d.state) === "PENDING_CONFIRMATION");
        if (pending.length === 0) {
          throw new IntegrityError(
            "FAIL_CLOSED_CONVERSATION_ACK_NONE",
            `no pending draft in session ${sessionId}`,
          );
        }
        if (pending.length > 1 || String(pending[0].draft_id) !== draftId) {
          throw new IntegrityError(
            "FAIL_CLOSED_CONVERSATION_ACK_AMBIGUOUS",
            `${pending.length} pending draft(s) — acknowledgement cannot pick ${draftId}`,
          );
        }
      }
      // 7: authority re-proof — project still canonical; constraints were
      // canonicalized at creation and revalidated by the digest.
      if (!this.deps.store.tryGet("project", String(row.project_id))) {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_PROJECT", `project:${String(row.project_id)} gone`);
      }
      const next = {
        ...row,
        state: "SUBMITTING" as const,
        claimed_at: (this.deps.now ?? utcnow)(),
        confirmation_kind: input.kind,
      };
      const saved = this.deps.store.put(
        MISSION_DRAFT_ENTITY, draftId, next, Number(row.version ?? 0));
      this.deps.store.event({
        entity_type: MISSION_DRAFT_ENTITY,
        entity_id: draftId,
        event_type: "MISSION_DRAFT_CLAIMED",
        old_state: "PENDING_CONFIRMATION",
        new_state: "SUBMITTING",
        actor: `operator:${operatorId}`,
        metadata: {
          draft_id: draftId, session_id: sessionId,
          draft_digest: row.draft_digest, confirmation_kind: input.kind,
        },
      });
      return { mode: "claimed" as const, row: saved as unknown as MissionDraftRow & { version: number } };
    });

    if (gate.mode === "receipt") {
      const mission = this.deps.store.get("mission", String(gate.row.mission_id));
      return { draft: gate.row, mission_id: String(gate.row.mission_id), mission, reused: true };
    }
    let row = gate.row;

    /* ---- Planning — ONLY after the claim is durable ----------------- */
    if (row.preview_id == null) {
      // Phase C — the draft plans through the SAME asynchronous LLM
      // Planner Pool expander as every other new-Mission ingress (the
      // API preview/submit edge, schedules, delegated WorkItem opens).
      // Missing dependency → typed FAIL_CLOSED_NO_PLANNER: zero provider
      // calls, zero fabricated planner_run evidence, draft stays
      // SUBMITTING so a retry can recover once planning exists. An
      // EXISTING planner that exhausts its candidates propagates the
      // durable run/attempt evidence upward — the two failure classes
      // are never conflated.
      const expander = this.deps.planExpander;
      if (!expander) {
        throw new PolicyError(
          "FAIL_CLOSED_NO_PLANNER",
          "conversation_mission_draft.confirm",
        );
      }
      const expanded = await expander({
        project_id: row.project_id,
        goal: row.goal,
        metadata: { conversation_draft: { session_id: sessionId, draft_id: draftId } },
        granted_permissions: row.granted_permissions,
        authorized_workspaces: row.authorized_workspaces ?? undefined,
        risk_ceiling: row.risk_ceiling ?? undefined,
        operator_id: operatorId,
      });
      const exInput =
        (expanded as { input?: Record<string, unknown> }).input ??
        (expanded as unknown as Record<string, unknown>);
      const plannerEvidence = (expanded as { planner?: Record<string, unknown> }).planner;
      // The persisted preview replays the DRAFT's canonical terms —
      // project/goal/constraints are the confirmed digest's authority;
      // only the expander's metadata merge (llm_plan + provenance) rides
      // along, with the draft marker pinned last.
      const preview = this.deps.control.createPlanPreview({
        project_id: row.project_id,
        goal: row.goal,
        metadata: {
          ...((exInput.metadata as Record<string, unknown> | undefined) ?? {}),
          conversation_draft: { session_id: sessionId, draft_id: draftId },
        },
        granted_permissions: row.granted_permissions,
        authorized_workspaces: row.authorized_workspaces ?? undefined,
        risk_ceiling: row.risk_ceiling ?? undefined,
        operator_id: operatorId,
      }, plannerEvidence as never);
      // Pin the preview binding — CAS: a racing pin wins, the loser
      // adopts the pinned preview instead of its own. Exactly one
      // preview is ever submitted per draft.
      const pinned = this.deps.store.immediate(() => {
        const fresh = this.canonicalDraft(draftId);
        if (fresh.state !== "SUBMITTING") {
          throw new IntegrityError(
            "FAIL_CLOSED_CONVERSATION_DRAFT_STATE",
            `draft ${draftId} left SUBMITTING (${fresh.state}) mid-claim`);
        }
        if (fresh.preview_id != null) return fresh; // loser adopts
        const next = {
          ...fresh,
          preview_id: String(preview.preview_id),
          plan_digest: String(preview.plan_digest),
        };
        return this.deps.store.put(
          MISSION_DRAFT_ENTITY, draftId, next, Number(fresh.version ?? 0),
        ) as unknown as MissionDraftRow & { version: number };
      });
      row = pinned;
    }

    /* ---- R1.B + R2 — pinned-preview recoverability ------------------- */
    // R2 — the recoverability decision is ATOMIC: draft + pinned preview
    // are re-read inside ONE transaction. A stale "READY" observation can
    // never terminalize a draft whose preview a racing process already
    // consumed — consumption is rechecked against the LIVE row.
    const gate2 = this.deps.store.immediate(() => {
      const fresh = this.canonicalDraft(draftId);
      if (fresh.state === "CONFIRMED" && fresh.mission_id) {
        // Another process already settled — converge to its receipt.
        return { mode: "settled" as const, row: fresh };
      }
      if (fresh.state !== "SUBMITTING") {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_STATE",
          `draft ${draftId} left SUBMITTING (${fresh.state}) mid-claim`,
        );
      }
      const pv = this.deps.store.tryGet(
        "mission_plan_preview", String(fresh.preview_id)) as Record<string, unknown> | null;
      if (!pv) {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_INTEGRITY",
          `pinned preview ${String(fresh.preview_id)} missing`,
        );
      }
      if (String(pv.state) === "CONSUMED") {
        // A consumed preview still replays its mission receipt — expiry
        // is irrelevant once consumption is canonical.
        return { mode: "confirm" as const, row: fresh };
      }
      if ((this.deps.now ?? utcnow)() > String(pv.expires_at ?? "")) {
        // Expired + unconsumed: can never legally confirm — commit the
        // terminal outcome atomically, THEN throw.
        const next = { ...fresh, state: "SUBMISSION_EXPIRED" as const };
        this.deps.store.put(MISSION_DRAFT_ENTITY, draftId,
          next as unknown as Record<string, unknown>, Number(fresh.version ?? 0));
        this.deps.store.event({
          entity_type: MISSION_DRAFT_ENTITY,
          entity_id: draftId,
          event_type: "MISSION_DRAFT_SUBMISSION_EXPIRED",
          old_state: "SUBMITTING",
          new_state: "SUBMISSION_EXPIRED",
          actor: "conversation-mission-draft",
          metadata: {
            draft_id: draftId, session_id: sessionId,
            preview_id: String(fresh.preview_id),
            preview_expires_at: String(pv.expires_at),
          },
        });
        return { mode: "expired" as const, row: fresh };
      }
      return { mode: "confirm" as const, row: fresh };
    });
    if (gate2.mode === "settled") {
      const mission = this.deps.store.get("mission", String(gate2.row.mission_id));
      return { draft: gate2.row, mission_id: String(gate2.row.mission_id), mission, reused: true };
    }
    if (gate2.mode === "expired") {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_DRAFT_SUBMISSION_EXPIRED",
        `draft ${draftId} pinned preview ${String(row.preview_id)} expired — confirm a new draft`,
      );
    }
    row = gate2.row;

    /* ---- Governed submission — canonical confirm, atomic consume ---- */
    // confirmPlanPreview: digest/expiry/authority re-proof → mission mint
    // + preview consume in ONE store.immediate; supervisor wake happens
    // only after the durable commit (its own contract). A consumed
    // preview replays ALREADY_CONSUMED → the existing mission.
    const mission = this.deps.control.confirmPlanPreview({
      preview_id: String(row.preview_id),
      plan_digest: String(row.plan_digest),
      operator_id: operatorId,
    });

    /* ---- Txn B — settle the receipt --------------------------------- */
    const settled = this.deps.store.immediate(() => {
      const fresh = this.canonicalDraft(draftId);
      if (fresh.state === "CONFIRMED" && fresh.mission_id) {
        // A racing settle already wrote the receipt — converge, the
        // pinned mission is the same one (preview consume CAS).
        return fresh;
      }
      if (fresh.state !== "SUBMITTING") {
        throw new IntegrityError(
          "FAIL_CLOSED_CONVERSATION_DRAFT_STATE",
          `draft ${draftId} state ${fresh.state} cannot settle`,
        );
      }
      const next = {
        ...fresh,
        state: "CONFIRMED" as const,
        mission_id: String(mission.mission_id),
        submitted_at: (this.deps.now ?? utcnow)(),
      };
      const saved = this.deps.store.put(
        MISSION_DRAFT_ENTITY, draftId, next, Number(fresh.version ?? 0));
      this.deps.store.event({
        entity_type: MISSION_DRAFT_ENTITY,
        entity_id: draftId,
        event_type: "MISSION_DRAFT_CONFIRMED",
        old_state: "SUBMITTING",
        new_state: "CONFIRMED",
        actor: `operator:${operatorId}`,
        metadata: {
          draft_id: draftId, session_id: sessionId,
          preview_id: row.preview_id, plan_digest: row.plan_digest,
          mission_id: String(mission.mission_id),
        },
      });
      return saved as unknown as MissionDraftRow & { version: number };
    });
    return { draft: settled, mission_id: String(mission.mission_id), mission, reused: false };
  }

  private ttlS(): number {
    return this.deps.draft_ttl_s ?? MISSION_DRAFT_DEFAULT_TTL_S;
  }
}

/* ------------------------------------------------------------------ *
 *  P15.8-F — proposal project resolution (deterministic)               *
 * ------------------------------------------------------------------ */

/** Resolve which canonical project a conversational proposal may bind
 *  to. The rule is fixed and server-side — the model NEVER names a
 *  project: exactly one canonical project → it is used; more than one →
 *  ambiguous and the operator must choose before a confirmable draft
 *  may be minted; zero → no draft possible. */
export type ProposalProjectResolution =
  | { kind: "resolved"; project_id: string }
  | { kind: "ambiguous"; candidates: Array<{ project_id: string; name: string }> }
  | { kind: "none"; candidates: [] };

export function resolveProposalProject(store: PairEvidenceStore): ProposalProjectResolution {
  const projects = store.list("project")
    .map((p) => ({
      project_id: String(p.project_id ?? ""),
      name: String(p.name ?? p.project_id ?? ""),
    }))
    .filter((p) => p.project_id !== "");
  if (projects.length === 0) return { kind: "none", candidates: [] };
  if (projects.length === 1) return { kind: "resolved", project_id: projects[0]!.project_id };
  return { kind: "ambiguous", candidates: projects };
}
