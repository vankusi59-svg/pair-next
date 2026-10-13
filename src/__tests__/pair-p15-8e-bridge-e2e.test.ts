/* P15.8-E — real bridge e2e: spawn the ACTUAL scripts/telegram-bridge.mjs
 * against (a) a mocked Telegram Bot API recorder and (b) the REAL
 * mission-control-server HTTP surface (mocked conversation invoker —
 * zero model calls). Proves the thin-adapter contract end to end:
 * poll → ingress → governed reply, callback buttons, restart cursor.
 */

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p158e-bridge-"));
const CHAT = "1882810918";
const TOK = "mc-test-token";
const servers: Server[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const s of servers) s.close();
});

/* ---- mock Telegram Bot API ------------------------------------------------ */
interface TgCall { method: string; body: Record<string, unknown>; failed?: boolean }
class MockTgApi {
  calls: TgCall[] = [];
  updates: Record<string, unknown>[] = [];
  mid = 90000;
  /** When >0, the next `failNextSends` sendMessage calls return HTTP 500 —
   *  simulates a presentation send dying mid-sequence. */
  failNextSends = 0;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const method = req.url!.split("/").pop()!;
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      this.calls.push({ method, body: parsed });
      const ok = (result: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result }));
      };
      switch (method) {
        case "getMe": return ok({ id: 1, username: "pairbot", is_bot: true });
        case "setMyCommands": return ok(true);
        case "getUpdates": {
          const off = Number(parsed.offset ?? 0);
          // Telegram semantics: updates stay until the offset confirms
          // them — an unconfirmed update is re-delivered.
          return ok(this.updates.filter((u) =>
            Number(u.update_id) >= off));
        }
        case "sendMessage": {
          if (this.failNextSends > 0) {
            this.failNextSends -= 1;
            this.calls[this.calls.length - 1]!.failed = true;
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, description: "boom" }));
            return;
          }
          return ok({ message_id: ++this.mid });
        }
        case "answerCallbackQuery": return ok(true);
        case "editMessageReplyMarkup": return ok(true);
        default: return ok(true);
      }
    });
  });
  push(u: Record<string, unknown>) { this.updates.push(u); }
  sent(chatId: string): TgCall[] {
    return this.calls.filter(
      (c) => c.method === "sendMessage" && String(c.body.chat_id) === String(chatId));
  }
  /** sendMessage calls that actually got a 200 — buttons only exist on
   *  these; a 500 attempt recorded in `calls` delivered nothing. */
  delivered(chatId: string): TgCall[] {
    return this.sent(chatId).filter((c) => !c.failed);
  }
  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, r));
    servers.push(this.server);
    return (this.server.address() as AddressInfo).port;
  }
}

/* ---- mission control stack -------------------------------------------------*/
let counter = 0;
const mockInvoker: ConversationInvoker = {
  calls: [] as ConversationInvokeInput[],
  async invoke(i: ConversationInvokeInput): Promise<ConversationInvokeResult> {
    (this as never as { calls: ConversationInvokeInput[] }).calls?.push?.(i);
    return {
      model_entry_id: i.transport.model_entry_id,
      provider_id: i.transport.provider_id,
      model_id: i.transport.model_id,
      raw_text: "PAIR trả lời mô phỏng: đã nhận " + i.user_prompt.slice(0, 60),
    };
  },
};

function stack(dir: string) {
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
    reconciliation: recon, recovery, planner });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner });
  const biz = new BusinessLayer({
    store, control, schedules: new MissionScheduleService(service) });
  const wf = new WorkforceService({ store, business: biz });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name: "p", root_location: dir });
  const sessions = new ConversationSessionService(store);
  const reasoning = new ConversationReasoningService({
    conversation: sessions, store, invoker: mockInvoker,
    model_entry_id: ensureConversationModel(store, undefined, "t") });
  const drafts = new MissionDraftService({
    conversation: sessions, control, store,
    // Phase C — same async Planner Pool seam; passthrough keeps the
    // sync test planner as the preview's plan source.
    planExpander: async (input) => ({ input }) });
  const telegram = new TelegramConversationService({
    store, conversation: sessions, drafts, reasoning });
  const server = createMissionControlServer({
    control, business: biz, workforce: wf, store, authToken: TOK,
    conversation: { sessions, reasoning, drafts, telegram } });
  return { store, server, projectId: String(project.project_id) };
}

async function waitFor(fn: () => boolean, ms = 8000, step = 80): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, step));
  }
}

