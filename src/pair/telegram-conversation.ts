/* P15.8-E — Telegram conversation ingress authority.
 *
 * The bridge is a thin transport: it long-polls Telegram, maps each
 * update to ONE call into this service, and renders the returned text.
 * ALL authority decisions live here, against the canonical P15.8-A/B/C
 * services — nothing in this module mints a mission. The only path to
 * execution remains MissionDraftService.confirmDraft behind an explicit
 * button ref or a reply-bound natural-language ack.
 *
 * Entities (single `entities` table, same digest/version discipline as
 * the rest of the store):
 *
 *   telegram_chat_binding (TGB_*) — durable operator↔chat↔session map.
 *     Sessions persist server-side, so conversation continuity survives
 *     bridge restarts and process crashes.
 *
 *   telegram_confirm_ref (TGR_*) — compact opaque reference minted when
 *     a draft prompt is sent. It binds: chat, operator, session, exact
 *     draft_id AND the full draft_digest, the prompt message id, and the
 *     draft's own expiry. callback_data carries only `c:<ref_id>` — the
 *     digest is NEVER truncated onto the wire; the ref resolves to the
 *     full canonical digest server-side before confirmation. The same
 *     ref is what makes a reply-bound "OK" unambiguous: an ack text may
 *     confirm ONLY when it replies to the recorded prompt message of an
 *     ACTIVE ref AND the draft service's ack contract still holds.
 *
 * Idempotency: update ids become canonical keys — turns mint under
 * `tg:upd:<update_id>`, draft creation under `tg:draft:<update_id>`, so
 * Telegram's at-least-once delivery replays converge to zero new writes.
 * Ref confirmation converges through the draft's own exactly-once gate.
 */

