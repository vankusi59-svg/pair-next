/**
 * telegram-delivery.ts — canonical explicit Telegram delivery authority
 * (Incident R2, hardened by R3 + R4).
 *
 * Telegram has two roles: a bounded lifecycle NOTIFICATION channel
 * (mission state changes) and an EXPLICIT delivery channel (files/result
 * text). File presence, outbox presence, and mission completion NEVER
 * authorize transmission — only a governed TELEGRAM_DELIVERY task whose
 * PAIR-stamped manifest names the exact artifacts may mint a send
 * request, and that request may only go to the canonically bound
 * destination chat.
 *
 * R4 — one identical durable lifecycle for EVERY payload (each FILES
 * artifact, and the TEXT payload alike), all transitions validated
 * fail-closed:
 *
 *   QUEUED ──beginDeliveryAttempt──▶ SENDING
 *     │                              │  definite success + message_id
 *     │                              ├──────────────────────────▶ SENT
 *     │                              │  definite failure, budget left
 *     │                              ├──▶ QUEUED (+attempt_count,
 *     │                              │      +next_retry_at backoff)
 *     │                              │  definite failure, budget spent
 *     │                              ├──▶ FAILED_DELIVERY (terminal)
 *     │                              │  ambiguous (crash/network)
 *     │                              └──▶ UNKNOWN_SIDE_EFFECT
 *     │
 *   A stale SENDING found on restart (the process died inside the
 *   transport window — Telegram may have accepted) reconciles to
 *   UNKNOWN_SIDE_EFFECT: never auto-resend, never silently SENT, and it
 *   does NOT re-project as sendable. TEXT and FILES share the identical
 *   state machine — TEXT has no asymmetric crash semantics.
 *
 *   SENT requires REAL Telegram acceptance evidence: a valid message_id
 *   persisted with completed_at. `ok`-without-message_id is classified
 *   UNKNOWN_SIDE_EFFECT by transport and rejected fail-closed at the
 *   domain transition — never silently SENT.
 *
 *   Retry governance is durable per payload: attempt_count,
 *   max_attempts (canonical ceiling PAIR_TG_DELIVERY_MAX_ATTEMPTS,
 *   bounded 1..10, default 3 — stamped at mint), next_retry_at
 *   (deterministic backoff), last_error. Past the ceiling →
 *   FAILED_DELIVERY, a durable terminal hold — no automatic human
 *   approval, no infinite bridge retry.
 *
 * Request-level status: QUEUED → SENT (all payloads SENT) |
 * FAILED_DELIVERY (all payloads terminal-failed) | UNSENDABLE
 * (destination unresolvable/not allowed — durable hold, zero sends,
 * never broadcast).
 */

import fs from "node:fs";
import path from "node:path";
import { canonicalJson, digest } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { deliveryManifest, normalizeArtifactPath } from "./plan-dataflow.js";
import type { PairEvidenceStore } from "./store.js";

export const TELEGRAM_DELIVERY_REQUEST = "telegram_delivery_request";

/** One canonical destination per request (R3 §9): the originating
 *  Telegram chat for telegram-origin missions, else exactly one
 *  configured default — never the allowlist. */
export interface DeliveryDestination {
  provider: "TELEGRAM";
  chat_id: string;
  provenance: "MISSION_ORIGIN" | "CONFIGURED_DEFAULT";
}

export type DeliveryPayloadState =
  | "QUEUED" // (retry = QUEUED + next_retry_at in the future)
  | "SENDING"
  | "SENT"
  | "UNKNOWN_SIDE_EFFECT"
  | "FAILED_DELIVERY";

/** The uniform payload slot — a FILES artifact or the TEXT payload.
 *  Identical lifecycle fields in both modes (R4 §8). */
export interface DeliverySlot {
  /** FILES only: canonical manifest name (normalized workspace-relative). */
  name?: string;
  state:
    | "QUEUED"
    | "SENDING"
    | "SENT"
    | "UNKNOWN_SIDE_EFFECT"
    | "FAILED_DELIVERY";
  /** Durable retry budget: consumed attempts + canonical ceiling. */
  attempt_count: number;
  max_attempts: number;
  /** Earliest eligible send time after a definite failure (ISO). */
  next_retry_at?: string;
  /** Deterministic attempt identity: ATT_<digest(delivery_id:slot:n)>. */
  attempt_id?: string;
  attempt_number?: number;
  attempt_started_at?: string;
  /** Telegram acceptance evidence — persisted only on definite success. */
  message_id?: string | number;
  sent_at?: string;
  completed_at?: string;
  last_error?: string;
  unknown_reason?: string;
}