async function spawnBridge(mcPort: number, tgPort: number, dir: string, log: string[]) {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "..", "scripts", "telegram-bridge.mjs")],
    {
      env: {
        ...process.env,
        PAIR_TG_BOT_TOKEN: "test-token",
        PAIR_TG_API_BASE: `http://127.0.0.1:${tgPort}/bot`,
        PAIR_MC_URL: `http://127.0.0.1:${mcPort}`,
        PAIR_MC_TOKEN: TOK,
        PAIR_MC_DIR: dir,
        PAIR_TG_ALLOW_FILE: path.join(dir, "telegram-allow.json"),
      },
    });
  children.push(child);
  child.stdout?.on("data", (d) => log.push(String(d)));
  child.stderr?.on("data", (d) => log.push(String(d)));
  await waitFor(() => log.join("").includes("bot @pairbot"));
  return child;
}

const msgUpdate = (id: number, chat: string, text: string, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  message: {
    message_id: 60000 + id,
    chat: { id: Number(chat), type: "private" },
    text,
    ...extra,
  },
});

/* ============================ TESTS ============================ */

describe("P15.8-E bridge e2e — real bridge × mock Bot API × real MC", () => {
  it("text → conversation reply (not a mission); dup update → no second turn", async () => {
    const dir = path.join(ROOT, `s${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram-allow.json"), JSON.stringify([CHAT]));
    const st = stack(dir);
    const mcPort = await new Promise<number>((r) =>
      st.server.listen(0, () => r((st.server.address() as AddressInfo).port)));
    servers.push(st.server);
    const tg = new MockTgApi();
    const tgPort = await tg.listen();
    const log: string[] = [];
    const child = await spawnBridge(mcPort, tgPort, dir, log);

    tg.push(msgUpdate(1, CHAT, "PAIR Next đang hoạt động thế nào?"));
    await waitFor(() => tg.sent(CHAT).some((c) =>
      String(c.body.text).includes("PAIR trả lời mô phỏng")));
    expect(st.store.list("mission")).toHaveLength(0);

    // At-least-once redelivery: rewind the durable offset, restart the
    // bridge, and let Telegram re-send update_id 1. The server must dedup
    // the turn — one operator message, one reply, no mission.
    child.kill("SIGKILL");
    fs.rmSync(path.join(dir, "telegram-offset.json"), { force: true });
    tg.push(msgUpdate(1, CHAT, "PAIR Next đang hoạt động thế nào?"));
    const log2: string[] = [];
    await spawnBridge(mcPort, tgPort, dir, log2);
    await waitFor(() =>
      st.store.list("conversation_message").length >= 1 &&
      tg.sent(CHAT).length >= 1, 8000);
    // give the bridge a beat to (incorrectly) process a second turn
    await new Promise((r) => setTimeout(r, 1500));
    expect(st.store.list("conversation_message").filter(
      (m) => String(m.body).includes("đang hoạt động")).length).toBe(1);
    expect(st.store.list("conversation_message").filter(
      (m) => m.role === "assistant").length).toBe(1);
    expect(st.store.list("mission")).toHaveLength(0);
  }, 20000);

  it("/draft → prompt buttons → callback confirm → exactly one mission; restart keeps binding", async () => {
    const dir = path.join(ROOT, `s${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram-allow.json"), JSON.stringify([CHAT]));
    const st = stack(dir);
    const mcPort = await new Promise<number>((r) =>
      st.server.listen(0, () => r((st.server.address() as AddressInfo).port)));
    servers.push(st.server);
    const tg = new MockTgApi();
    const tgPort = await tg.listen();
    const log: string[] = [];
    const child = await spawnBridge(mcPort, tgPort, dir, log);

    // /draft → prompt message with inline keyboard
    tg.push(msgUpdate(10, CHAT, `/draft ${st.projectId} viết báo cáo tuần`));
    await waitFor(() => tg.sent(CHAT).some((c) => c.body.reply_markup));
    const prompt = tg.sent(CHAT).find((c) => c.body.reply_markup)!;
    const kb = (prompt.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0]!;
    expect(kb[0]!.callback_data).toMatch(/^c:TGR_/);
    expect(String(prompt.body.text)).toContain("GOVERNED MISSION DRAFT");
    expect(st.store.list("mission")).toHaveLength(0);

    // Tap Confirm (callback_query) → exactly one mission
    tg.push({
      update_id: 11,
      callback_query: {
        id: "cbq1",
        message: { chat: { id: Number(CHAT), type: "private" }, message_id: 60010 },
        data: kb[0]!.callback_data,
      },
    });
    await waitFor(() =>
      st.store.list("mission").length === 1 &&
      tg.calls.some((c) => c.method === "answerCallbackQuery"));
    expect(st.store.list("mission")).toHaveLength(1);

    // Duplicate tap converges — still one mission
    tg.push({
      update_id: 12,
      callback_query: {
        id: "cbq2",
        message: { chat: { id: Number(CHAT), type: "private" }, message_id: 60010 },
        data: kb[0]!.callback_data,
      },
    });
    await waitFor(() =>
      tg.calls.filter((c) => c.method === "answerCallbackQuery").length >= 2);
    expect(st.store.list("mission")).toHaveLength(1);

    // Restart the bridge — durable offset resumes, binding persists.
    child.kill("SIGKILL");
    const log2: string[] = [];
    await spawnBridge(mcPort, tgPort, dir, log2);
    tg.push(msgUpdate(13, CHAT, "còn nhớ cuộc trò chuyện không?"));
    await waitFor(() => tg.sent(CHAT).some((c) =>
      String(c.body.text).includes("PAIR trả lời mô phỏng") &&
      String(c.body.text).includes("còn nhớ")));
    expect(fs.existsSync(path.join(dir, "telegram-offset.json"))).toBe(true);
  }, 25000);

  it("reply-bound 'OK' confirms; unbound 'OK' stays chat; unauthorized refused", async () => {
    const dir = path.join(ROOT, `s${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram-allow.json"), JSON.stringify([CHAT]));
    const st = stack(dir);
    const mcPort = await new Promise<number>((r) =>
      st.server.listen(0, () => r((st.server.address() as AddressInfo).port)));
    servers.push(st.server);
    const tg = new MockTgApi();
    const tgPort = await tg.listen();
    const log: string[] = [];
    await spawnBridge(mcPort, tgPort, dir, log);

    // unbound OK → plain conversation
    tg.push(msgUpdate(20, CHAT, "OK"));
    await waitFor(() => tg.sent(CHAT).some((c) =>
      String(c.body.text).includes("PAIR trả lời")));
    expect(st.store.list("mission")).toHaveLength(0);

    // draft → prompt msg id is the mock's mid counter; find bound prompt
    tg.push(msgUpdate(21, CHAT, `/draft ${st.projectId} test ack`));
    await waitFor(() => tg.sent(CHAT).some((c) => c.body.reply_markup));
    const promptMid = tg.mid; // sendMessage result message_id
    // "vâng" replying to the prompt → confirm
    tg.push(msgUpdate(22, CHAT, "vâng", {
      reply_to_message: { message_id: promptMid, chat: { id: Number(CHAT) } },
    }));
    await waitFor(() => st.store.list("mission").length === 1);
    expect(st.store.list("mission")).toHaveLength(1);

    // unauthorized chat → refused, nothing persisted for it
    tg.push(msgUpdate(23, "555444", "hello"));
    await waitFor(() => tg.sent("555444").some((c) =>
      String(c.body.text).includes("không có quyền")));
    expect(st.store.list("conversation_session").filter(
      (x) => String(x.owner_operator_id).includes("555444")).length).toBe(0);
  }, 25000);

  it("R1.A: crash between receive and ingress — the offset never passes the update; restart processes it exactly once", async () => {
    const dir = path.join(ROOT, `s${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram-allow.json"), JSON.stringify([CHAT]));
    const st = stack(dir);
    // Spawn the bridge against a DEAD mission-control endpoint: every
    // dispatch is an ambiguous outcome — bounded retry, then the cursor
    // must NOT advance past the update.
    const deadPort = await new Promise<number>((r) => {
      const s = http.createServer().listen(0, () => {
        const p = (s.address() as AddressInfo).port; s.close(() => r(p));
      });
    });
    const tg = new MockTgApi();
    const tgPort = await tg.listen();
    const log: string[] = [];
    const dead = await spawnBridge(deadPort, tgPort, dir, log);
    tg.push(msgUpdate(1, CHAT, "tin nhắn trước crash"));
    await waitFor(() => log.join("").includes("ambiguous"), 8000);
    // give the bounded-retry window time to exhaust
    await new Promise((r) => setTimeout(r, 2500));
    expect(fs.existsSync(path.join(dir, "telegram-offset.json"))).toBe(false);
    dead.kill("SIGKILL");

    // Restart against live MC — the uncommitted update is redelivered
    // and processed exactly once.
    const mcPort = await new Promise<number>((r) =>
      st.server.listen(0, () => r((st.server.address() as AddressInfo).port)));
    servers.push(st.server);
    const log2: string[] = [];
    await spawnBridge(mcPort, tgPort, dir, log2);
    await waitFor(() => tg.sent(CHAT).some((c) =>
      String(c.body.text).includes("PAIR trả lời mô phỏng")));
    const ops = st.store.list("conversation_message").filter(
      (m) => m.role === "operator" && String(m.body).includes("trước crash"));
    const ast = st.store.list("conversation_message").filter(
      (m) => m.role === "assistant");
    expect(ops).toHaveLength(1);
    expect(ast).toHaveLength(1);
    expect(st.store.list("mission")).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "telegram-offset.json"))).toBe(true);
  }, 30000);

  it("R1.A: replayed /new update replays the recorded outcome — one new session, stable binding", async () => {
    const dir = path.join(ROOT, `s${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram-allow.json"), JSON.stringify([CHAT]));
    const st = stack(dir);
    const mcPort = await new Promise<number>((r) =>
      st.server.listen(0, () => r((st.server.address() as AddressInfo).port)));
    servers.push(st.server);
    const tg = new MockTgApi();
    const tgPort = await tg.listen();
    const log: string[] = [];
    const child = await spawnBridge(mcPort, tgPort, dir, log);

    tg.push(msgUpdate(40, CHAT, "/new"));
    await waitFor(() => tg.sent(CHAT).some((c) =>
      String(c.body.text).includes("Phiên trò chuyện mới")));
    const boundAfterNew = String(
      (st.store.list("telegram_chat_binding")[0] as never as { session_id: string }).session_id);
    const sessions = () => st.store.list("conversation_session")
      .filter((x) => String(x.owner_operator_id) === `telegram:${CHAT}`).length;
    expect(sessions()).toBe(1); // fresh chat: the rotated session IS the only one

    // Crash + rewind the durable cursor → the SAME update redelivers.
    child.kill("SIGKILL");
    fs.rmSync(path.join(dir, "telegram-offset.json"), { force: true });
    const log2: string[] = [];
    await spawnBridge(mcPort, tgPort, dir, log2);
    await waitFor(() => tg.sent(CHAT).filter((c) =>
      String(c.body.text).includes("Phiên trò chuyện mới")).length >= 2);
    await new Promise((r) => setTimeout(r, 1000));
    // Recorded outcome replayed — NO extra session, binding unchanged.
    expect(sessions()).toBe(1);
    expect(String(
      (st.store.list("telegram_chat_binding")[0] as never as { session_id: string }).session_id))
      .toBe(boundAfterNew);
  }, 25000);

  it("R1.B: a 1,000-char goal is fully presented before Confirm exists; confirm submits the exact goal", async () => {
    const dir = path.join(ROOT, `s${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram-allow.json"), JSON.stringify([CHAT]));
    const st = stack(dir);
    const mcPort = await new Promise<number>((r) =>
      st.server.listen(0, () => r((st.server.address() as AddressInfo).port)));
    servers.push(st.server);
    const tg = new MockTgApi();
    const tgPort = await tg.listen();
    const log: string[] = [];
    await spawnBridge(mcPort, tgPort, dir, log);

    const goal = "viết báo cáo " + "x".repeat(987); // 1,000 chars
    tg.push(msgUpdate(50, CHAT, `/draft ${st.projectId} ${goal}`));
    await waitFor(() => tg.sent(CHAT).some((c) => c.body.reply_markup));
    // Every presented part together contains the COMPLETE goal.
    const parts = tg.sent(CHAT).map((c) => String(c.body.text)).join("");
    expect(parts).toContain(goal);
    expect(parts).toContain("risk ceiling");
    const prompt = tg.sent(CHAT).filter((c) => c.body.reply_markup).at(-1)!;
    const kb = (prompt.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0]!;
    tg.push({
      update_id: 51,
      callback_query: {
        id: "cbqL", data: kb[0]!.callback_data,
        message: { chat: { id: Number(CHAT), type: "private" },
          message_id: Number(prompt.body.message_id ?? 0) || 1 },
      },
    });
    await waitFor(() => st.store.list("mission").length === 1);
    const mission = st.store.list("mission")[0] as never as { goal: string };
    expect(mission.goal).toBe(goal);
  }, 25000);

  it("R1.B: presentation send failure mints no confirm authority — a forged callback cannot confirm", async () => {
    const dir = path.join(ROOT, `s${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram-allow.json"), JSON.stringify([CHAT]));
    const st = stack(dir);
    const mcPort = await new Promise<number>((r) =>
      st.server.listen(0, () => r((st.server.address() as AddressInfo).port)));
    servers.push(st.server);
    const tg = new MockTgApi();
    const tgPort = await tg.listen();
    const log: string[] = [];
    await spawnBridge(mcPort, tgPort, dir, log);

    // The first (and only) presentation send dies → no buttons are ever
    // shown → the operator never saw complete terms.
    tg.failNextSends = 1;
    tg.push(msgUpdate(60, CHAT, `/draft ${st.projectId} draft sẽ không hiển thị`));
    await waitFor(() => log.join("").includes("deliver:") ||
      st.store.list("telegram_confirm_ref").length === 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(tg.delivered(CHAT).some((c) => c.body.reply_markup)).toBe(false);
    // The minted ref stays unbound to any delivered prompt.
    const ref = st.store.list("telegram_confirm_ref")[0] as never as {
      ref_id: string; prompt_message_id: number | null };
    expect(ref.prompt_message_id).toBeNull();
    // Even a forged callback on that ref gets no authority.
    tg.push({
      update_id: 61,
      callback_query: {
        id: "cbqF", data: `c:${ref.ref_id}`,
        message: { chat: { id: Number(CHAT), type: "private" }, message_id: 1 },
      },
    });
    await waitFor(() =>
      tg.calls.some((c) => c.method === "answerCallbackQuery"), 8000);
    await new Promise((r) => setTimeout(r, 500));
    expect(st.store.list("mission")).toHaveLength(0);
    const err = tg.sent(CHAT).map((c) => String(c.body.text)).join("");
    expect(err).toContain("chưa được trình bày");
  }, 25000);

  it("R2: crash between confirm and cursor commit — redelivered ACK replays the receipt, no new turn/model call, one mission", async () => {
    const dir = path.join(ROOT, `s${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "telegram-allow.json"), JSON.stringify([CHAT]));
    const st = stack(dir);
    const mcPort = await new Promise<number>((r) =>
      st.server.listen(0, () => r((st.server.address() as AddressInfo).port)));
    servers.push(st.server);
    const tg = new MockTgApi();
    const tgPort = await tg.listen();
    const log: string[] = [];
    const child = await spawnBridge(mcPort, tgPort, dir, log);

    // draft → bound prompt → reply-bound "vâng" ack → one mission.
    tg.push(msgUpdate(70, CHAT, `/draft ${st.projectId} ack replay e2e`));
    await waitFor(() => tg.delivered(CHAT).some((c) => c.body.reply_markup));
    const promptMid = tg.mid;
    tg.push(msgUpdate(71, CHAT, "vâng", {
      reply_to_message: { message_id: promptMid, chat: { id: Number(CHAT) } },
    }));
    await waitFor(() => st.store.list("mission").length === 1);
    const ackSend = (c: TgCall) => String(c.body.text).includes("đã xác nhận");
    await waitFor(() => tg.sent(CHAT).some(ackSend));
    const msgCount = () => st.store.list("conversation_message").length;
    const before = msgCount();

    // Crash + rewind cursor — Telegram redelivers update 71. The ref is
    // already CONSUMED: the recorded outcome must replay, NOT
    // reclassify into an ordinary turn.
    child.kill("SIGKILL");
    fs.rmSync(path.join(dir, "telegram-offset.json"), { force: true });
    const log2: string[] = [];
    await spawnBridge(mcPort, tgPort, dir, log2);
    // A second (replayed) ack notification may re-send — that's at-least-
    // once delivery — but there must be NO new conversation turn and NO
    // model reply ("PAIR trả lời mô phỏng" is the invoker's text).
    await waitFor(() => tg.sent(CHAT).filter(ackSend).length >= 2, 8000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(st.store.list("mission")).toHaveLength(1);
    expect(msgCount()).toBe(before);
    expect(tg.sent(CHAT).some((c) =>
      String(c.body.text).includes("PAIR trả lời mô phỏng") &&
      String(c.body.text).includes("vâng"))).toBe(false);
  }, 25000);
});