import { digest, newId, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import type { PairEvidenceStore } from "./store.js";
import type {
  ConversationSessionService,
  ConversationSessionRow,
} from "./conversation-session.js";
import type { ConversationReasoningService, ConversationTurnResult } from "./conversation-reasoning.js";
import type { MissionDraftService, MissionDraftRow } from "./mission-draft.js";
import { resolveProposalProject } from "./mission-draft.js";

export const TELEGRAM_CHAT_BINDING_ENTITY = "telegram_chat_binding";
export const TELEGRAM_CONFIRM_REF_ENTITY = "telegram_confirm_ref";
export const TELEGRAM_UPDATE_ENTITY = "telegram_update";

/* Natural-language ack set — matched case-insensitively on the trimmed
 * message. An ack text is confirmation authority ONLY when reply-bound
 * to a recorded prompt message; anywhere else it is ordinary chat. */
export const TELEGRAM_ACK_WORDS = new Set([
  "ok", "okay", "yes", "y", "vâng", "vang", "được", "duoc",
  "xác nhận", "xac nhan", "confirm", "làm đi", "lam di", "go",
]);

const TG_MAX_TEXT_CHARS = 3500;
const TELEGRAM_PRIVATE_ONLY = "private";
/** Telegram caps a message at 4096 chars — hold headroom so markup and
 *  future fields never push a rendered part over the wire limit. */
const TG_MSG_SAFE_CHARS = 4000;
/** Presentation bound: header + goal chunks + final confirmation block.
 *  Canonical terms (goal ≤ 3500 + fixed metadata) always fit within 4 —
 *  anything larger means inconsistent inputs → fail closed, never
 *  partially present. */
const TG_MAX_PRESENTATION_MESSAGES = 4;

export interface TelegramChatBindingRow {
  binding_id: string;
  operator_id: string;
  chat_id: string;
  session_id: string;
  binding_digest: string;
  created_at: string;
  updated_at: string;
}

export const TELEGRAM_CONFIRM_REF_STATES = ["ACTIVE", "CONSUMED", "INVALIDATED"] as const;
export type TelegramConfirmRefState = (typeof TELEGRAM_CONFIRM_REF_STATES)[number];

export interface TelegramConfirmRefRow {
  ref_id: string;
  operator_id: string;
  chat_id: string;
  session_id: string;
  draft_id: string;
  /** Full canonical draft digest — the confirmation authority lives
   *  here; the wire only ever carries the opaque ref_id. */
  draft_digest: string;
  /** Telegram message id of the bot's confirmation prompt — the ONLY
   *  message a natural-language ack may reply to. */
  prompt_message_id: number | null;
  state: TelegramConfirmRefState;
  created_at: string;
  expires_at: string;
  ref_digest: string;
}

export function telegramBindingDigest(row: {
  binding_id: string; operator_id: string; chat_id: string; session_id: string;
}): string {
  return digest({
    contract: "pair-telegram-chat-binding.v1",
    binding_id: row.binding_id,
    operator_id: row.operator_id,
    chat_id: row.chat_id,
    session_id: row.session_id,
  });
}

export function telegramRefDigest(row: {
  ref_id: string; operator_id: string; chat_id: string; session_id: string;
  draft_id: string; draft_digest: string; prompt_message_id: number | null;
}): string {
  return digest({
    contract: "pair-telegram-confirm-ref.v1",
    ref_id: row.ref_id,
    operator_id: row.operator_id,
    chat_id: row.chat_id,
    session_id: row.session_id,
    draft_id: row.draft_id,
    draft_digest: row.draft_digest,
    prompt_message_id: row.prompt_message_id,
  });
}

/** Deterministic ref per draft — re-prompting the same draft converges
 *  onto the same ref instead of minting parallel authorities. */
export function telegramRefIdFor(draftId: string): string {
  return `TGR_${digest(`telegram-confirm-ref:${draftId}`).slice(0, 22)}`;
}

/* ------------------------------------------------------------------ */
/* Processed-update outcome records (R1.A)                              */
/*                                                                      */
/* Telegram's delivery is at-least-once; the bridge's durable cursor is  */
/* only a hint. The COMMITTED outcome of a mutating inbound action is    */
/* recorded here INSIDE the same transaction that performs it — a       */
/* replayed update converges onto the recorded outcome no matter what   */
/* the cursor says.                                                     */
export interface TelegramUpdateRow {
  update_key: string;       // `tgupd:<chat_id>:<update_id>` — entity key
  chat_id: string;
  update_id: number;
  kind: string;             // the action committed (currently "new")
  /** Recorded outcome summary — returned verbatim on replay. */
  outcome: Record<string, unknown>;
  update_digest: string;
  created_at: string;
}

export function telegramUpdateDigest(row: {
  update_key: string; chat_id: string; update_id: number;
  kind: string; outcome: Record<string, unknown>;
}): string {
  return digest({
    contract: "pair-telegram-update.v1",
    update_key: row.update_key,
    chat_id: row.chat_id,
    update_id: row.update_id,
    kind: row.kind,
    outcome: row.outcome,
  });
}

/* ------------------------------------------------------------------ */
/* Draft presentation (R1.B)                                            */
/*                                                                      */
/* Confirmation authority requires the operator to SEE the exact        */
/* canonical terms. Presentation segments are built here — the bridge   */
/* may attach the Confirm markup ONLY to the last segment and may only  */
/* call prompt-sent after it delivered. A draft whose terms cannot be   */
/* fully presented within the bounded segment count fails closed with   */
/* zero confirmation authority (the ref is never minted).               */
export function telegramDraftPresentation(draft: MissionDraftRow): string[] {
  const header = [
    "GOVERNED MISSION DRAFT — chờ xác nhận",
    `draft: ${draft.draft_id}`,
    "",
    "goal:",
  ].join("\n");
  const goal = String(draft.goal ?? "");
  const confirmBlock = [
    "ĐIỀU KHOẢN — kiểm tra trước khi xác nhận:",
    `draft: ${draft.draft_id}`,
    `project: ${draft.project_id}`,
    `permissions: ${(draft.granted_permissions ?? []).join(", ") || "—"}`,
    `workspaces: ${(draft.authorized_workspaces ?? []).join(", ") || "—"}`,
    `risk ceiling: ${draft.risk_ceiling ?? "system default"}`,
    `hết hạn: ${draft.expires_at}`,
    "",
    "Bấm Confirm để submit đúng draft này — hoặc reply tin nhắn này bằng \"OK\"/\"xác nhận\".",
  ].join("\n");
  const full = [header, goal, "", confirmBlock].join("\n");
  // Single-message when everything fits — identical shape to the
  // pre-R1 prompt for ordinary short drafts.
  if (full.length <= TG_MSG_SAFE_CHARS) return [full];
  // Otherwise chunk the COMPLETE content — the last segment always ends
  // with the confirmation instructions and is the ONLY segment that may
  // carry Confirm markup.
  const parts: string[] = [];
  for (let i = 0; i < full.length; i += TG_MSG_SAFE_CHARS) {
    parts.push(full.slice(i, i + TG_MSG_SAFE_CHARS));
  }
  if (parts.length > TG_MAX_PRESENTATION_MESSAGES) {
    throw new IntegrityError(
      "FAIL_CLOSED_TELEGRAM_PRESENTATION",
      `terms need ${parts.length} messages (cap ${TG_MAX_PRESENTATION_MESSAGES})`,
    );
  }
  return parts;
}

function assertField(field: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new IntegrityError("FAIL_CLOSED_TELEGRAM_FIELD", `${field} invalid`);
  }
  return v;
}

