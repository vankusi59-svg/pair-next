/**
 * telegram-delivery.ts — canonical explicit Telegram delivery authority
 * (Incident R2, hardened by R3).
 *
 * Telegram has two roles: a bounded lifecycle NOTIFICATION channel
 * (mission state changes) and an EXPLICIT delivery channel (files/result
 * text). File presence, outbox presence, and mission completion NEVER
 * authorize transmission — only a governed TELEGRAM_DELIVERY task whose
 * PAIR-stamped manifest names the exact artifacts may mint a send
 * request, and that request may only go to the canonically bound
 * destination chat.
 *
 * A `telegram_delivery_request` entity is minted by MissionRuntime the
 * moment a delivery task's execution validates COMPLETED. Its durable
 * transport lifecycle is explicit and per-artifact:
 *
 *   QUEUED ──beginDeliveryAttempt──▶ SENDING
 *     │                              │  definite success (message_id)
 *     │                              ├──────────────────────────▶ SENT
 *     │                              │  definite failure (bounded retry)
 *     │                              └──▶ QUEUED (+last_error)
 *     │                              │  ambiguous (crash/network)
 *     │                              └──────────▶ UNKNOWN_SIDE_EFFECT
 *     │
 *   a stale SENDING found on restart (the process died inside the
 *   transport window) reconciles to UNKNOWN_SIDE_EFFECT — never
 *   auto-resend, never silently SENT. A filename ".sent" mark is NOT
 *   transport evidence and was removed.
 *
 * Request-level status: QUEUED → SENT (all artifacts SENT) | UNSENDABLE
 * (destination unresolvable or no longer allowed — durable hold, zero
 * sends, never broadcast).
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

export type DeliveryArtifactState =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "UNKNOWN_SIDE_EFFECT";

export interface DeliveryAttempt {
  attempt_id: string;
  started_at: string;
}

export interface DeliveryArtifact {
  /** Canonical manifest name (normalized workspace-relative). */
  name: string;
  state: DeliveryArtifactState;
  attempt?: DeliveryAttempt;
  /** Telegram acceptance evidence — persisted only on definite success. */
  message_id?: string | number | null;
  sent_at?: string;
  completed_at?: string;
  /** Bounded retry evidence (definite failure → back to QUEUED). */
  last_error?: string;
  /** Ambiguous-side-effect evidence (crash window / unknown acceptance). */
  unknown_reason?: string;
}

export interface TelegramDeliveryRequestPayload {
  delivery_id: string;
  mission_id: string;
  task_id: string;
  execution_id: string;
  mode: "FILES" | "TEXT";
  /** Exact artifacts the delivery may transmit (manifest names). */
  artifacts: DeliveryArtifact[];
  /** TEXT-mode payload — bounded composed result text. */
  text: string | null;
  /** TEXT request-level attempt state (FILES mode tracks per-artifact). */
  attempt?: DeliveryAttempt;
  attempt_state?: "SENDING";
  last_error?: string;
  message_id?: string | number | null;
  unknown_reason?: string;
  /** Canonically bound destination — NEVER a fan-out over the allowlist. */
  destination: DeliveryDestination | null;
  /** Project outbox directory the artifacts resolve inside. */
  outbox_dir: string;
  /** Mission workspace root — manifested names are workspace-relative. */
  workspace: string;
  status: "QUEUED" | "SENT" | "UNSENDABLE";
  hold_reason?: string;
  created_at: string;
  sent_at?: string;
}

const MAX_TEXT_BYTES = 3500;

export function deliveryRequestId(missionId: string, taskId: string): string {
  return `TDR_${digest(`telegram_delivery:${missionId}:${taskId}`).slice(0, 24)}`;
}

