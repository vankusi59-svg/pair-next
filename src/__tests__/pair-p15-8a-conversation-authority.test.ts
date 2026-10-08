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

  it("tampered session/message payloads fail closed on read", () => {
    const ctx = fresh("tamper");
    const s = ctx.conv.createSession({ owner_operator_id: OWNER });
    const m = ctx.conv.appendMessage({
      session_id: s.session_id, operator_id: OWNER, role: "operator", body: "hello",
    });
    sqlRewriteEntity(ctx.store, CONVERSATION_SESSION_ENTITY, s.session_id, (b) => {
      b.owner_operator_id = OTHER;
    });
    expect(code(() => ctx.conv.getSession(s.session_id, OWNER))).toBe(
      "FAIL_CLOSED_CONVERSATION_DIGEST",
    );
    sqlRewriteEntity(ctx.store, CONVERSATION_SESSION_ENTITY, s.session_id, () => {});
    sqlRewriteEntity(ctx.store, CONVERSATION_MESSAGE_ENTITY, m.message_id, (b) => {
      b.body = "rewritten";
    });
    expect(code(() =>
      ctx.conv.listMessages(s.session_id, { operator_id: OWNER })
    )).toBe("FAIL_CLOSED_CONVERSATION_DIGEST");
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
    const s = svcA.createSession({ owner_operator_id: OWNER });
    svcA.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "a1" });
    svcB.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "assistant", body: "b1" });
    svcA.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "operator", body: "a2" });
    svcB.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "assistant", body: "b2" });
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
    conv2.appendMessage({ session_id: s.session_id, operator_id: OWNER, role: "assistant", body: "two" });
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

  /* ---------------- idempotency ---------------- */

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
    ctx.conv.appendMessage({ session_id: s1.session_id, operator_id: OWNER, role: "assistant", body: "Đã ghi nhận — không thực thi gì." });
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
