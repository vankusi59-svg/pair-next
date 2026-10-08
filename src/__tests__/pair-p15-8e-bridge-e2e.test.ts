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
interface TgCall { method: string; body: Record<string, unknown> }
class MockTgApi {
  calls: TgCall[] = [];
  updates: Record<string, unknown>[] = [];
  mid = 90000;
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
          return ok(this.updates.filter((u) =>
            Number(u.update_id) >= off).splice(0));
        }
        case "sendMessage": return ok({ message_id: ++this.mid });
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
    conversation: sessions, control, store });
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
});