export interface TelegramDeliveryRequestPayload {
  delivery_id: string;
  mission_id: string;
  task_id: string;
  execution_id: string;
  mode: "FILES" | "TEXT";
  /** FILES: one slot per manifested artifact. */
  artifacts: DeliverySlot[];
  /** TEXT: the bounded composed result text. */
  text: string | null;
  /** TEXT mode: identical slot fields live at request level (R4 §8). */
  text_state?: DeliverySlot["state"];
  attempt_count?: number;
  max_attempts?: number;
  next_retry_at?: string;
  attempt_id?: string;
  attempt_number?: number;
  attempt_started_at?: string;
  last_error?: string;
  message_id?: string | number;
  unknown_reason?: string;
  /** Canonically bound destination — NEVER a fan-out over the allowlist. */
  destination: DeliveryDestination | null;
  outbox_dir: string;
  workspace: string;
  status: "QUEUED" | "SENT" | "UNSENDABLE" | "FAILED_DELIVERY";
  hold_reason?: string;
  created_at: string;
  sent_at?: string;
}

const MAX_TEXT_BYTES = 3500;
/** Canonical default ceiling — overridden by the mint-time
 *  PAIR_TG_DELIVERY_MAX_ATTEMPTS env wiring. */
export const TELEGRAM_DELIVERY_DEFAULT_MAX_ATTEMPTS = 3;
/** Deterministic backoff: 5s × consumed attempts, bounded at 60s. */
export function telegramDeliveryBackoffSeconds(attemptCount: number): number {
  return Math.min(60, Math.max(1, attemptCount) * 5);
}

export function deliveryRequestId(missionId: string, taskId: string): string {
  return `TDR_${digest(`telegram_delivery:${missionId}:${taskId}`).slice(0, 24)}`;
}

/** R3 §3 — bind the one canonical destination. */
export function resolveDeliveryDestination(
  mission: Record<string, unknown>,
  opts: { defaultChatId?: string | null } = {},
): DeliveryDestination | null {
  const origin = (
    (mission.metadata as Record<string, unknown> | undefined)
      ?.mission_origin as Record<string, unknown> | undefined
  )?.operator_id;
  if (typeof origin === "string" && origin.startsWith("telegram:")) {
    const chat = origin.slice("telegram:".length).trim();
    if (chat) {
      return { provider: "TELEGRAM", chat_id: chat, provenance: "MISSION_ORIGIN" };
    }
  }
  const def = opts.defaultChatId ? String(opts.defaultChatId).trim() : "";
  if (def) {
    return { provider: "TELEGRAM", chat_id: def, provenance: "CONFIGURED_DEFAULT" };
  }
  return null;
}

/**
 * Mint the canonical send request for a completed TELEGRAM_DELIVERY task.
 * No stamped manifest → no send authority → no request. No canonical
 * destination → UNSENDABLE (fail closed, never broadcast). Idempotent —
 * the deterministic id makes a replayed settle a no-op.
 */
