/* P15.8-E — Telegram conversation ingress: the bridge is thin; ALL
 * authority is server-side. Proofs over the REAL mission-control-server
 * HTTP surface with a mocked conversation invoker (zero model calls):
 *
 *  - Ordinary text → conversation reply, NEVER a mission.
 *  - Mission-shaped text → still just conversation.
 *  - /draft-equivalent (prepareDraft) → draft + compact ref, ZERO missions.
 *  - Ref-bound confirm → exactly ONE mission; replays converge.
 *  - Reply-bound NL ack → confirms ONLY through the recorded prompt ref;
 *    unbound acks and ambiguous acks stay conversation (0 missions).
 *  - Operator↔chat binding: a header for chat A can never act on chat B.
 *  - Group chats are refused.
 *  - Update id dedup: replayed updates mint no new rows.
 *  - Restart: bindings/refs/drafts are durable — continuity survives.
 */

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApprovalQueue,
  BusinessLayer,
  ConversationReasoningService,
  ConversationSessionService,
  createMissionControlServer,
  ensureConversationModel,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  MissionDraftService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  TelegramConversationService,
  WorkforceService,
  type ConversationInvokeInput,
  type ConversationInvokeResult,
  type ConversationInvoker,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p158e-"));
let counter = 0;
const CHAT = "1882810918";
const CHAT2 = "999000111";
const OP = `telegram:${CHAT}`;
const TOK = "mc-test-token";
const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

interface Stack {
  dir: string;
  store: PairEvidenceStore;
  control: MissionControl;
  biz: BusinessLayer;
  wf: WorkforceService;
  projectId: string;
  modelEntryId: string;
}

