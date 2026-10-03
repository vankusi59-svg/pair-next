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
 * Request-level aggregate status (R5 §2): QUEUED → SENT (all payloads
 * SENT) | FAILED_DELIVERY (terminal deterministic failures, no
 * progressable payload left) | UNKNOWN_SIDE_EFFECT (acceptance
 * ambiguity dominates once nothing progressable remains) | UNSENDABLE
 * (destination unresolvable/not allowed — durable hold, zero sends,
 * never broadcast). QUEUED means at least one payload can still make
 * canonical automatic progress (eligible, backoff-pending, or SENDING)
 * — a request with zero progressable payloads never stays QUEUED.
 */

import fs from "node:fs";
import path from "node:path";
import { boundedFileSha256, compatOutboxBasename, digest, sha256Hex } from "./canonical.js";
import type { BoundedFileResult } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { DELIVERY_TEXT_ARTIFACT } from "./output-language.js";
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
  /** FILES only: canonical artifact identity (SHA-256 of the exact bytes
   *  verified at the delivery-contract gate). The bridge-side projection
   *  re-verifies it — a file mutated after minting fails closed with
   *  FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST, zero network call. */
  sha256?: string;
  /** FILES only (F4): retained CAS object path stamped at mint — the
   *  canonical bytes for `sha256` live here, NOT in the shared outbox.
   *  The projection stages verified bytes from this path only; a slot
   *  minted without it has no canonical byte source. */
  source_path?: string;
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
  status:
    | "QUEUED"
    | "SENT"
    | "UNSENDABLE"
    | "FAILED_DELIVERY"
    | "UNKNOWN_SIDE_EFFECT";
  hold_reason?: string;
  created_at: string;
  sent_at?: string;
}

export const MAX_TEXT_BYTES = 3500;
/** Canonical artifact-digest shape — shared by the mint check, the
 *  bridge-side projection, and the settle-time delivery gate. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/** R1.1 — THE one canonical materialization of the wire TEXT payload.
 *  The delivery-contract gate materializes the payload from the
 *  canonical source artifact with EXACTLY these rules, validates it,
 *  and hands the same string to mint — mint never re-reads or
 *  re-transforms the file (no TOCTOU / trim / truncation drift between
 *  what was validated and what is sent). */
export function materializeDeliveryTextPayload(raw: string): string {
  return raw.trim().slice(0, MAX_TEXT_BYTES);
}
/** Canonical default ceiling — overridden by the mint-time
 *  PAIR_TG_DELIVERY_MAX_ATTEMPTS env wiring. */
export const TELEGRAM_DELIVERY_DEFAULT_MAX_ATTEMPTS = 3;
/** Deterministic backoff: 5s × consumed attempts, bounded at 60s. */
export function telegramDeliveryBackoffSeconds(attemptCount: number): number {
  return Math.min(60, Math.max(1, attemptCount) * 5);
}
/** R6 §3 — canonical default SENDING lease: a durable SENDING slot is
 *  stale only once now - attempt_started_at exceeds this; overridden by
 *  the PAIR_TG_DELIVERY_STALE_AFTER_MS env wiring (bounded, validated). */
export const TELEGRAM_DELIVERY_DEFAULT_STALE_AFTER_MS = 60_000;

/** R3/R4.2 — bounded byte materialization: the Telegram Bot API caps
 *  bot uploads at ~50MB; a pinned artifact beyond this bound can never
 *  send, so it converges to a durable terminal failure rather than
 *  polling QUEUED forever (checked by stat BEFORE any full read). */
export const MAX_TELEGRAM_FILE_BYTES = 48 * 1024 * 1024;

/** R5/F1 — the ONE canonical stat-first bounded file authority lives in
 *  canonical.ts so every governed byte seam (delivery pins/snapshots/
 *  transport AND the F1 artifact ingest authority) shares identical
 *  semantics: stat proves `size <= maxBytes` FIRST, a successful read
 *  proves `bytes.length === stat size`, and the sha256 is computed over
 *  THOSE exact materialized bytes. Re-exported for compatibility. */
export { boundedFileSha256, type BoundedFileResult };

export function deliveryRequestId(missionId: string, taskId: string): string {
  return `TDR_${digest(`telegram_delivery:${missionId}:${taskId}`).slice(0, 24)}`;
}

/** R2.3/R3 — request-owned staging namespace for digest-pinned wire
 *  snapshots: hidden so artifact-name resolution never confuses a
 *  staged copy for a manifested sibling. */
