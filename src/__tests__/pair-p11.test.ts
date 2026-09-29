/**
 * P11 SOLO BUSINESS HARDENING regressions — scope integrity, work-item
 * lifecycle, claim integrity, single-dispatch dedup, routine projection,
 * budget hard-stop, credential broker boundaries, evidence integrity.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  BusinessLayer,
  CredentialBroker,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  ReconciliationService,
  RecoveryController,
  createMissionControlServer,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p11-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const ALL_CAPS = [
  "FILE_OPERATIONS",
  "AUTOMATON_TASK_EXECUTION",
  "SHELL_EXECUTION",
  "CODE_GENERATION",
  "REASONING",
];

function makeCtx(name: string) {
  const dir = freshDir(name);
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
  const adapters = new Map();
  const planner = () => ({
    tasks: [{ task_key: "T1", title: "t1", required_capabilities: ["FILE_OPERATIONS"], depends_on: [] }],
  });
  const runtime = new MissionRuntime({
    service, gate, router, adapters, scheduler, approvals,
    reconciliation: recon, recovery, planner,
  });
  const supervisor = new MissionSupervisor(service, runtime, recovery, recon);
  const observability = new MissionObservability(service);
  const control = new MissionControl({
    service, runtime, supervisor, scheduler, approvals,
    reconciliation: recon, observability, planner,
  });
  for (const c of ALL_CAPS) service.registerCapability(c, { risk_class: "LOW" });
  const project = service.createProject({ name, root_location: workspace });
  return {
    dir, workspace, store, service, control,
    projectId: String(project.project_id),
  };
}

function makeBiz(name: string) {
  const ctx = makeCtx(name);
  const schedules = new MissionScheduleService(ctx.service);
  const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
  return { ctx, biz, schedules };
}

const bId = (b: Record<string, unknown>) => String(b.business_id);
const aId = (a: Record<string, unknown>) => String(a.agent_id);
const wId = (w: Record<string, unknown>) => String(w.work_item_id);

function bizWithAgent(biz: BusinessLayer, projectId: string, dept = "sales") {
  const b = biz.createBusiness({ name: "B", project_id: projectId, operator_id: "op" });
  const a = biz.createOrgAgent({ business_id: bId(b), title: "A", department: dept, operator_id: "op" });
  return { b, a };
}

describe("P11 §2.A scope integrity", () => {
  it("rejects reports_to pointing at another business", () => {
    const { ctx, biz } = makeBiz("scope1");
    const { b } = bizWithAgent(biz, ctx.projectId);
    const b2 = biz.createBusiness({ name: "B2", project_id: ctx.projectId, operator_id: "op" });
    const a2 = biz.createOrgAgent({ business_id: bId(b2), title: "Mgr", department: "d", operator_id: "op" });
    expect(() =>
      biz.createOrgAgent({ business_id: bId(b), title: "X", department: "d", reports_to: aId(a2), operator_id: "op" }),
    ).toThrowError(/FAIL_CLOSED_ORG_AGENT_SCOPE/);
  });

  it("rejects objective with cross-business parent", () => {
    const { ctx, biz } = makeBiz("scope2");
    const { b } = bizWithAgent(biz, ctx.projectId);
    const b2 = biz.createBusiness({ name: "B2", project_id: ctx.projectId, operator_id: "op" });
    const o2 = biz.createObjective({ business_id: bId(b2), title: "foreign", operator_id: "op" });
    expect(() =>
      biz.createObjective({ business_id: bId(b), title: "child", parent_objective_id: String(o2.objective_id), operator_id: "op" }),
    ).toThrowError(/FAIL_CLOSED_OBJECTIVE_SCOPE/);
  });

  it("rejects work item with objective from another business", () => {
    const { ctx, biz } = makeBiz("scope3");
    const { b } = bizWithAgent(biz, ctx.projectId);
    const b2 = biz.createBusiness({ name: "B2", project_id: ctx.projectId, operator_id: "op" });
    const o2 = biz.createObjective({ business_id: bId(b2), title: "foreign", operator_id: "op" });
    expect(() =>
      biz.createWorkItem({ business_id: bId(b), title: "t", goal: "g", objective_id: String(o2.objective_id), operator_id: "op" }),
    ).toThrowError(/FAIL_CLOSED_WORK_ITEM_SCOPE/);
  });

  it("rejects routine with paused assignee", () => {
    const { ctx, biz } = makeBiz("scope4");
    const { b, a } = bizWithAgent(biz, ctx.projectId);
    biz.setOrgAgentStatus(aId(a), "PAUSED", "op");
    expect(() =>
      biz.createRoutine({ business_id: bId(b), name: "r", goal_template: "g", cron: "0 7 * * *", assignee_agent_id: aId(a), operator_id: "op" }),
    ).toThrowError(/FAIL_CLOSED_AGENT_INACTIVE/);
  });
});

describe("P11 §2.B work-item lifecycle", () => {
  it("rejects illegal transitions: open DONE / CANCELLED / IN_PROGRESS", () => {
    const { ctx, biz } = makeBiz("life1");
    const { b } = bizWithAgent(biz, ctx.projectId);
    const w = biz.createWorkItem({ business_id: bId(b), title: "t", goal: "g", operator_id: "op" });
    biz.openWorkItem(wId(w), "op");
    // already IN_PROGRESS with a live linked mission — second open refused
    expect(() => biz.openWorkItem(wId(w), "op")).toThrowError(/FAIL_CLOSED_MISSION_ACTIVE/);
    // terminal → open
    const mid = (biz.listWorkItems(bId(b))[0].mission_ids as string[])[0];
    const m = ctx.store.get("mission", mid);
    m.status = "COMPLETED";
    ctx.store.put("mission", mid, m, Number(m.version));
    biz.board(bId(b)); // sync IN_PROGRESS → DONE
    expect(() => biz.openWorkItem(wId(w), "op")).toThrowError(/FAIL_CLOSED_WORK_ITEM_TRANSITION/);
    const w2 = biz.createWorkItem({ business_id: bId(b), title: "t2", goal: "g", operator_id: "op" });
    biz.blockWorkItem(wId(w2), "stuck", "op");
    expect(() => biz.unblockWorkItem(wId(w2), "op")).not.toThrow();
    const w3 = biz.createWorkItem({ business_id: bId(b), title: "t3", goal: "g", operator_id: "op" });
    biz.openWorkItem(wId(w3), "op");
    const mid3 = (biz.listWorkItems(bId(b)).find((x) => x.work_item_id === w3.work_item_id)!.mission_ids as string[])[0];
    const m3 = ctx.store.get("mission", mid3);
    m3.status = "CANCELLED";
    ctx.store.put("mission", mid3, m3, Number(m3.version));
    biz.board(bId(b));
    expect(() => biz.openWorkItem(wId(w3), "op")).toThrowError(/FAIL_CLOSED_WORK_ITEM_TRANSITION/);
  });

  it("governed reopen: BLOCKED → IN_PROGRESS via open only", () => {
    const { ctx, biz } = makeBiz("life2");
    const { b, a } = bizWithAgent(biz, ctx.projectId);
    const w = biz.createWorkItem({ business_id: bId(b), title: "t", goal: "g", assignee_agent_id: aId(a), operator_id: "op" });
    biz.blockWorkItem(wId(w), "blocked", "op");
    const reopened = biz.openWorkItem(wId(w), "op");
    expect(String(reopened.status)).toBe("IN_PROGRESS");
    expect((reopened.mission_ids as string[])).toHaveLength(1);
  });
});

describe("P11 §2.C claim integrity", () => {
  it("expired claim can be reclaimed by another agent", () => {
    const { ctx, biz } = makeBiz("claim1");
    const { b, a } = bizWithAgent(biz, ctx.projectId);
    const a2 = biz.createOrgAgent({ business_id: bId(b), title: "A2", department: "sales", operator_id: "op" });
    const w = biz.createWorkItem({ business_id: bId(b), title: "t", goal: "g", operator_id: "op" });
    biz.claimWorkItem(wId(w), aId(a), "op");
    // expire the claim by rewinding expiry into the past
    const row = ctx.store.get("work_item", wId(w));
    row.claim_expires_at = new Date(Date.now() - 1000).toISOString();
    ctx.store.put("work_item", wId(w), row, Number(row.version));
    const reclaimed = biz.claimWorkItem(wId(w), aId(a2), "op");
    expect(String(reclaimed.claimed_by)).toBe(aId(a2));
  });

  it("stale/absent claim_token cannot release a live claim", () => {
    const { ctx, biz } = makeBiz("claim2");
    const { b, a } = bizWithAgent(biz, ctx.projectId);
    const w = biz.createWorkItem({ business_id: bId(b), title: "t", goal: "g", operator_id: "op" });
    const claimed = biz.claimWorkItem(wId(w), aId(a), "op");
    const token = String(claimed.claim_token);
    expect(() => biz.releaseClaim(wId(w), "op")).toThrowError(/FAIL_CLOSED_CLAIM_TOKEN/);
    expect(() => biz.releaseClaim(wId(w), "op", "CLM_wrong")).toThrowError(/FAIL_CLOSED_CLAIM_TOKEN/);
    const released = biz.releaseClaim(wId(w), "op", token);
    expect(released.claimed_by).toBeNull();
  });

  it("assign to another agent while claim is live is rejected", () => {
    const { ctx, biz } = makeBiz("claim3");
    const { b, a } = bizWithAgent(biz, ctx.projectId);
    const a2 = biz.createOrgAgent({ business_id: bId(b), title: "A2", department: "sales", operator_id: "op" });
    const w = biz.createWorkItem({ business_id: bId(b), title: "t", goal: "g", operator_id: "op" });
    biz.claimWorkItem(wId(w), aId(a), "op");
    expect(() => biz.assignWorkItem(wId(w), aId(a2), "op")).toThrowError(/FAIL_CLOSED_WORK_ITEM_CLAIMED/);
  });
});

describe("P11 §2.D single dispatch per open", () => {
  it("retry/double-open cannot mint a second mission", () => {
    const { ctx, biz } = makeBiz("dup1");
    const { b, a } = bizWithAgent(biz, ctx.projectId);
    const w = biz.createWorkItem({ business_id: bId(b), title: "t", goal: "g", assignee_agent_id: aId(a), operator_id: "op" });
    biz.openWorkItem(wId(w), "op");
    expect(() => biz.openWorkItem(wId(w), "op")).toThrowError(/FAIL_CLOSED_MISSION_ACTIVE/);
    const row = ctx.store.get("work_item", wId(w));
    expect(row.mission_ids as string[]).toHaveLength(1);
    expect(ctx.store.list("mission")).toHaveLength(1);
  });

  it("budget refusal rolls the item back to its prior status — openable again", () => {
    const { ctx, biz } = makeBiz("dup2");
    const { b } = bizWithAgent(biz, ctx.projectId);
    biz.createBudgetPolicy({ business_id: bId(b), scope_type: "business", period: "DAY", max_missions: 1, operator_id: "op" });
    const w1 = biz.createWorkItem({ business_id: bId(b), title: "t1", goal: "g", operator_id: "op" });
    const w2 = biz.createWorkItem({ business_id: bId(b), title: "t2", goal: "g", operator_id: "op" });
    biz.openWorkItem(wId(w1), "op");
    expect(() => biz.openWorkItem(wId(w2), "op")).toThrowError(/FAIL_CLOSED_BUDGET_EXCEEDED/);
    const w2row = ctx.store.get("work_item", wId(w2));
    expect(String(w2row.status)).toBe("BACKLOG"); // rolled back, not stranded IN_PROGRESS
    expect(w2row.mission_ids as string[]).toHaveLength(0);
    expect(ctx.store.list("mission")).toHaveLength(1);
  });
});

describe("P11 §2.E routine projection", () => {
  it("projects ≤1 work_item per fired mission and dedups on re-sync", async () => {
    const { ctx, biz } = makeBiz("rt1");
    const { b } = bizWithAgent(biz, ctx.projectId, "content");
    const r = biz.createRoutine({
      business_id: bId(b), name: "daily", goal_template: "post", cron: "0 7 * * *", operator_id: "op",
    });
    const schedId = String(r.schedule_id);
    // Simulate one fired mission carrying this schedule's metadata
    const m = ctx.control.startMission({
      project_id: ctx.projectId, goal: "post", operator_id: "op",
      metadata: { business_id: bId(b), schedule_id: schedId, plan_source: "schedule" },
    });
    biz.board(bId(b)); // projection pass 1
    let items = biz.listWorkItems(bId(b));
    expect(items).toHaveLength(1);
    expect(String((items[0].mission_ids as string[])[0])).toBe(String(m.mission_id));
    biz.board(bId(b)); // pass 2 — must not duplicate
    items = biz.listWorkItems(bId(b));
    expect(items).toHaveLength(1);
    // a second mission → exactly one more work item
    ctx.control.startMission({
      project_id: ctx.projectId, goal: "post2", operator_id: "op",
      metadata: { business_id: bId(b), schedule_id: schedId, plan_source: "schedule" },
    });
    biz.board(bId(b));
    expect(biz.listWorkItems(bId(b))).toHaveLength(2);
  });

  it("restart-safe: fresh BusinessLayer on same store keeps the projection deduped", async () => {
    const { ctx, biz } = makeBiz("rt2");
    const { b } = bizWithAgent(biz, ctx.projectId);
    const r = biz.createRoutine({ business_id: bId(b), name: "r", goal_template: "g", cron: "0 7 * * *", operator_id: "op" });
    ctx.control.startMission({
      project_id: ctx.projectId, goal: "g", operator_id: "op",
      metadata: { business_id: bId(b), schedule_id: String(r.schedule_id), plan_source: "schedule" },
    });
    biz.board(bId(b));
    // "restart": new layer + schedule service over the same store
    const schedules2 = new MissionScheduleService(ctx.service);
    const biz2 = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules: schedules2 });
    biz2.board(bId(b));
    biz2.board(bId(b));
    expect(biz2.listWorkItems(bId(b))).toHaveLength(1);
  });
});

describe("P11 §3 budget hardening", () => {
  it("rejects agent-scope budget for agent outside the business", () => {
    const { ctx, biz } = makeBiz("bud1");
    const { b } = bizWithAgent(biz, ctx.projectId);
    const b2 = biz.createBusiness({ name: "B2", project_id: ctx.projectId, operator_id: "op" });
    const foreign = biz.createOrgAgent({ business_id: bId(b2), title: "F", department: "d", operator_id: "op" });
    expect(() =>
      biz.createBudgetPolicy({ business_id: bId(b), scope_type: "agent", scope_id: aId(foreign), period: "DAY", max_missions: 1, operator_id: "op" }),
    ).toThrowError(/FAIL_CLOSED_BUDGET_SCOPE/);
    expect(() =>
      biz.createBudgetPolicy({ business_id: bId(b), scope_type: "agent", scope_id: "AGENT_missing", period: "DAY", max_missions: 1, operator_id: "op" }),
    ).toThrowError(); // dangling agent reference — fail closed
  });

  it("rejects department scope with no agents in the business", () => {
    const { ctx, biz } = makeBiz("bud2");
    const { b } = bizWithAgent(biz, ctx.projectId, "sales");
    expect(() =>
      biz.createBudgetPolicy({ business_id: bId(b), scope_type: "department", scope_id: "phantom", period: "DAY", max_missions: 1, operator_id: "op" }),
    ).toThrowError(/FAIL_CLOSED_BUDGET_SCOPE/);
    // valid department passes
    const ok = biz.createBudgetPolicy({ business_id: bId(b), scope_type: "department", scope_id: "sales", period: "DAY", max_missions: 5, operator_id: "op" });
    expect(String(ok.scope_id)).toBe("sales");
  });

  it("hard-stop is audit-trailed and cannot be bypassed by rapid opens", () => {
    const { ctx, biz } = makeBiz("bud3");
    const { b } = bizWithAgent(biz, ctx.projectId);
    biz.createBudgetPolicy({ business_id: bId(b), scope_type: "business", period: "DAY", max_missions: 1, operator_id: "op" });
    const ws = [1, 2, 3].map((i) =>
      biz.createWorkItem({ business_id: bId(b), title: `t${i}`, goal: "g", operator_id: "op" }));
    biz.openWorkItem(wId(ws[0]), "op");
    for (const w of ws.slice(1)) {
      expect(() => biz.openWorkItem(wId(w), "op")).toThrowError(/FAIL_CLOSED_BUDGET_EXCEEDED/);
    }
    expect(ctx.store.list("mission")).toHaveLength(1);
    expect(ctx.store.listEvents("budget_policy").filter((e) => e.event_type === "BUDGET_EXCEEDED").length).toBe(2);
  });
});

describe("P11 §4 credential broker", () => {
  it("vault is chmod 600 and list() never exposes values", () => {
    const dir = freshDir("brk1");
    const vault = path.join(dir, "vault.json");
    const broker = new CredentialBroker({ vaultPath: vault });
    broker.upsert({ name: "stripe_key", kind: "api_key", domains: ["api.stripe.com"], value: "sk_test_SECRET", created_by: "op" });
    const stat = fs.statSync(vault);
    expect(stat.mode & 0o777).toBe(0o600);
    const listed = broker.list();
    expect(JSON.stringify(listed)).not.toContain("sk_test_SECRET");
  });

  it("release audits grant; deny() audits rejected probes without a value", () => {
    const dir = freshDir("brk2");
    const events: Array<Record<string, unknown>> = [];
    const broker = new CredentialBroker({
      vaultPath: path.join(dir, "vault.json"),
      audit: (e) => events.push(e as unknown as Record<string, unknown>),
    });
    broker.upsert({ name: "k", kind: "api_key", domains: [], value: "v123", created_by: "op" });
    broker.release("k", { mission_id: "MSN_1", task_id: "T1" });
    broker.deny("k", { mission_id: "MSN_fake", task_id: null });
    expect(events).toHaveLength(2);
    expect(String(events[0].event_type)).toBe("CREDENTIAL_RELEASED");
    expect(String(events[1].event_type)).toBe("CREDENTIAL_DENIED");
    expect(JSON.stringify(events)).not.toContain("v123");
  });

  it("secrets never enter the canonical store: assertSecretFree blocks writes", () => {
    const { ctx } = makeBiz("brk3");
    expect(() =>
      ctx.store.put("work_item", "w", { work_item_id: "w", api_key: "sk_live_x" }, 0),
    ).toThrowError(/secret/i);
  });

  it("fetch endpoint rejects unknown mission_id and audits the denial", async () => {
    const ctx = makeCtx("brk4");
    const schedules = new MissionScheduleService(ctx.service);
    const biz = new BusinessLayer({ store: ctx.store, control: ctx.control, schedules });
    const broker = new CredentialBroker({
      vaultPath: path.join(ctx.dir, "vault.json"),
      audit: (e) =>
        ctx.store.event({
          entity_type: "mission",
          entity_id: e.mission_id ?? "unknown",
          event_type: e.event_type,
          actor: "credential-broker",
          metadata: { credential_name: e.credential_name, task_id: e.task_id, granted: e.granted },
        }),
    });
    broker.upsert({ name: "k", kind: "api_key", domains: [], value: "v999", created_by: "op" });
    const server = createMissionControlServer({ control: ctx.control, business: biz, broker, brokerToken: "btok" });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/broker/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-broker-token": "btok" },
        body: JSON.stringify({ credential_name: "k", mission_id: "MSN_phantom" }),
      });
      expect(res.status).toBe(404);
      const denied = ctx.store.listEvents().filter((e) => e.event_type === "CREDENTIAL_DENIED");
      expect(denied).toHaveLength(1);
      expect(String(denied[0].entity_id)).toBe("MSN_phantom");
    } finally {
      server.close();
    }
  });
});

describe("P11 §7 evidence integrity + docs consistency", () => {
  it("business ops keep the canonical store verifyIntegrity-clean", () => {
    const { ctx, biz } = makeBiz("int1");
    const { b, a } = bizWithAgent(biz, ctx.projectId);
    const w = biz.createWorkItem({ business_id: bId(b), title: "t", goal: "g", assignee_agent_id: aId(a), operator_id: "op" });
    biz.openWorkItem(wId(w), "op");
    biz.claimWorkItem(wId(w), aId(a), "op");
    // verifyIntegrity throws on any hash mismatch; clean = returns counts
    expect(() => ctx.store.verifyIntegrity()).not.toThrow();
    expect(Number(ctx.store.verifyIntegrity().entities)).toBeGreaterThan(0);
  });

  it("docs present and no longer misdescribe PAIR Next as Conway Automaton", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    // the front page leads with PAIR Next identity, not the upstream project
    expect(readme.split("\n")[0]).toMatch(/PAIR/i);
    expect(readme).toMatch(/mission control/i);
    for (const doc of ["ARCHITECTURE.md", "RELEASE.json", "DOCUMENTATION.md"]) {
      expect(fs.existsSync(path.join(repoRoot, doc))).toBe(true);
    }
    const rel = JSON.parse(fs.readFileSync(path.join(repoRoot, "RELEASE.json"), "utf8")) as Record<string, unknown>;
    expect(rel).toBeTruthy();
  });
});
