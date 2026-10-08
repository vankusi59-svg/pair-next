/**
 * P15.8-C — mission draft + conversational confirmation authority.
 * The 16 mandated cases: drafts never execute, explicit confirmation
 * mints ONE mission through the canonical preview path, every failure
 * mode closes, and direct Task Entry is untouched.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PairEvidenceStore,
  PairControlPlane,
  GovernedTaskGate,
  ExecutorRegistry,
  MissionRouter,
  RecoveryController,
  ReconciliationService,
  ApprovalQueue,
  MissionScheduler,
  MissionRuntime,
  MissionSupervisor,
  MissionObservability,
  MissionControl,
  ConversationSessionService,
  MissionDraftService,
  MISSION_DRAFT_ENTITY,
  type ExecutorAdapter,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p15-8c-"));
let counter = 0;
const OP = "operator:owner-1";
const FOREIGN = "operator:intruder";

const T1 = {
  task_key: "T1", title: "t1", task_instruction: "t1",
  required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
};

function makeCtx(n: string, opts: {
  planner?: (i: { mission: Record<string, unknown> }) => unknown;
  now?: () => string;
} = {}) {
  const dir = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
  const dbPath = path.join(dir, "pair.db");
  const store = new PairEvidenceStore(dbPath);
  const service = new PairControlPlane(store);
  const gate = new GovernedTaskGate(service);
  const registry = new ExecutorRegistry(service);
  const router = new MissionRouter(service, gate);
  const recovery = new RecoveryController(service);
  const adapters = new Map<string, ExecutorAdapter>();
  const recon = new ReconciliationService(service, adapters as never);
  const approvals = new ApprovalQueue(service);
  const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
  const plannerCalls: Array<Record<string, unknown>> = [];
  const planner = opts.planner ?? ((input: { mission: Record<string, unknown> }) => {
    plannerCalls.push(input.mission);
    return { tasks: [T1] };
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters: adapters as never, scheduler, approvals,
    reconciliation: recon, recovery, planner: planner as never,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability: new MissionObservability(service),
    planner: planner as never,
  });
  service.registerCapability("FILE_OPERATIONS", { risk_class: "LOW" });
  const project = service.createProject({ name: n, root_location: workspace });
  const conv = new ConversationSessionService(store);
  const drafts = new MissionDraftService({
    conversation: conv, control, store, ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    dir, dbPath, workspace, store, service, control, conv, drafts,
    plannerCalls, projectId: String(project.project_id),
  };
}

function mkSession(ctx: ReturnType<typeof makeCtx>, owner = OP) {
  const s = ctx.conv.createSession({ owner_operator_id: owner, title: "chat" });
  return String(s.session_id);
}

function mkDraft(ctx: ReturnType<typeof makeCtx>, sessionId: string, goal = "viết bài blog") {
  return ctx.drafts.createDraft({
    session_id: sessionId, operator_id: OP,
    project_id: ctx.projectId, goal,
  });
}

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error("expected failure");
};
const codeAsync = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { return (e as Error).message; }
  throw new Error("expected failure");
};

const missionCount = (ctx: ReturnType<typeof makeCtx>) =>
  ctx.store.list("mission").length;

describe("P15.8-C — mission confirmation", () => {
  it("1. draft creation mints zero missions", async () => {
    const ctx = makeCtx("create-zero");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    expect(d.state).toBe("PENDING_CONFIRMATION");
    expect(d.draft_digest).toBeTruthy();
    expect(d.mission_id).toBeNull();
    expect(missionCount(ctx)).toBe(0);
    // An ordinary conversation message about it is still just text.
    ctx.conv.appendMessage({ session_id: sid, operator_id: OP, body: "làm đi" });
    expect(missionCount(ctx)).toBe(0);
  });

  it("2. valid explicit confirmation → exactly ONE mission via governed path", async () => {
    const ctx = makeCtx("confirm-one");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    const r = await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    });
    expect(r.reused).toBe(false);
    expect(missionCount(ctx)).toBe(1);
    expect(r.mission.goal).toBe("viết bài blog");
    // Canonical preview provenance — pinned_plan binds the mission.
    const meta = r.mission.metadata as Record<string, unknown>;
    const pinned = meta.pinned_plan as Record<string, unknown>;
    expect(String(pinned.preview_id)).toBe(r.draft.preview_id);
    expect(r.draft.state).toBe("CONFIRMED");
    expect(r.draft.mission_id).toBe(r.mission_id);
    // mission_origin operator provenance preserved.
    const origin = meta.mission_origin as Record<string, unknown>;
    expect(String(origin.operator_id)).toBe(OP);
    expect(ctx.plannerCalls.length).toBe(1);
  });

  it("3. duplicate confirmation converges to the same mission", async () => {
    const ctx = makeCtx("confirm-dup");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    const r1 = await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    });
    const r2 = await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    });
    expect(r2.reused).toBe(true);
    expect(r2.mission_id).toBe(r1.mission_id);
    expect(missionCount(ctx)).toBe(1);
    expect(ctx.plannerCalls.length).toBe(1); // no re-plan on replay
  });

  it("4. concurrent confirmations cannot create duplicate missions", async () => {
    const ctx = makeCtx("confirm-conc");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    const [a, b, c] = await Promise.all([
      ctx.drafts.confirmDraft({ session_id: sid, operator_id: OP, draft_id: d.draft_id, expected_digest: d.draft_digest }),
      ctx.drafts.confirmDraft({ session_id: sid, operator_id: OP, draft_id: d.draft_id, expected_digest: d.draft_digest }),
      ctx.drafts.confirmDraft({ session_id: sid, operator_id: OP, draft_id: d.draft_id, expected_digest: d.draft_digest }),
    ]);
    expect(a.mission_id).toBe(b.mission_id);
    expect(b.mission_id).toBe(c.mission_id);
    expect(missionCount(ctx)).toBe(1);
    expect(ctx.plannerCalls.length).toBe(1);
  });

  it("5. wrong operator or wrong session is rejected", async () => {
    const ctx = makeCtx("wrong-party");
    const sid = mkSession(ctx);
    const other = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    expect(await codeAsync(() => ctx.drafts.confirmDraft({
      session_id: sid, operator_id: FOREIGN,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    }))).toContain("FAIL_CLOSED_CONVERSATION_FORBIDDEN");
    expect(await codeAsync(() => ctx.drafts.confirmDraft({
      session_id: other, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_MEMBERSHIP");
    expect(missionCount(ctx)).toBe(0);
  });

  it("6. wrong digest is rejected", async () => {
    const ctx = makeCtx("wrong-digest");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    expect(await codeAsync(() => ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: "deadbeef",
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_DIGEST_MISMATCH");
    expect(missionCount(ctx)).toBe(0);
    // Even a CONFIRMED draft re-checks the digest — a tampered confirm
    // can never ride on a stale receipt.
    const r = await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    });
    expect(missionCount(ctx)).toBe(1);
    expect(await codeAsync(() => ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: "deadbeef",
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_DIGEST_MISMATCH");
  });

  it("7. revision invalidates the old confirmation authority", async () => {
    const ctx = makeCtx("revise");
    const sid = mkSession(ctx);
    const old = mkDraft(ctx, sid, "bản nháp cũ");
    const neu = ctx.drafts.createDraft({
      session_id: sid, operator_id: OP,
      project_id: ctx.projectId, goal: "bản nháp mới",
      supersedes_draft_id: old.draft_id,
    });
    expect(neu.supersedes_draft_id).toBe(old.draft_id);
    const oldAfter = ctx.drafts.getDraft({ session_id: sid, operator_id: OP, draft_id: old.draft_id });
    expect(oldAfter.state).toBe("REJECTED");
    expect(await codeAsync(() => ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: old.draft_id, expected_digest: old.draft_digest,
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_STATE");
    expect(missionCount(ctx)).toBe(0);
    // The new draft confirms independently.
    const r = await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: neu.draft_id, expected_digest: neu.draft_digest,
    });
    expect(r.mission.goal).toBe("bản nháp mới");
  });

  it("8. rejected and expired drafts cannot submit", async () => {
    const ctx = makeCtx("terminal");
    const sid = mkSession(ctx);
    const d1 = mkDraft(ctx, sid);
    ctx.drafts.rejectDraft({ session_id: sid, operator_id: OP, draft_id: d1.draft_id });
    expect(await codeAsync(() => ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d1.draft_id, expected_digest: d1.draft_digest,
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_STATE");

    // Expiry — clock advances past ttl.
    let now = "2026-10-06T00:00:00.000Z";
    const ctx2 = makeCtx("expired", { now: () => now });
    const sid2 = mkSession(ctx2);
    const d2 = mkDraft(ctx2, sid2);
    now = "2026-10-06T02:00:00.000Z"; // > 3600s later
    expect(await codeAsync(() => ctx2.drafts.confirmDraft({
      session_id: sid2, operator_id: OP,
      draft_id: d2.draft_id, expected_digest: d2.draft_digest,
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_STATE");
    const after = ctx2.drafts.getDraft({ session_id: sid2, operator_id: OP, draft_id: d2.draft_id });
    expect(after.state).toBe("EXPIRED");
    expect(missionCount(ctx)).toBe(0);
    expect(missionCount(ctx2)).toBe(0);
  });

  it("9. closed-session confirmation fails closed", async () => {
    const ctx = makeCtx("closed");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    ctx.conv.closeSession(sid, { operator_id: OP });
    expect(await codeAsync(() => ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_SESSION_CLOSED");
    // New drafts in the closed session fail too.
    expect(code(() => mkDraft(ctx, sid))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_SESSION_CLOSED");
    expect(missionCount(ctx)).toBe(0);
  });

  it("10. ordinary 'OK'/'làm đi' without a unique pending proposal → zero missions", async () => {
    const ctx = makeCtx("ack-none");
    const sid = mkSession(ctx);
    ctx.conv.appendMessage({ session_id: sid, operator_id: OP, body: "OK" });
    ctx.conv.appendMessage({ session_id: sid, operator_id: OP, body: "làm đi" });
    expect(code(() => ctx.drafts.resolveAcknowledgement({ session_id: sid, operator_id: OP })))
      .toContain("FAIL_CLOSED_CONVERSATION_ACK_NONE");
    // Two competing pending drafts → ambiguous, still zero.
    mkDraft(ctx, sid, "việc A");
    mkDraft(ctx, sid, "việc B");
    ctx.conv.appendMessage({ session_id: sid, operator_id: OP, body: "xác nhận" });
    expect(code(() => ctx.drafts.resolveAcknowledgement({ session_id: sid, operator_id: OP })))
      .toContain("FAIL_CLOSED_CONVERSATION_ACK_AMBIGUOUS");
    expect(missionCount(ctx)).toBe(0);
  });

  it("11. AI-generated confirmation text creates zero missions", async () => {
    const ctx = makeCtx("ai-confirm");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    // An assistant-role message that LOOKS like consent is still just a
    // row — no authority. Only the operator/digest-bound op mints.
    ctx.conv.internalWriter().appendMessage({
      session_id: sid, role: "assistant", body: "Tôi xác nhận thay bạn — đã gửi mission.",
    });
    expect(missionCount(ctx)).toBe(0);
    // A forged confirm without the real digest never runs.
    expect(await codeAsync(() => ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: "ai-fabricated",
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_DIGEST_MISMATCH");
    expect(missionCount(ctx)).toBe(0);
  });

  it("12. confirmation cannot invent permissions, workspaces or delivery authority", async () => {
    const ctx = makeCtx("no-fabrication");
    const sid = mkSession(ctx);
    // Workspace authority is canonicalized at creation — raw caller
    // text can never persist as authority, and malformed values fail.
    const d = ctx.drafts.createDraft({
      session_id: sid, operator_id: OP,
      project_id: ctx.projectId, goal: "g",
      authorized_workspaces: ["relative/../escape"],
    });
    expect(d.authorized_workspaces).toEqual([path.resolve("relative/../escape")]);
    expect(code(() => ctx.drafts.createDraft({
      session_id: sid, operator_id: OP,
      project_id: ctx.projectId, goal: "g",
      authorized_workspaces: [""],
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_FIELD");
    // Non-canonical risk ceiling likewise.
    expect(code(() => ctx.drafts.createDraft({
      session_id: sid, operator_id: OP,
      project_id: ctx.projectId, goal: "g",
      risk_ceiling: "UNLIMITED_GODMODE",
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_FIELD");
    // A project that doesn't exist can't be claimed.
    expect(code(() => ctx.drafts.createDraft({
      session_id: sid, operator_id: OP,
      project_id: "PRJ_fabricated", goal: "g",
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_PROJECT");
    expect(missionCount(ctx)).toBe(0);
  });

  it("13. submission failure → truthful durable state, retry recovers", async () => {
    let calls = 0;
    const ctx = makeCtx("submit-fail", {
      planner: () => {
        calls++;
        if (calls === 1) throw new Error("planner offline");
        return { tasks: [T1] };
      },
    });
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    await expect(ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    })).rejects.toThrow("planner offline");
    // The claim is durable — SUBMITTING tells the truth, no mission.
    const mid = ctx.drafts.getDraft({ session_id: sid, operator_id: OP, draft_id: d.draft_id });
    expect(mid.state).toBe("SUBMITTING");
    expect(mid.mission_id).toBeNull();
    expect(missionCount(ctx)).toBe(0);
    // Retry resumes the SAME draft — claims don't stack.
    const r = await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    });
    expect(r.reused).toBe(false);
    expect(missionCount(ctx)).toBe(1);
    expect(calls).toBe(2);
  });

  it("14. restart preserves draft state, confirmation identity and receipt", async () => {
    const ctx = makeCtx("restart");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    const r = await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    });
    // New service instances over the same db.
    const store2 = new PairEvidenceStore(ctx.dbPath);
    const conv2 = new ConversationSessionService(store2);
    const drafts2 = new MissionDraftService({ conversation: conv2, control: ctx.control, store: store2 });
    const row = drafts2.getDraft({ session_id: sid, operator_id: OP, draft_id: d.draft_id });
    expect(row.state).toBe("CONFIRMED");
    expect(row.mission_id).toBe(r.mission_id);
    const r2 = await drafts2.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    });
    expect(r2.reused).toBe(true);
    expect(r2.mission_id).toBe(r.mission_id);
    expect(ctx.plannerCalls.length).toBe(1);
    expect(ctx.store.list("mission").length).toBe(1);
  });

  it("15. successful-confirmation replay never re-invokes the planner", async () => {
    const ctx = makeCtx("no-replan");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: d.draft_id, expected_digest: d.draft_digest,
    });
    expect(ctx.plannerCalls.length).toBe(1);
    for (let i = 0; i < 3; i++) {
      const r = await ctx.drafts.confirmDraft({
        session_id: sid, operator_id: OP,
        draft_id: d.draft_id, expected_digest: d.draft_digest,
      });
      expect(r.reused).toBe(true);
    }
    expect(ctx.plannerCalls.length).toBe(1);
    expect(missionCount(ctx)).toBe(1);
  });

  it("16. direct Task Entry still submits missions without conversation confirmation", () => {
    const ctx = makeCtx("task-entry");
    const m = ctx.control.startMission({
      project_id: ctx.projectId, goal: "direct task entry",
    });
    expect(String(m.mission_id)).toMatch(/^MSN_/);
    expect(missionCount(ctx)).toBe(1);
    // And it never touches the draft ledger.
    expect(ctx.store.list(MISSION_DRAFT_ENTITY).length).toBe(0);
  });

  it("ack path: unique pending draft resolves to its exact identity", async () => {
    const ctx = makeCtx("ack-bind");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    const target = ctx.drafts.resolveAcknowledgement({ session_id: sid, operator_id: OP });
    expect(target.draft_id).toBe(d.draft_id);
    expect(target.draft_digest).toBe(d.draft_digest);
    const r = await ctx.drafts.confirmDraft({
      session_id: sid, operator_id: OP,
      draft_id: target.draft_id, expected_digest: target.draft_digest, kind: "ack",
    });
    expect(r.draft.confirmation_kind).toBe("ack");
    expect(missionCount(ctx)).toBe(1);
  });

  it("adversarial: forged draft row fails closed on every read", async () => {
    const ctx = makeCtx("forged");
    const sid = mkSession(ctx);
    const d = mkDraft(ctx, sid);
    const row = ctx.store.get(MISSION_DRAFT_ENTITY, d.draft_id);
    ctx.store.put(MISSION_DRAFT_ENTITY, d.draft_id, {
      ...row, goal: "goal đã bị sửa",
    } as Record<string, unknown>, Number(row.version));
    expect(code(() => ctx.drafts.getDraft({ session_id: sid, operator_id: OP, draft_id: d.draft_id })))
      .toContain("FAIL_CLOSED_CONVERSATION_DRAFT_DIGEST");
  });

  it("adversarial: foreign-session supersede is rejected", () => {
    const ctx = makeCtx("xsupersede");
    const sid = mkSession(ctx);
    const other = mkSession(ctx, OP);
    const d = mkDraft(ctx, sid);
    expect(code(() => ctx.drafts.createDraft({
      session_id: other, operator_id: OP,
      project_id: ctx.projectId, goal: "g2",
      supersedes_draft_id: d.draft_id,
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_MEMBERSHIP");
  });

  it("adversarial: create replay via client_request_id converges", () => {
    const ctx = makeCtx("create-idem");
    const sid = mkSession(ctx);
    const a = ctx.drafts.createDraft({
      session_id: sid, operator_id: OP, project_id: ctx.projectId,
      goal: "g", client_request_id: "req-1",
    });
    const b = ctx.drafts.createDraft({
      session_id: sid, operator_id: OP, project_id: ctx.projectId,
      goal: "g", client_request_id: "req-1",
    });
    expect(b.draft_id).toBe(a.draft_id);
    // Same request id, different terms → conflict.
    expect(code(() => ctx.drafts.createDraft({
      session_id: sid, operator_id: OP, project_id: ctx.projectId,
      goal: "different", client_request_id: "req-1",
    }))).toContain("FAIL_CLOSED_CONVERSATION_DRAFT_IDEMPOTENCY_CONFLICT");
  });
});