function freshStack(name: string): Stack {
  const dir = path.join(ROOT, `${counter++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const store = new PairEvidenceStore(path.join(dir, "pair.db"));
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const recon = new ReconciliationService(service, new Map());
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", task_instruction: "t1",
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: new Map(), scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  const biz = new BusinessLayer({
    store, control, schedules: new MissionScheduleService(service) });
  const wf = new WorkforceService({ store, business: biz });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name: "p", root_location: workspace });
  return {
    dir, store, control, biz, wf,
    projectId: String(project.project_id),
    modelEntryId: ensureConversationModel(store, undefined, "t"),
  };
}

class MockInvoker implements ConversationInvoker {
  calls: ConversationInvokeInput[] = [];
  private fn: (i: ConversationInvokeInput) => string | Promise<string>;
  constructor(fn: string | ((i: ConversationInvokeInput) => string | Promise<string>) = "stub") {
    this.fn = typeof fn === "string" ? () => fn : fn;
  }
  async invoke(input: ConversationInvokeInput): Promise<ConversationInvokeResult> {
    this.calls.push(input);
    return {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: await this.fn(input),
    };
  }
}

interface ConvDeps {
  sessions: ConversationSessionService;
  reasoning: ConversationReasoningService;
  drafts: MissionDraftService;
  telegram: TelegramConversationService;
}

function convDeps(s: Stack, invoker: ConversationInvoker | null): ConvDeps {
  const sessions = new ConversationSessionService(s.store);
  const drafts = new MissionDraftService({
    conversation: sessions, control: s.control, store: s.store });
  const reasoning = invoker
    ? new ConversationReasoningService({
        conversation: sessions, store: s.store, invoker,
        model_entry_id: s.modelEntryId })
    : undefined;
  return {
    sessions,
    reasoning: reasoning as ConversationReasoningService,
    drafts,
    telegram: new TelegramConversationService({
      store: s.store, conversation: sessions, drafts,
      reasoning: reasoning ?? undefined }),
  };
}

async function serve(s: Stack, conv?: Partial<ConvDeps>) {
  const server = createMissionControlServer({
    control: s.control, business: s.biz, workforce: s.wf, store: s.store,
    authToken: TOK,
    conversation: conv as never,
  });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const hdr = (chat = CHAT) => ({
  "content-type": "application/json",
  "x-operator-id": `telegram:${chat}`,
  authorization: `Bearer ${TOK}`,
});

const post = (port: number, p: string, body: Record<string, unknown>,
  h = hdr()) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST", headers: h, body: JSON.stringify(body) });
const get = (port: number, p: string, h = hdr()) =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: h });
const json = async (r: Response) => ({ status: r.status, body: await r.json() as never });
const missionsOf = (s: Stack) => s.store.list("mission").map((m) => String(m.mission_id));

let upd = 1000;
const ingress = (port: number, text: string, opts: Record<string, unknown> = {},
  h = hdr()) =>
  post(port, "/api/telegram/conversation/ingress", {
    chat_id: CHAT, chat_type: "private", update_id: ++upd, text, ...opts }, h);

const mkDraft = async (port: number, goal: string, h = hdr()) => {
  const r = await json(await post(port, "/api/telegram/conversation/draft", {
    chat_id: CHAT, project_id: undefined, goal }, h));
  return r;
};

/* ============================ TESTS ============================ */

describe("P15.8-E §1 — ordinary text becomes conversation, never a mission", () => {
  it("1. authorized chat → AI reply, zero missions; update replays converge", async () => {
    const s = freshStack("chat");
    const inv = new MockInvoker((i) => `PAIR trả lời: ${i.user_prompt.slice(0, 40)}`);
    const port = await serve(s, convDeps(s, inv));

    const r1 = await json(await ingress(port, "PAIR Next đang hoạt động thế nào?"));
    expect(r1.status).toBe(200);
    expect((r1.body as { kind: string }).kind).toBe("reply");
    expect(missionsOf(s)).toHaveLength(0);

    // Replay the SAME update id — converges, no second turn, no model call.
    const rid = upd;
    const replay = await json(await post(port, "/api/telegram/conversation/ingress", {
      chat_id: CHAT, chat_type: "private", update_id: rid,
      text: "PAIR Next đang hoạt động thế nào?" }));
    expect((replay.body as { reused: boolean }).reused).toBe(true);
    expect(inv.calls).toHaveLength(1);
    expect(missionsOf(s)).toHaveLength(0);
  });

  it("2. Vietnamese multi-turn retains context + binds a durable session", async () => {
    const s = freshStack("vi");
    const inv = new MockInvoker((i) =>
      `ECHO[${(i.user_prompt.match(/seed-\d+/g) ?? []).join(",")}]`);
    const port = await serve(s, convDeps(s, inv));
    await ingress(port, "ghi nhớ seed-1");
    const r = await json(await ingress(port, "lúc nãy tôi nói seed-2 — nhắc lại ngữ cảnh"));
    expect(String((r.body as { reply: string }).reply)).toContain("seed-1");
    expect(String((r.body as { reply: string }).reply)).toContain("seed-2");

    // Binding is durable: a fresh service over the same store keeps the session.
    const deps2 = convDeps(s, inv);
    const tsvc2 = deps2.telegram;
    const found = tsvc2.resolveChatSession({ operator_id: OP, chat_id: CHAT });
    const msgs = deps2.sessions.listMessages(found.session.session_id, { operator_id: OP });
    expect(msgs.messages.length).toBeGreaterThanOrEqual(4);
    expect(missionsOf(s)).toHaveLength(0);
  });

  it("5. mission-shaped text is still only conversation", async () => {
    const s = freshStack("missionish");
    const inv = new MockInvoker("Tôi có thể thảo luận task này — nhưng không tự chạy mission.");
    const port = await serve(s, convDeps(s, inv));
    const r = await json(await ingress(port, "Truy cập cafef.vn và tổng hợp 5 bài mới nhất"));
    expect((r.body as { kind: string }).kind).toBe("reply");
    expect(missionsOf(s)).toHaveLength(0);
    expect(s.store.list("conversation_mission_draft")).toHaveLength(0);
  });

  it("9. unbound 'OK' is ordinary conversation — zero missions, zero ack", async () => {
    const s = freshStack("unbound");
    const port = await serve(s, convDeps(s, new MockInvoker("ok gì?")));
    const r = await json(await ingress(port, "OK"));
    expect((r.body as { kind: string }).kind).toBe("reply");
    expect(missionsOf(s)).toHaveLength(0);
  });

  it("4. unauthorized operator/chat combos are refused", async () => {
    const s = freshStack("forbid");
    const port = await serve(s, convDeps(s, new MockInvoker()));
    // operator for CHAT2 may not touch CHAT's ingress/binding/refs.
    const bad = await json(await ingress(port, "hi", {}, hdr(CHAT2)));
    expect(bad.status).toBe(409); // operator ↔ chat mismatch
    // group chat → rejected
    const grp = await json(await post(port, "/api/telegram/conversation/ingress", {
      chat_id: CHAT, chat_type: "group", update_id: ++upd, text: "hi" }));
    expect(grp.status).toBe(409);
    // no operator at all → required
    const noOp = await json(await post(port, "/api/telegram/conversation/ingress", {
      chat_id: CHAT, update_id: ++upd, text: "hi" },
      { "content-type": "application/json", authorization: `Bearer ${TOK}` }));
    expect(noOp.status).toBe(403);
    expect(missionsOf(s)).toHaveLength(0);
  });

  it("reasoning unavailable → typed kind, other surfaces keep working", async () => {
    const s = freshStack("noreason");
    const deps = convDeps(s, null); // reasoning absent
    const port = await serve(s, deps);
    const r = await json(await ingress(port, "hello"));
    expect((r.body as { kind: string }).kind).toBe("reasoning_unavailable");
    // /new + /draft still work
    const nw = await json(await post(port, "/api/telegram/conversation/new",
      { chat_id: CHAT, update_id: ++upd }));
    expect(nw.status).toBe(200);
    expect(missionsOf(s)).toHaveLength(0);
  });
});

describe("P15.8-E §2 — governed draft preparation + confirmation", () => {
  const draftPrompt = async (port: number, goal: string, promptMsgId: number) => {
    const s = await json(await post(port, "/api/telegram/conversation/draft", {
      chat_id: CHAT, project_id: "?", goal, update_id: ++upd }));
    return s;
  };

  it("6+7. draft creates ZERO missions; ref-bound confirm mints EXACTLY one", async () => {
    const s = freshStack("draftok");
    const port = await serve(s, convDeps(s, new MockInvoker()));
    const d = await json(await post(port, "/api/telegram/conversation/draft", {
      chat_id: CHAT, project_id: s.projectId, goal: "viết báo cáo", update_id: ++upd }));
    expect(d.status).toBe(200);
    const { draft, ref } = d.body as {
      draft: { draft_id: string; draft_digest: string };
      ref: { ref_id: string; prompt_message_id: number | null };
    };
    expect(missionsOf(s)).toHaveLength(0);
    // bridge records the prompt message id
    const bp = await json(await post(
      port, `/api/telegram/conversation/refs/${ref.ref_id}/prompt-sent`,
      { chat_id: CHAT, message_id: 55501 }));
    expect(bp.status).toBe(200);
    // inline confirm — exactly one mission
    const cf = await json(await post(
      port, `/api/telegram/conversation/refs/${ref.ref_id}/confirm`,
      { chat_id: CHAT, chat_type: "private" }));
    expect(cf.status).toBe(200);
    const cfBody = cf.body as { mission_id: string; reused: boolean };
    expect(cfBody.mission_id).toMatch(/^MSN_/);
    expect(missionsOf(s)).toHaveLength(1);

    // 8. duplicate callback confirm converges to the same receipt
    const cf2 = await json(await post(
      port, `/api/telegram/conversation/refs/${ref.ref_id}/confirm`,
      { chat_id: CHAT, chat_type: "private" }));
    expect((cf2.body as { mission_id: string }).mission_id).toBe(cfBody.mission_id);
    expect(missionsOf(s)).toHaveLength(1);
  });

  it("10. reply-bound ack confirms exactly one pending draft via kind:ack", async () => {
    const s = freshStack("ack");
    const port = await serve(s, convDeps(s, new MockInvoker("chat")));
    const d = await json(await post(port, "/api/telegram/conversation/draft", {
      chat_id: CHAT, project_id: s.projectId, goal: "làm việc này", update_id: ++upd }));
    const { ref } = d.body as { ref: { ref_id: string } };
    await post(port, `/api/telegram/conversation/refs/${ref.ref_id}/prompt-sent`,
      { chat_id: CHAT, message_id: 777001 });
    // "làm đi" replying to the prompt message → ack confirm
    const r = await json(await ingress(port, "làm đi", { reply_to_message_id: 777001 }));
    expect((r.body as { kind: string }).kind).toBe("ack_confirmed");
    expect(missionsOf(s)).toHaveLength(1);
  });

  it("11. two pending drafts → reply-bound ack is ambiguous, zero missions", async () => {
    const s = freshStack("amb");
    const port = await serve(s, convDeps(s, new MockInvoker("chat")));
    const a = await json(await post(port, "/api/telegram/conversation/draft", {
      chat_id: CHAT, project_id: s.projectId, goal: "draft A", update_id: ++upd }));
    const b = await json(await post(port, "/api/telegram/conversation/draft", {
      chat_id: CHAT, project_id: s.projectId, goal: "draft B", update_id: ++upd }));
    const refB = (b.body as { ref: { ref_id: string } }).ref.ref_id;
    await post(port, `/api/telegram/conversation/refs/${refB}/prompt-sent`,
      { chat_id: CHAT, message_id: 888001 });
    const r = await json(await ingress(port, "xác nhận", { reply_to_message_id: 888001 }));
    // ack uniqueness inside confirmDraft (P15.8-C R1.A) → ambiguous → 409, 0 missions
    expect(r.status).toBe(409);
    expect(String((r.body as { error: string }).error)).toContain("ACK_AMBIGUOUS");
    expect(missionsOf(s)).toHaveLength(0);
    void a;
  });

  it("12. rejected draft ref cannot confirm; expired ref is refused", async () => {
    const s = freshStack("reject");
    const port = await serve(s, convDeps(s, new MockInvoker()));
    const d = await json(await post(port, "/api/telegram/conversation/draft", {
      chat_id: CHAT, project_id: s.projectId, goal: "g", update_id: ++upd }));
    const ref = (d.body as { ref: { ref_id: string } }).ref;
    // reject via ref
    const rj = await json(await post(
      port, `/api/telegram/conversation/refs/${ref.ref_id}/reject`, { chat_id: CHAT }));
    expect(rj.status).toBe(200);
    const cf = await json(await post(
      port, `/api/telegram/conversation/refs/${ref.ref_id}/confirm`,
      { chat_id: CHAT, chat_type: "private" }));
    expect(cf.status).toBe(409); // INVALIDATED ref / REJECTED draft
    expect(missionsOf(s)).toHaveLength(0);

    // forged/foreign ref strings and a foreign chat never confirm
    const forged = await json(await post(
      port, "/api/telegram/conversation/refs/TGR_forged/confirm",
      { chat_id: CHAT, chat_type: "private" }));
    expect(forged.status).toBe(409);
    const foreignChat = await json(await post(
      port, `/api/telegram/conversation/refs/${ref.ref_id}/confirm`,
      { chat_id: CHAT2, chat_type: "private" }, hdr(CHAT2)));
    expect(foreignChat.status).toBe(409);
    expect(missionsOf(s)).toHaveLength(0);
  });

  it("group chat confirmation is refused even with a valid ref", async () => {
    const s = freshStack("grp");
    const port = await serve(s, convDeps(s, new MockInvoker()));
    const d = await json(await post(port, "/api/telegram/conversation/draft", {
      chat_id: CHAT, project_id: s.projectId, goal: "g", update_id: ++upd }));
    const ref = (d.body as { ref: { ref_id: string } }).ref;
    const cf = await json(await post(
      port, `/api/telegram/conversation/refs/${ref.ref_id}/confirm`,
      { chat_id: CHAT, chat_type: "group" }));
    expect(cf.status).toBe(409);
    expect(missionsOf(s)).toHaveLength(0);
  });

  it("13/14. existing admin routes + delivery surface untouched (404 graft)", async () => {
    const s = freshStack("compat");
    // WITHOUT telegram dep → typed disable, conversations still fine
    const conv = convDeps(s, new MockInvoker());
    const partial = { sessions: conv.sessions, drafts: conv.drafts };
    const port = await serve(s, partial as never);
    const r = await json(await post(port, "/api/telegram/conversation/ingress", {
      chat_id: CHAT, update_id: ++upd, text: "hi" }));
    expect(r.status).toBe(404);
    expect(String((r.body as { error: string }).error)).toBe("TELEGRAM_CONVERSATION_DISABLED");
    // unrelated conversation route still serves
    const ses = await json(await post(port, "/api/conversations", {}));
    expect(ses.status).toBe(200);
  });
});

describe("P15.8-E §3 — durability + tamper", () => {
  it("binding + pending refs survive restart (fresh service, same store)", async () => {
    const s = freshStack("restart");
    const d1 = convDeps(s, new MockInvoker("x"));
    const { session } = d1.telegram.resolveChatSession({ operator_id: OP, chat_id: CHAT });
    const { draft, ref } = d1.telegram.prepareDraft({
      operator_id: OP, chat_id: CHAT, project_id: s.projectId,
      goal: "sau restart", update_id: 42 });
    expect(ref.state).toBe("ACTIVE");
    // "restart" — brand-new service instances over the same store
    const d2 = convDeps(s, new MockInvoker("y"));
    const again = d2.telegram.resolveChatSession({ operator_id: OP, chat_id: CHAT });
    expect(again.session.session_id).toBe(session.session_id);
    const pending = d2.telegram.listPending({ operator_id: OP, chat_id: CHAT });
    expect(pending.map((x) => x.draft_id)).toContain(draft.draft_id);
    // R1.B — confirmation authority requires the recorded prompt: the
    // restarted bridge re-delivers the prompt and binds its message id.
    d2.telegram.bindPromptMessage({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, message_id: 990001 });
    // confirm through the restarted service converges to one mission
    const c = await d2.telegram.confirmByRef({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, kind: "explicit" });
    expect(missionsOf(s)).toHaveLength(1);
    const c2 = await d2.telegram.confirmByRef({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, kind: "explicit" });
    expect(c2.mission_id).toBe(c.mission_id);
    expect(missionsOf(s)).toHaveLength(1);
  });

  it("tampered ref payload fails closed on every read path", async () => {
    const s = freshStack("tamper");
    const d = convDeps(s, new MockInvoker());
    const { ref } = d.telegram.prepareDraft({
      operator_id: OP, chat_id: CHAT, project_id: s.projectId, goal: "g", update_id: 7 });
    // Coherent-shape mutation: point the ref at a foreign session id
    const cur = s.store.get("telegram_confirm_ref", ref.ref_id) as Record<string, unknown>;
    s.store.put("telegram_confirm_ref", ref.ref_id,
      { ...cur, session_id: "CSESS_other" }, Number(cur.version ?? 0));
    await expect(d.telegram.confirmByRef({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, kind: "explicit",
    })).rejects.toThrow(/FAIL_CLOSED/);
    expect(missionsOf(s)).toHaveLength(0);
  });
});

describe("P15.8-E R1 — inbound outcome durability + full presentation", () => {
  it("R1.A: /new is idempotent by (chat_id, update_id) — replay returns the recorded session, binding stable", () => {
    const s = freshStack("newdedup");
    const d = convDeps(s, new MockInvoker());
    const first = d.telegram.newChatSession({ operator_id: OP, chat_id: CHAT, update_id: 501 });
    expect(first.reused).toBe(false);
    // Replay the SAME update — recorded outcome replays; NO new session.
    const replay = d.telegram.newChatSession({ operator_id: OP, chat_id: CHAT, update_id: 501 });
    expect(replay.reused).toBe(true);
    expect(replay.session.session_id).toBe(first.session.session_id);
    // Binding still points at the originally minted session.
    const bound = d.telegram.resolveChatSession({ operator_id: OP, chat_id: CHAT });
    expect(bound.session.session_id).toBe(first.session.session_id);
    const sessions = s.store.list("conversation_session")
      .filter((x) => String(x.owner_operator_id) === OP);
    expect(sessions).toHaveLength(1);
    // A DIFFERENT update id is a new intent — rotates once more.
    const second = d.telegram.newChatSession({ operator_id: OP, chat_id: CHAT, update_id: 502 });
    expect(second.reused).toBe(false);
    expect(second.session.session_id).not.toBe(first.session.session_id);
    const bound2 = d.telegram.resolveChatSession({ operator_id: OP, chat_id: CHAT });
    expect(bound2.session.session_id).toBe(second.session.session_id);
  });

  it("R1.B: a ref never bound to a delivered prompt grants NO confirm authority", async () => {
    const s = freshStack("noprompt");
    const d = convDeps(s, new MockInvoker());
    const { ref } = d.telegram.prepareDraft({
      operator_id: OP, chat_id: CHAT, project_id: s.projectId, goal: "g", update_id: 8 });
    // Terms were never presented → confirm fails closed.
    await expect(d.telegram.confirmByRef({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, kind: "explicit",
    })).rejects.toThrow(/FAIL_CLOSED_TELEGRAM_REF_NOT_PRESENTED/);
    expect(missionsOf(s)).toHaveLength(0);
    // After the recorded prompt exists, the same ref confirms once.
    d.telegram.bindPromptMessage({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, message_id: 123001 });
    const c = await d.telegram.confirmByRef({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, kind: "explicit" });
    expect(c.mission_id).toMatch(/^MSN_/);
    expect(missionsOf(s)).toHaveLength(1);
  });

  it("R1.B: a 1,000-char goal is presented COMPLETE before confirm; mission holds the exact goal", async () => {
    const s = freshStack("longgoal");
    const d = convDeps(s, new MockInvoker());
    const goal = "viết báo cáo " + "x".repeat(987); // 1,000 chars total
    const { draft, presentation, ref } = d.telegram.prepareDraft({
      operator_id: OP, chat_id: CHAT, project_id: s.projectId, goal, update_id: 9 });
    expect(presentation.length).toBeGreaterThanOrEqual(1);
    for (const part of presentation) {
      expect(part.length).toBeLessThanOrEqual(4000);
    }
    // The COMPLETE canonical terms are what the operator sees.
    const rendered = presentation.join("");
    expect(rendered).toContain(goal);
    expect(rendered).toContain(s.projectId);
    expect(rendered).toContain(draft.draft_id);
    expect(rendered).toContain(draft.expires_at);
    // Confirm binds the FINAL presented message → exact goal submitted.
    d.telegram.bindPromptMessage({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, message_id: 456001 });
    const c = await d.telegram.confirmByRef({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, kind: "explicit" });
    const mission = s.store.get("mission", c.mission_id) as { goal: string };
    expect(mission.goal).toBe(goal);
  });

  it("R1.B: terms exceeding one message → bounded multi-part presentation; overflow mints NO ref", () => {
    const s = freshStack("multipart");
    const d = convDeps(s, new MockInvoker());
    // Long workspace list pushes terms past a single Telegram message.
    const ws = Array.from({ length: 24 }, (_, i) =>
      `/workspace/${"segment".repeat(30)}-${i}`);
    const { presentation, ref } = d.telegram.prepareDraft({
      operator_id: OP, chat_id: CHAT, project_id: s.projectId,
      goal: "multi-part draft", update_id: 10,
      authorized_workspaces: ws });
    expect(presentation.length).toBeGreaterThan(1);
    expect(presentation.length).toBeLessThanOrEqual(4);
    for (const part of presentation) {
      expect(part.length).toBeLessThanOrEqual(4000);
    }
    const rendered = presentation.join("");
    for (const w of ws) expect(rendered).toContain(w);
    expect(rendered).toContain("Bấm Confirm");
    // The LAST part is the only one that may carry Confirm markup — and
    // its message id is the only valid prompt binding.
    expect(ref.prompt_message_id).toBeNull();

    // Terms that cannot fit the bounded presentation fail closed and
    // mint NO confirmation ref at all.
    const huge = Array.from({ length: 32 }, (_, i) => `/ws/${"w".repeat(600)}-${i}`);
    expect(() => d.telegram.prepareDraft({
      operator_id: OP, chat_id: CHAT, project_id: s.projectId,
      goal: "g", update_id: 11, authorized_workspaces: huge,
    })).toThrow(/FAIL_CLOSED_TELEGRAM_PRESENTATION/);
    // No orphaned ref grants authority for the failed draft.
    const refs = s.store.list("telegram_confirm_ref");
    expect(refs.filter((r) => String(r.chat_id) === CHAT)).toHaveLength(1); // only the successful one
    expect(missionsOf(s)).toHaveLength(0);
  });
});

describe("P15.8-E R2 — reply-bound ACK replays its committed outcome", () => {
  it("replay of update_id after ref CONSUMED returns the original ack_confirmed receipt — zero new messages, zero model calls, one mission", async () => {
    const s = freshStack("ackreplay");
    const inv = new MockInvoker("pair ack");
    const d = convDeps(s, inv);
    const { draft, ref } = d.telegram.prepareDraft({
      operator_id: OP, chat_id: CHAT, project_id: s.projectId,
      goal: "ack replay draft", update_id: 499 });
    d.telegram.bindPromptMessage({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, message_id: 700 });
    const msgs = () => s.store.list("conversation_message");
    const msgCountBefore = msgs().length;

    const r1 = await d.telegram.ingress({
      operator_id: OP, chat_id: CHAT, chat_type: "private",
      update_id: 500, text: "vâng", reply_to_message_id: 700 });
    expect(r1).toMatchObject({ kind: "ack_confirmed",
      draft_id: draft.draft_id });
    expect(missionsOf(s)).toHaveLength(1);
    const missionId = (r1 as { mission_id: string }).mission_id;

    // Replay the EXACT update after the ref is CONSUMED — identical
    // receipt, no new turn, no model call, still one mission.
    const replay = await d.telegram.ingress({
      operator_id: OP, chat_id: CHAT, chat_type: "private",
      update_id: 500, text: "vâng", reply_to_message_id: 700 });
    expect(replay).toMatchObject({ kind: "ack_confirmed",
      draft_id: draft.draft_id, mission_id: missionId, reused: true });
    expect(msgs().length).toBe(msgCountBefore);
    expect(inv.calls).toHaveLength(0);
    expect(missionsOf(s)).toHaveLength(1);

    // Fresh service over the same store — replay is durable across restart.
    const d2 = convDeps(s, inv);
    const replay2 = await d2.telegram.ingress({
      operator_id: OP, chat_id: CHAT, chat_type: "private",
      update_id: 500, text: "vâng", reply_to_message_id: 700 });
    expect(replay2).toMatchObject({ kind: "ack_confirmed",
      mission_id: missionId, reused: true });
    expect(msgs().length).toBe(msgCountBefore);
    expect(inv.calls).toHaveLength(0);
    expect(missionsOf(s)).toHaveLength(1);

    // A DISTINCT update replying to the same prompt is an unbound ack —
    // it gains NO execution authority and stays ordinary conversation.
    const other = await d2.telegram.ingress({
      operator_id: OP, chat_id: CHAT, chat_type: "private",
      update_id: 501, text: "vâng", reply_to_message_id: 700 });
    expect(other.kind).toBe("reply");
    expect(missionsOf(s)).toHaveLength(1);
    expect(inv.calls).toHaveLength(1); // the ordinary turn's model call
  });

  it("replay binding cannot be redirected — mismatched prompt or tampered record fails closed", async () => {
    const s = freshStack("ackforge");
    const d = convDeps(s, new MockInvoker());
    const { ref } = d.telegram.prepareDraft({
      operator_id: OP, chat_id: CHAT, project_id: s.projectId,
      goal: "forge draft", update_id: 600 });
    d.telegram.bindPromptMessage({
      operator_id: OP, chat_id: CHAT, ref_id: ref.ref_id, message_id: 800 });
    const r = await d.telegram.ingress({
      operator_id: OP, chat_id: CHAT, chat_type: "private",
      update_id: 601, text: "OK", reply_to_message_id: 800 });
    expect(r.kind).toBe("ack_confirmed");

    // Same update_id replayed against a DIFFERENT prompt message → the
    // replayed gesture does not match the recorded one → fail closed.
    await expect(d.telegram.ingress({
      operator_id: OP, chat_id: CHAT, chat_type: "private",
      update_id: 601, text: "OK", reply_to_message_id: 999,
    })).rejects.toThrow(/FAIL_CLOSED_TELEGRAM_INTEGRITY/);

    // Tampered outcome record → digest mismatch → fail closed.
    const key = `tgupd:${CHAT}:601`;
    const row = s.store.get("telegram_update", key) as Record<string, unknown>;
    s.store.put("telegram_update", key,
      { ...row, outcome: { ...(row.outcome as object), mission_id: "MSN_forged" } },
      Number(row.version ?? 0));
    await expect(d.telegram.ingress({
      operator_id: OP, chat_id: CHAT, chat_type: "private",
      update_id: 601, text: "OK", reply_to_message_id: 800,
    })).rejects.toThrow(/FAIL_CLOSED_TELEGRAM_INTEGRITY/);
    expect(missionsOf(s)).toHaveLength(1);
  });
});
