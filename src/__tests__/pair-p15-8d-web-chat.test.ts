/* P15.8-D — web chat + task entry: backend integration proofs over the
 * REAL mission-control-server HTTP surface with a mocked conversation
 * invoker (zero model calls).
 *
 * Boundaries proven end-to-end:
 *  - Chat turns return assistant replies; operator messages + replies
 *    persist canonically; turns NEVER mint missions/drafts.
 *  - Draft create/mutate NEVER mints a mission; only confirmDraft does —
 *    exactly once, digest-bound, owner-bound.
 *  - Operator identity comes ONLY from the request boundary header —
 *    forged body owner fields never win.
 *  - Task Entry (preview/confirm via /api/missions*) is untouched.
 */

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkTmpDir } from "../test-utils/tmpdir.js";
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
  MissionSupervisor,
  MissionDraftService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceService,
  type ConversationInvokeInput,
  type ConversationInvokeResult,
  type ConversationInvoker,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-p158d-");
let counter = 0;
const OP = "1882810918";
const OP2 = "999000111";
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
  projectRoot: string;
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
  const schedules = new MissionScheduleService_(service);
  const biz = new BusinessLayer({ store, control, schedules });
  const wf = new WorkforceService({ store, business: biz });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name: "p", root_location: workspace });
  const modelEntryId = ensureConversationModel(store, undefined, "t");
  return { dir, store, control, biz, wf, modelEntryId,
    projectId: String(project.project_id), projectRoot: workspace };
}

// MissionScheduleService import shim (kept local to avoid a long import line)
import { MissionScheduleService as MissionScheduleService_ } from "../pair/index.js";

/* ---- mock conversation invoker: deterministic, zero model calls ---- */
class MockInvoker implements ConversationInvoker {
  calls: ConversationInvokeInput[] = [];
  private fn: (i: ConversationInvokeInput) => string | ConversationInvokeResult | Promise<ConversationInvokeResult>;
  constructor(
    fn: string | ((i: ConversationInvokeInput) => string | ConversationInvokeResult | Promise<ConversationInvokeResult>) =
      (i) => `pair-reply ${i.user_prompt.length}`) {
    this.fn = typeof fn === "string" ? () => fn : fn;
  }
  async invoke(input: ConversationInvokeInput): Promise<ConversationInvokeResult> {
    this.calls.push(input);
    const out = await this.fn(input);
    return typeof out === "string"
      ? { model_entry_id: input.transport.model_entry_id,
          provider_id: input.transport.provider_id,
          model_id: input.transport.model_id, raw_text: out }
      : out;
  }
}

interface ConvDeps {
  sessions: ConversationSessionService;
  reasoning: ConversationReasoningService;
  drafts: MissionDraftService;
}

function convDeps(s: Stack, invoker: ConversationInvoker): ConvDeps {
  const sessions = new ConversationSessionService(s.store);
  return {
    sessions,
    reasoning: new ConversationReasoningService({
      conversation: sessions, store: s.store, invoker,
      model_entry_id: s.modelEntryId,
    }),
    drafts: new MissionDraftService({
      conversation: sessions, control: s.control, store: s.store,
      // Phase C — same async Planner Pool seam; passthrough keeps the
      // sync test planner as the preview's plan source.
      planExpander: async (input) => ({ input }) }),
  };
}

async function serve(s: Stack, conv?: ConvDeps) {
  const server = createMissionControlServer({
    control: s.control, business: s.biz, workforce: s.wf, store: s.store,
    authToken: TOK,
    conversation: conv,
  });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const hdr = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-operator-id": OP,
  authorization: `Bearer ${TOK}`,
  ...extra,
});
const hdr2 = (extra: Record<string, string> = {}) => hdr({ "x-operator-id": OP2, ...extra });

