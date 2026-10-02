/**
 * telegram-delivery.ts — canonical explicit Telegram delivery authority
 * (Incident R2).
 *
 * Telegram has two roles: a bounded lifecycle NOTIFICATION channel
 * (mission state changes) and an EXPLICIT delivery channel (files/result
 * text). File presence, outbox presence, and mission completion NEVER
 * authorize transmission — only a governed TELEGRAM_DELIVERY task whose
 * PAIR-stamped manifest names the exact artifacts may mint a send
 * request.
 *
 * A `telegram_delivery_request` entity is minted by MissionRuntime the
 * moment a delivery task's execution validates COMPLETED:
 *
 *   QUEUED ──(bridge transports each manifested artifact, acks each)──▶ SENT
 *
 * The entity is the ONLY send authority — the Telegram bridge reads the
 * pending list through the API and never discovers files by scanning
 * directories. Idempotency: delivery_id is a deterministic digest of
 * (mission_id, task_id) so a replayed settle cannot mint a second
 * request, and per-artifact acks are idempotent flips.
 */

import fs from "node:fs";
import path from "node:path";
import { canonicalJson, digest } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { deliveryManifest, normalizeArtifactPath } from "./plan-dataflow.js";
import type { PairEvidenceStore } from "./store.js";

export const TELEGRAM_DELIVERY_REQUEST = "telegram_delivery_request";

export interface DeliveryArtifact {
  /** Canonical manifest name (normalized workspace-relative). */
  name: string;
  /** QUEUED → SENT; each flip is an idempotent ack. */
  state: "QUEUED" | "SENT";
  sent_at?: string;
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
  /** Project outbox directory the artifacts resolve inside. */
  outbox_dir: string;
  /** Mission workspace root — manifested names are workspace-relative. */
  workspace: string;
  status: "QUEUED" | "SENT";
  created_at: string;
  sent_at?: string;
}

const MAX_TEXT_BYTES = 3500;

export function deliveryRequestId(missionId: string, taskId: string): string {
  return `TDR_${digest(`telegram_delivery:${missionId}:${taskId}`).slice(0, 24)}`;
}

/**
 * Mint the canonical send request for a completed TELEGRAM_DELIVERY task.
 * No stamped manifest → no send authority → no request (fail-safe:
 * nothing is sendable without the pinned manifest).
 * Idempotent — the deterministic id makes a replayed settle a no-op.
 */
export function mintTelegramDeliveryRequest(args: {
  store: PairEvidenceStore;
  mission: Record<string, unknown>;
  task: Record<string, unknown>;
  execution: Record<string, unknown>;
  outboxDir: string;
  workspace: string;
  now: string;
}): Record<string, unknown> | null {
  const manifest = deliveryManifest(args.task);
  if (!manifest) return null;
  const missionId = String(args.mission.mission_id);
  const taskId = String(args.task.task_id);
  const id = deliveryRequestId(missionId, taskId);
  const existing = args.store.tryGet(TELEGRAM_DELIVERY_REQUEST, id);
  if (existing) return existing;
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
    outbox_dir: args.outboxDir,
    workspace: args.workspace,
    status: "QUEUED",
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

/** QUEUED requests projected for the bridge: resolved absolute artifact
 *  paths plus the bounded text payload. Files that do not resolve stay
 *  QUEUED (visible as unresolved — the bridge never sees a guess). */
export function pendingTelegramDeliveries(
  store: PairEvidenceStore,
): Array<Record<string, unknown>> {
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

/**
 * Idempotent ack: mark one manifested artifact SENT (or the whole TEXT
 * request). Unknown names fail closed — the bridge may only ack what the
 * manifest authorizes. When every artifact is SENT the request closes.
 */
export function ackTelegramDelivery(args: {
  store: PairEvidenceStore;
  deliveryId: string;
  artifact?: string;
  now: string;
}): Record<string, unknown> {
  const req = args.store.get(TELEGRAM_DELIVERY_REQUEST, args.deliveryId);
  const artifacts = ((req.artifacts as DeliveryArtifact[]) ?? []).map((a) => ({
    ...a,
  }));
  if (req.mode === "TEXT") {
    const next = { ...req, status: "SENT", sent_at: args.now, version: req.version };
    return args.store.put(TELEGRAM_DELIVERY_REQUEST, args.deliveryId, next);
  }
  const name = String(args.artifact ?? "");
  const target = artifacts.find((a) => a.name === name);
  if (!target) {
    throw new IntegrityError(
      "FAIL_CLOSED_TELEGRAM_DELIVERY_ARTIFACT",
      `${args.deliveryId}:${name}`,
    );
  }
  target.state = "SENT";
  target.sent_at = args.now;
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
