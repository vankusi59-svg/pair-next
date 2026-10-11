/**
 * P15.8-A Conversation Authority — canonical conversation session + message
 * store.
 *
 * Establishes persistence and authority boundaries for the future
 * Conversation Layer ONLY. This module owns durable chat state; it carries
 * zero mission authority by construction:
 *
 * - The service takes a `PairEvidenceStore` and nothing else — it cannot
 *   reach MissionControl, the planner, routers, executors, Telegram or any
 *   governed path. A message is a durable record, never an instruction.
 * - No content analysis of any kind: message bodies are opaque user data.
 *   Keywords ("run", "yes", "làm đi", "execute now") have no meaning here.
 * - Entry mode is pinned by the authorized entry surface at session create
 *   (always `CONVERSATION`); `TASK_ENTRY` names the pre-existing mission
 *   submission path which this module does not touch. A session can never
 *   change its mode — no API mutates `entry_mode`.
 * - Owner binding is fail-closed: every read/append/close requires the
 *   operator id equal to `owner_operator_id`. Foreign operators get
 *   `FAIL_CLOSED_CONVERSATION_FORBIDDEN`; cross-operator listing is
 *   impossible by construction.
 * - Ordering is deterministic: `seq` is minted inside `store.immediate()`
 *   from the session's own `next_seq` under CAS, so message order is the
 *   committed sequence order — never timestamp order.
 * - Idempotency is caller-supplied: `idempotency_key` → deterministic
 *   message id; replay returns the stored row; same key + different
 *   payload fails closed (`..._IDEMPOTENCY_CONFLICT`), matching the
 *   applied_evidence_keys convention.
 * - Bounded: body/title/limits are hard constants; reads are paginated by
 *   `after_seq` + `limit` clamped to MAX_PAGE_SIZE.
 * - Audit events carry ids + seq + body length only — never message text.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";

export const CONVERSATION_SESSION_SCHEMA = "pair.os.vnext.conversation-session.v1";
export const CONVERSATION_MESSAGE_SCHEMA = "pair.os.vnext.conversation-message.v1";
export const CONVERSATION_SESSION_ENTITY = "conversation_session";
export const CONVERSATION_MESSAGE_ENTITY = "conversation_message";

/** Trusted entry-mode vocabulary. The mode is selected by the entry
 *  surface that created the session — never inferred from content. */
export const ENTRY_MODES = ["CONVERSATION", "TASK_ENTRY"] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

export const CONVERSATION_SESSION_STATES = ["OPEN", "CLOSED"] as const;
export type ConversationSessionState = (typeof CONVERSATION_SESSION_STATES)[number];
export const TERMINAL_CONVERSATION_SESSION_STATES: ReadonlySet<string> = new Set(["CLOSED"]);

/** Message author kinds — operator text vs (future) assistant replies vs
 *  system records. No role carries execution authority. */
export const CONVERSATION_MESSAGE_ROLES = ["operator", "assistant", "system"] as const;
export type ConversationMessageRole = (typeof CONVERSATION_MESSAGE_ROLES)[number];

export const CONVERSATION_MAX_BODY_CHARS = 16_000;
export const CONVERSATION_MAX_TITLE_CHARS = 200;
export const CONVERSATION_MAX_IDEMPOTENCY_KEY_CHARS = 200;
export const CONVERSATION_MAX_MESSAGES_PER_SESSION = 10_000;
export const CONVERSATION_MAX_CORRELATION_ID_CHARS = 128;
export const CONVERSATION_MAX_SESSIONS_PER_OWNER = 1_000;
export const CONVERSATION_MAX_PAGE_SIZE = 200;

export type ConversationSessionRow = {
  schema_version: string;
  session_id: string;
  owner_operator_id: string;
  entry_mode: EntryMode;
  state: ConversationSessionState;
  title: string | null;
  message_count: number;
  next_seq: number;
  closed_at: string | null;
  session_digest: string;
  created_at: string;
  updated_at: string;
};

