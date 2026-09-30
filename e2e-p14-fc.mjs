// P14 WFV2 FINAL CLOSURE — Golden E2E.
// Parent ├── A ├── B(dep A) ├── C(requires_review) ├── D(dep B+C) └── E(delegated)
// Real server (dist build), real API, 5 restart boundaries A-E,
// coordination-vs-authority negatives, exactly-once evidence checks.
// Mission terminal writes go through the app's own store writers — the
// exact persisted shape the governed runtime produces.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const ROOT = process.cwd();
const PORT = 8923;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p14-fc-e2e-"));
const results = [];
const ok = (name, cond, extra = "") => {
  results.push([name, !!cond, extra]);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
};

const esbuild = fs.readdirSync("node_modules/.pnpm")
  .filter((d) => d.startsWith("esbuild@"))
  .map((d) => path.join("node_modules/.pnpm", d, "node_modules/esbuild/bin/esbuild"))
  .filter((p) => fs.existsSync(p)).sort().at(-1);
execFileSync(esbuild, ["src/pair/index.ts", "--bundle", "--format=esm", "--platform=node",
  "--external:better-sqlite3", "--external:ulid", "--external:yaml",
  "--outfile=node_modules/.cache/e2e-pair-bundle.mjs"], { cwd: ROOT, stdio: "pipe" });
const PAIR = await import("./node_modules/.cache/e2e-pair-bundle.mjs");

const storeOf = () => new PAIR.PairEvidenceStore(path.join(DIR, "pair.db"));
const RUNTIME_ACTOR = "PAIR_MISSION_RUNTIME";
const GATE_ACTOR = "PAIR_GOVERNED_TASK_GATE";
const TEST_EXECUTOR = "EX_E2E_CANONICAL";

const transitionRuntimeLike = (store, mid, to, reason) => {
  const rtId = `MRT_${mid}`;
  const cur = store.get("mission_runtime", rtId);
  const from = String(cur.state);
  if (from === to) return;
  cur.state = to; cur.entered_at = PAIR.utcnow(); cur.reason = reason;
  store.put("mission_runtime", rtId, cur, Number(cur.version));
  store.event({ entity_type: "mission_runtime", entity_id: rtId,
    event_type: "MISSION_RUNTIME_TRANSITION", old_state: from,
    new_state: to, actor: RUNTIME_ACTOR,
    metadata: { mission_id: mid, reason } });
};

// R3 — legal per-hop mirrors of service.MISSION_STATUS_TRANSITIONS and
// mission-runtime RUNTIME_TRANSITIONS: a bare `status = "FAILED"` write
// is a mutable claim; the canonical lifecycle proof requires legal
// transition evidence on BOTH state machines.
const M_STEPS = {
  CREATED: ["READY", "CANCELLED"],
  READY: ["RUNNING", "PAUSED", "CANCELLED"],
  RUNNING: ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED", "FAILED"],
  COMPLETED: [], FAILED: [], CANCELLED: [],
};
const RT_STEPS = {
  CREATED: ["PLANNING", "READY", "CANCELLED", "ABORTED"],
  PLANNING: ["READY", "FAILED", "WAITING_APPROVAL", "CANCELLED", "ABORTED"],
  READY: ["RUNNING", "PAUSED", "CANCELLED", "ABORTED"],
  RUNNING: ["WAITING", "WAITING_BACKOFF", "WAITING_APPROVAL", "RECONCILING",
    "REPLANNING", "RECOVERING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED", "ABORTED"],
  WAITING: ["RUNNING", "PAUSED", "CANCELLED", "ABORTED", "FAILED"],
  WAITING_BACKOFF: ["RUNNING", "RECOVERING", "CANCELLED", "ABORTED", "WAITING_APPROVAL"],
  WAITING_APPROVAL: ["RUNNING", "RECOVERING", "REPLANNING", "RECONCILING", "CANCELLED", "ABORTED", "FAILED"],
  RECONCILING: ["RUNNING", "RECOVERING", "WAITING_APPROVAL", "FAILED", "CANCELLED", "ABORTED"],
  REPLANNING: ["READY", "RUNNING", "FAILED", "CANCELLED", "ABORTED", "WAITING_APPROVAL"],
  RECOVERING: ["RUNNING", "WAITING_BACKOFF", "WAITING_APPROVAL", "RECONCILING",
    "REPLANNING", "FAILED", "CANCELLED", "ABORTED"],
  PAUSED: ["READY", "RUNNING", "CANCELLED", "ABORTED"],
  COMPLETED: [], FAILED: [], CANCELLED: [], ABORTED: [],
};
const pathTo = (table, from, to) => {
  if (from === to) return [];
  const q = [[from]], seen = new Set([from]);
  while (q.length) {
    const p = q.shift(), cur = p[p.length - 1];
    for (const nxt of table[cur] ?? []) {
      if (seen.has(nxt)) continue;
      if (nxt === to) return [...p.slice(1), to];
      seen.add(nxt); q.push([...p, nxt]);
    }
  }
  return null;
};

// Drive a mission to a canonically-provable FAILED/CANCELLED/PAUSED
// lifecycle state: legal mission transitions + MRT_<mid> row + legal
// runtime transitions to the canonical pairing.
const terminateMission = (mid, target, { rt = null } = {}) => {
  const store = storeOf();
  const service = new PAIR.PairControlPlane(store);
  const mPath = pathTo(M_STEPS, String(store.get("mission", mid).status), target);
  if (mPath === null) throw new Error(`no mission path to ${target}`);
  for (const to of mPath) service.transitionMission(mid, to, RUNTIME_ACTOR);
  const rtId = `MRT_${mid}`;
  if (!store.tryGet("mission_runtime", rtId)) {
    store.put("mission_runtime", rtId, {
      mission_runtime_id: rtId, mission_id: mid, state: "CREATED",
      entered_at: PAIR.utcnow(), reason: "mission_runtime_created",
      barriers: {}, pending_recovery: null, pending_approval_id: null,
      pending_remediation: null,
      budget_extension: { attempts_per_task: 0, attempts_per_mission: 0 },
      version: 0 }, 0);
    store.event({ entity_type: "mission_runtime", entity_id: rtId,
      event_type: "MISSION_RUNTIME_CREATED", new_state: "CREATED",
      actor: RUNTIME_ACTOR, metadata: { mission_id: mid } });
  }
  const rtTarget = rt ?? (target === "PAUSED" ? "PAUSED" : target);
  const reasons = { READY: "plan_committed", RUNNING: "tasks_dispatched",
    PAUSED: "operator_pause:e2e", FAILED: "tasks_incomplete:T1",
    CANCELLED: "operator_cancel:e2e", ABORTED: "aborted:e2e" };
  const rPath = pathTo(RT_STEPS, String(store.get("mission_runtime", rtId).state), rtTarget);
  if (rPath === null) throw new Error(`no runtime path to ${rtTarget}`);
  for (const to of rPath) transitionRuntimeLike(store, mid, to, reasons[to] ?? `to_${to.toLowerCase()}`);
};

