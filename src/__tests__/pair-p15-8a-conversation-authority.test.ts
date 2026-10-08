/**
 * P15.8-A Conversation Authority — adversarial matrix.
 *
 * Proves the mandate §8 boundaries:
 *  - durable session/message persistence + canonical digest/self-verify
 *  - deterministic seq ordering under concurrent writers + CAS
 *  - idempotent append (deterministic id, replay vs conflict)
 *  - owner-only authority (foreign operator fails closed everywhere)
 *  - fail-closed input validation + bounded pagination
 *  - ZERO mission authority: chat content (incl. task-like and affirmative
 *    text) mints no missions, executor dispatch, telegram deliveries,
 *    budget spend or objective mutations
 *  - restart/replay preserves all boundaries
 *  - operational error evidence stays code-only; audit events never carry
 *    message text; store-level secret policy still applies
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MAX_BODY_CHARS,
  CONVERSATION_MAX_IDEMPOTENCY_KEY_CHARS,
  CONVERSATION_MAX_MESSAGES_PER_SESSION,
  CONVERSATION_MAX_PAGE_SIZE,
  CONVERSATION_MAX_SESSIONS_PER_OWNER,
  CONVERSATION_MAX_TITLE_CHARS,
  CONVERSATION_MESSAGE_ENTITY,
  CONVERSATION_MESSAGE_SCHEMA,
  CONVERSATION_SESSION_ENTITY,
  CONVERSATION_SESSION_SCHEMA,
  ConversationSessionService,
  PairError,
  PairEvidenceStore,
  conversationMessageIdFor,
  conversationSessionIdFor,
  digest,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p158a-"));
let counter = 0;
const OWNER = "operator:owner-1";
const OTHER = "operator:owner-2";
const CORR_OK = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

type Ctx = { dir: string; dbPath: string; store: PairEvidenceStore; conv: ConversationSessionService };

function fresh(name: string): Ctx {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  return { dir, dbPath, store, conv: new ConversationSessionService(store) };
}

function reopen(ctx: Ctx): Ctx {
  const store = new PairEvidenceStore(ctx.dbPath);
  return { ...ctx, store, conv: new ConversationSessionService(store) };
}

function err(fn: () => unknown): PairError {
  try {
    fn();
  } catch (e) {
    if (e instanceof PairError) return e;
    throw e;
  }
  throw new Error("expected PairError");
}

function code(fn: () => unknown): string {
  return err(fn).code;
}

function dbOf(store: PairEvidenceStore) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}

function sqlRewriteEntity(
  store: PairEvidenceStore,
  entityType: string,
  entityId: string,
  fn: (body: Record<string, unknown>) => void,
): void {
  const row = dbOf(store)
    .prepare("SELECT payload FROM entities WHERE entity_type=? AND entity_id=?")
    .get(entityType, entityId) as { payload: string } | undefined;
  if (!row) throw new Error(`entity ${entityType}:${entityId} absent`);
  const body = JSON.parse(row.payload) as Record<string, unknown>;
  fn(body);
  dbOf(store)
    .prepare("UPDATE entities SET payload=?, payload_hash=? WHERE entity_type=? AND entity_id=?")
    .run(JSON.stringify(body), digest(body), entityType, entityId);
}

/** Every non-conversation entity type in the store — the zero-authority
 *  proof surface. */
function governedEntities(store: PairEvidenceStore): Array<Record<string, unknown>> {
  return dbOf(store)
    .prepare("SELECT entity_type, entity_id FROM entities WHERE entity_type NOT IN (?, ?)")
    .all(CONVERSATION_SESSION_ENTITY, CONVERSATION_MESSAGE_ENTITY) as Array<Record<string, unknown>>;
}

function governedEvents(store: PairEvidenceStore): Array<Record<string, unknown>> {
  return dbOf(store)
    .prepare("SELECT * FROM events WHERE entity_type NOT IN (?, ?)")
    .all(CONVERSATION_SESSION_ENTITY, CONVERSATION_MESSAGE_ENTITY) as Array<Record<string, unknown>>;
}

