/* Phase 1 R1 — HTTP-boundary proofs for the operational-status
 * authorization contract, exercised through the REAL
 * createMissionControlServer HTTP surface with a mocked conversation
 * invoker (zero model calls).
 *
 * F1 — a forged `x-operator-id` naming a VICTIM who owns real canonical
 *      resources can never read that victim's scope: the claimed identity
 *      is unverified, so every scoped section is `UNVERIFIED_IDENTITY`.
 * F2 — the PAIR_MC_ADMIN_TOKEN credential authenticates ONLY the
 *      operational-status boundary (conversation create/read/turns).
 *      Credentials/missions/budgets/drafts/confirms and every other /api
 *      route still require the MC token; `?token=` can never carry the
 *      admin credential.
 * F3 — a pure status question can NEVER materialize a mission draft —
 *      even when the model emits a valid PAIR_PROPOSAL trailer — and an
 *      admin-only (read_only) turn can never mint one either, while the
 *      normal proposal→draft flow on an MC-token turn still works.
 *
 * R2-F1 — a `telegram:` namespaced id claimed over the MC-token lane (or
 *      the equality-only telegram ingress) is NOT verified identity: a
 *      caller forging another chat's id receives zero victim data.
 * R2-F2 — proposal suppression is keyed on the server-derived read_only
 *      authority flag alone, never on topic/intent text: read_only turns
 *      suppress for ANY wording (false-negative proof), and an MC-token
 *      mission request that merely MENTIONS provider/cost topics still
 *      mints its draft (false-positive proof).
 *
 * R3-F1 — the read_only gate covers the REPLAY path too: a committed
 *      proposal-bearing reply retried under admin-only read authority
 *      surfaces no actionable proposal and mints nothing, while an
 *      authorized MC replay still performs crash-recovery minting.
 * R3-F2 — `read_only: true` is the explicit request contract separating
 *      read-query purpose from mission-creation purpose on the MC lane;
 *      a caller may only narrow its own authority, never widen it.
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
  MissionDraftService,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  OperationalQueryService,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  WorkforceService,
  type ConversationInvokeInput,
  type ConversationInvokeResult,
  type ConversationInvoker,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-phase1-http-"));
let counter = 0;
const NOW = "2026-10-20T00:00:00.000Z";
const OP = "op1"; // the VICTIM — owns real canonical resources
const TOK = "mc-token-aaaaaaaaaaaaaaaa";
const ADM = "adm-7f3Kx9Qp2Lw8Tz4B";
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

class MockInvoker implements ConversationInvoker {
  calls: ConversationInvokeInput[] = [];
  constructor(private fn: (i: ConversationInvokeInput) => string = () => "ok") {}
  async invoke(input: ConversationInvokeInput): Promise<ConversationInvokeResult> {
    this.calls.push(input);
    return {
      model_entry_id: input.transport.model_entry_id,
      provider_id: input.transport.provider_id,
      model_id: input.transport.model_id,
      raw_text: this.fn(input),
    };
  }
}

function statusFromPrompt(userPrompt: string): Record<string, unknown> | null {
  const m = userPrompt.match(
    /STATUS \(authorized read-only evidence\):\n(\{[\s\S]*?\})\n\nCONVERSATION/,
  );
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : null;
}

function fresh(name: string, responder?: (i: ConversationInvokeInput) => string) {
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
    tasks: [
      {
        task_key: "T1",
        title: "t1",
        task_instruction: "t1",
        required_capabilities: ["FILE_OPERATIONS"],
        depends_on: [],
      },
    ],
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
  const schedules = new MissionScheduleService(service);
  const biz = new BusinessLayer({ store, control, schedules });
  const wf = new WorkforceService({ store, business: biz });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  service.createProject({ name: "p", root_location: workspace });
  const sessions = new ConversationSessionService(store);
  const invoker = new MockInvoker(responder);
  const ops = new OperationalQueryService({
    store, control, now: () => NOW,
  });
  const reasoning = new ConversationReasoningService({
    conversation: sessions,
    store,
    invoker,
    model_entry_id: ensureConversationModel(store),
    observeOperatorContext: (req) => ops.statusForConversation(req),
  });
  const drafts = new MissionDraftService({
    conversation: sessions, control, store,
    planExpander: async (input) => ({ input }),
  });
  return {
    store, control, biz, wf, invoker,
    conversation: { sessions, reasoning, drafts },
  };
}

/** The VICTIM's canonical footprint — real resources op1 provably owns. */
function seedVictimResources(store: PairEvidenceStore) {
  const put = (entity: string, id: string, row: Record<string, unknown>) =>
    store.put(entity, id, { version: 0, ...row }, 0);
  put("business", "BIZ_V", {
    business_id: "BIZ_V", name: "victim co", project_id: "PRJ_1",
    status: "ACTIVE", created_at: NOW,
  });
  store.event({
    entity_type: "business", entity_id: "BIZ_V",
    event_type: "BUSINESS_CREATED", new_state: "ACTIVE",
    actor: `operator:${OP}`, metadata: { name: "victim co" },
  });
  put("objective", "OBJ_V", {
    objective_id: "OBJ_V", business_id: "BIZ_V",
    owner_authority_id: `operator:${OP}`, title: "victim objective",
    status: "ACTIVE", created_at: NOW,
    budget: { ceiling_microusd: 1000, consumed_microusd: 700 },
  });
  put("mission", "MSN_V", {
    mission_id: "MSN_V", project_id: "PRJ_1", goal: "victim mission",
    bound_open_id: "OPI_V", status: "CREATED", metadata: {}, created_at: NOW,
  });
  put("mission_runtime", "MRT_MSN_V", {
    mission_id: "MSN_V", state: "RUNNING", created_at: NOW,
  });
  put("work_open_binding", "OPI_V", {
    open_id: "OPI_V", mission_id: "MSN_V", work_item_id: "WI_V",
    business_id: "BIZ_V", project_id: "PRJ_1", state: "BOUND",
    created_at: NOW,
  });
  put("work_item", "WI_V", {
    work_item_id: "WI_V", business_id: "BIZ_V", title: "victim blocked",
    status: "BLOCKED", created_at: NOW,
  });
  put("provider", "PRV_V", {
    provider_id: "gemini", lifecycle_state: "ACTIVE",
    auth_state: "AUTH_OK", probe_state: "REACHABLE",
    health_state: "READY", created_at: NOW,
  });
}