/** R3 §3 — bind the one canonical destination. Telegram-origin missions
 *  deliver back to the originating chat (`operator_id=telegram:<id>`);
 *  other missions may use exactly one explicitly configured default.
 *  Unresolvable → null (UNSENDABLE, fail closed — never broadcast). */
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
 * No stamped manifest → no send authority → no request (fail-safe:
 * nothing is sendable without the pinned manifest). No canonical
 * destination → request minted UNSENDABLE (durable hold, never sent —
 * R3 §3 fail-closed). Idempotent — the deterministic id makes a
 * replayed settle a no-op.
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
  const artifacts: DeliveryArtifact[] = manifest.artifacts.map((name) => ({
    name,
    state: "QUEUED",
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
 * `<taskPrefix>-<name>` remote-upload sibling. Bounded, deterministic;
 * returns null when absent or ambiguous (never sends a guess).
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
  // Remote-upload shape: /api/outbox lands `<taskPrefix>-<filename>` in
  // the outbox dir — unique suffix match only, never a glob guess.
  let names: string[] = [];
  try {
    names = listDir(args.outboxDir);
  } catch {
    names = [];
  }
  const prefixed = names.filter((f) => f.endsWith(`-${rel}`));
  if (prefixed.length === 1) return path.join(args.outboxDir, prefixed[0]);
  // Producer-staged path: the manifested workspace-relative file itself
  // (delivery resolves what the plan produced — it does not require the
  // producer to copy into outbox).
  if (args.workspace) {
    const staged = path.join(args.workspace, normalized);
    if (exists(staged)) return staged;
  }
  return null;
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

function findArtifact(
  req: Record<string, unknown>,
  name: string,
): { artifacts: DeliveryArtifact[]; index: number } {
  const artifacts = ((req.artifacts as DeliveryArtifact[]) ?? []).map((a) => ({
    ...a,
    attempt: a.attempt ? { ...a.attempt } : undefined,
  }));
  return { artifacts, index: artifacts.findIndex((a) => a.name === name) };
}

function assertArtifactTarget(
  req: Record<string, unknown>,
  artifact: string | null | undefined,
): { artifacts: DeliveryArtifact[]; index: number } {
  if (req.mode === "TEXT") {
    if (artifact !== null && artifact !== undefined) {
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_DELIVERY_ARTIFACT",
        `${String(req.delivery_id)}:${String(artifact)}`,
      );
    }
    return { artifacts: [], index: -1 };
  }
  const { artifacts, index } = findArtifact(req, String(artifact ?? ""));
  if (index < 0) {
    throw new IntegrityError(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_ARTIFACT",
      `${String(req.delivery_id)}:${String(artifact ?? "")}`,
    );
  }
  return { artifacts, index };
}

function recomputeStatus(req: Record<string, unknown>): "QUEUED" | "SENT" | "UNSENDABLE" {
  if (req.status === "UNSENDABLE") return "UNSENDABLE";
  const artifacts = (req.artifacts as DeliveryArtifact[]) ?? [];
  const done =
    req.mode === "TEXT"
      ? req.status === "SENT"
      : artifacts.length > 0 && artifacts.every((a) => a.state === "SENT");
  return done ? "SENT" : "QUEUED";
}

/** QUEUED → SENDING: persist the attempt identity BEFORE the network
 *  call (R3 §7A). Idempotent for an already-SENDING slot (replay of the
 *  same in-flight attempt); any other state fails closed silently as
 *  no-op so a retried HTTP transition cannot corrupt terminal state. */
export function beginDeliveryAttempt(args: {
  store: PairEvidenceStore;
  deliveryId: string;
  artifact?: string | null;
  now: string;
}): Record<string, unknown> {
  const req = args.store.get(TELEGRAM_DELIVERY_REQUEST, args.deliveryId);
  const attempt: DeliveryAttempt = {
    attempt_id: `ATT_${digest(`${args.deliveryId}:${String(args.artifact ?? "text")}:${Date.now()}`).slice(0, 16)}`,
    started_at: args.now,
  };
  if (req.mode === "TEXT") {
    if (req.attempt_state === "SENDING") return req;
    const next = { ...req, attempt, attempt_state: "SENDING" };
    return putReq(args.store, next);
  }
  const { artifacts, index } = assertArtifactTarget(req, args.artifact);
  if (artifacts[index].state === "SENDING") return req;
  if (artifacts[index].state !== "QUEUED") return req;
  artifacts[index].state = "SENDING";
  artifacts[index].attempt = attempt;
  return putReq(args.store, { ...req, artifacts });
}

/** Resolve an in-flight attempt by transport outcome. SENT persists
 *  Telegram acceptance evidence (message_id + completed_at); FAILED
 *  returns to QUEUED with bounded last_error (retryable by policy);
 *  UNKNOWN persists UNKNOWN_SIDE_EFFECT — never auto-resend. */
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
  if (req.mode === "TEXT") {
    if (req.attempt_state !== "SENDING") return req;
    const next: Record<string, unknown> = { ...req };
    delete next.attempt;
    delete next.attempt_state;
    if (args.outcome === "SENT") {
      next.status = "SENT";
      next.message_id = args.messageId ?? null;
      next.sent_at = args.now;
      next.completed_at = args.now;
    } else if (args.outcome === "FAILED") {
      next.last_error = String(args.error ?? "telegram transport failed").slice(0, 300);
    } else {
      next.unknown_reason = String(args.error ?? "transport acceptance unknown").slice(0, 300);
      next.status = "QUEUED"; // still pending manual reconciliation
    }
    return putReq(args.store, next);
  }
  const { artifacts, index } = assertArtifactTarget(req, args.artifact);
  const art = artifacts[index];
  if (art.state !== "SENDING") return req;
  delete art.attempt;
  if (args.outcome === "SENT") {
    art.state = "SENT";
    art.message_id = args.messageId ?? null;
    art.sent_at = args.now;
    art.completed_at = args.now;
  } else if (args.outcome === "FAILED") {
    art.state = "QUEUED";
    art.last_error = String(args.error ?? "telegram transport failed").slice(0, 300);
  } else {
    art.state = "UNKNOWN_SIDE_EFFECT";
    art.unknown_reason = String(args.error ?? "transport acceptance unknown").slice(0, 300);
  }
  const next: Record<string, unknown> = { ...req, artifacts };
  const status = recomputeStatus({ ...next });
  next.status = status;
  if (status === "SENT") next.sent_at = args.now;
  return putReq(args.store, next);
}

/** A stale SENDING slot (process died inside the transport window) is
 *  ambiguous — Telegram may or may not have accepted. Reconcile to
 *  UNKNOWN_SIDE_EFFECT with durable evidence; never auto-resend and
 *  never claim SENT (R3 §7D + §15A/B). */
export function reconcileStaleDeliveryAttempts(
  store: PairEvidenceStore,
  now: string,
): void {
  for (const req of store.list(TELEGRAM_DELIVERY_REQUEST)) {
    if (req.status !== "QUEUED") continue;
    let dirty = false;
    const next = { ...req } as Record<string, unknown>;
    if (req.mode === "TEXT" && req.attempt_state === "SENDING") {
      delete next.attempt;
      delete next.attempt_state;
      next.unknown_reason = `stale_sending_reconciled:${now}`;
      dirty = true;
    }
    const artifacts = ((req.artifacts as DeliveryArtifact[]) ?? []).map((a) => {
      if (a.state === "SENDING") {
        dirty = true;
        return {
          ...a,
          state: "UNKNOWN_SIDE_EFFECT" as const,
          attempt: undefined,
          unknown_reason: `stale_sending_reconciled:${now}`,
        };
      }
      return a;
    });
    if (dirty) {
      next.artifacts = artifacts;
      putReq(store, next);
    }
  }
}

/** QUEUED requests projected for the bridge: resolved absolute artifact
 *  paths plus the bounded text payload and the bound destination. Stale
 *  SENDING slots are reconciled to UNKNOWN_SIDE_EFFECT first so a
 *  restarted bridge never replays an ambiguous attempt. */
export function pendingTelegramDeliveries(
  store: PairEvidenceStore,
  now?: string,
): Array<Record<string, unknown>> {
  reconcileStaleDeliveryAttempts(store, now ?? new Date().toISOString());
  const out: Array<Record<string, unknown>> = [];
  for (const req of store.list(TELEGRAM_DELIVERY_REQUEST)) {
    if (String(req.status) !== "QUEUED") continue;
    const artifacts = ((req.artifacts as DeliveryArtifact[]) ?? []).map((a) => ({
      name: a.name,
      state: a.state,
      path:
        a.state === "QUEUED"
          ? resolveDeliveryArtifactPath({
              outboxDir: String(req.outbox_dir),
              workspace: req.workspace ? String(req.workspace) : undefined,
              name: a.name,
            })
          : null,
    }));
    out.push({ ...req, artifacts });
  }
  return out;
}

/** Durable hold: the canonical destination is unresolvable or no longer
 *  permitted — zero sends, no broadcast fallback (R3 §4). Idempotent. */
export function holdTelegramDelivery(args: {
  store: PairEvidenceStore;
  deliveryId: string;
  reason: string;
  now: string;
}): Record<string, unknown> {
  const req = args.store.get(TELEGRAM_DELIVERY_REQUEST, args.deliveryId);
  if (req.status === "UNSENDABLE") return req;
  return putReq(args.store, {
    ...req,
    status: "UNSENDABLE",
    hold_reason: String(args.reason).slice(0, 300),
    hold_at: args.now,
  });
}

/**
 * Idempotent ack kept for API compatibility — marks one manifested
 * artifact SENT with optional Telegram message evidence, or the whole
 * TEXT request. Prefer beginDeliveryAttempt + resolveDeliveryAttempt
 * (the explicit transport lifecycle) for real transport.
 */
export function ackTelegramDelivery(args: {
  store: PairEvidenceStore;
  deliveryId: string;
  artifact?: string;
  now: string;
  messageId?: string | number;
}): Record<string, unknown> {
  const req = args.store.get(TELEGRAM_DELIVERY_REQUEST, args.deliveryId);
  if (req.mode === "TEXT") {
    const next = {
      ...req,
      status: "SENT",
      sent_at: args.now,
      ...(args.messageId !== undefined ? { message_id: args.messageId } : {}),
      version: req.version,
    };
    return args.store.put(TELEGRAM_DELIVERY_REQUEST, args.deliveryId, next);
  }
  const { artifacts, index } = assertArtifactTarget(req, args.artifact);
  const target = artifacts[index];
  target.state = "SENT";
  target.sent_at = args.now;
  if (args.messageId !== undefined) target.message_id = args.messageId;
  const done = artifacts.every((a) => a.state === "SENT");
  const next = {
    ...req,
    artifacts,
    status: done ? "SENT" : "QUEUED",
    ...(done ? { sent_at: args.now } : {}),
    version: req.version,
  };
  return args.store.put(TELEGRAM_DELIVERY_REQUEST, args.deliveryId, next);
}
