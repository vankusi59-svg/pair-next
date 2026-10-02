/**
 * telegram-transport.ts — governed Telegram delivery transport (R3).
 *
 * The single real transport implementation used by the production
 * bridge AND tests: injectable Telegram sender + durable-state backend,
 * so transport semantics (destination binding, SENDING/SENT/UNKNOWN
 * lifecycle, failure semantics) are unit-testable without a mock
 * reimplementation of the send loop.
 *
 * Semantics:
 *  - destination: exactly the request's canonically bound chat_id —
 *    never fan-out over the allowlist. Allowlist is an authorization
 *    check: destination not allowed → durable UNSENDABLE hold, zero
 *    sends, no broadcast fallback.
 *  - per artifact / per TEXT payload: QUEUED → SENDING (persisted
 *    BEFORE the network call) → SENT on definite success with
 *    message_id evidence; definite failure → back to QUEUED with
 *    attempt_count+1 and bounded next_retry_at backoff (terminal
 *    FAILED_DELIVERY past the ceiling); ambiguous (thrown, unknown
 *    acceptance, or `ok` WITHOUT message_id) → UNKNOWN_SIDE_EFFECT —
 *    never auto-resend, never claimed SENT (R4 §2).
 *  - FILES means ARTIFACT transport (R2.3): every manifested artifact —
 *    including .txt/.md — is sent as the digest-pinned file (document/
 *    photo upload), never re-read, trimmed, truncated, or converted to
 *    message text. The path projected by pendingTelegramDeliveries is
 *    a request-owned snapshot of the digest-verified bytes; this module
 *    re-verifies that exact path's digest immediately before claiming
 *    the attempt, so the bytes entering the network call are provably
 *    the bytes whose sha256 was authorized (no TOCTOU, no transform).
 */

import { digest, sha256File } from "./canonical.js";
import { SHA256_HEX_RE } from "./telegram-delivery.js";

export type GovernedSendResult =
  | { kind: "ok"; message_id?: string | number }
  | { kind: "fail"; error: string }
  | { kind: "unknown"; error: string };

/** The ONLY network surface a governed delivery may touch. Implementations
 *  must map outcomes honestly: HTTP/API-reported failure → "fail";
 *  thrown network/timeout/parse ambiguity → "unknown". */
export interface GovernedTelegramTransport {
  send(args: {
    chatId: string;
    text?: string;
    filePath?: string;
    name?: string;
  }): Promise<GovernedSendResult>;
}

/** R7 — exclusive claim outcome: the ONLY positive acquisition
 *  evidence a transport actor may act on. `attempt_id` identifies the
 *  attempt; it is never ownership permission by itself. */
export interface BeginDeliveryAcquire {
  acquired: boolean;
  attempt_id?: string;
  reason?: string;
}

/** Durable-state surface — backed by the evidence store in-process or
 *  by the Mission Control HTTP transition endpoint in the bridge. */
export interface DeliveryBackend {
  /** Exclusive acquire: QUEUED→SENDING. MUST return {acquired:true} only
   *  when THIS call performed the transition — anything else means the
   *  payload is already claimed and ZERO network calls may follow. */
  begin(artifact: string | null): Promise<BeginDeliveryAcquire> | BeginDeliveryAcquire;
  sent(artifact: string | null, evidence: { message_id?: string | number | null }): Promise<void> | void;
  failed(artifact: string | null, error: string): Promise<void> | void;
  unknown(artifact: string | null, error: string): Promise<void> | void;
  unsendable(reason: string): Promise<void> | void;
}


/** R6 §6 — defense-in-depth process-local non-overlap guard: a trigger
 *  firing while the previous cycle is still running is skipped. The
 *  canonical correctness mechanism remains the durable SENDING lease —
 *  this only prevents two bridge poll cycles from racing inside one
 *  process. */