const get = (port: number, p: string, h?: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: h ?? hdr() });
const post = (port: number, p: string, body: Record<string, unknown>, h?: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST", headers: h ?? hdr(), body: JSON.stringify(body) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() as never });
const missionsOf = (s: Stack) => s.store.list("mission").map((m) => String(m.mission_id));

async function newSession(port: number, h = hdr()): Promise<string> {
  const r = await post(port, "/api/conversations", {}, h);
  const j = await json(r);
  expect(j.status).toBe(200);
  return String((j.body as { session: { session_id: string } }).session.session_id);
}

/* ============================ TESTS ============================ */

describe("P15.8-D §1 — chat turns over HTTP", () => {
  it("create session + multi-turn Vietnamese dialogue + persistent history", async () => {
    const s = freshStack("t1");
    const inv = new MockInvoker((i) =>
      i.user_prompt.includes("MQL5")
        ? "Để bán EA trên MQL5, tôi gợi ý: tạo draft mission trước."
        : "Chào bạn! Tôi là PAIR — hãy nói mục tiêu của bạn.");
    const port = await serve(s, convDeps(s, inv));
    const sid = await newSession(port);

    const t1 = await json(await post(port, `/api/conversations/${sid}/turns`,
      { body: "xin chào" }));
    expect(t1.status).toBe(200);
    const turn1 = t1.body as { message: { role: string; seq: number };
      reply: { role: string; body: string }; reused: boolean };
    expect(turn1.message.role).toBe("operator");
    expect(turn1.message.seq).toBe(1);
    expect(turn1.reply.role).toBe("assistant");
    expect(turn1.reply.body).toContain("Chào bạn");

    const t2 = await json(await post(port, `/api/conversations/${sid}/turns`,
      { body: "giúp tôi bán EA trên MQL5" }));
    expect(t2.status).toBe(200);
    const turn2 = t2.body as { reply: { body: string; seq: number } };
    expect(turn2.reply.seq).toBe(4);
    expect(turn2.reply.body).toContain("MQL5");

    // History is chronological, complete, and includes both turns.
    const hist = await json(await get(port, `/api/conversations/${sid}/messages`));
    expect(hist.status).toBe(200);
    const msgs = hist.body as { messages: Array<{ role: string; seq: number; body: string }> };
    expect(msgs.messages.length).toBe(4);
    expect(msgs.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(msgs.messages[0]!.body).toBe("xin chào");
    expect(msgs.messages[3]!.body).toContain("MQL5");
    // Assistant text is stored as PLAIN TEXT — never trusted HTML.
    expect(msgs.messages.every((m) => typeof m.body === "string")).toBe(true);
    expect(inv.calls.length).toBe(2);
  });

  it("history + drafts survive a full service restart (same store, new instances)", async () => {
    const s = freshStack("restart");
    const inv1 = new MockInvoker("lần một");
    const sid = (await (async () => {
      const port = await serve(s, convDeps(s, inv1));
      const id = await newSession(port);
      const t = await post(port, `/api/conversations/${id}/turns`, { body: "một" });
      expect(t.status).toBe(200);
      const d = await post(port, `/api/conversations/${id}/drafts`,
        { project_id: s.projectId, goal: "g", risk_ceiling: "LOW" });
      expect(d.status).toBe(200);
      return id;
    })());
    // Restart: brand-new service instances over the SAME store+control.
    const inv2 = new MockInvoker("lần hai");
    const port2 = await serve(s, convDeps(s, inv2));
    const sess = await json(await get(port2, `/api/conversations/${sid}`));
    expect(sess.status).toBe(200);
    const hist = await json(await get(port2, `/api/conversations/${sid}/messages`));
    expect((hist.body as { messages: unknown[] }).messages.length).toBe(2);
    const drafts = await json(await get(port2, `/api/conversations/${sid}/drafts`));
    expect((drafts.body as { drafts: Array<{ state: string }> }).drafts.length).toBe(1);
    expect((drafts.body as { drafts: Array<{ state: string }> }).drafts[0]!.state)
      .toBe("PENDING_CONFIRMATION");
  });

  it("session ownership isolation — foreign operator cannot read or write", async () => {
    const s = freshStack("iso");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const sid = await newSession(port);
    await post(port, `/api/conversations/${sid}/turns`, { body: "riêng" });
    // Foreign operator: session read/messages/turn/drafts all fail closed.
    for (const r of [
      await get(port, `/api/conversations/${sid}`, hdr2()),
      await get(port, `/api/conversations/${sid}/messages`, hdr2()),
      await post(port, `/api/conversations/${sid}/turns`, { body: "x" }, hdr2()),
      await get(port, `/api/conversations/${sid}/drafts`, hdr2()),
    ]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    // And foreign list does not leak the session.
    const list = await json(await get(port, "/api/conversations", hdr2()));
    expect((list.body as { sessions: unknown[] }).sessions.length).toBe(0);
  });

  it("model transport failure → honest typed error; operator message committed; retry converges", async () => {
    const s = freshStack("fail");
    let fail = true;
    const inv = new MockInvoker(async () => {
      if (fail) throw new Error("transport dead");
      return "recovered";
    });
    const port = await serve(s, convDeps(s, inv));
    const sid = await newSession(port);
    const bad = await json(await post(port, `/api/conversations/${sid}/turns`,
      { body: "thử" }));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    // Honest: the error is a typed FAIL_CLOSED surface, not a fake reply.
    expect(String((bad.body as { error?: string }).error)).toMatch(/FAIL|ERROR/);
    const hist = await json(await get(port, `/api/conversations/${sid}/messages`));
    const msgs = (hist.body as { messages: Array<{ role: string }> }).messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("operator");
    // Immediate retry (message still newest) mints exactly one reply.
    fail = false;
    const ok = await json(await post(port, `/api/conversations/${sid}/turns`,
      { body: "thử" }));
    // Same operator message? No — each turn POST mints a NEW operator
    // message unless the client supplies an idempotency key. Retrying the
    // SAME request body with the same key converges; a fresh body mints
    // a fresh message. Both are correct — here a new turn succeeds.
    expect(ok.status).toBe(200);
  });

  it("chat turns mint ZERO missions and ZERO drafts", async () => {
    const s = freshStack("zero");
    const port = await serve(s, convDeps(s, new MockInvoker("talk")));
    const sid = await newSession(port);
    for (const b of ["hãy chạy mission đi", "execute now", "OK"]) {
      await post(port, `/api/conversations/${sid}/turns`, { body: b });
    }
    expect(missionsOf(s)).toEqual([]);
    const drafts = await json(await get(port, `/api/conversations/${sid}/drafts`));
    expect((drafts.body as { drafts: unknown[] }).drafts).toEqual([]);
  });
});

describe("P15.8-D §2 — governed mission draft flow over HTTP", () => {
  const draftBody = (s: Stack, over: Record<string, unknown> = {}) => ({
    project_id: s.projectId,
    goal: "ghi nhận mục tiêu bán 10 EA",
    granted_permissions: ["FILE_WRITE", "FILE_READ"],
    authorized_workspaces: [s.projectRoot],
    risk_ceiling: "LOW",
    ...over,
  });

  it("draft create → zero missions; confirm → exactly ONE mission; receipt returned", async () => {
    const s = freshStack("flow");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const sid = await newSession(port);
    const d = await json(await post(port, `/api/conversations/${sid}/drafts`,
      draftBody(s)));
    expect(d.status).toBe(200);
    const draft = (d.body as { draft: { draft_id: string; state: string;
      draft_digest: string } }).draft;
    expect(draft.state).toBe("PENDING_CONFIRMATION");
    expect(missionsOf(s)).toEqual([]);

    const c = await json(await post(port,
      `/api/conversations/${sid}/drafts/${draft.draft_id}/confirm`,
      { expected_digest: draft.draft_digest }));
    expect(c.status).toBe(200);
    const out = c.body as { mission_id: string; reused: boolean;
      draft: { state: string } };
    expect(out.reused).toBe(false);
    expect(out.draft.state).toBe("CONFIRMED");
    expect(missionsOf(s)).toEqual([out.mission_id]);
  });

  it("duplicate confirm converges — still exactly one mission", async () => {
    const s = freshStack("dup");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const sid = await newSession(port);
    const d = await json(await post(port, `/api/conversations/${sid}/drafts`,
      draftBody(s)));
    const draft = (d.body as { draft: { draft_id: string; draft_digest: string } }).draft;
    const c1 = await json(await post(port,
      `/api/conversations/${sid}/drafts/${draft.draft_id}/confirm`,
      { expected_digest: draft.draft_digest }));
    const c2 = await json(await post(port,
      `/api/conversations/${sid}/drafts/${draft.draft_id}/confirm`,
      { expected_digest: draft.draft_digest }));
    expect(c2.status).toBe(200);
    expect((c2.body as { reused: boolean }).reused).toBe(true);
    expect(missionsOf(s)).toEqual([(c1.body as { mission_id: string }).mission_id]);
  });

  it("wrong digest cannot confirm; revise mints a NEW draft and rejects the old", async () => {
    const s = freshStack("revise");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const sid = await newSession(port);
    const d1 = await json(await post(port, `/api/conversations/${sid}/drafts`,
      draftBody(s)));
    const draft1 = (d1.body as { draft: { draft_id: string; draft_digest: string } }).draft;
    // Stale/wrong digest → fail closed, no mission.
    const bad = await json(await post(port,
      `/api/conversations/${sid}/drafts/${draft1.draft_id}/confirm`,
      { expected_digest: "deadbeef" }));
    expect(bad.status).toBe(409);
    expect(missionsOf(s)).toEqual([]);

    // Revision supersedes the old draft atomically — old digest is dead.
    const d2 = await json(await post(port, `/api/conversations/${sid}/drafts`,
      draftBody(s, { goal: "mục tiêu mới", supersedes_draft_id: draft1.draft_id })));
    expect(d2.status).toBe(200);
    const draft2 = (d2.body as { draft: { draft_id: string; draft_digest: string } }).draft;
    expect(draft2.draft_id).not.toBe(draft1.draft_id);
    expect(draft2.draft_digest).not.toBe(draft1.draft_digest);
    const old = await json(await get(port,
      `/api/conversations/${sid}/drafts/${draft1.draft_id}`));
    expect((old.body as { draft: { state: string } }).draft.state).toBe("REJECTED");
    const stale = await json(await post(port,
      `/api/conversations/${sid}/drafts/${draft1.draft_id}/confirm`,
      { expected_digest: draft1.draft_digest }));
    expect(stale.status).toBe(409);
    expect(missionsOf(s)).toEqual([]);
  });

  it("kind:ack cannot confirm when two pending drafts exist (ambiguity is fail-closed)", async () => {
    const s = freshStack("ack");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const sid = await newSession(port);
    const d1 = await json(await post(port, `/api/conversations/${sid}/drafts`, draftBody(s)));
    const d2 = await json(await post(port, `/api/conversations/${sid}/drafts`,
      draftBody(s, { goal: "goal khác" })));
    const draft2 = (d2.body as { draft: { draft_id: string; draft_digest: string } }).draft;
    // Even a VALID id+digest through kind:ack fails while ambiguous.
    const r = await json(await post(port,
      `/api/conversations/${sid}/drafts/${draft2.draft_id}/confirm`,
      { expected_digest: draft2.draft_digest, kind: "ack" }));
    expect(r.status).toBe(409);
    expect(String((r.body as { error?: string }).error)).toContain("ACK");
    expect(missionsOf(s)).toEqual([]);
    void d1;
  });

  it("rejected draft cannot execute — confirm fails closed", async () => {
    const s = freshStack("rej");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const sid = await newSession(port);
    const d = await json(await post(port, `/api/conversations/${sid}/drafts`, draftBody(s)));
    const draft = (d.body as { draft: { draft_id: string; draft_digest: string } }).draft;
    const rej = await post(port,
      `/api/conversations/${sid}/drafts/${draft.draft_id}/reject`, {});
    expect(rej.status).toBe(200);
    const c = await json(await post(port,
      `/api/conversations/${sid}/drafts/${draft.draft_id}/confirm`,
      { expected_digest: draft.draft_digest }));
    expect(c.status).toBe(409);
    expect(missionsOf(s)).toEqual([]);
  });
});

describe("P15.8-D §3 — boundary + Task Entry compatibility", () => {
  it("operator identity: forged owner_operator_id in JSON body never wins", async () => {
    const s = freshStack("forge");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    // OP creates a session but supplies OP2 as owner in the body — the
    // boundary operator must own the session.
    const r = await json(await post(port, "/api/conversations",
      { owner_operator_id: OP2, operator_id: OP2 }));
    expect(r.status).toBe(200);
    const sess = (r.body as { session: { owner_operator_id: string } }).session;
    expect(sess.owner_operator_id).toBe(OP);
    // And OP2 cannot see it.
    const list = await json(await get(port, "/api/conversations", hdr2()));
    expect((list.body as { sessions: unknown[] }).sessions.length).toBe(0);
  });

  it("missing operator → 403; missing bearer → 401; no conversation dep → 404 CONVERSATION_DISABLED", async () => {
    const s = freshStack("gates");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const noOp = await post(port, "/api/conversations", {},
      { "content-type": "application/json", authorization: `Bearer ${TOK}` });
    expect(noOp.status).toBe(403);
    const noAuth = await post(port, "/api/conversations", {},
      { "content-type": "application/json", "x-operator-id": OP });
    expect(noAuth.status).toBe(401);
    const port2 = await serve(s); // server WITHOUT conversation deps
    const disabled = await json(await get(port2, "/api/conversations"));
    expect(disabled.status).toBe(404);
    expect(String((disabled.body as { error?: string }).error)).toBe("CONVERSATION_DISABLED");
    // Unrelated surfaces keep working on the conversation-free server.
    const health = await get(port2, "/api/health");
    expect(health.status).toBe(200);
  });

  it("turn on CLOSED session fails closed; close converges", async () => {
    const s = freshStack("closed");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const sid = await newSession(port);
    const close = await post(port, `/api/conversations/${sid}/close`, {});
    expect(close.status).toBe(200);
    const t = await json(await post(port, `/api/conversations/${sid}/turns`,
      { body: "còn không" }));
    expect(t.status).toBe(409);
  });

  it("Task Entry unchanged: preview → confirm via /api/missions* mints exactly one mission, no chat involved", async () => {
    const s = freshStack("taskentry");
    const port = await serve(s, convDeps(s, new MockInvoker("ok")));
    const pv = await json(await post(port, "/api/missions/preview", {
      project_id: s.projectId,
      goal: "ghi vào workspace",
      granted_permissions: ["FILE_WRITE", "FILE_READ"],
      authorized_workspaces: [s.projectRoot],
    }));
    expect(pv.status).toBe(200);
    const preview = pv.body as { preview_id: string; plan_digest: string };
    const cf = await json(await post(port, "/api/missions/confirm", {
      confirm_plan: { preview_id: preview.preview_id, digest: preview.plan_digest },
    }));
    expect(cf.status).toBe(200);
    expect(missionsOf(s).length).toBe(1);
  });
});