export interface TelegramIngressDeps {
  store: PairEvidenceStore;
  conversation: ConversationSessionService;
  drafts: MissionDraftService;
  /** Absent → turns fail typed CONVERSATION_REASONING_DISABLED while
   *  binding/draft/confirm paths keep working. */
  reasoning?: ConversationReasoningService | null;
  now?: () => string;
}

export type TelegramIngressResult =
  | { kind: "reply"; session_id: string; reply: string; reused: boolean }
  | { kind: "ack_confirmed"; session_id: string; draft_id: string; mission_id: string; reused: boolean }
  | { kind: "reasoning_unavailable"; session_id: string }
  | { kind: "draft_proposal"; session_id: string; reply: string;
      draft: MissionDraftRow; ref: TelegramConfirmRefRow; presentation: string[] }
  | { kind: "project_candidates"; session_id: string; reply: string; goal: string;
      candidates: Array<{ project_id: string; name: string }> };

export class TelegramConversationService {
  constructor(private readonly deps: TelegramIngressDeps) {}

  private now(): string {
    return (this.deps.now ?? utcnow)();
  }

  /** The operator identity and the chat it claims must be the SAME —
   *  a header saying telegram:111 cannot mint refs for chat 222. */
  private assertChatOperator(operatorId: string, chatId: string): void {
    if (operatorId !== `telegram:${chatId}`) {
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_OPERATOR_CHAT_MISMATCH",
        `${operatorId} vs chat:${chatId}`,
      );
    }
  }

  private assertCanonicalBinding(row: Record<string, unknown>): asserts row is Record<string, unknown> & TelegramChatBindingRow {
    for (const f of ["binding_id", "operator_id", "chat_id", "session_id", "binding_digest"]) {
      if (typeof row[f] !== "string" || !row[f]) {
        throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", `binding.${f}`);
      }
    }
    const d = telegramBindingDigest(row as unknown as TelegramChatBindingRow);
    if (d !== String(row.binding_digest)) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", String(row.binding_id));
    }
  }

  private assertCanonicalRef(row: Record<string, unknown>): asserts row is Record<string, unknown> & TelegramConfirmRefRow {
    for (const f of ["ref_id", "operator_id", "chat_id", "session_id", "draft_id", "draft_digest", "ref_digest", "state"]) {
      if (typeof row[f] !== "string" || !row[f]) {
        throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", `ref.${f}`);
      }
    }
    if (!(TELEGRAM_CONFIRM_REF_STATES as readonly string[]).includes(String(row.state))) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", `ref.state=${String(row.state)}`);
    }
    if (telegramRefDigest(row as unknown as TelegramConfirmRefRow) !== String(row.ref_digest)) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", String(row.ref_id));
    }
  }

  private canonicalRef(refId: string): TelegramConfirmRefRow {
    const raw = this.deps.store.tryGet(TELEGRAM_CONFIRM_REF_ENTITY, refId);
    if (!raw) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_NOT_FOUND", refId);
    }
    this.assertCanonicalRef(raw);
    return raw as unknown as TelegramConfirmRefRow;
  }

  /* ------------------------------------------------------------------ */
  /* Chat ↔ session binding                                              */
  /* ------------------------------------------------------------------ */

  /** Durable chat→session map. A missing binding mints a session AND
   *  its binding in one transaction; a binding to a closed session is
   *  rebound the same way (restart creates nothing ambiguous). */
  resolveChatSession(input: { operator_id: string; chat_id: string }): {
    session: ConversationSessionRow; created: boolean;
  } {
    const operatorId = assertField("operator_id", input.operator_id);
    const chatId = assertField("chat_id", input.chat_id);
    this.assertChatOperator(operatorId, chatId);
    return this.deps.store.immediate(() => {
      const existing = this.deps.store
        .list(TELEGRAM_CHAT_BINDING_ENTITY)
        .find((r) => String(r.chat_id) === chatId);
      if (existing) {
        this.assertCanonicalBinding(existing);
        if (String(existing.operator_id) !== operatorId) {
          throw new IntegrityError("FAIL_CLOSED_TELEGRAM_BINDING_OWNER", chatId);
        }
        const session = this.deps.conversation.getSession(
          String(existing.session_id), operatorId);
        if (session.state === "OPEN") {
          return { session, created: false };
        }
        // Bound session is closed — rebind to a fresh session atomically.
        const rebound = this.deps.conversation.createSession({
          owner_operator_id: operatorId,
          title: `telegram:${chatId}`,
        });
        const next = {
          ...existing,
          session_id: rebound.session_id,
          binding_digest: telegramBindingDigest({
            binding_id: String(existing.binding_id),
            operator_id: operatorId,
            chat_id: chatId,
            session_id: rebound.session_id,
          }),
          updated_at: this.now(),
        };
        this.deps.store.put(
          TELEGRAM_CHAT_BINDING_ENTITY,
          String(existing.binding_id),
          next,
          Number(existing.version ?? 0),
        );
        return { session: rebound, created: true };
      }
      const session = this.deps.conversation.createSession({
        owner_operator_id: operatorId,
        title: `telegram:${chatId}`,
      });
      const bindingId = newId("TGB");
      const binding: TelegramChatBindingRow = {
        binding_id: bindingId,
        operator_id: operatorId,
        chat_id: chatId,
        session_id: session.session_id,
        binding_digest: telegramBindingDigest({
          binding_id: bindingId, operator_id: operatorId, chat_id: chatId,
          session_id: session.session_id,
        }),
        created_at: this.now(),
        updated_at: this.now(),
      };
      this.deps.store.put(TELEGRAM_CHAT_BINDING_ENTITY, bindingId, binding as unknown as Record<string, unknown>);
      return { session, created: true };
    }) as { session: ConversationSessionRow; created: boolean };
  }

  /** "/new" — close the bound session and mint a fresh one. Pending
   *  drafts on the old session become unreachable for acks (they belong
   *  to the closed session), which is exactly the operator intent.
   *
   *  Idempotent by (chat_id, update_id): the rotation AND its outcome
   *  record commit in the SAME transaction — a replayed /new update
   *  returns the originally minted session (`reused: true`) and never
   *  rotates again. */
  newChatSession(input: {
    operator_id: string; chat_id: string; update_id: number;
  }): { session: ConversationSessionRow; reused: boolean } {
    const operatorId = assertField("operator_id", input.operator_id);
    const chatId = assertField("chat_id", input.chat_id);
    this.assertChatOperator(operatorId, chatId);
    if (!Number.isSafeInteger(Number(input.update_id)) || Number(input.update_id) <= 0) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_FIELD", "update_id invalid");
    }
    const updateId = Number(input.update_id);
    const updateKey = `tgupd:${chatId}:${updateId}`;
    return this.deps.store.immediate(() => {
      const prior = this.deps.store.tryGet(TELEGRAM_UPDATE_ENTITY, updateKey);
      if (prior) {
        if (String(prior.update_digest) !== telegramUpdateDigest({
          update_key: String(prior.update_key), chat_id: String(prior.chat_id),
          update_id: Number(prior.update_id), kind: String(prior.kind),
          outcome: prior.outcome as Record<string, unknown>,
        })) {
          throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", updateKey);
        }
        if (String(prior.kind) !== "new" || String(prior.chat_id) !== chatId) {
          throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", `kind ${String(prior.kind)}`);
        }
        const recorded = this.deps.conversation.getSession(
          String((prior.outcome as { session_id: string }).session_id), operatorId);
        return { session: recorded, reused: true };
      }
      const existing = this.deps.store
        .list(TELEGRAM_CHAT_BINDING_ENTITY)
        .find((r) => String(r.chat_id) === chatId);
      if (existing) {
        this.assertCanonicalBinding(existing);
        if (String(existing.operator_id) !== operatorId) {
          throw new IntegrityError("FAIL_CLOSED_TELEGRAM_BINDING_OWNER", chatId);
        }
        try {
          this.deps.conversation.closeSession(
            String(existing.session_id), { operator_id: operatorId });
        } catch { /* already closed — rebinding still succeeds */ }
      }
      const session = this.deps.conversation.createSession({
        owner_operator_id: operatorId,
        title: `telegram:${chatId}`,
      });
      const bindingId = existing ? String(existing.binding_id) : newId("TGB");
      const row = {
        ...(existing ?? { binding_id: bindingId, created_at: this.now() }),
        binding_id: bindingId,
        operator_id: operatorId,
        chat_id: chatId,
        session_id: session.session_id,
        binding_digest: telegramBindingDigest({
          binding_id: bindingId, operator_id: operatorId, chat_id: chatId,
          session_id: session.session_id,
        }),
        updated_at: this.now(),
        created_at: String((existing ?? {}).created_at ?? this.now()),
      };
      this.deps.store.put(
        TELEGRAM_CHAT_BINDING_ENTITY,
        bindingId,
        row,
        existing ? Number(existing.version ?? 0) : undefined,
      );
      // Atomic outcome record — same transaction as the rotation.
      const outcomeRow: TelegramUpdateRow = {
        update_key: updateKey,
        chat_id: chatId,
        update_id: updateId,
        kind: "new",
        outcome: {
          session_id: session.session_id,
          previous_session_id: existing ? String(existing.session_id) : null,
        },
        update_digest: "",
        created_at: this.now(),
      };
      outcomeRow.update_digest = telegramUpdateDigest(outcomeRow);
      this.deps.store.put(
        TELEGRAM_UPDATE_ENTITY, updateKey,
        outcomeRow as unknown as Record<string, unknown>);
      return { session, reused: false };
    }) as unknown as { session: ConversationSessionRow; reused: boolean };
  }

  /* ------------------------------------------------------------------ */
  /* Text ingress — classification                                       */
  /* ------------------------------------------------------------------ */

  /** ONE decision point for ordinary text. Classification is
   *  deterministic: a message is a reply-bound ack ONLY when it replies
   *  to the recorded prompt message of an ACTIVE ref whose ack-word set
   *  matches; everything else is a conversation turn. Model intent never
   *  classifies. `update_id` is the at-least-once dedup anchor. */
  async ingress(input: {
    operator_id: string;
    chat_id: string;
    chat_type?: string | null;
    update_id: number;
    text: string;
    reply_to_message_id?: number | null;
  }): Promise<TelegramIngressResult> {
    const operatorId = assertField("operator_id", input.operator_id);
    const chatId = assertField("chat_id", input.chat_id);
    this.assertChatOperator(operatorId, chatId);
    const chatType = input.chat_type ?? TELEGRAM_PRIVATE_ONLY;
    if (chatType !== TELEGRAM_PRIVATE_ONLY) {
      // V1: private chats only — a group has no unambiguous single-
      // operator identity to bind confirmation authority to.
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_CHAT_TYPE", `type=${chatType}`);
    }
    if (!Number.isSafeInteger(Number(input.update_id)) || Number(input.update_id) <= 0) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_FIELD", "update_id invalid");
    }
    const text = String(input.text ?? "").trim();
    if (!text || text.length > TG_MAX_TEXT_CHARS) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_FIELD", "text empty/oversize");
    }
    const updateId = Number(input.update_id);

    // R2 — processed-update replay: a reply-bound ack whose confirmation
    // committed records its outcome keyed by (chat_id, update_id). The
    // same redelivered update replays that receipt VERBATIM — even after
    // the ref moved to CONSUMED — instead of reclassifying into an
    // ordinary turn (which would mint messages and re-invoke the model).
    const updKey = `tgupd:${chatId}:${updateId}`;
    const prior = this.deps.store.tryGet(TELEGRAM_UPDATE_ENTITY, updKey);
    if (prior) {
      if (String(prior.update_digest) !== telegramUpdateDigest({
        update_key: String(prior.update_key), chat_id: String(prior.chat_id),
        update_id: Number(prior.update_id), kind: String(prior.kind),
        outcome: prior.outcome as Record<string, unknown>,
      })) {
        throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", updKey);
      }
      if (String(prior.kind) !== "ack" || String(prior.chat_id) !== chatId) {
        throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY",
          `update ${updateId} kind ${String(prior.kind)}`);
      }
      const o = prior.outcome as {
        session_id: string; draft_id: string; mission_id: string;
        ref_id: string; prompt_message_id: number;
      };
      // The replay binding is durable and cannot be redirected: the
      // recorded session must canonically exist and belong to THIS
      // operator, and the recorded prompt message is the exact one the
      // original ack replied to — never "another draft/prompt/session".
      if (Number(o.prompt_message_id) !== Number(input.reply_to_message_id ?? NaN)) {
        throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY",
          `update ${updateId} prompt mismatch`);
      }
      const boundSession = this.deps.conversation.getSession(
        String(o.session_id), operatorId);
      return {
        kind: "ack_confirmed", session_id: boundSession.session_id,
        draft_id: String(o.draft_id), mission_id: String(o.mission_id),
        reused: true,
      };
    }

    const { session } = this.resolveChatSession({ operator_id: operatorId, chat_id: chatId });

    // Reply-bound natural-language ack? The ref must be ACTIVE, bound to
    // THIS chat+session, and the replied-to message must be the prompt
    // the ref recorded — never "any bot message".
    const ackish = TELEGRAM_ACK_WORDS.has(text.toLowerCase());
    const replyTo = input.reply_to_message_id;
    if (ackish && Number.isSafeInteger(Number(replyTo))) {
      const ref = this.deps.store
        .list(TELEGRAM_CONFIRM_REF_ENTITY)
        .map((r) => { this.assertCanonicalRef(r); return r as unknown as TelegramConfirmRefRow; })
        .find((r) =>
          r.chat_id === chatId &&
          r.operator_id === operatorId &&
          r.state === "ACTIVE" &&
          r.prompt_message_id === Number(replyTo),
        );
      if (ref) {
        const c = await this.confirmByRef({
          operator_id: operatorId, chat_id: chatId, ref_id: ref.ref_id,
          kind: "ack", update_id: updateId,
        });
        return {
          kind: "ack_confirmed", session_id: session.session_id,
          draft_id: c.draft.draft_id, mission_id: c.mission_id, reused: c.reused,
        };
      }
      // Unbound ack → falls through to ordinary conversation below.
    }

    if (!this.deps.reasoning) {
      return { kind: "reasoning_unavailable", session_id: session.session_id };
    }
    const turn: ConversationTurnResult = await this.deps.reasoning.turn({
      session_id: session.session_id,
      operator_id: operatorId,
      body: text,
      idempotency_key: `tg:upd:${Number(input.update_id)}`,
    });
    // P15.8-F — actionable text may carry a model PROPOSAL. The proposal
    // itself authorizes nothing; materialization runs through the same
    // canonical prepareDraft seam as /draft (deterministic project
    // resolution, update-bound idempotency, ref + bounded presentation).
    // Ambiguous or absent projects mint NOTHING — the bridge presents
    // the candidate list and the operator chooses via /draft.
    if (turn.proposal && !turn.reused) {
      const res = resolveProposalProject(this.deps.store);
      if (res.kind === "resolved") {
        const prepared = this.prepareDraft({
          operator_id: operatorId, chat_id: chatId,
          project_id: res.project_id, goal: turn.proposal.goal,
          update_id: updateId,
        });
        return {
          kind: "draft_proposal",
          session_id: session.session_id,
          reply: String(turn.reply.body ?? ""),
          draft: prepared.draft,
          ref: prepared.ref,
          presentation: prepared.presentation,
        };
      }
      return {
        kind: "project_candidates",
        session_id: session.session_id,
        reply: String(turn.reply.body ?? ""),
        goal: turn.proposal.goal,
        candidates: res.candidates,
      };
    }
    return {
      kind: "reply",
      session_id: session.session_id,
      reply: String(turn.reply.body ?? ""),
      reused: turn.reused,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Draft preparation + prompt refs                                     */
  /* ------------------------------------------------------------------ */

  /** "/draft <project> <goal>" — explicit draft preparation. The caller
   *  MUST name a canonical project; the service never picks one. Draft
   *  creation mints ZERO missions; the ACTIVE ref is what the bot's
   *  Confirm/Reject buttons and the prompt message bind to.
   *
   *  `presentation` (R1.B): the COMPLETE canonical terms split into
   *  Telegram-safe segments — the bridge must deliver all of them in
   *  order and may attach Confirm markup ONLY to the last one. When the
   *  terms cannot be fully presented, this throws before the ref is
   *  minted: no ref, no prompt, zero confirmation authority. */
  prepareDraft(input: {
    operator_id: string;
    chat_id: string;
    project_id: string;
    goal: string;
    update_id: number;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
  }): { session: ConversationSessionRow; draft: MissionDraftRow; ref: TelegramConfirmRefRow; presentation: string[] } {
    const operatorId = assertField("operator_id", input.operator_id);
    const chatId = assertField("chat_id", input.chat_id);
    this.assertChatOperator(operatorId, chatId);
    const projectId = assertField("project_id", input.project_id);
    const goal = assertField("goal", input.goal);
    if (goal.length > TG_MAX_TEXT_CHARS) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_FIELD", "goal oversize");
    }
    const { session } = this.resolveChatSession({ operator_id: operatorId, chat_id: chatId });
    const draft = this.deps.drafts.createDraft({
      session_id: session.session_id,
      operator_id: operatorId,
      project_id: projectId,
      goal,
      granted_permissions: input.granted_permissions,
      authorized_workspaces: input.authorized_workspaces,
      risk_ceiling: input.risk_ceiling,
      // Update-bound request id: a replayed /draft update converges onto
      // the same draft rather than minting duplicates.
      client_request_id: `tg:draft:${Number(input.update_id)}`,
    });
    // Build the full presentation BEFORE the ref exists — an
    // unpresentable draft mints no ref and holds no confirm authority.
    const presentation = telegramDraftPresentation(draft);
    return {
      session, draft, presentation,
      ref: this.mintRef({ operatorId, chatId, sessionId: session.session_id, draft }),
    };
  }

  private mintRef(input: {
    operatorId: string; chatId: string; sessionId: string; draft: MissionDraftRow;
  }): TelegramConfirmRefRow {
    return this.deps.store.immediate(() => {
      const refId = telegramRefIdFor(input.draft.draft_id);
      const existing = this.deps.store.tryGet(TELEGRAM_CONFIRM_REF_ENTITY, refId);
      if (existing) {
        this.assertCanonicalRef(existing);
        // Re-mint of the same draft's ref resets it ACTIVE with no prompt
        // binding — convergent, one ref authority per draft.
        const next = {
          ...existing,
          prompt_message_id: null,
          state: "ACTIVE" as const,
          expires_at: input.draft.expires_at,
          ref_digest: telegramRefDigest({
            ref_id: refId, operator_id: input.operatorId, chat_id: input.chatId,
            session_id: input.sessionId, draft_id: input.draft.draft_id,
            draft_digest: input.draft.draft_digest, prompt_message_id: null,
          }),
        };
        return this.deps.store.put(
          TELEGRAM_CONFIRM_REF_ENTITY, refId, next,
          Number(existing.version ?? 0)) as unknown as TelegramConfirmRefRow;
      }
      const row: TelegramConfirmRefRow = {
        ref_id: refId,
        operator_id: input.operatorId,
        chat_id: input.chatId,
        session_id: input.sessionId,
        draft_id: input.draft.draft_id,
        draft_digest: input.draft.draft_digest,
        prompt_message_id: null,
        state: "ACTIVE",
        created_at: this.now(),
        expires_at: input.draft.expires_at,
        ref_digest: telegramRefDigest({
          ref_id: refId, operator_id: input.operatorId, chat_id: input.chatId,
          session_id: input.sessionId, draft_id: input.draft.draft_id,
          draft_digest: input.draft.draft_digest, prompt_message_id: null,
        }),
      };
      return this.deps.store.put(
        TELEGRAM_CONFIRM_REF_ENTITY, refId,
        row as unknown as Record<string, unknown>) as unknown as TelegramConfirmRefRow;
    });
  }

  /** Record which Telegram message carried the prompt — called after
   *  the bot's sendMessage returns its message_id. Only this recorded
   *  message grants reply-bound ack authority. */
  bindPromptMessage(input: {
    operator_id: string; chat_id: string; ref_id: string; message_id: number;
  }): TelegramConfirmRefRow {
    const operatorId = assertField("operator_id", input.operator_id);
    const chatId = assertField("chat_id", input.chat_id);
    this.assertChatOperator(operatorId, chatId);
    if (!Number.isSafeInteger(Number(input.message_id)) || Number(input.message_id) <= 0) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_FIELD", "message_id invalid");
    }
    return this.deps.store.immediate(() => {
      const ref = this.canonicalRef(input.ref_id);
      if (ref.operator_id !== operatorId || ref.chat_id !== chatId) {
        throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_OWNERSHIP", ref.ref_id);
      }
      if (ref.state !== "ACTIVE") {
        throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_STATE", `ref ${ref.ref_id} ${ref.state}`);
      }
      const mid = Number(input.message_id);
      const next = {
        ...ref,
        prompt_message_id: mid,
        ref_digest: telegramRefDigest({ ...ref, prompt_message_id: mid }),
      };
      return this.deps.store.put(
        TELEGRAM_CONFIRM_REF_ENTITY, ref.ref_id, next,
        Number((ref as unknown as { version?: number }).version ?? 0),
      ) as unknown as TelegramConfirmRefRow;
    });
  }

  /** The ref a callback carries: opaque id → validate → the FULL stored
   *  digest goes to confirmDraft. A consumed ref replays the draft's own
   *  exactly-once receipt rather than erroring (duplicate taps
   *  converge); anything else (foreign chat, expired, invalidated,
   *  tampered digest) fails closed. */
  async confirmByRef(input: {
    operator_id: string;
    chat_id: string;
    chat_type?: string | null;
    ref_id: string;
    kind: "explicit" | "ack";
    /** R2 — the triggering Telegram update id. When present, the
     *  ack_confirmed outcome is recorded in the SAME transaction that
     *  consumes the ref, so a redelivered update replays the receipt
     *  even after the ref is CONSUMED (no reclassification into a turn). */
    update_id?: number;
  }): Promise<{ draft: MissionDraftRow; mission_id: string; mission: Record<string, unknown>; reused: boolean }> {
    const operatorId = assertField("operator_id", input.operator_id);
    const chatId = assertField("chat_id", input.chat_id);
    this.assertChatOperator(operatorId, chatId);
    if ((input.chat_type ?? TELEGRAM_PRIVATE_ONLY) !== TELEGRAM_PRIVATE_ONLY) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_CHAT_TYPE", "group confirmations rejected");
    }
    const ref = this.canonicalRef(assertField("ref_id", input.ref_id));
    if (ref.operator_id !== operatorId || ref.chat_id !== chatId) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_OWNERSHIP", ref.ref_id);
    }
    if (ref.state !== "ACTIVE" && ref.state !== "CONSUMED") {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_STATE", `ref ${ref.ref_id} ${ref.state}`);
    }
    // R1.B — a ref grants confirmation authority ONLY after the complete
    // terms presentation was durably delivered: the recorded prompt
    // message is the proof that every segment reached the operator. An
    // unbound ref (prompt never sent, partial delivery) cannot confirm.
    if (ref.prompt_message_id == null) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_NOT_PRESENTED", ref.ref_id);
    }
    // Expiry binds only live prompts — a CONSUMED ref replays its
    // receipt regardless so duplicate taps converge deterministically.
    if (ref.state === "ACTIVE" && ref.expires_at <= this.now()) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_EXPIRED", ref.ref_id);
    }
    const result = await this.deps.drafts.confirmDraft({
      session_id: ref.session_id,
      operator_id: operatorId,
      draft_id: ref.draft_id,
      expected_digest: ref.draft_digest,
      kind: input.kind,
    });
    // Mark the ref consumed after the governed submission converged —
    // repeat callbacks still replay the same receipt via the draft.
    // R2: when a Telegram update drove this confirmation, its outcome is
    // recorded in the SAME transaction — a redelivery replays the
    // receipt, never reclassifies into an ordinary turn.
    this.deps.store.immediate(() => {
      const cur = this.canonicalRef(ref.ref_id);
      if (cur.state === "ACTIVE") {
        this.deps.store.put(
          TELEGRAM_CONFIRM_REF_ENTITY, ref.ref_id,
          { ...cur, state: "CONSUMED" },
          Number((cur as unknown as { version?: number }).version ?? 0),
        );
      }
      if (input.update_id !== undefined) {
        const updateId = Number(input.update_id);
        const updateKey = `tgupd:${chatId}:${updateId}`;
        const prior = this.deps.store.tryGet(TELEGRAM_UPDATE_ENTITY, updateKey);
        const outcome = {
          session_id: ref.session_id,
          draft_id: ref.draft_id,
          mission_id: result.mission_id,
          ref_id: ref.ref_id,
          prompt_message_id: ref.prompt_message_id,
        };
        if (prior) {
          // Already recorded — it must be the IDENTICAL outcome, else a
          // redirect attempt fails closed.
          const same =
            String(prior.kind) === "ack" &&
            String(prior.chat_id) === chatId &&
            JSON.stringify(prior.outcome) === JSON.stringify(outcome);
          if (!same ||
              String(prior.update_digest) !== telegramUpdateDigest({
                update_key: String(prior.update_key), chat_id: String(prior.chat_id),
                update_id: Number(prior.update_id), kind: String(prior.kind),
                outcome: prior.outcome as Record<string, unknown> })) {
            throw new IntegrityError("FAIL_CLOSED_TELEGRAM_INTEGRITY", updateKey);
          }
          return;
        }
        const outcomeRow: TelegramUpdateRow = {
          update_key: updateKey,
          chat_id: chatId,
          update_id: updateId,
          kind: "ack",
          outcome,
          update_digest: "",
          created_at: this.now(),
        };
        outcomeRow.update_digest = telegramUpdateDigest(outcomeRow);
        this.deps.store.put(
          TELEGRAM_UPDATE_ENTITY, updateKey,
          outcomeRow as unknown as Record<string, unknown>);
      }
    });
    return result;
  }

  rejectByRef(input: {
    operator_id: string; chat_id: string; ref_id: string;
  }): MissionDraftRow {
    const operatorId = assertField("operator_id", input.operator_id);
    const chatId = assertField("chat_id", input.chat_id);
    this.assertChatOperator(operatorId, chatId);
    const ref = this.canonicalRef(assertField("ref_id", input.ref_id));
    if (ref.operator_id !== operatorId || ref.chat_id !== chatId) {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_OWNERSHIP", ref.ref_id);
    }
    if (ref.state === "CONSUMED") {
      throw new IntegrityError("FAIL_CLOSED_TELEGRAM_REF_STATE", `ref ${ref.ref_id} CONSUMED`);
    }
    const draft = this.deps.drafts.rejectDraft({
      session_id: ref.session_id,
      operator_id: operatorId,
      draft_id: ref.draft_id,
    });
    this.deps.store.immediate(() => {
      const cur = this.canonicalRef(ref.ref_id);
      if (cur.state !== "ACTIVE") return;
      this.deps.store.put(
        TELEGRAM_CONFIRM_REF_ENTITY, ref.ref_id,
        { ...cur, state: "INVALIDATED" },
        Number((cur as unknown as { version?: number }).version ?? 0),
      );
    });
    return draft;
  }

  /** Pending drafts of the bound session — the bridge renders these on
   *  /drafts so an operator sees what an ack could bind to. */
  listPending(input: { operator_id: string; chat_id: string }): MissionDraftRow[] {
    const operatorId = assertField("operator_id", input.operator_id);
    const chatId = assertField("chat_id", input.chat_id);
    this.assertChatOperator(operatorId, chatId);
    const { session } = this.resolveChatSession({ operator_id: operatorId, chat_id: chatId });
    return this.deps.drafts
      .listDrafts({ session_id: session.session_id, operator_id: operatorId })
      .filter((d) => d.state === "PENDING_CONFIRMATION");
  }
}