export function makeNonReentrant(
  fn: () => Promise<unknown> | unknown,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

/**
 * Transport ONE canonical delivery request end to end. `request` is a
 * pendingTelegramDeliveries projection (QUEUED artifacts carry resolved
 * absolute paths). Returns the artifact names that reached SENT this
 * pass — for logging/tests; durable state lives in the backend.
 */
export async function transportTelegramDelivery(args: {
  request: Record<string, unknown>;
  transport: GovernedTelegramTransport;
  /** Authorization check on the bound destination (allowlist semantics). */
  isAllowed: (chatId: string) => boolean;
  backend: DeliveryBackend;
  /** Deprecated (R2.3): FILES artifacts are always transported as
   *  files — no caller-side text conversion is consulted. */
  readText?: (absPath: string) => string;
  /** Payload prefix — keeps the bridge's 📨 convention in one place. */
  textPrefix?: string;
  /** R6 §4/§7 — canonical bounded transport timeout: a send still
   *  in-flight past this is classified UNKNOWN (acceptance ambiguous),
   *  never definite failure, never silent success. */
  timeoutMs?: number;
}): Promise<{ sent: string[]; held: boolean }> {
  const req = args.request;
  const dest = (
    req.destination as { provider?: string; chat_id?: string } | null | undefined
  )?.chat_id;
  const prefix = args.textPrefix ?? "📨 ";

  // R3 §3+§4 — exactly the bound destination; never broadcast. A
  // missing/unresolvable or no-longer-allowed destination holds the
  // request durably with zero sends.
  if (!dest) {
    await args.backend.unsendable("FAIL_CLOSED_TELEGRAM_DESTINATION_UNRESOLVED");
    return { sent: [], held: true };
  }
  if (!args.isAllowed(String(dest))) {
    await args.backend.unsendable(
      `FAIL_CLOSED_TELEGRAM_DESTINATION_NOT_ALLOWED:${String(dest)}`,
    );
    return { sent: [], held: true };
  }

  const sent: string[] = [];
  const chatId = String(dest);

  const resolve = async (
    artifact: string | null,
    r: GovernedSendResult,
  ): Promise<boolean> => {
    if (r.kind === "ok") {
      // R4 §2 — definite success REQUIRES real acceptance evidence. A
      // transport `ok` without message_id is ambiguous: classify
      // UNKNOWN_SIDE_EFFECT, never SENT.
      const mid = r.message_id;
      // R5 §4 — Telegram `message_id` is an Integer; only a positive
      // safe integer is canonical acceptance evidence. "MID_fake",
      // "123", 0, -1, 1.5, NaN → UNKNOWN, never SENT.
      const valid =
        typeof mid === "number" && Number.isSafeInteger(mid) && mid > 0;
      if (!valid) {
        await args.backend.unknown(artifact, "acceptance_unproven:no message_id");
        return false;
      }
      await args.backend.sent(artifact, { message_id: mid });
      return true;
    }
    if (r.kind === "fail") {
      await args.backend.failed(artifact, r.error);
      return false;
    }
    await args.backend.unknown(artifact, r.error);
    return false;
  };

  const send = async (a: {
    text?: string;
    filePath?: string;
    name?: string;
  }): Promise<GovernedSendResult> => {
    try {
      const p = args.transport.send({ chatId, ...a });
      const tmo = args.timeoutMs;
      if (Number.isFinite(tmo) && (tmo as number) > 0) {
        // R6 §7 — bounded transport timeout: a call that outlives the
        // canonical deadline is UNKNOWN_SIDE_EFFECT (Telegram may have
        // accepted), never a definite failure and never a blind retry.
        const r = await Promise.race<GovernedSendResult | { timeout: true }>([
          p,
          new Promise<{ timeout: true }>((res) =>
            setTimeout(() => res({ timeout: true }), tmo),
          ),
        ]);
        if ("timeout" in r) {
          return { kind: "unknown", error: `transport_timeout:${tmo}ms` };
        }
        return r;
      }
      return await p;
    } catch (e) {
      // A thrown transport error means acceptance is unknown — the send
      // may have landed. UNKNOWN_SIDE_EFFECT, never false SENT and
      // never blind resend.
      return { kind: "unknown", error: String(e).slice(0, 300) };
    }
  };

  if (String(req.mode) === "TEXT") {
    // R4 §1 — TEXT carries the same durable slot state as FILES; only a
    // canonically eligible QUEUED text payload may begin.
    if (String(req.text_state) !== "QUEUED") return { sent, held: false };
    // R2.1 — re-prove payload evidence at the transport edge: the exact
    // text that will be sent must still hash/length/source-match the
    // bound evidence. Anything else never reaches begin or the network.
    const body = String(req.text ?? "");
    const wantSha = String(req.text_sha256 ?? "");
    let actualSha: string | null = null;
    try {
      actualSha = digest(body);
    } catch {
      actualSha = null;
    }
    if (
      !body.length ||
      !SHA256_HEX_RE.test(wantSha) ||
      actualSha !== wantSha ||
      Number(req.text_length) !== body.length
    ) {
      return { sent, held: false };
    }
    const text = `${prefix}${body}`.trim();
    if (text.length <= prefix.trim().length) return { sent, held: false };
    // R7 — exclusive acquire required before any network call. A stale
    // projection is not authority: if the durable begin did not grant
    // this caller the attempt, the send must not happen.
    const acq = await args.backend.begin(null);
    if (!acq || acq.acquired !== true) return { sent, held: false };
    const r = await send({ text: `${prefix}${body.slice(0, 3700)}` });
    if (await resolve(null, r)) sent.push(`TEXT:${String(req.delivery_id)}`);
    return { sent, held: false };
  }

  for (const art of (req.artifacts as Array<Record<string, unknown>>) ?? []) {
    if (String(art.state) !== "QUEUED" || !art.path) continue;
    const name = String(art.name);
    const fp = String(art.path);
    // R2.3 — the slot's authorized sha256 must still match the pinned
    // path bytes BEFORE any attempt is claimed: a diverging/tampered
    // snapshot never reaches begin or the network (the next projection
    // re-verifies the source and converges the slot deterministically).
    const wantSha = String(art.sha256 ?? "");
    let actualSha: string | null = null;
    try {
      actualSha = sha256File(fp);
    } catch {
      actualSha = null;
    }
    if (!SHA256_HEX_RE.test(wantSha) || actualSha !== wantSha) continue;
    // R7 — exclusive acquire required before any network call.
    const acq = await args.backend.begin(name);
    if (!acq || acq.acquired !== true) continue;
    // FILES = artifact transport: the digest-pinned file itself, never
    // a trimmed/truncated text conversion (R2.3).
    const r = await send({ filePath: fp, name });
    if (await resolve(name, r)) sent.push(name);
  }
  return { sent, held: false };
}