export const DELIVERY_SNAPSHOT_DIR = ".delivery-snapshots";

/** Deterministic snapshot path shared by projection, transport, and
 *  retention cleanup — same name every pass. */
function deliverySnapshotPath(
  outboxDir: string,
  deliveryId: string,
  name: string,
): string {
  return path.join(
    outboxDir,
    DELIVERY_SNAPSHOT_DIR,
    `${deliveryId}-${name}`.replace(/[^A-Za-z0-9._-]/g, "_"),
  );
}

const TERMINAL_DELIVERY_SLOT = new Set(["SENT", "FAILED_DELIVERY"]);
const TERMINAL_DELIVERY_REQUEST = new Set([
  "SENT",
  "FAILED_DELIVERY",
  "UNSENDABLE",
]);

/** R3 — bounded snapshot retention. A pinned snapshot exists only
 *  while its slot's fate is open (QUEUED retry, in-flight SENDING,
 *  UNKNOWN_SIDE_EFFECT investigation — the bytes are the evidence of
 *  what may/must still ship). Once a slot is SENT/FAILED_DELIVERY, or
 *  the whole request lands terminal, the durable identity evidence is
 *  the slot's sha256 itself and the staged bytes are removed on the
 *  next projection pass — no unbounded hidden-file accumulation over
 *  long-running production. Best-effort: a vanished file is no error. */
