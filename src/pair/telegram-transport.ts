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
 *    last_error (bounded retry on later polls); ambiguous (thrown or
 *    unknown acceptance) → UNKNOWN_SIDE_EFFECT — never auto-resend,
 *    never claimed SENT.
 *  - file content reading (.txt/.md sent as message text; everything
 *    else as document upload) lives here so the bridge and tests share
 *    the exact same decision.
 */

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

/** Durable-state surface — backed by the evidence store in-process or
 *  by the Mission Control HTTP transition endpoint in the bridge. */
export interface DeliveryBackend {
  begin(artifact: string | null): Promise<void> | void;
  sent(artifact: string | null, evidence: { message_id?: string | number | null }): Promise<void> | void;
  failed(artifact: string | null, error: string): Promise<void> | void;
  unknown(artifact: string | null, error: string): Promise<void> | void;
  unsendable(reason: string): Promise<void> | void;
}

const TEXT_FILE_EXT = new Set([".txt", ".md"]);

function extname(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
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
  /** Reads artifact file content for .txt/.md message payloads. */
  readText?: (absPath: string) => string;
  /** Payload prefix — keeps the bridge's 📨 convention in one place. */
  textPrefix?: string;
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
      await args.backend.sent(artifact, { message_id: r.message_id ?? null });
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
      return await args.transport.send({ chatId, ...a });
    } catch (e) {
      // A thrown transport error means acceptance is unknown — the send
      // may have landed. UNKNOWN_SIDE_EFFECT, never false SENT and
      // never blind resend.
      return { kind: "unknown", error: String(e).slice(0, 300) };
    }
  };

  if (String(req.mode) === "TEXT") {
    const text = `${prefix}${String(req.text ?? "")}`.trim();
    if (text.length <= prefix.trim().length) return { sent, held: false };
    await args.backend.begin(null);
    const r = await send({ text: `${prefix}${String(req.text ?? "").slice(0, 3700)}` });
    if (await resolve(null, r)) sent.push(`TEXT:${String(req.delivery_id)}`);
    return { sent, held: false };
  }

  for (const art of (req.artifacts as Array<Record<string, unknown>>) ?? []) {
    if (String(art.state) !== "QUEUED" || !art.path) continue;
    const name = String(art.name);
    const fp = String(art.path);
    await args.backend.begin(name);
    let r: GovernedSendResult;
    if (TEXT_FILE_EXT.has(extname(name)) && args.readText) {
      const content = args.readText(fp).trim();
      r = content
        ? await send({
            text: `${prefix}${name}:\n\n${content.slice(0, 3600)}`,
            name,
          })
        : { kind: "fail", error: "artifact empty" };
    } else {
      r = await send({ filePath: fp, name });
    }
    if (await resolve(name, r)) sent.push(name);
  }
  return { sent, held: false };
}