export function mintTelegramDeliveryRequest(args: {
  store: PairEvidenceStore;
  mission: Record<string, unknown>;
  task: Record<string, unknown>;
  execution: Record<string, unknown>;
  outboxDir: string;
  workspace: string;
  now: string;
  /** Exactly-one configured default destination (non-Telegram origin). */
  defaultChatId?: string | null;
  /** Canonical retry ceiling stamped per payload (bounded, env-driven). */
  maxAttempts?: number;
}): Record<string, unknown> | null {
  const manifest = deliveryManifest(args.task);
  if (!manifest) return null;
  const missionId = String(args.mission.mission_id);
  const taskId = String(args.task.task_id);
  const id = deliveryRequestId(missionId, taskId);
  const existing = args.store.tryGet(TELEGRAM_DELIVERY_REQUEST, id);
  if (existing) return existing;
  const destination = resolveDeliveryDestination(args.mission, {
    defaultChatId: args.defaultChatId,
  });
  const maxAttempts =
    Number.isSafeInteger(args.maxAttempts) && (args.maxAttempts as number) > 0
      ? (args.maxAttempts as number)
      : TELEGRAM_DELIVERY_DEFAULT_MAX_ATTEMPTS;
  const artifacts: DeliverySlot[] = manifest.artifacts.map((name) => ({
    name,
    state: "QUEUED",
    attempt_count: 0,
    max_attempts: maxAttempts,
  }));
  let text: string | null = null;
  if (manifest.mode === "TEXT") {
    const result = args.execution.result as Record<string, unknown> | undefined;
    const summary = result?.summary ?? result?.text ?? result;
    text = (typeof summary === "string" ? summary : canonicalJson(summary ?? {})).slice(
      0,
      MAX_TEXT_BYTES,
    );
  }
  const body: Record<string, unknown> = {
    delivery_id: id,
    mission_id: missionId,
    task_id: taskId,
    execution_id: String(args.execution.execution_id),
    mode: manifest.mode,
    artifacts,
    text,
    ...(manifest.mode === "TEXT"
      ? {
          text_state: "QUEUED",
          attempt_count: 0,
          max_attempts: maxAttempts,
        }
      : {}),
    destination,
    outbox_dir: args.outboxDir,
    workspace: args.workspace,
    ...(destination
      ? { status: "QUEUED" }
      : {
          status: "UNSENDABLE",
          hold_reason: "FAIL_CLOSED_TELEGRAM_DESTINATION_UNRESOLVED",
        }),
    created_at: args.now,
  };
  return args.store.put(TELEGRAM_DELIVERY_REQUEST, id, body);
}

/**
 * Resolve a manifested artifact name to an absolute path inside the
 * request's outbox dir — exact filename match, else the unique
 * `<taskPrefix>-<name>` remote-upload sibling, else the producer-staged
 * workspace path. Bounded, deterministic; null when absent/ambiguous.
 */
export function resolveDeliveryArtifactPath(args: {
  outboxDir: string;
  workspace?: string;
  name: string;
  existsSync?: (p: string) => boolean;
  listDirSync?: (p: string) => string[];
}): string | null {
  const normalized = normalizeArtifactPath(args.name);
  if (!normalized) return null;
  const rel = normalized.startsWith("outbox/")
    ? normalized.slice("outbox/".length)
    : path.posix.basename(normalized);
  const exists = args.existsSync ?? ((p: string) => fs.existsSync(p));
  const listDir =
    args.listDirSync ?? ((p: string) => fs.readdirSync(p).map(String));
  const exact = path.join(args.outboxDir, rel);
  if (exists(exact)) return exact;
  let names: string[] = [];
  try {
    names = listDir(args.outboxDir);
  } catch {
    names = [];
  }
  const prefixed = names.filter((f) => f.endsWith(`-${rel}`));
  if (prefixed.length === 1) return path.join(args.outboxDir, prefixed[0]);
  if (args.workspace) {
    const staged = path.join(args.workspace, normalized);
    if (exists(staged)) return staged;
  }
  return null;
}

/* ------------------------------ slots ------------------------------ */

/** A mutable view of the request's uniform payload slots: for TEXT the
 *  request-level fields; for FILES each artifact row. Mutations land on
 *  `next` which is then persisted. */