async function serve(s: ReturnType<typeof fresh>) {
  const server = createMissionControlServer({
    control: s.control,
    business: s.biz,
    workforce: s.wf,
    store: s.store,
    authToken: TOK,
    adminToken: ADM,
    conversation: s.conversation,
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
const get = (port: number, p: string, h?: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: h ?? hdr() });
const post = (
  port: number,
  p: string,
  body: Record<string, unknown>,
  h?: Record<string, string>,
) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: h ?? hdr(),
    body: JSON.stringify(body),
  });
const json = async (r: Response) => ({ status: r.status, body: await r.json() as never });

async function newSession(port: number, h: Record<string, string>): Promise<string> {
  const r = await post(port, "/api/conversations", {}, h);
  const j = await json(r);
  expect(j.status).toBe(200);
  return String((j.body as { session: { session_id: string } }).session.session_id);
}

const adminHdr = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-operator-id": "operator:admin",
  authorization: `Bearer ${ADM}`,
  ...extra,
});

/* ===================================================================== */

describe("F2 — the admin credential is NOT a general API token", () => {
  it("admin token authenticates ONLY the operational-status boundary", async () => {
    const s = fresh("f2-boundary");
    seedVictimResources(s.store);
    const port = await serve(s);

    // Boundary ALLOWED: conversation create + turns with the admin bearer.
    const sid = await newSession(port, adminHdr());
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "what is PAIR doing now?" }, adminHdr()),
    );
    expect(t.status).toBe(200);
    const env = statusFromPrompt(s.invoker.calls[0]!.user_prompt)!;
    expect((env.principal as { kind: string }).kind).toBe("admin");
    // Global evidence present: the victim's mission is admin-visible.
    expect(JSON.stringify(env)).toContain("MSN_V");

    // Boundary DENIED: every other route requires the MC token.
    for (const p of ["/api/missions", "/api/cost", "/api/providers", "/api/credentials", "/api/approvals"]) {
      const r = await get(port, p, adminHdr());
      expect(r.status, `GET ${p}`).toBe(401);
    }
    for (const p of ["/api/missions", "/api/credentials", "/api/businesses", "/api/cost-policies"]) {
      const r = await post(port, p, {}, adminHdr());
      expect(r.status, `POST ${p}`).toBe(401);
    }
    // Draft/confirm surface is outside the status boundary too.
    const rDraft = await post(port, `/api/conversations/${sid}/drafts`, { goal: "x" }, adminHdr());
    expect(rDraft.status).toBe(401);
    const rClose = await post(port, `/api/conversations/${sid}/close`, {}, adminHdr());
    expect(rClose.status).toBe(401);

    // MC token still authenticates the general surface (unchanged).
    expect((await get(port, "/api/missions")).status).toBe(200);
    expect((await get(port, "/api/cost")).status).toBe(200);
    expect((await get(port, "/api/providers")).status).toBe(200);
  });

  it("the admin credential can NEVER arrive via ?token=", async () => {
    const s = fresh("f2-query");
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port, adminHdr());
    // Query-token alone (no bearer) — the gate sees no MC token → 401.
    const noBearer = { "content-type": "application/json", "x-operator-id": "operator:admin" };
    const r1 = await post(port, `/api/conversations/${sid}/turns?token=${ADM}`, { body: "status?" }, noBearer);
    expect(r1.status).toBe(401);
    // Valid MC bearer + admin token in the query → authenticated as
    // OPERATOR; the query admin credential is ignored entirely.
    const t2 = await post(
      port, `/api/conversations/${sid}/turns?token=${ADM}`,
      { body: "what is PAIR doing?" }, hdr({ "x-operator-id": "operator:admin" }),
    );
    const j2 = await json(t2);
    expect(j2.status).toBe(200);
    const env = statusFromPrompt(s.invoker.calls[0]!.user_prompt)!;
    expect((env.principal as { kind: string }).kind).toBe("operator");
    expect(JSON.stringify(env)).not.toContain("MSN_V");
  });
});