export type ConversationMessageRow = {
  schema_version: string;
  message_id: string;
  session_id: string;
  owner_operator_id: string;
  seq: number;
  role: ConversationMessageRole;
  body: string;
  idempotency_key: string | null;
  message_digest: string;
  created_at: string;
  /** P15.8-F R2 — durable, NON-authority proposal outcome attached to
   *  the assistant reply. Descriptive model output only (untrusted), but
   *  now bound into message_digest: the canonical committed row is the
   *  ONLY proposal a caller may materialize, and a raced divergent
   *  proposal conflicts instead of silently converging. No execution
   *  authority — proposal → draft → explicit confirmation → mission.
   *  Only the internal writer may set it. */
  proposal?: { goal: string } | null;
};

function assertStr(field: string, value: unknown, { empty = false } = {}): string {
  if (typeof value !== "string" || (!empty && !value.trim())) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_FIELD", `${field} invalid`);
  }
  return value;
}

/** R3.B — audit correlation ids must be bounded opaque identifiers,
 *  never arbitrary caller text: a `bcap1.*` capability token, a secret
 *  payload or freeform prose cannot ride into the durable event log.
 *  Charset allows alnum + `_ . : -` (real correlation-id shapes); the
 *  `bcap1.` capability prefix is denied outright. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function assertCorrelationId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = assertStr("correlation_id", value, { empty: true });
  if (v.length > CONVERSATION_MAX_CORRELATION_ID_CHARS) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_LIMIT", "correlation_id");
  }
  if (!CORRELATION_ID_PATTERN.test(v) || v.startsWith("bcap1.")) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_FIELD", "correlation_id");
  }
  return v;
}

function assertOptStr(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return assertStr(field, value);
}

/** Immutable session terms digest — identity + owner + entry mode. Mutable
 *  counters (next_seq, message_count, state, closed_at) stay outside; they
 *  are the fields the CAS transaction legitimately advances. */
export function conversationSessionDigest(row: {
  session_id: string;
  owner_operator_id: string;
  entry_mode: string;
}): string {
  return digest({
    contract: "pair-conversation-session.v1",
    session_id: row.session_id,
    owner_operator_id: row.owner_operator_id,
    entry_mode: row.entry_mode,
  });
}

/** Message provenance — binds session membership, position, author and
 *  content. Self-verified on every read like objective rows.
 *  F-R2 — a present proposal participates in the digest: two commits of
 *  the same deterministic reply identity carrying different proposals
 *  can never silently converge. Rows WITHOUT proposal digest exactly as
 *  before (the key is absent, not null) — pre-existing P15.8-A/B rows
 *  keep their digests. Proposal stays NON-authority: binding it into
 *  integrity is not execution authority. */
export function conversationMessageDigest(row: {
  message_id: string;
  session_id: string;
  owner_operator_id: string;
  seq: number;
  role: string;
  body: string;
  idempotency_key: string | null;
  proposal?: { goal: string } | null;
}): string {
  return digest({
    contract: "pair-conversation-message.v1",
    message_id: row.message_id,
    session_id: row.session_id,
    owner_operator_id: row.owner_operator_id,
    seq: row.seq,
    role: row.role,
    body: row.body,
    idempotency_key: row.idempotency_key,
    ...(row.proposal ? { proposal_goal: row.proposal.goal } : {}),
  });
}

/** Canonical proposal normalizer — the ONLY shape a persisted proposal
 *  may take. `undefined`/`null` → absent; anything else must be an
 *  object holding exactly one non-empty bounded `goal` string, and a
 *  proposal may exist only on an assistant row. Fails closed. */
export function canonicalProposal(
  role: string,
  value: unknown,
): { goal: string } | null {
  if (value === undefined || value === null) return null;
  if (role !== "assistant") {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "proposal_role");
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "proposal_shape");
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "goal") {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "proposal_keys");
  }
  const goal = (value as Record<string, unknown>).goal;
  if (typeof goal !== "string" || !goal.trim()) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "proposal_goal");
  }
  if (goal.length > CONVERSATION_MAX_BODY_CHARS) {
    throw new IntegrityError("FAIL_CLOSED_CONVERSATION_LIMIT", "proposal_goal_chars");
  }
  return { goal };
}

/** Deterministic message identity when the caller supplies an idempotency
 *  key: same session + same key → same id, so retries converge onto the
 *  stored row instead of duplicating. */