function slots(
  req: Record<string, unknown>,
  next: Record<string, unknown>,
): Array<{ slot: DeliverySlot; apply: () => void }> {
  if (req.mode === "TEXT") {
    const slot: DeliverySlot = {
      state: String(next.text_state ?? "QUEUED") as DeliverySlot["state"],
      attempt_count: Number(next.attempt_count ?? 0),
      max_attempts: Number(
        next.max_attempts ?? TELEGRAM_DELIVERY_DEFAULT_MAX_ATTEMPTS,
      ),
      next_retry_at: next.next_retry_at as string | undefined,
      attempt_id: next.attempt_id as string | undefined,
      attempt_number: next.attempt_number as number | undefined,
      attempt_started_at: next.attempt_started_at as string | undefined,
      message_id: next.message_id as string | number | undefined,
      sent_at: next.sent_at as string | undefined,
      completed_at: next.completed_at as string | undefined,
      last_error: next.last_error as string | undefined,
      unknown_reason: next.unknown_reason as string | undefined,
    };
    return [
      {
        slot,
        apply: () => {
          next.text_state = slot.state;
          next.attempt_count = slot.attempt_count;
          next.max_attempts = slot.max_attempts;
          next.next_retry_at = slot.next_retry_at;
          next.attempt_id = slot.attempt_id;
          next.attempt_number = slot.attempt_number;
          next.attempt_started_at = slot.attempt_started_at;
          next.message_id = slot.message_id;
          next.sent_at = slot.sent_at;
          next.completed_at = slot.completed_at;
          next.last_error = slot.last_error;
          next.unknown_reason = slot.unknown_reason;
          for (const k of [
            "next_retry_at",
            "attempt_id",
            "attempt_number",
            "attempt_started_at",
            "message_id",
            "sent_at",
            "completed_at",
            "last_error",
            "unknown_reason",
          ]) {
            if (slot[k as keyof DeliverySlot] === undefined) {
              delete next[k];
            }
          }
        },
      },
    ];
  }
  const artifacts = ((req.artifacts as DeliverySlot[]) ?? []).map((a) => ({
    ...a,
  }));
  next.artifacts = artifacts;
  return artifacts.map((a) => ({
    slot: a,
    apply: () => undefined, // mutation landed on artifacts array already
  }));
}

function findSlot(
  req: Record<string, unknown>,
  next: Record<string, unknown>,
  artifact: string | null | undefined,
): { slot: DeliverySlot; apply: () => void } {
  const all = slots(req, next);
  if (req.mode === "TEXT") {
    if (artifact !== null && artifact !== undefined) {
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_DELIVERY_ARTIFACT",
        `${String(req.delivery_id)}:${String(artifact)}`,
      );
    }
    return all[0];
  }
  const key = String(artifact ?? "");
  const hit = all.find((s) => s.slot.name === key);
  if (!hit) {
    throw new IntegrityError(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_ARTIFACT",
      `${String(req.delivery_id)}:${key}`,
    );
  }
  return hit;
}

function eligible(slot: DeliverySlot, now: string): boolean {
  if (slot.state !== "QUEUED") return false;
  if (slot.attempt_count >= slot.max_attempts) return false;
  if (slot.next_retry_at && slot.next_retry_at > now) return false;
  return true;
}

function recomputeStatus(
  req: Record<string, unknown>,
  next: Record<string, unknown>,
): "QUEUED" | "SENT" | "UNSENDABLE" | "FAILED_DELIVERY" {
  if (next.status === "UNSENDABLE") return "UNSENDABLE";
  // Read the ALREADY-mutated slot states in `next` (not `req` — a second
  // slots() copy would revert in-flight mutations).
  const states =
    req.mode === "TEXT"
      ? [next.text_state as DeliverySlot["state"]]
      : ((next.artifacts as DeliverySlot[]) ?? []).map((a) => a.state);
  if (states.length > 0 && states.every((s) => s === "SENT")) return "SENT";
  if (states.length > 0 && states.every((s) => s === "FAILED_DELIVERY")) {
    return "FAILED_DELIVERY";
  }
  return "QUEUED";
}

function putReq(
  store: PairEvidenceStore,
  req: Record<string, unknown>,
): Record<string, unknown> {
  return store.put(TELEGRAM_DELIVERY_REQUEST, String(req.delivery_id), {
    ...req,
    version: req.version,
  });
}

function failTransition(deliveryId: string, slot: string, from: string, to: string): never {
  throw new IntegrityError(
    "FAIL_CLOSED_TELEGRAM_DELIVERY_TRANSITION",
    `${deliveryId}:${slot}:${from}->${to}`,
  );
}

/**
 * QUEUED → SENDING: persist the deterministic attempt identity BEFORE
 * the network call (R4 §7 — ATT_<digest(delivery_id:slot:attempt_number)>,
 * no wall-clock inside the domain transition). Legal only from QUEUED
 * with retry budget remaining and next_retry_at elapsed (R4 §6).
 * Idempotent replay of the same in-flight begin returns existing state;
 * every other transition fails closed.
 */