describe("F1 — forged victim operator id can never see victim resources", () => {
  it("claimed x-operator-id over HTTP gets zero scoped operational data", async () => {
    const s = fresh("f1-forged");
    seedVictimResources(s.store);
    const port = await serve(s);
    // The attacker holds only the MC token and claims the victim's id.
    const sid = await newSession(port);
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "which missions are active? any blockers?" }, hdr()),
    );
    expect(t.status).toBe(200);
    const env = statusFromPrompt(s.invoker.calls[0]!.user_prompt)!;
    const un = env.unavailable as Array<{ section: string; reason: string }>;
    expect(un).toContainEqual({ section: "active_missions", reason: "UNVERIFIED_IDENTITY" });
    expect(un).toContainEqual({ section: "attention", reason: "UNVERIFIED_IDENTITY" });
    // Zero leakage of the victim's ids into the model-visible envelope.
    const j = JSON.stringify(env);
    for (const id of ["MSN_V", "OBJ_V", "WI_V", "BIZ_V", "OPI_V"]) {
      expect(j).not.toContain(id);
    }
    // And the visible reply carries nothing either (model echoes 'ok').
    expect((t.body as { reply: { body: string } }).reply.body).not.toContain("MSN_V");
    // Zero writes beyond conversation rows.
    expect(s.store.list("conversation_mission_draft").length).toBe(0);
    expect(s.store.list("mission").length).toBe(1); // only the seeded one
  });
});