function pruneDeliverySnapshots(req: Record<string, unknown>): void {
  const outbox = req.outbox_dir;
  if (typeof outbox !== "string" || !outbox) return;
  const id = String(req.delivery_id);
  const requestTerminal = TERMINAL_DELIVERY_REQUEST.has(String(req.status));
  const artifacts = req.artifacts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(artifacts)) {
    for (const a of artifacts) {
      if (!requestTerminal && !TERMINAL_DELIVERY_SLOT.has(String(a.state))) {
        continue;
      }
      const snap = deliverySnapshotPath(outbox, id, String(a.name));
      for (const p of [snap, `${snap}.tmp`]) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* best effort — a missing snapshot is already pruned */
        }
      }
    }
  }
  const dir = path.join(outbox, DELIVERY_SNAPSHOT_DIR);
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    /* best effort */
  }
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
  /** FILES: artifact content identity verified at the delivery-contract
   *  gate (manifest name → SHA-256 hex). R1.2 — MANDATORY: every FILES
   *  manifest name must map to a valid SHA-256; a missing/incomplete/
   *  malformed map mints nothing (no hash → no authority). */
  artifactSha256?: Record<string, string>;
  /** FILES: manifest name → retained CAS object path the canonical
   *  bytes for `artifactSha256[name]` live at (stamped at mint by the
   *  caller that verified them — the projection stages from THIS path
   *  and re-proves its digest, never the shared outbox). */
  artifactSources?: Record<string, string>;
  /** TEXT: the exact wire payload materialized and validated at the
   *  delivery-contract gate — mint stores it verbatim and NEVER
   *  re-reads the source file (R1.1: VALIDATED PAYLOAD === TDR
   *  PAYLOAD). */
  textPayload?: string;
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
  if (manifest.mode === "FILES") {
    // R1.2 — digest authority is mandatory: no hash → no authority.
    // A FILES mint without the complete verified map, or with any
    // malformed digest, fails closed before the request exists.
    const bad = (name: string, why: string): never => {
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST",
        JSON.stringify({ artifact: name, reason: why }),
      );
    };
    const map = args.artifactSha256;
    for (const name of manifest.artifacts) {
      const sha = map?.[name];
      if (sha === undefined || sha === null) bad(name, "missing_artifact_digest");
      else if (!SHA256_HEX_RE.test(String(sha))) bad(name, "malformed_digest");
    }
  }
  const artifacts: DeliverySlot[] = manifest.artifacts.map((name) => ({
    name,
    state: "QUEUED",
    attempt_count: 0,
    max_attempts: maxAttempts,
    ...(manifest.mode === "FILES"
      ? {
          sha256: String(args.artifactSha256?.[name]),
          ...(typeof args.artifactSources?.[name] === "string"
            ? { source_path: args.artifactSources[name] }
            : {}),
        }
      : {}),
  }));
  let text: string | null = null;
  let textEvidence: Record<string, unknown> = {};
  if (manifest.mode === "TEXT") {
    // R1.1 — the TDR text is the EXACT payload materialized and
    // language-validated at the delivery-contract gate. Mint never
    // re-reads or re-transforms the source artifact: an unbound mint
    // (caller forgot the gate) fails closed instead of fabricating a
    // payload from unvalidated bytes.
    if (typeof args.textPayload !== "string" || !args.textPayload.length) {
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_UNBOUND",
        JSON.stringify({ artifact: DELIVERY_TEXT_ARTIFACT }),
      );
    }
    text = args.textPayload;
    textEvidence = {
      text_sha256: digest(text),
      text_length: text.length,
      text_source_artifact: DELIVERY_TEXT_ARTIFACT,
    };
  }
  const body: Record<string, unknown> = {
    delivery_id: id,
    mission_id: missionId,
    task_id: taskId,
    execution_id: String(args.execution.execution_id),
    mode: manifest.mode,
    artifacts,
    text,
    ...textEvidence,
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
  let normalized = normalizeArtifactPath(args.name);
  if (!normalized) {
    // R2.5 — a logical artifact name outside the manifest charset
    // (e.g. `a b.txt`, `a?b.txt`) can still resolve deterministically
    // through the shared compat rule when it is a plain basename with
    // no traversal — the compat writer's deterministic output is what
    // this lookup is for. Strictly reject anything with separators.
    const raw = String(args.name ?? "");
    if (
      raw &&
      !raw.includes("/") &&
      !raw.includes("\\") &&
      !raw.includes("\0") &&
      raw !== "." &&
      raw !== ".." &&
      !raw.startsWith("~")
    ) {
      normalized = raw;
    }
  }
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
  // R2.5 — ONE canonical naming rule with the compat writer: resolve by
  // the same sanitized basename the outbox materialization emits
  // (`<task>-<artfrag>-<compatBasename>`). Distinct logical names that
  // sanitize alike produce multiple matches -> fail closed, never pick.
  const compatRel = compatOutboxBasename(rel);
  const prefixed = names.filter((f) => f.endsWith(`-${compatRel}`));
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

/** R5 §4 — Telegram Bot API `Message.message_id` is an Integer; only a
 *  positive safe integer is canonical SENT evidence. */
export function isValidTelegramMessageId(mid: unknown): mid is number {
  return typeof mid === "number" && Number.isSafeInteger(mid) && mid > 0;
}

/** A slot can still make canonical automatic progress: eligible now,
 *  QUEUED under bounded backoff (budget left), or in-flight SENDING. */
function progressable(slot: DeliverySlot): boolean {
  if (slot.state === "SENDING") return true;
  return slot.state === "QUEUED" && slot.attempt_count < slot.max_attempts;
}

/** R5 §2 — canonical request aggregate. QUEUED only while ≥1 payload
 *  can still make automatic progress; otherwise terminal aggregate:
 *  UNKNOWN_SIDE_EFFECT dominates FAILED_DELIVERY, which dominates SENT
 *  mix. Per-slot evidence is never flattened. */
function recomputeStatus(
  req: Record<string, unknown>,
  next: Record<string, unknown>,
): "QUEUED" | "SENT" | "UNSENDABLE" | "FAILED_DELIVERY" | "UNKNOWN_SIDE_EFFECT" {
  if (next.status === "UNSENDABLE") return "UNSENDABLE";
  // Read the ALREADY-mutated slot state in `next` (not `req` — a second
  // slots() copy would revert in-flight mutations).
  const all: DeliverySlot[] =
    req.mode === "TEXT"
      ? [
          {
            state: next.text_state as DeliverySlot["state"],
            attempt_count: Number(next.attempt_count ?? 0),
            max_attempts: Number(next.max_attempts ?? 1),
          },
        ]
      : ((next.artifacts as DeliverySlot[]) ?? []);
  if (all.some(progressable)) return "QUEUED";
  if (all.some((s) => s.state === "UNKNOWN_SIDE_EFFECT")) {
    return "UNKNOWN_SIDE_EFFECT";
  }
  if (all.some((s) => s.state === "FAILED_DELIVERY")) {
    return "FAILED_DELIVERY";
  }
  if (all.length > 0 && all.every((s) => s.state === "SENT")) return "SENT";
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
 * R7 — exclusive send claim: `begin` is an ACQUIRE, not a status peek.
 * `acquired === true` is the ONLY positive durable evidence that THIS
 * caller performed QUEUED→SENDING and therefore holds transport
 * authority for this attempt. A caller that finds the slot already
 * SENDING gets `acquired:false`/`ALREADY_CLAIMED` — it must perform
 * ZERO network calls; retrying a begin whose response was lost can
 * never regain send permission (the slot converges via the normal
 * SENT / stale→UNKNOWN_SIDE_EFFECT path). `attempt_id` identifies the
 * attempt — it is NEVER ownership permission by itself.
 */
export interface BeginDeliveryResult {
  acquired: boolean;
  request: Record<string, unknown>;
  /** Canonical attempt identity (present on both outcomes). */
  attempt_id?: string;
  attempt_number?: number;
  /** e.g. "ALREADY_CLAIMED" on a competing/lost-response begin. */
  reason?: string;
}

/**
 * QUEUED → SENDING: persist the deterministic attempt identity BEFORE
 * the network call (R4 §7 — ATT_<digest(delivery_id:slot:attempt_number)>,
 * no wall-clock inside the domain transition). Legal only from QUEUED
 * with retry budget remaining and next_retry_at elapsed (R4 §6).
 */
export function beginDeliveryAttempt(args: {
  store: PairEvidenceStore;
  deliveryId: string;
  artifact?: string | null;
  now: string;
}): BeginDeliveryResult {
  const req = args.store.get(TELEGRAM_DELIVERY_REQUEST, args.deliveryId);
  if (req.status !== "QUEUED") {
    failTransition(args.deliveryId, String(args.artifact ?? "text"), String(req.status), "SENDING");
  }
  const next = { ...req };
  const { slot, apply } = findSlot(req, next, args.artifact);
  if (slot.state === "SENDING") {
    // Already claimed — durable state is authoritative, never send
    // authority for a competing or response-lost caller.
    return {
      acquired: false,
      reason: "ALREADY_CLAIMED",
      request: req,
      attempt_id: slot.attempt_id,
      attempt_number: slot.attempt_number,
    };
  }
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
  const attemptId = `ATT_${digest(
    `${args.deliveryId}:${String(args.artifact ?? "text")}:${attemptNumber}`,
  ).slice(0, 16)}`;
  slot.attempt_id = attemptId;
  slot.attempt_started_at = args.now;
  slot.state = "SENDING";
  apply();
  const request = putReq(args.store, next);
  return { acquired: true, request, attempt_id: attemptId, attempt_number: attemptNumber };
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
    // R4 §2 + R5 §4-5 — SENT requires REAL Telegram acceptance evidence:
    // a positive safe-integer message_id (Bot API Integer). Strings,
    // "MID_fake", 0, negatives, fractions, NaN are all rejected
    // fail-closed — a caller cannot forge SENT by posting fake ids.
    if (!isValidTelegramMessageId(args.messageId)) {
      throw new IntegrityError(
        "FAIL_CLOSED_TELEGRAM_DELIVERY_EVIDENCE",
        `${args.deliveryId}:${String(args.artifact ?? "text")}:invalid message_id`,
      );
    }
    slot.state = "SENT";
    slot.message_id = args.messageId;
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
/**
 * R6 — a durable SENDING slot is ambiguous ONLY once its lease
 * `attempt_started_at` is older than `staleAfterMs`. A FRESH SENDING
 * (overlapping poll while the network call is still in flight) is
 * NEVER reconciled — reconcile neither corrupts it nor projects it
 * for a second send. A SENDING slot with a missing/malformed
 * `attempt_started_at` is unrecoverably ambiguous →
 * UNKNOWN_SIDE_EFFECT (`stale_sending_missing_started_at`).
 */
export function reconcileStaleDeliveryAttempts(
  store: PairEvidenceStore,
  now: string,
  staleAfterMs: number = TELEGRAM_DELIVERY_DEFAULT_STALE_AFTER_MS,
): void {
  const nowMs = Date.parse(now);
  for (const req of store.list(TELEGRAM_DELIVERY_REQUEST)) {
    if (req.status !== "QUEUED") continue;
    let dirty = false;
    const next = { ...req } as Record<string, unknown>;
    for (const { slot, apply } of slots(req, next)) {
      if (slot.state !== "SENDING") {
        apply();
        continue;
      }
      const startedMs = Date.parse(String(slot.attempt_started_at ?? ""));
      if (!Number.isFinite(startedMs)) {
        dirty = true;
        slot.state = "UNKNOWN_SIDE_EFFECT";
        delete slot.attempt_id;
        delete slot.attempt_number;
        delete slot.attempt_started_at;
        slot.unknown_reason = "stale_sending_missing_started_at";
      } else if (nowMs - startedMs >= staleAfterMs) {
        dirty = true;
        slot.state = "UNKNOWN_SIDE_EFFECT";
        delete slot.attempt_id;
        delete slot.attempt_number;
        delete slot.attempt_started_at;
        slot.unknown_reason = `stale_sending_reconciled:${now}`;
      }
      // else: fresh SENDING — legitimately in flight, leave untouched.
      apply();
    }
    if (dirty) {
      // R5 §3 — stale reconciliation must recompute the canonical
      // request aggregate (a single stale payload → UNKNOWN_SIDE_EFFECT,
      // never dead QUEUED).
      next.status = recomputeStatus(req, next);
      putReq(store, next);
    }
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
  staleAfterMs: number = TELEGRAM_DELIVERY_DEFAULT_STALE_AFTER_MS,
): Array<Record<string, unknown>> {
  const ts = now ?? new Date().toISOString();
  reconcileStaleDeliveryAttempts(store, ts, staleAfterMs);
  const out: Array<Record<string, unknown>> = [];
  for (const req of store.list(TELEGRAM_DELIVERY_REQUEST)) {
    // R3 — bounded snapshot retention: a pinned snapshot is transport
    // staging only while its slot's fate is open (QUEUED retry,
    // in-flight SENDING, UNKNOWN_SIDE_EFFECT investigation — the bytes
    // are the evidence of what may/must still ship). Once a slot lands
    // SENT/FAILED_DELIVERY, or the whole request lands terminal
    // (SENT/FAILED_DELIVERY/UNSENDABLE), the durable identity evidence
    // is the slot's sha256 itself and the staged bytes are removed on
    // this projection pass — no unbounded hidden-file accumulation.
    pruneDeliverySnapshots(req);
    if (String(req.status) !== "QUEUED") continue;
    if (req.mode === "TEXT") {
      const probe = { ...req } as Record<string, unknown>;
      const [s] = slots(req, probe);
      if (!eligible(s.slot, ts)) continue;
      // R2.1 — a TEXT payload has send authority ONLY when its canonical
      // payload evidence is complete AND internally consistent with the
      // exact persisted text. A persisted pre-contract request (e.g.
      // text:"DONE", no bound evidence) has no provable payload source:
      // it converges to a durable terminal failure — never migrated,
      // never re-baselined from the workspace, zero network calls.
      const text = req.text;
      const evidenceOk =
        typeof text === "string" &&
        text.length > 0 &&
        typeof req.text_sha256 === "string" &&
        SHA256_HEX_RE.test(req.text_sha256) &&
        req.text_sha256 === digest(text) &&
        Number(req.text_length) === text.length &&
        String(req.text_source_artifact) === DELIVERY_TEXT_ARTIFACT;
      if (!evidenceOk) {
        probe.text_state = "FAILED_DELIVERY";
        probe.last_error = "FAIL_CLOSED_TELEGRAM_TEXT_PAYLOAD_EVIDENCE";
        probe.completed_at = ts;
        probe.status = recomputeStatus(req, probe);
        putReq(store, probe);
        continue;
      }
      out.push(probe);
      continue;
    }
    // R5 §6 — an eligible-but-unresolvable manifested artifact (no exact
    // file, no unique remote-upload match, no workspace-staged copy)
    // converges deterministically to a durable terminal failure — never
    // polled forever, never a network call burned on a nonexistent file.
    const next = { ...req } as Record<string, unknown>;
    let dirty = false;
    const projected: Array<Record<string, unknown>> = [];
    for (const a of (next.artifacts as DeliverySlot[])) {
      if (a.state !== "QUEUED" || a.attempt_count >= a.max_attempts) continue;
      // R1.2 — a hashless FILES slot has NO send authority: a persisted
      // request minted before digest authority was mandatory converges
      // to deterministic terminal failure — never verified, never sent.
      if (typeof a.sha256 !== "string" || !SHA256_HEX_RE.test(a.sha256)) {
        a.state = "FAILED_DELIVERY";
        a.last_error = "FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST";
        a.completed_at = ts;
        dirty = true;
        continue;
      }
      // R4.1 — snapshot-first authority: the immutable identity is the
      // TDR slot sha256; the pinned snapshot is its retained byte
      // realization. A VALID snapshot (sha256 == slot digest) is
      // already the canonical transport authority — reuse it; the
      // mutable producer/workspace file is NOT required to still exist
      // and is never re-read while a valid snapshot stands (source
      // drift/deletion after a failed attempt cannot kill the retry).
      const snapDir = path.join(String(req.outbox_dir), DELIVERY_SNAPSHOT_DIR);
      const snapPath = deliverySnapshotPath(
        String(req.outbox_dir),
        String(req.delivery_id),
        String(a.name),
      );
      // R5.1 — stat-first: an oversized retained snapshot is rejected
      // by the bound before any full-file read; a size-valid snapshot
      // is verified over its own materialized bytes.
      let snapshotValid = false;
      {
        const sr = boundedFileSha256(snapPath, MAX_TELEGRAM_FILE_BYTES);
        snapshotValid = sr.kind === "ok" && sr.sha256 === a.sha256;
      }
      if (!snapshotValid) {
        // A mismatched snapshot is never trusted — replace it only from
        // the canonical source: source must exist AND its sha256 must
        // equal the slot digest (reconstruction is a fallback, not a
        // re-baseline). Drop this delivery's own stale staging tmp from
        // any crashed attempt first (R4.3).
        try {
          fs.rmSync(`${snapPath}.tmp`, { force: true });
        } catch {
          /* best effort */
        }
        // F4.3 — the ONE canonical byte source is the CAS object path
        // stamped at mint (the bytes the delivery-contract gate verified
        // live there). The shared outbox is staging/transport, NEVER
        // authority: a stale same-name file cannot be selected, cannot
        // shadow the canonical artifact, and is never opened.
        const p =
          typeof a.source_path === "string" && a.source_path.length
            ? a.source_path
            : null;
        if (!p) {
          a.state = "FAILED_DELIVERY";
          a.last_error = "FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED";
          a.completed_at = ts;
          dirty = true;
          continue;
        }
        // R5.2 — canonical stat-first source authority: ONE bounded
        // read resolves the file, proves actual length == stat size,
        // and hashes THOSE bytes — the same materialized buffer is then
        // staged into the snapshot (never a second source read).
        // Oversized → durable TOO_LARGE with zero full-file read.
        const br = boundedFileSha256(p, MAX_TELEGRAM_FILE_BYTES);
        if (br.kind === "unresolved") {
          a.state = "FAILED_DELIVERY";
          a.last_error = "FAIL_CLOSED_TELEGRAM_ARTIFACT_UNRESOLVED";
          a.completed_at = ts;
          dirty = true;
          continue;
        }
        if (br.kind === "too_large") {
          a.state = "FAILED_DELIVERY";
          a.last_error = "FAIL_CLOSED_TELEGRAM_ARTIFACT_TOO_LARGE";
          a.completed_at = ts;
          dirty = true;
          continue;
        }
        // Canonical artifact identity replayed at send time: a
        // manifested artifact mutated between mint and dispatch never
        // reaches the bridge — durable terminal failure, zero network
        // call burned.
        if (br.sha256 !== a.sha256) {
          a.state = "FAILED_DELIVERY";
          a.last_error = "FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST";
          a.completed_at = ts;
          dirty = true;
          continue;
        }
        // R2.3 — pin the verified bytes: the wire artifact must be the
        // exact digest-authorized content, not whatever the workspace
        // path holds at send time (TOCTOU between projection and send).
        // Write the verified bytes into the request-owned snapshot and
        // project THAT path. R3 — durability: the staged file data is
        // fsynced before the atomic rename so a crash cannot leave a
        // half-written snapshot masquerading as the authorized bytes.
        try {
          fs.mkdirSync(snapDir, { recursive: true });
          const tmp = `${snapPath}.tmp`;
          const fd = fs.openSync(tmp, "w");
          try {
            fs.writeSync(fd, br.bytes);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.renameSync(tmp, snapPath);
          const post = boundedFileSha256(snapPath, MAX_TELEGRAM_FILE_BYTES);
          if (post.kind !== "ok" || post.sha256 !== a.sha256) {
            throw new Error("snapshot_digest_mismatch");
          }
        } catch {
          a.state = "FAILED_DELIVERY";
          a.last_error = "FAIL_CLOSED_TELEGRAM_ARTIFACT_DIGEST";
          a.completed_at = ts;
          dirty = true;
          continue;
        }
      }
      if (a.next_retry_at && a.next_retry_at > ts) continue; // backoff
      projected.push({
        name: a.name,
        state: a.state,
        attempt_count: a.attempt_count,
        max_attempts: a.max_attempts,
        next_retry_at: a.next_retry_at,
        path: snapPath,
        sha256: a.sha256,
      });
    }
    if (dirty) {
      next.status = recomputeStatus(req, next);
      putReq(store, next);
    }
    if (!projected.length) continue;
    out.push({ ...next, artifacts: projected });
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