describe("P15.8-A conversation authority", () => {
  /* ---------------- persistence + canonical identity ---------------- */

  it("create persists across process restart with canonical fields", () => {
    const ctx = fresh("restart");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER, title: "demo" });
    expect(s.session_id.startsWith("CSESS_")).toBe(true);
    expect(s.entry_mode).toBe("CONVERSATION");
    expect(s.state).toBe("OPEN");
    expect(s.message_count).toBe(0);
    expect(s.next_seq).toBe(1);

    const ctx2 = reopen(ctx);
    const reread = ctx2.conv.getSession(s.session_id, OWNER);
    expect(reread).toEqual(s);
  });

  it("client_request_id converges duplicate creates onto one row", () => {
    const ctx = fresh("dedup");
    const a = ctx.conv.createSession({ owner_operator_id: OWNER, client_request_id: "req-1" });
    const b = ctx.conv.createSession({ owner_operator_id: OWNER, client_request_id: "req-1" });
    expect(a.session_id).toBe(b.session_id);
    expect(a.session_id).toBe(conversationSessionIdFor(OWNER, "req-1"));
    expect(ctx.conv.listSessions({ operator_id: OWNER })).toHaveLength(1);
    // Same request id under a DIFFERENT owner is a different session —
    // dedup is scoped to the owner.
    const c = ctx.conv.createSession({ owner_operator_id: OTHER, client_request_id: "req-1" });
    expect(c.session_id).not.toBe(a.session_id);
  });

  it("session tamper fails on session digest (independent proof)", () => {
    const ctx = fresh("tamper-session");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    sqlRewriteEntity(ctx.store, CONVERSATION_SESSION_ENTITY, s.session_id, (b) => {
      b.owner_operator_id = OTHER;
    });
    // Fails on the SESSION digest — the field carries a different owner
    // than the digest pins, before any ownership check can even run.
    expect(code(() => ctx.conv.getSession(s.session_id, OWNER))).toBe(
      "FAIL_CLOSED_CONVERSATION_DIGEST",
    );
    // Restore the ORIGINAL terms — recompute then matches again.
    sqlRewriteEntity(ctx.store, CONVERSATION_SESSION_ENTITY, s.session_id, (b) => {
      b.owner_operator_id = OWNER;
    });
    expect(ctx.conv.getSession(s.session_id, OWNER).owner_operator_id).toBe(OWNER);
  });

  it("message tamper fails on message digest (independent proof)", () => {
    const ctx = fresh("tamper-message");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const m = ctx.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, role: "operator", body: "hello",
    });
    sqlRewriteEntity(ctx.store, CONVERSATION_MESSAGE_ENTITY, m.message_id, (b) => {
      b.body = "rewritten";
    });
    // Session itself is still canonical — reads fine.
    expect(ctx.conv.getSession(s.session_id, OWNER).session_id).toBe(s.session_id);
    // The MESSAGE digest is what catches the rewrite.
    expect(code(() =>
      ctx.conv.listMessages(s.session_id, { operator_id: OWNER })
    )).toBe("FAIL_CLOSED_CONVERSATION_DIGEST");
    // Restore the original body — read passes again.
    sqlRewriteEntity(ctx.store, CONVERSATION_MESSAGE_ENTITY, m.message_id, (b) => {
      b.body = "hello";
    });
    expect(
      ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages[0]!.body,
    ).toBe("hello");
  });

  it("a row with a foreign schema cannot mint a canonical session", () => {
    const ctx = fresh("schema");
    ctx.store.put(CONVERSATION_SESSION_ENTITY, "CSESS_FORGED", {
      schema_version: "pair.fake.v1",
      session_id: "CSESS_FORGED",
      owner_operator_id: OWNER,
      entry_mode: "CONVERSATION",
      state: "OPEN",
    });
    expect(code(() => ctx.conv.getSession("CSESS_FORGED", OWNER))).toBe(
      "FAIL_CLOSED_CONVERSATION_SCHEMA",
    );
  });

  /* ---------------- ordering + concurrency ---------------- */

  it("messages carry exact session membership and deterministic seq order", () => {
    const ctx = fresh("order");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OWNER, role: "operator", body: `m${i}`,
        }).message_id,
      );
    }
    const { messages } = ctx.conv.listMessages(s.session_id, { operator_id: OWNER });
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(messages.map((m) => m.session_id)).toEqual(ids.map(() => s.session_id));
    expect(messages.map((m) => m.message_id)).toEqual(ids);
    expect(ctx.conv.getSession(s.session_id, OWNER).message_count).toBe(5);
    expect(ctx.conv.getSession(s.session_id, OWNER).next_seq).toBe(6);
    // Ordering is by committed seq — never by wall clock.
    const seqs = messages.map((m) => m.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("concurrent writers on one store keep a gap-free seq", () => {
    const ctx = fresh("writers");
    const svcA = ctx.conv;
    const svcB = new ConversationSessionService(ctx.store);
    const writerB = svcB.internalWriter();
    const s = svcA.createSession({ owner_operator_id: OWNER });
    svcA.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "a1" });
    writerB.appendMessage({ session_id: s.session_id, role: "assistant", body: "b1" });
    svcA.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "a2" });
    writerB.appendMessage({ session_id: s.session_id, role: "assistant", body: "b2" });
    const { messages } = svcA.listMessages(s.session_id, { operator_id: OWNER });
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(messages.map((m) => m.body)).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("a second connection sees committed state and CAS rejects stale writes", () => {
    const ctx = fresh("cas");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const conv2 = new ConversationSessionService(store2);
    const seen = conv2.getSession(s.session_id, OWNER);
    expect(seen.state).toBe("OPEN");
    // Interleaved appends across connections stay gap-free.
    ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "one" });
    conv2.internalWriter().appendMessage({ session_id: s.session_id, role: "assistant", body: "two" });
    expect(
      ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages.map((m) => m.seq),
    ).toEqual([1, 2]);
    // A stale CAS write (captured version is now behind) conflicts — it
    // cannot clobber the newer committed counters.
    const stale = ctx.store.get(CONVERSATION_SESSION_ENTITY, s.session_id);
    expect(
      code(() =>
        ctx.store.put(CONVERSATION_SESSION_ENTITY, s.session_id, stale, 0)
      ),
    ).toBe("FAIL_CLOSED_VERSION_CONFLICT");
    store2.close();
  });

  /* ---------------- R1.A — raced-path equivalence ---------------- */

  /** Deterministic interleave: commit a full competing write between the
   *  service's pre-transaction check and its in-transaction re-check.
   *  The injector runs a REAL service call on the same store, so the raced
   *  row carries genuine counters/events — not a fabricated row. */
  function raceOnce(store: PairEvidenceStore, inject: () => void): void {
    const orig = store.immediate.bind(store);
    let armed = true;
    (store as unknown as { immediate: typeof orig }).immediate = <T>(fn: () => T): T => {
      if (armed) {
        armed = false;
        inject();
      }
      return orig(fn);
    };
  }

  it("raced identical append converges — stored row, no seq advance, no second event", () => {
    const ctx = fresh("race-append-same");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const input = {
      session_id: s.session_id, operator_id: OWNER, role: "operator" as const,
      body: "identical", idempotency_key: "race-k",
    };
    const other = new ConversationSessionService(ctx.store);
    raceOnce(ctx.store, () => other.appendMessage(input));
    const out = ctx.conv.appendMessage(input);
    // Converged onto the raced row — the retry minted nothing new.
    expect(ctx.conv.getSession(s.session_id, OWNER).message_count).toBe(1);
    expect(out.seq).toBe(1);
    const events = ctx.store
      .listEvents(CONVERSATION_SESSION_ENTITY, s.session_id)
      .filter((e) => e.event_type === "CONVERSATION_MESSAGE_APPENDED");
    expect(events).toHaveLength(1);
  });

  it("raced different append fails closed — IDEMPOTENCY_CONFLICT", () => {
    const ctx = fresh("race-append-diff");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const other = new ConversationSessionService(ctx.store);
    raceOnce(ctx.store, () =>
      other.appendMessage({
        session_id: s.session_id, operator_id: OWNER, role: "operator",
        body: "winner", idempotency_key: "race-k",
      }));
    expect(
      code(() =>
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OWNER, role: "operator",
          body: "loser", idempotency_key: "race-k",
        }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_IDEMPOTENCY_CONFLICT");
    // Loser minted nothing.
    expect(ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages).toHaveLength(1);
    expect(ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages[0]!.body).toBe("winner");
  });

  it("raced identical create converges; raced different create conflicts", () => {
    const ctx = fresh("race-create");
    const other = new ConversationSessionService(ctx.store);
    // Same owner + same request id + same title → converge.
    raceOnce(ctx.store, () =>
      other.createSession({ owner_operator_id: OWNER, client_request_id: "rc", title: "t" }));
    const a = ctx.conv.createSession({ owner_operator_id: OWNER, client_request_id: "rc", title: "t" });
    expect(ctx.conv.listSessions({ operator_id: OWNER })).toHaveLength(1);
    expect(a.session_id).toBe(conversationSessionIdFor(OWNER, "rc"));
    // Same request id + DIFFERENT title → conflict, not silent reuse.
    const ctx2 = fresh("race-create-diff");
    const other2 = new ConversationSessionService(ctx2.store);
    raceOnce(ctx2.store, () =>
      other2.createSession({ owner_operator_id: OWNER, client_request_id: "rc", title: "first" }));
    expect(
      code(() =>
        ctx2.conv.createSession({ owner_operator_id: OWNER, client_request_id: "rc", title: "second" }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_IDEMPOTENCY_CONFLICT");
  });

  it("same request id + different terms conflicts on the non-raced path too", () => {
    const ctx = fresh("create-diff");
    ctx.conv.createSession({ owner_operator_id: OWNER, client_request_id: "rc", title: "t1" });
    expect(
      code(() =>
        ctx.conv.createSession({ owner_operator_id: OWNER, client_request_id: "rc", title: "t2" }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_IDEMPOTENCY_CONFLICT");
    // Identical replay still converges.
    const again = ctx.conv.createSession({ owner_operator_id: OWNER, client_request_id: "rc", title: "t1" });
    expect(again.title).toBe("t1");
  });

  /* ---------------- R1.B — role provenance ---------------- */

  it("an operator cannot forge assistant or system messages", () => {
    const ctx = fresh("role-spoof");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    for (const role of ["assistant", "system", "user", "admin"]) {
      expect(
        code(() =>
          ctx.conv.appendMessage({
            session_id: s.session_id, operator_id: OWNER,
            role: role as never, body: "forged",
          }),
        ),
      ).toBe("FAIL_CLOSED_CONVERSATION_ROLE");
    }
    // Minted nothing.
    expect(ctx.conv.getSession(s.session_id, OWNER).message_count).toBe(0);
    // Operator writes still work — default and explicit.
    const a = ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, body: "hi" });
    const b = ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "hi2" });
    expect(a.role).toBe("operator");
    expect(b.role).toBe("operator");
  });

  it("internal writer mints assistant/system bound to the session owner", () => {
    const ctx = fresh("internal");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const w = ctx.conv.internalWriter();
    const a = w.appendMessage({ session_id: s.session_id, role: "assistant", body: "trả lời" });
    expect(a.role).toBe("assistant");
    expect(a.owner_operator_id).toBe(OWNER); // ownership = parent session owner
    const b = w.appendMessage({ session_id: s.session_id, role: "system", body: "note" });
    expect(b.role).toBe("system");
    // Internal writer cannot impersonate an operator.
    expect(
      code(() => w.appendMessage({ session_id: s.session_id, role: "operator" as never, body: "x" })),
    ).toBe("FAIL_CLOSED_CONVERSATION_ROLE");
    // Owner sees them on canonical reads; the audit actor is internal.
    const { messages } = ctx.conv.listMessages(s.session_id, { operator_id: OWNER });
    expect(messages.map((m) => m.role)).toEqual(["assistant", "system"]);
    const ev = ctx.store
      .listEvents(CONVERSATION_SESSION_ENTITY, s.session_id)
      .filter((e) => e.event_type === "CONVERSATION_MESSAGE_APPENDED");
    expect(ev.map((e) => e.actor)).toEqual(["conversation-internal", "conversation-internal"]);
  });

  it("internal writer is still owner-consistent and closed-session denied", () => {
    const ctx = fresh("internal-owner");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const w = ctx.conv.internalWriter();
    const a = w.appendMessage({ session_id: s.session_id, role: "assistant", body: "x" });
    // Foreign operator cannot read it — owner pinning holds.
    expect(code(() => ctx.conv.listMessages(s.session_id, { operator_id: OTHER }))).toBe(
      "FAIL_CLOSED_CONVERSATION_FORBIDDEN",
    );
    // And the internal writer cannot mint into a CLOSED session.
    ctx.conv.closeSession(s.session_id, { operator_id: OWNER });
    expect(
      code(() => w.appendMessage({ session_id: s.session_id, role: "assistant", body: "late" })),
    ).toBe("FAIL_CLOSED_CONVERSATION_CLOSED");
    expect(a.owner_operator_id).toBe(OWNER);
  });

  /* ---------------- R2.A — replay before new-write admission ---------------- */

  it("identical replay converges through a raced CLOSE — no CLOSED error", () => {
    const ctx = fresh("race-close");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const input = {
      session_id: s.session_id, operator_id: OWNER, role: "operator" as const,
      body: "committed", idempotency_key: "close-race",
    };
    const other = new ConversationSessionService(ctx.store);
    // Between our pre-check and our txn: the racing append commits AND the
    // session closes. Our write is a retry of committed state — converge.
    raceOnce(ctx.store, () => {
      other.appendMessage(input);
      other.closeSession(s.session_id, { operator_id: OWNER });
    });
    const out = ctx.conv.appendMessage(input);
    expect(out.seq).toBe(1);
    expect(ctx.conv.getSession(s.session_id, OWNER).message_count).toBe(1);
    expect(ctx.conv.getSession(s.session_id, OWNER).state).toBe("CLOSED");
    // One append event + one close event, never two appends.
    const ev = ctx.store
      .listEvents(CONVERSATION_SESSION_ENTITY, s.session_id)
      .filter((e) => e.event_type === "CONVERSATION_MESSAGE_APPENDED");
    expect(ev).toHaveLength(1);
    // And a NEW message (different key) still fails CLOSED.
    expect(
      code(() =>
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OWNER, role: "operator",
          body: "new", idempotency_key: "after-close",
        }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_CLOSED");
  });

  it("identical replay converges through a raced capacity fill — no LIMIT error", () => {
    const ctx = fresh("race-cap");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const input = {
      session_id: s.session_id, operator_id: OWNER, role: "operator" as const,
      body: "committed", idempotency_key: "cap-race",
    };
    const other = new ConversationSessionService(ctx.store);
    // Raced append commits, then the session row is coherently advanced to
    // the cap (digest rebuilt — the row is canonical, just full).
    raceOnce(ctx.store, () => {
      other.appendMessage(input);
      sqlRewriteEntity(ctx.store, CONVERSATION_SESSION_ENTITY, s.session_id, (b) => {
        b.message_count = CONVERSATION_MAX_MESSAGES_PER_SESSION;
        b.next_seq = CONVERSATION_MAX_MESSAGES_PER_SESSION + 1;
      });
    });
    const out = ctx.conv.appendMessage(input);
    expect(out.seq).toBe(1);
    // Still exactly one message row — the cap did not mint or reject the replay.
    expect(
      ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages,
    ).toHaveLength(1);
    // A genuinely new message hits the cap.
    expect(
      code(() =>
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OWNER, role: "operator",
          body: "overflow", idempotency_key: "cap-new",
        }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_LIMIT");
    // sqlRewriteEntity left the session digest stale — restore it so the
    // context teardown/store checks stay clean for other assertions.
    sqlRewriteEntity(ctx.store, CONVERSATION_SESSION_ENTITY, s.session_id, (b) => {
      b.message_count = 1;
      b.next_seq = 2;
    });
  });

  it("raced DIFFERENT-payload replay on a closed session still conflicts", () => {
    const ctx = fresh("race-close-diff");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const other = new ConversationSessionService(ctx.store);
    raceOnce(ctx.store, () => {
      other.appendMessage({
        session_id: s.session_id, operator_id: OWNER, role: "operator",
        body: "winner", idempotency_key: "k",
      });
      other.closeSession(s.session_id, { operator_id: OWNER });
    });
    expect(
      code(() =>
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OWNER, role: "operator",
          body: "loser", idempotency_key: "k",
        }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_IDEMPOTENCY_CONFLICT");
  });

  /* ---------------- R2.B — membership / owner consistency ---------------- */

  it("a persisted row with mismatched owner fails closed on history reads", () => {
    const ctx = fresh("owner-mismatch");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const mid = conversationMessageIdFor(s.session_id, "planted");
    // Plant a row that is INTERNALLY consistent — valid schema, valid
    // recomputed digest over its own (wrong) fields, store hash coherent.
    const body = {
      schema_version: CONVERSATION_MESSAGE_SCHEMA,
      message_id: mid,
      session_id: s.session_id,
      owner_operator_id: OTHER, // planted foreign owner
      seq: 1,
      role: "operator",
      body: "injected",
      idempotency_key: "planted",
      created_at: new Date().toISOString(),
    };
    (body as Record<string, unknown>).message_digest = digest({
      contract: "pair-conversation-message.v1",
      message_id: mid,
      session_id: s.session_id,
      owner_operator_id: OTHER,
      seq: 1,
      role: "operator",
      body: "injected",
      idempotency_key: "planted",
    });
    ctx.store.put(CONVERSATION_MESSAGE_ENTITY, mid, body);
    // History read must not return it — and must fail closed, not skip it.
    expect(
      code(() => ctx.conv.listMessages(s.session_id, { operator_id: OWNER })),
    ).toBe("FAIL_CLOSED_CONVERSATION_INTEGRITY");
    // Replay of the same deterministic id also fails as integrity, not
    // as a converged row.
    expect(
      code(() =>
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OWNER, role: "operator",
          body: "injected", idempotency_key: "planted",
        }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_INTEGRITY");
  });

  it("a persisted row claiming a different session fails closed via replay", () => {
    const ctx = fresh("session-mismatch");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const other = ctx.conv.createSession({ owner_operator_id: OWNER });
    const mid = conversationMessageIdFor(s.session_id, "crossed");
    // Row's entity key says session s; its payload claims `other` session.
    const rowBody = {
      schema_version: CONVERSATION_MESSAGE_SCHEMA,
      message_id: mid,
      session_id: other.session_id, // mismatched membership
      owner_operator_id: OWNER,
      seq: 1,
      role: "operator",
      body: "cross-session",
      idempotency_key: "crossed",
      created_at: new Date().toISOString(),
    };
    (rowBody as Record<string, unknown>).message_digest = digest({
      contract: "pair-conversation-message.v1",
      message_id: mid,
      session_id: other.session_id,
      owner_operator_id: OWNER,
      seq: 1,
      role: "operator",
      body: "cross-session",
      idempotency_key: "crossed",
    });
    ctx.store.put(CONVERSATION_MESSAGE_ENTITY, mid, rowBody);
    // Replay against session s hits the membership check.
    expect(
      code(() =>
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OWNER, role: "operator",
          body: "cross-session", idempotency_key: "crossed",
        }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_INTEGRITY");
    // listMessages(s) never sees it — the filter keys off session_id.
    expect(
      ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages,
    ).toHaveLength(0);
    // R3.A: the session it CLAIMS (`other`) must reject it — the payload's
    // id was minted for session s, violating canonical message identity.
    expect(
      code(() => ctx.conv.listMessages(other.session_id, { operator_id: OWNER })),
    ).toBe("FAIL_CLOSED_CONVERSATION_INTEGRITY");
  });

  it("a row planted under a foreign entity key fails entity/payload binding", () => {
    const ctx = fresh("entity-key-split");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const legit = conversationMessageIdFor(s.session_id, "k-legit");
    // Row at entity key `legit` but payload claims a different message_id.
    const rowBody = {
      schema_version: CONVERSATION_MESSAGE_SCHEMA,
      message_id: "MSG_PLANTED-FOREIGN-KEY",
      session_id: s.session_id,
      owner_operator_id: OWNER,
      seq: 1,
      role: "operator",
      body: "ghost",
      idempotency_key: null,
      created_at: new Date().toISOString(),
    };
    (rowBody as Record<string, unknown>).message_digest = digest({
      contract: "pair-conversation-message.v1",
      message_id: "MSG_PLANTED-FOREIGN-KEY",
      session_id: s.session_id,
      owner_operator_id: OWNER,
      seq: 1,
      role: "operator",
      body: "ghost",
      idempotency_key: null,
    });
    ctx.store.put(CONVERSATION_MESSAGE_ENTITY, legit, rowBody);
    expect(
      code(() => ctx.conv.listMessages(s.session_id, { operator_id: OWNER })),
    ).toBe("FAIL_CLOSED_CONVERSATION_INTEGRITY");
  });

  /* ---------------- R4.A — derived correlation ids ---------------- */

  it("correlation_id is server-derived — raw caller text never reaches events", () => {
    const ctx = fresh("corr");
    const secretShapes = [
      `bcap1.${"a".repeat(32)}.${"b".repeat(32)}`,
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456",
      "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
      "Authorization: Bearer tok_live_9x",
      "gửi báo cáo lên telegram ngay",
    ];
    // Every shape flows through — but what persists is `corr_<sha256>`,
    // and the raw text is absent from the whole events table.
    const s = ctx.conv.createSession({ owner_operator_id: OWNER, correlation_id: secretShapes[0] });
    ctx.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, body: "m1",
      correlation_id: secretShapes[1],
    });
    ctx.conv.internalWriter().appendMessage({
      session_id: s.session_id, role: "assistant", body: "m2",
      correlation_id: secretShapes[2],
    });
    ctx.conv.closeSession(s.session_id, { operator_id: OWNER, correlation_id: secretShapes[3] });
    const events = ctx.store.listEvents(CONVERSATION_SESSION_ENTITY, s.session_id);
    expect(events).toHaveLength(4); // created + 2 appends + closed
    for (const e of events) {
      expect(String(e.correlation_id)).toMatch(/^corr_[0-9a-f]{64}$/);
    }
    // Raw caller text is nowhere — not in correlation_id, not anywhere in
    // the serialized event row.
    const dumped = JSON.stringify(events);
    for (const raw of secretShapes) {
      expect(dumped).not.toContain(raw);
    }
    // Correlation still works: identical inputs mint the SAME derived id
    // (deterministic — a retried request correlates to its own events),
    // different inputs mint different ids.
    const c1 = ctx.store.listEvents(CONVERSATION_SESSION_ENTITY, s.session_id)
      .find((e) => e.event_type === "CONVERSATION_SESSION_CREATED")!.correlation_id;
    const s2 = ctx.conv.createSession({ owner_operator_id: OWNER, correlation_id: secretShapes[0] });
    const c2 = ctx.store.listEvents(CONVERSATION_SESSION_ENTITY, s2.session_id)
      .find((e) => e.event_type === "CONVERSATION_SESSION_CREATED")!.correlation_id;
    expect(c2).toBe(c1);
    const s3 = ctx.conv.createSession({ owner_operator_id: OWNER, correlation_id: "different-input" });
    const c3 = ctx.store.listEvents(CONVERSATION_SESSION_ENTITY, s3.session_id)
      .find((e) => e.event_type === "CONVERSATION_SESSION_CREATED")!.correlation_id;
    expect(c3).not.toBe(c1);
    // Bounded: unreasonably long input fails closed rather than hashing forever.
    expect(
      code(() =>
        ctx.conv.createSession({ owner_operator_id: OWNER, correlation_id: "x".repeat(5000) }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_LIMIT");
    expect(code(() => ctx.conv.createSession({ owner_operator_id: OWNER, correlation_id: 7 }))).toBe(
      "FAIL_CLOSED_CONVERSATION_FIELD",
    );
  });

  /* ---------------- R4.B — duplicate physical rows ---------------- */

  it("a cloned physical row under a second entity key fails closed", () => {
    const ctx = fresh("clone");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const m = ctx.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, body: "original",
    });
    // Deterministic adversarial: INSERT a second physical row at a
    // DIFFERENT entity key carrying the exact same payload — identical
    // digest, identical hash, byte-for-byte coherent.
    const row = dbOf(ctx.store)
      .prepare("SELECT payload, payload_hash FROM entities WHERE entity_type=? AND entity_id=?")
      .get(CONVERSATION_MESSAGE_ENTITY, m.message_id) as { payload: string; payload_hash: string };
    dbOf(ctx.store)
      .prepare("INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)")
      .run(CONVERSATION_MESSAGE_ENTITY, "MSG_CLONE_PHYSICAL", 1, row.payload, row.payload_hash, new Date().toISOString());
    // History read sees TWO physical rows claiming one canonical
    // identity + one sequence — integrity failure, not silent return.
    expect(
      code(() => ctx.conv.listMessages(s.session_id, { operator_id: OWNER })),
    ).toBe("FAIL_CLOSED_CONVERSATION_INTEGRITY");
    // Remove the clone and reads pass again — the check is on persisted
    // state, not a cached flag.
    dbOf(ctx.store)
      .prepare("DELETE FROM entities WHERE entity_type=? AND entity_id=?")
      .run(CONVERSATION_MESSAGE_ENTITY, "MSG_CLONE_PHYSICAL");
    expect(
      ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages,
    ).toHaveLength(1);
  });

  it("idempotent retry converges — same key, same row, no duplicate", () => {
    const ctx = fresh("idem");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const input = {
      session_id: s.session_id,
      operator_id: OWNER,
      role: "operator" as const,
      body: "send this once",
      idempotency_key: "client-msg-42",
    };
    const a = ctx.conv.appendMessage(input);
    const b = ctx.conv.appendMessage(input);
    expect(b.message_id).toBe(a.message_id);
    expect(a.message_id).toBe(conversationMessageIdFor(s.session_id, "client-msg-42"));
    expect(ctx.conv.getSession(s.session_id, OWNER).message_count).toBe(1);
    expect(ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages).toHaveLength(1);
  });

  it("same key + different payload fails closed (idempotency conflict)", () => {
    const ctx = fresh("idem-conflict");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    ctx.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, role: "operator",
      body: "first", idempotency_key: "k1",
    });
    expect(
      code(() =>
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OWNER, role: "operator",
          body: "different", idempotency_key: "k1",
        }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_IDEMPOTENCY_CONFLICT");
    // The stored row is untouched.
    const { messages } = ctx.conv.listMessages(s.session_id, { operator_id: OWNER });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("first");
  });

  it("the same key in a different session mints a different message", () => {
    const ctx = fresh("idem-scope");
    const a = ctx.conv.createSession({ owner_operator_id: OWNER });
    const b = ctx.conv.createSession({ owner_operator_id: OWNER });
    const m1 = ctx.conv.appendMessage({
      session_id: a.session_id, operator_id: OWNER, role: "operator",
      body: "x", idempotency_key: "k",
    });
    const m2 = ctx.conv.appendMessage({
      session_id: b.session_id, operator_id: OWNER, role: "operator",
      body: "x", idempotency_key: "k",
    });
    expect(m1.message_id).not.toBe(m2.message_id);
  });

  /* ---------------- owner/authorization ---------------- */

  it("a foreign operator cannot read, append, page or close another's session", () => {
    const ctx = fresh("forbidden");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "mine" });
    expect(code(() => ctx.conv.getSession(s.session_id, OTHER))).toBe(
      "FAIL_CLOSED_CONVERSATION_FORBIDDEN",
    );
    expect(
      code(() =>
        ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OTHER, role: "operator", body: "inject" }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_FORBIDDEN");
    expect(code(() => ctx.conv.listMessages(s.session_id, { operator_id: OTHER }))).toBe(
      "FAIL_CLOSED_CONVERSATION_FORBIDDEN",
    );
    expect(code(() => ctx.conv.closeSession(s.session_id, { operator_id: OTHER }))).toBe(
      "FAIL_CLOSED_CONVERSATION_FORBIDDEN",
    );
    expect(ctx.conv.listSessions({ operator_id: OTHER })).toHaveLength(0);
    // The stored message is untouched by the denied calls.
    expect(ctx.conv.listMessages(s.session_id, { operator_id: OWNER }).messages).toHaveLength(1);
  });

  it("an idempotent replay by a foreign operator still fails closed", () => {
    const ctx = fresh("foreign-replay");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const m = ctx.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, role: "operator",
      body: "secret chat", idempotency_key: "kk",
    });
    // Foreigner re-issues the exact call — ownership is checked before
    // the replay path, so no oracle reveals that the id exists.
    expect(
      code(() =>
        ctx.conv.appendMessage({
          session_id: s.session_id, operator_id: OTHER, role: "operator",
          body: "secret chat", idempotency_key: "kk",
        }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_FORBIDDEN");
    expect(m.message_id).toBeDefined();
  });

  /* ---------------- validation + bounds ---------------- */

  it("malformed inputs fail closed", () => {
    const ctx = fresh("validate");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    for (const bad of [
      () => ctx.conv.createSession({ owner_operator_id: "" }),
      () => ctx.conv.createSession({ owner_operator_id: OWNER, title: "x".repeat(CONVERSATION_MAX_TITLE_CHARS + 1) }),
      () => ctx.conv.getSession(" ", OWNER),
      () => ctx.conv.getSession(s.session_id, " "),
      () => ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "nope" as never, body: "x" }),
      () => ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "" }),
      () => ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "y".repeat(CONVERSATION_MAX_BODY_CHARS + 1) }),
      () => ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "x", idempotency_key: "k".repeat(CONVERSATION_MAX_IDEMPOTENCY_KEY_CHARS + 1) }),
      () => ctx.conv.appendMessage({ session_id: "CSESS_ABSENT", operator_id: OWNER, role: "operator", body: "x" }),
      () => ctx.conv.listMessages(s.session_id, { operator_id: OWNER, after_seq: Number.NaN }),
      () => ctx.conv.listMessages(s.session_id, { operator_id: OWNER, limit: Number.NaN }),
      () => ctx.conv.listMessages(s.session_id, { operator_id: OWNER, after_seq: "abc" as never }),
      () => ctx.conv.listSessions({ operator_id: OWNER, state: "RUNNING" as never }),
    ]) {
      expect(() => bad()).toThrowError(PairError);
    }
    // Specific codes on the important ones.
    expect(
      code(() => ctx.conv.appendMessage({ session_id: "CSESS_ABSENT", operator_id: OWNER, role: "operator", body: "x" })),
    ).toBe("NOT_FOUND");
    expect(ctx.conv.getSession(s.session_id, OWNER).message_count).toBe(0);
  });

  it("CLOSED sessions reject appends; close is idempotent", () => {
    const ctx = fresh("close");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "last" });
    const closed = ctx.conv.closeSession(s.session_id, { operator_id: OWNER });
    expect(closed.state).toBe("CLOSED");
    expect(closed.closed_at).toBeTruthy();
    const again = ctx.conv.closeSession(s.session_id, { operator_id: OWNER });
    expect(again.state).toBe("CLOSED");
    expect(
      code(() =>
        ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "too late" }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_CLOSED");
    // No re-open path exists in Phase A — the row stays CLOSED.
    expect(ctx.conv.getSession(s.session_id, OWNER).state).toBe("CLOSED");
  });

  /* ---------------- pagination ---------------- */

  it("long conversations page in bounded, exact order", () => {
    const ctx = fresh("paging");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const N = 205;
    for (let i = 0; i < N; i++) {
      ctx.conv.appendMessage({
        session_id: s.session_id, operator_id: OWNER, role: "operator", body: `m${i}`,
      });
    }
    // Default limit clamps to MAX_PAGE_SIZE.
    const first = ctx.conv.listMessages(s.session_id, { operator_id: OWNER });
    expect(first.messages).toHaveLength(CONVERSATION_MAX_PAGE_SIZE);
    expect(first.next_after_seq).toBe(CONVERSATION_MAX_PAGE_SIZE);
    const rest = ctx.conv.listMessages(s.session_id, {
      operator_id: OWNER, after_seq: first.next_after_seq,
    });
    expect(rest.messages.map((m) => m.seq)).toEqual(
      Array.from({ length: N - CONVERSATION_MAX_PAGE_SIZE }, (_, i) => CONVERSATION_MAX_PAGE_SIZE + 1 + i),
    );
    expect(rest.next_after_seq).toBeNull();
    // Full walk via cursor preserves exact order.
    const seen: number[] = [];
    let cursor: number | null = null;
    for (;;) {
      const page = ctx.conv.listMessages(s.session_id, {
        operator_id: OWNER, after_seq: cursor, limit: 33,
      });
      seen.push(...page.messages.map((m) => m.seq));
      if (page.next_after_seq === null) break;
      cursor = page.next_after_seq;
    }
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it("per-session message cap is enforced", () => {
    const ctx = fresh("msgcap");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    dbOf(ctx.store).exec("BEGIN");
    try {
      const now = new Date().toISOString();
      const insert = dbOf(ctx.store).prepare(
        "INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)",
      );
      for (let seq = 1; seq <= CONVERSATION_MAX_MESSAGES_PER_SESSION; seq++) {
        const row = {
          schema_version: "pair.os.vnext.conversation-message.v1",
          message_id: `MSG_SEED_${seq}`,
          session_id: s.session_id,
          owner_operator_id: OWNER,
          seq,
          role: "operator",
          body: "seed",
          idempotency_key: null,
          created_at: now,
        };
        const body = { ...row, message_digest: "x" };
        body.message_digest = digest({
          contract: "pair-conversation-message.v1",
          message_id: row.message_id,
          session_id: row.session_id,
          owner_operator_id: OWNER,
          seq,
          role: "operator",
          body: "seed",
          idempotency_key: null,
        });
        insert.run(CONVERSATION_MESSAGE_ENTITY, row.message_id, 1, JSON.stringify(body), digest(body), now);
      }
      // Bump the session counters the same way the service would.
      const srow = dbOf(ctx.store)
        .prepare("SELECT payload, version FROM entities WHERE entity_type=? AND entity_id=?")
        .get(CONVERSATION_SESSION_ENTITY, s.session_id) as { payload: string; version: number };
      const sbody = JSON.parse(srow.payload) as Record<string, unknown>;
      sbody.message_count = CONVERSATION_MAX_MESSAGES_PER_SESSION;
      sbody.next_seq = CONVERSATION_MAX_MESSAGES_PER_SESSION + 1;
      dbOf(ctx.store)
        .prepare("UPDATE entities SET payload=?, payload_hash=?, version=? WHERE entity_type=? AND entity_id=?")
        .run(JSON.stringify(sbody), digest(sbody), srow.version + 1, CONVERSATION_SESSION_ENTITY, s.session_id);
      dbOf(ctx.store).exec("COMMIT");
    } catch (e) {
      dbOf(ctx.store).exec("ROLLBACK");
      throw e;
    }
    expect(
      code(() =>
        ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "over" }),
      ),
    ).toBe("FAIL_CLOSED_CONVERSATION_LIMIT");
  });

  /* ---------------- zero mission authority ---------------- */

  it("task-like chat text creates ZERO missions or governed entities", () => {
    const ctx = fresh("no-mission");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    for (const body of [
      "tạo mission deploy production ngay",
      "làm task này đi: gửi report.txt lên telegram",
      "run the executor on /tmp/x",
      "startMission({goal: 'ship it'})",
      "POST /api/missions confirm",
      "đặt objective: đạt 100 khách hàng trong tháng",
    ]) {
      ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body });
    }
    expect(governedEntities(ctx.store)).toEqual([]);
    expect(governedEvents(ctx.store)).toEqual([]);
  });

  it("affirmative words carry no execution authority", () => {
    const ctx = fresh("affirm");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    for (const body of ["OK", "yes", "làm đi", "execute now", "confirm", "ok chạy đi"]) {
      ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body });
    }
    expect(governedEntities(ctx.store)).toEqual([]);
    expect(governedEvents(ctx.store)).toEqual([]);
    expect(ctx.conv.getSession(s.session_id, OWNER).message_count).toBe(6);
  });

  it("conversation ops never mint objective, mission, telegram or cost rows", () => {
    const ctx = fresh("isolation");
    const s1 = ctx.conv.createSession({ owner_operator_id: OWNER });
    const s2 = ctx.conv.createSession({ owner_operator_id: OTHER });
    ctx.conv.appendMessage({ session_id: s1.session_id, operator_id: OWNER, role: "operator", body: "gửi file lên Telegram nhé" });
    ctx.conv.internalWriter().appendMessage({ session_id: s1.session_id, role: "assistant", body: "Đã ghi nhận — không thực thi gì." });
    ctx.conv.appendMessage({ session_id: s2.session_id, operator_id: OTHER, role: "operator", body: "run codex --exec deploy" });
    ctx.conv.closeSession(s2.session_id, { operator_id: OTHER });
    const types = new Set(governedEntities(ctx.store).map((e) => e.entity_type));
    for (const t of ["mission", "objective", "objective_workstream", "telegram_delivery", "work_item", "cost_policy"]) {
      expect(types.has(t)).toBe(false);
    }
    expect(governedEvents(ctx.store)).toEqual([]);
  });

  /* ---------------- restart/replay ---------------- */

  it("restart preserves boundaries: reads, seq continuation, replay", () => {
    const ctx = fresh("restart2");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const m1 = ctx.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, role: "operator",
      body: "persist me", idempotency_key: "r1",
    });
    const ctx2 = reopen(ctx);
    // Same reads after reopen.
    expect(ctx2.conv.getSession(s.session_id, OWNER).message_count).toBe(1);
    expect(
      code(() => ctx2.conv.appendMessage({ session_id: s.session_id, operator_id: OTHER, role: "operator", body: "x" })),
    ).toBe("FAIL_CLOSED_CONVERSATION_FORBIDDEN");
    // Replay of the idempotent call returns the stored row post-restart.
    const replayed = ctx2.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, role: "operator",
      body: "persist me", idempotency_key: "r1",
    });
    expect(replayed.message_id).toBe(m1.message_id);
    // Seq continues from the persisted counter.
    const m2 = ctx2.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "next" });
    expect(m2.seq).toBe(2);
    expect(ctx2.conv.listMessages(s.session_id, { operator_id: OWNER }).messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  /* ---------------- error evidence stays secret-safe ---------------- */

  it("audit events carry ids and counts only — never message text", () => {
    const ctx = fresh("eventmeta");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const text = "the quick brown fox has AKIAIOSFODNN7EXAMPLE and ghp_AbC123xYz0099 inside";
    ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: text });
    ctx.conv.closeSession(s.session_id, { operator_id: OWNER });
    const events = ctx.store.listEvents(CONVERSATION_SESSION_ENTITY, s.session_id);
    expect(events.map((e) => e.event_type)).toEqual([
      "CONVERSATION_SESSION_CREATED",
      "CONVERSATION_MESSAGE_APPENDED",
      "CONVERSATION_SESSION_CLOSED",
    ]);
    for (const e of events) {
      const meta = e.metadata_json ? String(e.metadata_json) : "";
      expect(meta.includes(text)).toBe(false);
      expect(meta.includes("AKIA")).toBe(false);
      expect(meta.includes("ghp_")).toBe(false);
    }
    // The appended event's metadata is exactly the allowlisted fields.
    const appended = events[1]!;
    const meta = JSON.parse(String(appended.metadata_json)) as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["body_chars", "message_id", "role", "seq"]);
  });

  it("ordinary user text persists; error evidence stays code-only", () => {
    const ctx = fresh("evidence");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    // User content with secret-looking text is stored as user data
    // (mandate §6: ordinary authenticated conversation content may be
    // stored) — the store's marker-field/bcap policy still applies.
    const m = ctx.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, role: "operator",
      body: "key looks like AKIAIOSFODNN7EXAMPLE — just a note",
    });
    expect(m.body).toContain("AKIAIOSFODNN7EXAMPLE");
    const e = err(() => ctx.conv.appendMessage({ session_id: s.session_id, operator_id: OTHER, role: "operator", body: "x" }));
    expect(e.code).toBe("FAIL_CLOSED_CONVERSATION_FORBIDDEN");
    // Error text carries identity, not user content.
    expect(e.message).not.toContain("AKIA");
  });

  it("secret-marker field names and bcap-shaped strings never persist", () => {
    const ctx = fresh("secret-free");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    // bcap1 capability-shaped content is rejected by the store layer even
    // inside a user message body — fail closed before persistence.
    const capToken = `bcap1.${"a".repeat(32)}.${"b".repeat(32)}`;
    const thrown = err(() =>
      ctx.conv.appendMessage({
        session_id: s.session_id, operator_id: OWNER, role: "operator", body: capToken,
      }),
    );
    expect(thrown.code).toBe("FAIL_CLOSED_SENSITIVE_MATERIAL");
    expect(ctx.conv.getSession(s.session_id, OWNER).message_count).toBe(0);
  });

  /* ---------------- limits contract ---------------- */

  it("resource limits are the documented constants", () => {
    expect(CONVERSATION_MAX_PAGE_SIZE).toBe(200);
    expect(CONVERSATION_MAX_MESSAGES_PER_SESSION).toBe(10_000);
    expect(CONVERSATION_MAX_SESSIONS_PER_OWNER).toBe(1_000);
    expect(CONVERSATION_MAX_BODY_CHARS).toBe(16_000);
    expect(CONVERSATION_MAX_TITLE_CHARS).toBe(200);
    expect(CONVERSATION_SESSION_SCHEMA).toBe("pair.os.vnext.conversation-session.v1");
  });

  it("per-owner session cap is enforced atomically", () => {
    const ctx = fresh("ownercap");
    dbOf(ctx.store).exec("BEGIN");
    try {
      const now = new Date().toISOString();
      const insert = dbOf(ctx.store).prepare(
        "INSERT INTO entities (entity_type, entity_id, version, payload, payload_hash, updated_at) VALUES (?,?,?,?,?,?)",
      );
      for (let i = 0; i < CONVERSATION_MAX_SESSIONS_PER_OWNER; i++) {
        const sid = `CSESS_SEED_${i}`;
        const body = {
          schema_version: CONVERSATION_SESSION_SCHEMA,
          session_id: sid,
          owner_operator_id: OWNER,
          entry_mode: "CONVERSATION",
          state: "OPEN",
          title: null,
          message_count: 0,
          next_seq: 1,
          closed_at: null,
          session_digest: digest({
            contract: "pair-conversation-session.v1",
            session_id: sid,
            owner_operator_id: OWNER,
            entry_mode: "CONVERSATION",
          }),
          created_at: now,
          updated_at: now,
        };
        insert.run(CONVERSATION_SESSION_ENTITY, sid, 1, JSON.stringify(body), digest(body), now);
      }
      dbOf(ctx.store).exec("COMMIT");
    } catch (e) {
      dbOf(ctx.store).exec("ROLLBACK");
      throw e;
    }
    expect(
      code(() => ctx.conv.createSession({ owner_operator_id: OWNER })),
    ).toBe("FAIL_CLOSED_CONVERSATION_LIMIT");
    // Another owner is unaffected.
    expect(ctx.conv.createSession({ owner_operator_id: OTHER }).state).toBe("OPEN");
  });
});