export function beginDeliveryAttempt(args: {
  store: PairEvidenceStore;
  deliveryId: string;
  artifact?: string | null;
  now: string;
}): Record<string, unknown> {
  const req = args.store.get(TELEGRAM_DELIVERY_REQUEST, args.deliveryId);
  if (req.status !== "QUEUED") {
    failTransition(args.deliveryId, String(args.artifact ?? "text"), String(req.status), "SENDING");
  }
  const next = { ...req };
  const { slot, apply } = findSlot(req, next, args.artifact);
  if (slot.state === "SENDING") return req; // idempotent same-transition replay
  if (slot.state !== "QUEUED") {
    failTransition(args.deliveryId, String(args.artifact ?? "text"), slot.state, "SENDING");
  }
  if (slot.attempt_count >= slot.max_attempts) {
    failTransition(args.deliveryId, String(args.artifact ?? "text"), "BUDGET_EXHAUSTED", "SENDING");
  }
  if (slot.next_retry_at && slot.next_retry_at > args.now) {
    failTransition(args.deliveryId, String(args.artifact ?? "text"), "BACKOFF_PENDING", "SENDING");
  }
  const attemptNumber = slot.attempt_count + 1;
  slot.attempt_number = attemptNumber;
  slot.attempt_id = `ATT_${digest(
    `${args.deliveryId}:${String(args.artifact ?? "text")}:${attemptNumber}`,
  ).slice(0, 16)}`;
  slot.attempt_started_at = args.now;
  slot.state = "SENDING";
  apply();
  return putReq(args.store, next);
}

/**
 * Resolve an in-flight SENDING attempt. Legal only from SENDING:
 *  - SENT requires a valid Telegram message_id (real acceptance
 *    evidence — no message_id → fail closed, NEVER silent SENT).
 *  - FAILED consumes the attempt: budget left → QUEUED + bounded
 *    next_retry_at backoff; budget spent → FAILED_DELIVERY terminal hold.
 *  - UNKNOWN → UNKNOWN_SIDE_EFFECT (ambiguous acceptance — never resend).
 */
export function resolveDeliveryAttempt(args: {
  store: PairEvidenceStore;
  deliveryId: string;
  artifact?: string | null;
  outcome: "SENT" | "FAILED" | "UNKNOWN";
  messageId?: string | number;
  error?: string;
  now: string;
}): Record<string, unknown> {
  const req = args.store.get(TELEGRAM_DELIVERY_REQUEST, args.deliveryId);
  const next = { ...req };
  const { slot, apply } = findSlot(req, next, args.artifact);
  if (slot.state !== "SENDING") {
    failTransition(
      args.deliveryId,
      String(args.artifact ?? "text"),
      slot.state,
      args.outcome,
    );
  }
  delete slot.attempt_id;
  delete slot.attempt_number;
  delete slot.attempt_started_at;
  if (args.outcome === "SENT") {
    const mid = args.messageId;
    const valid =
      typeof mid === "number"
        ? Number.isFinite(mid)
        : typeof mid === "string" && mid.trim().length > 0;
    if (!valid) {
      // R4 §2 — SENT requires real Telegram acceptance evidence; a
      // claimed success without message_id is ambiguous, never SENT.
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_DELIVERY_EVIDENCE",
        `${args.deliveryId}:${String(args.artifact ?? "text")}:message_id missing`,
      );
    }
    slot.state = "SENT";
    slot.message_id = mid;
    slot.sent_at = args.now;
    slot.completed_at = args.now;
    delete slot.next_retry_at;
    delete slot.last_error;
  } else if (args.outcome === "FAILED") {
    slot.attempt_count = slot.attempt_count + 1;
    slot.last_error = String(args.error ?? "telegram transport failed").slice(0, 300);
    if (slot.attempt_count < slot.max_attempts) {
      slot.state = "QUEUED";
      slot.next_retry_at = new Date(
        Date.parse(args.now) +
          telegramDeliveryBackoffSeconds(slot.attempt_count) * 1000,
      ).toISOString();
    } else {
      // Retry ceiling reached — durable terminal hold, no auto-approval.
      slot.state = "FAILED_DELIVERY";
      delete slot.next_retry_at;
    }
  } else {
    slot.state = "UNKNOWN_SIDE_EFFECT";
    slot.unknown_reason = String(args.error ?? "transport acceptance unknown").slice(0, 300);
  }
  apply();
  const status = recomputeStatus(req, next);
  next.status = status;
  if (status === "SENT") next.sent_at = args.now;
  return putReq(args.store, next);
}