export function conversationMessageIdFor(sessionId: string, idempotencyKey: string): string {
  return `MSG_${digest(`conversation-msg-id:${sessionId}:${idempotencyKey}`).slice(0, 26)}`;
}

/** Deterministic session identity when the entry surface supplies a
 *  client request id: retry of the same create converges onto one row. */
export function conversationSessionIdFor(ownerOperatorId: string, clientRequestId: string): string {
  return `CSESS_${digest(`conversation-session-id:${ownerOperatorId}:${clientRequestId}`).slice(0, 26)}`;
}

export class ConversationSessionService {
  constructor(private readonly store: PairEvidenceStore) {}

  /* ------------------------------------------------------------------ *
   *  reads                                                               *
   * ------------------------------------------------------------------ */

  /** Canonical read: schema + immutable-terms digest + enum/shape
   *  validation — anything else fails closed. Returns the row with its
   *  store CAS version for callers that mutate inside a transaction. */
  private canonicalSession(sessionId: string): ConversationSessionRow & { version: number } {
    const raw = this.store.get(CONVERSATION_SESSION_ENTITY, sessionId);
    this.assertCanonicalSession(raw);
    return raw as unknown as ConversationSessionRow & { version: number };
  }

  private canonicalMessage(messageId: string): ConversationMessageRow {
    const raw = this.store.get(CONVERSATION_MESSAGE_ENTITY, messageId);
    this.assertCanonicalMessage(raw);
    return raw as unknown as ConversationMessageRow;
  }

  /** R1.B — canonical message read authority for trusted internal
   *  consumers (P15.8-B reused-reply validation): proves schema,
   *  immutable-terms digest and canonical identity of a raw persisted
   *  row. Throws IntegrityError on ANY deviation — never returns
   *  malformed or forged data as authoritative. */
  public assertMessageCanonical(row: Record<string, unknown>): void {
    this.assertCanonicalMessage(row);
  }