// Canonical governed-runtime completion evidence — identical persisted
// shape to GovernedTaskGate + ArtifactProvenanceValidator output.
const completeMission = (mid, { tasks = 1 } = {}) => {
  const store = storeOf();
  const service = new PAIR.PairControlPlane(store);
  const plan = service.commitPlan({
    mission_id: mid,
    tasks: Array.from({ length: tasks }, (_, i) => ({
      task_key: `T${i + 1}`, title: `t${i + 1}`,
      task_instruction: `t${i + 1}`,
      required_capabilities: [], depends_on: [] })),
    source: "E2E_CANONICAL", reason: "canonical-completion",
    proposal: { ok: true } });
  const status = () => String(store.get("mission", mid).status);
  if (status() === "CREATED") service.transitionMission(mid, "READY", RUNTIME_ACTOR);
  if (status() === "READY") service.transitionMission(mid, "RUNNING", RUNTIME_ACTOR);
  const rtId = `MRT_${mid}`;
  if (!store.tryGet("mission_runtime", rtId)) {
    store.put("mission_runtime", rtId, {
      mission_runtime_id: rtId, mission_id: mid, state: "CREATED",
      entered_at: PAIR.utcnow(), reason: "mission_runtime_created",
      barriers: {}, pending_recovery: null, pending_approval_id: null,
      pending_remediation: null,
      budget_extension: { attempts_per_task: 0, attempts_per_mission: 0 },
      version: 0 }, 0);
    store.event({ entity_type: "mission_runtime", entity_id: rtId,
      event_type: "MISSION_RUNTIME_CREATED", new_state: "CREATED",
      actor: RUNTIME_ACTOR, metadata: { mission_id: mid } });
  }
  if (String(store.get("mission_runtime", rtId).state) === "CREATED")
    transitionRuntimeLike(store, mid, "READY", "plan_committed");
  if (String(store.get("mission_runtime", rtId).state) === "READY")
    transitionRuntimeLike(store, mid, "RUNNING", "tasks_dispatched");
  for (const tid of plan.task_ids) {
    const gtId = `GT_${tid}`;
    const eid = `EXEC_${tid}`, corr = `COR_${tid}`;
    const ws = `${DIR}/ws/${mid}`;
    store.put("governed_task", gtId, {
      governed_task_id: gtId, mission_id: mid, task_id: tid,
      plan_id: plan.plan_id, plan_revision: plan.revision,
      correlation_id: corr, executor_id: TEST_EXECUTOR,
      task_instruction: "t1", workspace: ws, allowed_paths: [ws],
      permissions: [], constraints: [], requested_tools: [],
      dependency_outputs: [], timeout: 60000,
      expected_output_contract: null, risk_class: "LOW",
      approval_required: false, approval_id: null,
      approval_scope_digest: null,
      governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
      created_at: PAIR.utcnow(), version: 0 }, 0);
    store.event({ entity_type: "governed_task", entity_id: gtId,
      event_type: "GOVERNED_TASK_VALIDATED", new_state: "VALIDATED",
      actor: GATE_ACTOR, correlation_id: corr,
      metadata: { mission_id: mid, task_id: tid,
        executor_id: TEST_EXECUTOR, risk_class: "LOW",
        approval_required: false } });
    store.event({ entity_type: "governed_task", entity_id: gtId,
      event_type: "EXECUTION_PREPARED", old_state: "VALIDATED",
      new_state: "DISPATCH_AUTHORIZED", actor: GATE_ACTOR,
      correlation_id: corr });
    store.put("executor_dispatch_intent", `INTENT_${gtId}`, {
      intent_id: `INTENT_${gtId}`, governed_task_id: gtId,
      executor_id: TEST_EXECUTOR, state: "EXECUTION_PERSISTED",
      execution_id: eid, created_at: PAIR.utcnow(), version: 0 }, 0);
    store.put("executor_execution", eid, {
      execution_id: eid, governed_task_id: gtId, mission_id: mid,
      task_id: tid, executor_id: TEST_EXECUTOR,
      plan_revision: plan.revision, correlation_id: corr,
      execution_state: "COMPLETED", dispatch_timestamp: PAIR.utcnow(),
      run_root: `${ws}/run`, workspace: ws,
      result: { status: "COMPLETED", output: "done" }, version: 0 }, 0);
    store.event({ entity_type: "executor_execution", entity_id: eid,
      event_type: "EXECUTION_DISPATCHED", new_state: "COMPLETED",
      actor: GATE_ACTOR, correlation_id: corr,
      metadata: { governed_task_id: gtId } });
    store.event({ entity_type: "executor_execution", entity_id: eid,
      event_type: "RESULT_COLLECTED", new_state: "COMPLETED",
      actor: GATE_ACTOR, correlation_id: corr });
    const v = new PAIR.ArtifactProvenanceValidator()
      .validate_execution(service, eid);
    if (String(v.status) !== "PASS")
      throw new Error(`e2e validation failed: ${v.status}`);
    service.updateTask(tid, { status: "COMPLETED", completed_at: PAIR.utcnow() });
    store.event({ entity_type: "task", entity_id: tid,
      event_type: "TASK_COMPLETED", new_state: "COMPLETED",
      actor: RUNTIME_ACTOR, correlation_id: corr });
  }
  if (status() !== "COMPLETED") service.transitionMission(mid, "COMPLETED", RUNTIME_ACTOR);
  transitionRuntimeLike(store, mid, "COMPLETED", "all_tasks_completed");
};