/**
 * A stale SENDING slot (process died inside the transport window) is
 * ambiguous — Telegram may or may not have accepted. Reconcile to
 * UNKNOWN_SIDE_EFFECT with durable evidence; never auto-resend, never
 * claim SENT (R3 §7D + R4 §1 — TEXT and FILES identical).
 */
export function reconcileStaleDeliveryAttempts(
  store: PairEvidenceStore,
  now: string,
): void {
  for (const req of store.list(TELEGRAM_DELIVERY_REQUEST)) {
    if (req.status !== "QUEUED") continue;
    let dirty = false;
    const next = { ...req } as Record<string, unknown>;
    for (const { slot, apply } of slots(req, next)) {
      if (slot.state === "SENDING") {
        dirty = true;
        slot.state = "UNKNOWN_SIDE_EFFECT";
        delete slot.attempt_id;
        delete slot.attempt_number;
        delete slot.attempt_started_at;
        slot.unknown_reason = `stale_sending_reconciled:${now}`;
      }
      apply();
    }
    if (dirty) putReq(store, next);
  }
}

/**
 * R4 §4 — only payloads canonically eligible NOW are projected for the
 * bridge: QUEUED + attempt budget left + next_retry_at elapsed. SENT /
 * UNSENDABLE / FAILED_DELIVERY / UNKNOWN_SIDE_EFFECT / SENDING and
 * backoff-pending payloads never reach the bridge. Requests with zero
 * eligible payloads are not returned at all.
 */
export function pendingTelegramDeliveries(
  store: PairEvidenceStore,
  now?: string,
): Array<Record<string, unknown>> {
  const ts = now ?? new Date().toISOString();
  reconcileStaleDeliveryAttempts(store, ts);
  const out: Array<Record<string, unknown>> = [];
  for (const req of store.list(TELEGRAM_DELIVERY_REQUEST)) {
    if (String(req.status) !== "QUEUED") continue;
    if (req.mode === "TEXT") {
      const probe = { ...req } as Record<string, unknown>;
      const [s] = slots(req, probe);
      if (!eligible(s.slot, ts)) continue;
      out.push(probe);
      continue;
    }
    const artifacts = ((req.artifacts as DeliverySlot[]) ?? [])
      .filter((a) => eligible(a, ts))
      .map((a) => ({
        name: a.name,
        state: a.state,
        attempt_count: a.attempt_count,
        max_attempts: a.max_attempts,
        next_retry_at: a.next_retry_at,
        path: resolveDeliveryArtifactPath({
          outboxDir: String(req.outbox_dir),
          workspace: req.workspace ? String(req.workspace) : undefined,
          name: String(a.name),
        }),
      }));
    if (!artifacts.length) continue;
    out.push({ ...req, artifacts });
  }
  return out;
}

/** Durable hold: the canonical destination is unresolvable or no longer
 *  permitted — zero sends, no broadcast fallback (R3 §4). Idempotent on
 *  an already-held request; rejected from any other status (R4 §6). */
export function holdTelegramDelivery(args: {
  store: PairEvidenceStore;
  deliveryId: string;
  reason: string;
  now: string;
}): Record<string, unknown> {
  const req = args.store.get(TELEGRAM_DELIVERY_REQUEST, args.deliveryId);
  if (req.status === "UNSENDABLE") return req;
  if (req.status !== "QUEUED") {
    failTransition(args.deliveryId, "request", String(req.status), "UNSENDABLE");
  }
  return putReq(args.store, {
    ...req,
    status: "UNSENDABLE",
    hold_reason: String(args.reason).slice(0, 300),
    hold_at: args.now,
  });
}