  private assertCanonicalSession(row: Record<string, unknown>): void {
    if (String(row.schema_version) !== CONVERSATION_SESSION_SCHEMA) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_SCHEMA",
        `${String(row.session_id ?? row.entity_id)}:${String(row.schema_version ?? "absent")}`,
      );
    }
    for (const f of ["session_id", "owner_operator_id", "session_digest", "created_at", "updated_at"]) {
      assertStr(f, row[f]);
    }
    if (!(ENTRY_MODES as readonly string[]).includes(String(row.entry_mode))) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "entry_mode");
    }
    if (!(CONVERSATION_SESSION_STATES as readonly string[]).includes(String(row.state))) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", `state=${String(row.state)}`);
    }
    if (!Number.isInteger(row.message_count) || Number(row.message_count) < 0 ||
        !Number.isInteger(row.next_seq) || Number(row.next_seq) < Number(row.message_count) + 1) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "message_count/next_seq");
    }
    if (row.title !== null && row.title !== undefined && typeof row.title !== "string") {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "title");
    }
    if (row.closed_at !== null && row.closed_at !== undefined && typeof row.closed_at !== "string") {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "closed_at");
    }
    const rebuilt = conversationSessionDigest({
      session_id: String(row.session_id),
      owner_operator_id: String(row.owner_operator_id),
      entry_mode: String(row.entry_mode),
    });
    if (rebuilt !== row.session_digest) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_DIGEST", String(row.session_id));
    }
  }

  private assertCanonicalMessage(row: Record<string, unknown>): void {
    if (String(row.schema_version) !== CONVERSATION_MESSAGE_SCHEMA) {
      throw new IntegrityError(
        "FAIL_CLOSED_CONVERSATION_SCHEMA",
        `${String(row.message_id ?? row.entity_id)}:${String(row.schema_version ?? "absent")}`,
      );
    }
    for (const f of ["message_id", "session_id", "owner_operator_id", "body", "message_digest", "created_at"]) {
      assertStr(f, row[f]);
    }
    if (!Number.isInteger(row.seq) || Number(row.seq) < 1) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "seq");
    }
    if (!(CONVERSATION_MESSAGE_ROLES as readonly string[]).includes(String(row.role))) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", `role=${String(row.role)}`);
    }
    if (row.idempotency_key !== null && row.idempotency_key !== undefined &&
        typeof row.idempotency_key !== "string") {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "idempotency_key");
    }
    // R3.A — canonical message identity: a keyed message's persisted id
    // must equal the deterministic id derived from ITS pinned session and
    // key. A planted row carrying a foreign session_id but an id minted
    // for another session fails here — cross-session inconsistency is an
    // integrity violation on every canonical read.
    if (typeof row.idempotency_key === "string" &&
        String(row.message_id) !== conversationMessageIdFor(String(row.session_id), row.idempotency_key)) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "message_id");
    }
    // F-R2 — proposal is part of the integrity contract: assistant-only,
    // exact single-`goal` shape, bounded; malformed/tampered fails closed
    // BEFORE the digest check so the failure is typed, not a bare digest
    // mismatch.
    const proposal = canonicalProposal(String(row.role), row.proposal);
    const rebuilt = conversationMessageDigest({
      message_id: String(row.message_id),
      session_id: String(row.session_id),
      owner_operator_id: String(row.owner_operator_id),
      seq: Number(row.seq),
      role: String(row.role),
      body: String(row.body),
      idempotency_key: row.idempotency_key === undefined ? null : (row.idempotency_key as string | null),
      proposal,
    });
    if (rebuilt !== row.message_digest) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_DIGEST", String(row.message_id));
    }
  }

  /** Owner gate — every operation funnels through here. A session that
   *  does not exist surfaces NotFoundError (foreign operators cannot
   *  distinguish "absent" from "not mine" any further than the existence
   *  bit; the row itself is never returned). */
  private ownedSession(
    sessionId: string,
    operatorId: string,
  ): ConversationSessionRow & { version: number } {
    const session = this.canonicalSession(sessionId);
    if (session.owner_operator_id !== operatorId) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_FORBIDDEN", sessionId);
    }
    return session;
  }

  /* ------------------------------------------------------------------ *
   *  session lifecycle                                                   *
   * ------------------------------------------------------------------ */

  createSession(input: {
    owner_operator_id: string;
    title?: string | null;
    /** Entry-surface request id for create-retry convergence. */
    client_request_id?: string | null;
    correlation_id?: string | null;
  }): ConversationSessionRow {
    const owner = assertStr("owner_operator_id", input.owner_operator_id);
    const title = input.title === undefined ? null : assertOptStr("title", input.title);
    if (title !== null && title.length > CONVERSATION_MAX_TITLE_CHARS) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_LIMIT", "title");
    }
    const clientRequestId = input.client_request_id === undefined
      ? null : assertOptStr("client_request_id", input.client_request_id);
    if (clientRequestId !== null && clientRequestId.length > CONVERSATION_MAX_IDEMPOTENCY_KEY_CHARS) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_LIMIT", "client_request_id");
    }
    const corrId = assertCorrelationId(input.correlation_id);
    const sessionId = clientRequestId
      ? conversationSessionIdFor(owner, clientRequestId)
      : newId("CSESS");
    // Equivalence for a deterministic-id replay: same owner + same title
    // (the only caller-variable terms) + fixed entry_mode/state.
    const createEquivalent = (row: Record<string, unknown>): boolean =>
      String(row.owner_operator_id) === owner && (row.title ?? null) === title;
    const existing = this.store.tryGet(CONVERSATION_SESSION_ENTITY, sessionId);
    if (existing) {
      this.assertCanonicalSession(existing);
      if (existing.owner_operator_id !== owner) {
        throw new IntegrityError("FAIL_CLOSED_CONVERSATION_FORBIDDEN", sessionId);
      }
      if (!createEquivalent(existing)) {
        throw new IntegrityError("FAIL_CLOSED_CONVERSATION_IDEMPOTENCY_CONFLICT", sessionId);
      }
      return existing as unknown as ConversationSessionRow;
    }
    // Per-owner session cap — counted inside the transaction so a racing
    // create cannot exceed it.
    return this.store.immediate(() => {
      // Identical concurrent create under the same client_request_id
      // converges onto the raced row — it is a retry, not a conflict.
      // Different terms under one request id fail closed instead of
      // silently reusing the row.
      const raced = this.store.tryGet(CONVERSATION_SESSION_ENTITY, sessionId);
      if (raced) {
        this.assertCanonicalSession(raced);
        if (String(raced.owner_operator_id) !== owner) {
          throw new IntegrityError("FAIL_CLOSED_CONVERSATION_FORBIDDEN", sessionId);
        }
        if (!createEquivalent(raced)) {
          throw new IntegrityError("FAIL_CLOSED_CONVERSATION_IDEMPOTENCY_CONFLICT", sessionId);
        }
        return raced as unknown as ConversationSessionRow;
      }
      const ownerSessions = this.store
        .list(CONVERSATION_SESSION_ENTITY)
        .filter((r) => String(r.owner_operator_id) === owner);
      if (ownerSessions.length >= CONVERSATION_MAX_SESSIONS_PER_OWNER) {
        throw new IntegrityError("FAIL_CLOSED_CONVERSATION_LIMIT", "sessions_per_owner");
      }
      const now = utcnow();
      const row = {
        schema_version: CONVERSATION_SESSION_SCHEMA,
        session_id: sessionId,
        owner_operator_id: owner,
        entry_mode: "CONVERSATION" as const,
        state: "OPEN" as const,
        title,
        message_count: 0,
        next_seq: 1,
        closed_at: null,
        session_digest: conversationSessionDigest({
          session_id: sessionId,
          owner_operator_id: owner,
          entry_mode: "CONVERSATION",
        }),
        created_at: now,
        updated_at: now,
      };
      const written = this.store.put(CONVERSATION_SESSION_ENTITY, sessionId, row);
      this.store.event({
        entity_type: CONVERSATION_SESSION_ENTITY,
        entity_id: sessionId,
        event_type: "CONVERSATION_SESSION_CREATED",
        old_state: null,
        new_state: "OPEN",
        actor: owner,
        correlation_id: corrId,
        metadata: { owner_operator_id: owner, entry_mode: "CONVERSATION" },
      });
      return written as unknown as ConversationSessionRow;
    });
  }

  /** Owner-scoped read. Foreign operator → forbidden (existence still
   *  disclosed — ids are unguessable ULIDs/digests anyway). */
  getSession(sessionId: string, operatorId: string): ConversationSessionRow {
    const op = assertStr("operator_id", operatorId);
    return this.ownedSession(assertStr("session_id", sessionId), op);
  }

  /** Owner-scoped listing — only the caller's own sessions, newest last
   *  by created_at. Tolerant read for display; authority reads always go
   *  through canonicalSession. */
  listSessions(input: {
    operator_id: string;
    state?: ConversationSessionState | null;
    limit?: number;
  }): ConversationSessionRow[] {
    const op = assertStr("operator_id", input.operator_id);
    const state = input.state ?? null;
    if (state !== null && !(CONVERSATION_SESSION_STATES as readonly string[]).includes(state)) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_FIELD", "state");
    }
    const limit = Math.min(
      Math.max(Math.trunc(Number(input.limit ?? CONVERSATION_MAX_PAGE_SIZE)), 1),
      CONVERSATION_MAX_PAGE_SIZE,
    );
    return this.store
      .list(CONVERSATION_SESSION_ENTITY)
      .filter((r) => String(r.owner_operator_id) === op)
      .filter((r) => state === null || String(r.state) === state)
      .map((r) => {
        this.assertCanonicalSession(r);
        return r as unknown as ConversationSessionRow;
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-limit)
      .reverse();
  }

  closeSession(sessionId: string, input: {
    operator_id: string;
    correlation_id?: string | null;
  }): ConversationSessionRow {
    const op = assertStr("operator_id", input.operator_id);
    const id = assertStr("session_id", sessionId);
    const corrId = assertCorrelationId(input.correlation_id);
    return this.store.immediate(() => {
      const session = this.ownedSession(id, op);
      if (session.state === "CLOSED") return session; // idempotent close
      const next = {
        ...session,
        state: "CLOSED" as const,
        closed_at: utcnow(),
        updated_at: utcnow(),
      };
      const written = this.store.put(
        CONVERSATION_SESSION_ENTITY, id, next, Number(session.version));
      this.store.event({
        entity_type: CONVERSATION_SESSION_ENTITY,
        entity_id: id,
        event_type: "CONVERSATION_SESSION_CLOSED",
        old_state: "OPEN",
        new_state: "CLOSED",
        actor: op,
        correlation_id: corrId,
        metadata: { message_count: session.message_count },
      });
      return written as unknown as ConversationSessionRow;
    });
  }

  /* ------------------------------------------------------------------ *
   *  messages                                                            *
   * ------------------------------------------------------------------ */

  /** Operator message seam — the ONLY message write the future
   *  operator-facing surfaces may call. `role` is pinned to "operator":
   *  an ordinary operator can never mint assistant/system rows by
   *  supplying a role field. Non-operator roles are reserved for
   *  `internalWriter()` — a capability object only server-side code holds. */
  appendMessage(input: {
    session_id: string;
    operator_id: string;
    /** Must be "operator" when present; absent defaults to it. */
    role?: "operator";
    body: string;
    idempotency_key?: string | null;
    correlation_id?: string | null;
  }): ConversationMessageRow {
    const op = assertStr("operator_id", input.operator_id);
    if (input.role !== undefined && input.role !== "operator") {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_ROLE", String(input.role));
    }
    // F-R2 — the operator seam never carries a proposal: an injected
    // field fails closed rather than being silently dropped.
    if ("proposal" in input) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", "proposal_role");
    }
    return this.appendCore({
      session_id: input.session_id,
      caller_operator_id: op,
      actor: op,
      role: "operator",
      body: input.body,
      idempotency_key: input.idempotency_key,
      correlation_id: input.correlation_id,
    });
  }

  /** Trusted internal writer — assistant/system records minted only by
   *  server-side integration code (e.g. the P15.8-B response pipeline).
   *  The capability object is obtainable only through this method, which
   *  is the auditable boundary: entry surfaces expose `appendMessage` to
   *  operators and never hand out the internal writer. The writer binds
   *  each message's owner to the parent session's owner and records actor
   *  `conversation-internal` — it cannot impersonate an operator. */
  internalWriter(): {
    appendMessage(input: {
      session_id: string;
      role: "assistant" | "system";
      body: string;
      idempotency_key?: string | null;
      correlation_id?: string | null;
      /** P15.8-F R1 — descriptive proposal outcome, atomically bound to
       *  the reply row. Assistant role only; never authority. */
      proposal?: { goal: string } | null;
    }): ConversationMessageRow;
  } {
    const svc = this;
    return {
      appendMessage(input: {
        session_id: string;
        role: "assistant" | "system";
        body: string;
        idempotency_key?: string | null;
        correlation_id?: string | null;
        proposal?: { goal: string } | null;
      }): ConversationMessageRow {
        if (input.role !== "assistant" && input.role !== "system") {
          throw new IntegrityError("FAIL_CLOSED_CONVERSATION_ROLE", String(input.role));
        }
        return svc.appendCore({
          session_id: input.session_id,
          caller_operator_id: null,
          actor: "conversation-internal",
          role: input.role,
          body: input.body,
          idempotency_key: input.idempotency_key,
          correlation_id: input.correlation_id,
          proposal: input.proposal,
        });
      },
    };
  }

  /** Idempotent replay equivalence — identical deterministic id + same
   *  session/owner/role/body/key digest → the stored row; any drift →
   *  conflict. Shared by the pre-transaction and in-transaction checks so
   *  a raced commit is judged by exactly the same rule as a plain retry. */
  private replayOrConflict(
    row: Record<string, unknown>,
    input: {
      sessionId: string;
      ownerOperatorId: string;
      role: ConversationMessageRole;
      body: string;
      idemKey: string | null;
      proposal: { goal: string } | null;
      messageId: string;
    },
  ): ConversationMessageRow {
    this.assertCanonicalMessage(row);
    // Entity-key/payload binding (R3.A): the row was fetched by entity
    // key `input.messageId` — its payload must claim that same id.
    if (String(row.message_id) !== input.messageId) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", input.messageId);
    }
    // Membership/owner consistency (R2.B): the stored row must name THIS
    // session and THIS owner. A planted row whose own message_digest and
    // store hash are internally consistent — but whose session_id or
    // owner_operator_id disagree with the canonical session — is an
    // integrity violation, not an idempotency conflict.
    if (String(row.session_id) !== input.sessionId ||
        String(row.owner_operator_id) !== input.ownerOperatorId) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", input.messageId);
    }
    const expected = conversationMessageDigest({
      message_id: String(row.message_id),
      session_id: input.sessionId,
      owner_operator_id: input.ownerOperatorId,
      seq: Number(row.seq),
      role: input.role,
      body: input.body,
      idempotency_key: input.idemKey,
      proposal: input.proposal,
    });
    // F-R2 — same reply identity + divergent proposal → different digest
    // → typed conflict; a raced writer's local proposal can never be
    // silently adopted in place of the committed canonical one.
    if (expected !== row.message_digest) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_IDEMPOTENCY_CONFLICT", input.messageId);
    }
    return row as unknown as ConversationMessageRow;
  }

  private appendCore(input: {
    session_id: string;
    /** Non-null → the operator owner gate applies. Null → internal
     *  writer; the session's pinned owner supplies message ownership. */
    caller_operator_id: string | null;
    actor: string;
    role: ConversationMessageRole;
    body: string;
    idempotency_key?: string | null;
    correlation_id?: string | null;
    proposal?: { goal: string } | null;
  }): ConversationMessageRow {
    const sessionId = assertStr("session_id", input.session_id);
    const body = assertStr("body", input.body);
    // Descriptive proposal outcome — canonical shape, assistant-only,
    // untrusted, non-authority. It rides the message digest (F-R2) so a
    // raced commit carrying a different proposal conflicts loudly.
    const proposal = canonicalProposal(input.role, input.proposal);
    if (body.length > CONVERSATION_MAX_BODY_CHARS) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_LIMIT", "body_chars");
    }
    const idemKey = input.idempotency_key === undefined
      ? null : assertOptStr("idempotency_key", input.idempotency_key);
    if (idemKey !== null && idemKey.length > CONVERSATION_MAX_IDEMPOTENCY_KEY_CHARS) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_LIMIT", "idempotency_key");
    }
    const corrId = assertCorrelationId(input.correlation_id);
    const role = input.role;
    const messageId = idemKey ? conversationMessageIdFor(sessionId, idemKey) : newId("MSG");
    // Session resolution differs by seam: the operator path enforces
    // owner equality (foreign operator → FORBIDDEN before any oracle);
    // the internal path resolves canonically — its authority is the
    // writer capability itself, and ownership comes from the session row.
    const resolveSession = () =>
      input.caller_operator_id === null
        ? this.canonicalSession(sessionId)
        : this.ownedSession(sessionId, input.caller_operator_id);
    const preSession = resolveSession();
    const ownerOperatorId = preSession.owner_operator_id;

    // Idempotent replay BEFORE mutating: same deterministic id + same
    // provenance digest → return the stored row untouched.
    const prior = this.store.tryGet(CONVERSATION_MESSAGE_ENTITY, messageId);
    if (prior) {
      return this.replayOrConflict(prior, {
        sessionId, ownerOperatorId, role, body, idemKey, proposal, messageId,
      });
    }

    return this.store.immediate(() => {
      const session = resolveSession();
      // Replay check runs BEFORE new-write admission (R2.A): an identical
      // committed message converges even when the session closed or hit
      // its cap after the pre-check — it is a retry of committed state,
      // not a new write. A different-payload collision still conflicts.
      const raced = this.store.tryGet(CONVERSATION_MESSAGE_ENTITY, messageId);
      if (raced) {
        return this.replayOrConflict(raced, {
          sessionId, ownerOperatorId, role, body, idemKey, proposal, messageId,
        }) as ConversationMessageRow & { version: number };
      }
      if (session.state !== "OPEN") {
        throw new IntegrityError("FAIL_CLOSED_CONVERSATION_CLOSED", sessionId);
      }
      if (session.message_count >= CONVERSATION_MAX_MESSAGES_PER_SESSION) {
        throw new IntegrityError("FAIL_CLOSED_CONVERSATION_LIMIT", "messages_per_session");
      }
      const seq = Number(session.next_seq);
      const now = utcnow();
      const sessionVersion = Number(session.version);
      const msg = {
        schema_version: CONVERSATION_MESSAGE_SCHEMA,
        message_id: messageId,
        session_id: sessionId,
        owner_operator_id: ownerOperatorId,
        seq,
        role,
        body,
        idempotency_key: idemKey,
        message_digest: conversationMessageDigest({
          message_id: messageId,
          session_id: sessionId,
          owner_operator_id: ownerOperatorId,
          seq,
          role,
          body,
          idempotency_key: idemKey,
          proposal,
        }),
        created_at: now,
        ...(proposal !== null ? { proposal } : {}),
      };
      const written = this.store.put(CONVERSATION_MESSAGE_ENTITY, messageId, msg);
      this.store.put(
        CONVERSATION_SESSION_ENTITY,
        sessionId,
        {
          ...session,
          message_count: Number(session.message_count) + 1,
          next_seq: seq + 1,
          updated_at: now,
        },
        sessionVersion,
      );
      this.store.event({
        entity_type: CONVERSATION_SESSION_ENTITY,
        entity_id: sessionId,
        event_type: "CONVERSATION_MESSAGE_APPENDED",
        old_state: null,
        new_state: null,
        actor: input.actor,
        correlation_id: corrId,
        metadata: { message_id: messageId, seq, role, body_chars: body.length },
      });
      return written as unknown as ConversationMessageRow;
    });
  }

  /** Bounded owner-scoped page of a session's message history, in
   *  canonical seq order. `after_seq` is an exclusive cursor. */
  listMessages(sessionId: string, input: {
    operator_id: string;
    after_seq?: number | null;
    limit?: number | null;
  }): { messages: ConversationMessageRow[]; next_after_seq: number | null } {
    const op = assertStr("operator_id", input.operator_id);
    const id = assertStr("session_id", sessionId);
    const session = this.ownedSession(id, op);
    if (input.after_seq !== null && input.after_seq !== undefined &&
        !Number.isFinite(Number(input.after_seq))) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_FIELD", "after_seq");
    }
    if (input.limit !== null && input.limit !== undefined &&
        !Number.isFinite(Number(input.limit))) {
      throw new IntegrityError("FAIL_CLOSED_CONVERSATION_FIELD", "limit");
    }
    const afterSeq = input.after_seq === null || input.after_seq === undefined
      ? 0
      : Math.max(0, Math.trunc(Number(input.after_seq)));
    const limit = Math.min(
      Math.max(Math.trunc(Number(input.limit ?? CONVERSATION_MAX_PAGE_SIZE)), 1),
      CONVERSATION_MAX_PAGE_SIZE,
    );
    const rows = this.store
      .list(CONVERSATION_MESSAGE_ENTITY)
      .filter((r) => String(r.session_id) === id)
      .map((r) => {
        this.assertCanonicalMessage(r);
        // Membership/owner consistency (R2.B): a persisted row may pass
        // its own message_digest and store-hash check yet still name a
        // different owner than the canonical session — planted foreign
        // rows are an integrity violation, never silently returned.
        if (String(r.owner_operator_id) !== String(session.owner_operator_id)) {
          throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", String(r.message_id));
        }
        // Entity-key/payload binding (R3.A): the message payload's id
        // must itself be a live entity key holding the SAME payload — a
        // row planted under a foreign entity key cannot borrow a
        // canonical identity.
        const byId = this.store.tryGet(CONVERSATION_MESSAGE_ENTITY, String(r.message_id));
        const { version: _v1, ...listed } = r;
        const { version: _v2, ...byIdPayload } = (byId ?? {}) as Record<string, unknown>;
        if (byId === null || digest(listed) !== digest(byIdPayload)) {
          throw new IntegrityError("FAIL_CLOSED_CONVERSATION_INTEGRITY", String(r.message_id));
        }
        return r as unknown as ConversationMessageRow;
      })
      .sort((a, b) => a.seq - b.seq)
      .filter((m) => m.seq > afterSeq);
    const page = rows.slice(0, limit);
    return {
      messages: page,
      next_after_seq: rows.length > limit ? page[page.length - 1]!.seq : null,
    };
  }
}