describe("F3 — a status turn can never materialize a mission draft", () => {
  it("status question + valid PAIR_PROPOSAL trailer → proposal suppressed, zero drafts", async () => {
    const s = fresh("f3-status", () =>
      `running fine\nPAIR_PROPOSAL: {"goal":"build a reporting pipeline"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port, adminHdr());
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "what is PAIR doing now?" }, adminHdr()),
    );
    expect(t.status).toBe(200);
    const body = t.body as { proposal?: unknown; reply: { body: string } };
    // The trailer was parsed out of the visible reply — and the proposal
    // was suppressed BEFORE persistence, so no draft materialized.
    expect(body.reply.body).not.toContain("PAIR_PROPOSAL");
    expect(body.proposal === undefined || body.proposal === null).toBe(true);
    expect(s.store.list("conversation_mission_draft").length).toBe(0);
    expect(s.store.list("mission").length).toBe(1);
  });

  it("normal mission flow preserved — a non-status message still mints a draft", async () => {
    const s = fresh("f3-normal", () =>
      `vâng, chuẩn bị draft\nPAIR_PROPOSAL: {"goal":"build a reporting pipeline"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port);
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "hãy build một reporting pipeline cho tôi" }, hdr()),
    );
    expect(t.status).toBe(200);
    const body = t.body as {
      proposal?: { goal: string; draft?: { draft_id: string } };
    };
    expect(body.proposal?.goal).toBe("build a reporting pipeline");
    expect(body.proposal?.draft?.draft_id).toMatch(/^MDR_/);
    expect(s.store.list("conversation_mission_draft").length).toBe(1);
  });

  it("admin-only (read_only) turns suppress proposals even for actionable text", async () => {
    const s = fresh("f3-admin-ro", () =>
      `ok\nPAIR_PROPOSAL: {"goal":"build a reporting pipeline"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port, adminHdr());
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "build a reporting pipeline for me" }, adminHdr()),
    );
    expect(t.status).toBe(200);
    const body = t.body as { proposal?: unknown };
    expect(body.proposal === undefined || body.proposal === null).toBe(true);
    expect(s.store.list("conversation_mission_draft").length).toBe(0);
  });
});

describe("R2-F1 — a forged telegram chat id over the MC lane is unverified", () => {
  it("claiming telegram:<victim_chat> via x-operator-id yields zero victim data", async () => {
    const s = fresh("r2-tg-forge");
    seedVictimResources(s.store);
    // A mission minted via a CONFIRMED draft owned by the victim chat id.
    s.store.put("mission", "MSN_TGV", {
      mission_id: "MSN_TGV", project_id: "PRJ_1", goal: "victim tg mission",
      bound_open_id: null, status: "CREATED", metadata: {},
      created_at: NOW, version: 0,
    }, 0);
    s.store.put("mission_runtime", "MRT_MSN_TGV", {
      mission_id: "MSN_TGV", state: "RUNNING", created_at: NOW, version: 0,
    }, 0);
    s.store.put("conversation_mission_draft", "CMD_TGV", {
      draft_id: "CMD_TGV", session_id: "CS_v",
      owner_operator_id: "telegram:555", mission_id: "MSN_TGV",
      state: "CONFIRMED", created_at: NOW, version: 0,
    }, 0);
    const port = await serve(s);
    // The attacker holds the MC token and CLAIMS the victim's chat id —
    // the claim mints only an `operator` principal (never `telegram`).
    const sid = await newSession(port, hdr({ "x-operator-id": "telegram:555" }));
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "which missions are active? any blockers?" },
        hdr({ "x-operator-id": "telegram:555" })),
    );
    expect(t.status).toBe(200);
    const env = statusFromPrompt(s.invoker.calls[0]!.user_prompt)!;
    expect((env.principal as { kind: string }).kind).toBe("operator");
    const un = env.unavailable as Array<{ section: string; reason: string }>;
    expect(un).toContainEqual({ section: "active_missions", reason: "UNVERIFIED_IDENTITY" });
    const j = JSON.stringify(env);
    for (const id of ["MSN_TGV", "CMD_TGV", "MSN_V", "OBJ_V", "BIZ_V"]) {
      expect(j).not.toContain(id);
    }
    expect(s.store.list("conversation_mission_draft").length).toBe(1); // seeded only
    expect(s.store.list("mission").length).toBe(2); // MSN_V + MSN_TGV
  });
});

describe("R2-F2 — proposal suppression is authority-derived, not topic-derived", () => {
  it("FALSE-NEGATIVE: read_only + unrecognized wording + trailer → zero drafts", async () => {
    const s = fresh("r2-fn", () =>
      `nothing special\nPAIR_PROPOSAL: {"goal":"build a reporting pipeline"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port, adminHdr());
    // "sitrep" matches no lexicon phrase → intents [GENERIC] — but the
    // read_only authority flag suppresses the trailer regardless.
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "give me a sitrep please" }, adminHdr()),
    );
    expect(t.status).toBe(200);
    const env = statusFromPrompt(s.invoker.calls[0]!.user_prompt)!;
    expect(env.intents).toEqual(["GENERIC"]);
    const body = t.body as { proposal?: unknown };
    expect(body.proposal === undefined || body.proposal === null).toBe(true);
    expect(s.store.list("conversation_mission_draft").length).toBe(0);
    expect(s.store.list("mission").length).toBe(1);
  });

  it("FALSE-POSITIVE: an MC mission request mentioning provider/cost still mints a draft", async () => {
    const s = fresh("r2-fp", () =>
      `vâng, chuẩn bị draft\nPAIR_PROPOSAL: {"goal":"build a reporting pipeline via gemini"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port);
    // Provider AND cost topics appear in the request — under the old
    // intent-based gate this turn would have been suppressed.
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "build a reporting pipeline that calls the gemini provider and tracks the cost" },
        hdr()),
    );
    expect(t.status).toBe(200);
    const body = t.body as {
      proposal?: { goal: string; draft?: { draft_id: string } };
    };
    expect(body.proposal?.goal).toBe("build a reporting pipeline via gemini");
    expect(body.proposal?.draft?.draft_id).toMatch(/^MDR_/);
    expect(s.store.list("conversation_mission_draft").length).toBe(1);
  });
});

describe("R3-F1 — a read-only retry can never resurrect committed proposal authority", () => {
  it("crash window: committed proposal + admin-only replay → zero drafts; authorized replay still recovers", async () => {
    const s = fresh("r3-replay", () =>
      `ok\nPAIR_PROPOSAL: {"goal":"build a reporting pipeline"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port);
    // CRASH WINDOW — the turn commits a proposal-bearing reply through
    // the reasoning service directly, so the route's draft mint never ran.
    const t0 = await s.conversation.reasoning.turn({
      session_id: sid, operator_id: OP,
      principal: { kind: "operator", operator_id: OP },
      body: "build a reporting pipeline for me",
      idempotency_key: "r3-k1",
    });
    expect(t0.proposal?.goal).toBe("build a reporting pipeline");
    expect(s.store.list("conversation_mission_draft").length).toBe(0);

    // Replay the SAME session/message/key through admin-only read
    // authority: the durable proposal must NOT be surfaced — no
    // actionable authority, zero drafts, zero missions.
    const r1 = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "build a reporting pipeline for me", idempotency_key: "r3-k1" },
        adminHdr({ "x-operator-id": OP })),
    );
    expect(r1.status).toBe(200);
    expect((r1.body as { reused?: boolean }).reused).toBe(true);
    const p1 = (r1.body as { proposal?: unknown }).proposal;
    expect(p1 === undefined || p1 === null).toBe(true);
    expect(s.store.list("conversation_mission_draft").length).toBe(0);
    expect(s.store.list("mission").length).toBe(1); // seeded only

    // Normal authorized crash-recovery preserved: an MC-token replay of
    // the same turn still surfaces the proposal and the idempotent mint
    // converges onto the draft.
    const r2 = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "build a reporting pipeline for me", idempotency_key: "r3-k1" }, hdr()),
    );
    expect(r2.status).toBe(200);
    const p2 = (r2.body as {
      proposal?: { goal: string; draft?: { draft_id: string } };
    }).proposal;
    expect(p2?.goal).toBe("build a reporting pipeline");
    expect(p2?.draft?.draft_id).toMatch(/^MDR_/);
    expect(s.store.list("conversation_mission_draft").length).toBe(1);
  });
});