// Tamper seam — bare status forge on the bound mission row (no runtime
// evidence at all), the exact forgery P3-R1 fences.
const forgeMission = (mid) => {
  const store = storeOf();
  const m = store.get("mission", mid);
  m.status = "COMPLETED";
  m.updated_at = new Date().toISOString();
  store.put("mission", mid, m, Number(m.version));
};

const rows = (type) => storeOf().list(type);
const eventsOf = (type, id) => storeOf().listEvents(type, id);
const wcpOf = (wid) => storeOf().tryGet("work_completion", `WCP_${wid}`);
const anchorsOf = (wid) => eventsOf("work_completion", `WCP_${wid}`)
  .filter((e) => String(e.event_type) === "WORK_ITEM_COMPLETED");
const acceptOf = (wid) => eventsOf("work_item", wid)
  .filter((e) => String(e.event_type) === "WORK_REVIEW_ACCEPTED");
const bindingsOf = (wid) => rows("work_open_binding")
  .filter((b) => String(b.work_item_id) === wid);

async function api(p, method = "GET", body) {
  const r = await fetch(`http://localhost:${PORT}${p}`, {
    method, headers: { "content-type": "application/json" },
    body: body ? JSON.stringify({ operator_id: "op", ...body }) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const wi = async (id) => {
  const l = (await api(`/api/work-items?business_id=${bid}`)).data.work_items;
  return l.find((w) => String(w.work_item_id) === id) ?? {};
};
const board = async () => api(`/api/businesses/${bid}`);
const completion = async (id) => (await api(`/api/work-items/${id}/completion`)).data;
const fold = async (id) => { await board(); return wi(id); };
const openWI = async (id) => api(`/api/work-items/${id}/open`, "POST", {});

function startServer() {
  const proc = spawn("node", ["scripts/serve-mission-control.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PAIR_MC_DIR: DIR, PAIR_MC_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  return proc;
}
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await api("/api/projects"); if (r.status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not come up");
}
const restart = async (proc) => {
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  const n = startServer();
  await waitUp();
  return n;
};

// =====================================================================
// A. fresh dir + server
let srv = startServer();
await waitUp();
ok("FC-A server-up", true, DIR);

// B. project + business + agents
const projects = (await api("/api/projects")).data.projects ?? (await api("/api/projects")).data;
const projectId = String(projects[0].project_id);
const bizRes = await api("/api/businesses", "POST", { name: "FC-Biz", project_id: projectId });
const bid = String(bizRes.data.business_id);
const mkAgent = async (role) =>
  String((await api("/api/org-agents", "POST", {
    business_id: bid, title: role, role, department: "ops",
    capabilities: ["FILE_OPERATIONS"] })).data.agent_id);
const lead = await mkAgent("lead");
const rev = await mkAgent("reviewer");
const w2 = await mkAgent("worker2");
ok("FC-B biz+agents", !!bid && !!lead && !!rev && !!w2, `bid=${bid}`);

// C. parent + golden decomposition: A, B(dep A), C(review), D(dep B+C)
const pRes = await api("/api/work-items", "POST", {
  business_id: bid, title: "parent", goal: "g", assignee_agent_id: lead });
const pid = String(pRes.data.work_item_id);
const dec = await api(`/api/work-items/${pid}/decompose`, "POST", {
  decomposition_id: "D-FC-1",
  children: [
    { title: "A", goal: "ga", assignee_agent_id: lead },
    { title: "B", goal: "gb", assignee_agent_id: lead, depends_on_indices: [0] },
    { title: "C", goal: "gc", assignee_agent_id: w2, requires_review: true },
    { title: "D", goal: "gd", assignee_agent_id: lead, depends_on_indices: [1, 2] },
  ] });
const [A, B, C, D] = dec.data.children.map((c) => String(c.work_item_id));
ok("FC-C decompose A/B(depA)/C(review)/D(depB+C)",
  dec.status === 200 && [A, B, C, D].every(Boolean), `${A},${B},${C},${D}`);

// delegation: child E governed by delegation (parent child set = WDEC∪WDEL)
const dres = await api(`/api/work-items/${pid}/delegate`, "POST", {
  delegated_by_agent_id: lead, delegated_to_agent_id: w2,
  delegation_key: "E", reason: "fc" });
const E = String(dres.data?.work_item_id ?? dres.data?.child?.work_item_id ?? "");
ok("FC-D delegate E", dres.status === 200 && !!E, `${dres.status} ${E}`);

// E-F. coordination: claim + heartbeat are coordination, not authority
const claim = await api(`/api/work-items/${A}/claim`, "POST", { agent_id: lead });
const token = String(claim.data?.claim_token ?? "");
ok("FC-E claim A", claim.status === 200 && !!token, `lease`);
const hb = await api(`/api/work-items/${A}/heartbeat`, "POST",
  { agent_id: lead, claim_token: token });
ok("FC-F heartbeat A", hb.status === 200);

// NEGATIVES — coordination never grants completion authority
const msg = await api(`/api/work-items/${A}/messages`, "POST", {
  business_id: bid, sender_type: "OPERATOR", recipient_agent_id: rev,
  kind: "NOTE", body: "see A" });
const mid0 = String(msg.data?.message_id ?? "");
const ack = await api(`/api/workforce/messages/${mid0}/ack`, "POST", { agent_id: rev });
ok("FC-NEG-ack-not-completion", ack.status === 200 &&
  String(ack.data?.status ?? ack.data?.receipt?.status ?? "") === "ACKNOWLEDGED");
const bOpenEarly = await openWI(B);
ok("FC-NEG-deps-blocked-heartbeat+ack", bOpenEarly.status !== 200,
  String(bOpenEarly.data?.error?.code ?? bOpenEarly.data?.error ?? bOpenEarly.status));
const handoff = await api(`/api/work-items/${A}/messages`, "POST", {
  business_id: bid, sender_type: "AGENT", sender_agent_id: lead,
  recipient_agent_id: w2, kind: "HANDOFF_REQUEST", body: "take A" });
ok("FC-NEG-handoff-message-sent", handoff.status === 200);
const foreignClaim = await api(`/api/work-items/${A}/claim`, "POST", { agent_id: w2 });
ok("FC-NEG-handoff-not-authority", foreignClaim.status !== 200,
  String(foreignClaim.data?.error?.code ?? foreignClaim.data?.error ?? foreignClaim.status));

// G. A opens via work_open_binding — single canonical execution entry
const oA = await openWI(A);
ok("FC-G open A", oA.status === 200);
const aRow = await wi(A);
const midA = String((aRow.mission_ids ?? [])[0] ?? "");
const boundA = bindingsOf(A).filter((b) => String(b.state) === "BOUND");
ok("FC-G bound mission + binding", aRow.status === "IN_PROGRESS" &&
  boundA.length === 1 &&
  String(storeOf().get("mission", midA).bound_open_id) === String(boundA[0].open_id),
  `mid=${midA}`);

// RESTART-1 (boundary A: after binding, before mission progress)
srv = await restart(srv);
ok("FC-R1 restart after binding", true);
const aR1 = await wi(A);
const boundA2 = bindingsOf(A);
ok("FC-R1 no dup binding/mission", boundA2.length === 1 &&
  String(aR1.status) === "IN_PROGRESS" &&
  (aR1.mission_ids ?? []).length === 1);

// A mission completes canonically; RESTART-2 before the WCP fold lands
completeMission(midA);
srv = await restart(srv);
ok("FC-R2 restart mission-complete", true);
const aDone = await fold(A);
const aWcp = wcpOf(A);
ok("FC-H A DONE+WCP post-restart", aDone.status === "DONE" && !!aWcp,
  `status=${aDone.status} canon=${aDone.canonically_complete ?? (await completion(A)).canonically_complete}`);
ok("FC-H exactly-one A anchor", anchorsOf(A).length === 1);

// RESTART-3 (boundary C: first child WCP landed, before parent cascade)
srv = await restart(srv);
ok("FC-R3 restart child-WCP", true);
const aR3 = await wi(A);
const pR3 = await wi(pid);
ok("FC-R3 A still DONE+WCP, parent not done",
  aR3.status === "DONE" && anchorsOf(A).length === 1 && pR3.status !== "DONE");

// B + C open (B dep A satisfied; C no deps)
const oB = await openWI(B);
const oC = await openWI(C);
ok("FC-I B open dep-satisfied", oB.status === 200);
ok("FC-I C open", oC.status === 200);
const midB = String((await wi(B)).mission_ids?.[0] ?? "");
const midC = String((await wi(C)).mission_ids?.[0] ?? "");

// B completes → DONE+WCP
completeMission(midB);
const bDone = await fold(B);
ok("FC-J B DONE+WCP", bDone.status === "DONE" && !!wcpOf(B) && anchorsOf(B).length === 1);

// C completes → REVIEW_REQUIRED (requires_review — NO WCP yet)
completeMission(midC);
const cRev = await fold(C);
ok("FC-K C REVIEW_REQUIRED no-WCP",
  cRev.status === "REVIEW_REQUIRED" && !wcpOf(C), `status=${cRev.status}`);
const dBlocked = await openWI(D);
ok("FC-NEG-D-blocked-pre-review", dBlocked.status !== 200,
  String(dBlocked.data?.error?.code ?? dBlocked.data?.error ?? dBlocked.status));

// reviewer ACCEPT → DONE+WCP (in-txn reviewer re-proof)
const acc = await api(`/api/work-items/${C}/review`, "POST",
  { reviewer_agent_id: rev, decision: "ACCEPT" });
const cDone = await wi(C);
ok("FC-L C ACCEPT→DONE+WCP", acc.status === 200 && cDone.status === "DONE" &&
  !!wcpOf(C) && acceptOf(C).length === 1);
const accIdem = await api(`/api/work-items/${C}/review`, "POST",
  { reviewer_agent_id: rev, decision: "ACCEPT" });
ok("FC-L ACCEPT idempotent", accIdem.status === 200 && acceptOf(C).length === 1);

// RESTART-4 (boundary D: after ACCEPT evidence, before derived recovery)
srv = await restart(srv);
ok("FC-R4 restart post-ACCEPT", true);
const cR4 = await wi(C);
ok("FC-R4 C DONE+WCP, exactly-one ACCEPT+anchor",
  cR4.status === "DONE" && acceptOf(C).length === 1 && anchorsOf(C).length === 1);

// D open (B+C satisfied); E open (delegated child)
const oD = await openWI(D);
const oE = await openWI(E);
ok("FC-M D open dep-satisfied", oD.status === 200);
ok("FC-M E open delegated", oE.status === 200);
const midD = String((await wi(D)).mission_ids?.[0] ?? "");
const midE = String((await wi(E)).mission_ids?.[0] ?? "");

// D mission completes; RESTART-5 (boundary E: final child before parent finalization)
completeMission(midD);
srv = await restart(srv);
ok("FC-R5 restart final-child", true);
const dDone = await fold(D);
ok("FC-N D DONE+WCP post-restart", dDone.status === "DONE" && anchorsOf(D).length === 1);

// E completes → parent aggregates all canonical children (WDEC∪WDEL)
completeMission(midE);
const eDone = await fold(E);
const pDone = await wi(pid);
const pWcp = wcpOf(pid);
ok("FC-O E DONE", eDone.status === "DONE" && anchorsOf(E).length === 1);
ok("FC-P parent DONE+WCP aggregated 5 children",
  pDone.status === "DONE" && !!pWcp &&
  ((pWcp.child_work_item_ids ?? []).length === 5) &&
  anchorsOf(pid).length === 1,
  `children=${JSON.stringify(pWcp?.child_work_item_ids ?? [])}`);

// ================= NEGATIVE: forged DONE ≠ dependency =================
const spareRes = await api("/api/work-items", "POST", {
  business_id: bid, title: "spare", goal: "g", assignee_agent_id: lead });
const spare = String(spareRes.data.work_item_id);
{
  const store = storeOf();
  const r = store.get("work_item", spare);
  store.put("work_item", spare, { ...r, status: "DONE" }, Number(r.version));
}
const depRes2 = await api("/api/work-items", "POST", {
  business_id: bid, title: "dep2", goal: "g", assignee_agent_id: lead });
const dep2 = String(depRes2.data.work_item_id);
const depRow = await wi(dep2);
const depSet = await api(`/api/work-items/${dep2}/dependencies`, "PUT",
  { depends_on: [spare], expected_version: Number(depRow.version ?? 0) });
ok("FC-NEG dep-set on forged DONE", depSet.status === 200);
const depOpen = await openWI(dep2);
ok("FC-NEG DONE-without-WCP not a dep", depOpen.status !== 200,
  String(depOpen.data?.error?.code ?? depOpen.data?.error ?? depOpen.status));

// NEGATIVE: forged mission completion never folds
const fgRes = await api("/api/work-items", "POST", {
  business_id: bid, title: "fg", goal: "g", assignee_agent_id: lead });
const fgId = String(fgRes.data.work_item_id);
await openWI(fgId);
const fgRow = await wi(fgId);
const fgMid = String((fgRow.mission_ids ?? [])[0] ?? "");
forgeMission(fgMid); // status=COMPLETED, zero runtime evidence
const fgAfter = await fold(fgId);
ok("FC-NEG forged-mission quarantined, no WCP",
  fgAfter.status !== "DONE" && !wcpOf(fgId) &&
  String(fgAfter.blocked_code ?? "") === "TERMINAL_PROVENANCE_CORRUPT",
  `status=${fgAfter.status} blocked=${fgAfter.blocked_code ?? ""}`);

// NEGATIVE: duplicate open on DONE item
const reOpen = await openWI(A);
ok("FC-NEG reopen-DONE-fails", reOpen.status !== 200);

// NEGATIVE: concurrent opens mint exactly one mission
const raceRes = await api("/api/work-items", "POST", {
  business_id: bid, title: "race", goal: "g", assignee_agent_id: lead });
const raceId = String(raceRes.data.work_item_id);
const [r1, r2] = await Promise.all([openWI(raceId), openWI(raceId)]);
const raceRow = await wi(raceId);
ok("FC-NEG concurrent-open exactly-one-mission",
  (r1.status === 200) !== (r2.status === 200) &&
  (raceRow.mission_ids ?? []).length === 1 && bindingsOf(raceId).length === 1,
  `${r1.status}/${r2.status}`);

// FINAL RESTART — boot reconcile must quarantine the forged spare DONE
srv = await restart(srv);
const spareFinal = await wi(spare);
ok("FC-NEG restart-quarantines-forged-DONE",
  String(spareFinal.blocked_code ?? "") === "TERMINAL_PROVENANCE_CORRUPT",
  `blocked=${spareFinal.blocked_code ?? ""}`);

// ================= FC-R1: genuine routine lifecycle =================
// createRoutine → real fireDue → occurrence → mirror → canonical
// completion → DONE mirror / zero WCP → restart honest → promote/reopen
// → canonical WGM → bound mission → WCP → restart → zero duplicates.
const rtRes = await api("/api/routines", "POST", {
  business_id: bid, name: "fc-daily", goal_template: "g", cron: "0 9 * * *" });
const rt = String(rtRes.data?.routine_id ?? "");
const schedId = String((rtRes.data?.schedule_id ?? ""));
const rtItemsOf = () =>
  rows("work_item").filter((w) => String(w.routine_id ?? "") === rt);

// NEGATIVE: caller-supplied schedule metadata is a label, never a fire —
// it must NOT mint a routine mirror.
const forgeCall = await api("/api/missions", "POST", {
  project_id: projectId, goal: "routine fc run",
  metadata: { business_id: bid, schedule_id: schedId, plan_source: "schedule" } });
await board();
await board();
ok("FC-R1 caller-metadata forgery does not project",
  forgeCall.status === 200 && rtItemsOf().length === 0,
  `call=${forgeCall.status} items=${rtItemsOf().length}`);

// GENUINE canonical fire — real MissionScheduleService.fireDue on the
// same store, submitting through the governed /api/missions path.
const svc2 = new PAIR.PairControlPlane(storeOf());
const sched2 = new PAIR.MissionScheduleService(svc2);
const fireRoutine = async (now) => {
  if (!now) {
    const s = storeOf();
    const row = s.get("mission_schedule", schedId);
    row.next_due_at = new Date(Date.now() - 1000).toISOString();
    s.put("mission_schedule", schedId, row, Number(row.version));
  }
  return sched2.fireDue((input) =>
    api("/api/missions", "POST", {
      project_id: projectId, goal: input.goal, metadata: input.metadata,
    }).then((r) => r.data), now);
};

// Occurrence 1: fire → mirror IN_PROGRESS → canonical completion → DONE mirror
const fire1 = await fireRoutine();
const occ1 = rows("schedule_occurrence")
  .find((o) => String(o.schedule_id) === schedId && o.mission_id != null);
ok("FC-R1 genuine fire binds occurrence FIRED",
  fire1.fired.includes(schedId) && !!occ1 && String(occ1.status) === "FIRED",
  `fired=${fire1.fired} occ=${occ1?.occurrence_id} status=${occ1?.status}`);
const rtMid1 = String(occ1?.mission_id ?? "");
await board();
const rtItems1 = rtItemsOf();
ok("FC-R1 canonical mirror projected (WI_RT id + WGM)",
  rtItems1.length === 1 && /^WI_RT_[0-9a-f]{24}$/.test(String(rtItems1[0].work_item_id)) &&
  rows("work_graph_membership").filter((g) =>
    String(g.work_item_id) === String(rtItems1[0].work_item_id) &&
    String(g.membership_type) === "STANDALONE").length === 1,
  `items=${rtItems1.length} id=${rtItems1[0]?.work_item_id}`);
const rtWid1 = String(rtItems1[0].work_item_id);
completeMission(rtMid1);
await board();
const rtDone1 = await wi(rtWid1);
ok("FC-R1 DONE mirror zero WCP/zero item authority",
  String(rtDone1.status) === "DONE" && !wcpOf(rtWid1),
  `status=${rtDone1.status} wcp=${!!wcpOf(rtWid1)}`);

// RESTART — the DONE mirror stays honest (canonical provenance intact)
srv = await restart(srv);
const rtAfter1 = await wi(rtWid1);
ok("FC-R1 DONE mirror honest after restart",
  String(rtAfter1.status) === "DONE" &&
  String(rtAfter1.blocked_code ?? "") !== "TERMINAL_PROVENANCE_CORRUPT",
  `status=${rtAfter1.status} blocked=${rtAfter1.blocked_code ?? ""}`);

// Occurrence 2: fire → mission FAILS → BLOCKED mirror → promote/reopen →
// canonical WGM + bound mission → WCP → restart → zero duplicates.
await fireRoutine("2999-01-01T00:00:00Z");
const occ2 = rows("schedule_occurrence")
  .filter((o) => String(o.schedule_id) === schedId && o.mission_id != null)
  .sort((a, b) => String(b.due_at).localeCompare(String(a.due_at)))[0];
const rtMid2 = String(occ2?.mission_id ?? "");
ok("FC-R1 second occurrence fired+bound", !!occ2 && rtMid2 !== rtMid1,
  `occ2=${occ2?.occurrence_id} mid2=${rtMid2}`);
// run the scheduler mission to FAILED — mirror folds BLOCKED
// R3 — canonical failure: mission + runtime transition evidence.
terminateMission(rtMid2, "FAILED");
await board();
const rtItems2 = rtItemsOf();
const rtWid2 = String(rtItems2.find((w) => String(w.work_item_id) !== rtWid1)?.work_item_id ?? "");
ok("FC-R1 failed run mirrors BLOCKED",
  rtItems2.length === 2 && String((await wi(rtWid2)).status) === "BLOCKED",
  `items=${rtItems2.length} status=${(await wi(rtWid2)).status}`);

// Promote/reopen: canonical WGM must already pin it; open mints binding+mission.
const promote = await openWI(rtWid2);
const boundRow = await wi(rtWid2);
const boundMid = String((boundRow.mission_ids ?? []).slice(-1)[0] ?? "");
const rtBindings = bindingsOf(rtWid2);
ok("FC-R1 promotion → canonical WGM + bound mission",
  promote.status === 200 && boundMid !== rtMid2 &&
  rows("work_graph_membership").filter((g) => String(g.work_item_id) === rtWid2).length === 1 &&
  rtBindings.length === 1 && String(rtBindings[0].mission_id) === boundMid,
  `promote=${promote.status} boundMid=${boundMid} wgms=${rows("work_graph_membership").filter((g) => String(g.work_item_id) === rtWid2).length}`);
// complete bound mission canonically → real WCP
completeMission(boundMid);
const rtDone2 = await fold(rtWid2);
ok("FC-R1 reopened routine completes with WGM→binding→WCP",
  String(rtDone2.status) === "DONE" && !!wcpOf(rtWid2) &&
  String(wcpOf(rtWid2).mission_id) === boundMid,
  `status=${rtDone2.status} wcp=${!!wcpOf(rtWid2)}`);

// FINAL RESTART — promoted item + both mirrors converge, zero duplicates
srv = await restart(srv);
const rtFinal2 = await wi(rtWid2);
ok("FC-R1 restart zero-dup (1 mirror each, 1 WGM, 1 binding, 1 WCP)",
  rtItemsOf().length === 2 && String(rtFinal2.status) === "DONE" &&
  rows("work_graph_membership").filter((g) => String(g.work_item_id) === rtWid2).length === 1 &&
  bindingsOf(rtWid2).length === 1 && !!wcpOf(rtWid2) &&
  anchorsOf(rtWid2).length === 1,
  `items=${rtItemsOf().length} status=${rtFinal2.status} anchors=${anchorsOf(rtWid2).length}`);

// ================= FC-R2: routine mission-lineage tamper =================
// genuine scheduler mission stays LIVE; a foreign terminal mission id is
// appended to the mirror's mission_ids → restart/board must quarantine;
// openWorkItem must fail closed — zero new mission/binding/dispatch/WCP.
// Occurrence 3: fire → mirror IN_PROGRESS (scheduler mission RUNNING).
await fireRoutine("2999-02-01T00:00:00.000Z");
const occs3 = rows("schedule_occurrence")
  .filter((o) => String(o.schedule_id) === schedId && o.mission_id != null &&
    ![rtMid1, rtMid2].includes(String(o.mission_id)));
const rtMid3 = String(occs3[occs3.length - 1]?.mission_id ?? "");
ok("FC-R2 third occurrence fired+bound", !!rtMid3 && rtMid3 !== rtMid2,
  `mid3=${rtMid3}`);
svc2.transitionMission(rtMid3, "READY", "PAIR_MISSION_RUNTIME");
svc2.transitionMission(rtMid3, "RUNNING", "PAIR_MISSION_RUNTIME");
await board();
const rtWid3 = String(rtItemsOf().find((w) =>
  (w.mission_ids ?? []).includes(rtMid3))?.work_item_id ?? "");
ok("FC-R2 live scheduler mirror projected", !!rtWid3 &&
  String((await wi(rtWid3)).status) === "IN_PROGRESS",
  `wid3=${rtWid3} status=${(await wi(rtWid3)).status}`);
// Inject a FOREIGN terminal mission id into the mirror's lineage.
const foreign = await api("/api/missions", "POST",
  { project_id: projectId, goal: "foreign tail" });
const fMid = String(foreign.data?.mission_id ?? "");
svc2.transitionMission(fMid, "READY", "PAIR_MISSION_RUNTIME");
svc2.transitionMission(fMid, "RUNNING", "PAIR_MISSION_RUNTIME");
svc2.transitionMission(fMid, "FAILED", "PAIR_MISSION_RUNTIME");
{
  const s = storeOf();
  const w = s.get("work_item", rtWid3);
  w.mission_ids = [rtMid3, fMid];
  s.put("work_item", rtWid3, w, Number(w.version));
}
// RESTART — the corrupted lineage survives a process boundary; board must
// quarantine, never fold the foreign state, never open a replacement.
srv = await restart(srv);
await board(); await board();
const rtQ = await wi(rtWid3);
ok("FC-R2 foreign tail quarantined (restart+board, no foreign fold)",
  String(rtQ.blocked_code ?? "") === "TERMINAL_PROVENANCE_CORRUPT" &&
  (rtQ.mission_ids ?? []).length === 2,
  `blocked=${rtQ.blocked_code ?? ""} mids=${(rtQ.mission_ids ?? []).length}`);
const missionsBefore = rows("mission").length;
const openRes = await openWI(rtWid3);
const rtQ2 = await wi(rtWid3);
ok("FC-R2 open gate fail-closed — zero new mission/binding/intent/WCP",
  openRes.status !== 200 &&
  rows("mission").length === missionsBefore &&
  bindingsOf(rtWid3).length === 0 &&
  (rtQ2.pending_open_id ?? null) === null &&
  !wcpOf(rtWid3),
  `open=${openRes.status} missionsΔ=${rows("mission").length - missionsBefore} ` +
  `bindings=${bindingsOf(rtWid3).length} wcp=${!!wcpOf(rtWid3)}`);

// Legitimate canonical reopen still succeeds: occurrence 4 → FAILED run →
// BLOCKED mirror → promote → canonical WGM + bound mission → WCP.
await fireRoutine("2999-03-01T00:00:00.000Z");
const occs4 = rows("schedule_occurrence")
  .filter((o) => String(o.schedule_id) === schedId && o.mission_id != null &&
    ![rtMid1, rtMid2, rtMid3].includes(String(o.mission_id)));
const rtMid4 = String(occs4[occs4.length - 1]?.mission_id ?? "");
// R3 — canonical failure evidence on both state machines.
terminateMission(rtMid4, "FAILED");
await board();
const rtWid4 = String(rtItemsOf().find((w) =>
  (w.mission_ids ?? []).includes(rtMid4))?.work_item_id ?? "");
const promote4 = await openWI(rtWid4);
const boundRow4 = await wi(rtWid4);
const boundMid4 = String((boundRow4.mission_ids ?? []).slice(-1)[0] ?? "");
ok("FC-R2 legitimate canonical reopen still succeeds",
  promote4.status === 200 && !!rtWid4 && boundMid4 !== rtMid4 &&
  (boundRow4.mission_ids ?? []).length === 2 &&
  bindingsOf(rtWid4).length === 1 &&
  rows("work_graph_membership").filter((g) => String(g.work_item_id) === rtWid4).length === 1,
  `promote=${promote4.status} boundMid=${boundMid4} mids=${(boundRow4.mission_ids ?? []).length}`);
completeMission(boundMid4);
const rtDone4 = await fold(rtWid4);
ok("FC-R2 reopened routine completes WGM→binding→WCP",
  String(rtDone4.status) === "DONE" && !!wcpOf(rtWid4) &&
  String(wcpOf(rtWid4).mission_id) === boundMid4,
  `status=${rtDone4.status} wcp=${!!wcpOf(rtWid4)}`);

// ================= FC-R3: mutable mission.status ≠ replacement authority =================
// (A) bound mission + runtime RUNNING → forge mission.status=FAILED →
// board/sync folds nothing and quarantines; openWorkItem fails closed —
// zero new intent/binding/mission/dispatch/WCP.
{
  const r3a = await api("/api/work-items", "POST", {
    business_id: bid, title: "r3a", goal: "g", assignee_agent_id: lead });
  const widA = String(r3a.data.work_item_id);
  await openWI(widA);
  const midA = String((await wi(widA)).mission_ids[0]);
  // Attack: mutate ONLY the mutable field — no transitions, no runtime.
  { const s = storeOf(); const m = s.get("mission", midA);
    m.status = "FAILED"; s.put("mission", midA, m, Number(m.version)); }
  await board();
  const wA = await wi(widA);
  const m0 = rows("mission").length, b0 = rows("work_open_binding").length;
  const openA = await openWI(widA);
  const wA2 = await wi(widA);
  ok("FC-R3-A forged FAILED on live bound mission → quarantine + fail-closed open, zero mints",
    String(wA.blocked_code ?? "") === "TERMINAL_PROVENANCE_CORRUPT" &&
    String(wA.status) === "IN_PROGRESS" &&
    openA.status !== 200 &&
    rows("mission").length === m0 && rows("work_open_binding").length === b0 &&
    (wA2.pending_open_id ?? null) === null && !wcpOf(widA),
    `blocked=${wA.blocked_code ?? ""} status=${wA.status} open=${openA.status}`);
}

// (B) genuine scheduler routine mission RUNNING + runtime RUNNING →
// forge mission.status=FAILED → mirror quarantines, never BLOCKED, and
// the corrupt mirror can never be promoted into a replacement mission.
{
  await fireRoutine("2999-04-01T00:00:00.000Z");
  const occs5 = rows("schedule_occurrence")
    .filter((o) => String(o.schedule_id) === schedId && o.mission_id != null &&
      ![rtMid1, rtMid2, rtMid3, rtMid4].includes(String(o.mission_id)));
  const rtMid5 = String(occs5[occs5.length - 1]?.mission_id ?? "");
  ok("FC-R3-B fifth occurrence fired", !!rtMid5, `mid5=${rtMid5}`);
  // Mission + runtime BOTH RUNNING — then forge ONLY mission.status.
  terminateMission(rtMid5, "RUNNING");
  { const s = storeOf(); const m = s.get("mission", rtMid5);
    m.status = "FAILED"; s.put("mission", rtMid5, m, Number(m.version)); }
  await board();
  const rtWid5 = String(rtItemsOf().find((w) =>
    (w.mission_ids ?? []).includes(rtMid5))?.work_item_id ?? "");
  const w5 = await wi(rtWid5);
  const m0 = rows("mission").length, b0 = rows("work_open_binding").length;
  const open5 = await openWI(rtWid5);
  ok("FC-R3-B forged scheduler FAILED → mirror quarantined, no BLOCKED, no reopen",
    !!rtWid5 && String(w5.blocked_code ?? "") === "TERMINAL_PROVENANCE_CORRUPT" &&
    String(w5.status) !== "BLOCKED" &&
    open5.status !== 200 &&
    rows("mission").length === m0 && rows("work_open_binding").length === b0,
    `wid5=${rtWid5} status=${w5.status} blocked=${w5.blocked_code ?? ""} open=${open5.status}`);
}

// (C) a separate mission through REAL canonical failure → governed
// reopen mints exactly one bound attempt — a second open while the
// replacement is still live fails closed.
{
  const r3c = await api("/api/work-items", "POST", {
    business_id: bid, title: "r3c", goal: "g", assignee_agent_id: lead });
  const widC = String(r3c.data.work_item_id);
  await openWI(widC);
  const midC = String((await wi(widC)).mission_ids[0]);
  terminateMission(midC, "FAILED");
  const wC = await fold(widC);
  const openC = await openWI(widC);
  const wC2 = await wi(widC);
  const midsC = wC2.mission_ids ?? [];
  ok("FC-R3-C canonical failure → BLOCKED → governed reopen exactly once",
    String(wC.status) === "BLOCKED" && openC.status === 200 &&
    midsC.length === 2 && String(midsC[1]) !== midC &&
    bindingsOf(widC).length === 2,
    `status=${wC.status} open=${openC.status} mids=${midsC.length} bindings=${bindingsOf(widC).length}`);
  const openC2 = await openWI(widC);
  ok("FC-R3-C second reopen while replacement live denied",
    openC2.status !== 200 &&
    (await wi(widC)).mission_ids.length === 2,
    `open2=${openC2.status}`);
}

// ================= FC-R4: omission-safe attempt history =================
// (A) bound Mission1 + item BLOCKED (mission PAUSED, non-terminal) →
// delete the Mission1 ROW while WOB/runtime remain → open fails closed:
// Δmission=0, ΔWOB=0, zero dispatch.
{
  const r4a = await api("/api/work-items", "POST", {
    business_id: bid, title: "r4a", goal: "g", assignee_agent_id: lead });
  const widA = String(r4a.data.work_item_id);
  await openWI(widA);
  const midA = String((await wi(widA)).mission_ids[0]);
  const blk = await api(`/api/work-items/${widA}/block`, "POST", { reason: "hold" });
  const wPre = await wi(widA);
  const mPre = rows("mission"), bPre = rows("work_open_binding");
  // Attack: remove ONLY the mission row — WOB + runtime evidence intact.
  { const s = storeOf();
    s.db.prepare("DELETE FROM entities WHERE entity_type='mission' AND entity_id=?").run(midA); }
  const openA = await api(`/api/work-items/${widA}/open`, "POST", {});
  const wA = await wi(widA);
  ok("FC-R4-A deleted bound mission row → open fails closed, zero mints",
    blk.status === 200 && String(wPre.status) === "BLOCKED" &&
    openA.status !== 200 &&
    rows("mission").length === mPre.length - 1 &&
    rows("work_open_binding").length === bPre.length &&
    String((wA.mission_ids ?? [])[0] ?? "") === midA &&
    (wA.pending_open_id ?? null) === null,
    `blk=${blk.status} status=${wPre.status} open=${openA.status}`);
}

// (B) same setup but TRUNCATE work_item.mission_ids — WOB still proves
// Mission1 existed → identical fail-closed result.
{
  const r4b = await api("/api/work-items", "POST", {
    business_id: bid, title: "r4b", goal: "g", assignee_agent_id: lead });
  const widB = String(r4b.data.work_item_id);
  await openWI(widB);
  const midB = String((await wi(widB)).mission_ids[0]);
  await api(`/api/work-items/${widB}/block`, "POST", { reason: "hold" });
  { const s = storeOf(); const w = s.get("work_item", widB);
    w.mission_ids = []; s.put("work_item", widB, w, Number(w.version)); }
  const m0 = rows("mission").length, b0 = rows("work_open_binding").length;
  const openB = await api(`/api/work-items/${widB}/open`, "POST", {});
  ok("FC-R4-B mission_ids truncation cannot erase WOB-proven live attempt → fail closed",
    openB.status !== 200 &&
    rows("mission").length === m0 && rows("work_open_binding").length === b0,
    `open=${openB.status} missions=${rows("mission").length}/${m0}`);
  // restore the projection so integrity verification stays clean
  { const s = storeOf(); const w = s.get("work_item", widB);
    w.mission_ids = [midB]; s.put("work_item", widB, w, Number(w.version)); }
}

// (C) canonical terminal M1 → legitimate M2 reopen → canonical attempt
// history validates → normal execution proceeds.
{
  const r4c = await api("/api/work-items", "POST", {
    business_id: bid, title: "r4c", goal: "g", assignee_agent_id: lead });
  const widC = String(r4c.data.work_item_id);
  await openWI(widC);
  const midC1 = String((await wi(widC)).mission_ids[0]);
  terminateMission(midC1, "FAILED");
  const wC = await fold(widC);
  const openC = await api(`/api/work-items/${widC}/open`, "POST", {});
  const wC2 = await wi(widC);
  const midsC = wC2.mission_ids ?? [];
  const wobs = bindingsOf(widC).filter((x) => String(x.state) === "BOUND");
  ok("FC-R4-C canonical terminal → legitimate reopen → ordered WOB history validates",
    String(wC.status) === "BLOCKED" && openC.status === 200 &&
    midsC.length === 2 && String(midsC[1]) !== midC1 &&
    wobs.length === 2 &&
    String(wobs[0].mission_id) === midC1 && String(wobs[1].mission_id) === String(midsC[1]) &&
    String(wobs[0].open_id) < String(wobs[1].open_id),
    `status=${wC.status} open=${openC.status} mids=${midsC.length} wobs=${wobs.length}`);
}

// ================= exactly-once audit over the whole store =================
{
  const wcps = rows("work_completion");
  const wiAll = rows("work_item");
  let dupAnchor = 0, missingWcp = 0;
  for (const w of wiAll) {
    const wid = String(w.work_item_id);
    const a = anchorsOf(wid);
    if (a.length > 1) dupAnchor++;
    // forged/quarantined DONE rows legitimately have no WCP
    if (String(w.status) === "DONE" && w.routine_id == null &&
        String(w.blocked_code ?? "") !== "TERMINAL_PROVENANCE_CORRUPT" &&
        !wcpOf(wid)) {
      missingWcp++; console.log(`    missingWcp: ${wid}`);
    }
  }
  const acceptTotal = wiAll
    .flatMap((w) => acceptOf(String(w.work_item_id)))
    .length;
  ok("FC-XO exactly-one WCP+anchor per DONE item",
    dupAnchor === 0 && missingWcp === 0 && wcps.length === 5 + 1 + 2, // A..E + parent + 2 promoted routines
    `wcps=${wcps.length} dupAnchors=${dupAnchor} missingWcp=${missingWcp}`);
  ok("FC-XO exactly-one ACCEPT total", acceptTotal === 1, `accepts=${acceptTotal}`);
  const inbox = await api(`/api/org-agents/${rev}/inbox`);
  ok("FC-XO ack receipt delivered", inbox.status === 200 &&
    ((inbox.data?.messages ?? []).length >= 1));
  const v = storeOf().verifyIntegrity();
  ok("FC-XO store integrity verified", Number(v.errors ?? 0) === 0,
    `errors=${v.errors ?? 0}`);
}

srv.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 400));
const failed = results.filter(([, c]) => !c);
console.log(`\n===== FC E2E: ${results.length - failed.length}/${results.length} PASS =====`);
if (failed.length) {
  for (const [n] of failed) console.log(`FAILED: ${n}`);
  process.exit(1);
}