describe("R3-F2 — explicit read_only request contract on the MC lane", () => {
  it("pure status request with read_only:true + proposal trailer → zero drafts", async () => {
    const s = fresh("r3-mc-ro", () =>
      `all running\nPAIR_PROPOSAL: {"goal":"build a reporting pipeline"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port);
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "what is PAIR doing now?", read_only: true }, hdr()),
    );
    expect(t.status).toBe(200);
    const b = t.body as { proposal?: unknown; reply: { body: string } };
    expect(b.reply.body).not.toContain("PAIR_PROPOSAL");
    expect(b.proposal === undefined || b.proposal === null).toBe(true);
    expect(s.store.list("conversation_mission_draft").length).toBe(0);
    expect(s.store.list("mission").length).toBe(1);
  });

  it("declared read_only wins over actionable wording — purpose is the contract", async () => {
    const s = fresh("r3-mc-ro2", () =>
      `ok\nPAIR_PROPOSAL: {"goal":"build a reporting pipeline"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port);
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "build a reporting pipeline for me", read_only: true }, hdr()),
    );
    expect(t.status).toBe(200);
    const b = t.body as { proposal?: unknown };
    expect(b.proposal === undefined || b.proposal === null).toBe(true);
    expect(s.store.list("conversation_mission_draft").length).toBe(0);
  });

  it("absent read_only keeps the governed draft flow — mixed ops wording does not revoke", async () => {
    const s = fresh("r3-mc-rw", () =>
      `vâng\nPAIR_PROPOSAL: {"goal":"pipeline with gemini provider, watch cost"}`,
    );
    seedVictimResources(s.store);
    const port = await serve(s);
    const sid = await newSession(port);
    const t = await json(
      await post(port, `/api/conversations/${sid}/turns`,
        { body: "build a pipeline using the gemini provider and track cost" }, hdr()),
    );
    expect(t.status).toBe(200);
    const b = t.body as { proposal?: { draft?: { draft_id: string } } };
    expect(b.proposal?.draft?.draft_id).toMatch(/^MDR_/);
    expect(s.store.list("conversation_mission_draft").length).toBe(1);
  });
});
