/**
 * P9 Mission Control server — `node:http` JSON API + functional operator UI.
 *
 * Read endpoints expose canonical projections only; every mutation endpoint
 * requires an explicit operator identity (`x-operator-id` header or
 * `operator_id` in the JSON body) and delegates to canonical services —
 * this server never writes a DB row directly and never serves credentials,
 * env dumps, or secret material.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { IntegrityError, PairError, PolicyError } from "./errors.js";
import { compatOutboxBasename } from "./canonical.js";
import { MAX_ARTIFACT_BYTES } from "./artifact-authority.js";
import { ulid } from "ulid";
import type { MissionControl } from "./mission-control.js";
import type { CredentialBroker } from "./credential-broker.js";
import type { BusinessLayer } from "./business.js";
import type { WorkforceService } from "./work-graph.js";
import type { PairEvidenceStore } from "./store.js";
import type { CeoDecisionInvoker } from "./ceo-decision.js";
import type { ConversationSessionService } from "./conversation-session.js";
import type { ConversationReadGrantService } from "./conversation-read-grant.js";
import type { ConversationReasoningService } from "./conversation-reasoning.js";
import { classifyRequestCredential } from "./operational-query.js";
import {
  approveGoalIntentItems,
  GOAL_INTENT_APPROVAL_ENTITY,
  semanticMode,
  type GoalIntentApproval,
} from "./semantic-goal-understanding.js";
import {
  deriveIntakeDraft,
  deriveManualDraft,
  INTAKE_DRAFT_SCHEMA,
  INTAKE_MAX_GOAL,
} from "./objective-intake.js";
import type { MissionDraftService } from "./mission-draft.js";
import { resolveProposalProject } from "./mission-draft.js";
import type { TelegramConversationService } from "./telegram-conversation.js";
import { ObjectiveWorkstreamService } from "./objective-workstream.js";
import { ObjectiveAutoPolicyService } from "./objective-auto-policy.js";
import { ObjectiveReviewSignoffService } from "./objective-review-signoff.js";
import type { ObjectiveAutoScheduler } from "./objective-auto-scheduler.js";
import type { ObjectiveAutoDriverService } from "./objective-auto-driver.js";
import {
  createDefaultObjectiveOperatingService,
  type ObjectiveOperatingService,
} from "./objective-operating-loop.js";
import { ObjectiveCockpitService } from "./objective-cockpit.js";
import { ObjectivePortfolioService } from "./objective-portfolio.js";
import { ObjectiveRelationService } from "./objective-relation.js";
import { OrgAgentDutyService } from "./org-agent-duty.js";
import type { ArtifactAuthority } from "./artifact-authority.js";

export interface MissionControlServerDeps {
  control: MissionControl;
  /** Serve a built SPA (e.g. apps/mission-control-ui/dist) for non-/api GETs. */
  staticDir?: string;
  /**
   * Plan-proposal seam (Phase B): runs the Planner failover chain at the
   * API edge and returns { input, planner } where `input` carries the
   * winning sanitized task list (metadata.llm_plan) and `planner` is the
   * attempt/provenance evidence persisted with the durable preview.
   * Phase C — absent → the sync planner fails closed
   * FAIL_CLOSED_PLAN_REQUIRED (no deterministic template remains), and
   * delegated open/draft/schedule callers fail FAIL_CLOSED_NO_PLANNER.
   */
  planExpander?: (
    input: Record<string, unknown>,
  ) => Promise<{ input: Record<string, unknown>; planner?: {
    attempts: unknown[]; winner: unknown; warnings: string[];
    allowed_capabilities?: string[]; capability_sets?: string[][];
  } }>;
  /** Back-compat shape: older expanders returned the bare input. */
  planExpanderResult?: never;
  /**
   * Optional bearer token gate: when set, every `/api/*` request must carry
   * `Authorization: Bearer <token>` (or `?token=` for SSE EventSource, which
   * cannot send headers). Static SPA assets stay public so the UI can load
   * and ask for the token. Unset → no gate (local dev default).
   */
  authToken?: string;
  /**
   * Phase 1 R1 — the SEPARATE operational-status admin credential
   * (PAIR_MC_ADMIN_TOKEN). Bearer-only (never `?token=`); it mints the
   * `admin` principal for the conversation status hook and
   * authenticates ONLY the operational-status boundary — conversation
   * create/read/turns. It can NEVER satisfy the general /api gate:
   * credentials, missions, budgets, drafts, confirms and every other
   * mutation still require the MC token, and an admin-only turn is
   * read_only (proposals can never materialize). Equal to the MC token
   * → admin lane disabled outright. Unset → every caller is scoped. */
  adminToken?: string;
  /**
   * Narrow-scope token for `POST /api/outbox` — remote executors push binary
   * deliverables (chart screenshots, report files) with
   * `x-outbox-token: <token>`. Separate from authToken so remote agents never
   * hold full API access; unset → the endpoint stays disabled.
   */
  outboxToken?: string;
  /**
   * Credential broker: operator manages the vault via MC-token routes
   * (POST/GET /api/credentials); remote executors release a named credential
   * via POST /api/broker/fetch with `x-broker-token` — a narrow token separate
   * from authToken. Unset brokerToken → fetch endpoint disabled.
   */
  broker?: CredentialBroker;
  brokerToken?: string;
  /** F1 §6 — master secret that verifies `x-artifact-capability` remote
   *  uploads (PAIR_ARTIFACT_UPLOAD_TOKEN or the broker master). The
   *  generic outbox token remains transport compatibility only — it can
   *  never mint canonical artifact authority. Unset → capability ingest
   *  disabled. */
  artifactUploadToken?: string;
  /** F2 R2.4 — master secret that verifies `x-artifact-consume-capability`
   *  on /api/artifacts/fetch. Resolved ONCE at bootstrap
   *  (PAIR_ARTIFACT_UPLOAD_TOKEN || PAIR_BROKER_TOKEN, mirroring the
   *  executor's mint side); request handling never inspects ambient env.
   *  Falls back to artifactUploadToken — serve-mission-control already
   *  resolves the same chain there. PAIR_OUTBOX_TOKEN is never consume
   *  authority. Neither set → the consume lane is disabled. */
  artifactConsumeToken?: string;
  /** Optional business layer: companies → org agents → work items →
   *  routines → budgets, all dispatching through startMission. */
  business?: BusinessLayer;
  /** Optional workforce graph: decompose/delegate/dependency edges on
   *  work items (P14 Workforce V2 Phase 1). Coordinates only — never
   *  dispatches. */
  workforce?: WorkforceService;
  /** Canonical evidence store — needed to compose the P15.6 operating
   *  service for /api/vnext/objectives/:id/ceo-cycle (P15.7). */
  store?: PairEvidenceStore;
  /** P15.10-B owner-scoped RECONCILE_ONLY scheduler projection. */
  autoScheduler?: ObjectiveAutoScheduler;
  /** P15.10-C — the production autonomous driver. Present ONLY when
   *  the deployment explicitly opted in (PAIR_OBJECTIVE_AUTO_DRIVER=1
   *  in the serve script); absent → scheduler status keeps reporting
   *  driver_ready:false and the auto-driver route 404s. Read-only
   *  surface — no mutating driver route exists. */
  autoDriver?: Pick<ObjectiveAutoDriverService, "status" | "statusReadOnly" | "driverStatus" | "readiness">;
  /** P15.9-A1 — canonical artifact verification authority used by the
   *  cockpit projection to re-prove producer/execution/mission binding
   *  + retained CAS bytes NOW (service.artifacts). Absent → artifacts
   *  render as unverified-dropped in the cockpit. */
  artifacts?: ArtifactAuthority;
  /** Executor Management read model — adapter ids bound IN THIS
   *  process (the runtime's merged adapter map). The executors
   *  projection marks enabled-but-unbound executors requires_restart:
   *  toggling intent alone can never conjure an adapter; bootstrap +
   *  restart can. Absent → every row reports bound:false. */
  executorBoundIds?: () => string[];
  /** TEST-ONLY: deterministic CEO decision transport for the
   *  lazily-composed operating service. Production bootstrap never
   *  sets it (the route resolves the real codex-cli model); HTTP
   *  callers can never inject it — it is a server-wiring dep only. */
  ceoInvoker?: CeoDecisionInvoker;
  /** UI-V2 (Phase B) — bounded advisory interpretation for the NL intake
   *  draft seam. Server wiring only (serve-mission-control owns the
   *  provider lane); absent → /api/v1/intake/draft reports mode:"off"
   *  honestly and still serves the manual draft. The result is
   *  NON-AUTHORITATIVE evidence — never pinned to a run, never
   *  persisted as canonical input. */
  intakeAnalyze?: (input: {
    goal: string;
    business_id: string | null;
    project_id: string | null;
    operator_id: string;
  }) => Promise<Record<string, unknown> | null>;
  /** P15.8-D — conversation layer composition (chat + governed mission
   *  drafts). Absent entirely → every /api/conversations* route is
   *  CONVERSATION_DISABLED; `reasoning` absent → only the /turns route
   *  is unavailable (sessions/history/drafts keep working); `drafts`
   *  absent → draft routes unavailable. Unrelated Mission Control
   *  routes are never affected. */
  conversation?: {
    sessions: ConversationSessionService;
    reasoning?: ConversationReasoningService;
    drafts?: MissionDraftService;
    /** P15.8-E — telegram ingress authority. Absent → every
     *  /api/telegram/conversation* route is TELEGRAM_CONVERSATION_
     *  DISABLED; unrelated routes unaffected. */
    telegram?: TelegramConversationService;
    /** P16-D — canonical verified read grants for the operational-status
     *  surface. Absent → /api/conversations/read-grants* 404s and every
     *  non-admin principal stays UNVERIFIED_IDENTITY (default-deny). */
    readGrants?: ConversationReadGrantService;
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function tryStatic(staticDir: string | undefined, pathname: string, res: http.ServerResponse): boolean {
  if (!staticDir) return false;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const file = path.resolve(staticDir, rel);
  if (!file.startsWith(path.resolve(staticDir))) return false;
  const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(staticDir, "index.html");
  if (!fs.existsSync(target)) return false;
  res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(target));
  return true;
}

const UI_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PAIR Mission Control</title>
<style>
body{font-family:ui-monospace,Menlo,monospace;background:#0b0e14;color:#d5dbe5;margin:0;padding:16px}
h1{font-size:18px}nav{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
nav button{background:#1c2330;color:#d5dbe5;border:1px solid #344056;padding:4px 10px;cursor:pointer}
nav button.on{background:#2d3b55}
pre{background:#121722;border:1px solid #26303f;padding:10px;overflow:auto;max-height:70vh;font-size:12px}
table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #26303f;padding:3px 8px;text-align:left}
.badge{padding:1px 6px;border:1px solid #344056}input{background:#121722;color:#d5dbe5;border:1px solid #344056;padding:4px}
</style></head><body>
<h1>PAIR Mission Control</h1>
<div>operator: <input id="op" value="operator:local"></div>
<nav id="tabs"></nav>
<div id="view"></div>
<script>
const VIEWS={
 "Missions":"/api/missions","Health":"/api/health","Metrics":"/api/metrics",
 "Routing":"/api/routing","Recovery":"/api/recovery","Approvals":"/api/approvals",
 "Operations":"/api/operations",
 "Experience":"/api/experience","Self-Improvement":"/api/selfmod",
 "Business":"/api/businesses"};
const nav=document.getElementById("tabs"),view=document.getElementById("view"),op=document.getElementById("op");
let cur="Missions";
for(const name of Object.keys(VIEWS)){
 const b=document.createElement("button");b.textContent=name;
 b.onclick=()=>{cur=name;load()};nav.appendChild(b);
}
async function api(url,method,body){
 const r=await fetch(url,{method:method||"GET",
  headers:{"content-type":"application/json","x-operator-id":op.value},
  body:body?JSON.stringify(body):undefined});
 return {status:r.status,data:await r.json().catch(()=>({}))};
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}
async function load(){
 const r=await api(VIEWS[cur]);
 let html="<pre>"+esc(JSON.stringify(r.data,null,1))+"</pre>";
 if(cur==="Missions"&&r.data.missions){
  html="<table><tr><th>mission</th><th>status</th><th>runtime</th><th>actions</th></tr>"+
   r.data.missions.map(m=>"<tr><td>"+esc(m.mission_id)+"</td><td>"+esc(m.status)+"</td><td>"+esc(m.runtime_state||"-")+
   "</td><td>"+["pause","resume","cancel"].map(a=>
    '<button onclick="act(\\''+m.mission_id+'\\',\\''+a+'\\')">'+a+"</button>").join("")+
   ' <button onclick="detail(\\''+m.mission_id+'\\')">detail</button></td>').join("")+"</table>"+html;
 }
 if(cur==="Approvals"&&Array.isArray(r.data)){
  html="<table><tr><th>id</th><th>type</th><th>action</th><th>status</th><th>decide</th></tr>"+
   r.data.filter(a=>a.status==="PENDING").map(a=>
    "<tr><td>"+esc(a.approval_id)+"</td><td>"+esc(a.approval_type)+"</td><td>"+esc(a.requested_action)+"</td><td>"+esc(a.status)+"</td>"+
    '<td><button onclick="decide(\\''+a.approval_id+'\\',\\'approve\\')">approve</button>'+
    '<button onclick="decide(\\''+a.approval_id+'\\',\\'deny\\')">deny</button></td></tr>').join("")+"</table>"+html;
 }
 if(cur==="Business"){
  html='<div><input id="bizName" placeholder="business name"> <input id="bizPrj" placeholder="project_id">'+
   ' <button onclick="mkBiz()">create business</button></div>'+
   '<div id="bizList"></div><div id="bizBoard"></div>'+html;
  view.innerHTML=html;renderBiz(r.data);return;
 }
 view.innerHTML=html;
}
async function renderBiz(data){
 const list=(data.businesses||[]);
 document.getElementById("bizList").innerHTML="<h2>businesses</h2>"+
  list.map(b=>'<button onclick="bizDetail(\\''+b.business_id+'\\')">'+esc(b.name)+'</button> ').join("")+
  (list.length?"":"none yet");
}
async function mkBiz(){
 const r=await api("/api/businesses","POST",{name:document.getElementById("bizName").value,
  project_id:document.getElementById("bizPrj").value});
 if(r.status!==200)alert(JSON.stringify(r.data));load();
}
async function bizDetail(id){
 const r=await api("/api/businesses/"+id);
 const d=r.data,bb=document.getElementById("bizBoard");
 if(!d.business){bb.innerHTML="<pre>"+esc(JSON.stringify(d,null,1))+"</pre>";return}
 const cols=d.board||{};
 let h="<h2>"+esc(d.business.name)+"</h2>"+
  '<div><input id="wiTitle" placeholder="work item title"> <input id="wiGoal" placeholder="goal">'+
  ' <button onclick="mkWi(\\''+id+'\\')">+ work item</button>'+
  ' <input id="rtName" placeholder="routine name"> <input id="rtCron" placeholder="cron * * * * *">'+
  ' <input id="rtGoal" placeholder="goal template"> <button onclick="mkRt(\\''+id+'\\')">+ routine</button></div>';
 for(const s of Object.keys(cols)){
  h+="<h3>"+s+" ("+cols[s].length+")</h3><table>"+cols[s].map(w=>
   "<tr><td>"+esc(w.work_item_id)+"</td><td>"+esc(w.title)+(w.routine_id?" [routine]":"")+(w.claimed_by?" <b>held:"+esc(String(w.claimed_by).slice(0,14))+"</b>":"")+"</td><td>"+esc(w.department||"-")+"</td>"+
   "<td>"+esc(((w.blockers||[]).length?"blk:"+(w.blockers||[]).length+" ":"")+((w.comments||[]).length?"cmts:"+(w.comments||[]).length+" ":"")+((w.artifacts||[]).length?"art:"+(w.artifacts||[]).length:""))+"</td>"+
   "<td>"+(s==="READY"||s==="BLOCKED"||s==="BACKLOG"?'<button onclick="openWi(\\''+w.work_item_id+'\\')">open</button>':"")+"</td>"+
   "<td>"+(s!=="DONE"&&s!=="CANCELLED"?'<button onclick="wiBlock(\\''+w.work_item_id+'\\')">block</button>':"")+"</td>"+
   "<td>"+(s==="BLOCKED"?'<button onclick="wiUnblock(\\''+w.work_item_id+'\\')">unblock</button>':"")+"</td>"+
   "<td>"+(s!=="DONE"&&s!=="CANCELLED"?'<button onclick="wiCmt(\\''+w.work_item_id+'\\')">comment</button>':"")+"</td></tr>").join("")+"</table>";
 }
 h+="<h3>objectives</h3><table>"+(d.objectives||[]).map(o=>"<tr><td>"+esc(o.objective_id)+"</td><td>"+esc(o.title)+"</td><td>"+esc(o.metric||"-")+"</td><td>"+esc(o.target||"-")+"</td></tr>").join("")+"</table>";
 h+='<div><input id="objTitle" placeholder="objective title"> <input id="objMetric" placeholder="metric"> <input id="objTarget" placeholder="target"> <button onclick="mkObj(\\''+id+'\\')">+ objective</button></div>';
 h+="<h3>agents</h3><table>"+(d.agents||[]).map(a=>"<tr><td>"+esc(a.agent_id)+"</td><td>"+esc(a.title)+"</td><td>"+esc(a.department)+"</td><td>"+esc(a.status)+"</td><td>"+esc(((a.context_notes||[]).length)+" notes")+"</td></tr>").join("")+"</table>";
 h+='<div><input id="agTitle" placeholder="agent title"> <input id="agDept" placeholder="dept"> <button onclick="mkAg(\\''+id+'\\')">+ agent</button></div>';
 h+="<h3>routines</h3><table>"+(d.routines||[]).map(rt=>"<tr><td>"+esc(rt.name)+"</td><td>"+esc(rt.cron)+"</td><td>"+esc(rt.enabled?"on":"off")+"</td><td><button onclick=\"rtTog('"+rt.routine_id+"',"+(!rt.enabled)+")\">toggle</button></td></tr>").join("")+"</table>";
 bb.innerHTML=h;
}
async function mkAg(bid){const r=await api("/api/org-agents","POST",{business_id:bid,title:document.getElementById("agTitle").value,department:document.getElementById("agDept").value});if(r.status!==200)alert(JSON.stringify(r.data));bizDetail(bid)}
async function mkWi(bid){const r=await api("/api/work-items","POST",{business_id:bid,title:document.getElementById("wiTitle").value,goal:document.getElementById("wiGoal").value});if(r.status!==200)alert(JSON.stringify(r.data));bizDetail(bid)}
async function mkRt(bid){const r=await api("/api/routines","POST",{business_id:bid,name:document.getElementById("rtName").value,goal_template:document.getElementById("rtGoal").value,cron:document.getElementById("rtCron").value});if(r.status!==200)alert(JSON.stringify(r.data));bizDetail(bid)}
async function openWi(id){const r=await api("/api/work-items/"+id+"/open","POST",{});if(r.status!==200)alert(JSON.stringify(r.data));load()}
async function wiBlock(id){const reason=prompt("block reason");if(!reason)return;const r=await api("/api/work-items/"+id+"/block","POST",{reason});if(r.status!==200)alert(JSON.stringify(r.data));load()}
async function wiUnblock(id){const r=await api("/api/work-items/"+id+"/unblock","POST",{});if(r.status!==200)alert(JSON.stringify(r.data));load()}
async function wiCmt(id){const body=prompt("comment");if(!body)return;const r=await api("/api/work-items/"+id+"/comment","POST",{body});if(r.status!==200)alert(JSON.stringify(r.data));load()}
async function mkObj(bid){const r=await api("/api/objectives","POST",{business_id:bid,title:document.getElementById("objTitle").value,metric:document.getElementById("objMetric").value,target:document.getElementById("objTarget").value});if(r.status!==200)alert(JSON.stringify(r.data));bizDetail(bid)}
async function rtTog(id,en){const r=await api("/api/routines/"+id+"/"+(en?"enable":"disable"),"POST",{});if(r.status!==200)alert(JSON.stringify(r.data));load()}
async function act(id,a){await api("/api/missions/"+id+"/"+a,"POST",{});load()}
async function decide(id,a){
 const aData=(await api("/api/approvals")).data.find(x=>x.approval_id===id);
 const scope=aData&&aData.scope?aData.scope:{};
 const r=await api("/api/approvals/"+id+"/"+a,"POST",{scope});
 if(r.status!==200)alert(JSON.stringify(r.data));load();
}
async function detail(id){
 const r=await api("/api/missions/"+id);
 const t=await api("/api/missions/"+id+"/timeline");
 view.innerHTML="<pre>"+esc(JSON.stringify(r.data,null,1))+"</pre><h2>timeline</h2><pre>"+
  esc(JSON.stringify(t.data,null,1))+"</pre>";
}
load();setInterval(load,10000);
</script></body></html>`;

/** P2 §2: raw claim tokens never leave the server except inside the
 *  claim-creation response — strip the mirror field from any payload. */
function stripClaimToken(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripClaimToken);
  if (value && typeof value === "object") {
    const o = { ...(value as Record<string, unknown>) };
    for (const k of Object.keys(o)) {
      if (k === "claim_token") delete o[k];
      else o[k] = stripClaimToken(o[k]);
    }
    return o;
  }
  return value;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** R1.3 — wire-level body bounds. The request stream is bounded
 *  BEFORE full materialization: Content-Length is rejected early when
 *  it already exceeds the route bound, and cumulative streaming bytes
 *  are counted as chunks arrive — the socket is aborted the moment the
 *  bound is crossed; no `Buffer.concat` ever runs on an over-limit
 *  body. `/api/outbox` gets the canonical artifact wire bound
 *  (base64(64MiB) + bounded JSON overhead); every other route takes the
 *  small default bound (no API posts near it). */
const BODY_OVERHEAD_BYTES = 64 * 1024;
export const ARTIFACT_WIRE_BODY_BYTES =
  Math.ceil(MAX_ARTIFACT_BYTES * 4 / 3) + BODY_OVERHEAD_BYTES;
const LEGACY_WIRE_BODY_BYTES =
  Math.ceil(8 * 1024 * 1024 * 4 / 3) + BODY_OVERHEAD_BYTES;
const DEFAULT_BODY_BOUND_BYTES = 8 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`REQUEST_BODY_TOO_LARGE:${limit}`);
    this.name = "BodyTooLargeError";
  }
}

function routeBodyBound(p: string, req: http.IncomingMessage): number {
  if (p === "/api/outbox") {
    // The artifact-capability lane owns the 64MiB wire bound; the legacy
    // x-outbox-token lane keeps its 8MB artifact contract — its wire
    // bound is correspondingly smaller so legacy junk never approaches
    // the artifact bound.
    return req.headers["x-artifact-capability"]
      ? ARTIFACT_WIRE_BODY_BYTES
      : LEGACY_WIRE_BODY_BYTES;
  }
  return DEFAULT_BODY_BOUND_BYTES;
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const cl = Number(req.headers["content-length"] ?? 0);
  if (cl > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) {
      // Abort accumulation the moment the bound is crossed — the caller
      // answers 413 on the still-open socket; Node tears the request
      // stream down after res.end().
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** R2-F1 — `operator_goal` is canonical provenance pinned ONLY by
 *  trusted internal seams: `startBoundMission` derives it from the bound
 *  work item, and the confirm seam replays the digest-bound value the
 *  preview persisted. A public mission-creation body may NEVER name it —
 *  direct-mission authority derives from the authenticated request's
 *  `goal`. Rejected BEFORE any planner spend, at both the top level and
 *  inside caller-controlled `metadata` (the mint-time shadow check would
 *  catch the latter at confirm, but the request must never reach
 *  planning carrying forged authority). */
function rejectCallerOperatorGoal(body: Record<string, unknown>): void {
  const md = body.metadata as Record<string, unknown> | undefined;
  if (body.operator_goal != null || md?.operator_goal != null) {
    throw new IntegrityError(
      "FAIL_CLOSED_OPERATOR_GOAL_CALLER_SUPPLIED",
      "operator_goal is reserved canonical authority — direct submissions derive it from goal",
    );
  }
}

/** P18.6 — resolve a `goal_intent_approval_id` carried on a preview
 *  request into the GOVERNED amended goal revision. Server-side only:
 *  the caller names an approval row id; the persisted approval row
 *  supplies the amended goal text (never client-supplied text). Scope
 *  and operator binding are re-proven here — a cross-project or
 *  cross-operator replay fails closed before any planner spend. */
function resolveGoalIntentApprovalBody(
  store: PairEvidenceStore | undefined,
  body: Record<string, unknown>,
  operator: string | undefined,
): Record<string, unknown> {
  const approvalId = body.goal_intent_approval_id;
  if (approvalId == null || approvalId === "") return body;
  if (!store) {
    throw new IntegrityError("FAIL_CLOSED_GOAL_INTENT_APPROVAL", "store unavailable");
  }
  const approval = store.tryGet(
    GOAL_INTENT_APPROVAL_ENTITY,
    String(approvalId),
  ) as unknown as GoalIntentApproval | undefined;
  if (!approval) {
    throw new IntegrityError("FAIL_CLOSED_GOAL_INTENT_APPROVAL", "approval row not found");
  }
  const projectId = body.project_id != null ? String(body.project_id) : null;
  // Strict scope equality — an approval minted under one project never
  // replays under another, and an unscoped approval never widens into a
  // scoped one (null binds null only).
  if ((approval.scope?.project_id ?? null) !== projectId) {
    throw new IntegrityError(
      "FAIL_CLOSED_GOAL_INTENT_APPROVAL",
      "approval scope does not bind this project",
    );
  }
  const opRef = operator != null ? String(operator) : null;
  // A non-null operator binding must match exactly — a null request
  // operator can never satisfy it. A null-bound approval is adoptable
  // (the new preview's own operator binding governs).
  if (approval.operator_id != null && approval.operator_id !== opRef) {
    throw new IntegrityError(
      "FAIL_CLOSED_GOAL_INTENT_APPROVAL",
      "approval binds a different operator",
    );
  }
  return {
    ...body,
    operator_goal: approval.amended_goal,
    metadata: {
      ...((body.metadata as Record<string, unknown> | undefined) ?? {}),
      goal_intent_approval: {
        approval_id: approval.approval_id,
        revision_digest: approval.revision_digest,
        analysis_digest: approval.analysis_digest,
      },
    },
  };
}

/* Coercion artifacts that must never become an operator identity. A
   missing body/header coerces via String() into "undefined"/"null"/
   "[object Object]" — without this gate an objective could be created
   under `operator:undefined` and then legitimately claimed by ANY
   caller sending the header "undefined" (the string is a real,
   canonicalizable ref). Reject the artifact class at BOTH the mint
   (objective create) and the actor edge (owner-scoped routes). */
const OPERATOR_COERCION_ARTIFACTS = new Set([
  "", "undefined", "null", "NaN", "Infinity", "[object Object]",
]);

/** Canonicalize an operator identity ONCE (bare `alice` →
 *  `operator:alice`), failing closed on absent or coercion-artifact
 *  refs. Single seam for every owner-scoped route — authority never
 *  accepts a coerced garbage identity. */
function canonicalOperatorActor(raw: unknown, pathLabel: string): string {
  const s = String(raw ?? "").trim();
  const ref = s.startsWith("operator:") ? s.slice("operator:".length).trim() : s;
  if (OPERATOR_COERCION_ARTIFACTS.has(ref) || /\s/.test(ref)) {
    throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", pathLabel);
  }
  return s.startsWith("operator:") ? `operator:${ref}` : `operator:${s}`;
}

/** Same artifact gate returning the BARE ref — for callees that
 *  canonicalize `operator:` themselves in one place (business/routine
 *  create stamp `operator:${operator_id}` unconditionally). */
function operatorRef(raw: unknown, pathLabel: string): string {
  const s = String(raw ?? "").trim();
  const ref = s.startsWith("operator:") ? s.slice("operator:".length).trim() : s;
  if (OPERATOR_COERCION_ARTIFACTS.has(ref) || /\s/.test(ref)) {
    throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", pathLabel);
  }
  return ref;
}

export function createMissionControlServer(
  deps: MissionControlServerDeps,
): http.Server {
  const c = deps.control;
  // P15.7 — lazily-composed CEO operating service: built on the FIRST
  // ceo-cycle call so an unavailable/unqualified CEO model fails
  // closed on that route alone and can never take the server down at
  // boot. Resolved once, then cached for the process lifetime.
  let ceoOps: ReturnType<typeof createDefaultObjectiveOperatingService> | null = null;
  // P15.10-A — objective auto-policy authority (control plane only;
  // no driver). Owner proof comes ONLY from the trusted x-operator-id
  // header — a body-declared owner field is never authority here.
  let autoPolicySvc: ObjectiveAutoPolicyService | null = null;
  let cockpitSvc: ObjectiveCockpitService | null = null;
  let portfolioSvc: ObjectivePortfolioService | null = null;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";
    const body =
      method === "POST" || method === "PUT"
        ? await readBody(req, routeBodyBound(p, req)).catch((e: unknown) => {
            if (e instanceof BodyTooLargeError) {
              json(res, 413, { error: "REQUEST_BODY_TOO_LARGE" });
              return null;
            }
            json(res, 400, { error: "REQUEST_BODY_READ_FAILED" });
            return null;
          })
        : {};
    if (body === null) return;
    // POST /api/outbox, /api/broker/fetch and /api/artifacts/fetch carry
    // their own narrow tokens — exempt from the MC gate.
    const isOutboxUpload = method === "POST" && p === "/api/outbox";
    const isBrokerFetch = method === "POST" && p === "/api/broker/fetch";
    const isArtifactFetch = method === "POST" && p === "/api/artifacts/fetch";
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const queryToken = url.searchParams.get("token") ?? "";
    // Phase 1 R1 — credential classification. The admin credential is
    // BEARER-ONLY and authenticates ONLY the operational-status boundary
    // (conversation create/read/turns) — it is NOT a general Mission
    // Control API credential and can never come in via ?token= (query
    // tokens leak through logs/proxies). The MC token keeps its original
    // OR-semantics across both channels.
    const classOf = (credential: string) =>
      classifyRequestCredential({
        credential,
        authToken: deps.authToken,
        adminToken: deps.adminToken,
      });
    const adminBearer = classOf(bearer) === "admin";
    const mcAuthenticated =
      classOf(bearer) === "operator" || classOf(queryToken) === "operator";
    const adminBoundary =
      (method === "POST" &&
        (p === "/api/conversations" ||
          /^\/api\/conversations\/[^/]+\/turns$/.test(p) ||
          // P16-D — read-grant mint/control is operational-status authority:
          // the admin credential delegates reads, the MC-token owner claim
          // vouches only its own provable scope (enforced in the service).
          /^\/api\/conversations\/read-grants(\/|$)/.test(p))) ||
      (method === "GET" &&
        (p === "/api/conversations" ||
          /^\/api\/conversations\/[^/]+(\/messages)?$/.test(p) ||
          // P16-D — by-id grant status is operational-status authority too;
          // without it the admin credential 401s on a route it mints into.
          /^\/api\/conversations\/read-grants(\/|$)/.test(p)));
    if (deps.authToken && p.startsWith("/api/") && !isOutboxUpload && !isBrokerFetch && !isArtifactFetch) {
      // The MC token remains the general API credential. The admin
      // token unlocks ONLY the operational-status boundary — every
      // other route (credentials, missions, budgets, config, drafts,
      // confirms) still requires the MC token.
      if (!mcAuthenticated && !(adminBearer && adminBoundary)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "UNAUTHORIZED_MC_TOKEN" }));
        return;
      }
    }
    const operator =
      String(req.headers["x-operator-id"] ?? "") ||
      String(body.operator_id ?? "") ||
      undefined;
    try {
      // ---- read models ----------------------------------------------------
      if (method === "GET" && (p === "/" || p === "/ui")) {
        if (tryStatic(deps.staticDir, p, res)) return;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(UI_HTML);
        return;
      }
      // SPA deep-link fallback for non-API GETs (e.g. /missions/xxx).
      if (method === "GET" && !p.startsWith("/api/") && deps.staticDir) {
        if (tryStatic(deps.staticDir, p, res)) return;
      }
      // §4.1 — canonical event stream (SSE). Cursor = events.seq; EventSource
      // resumes via Last-Event-ID. Emits the hash-verified journal projection
      // only — read-only, never credentials or secret material.
      if (method === "GET" && p === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let cursor = Number(
          url.searchParams.get("last_seq") ?? req.headers["last-event-id"] ?? 0,
        ) || 0;
        const flush = () => {
          try {
            const { events, latest_seq } = c.eventsSince(cursor);
            for (const e of events) {
              res.write(`id: ${String(e.seq ?? 0)}\ndata: ${JSON.stringify(e)}\n\n`);
            }
            cursor = latest_seq;
          } catch {
            // hash mismatch / store error — tell clients to resync
            res.write("event: resync\ndata: {}\n\n");
          }
        };
        flush();
        const iv = setInterval(flush, 400);
        const hb = setInterval(() => res.write(":ping\n\n"), 15000);
        req.on("close", () => {
          clearInterval(iv);
          clearInterval(hb);
          res.end();
        });
        return;
      }
      // Executor outbox ingress: remote sessions upload deliverable files
      // (screenshots, reports) base64-encoded; stored in the mission's
      // project outbox for the delivery pipeline to pick up.
      if (isOutboxUpload) {
        // F1 §6 — capability-bound canonical ingest. `x-artifact-capability`
        // is an execution-scoped HMAC capability minted server-side at
        // dispatch; the generic outbox token remains a legacy storage-only
        // path and NEVER mints canonical artifact authority.
        const artifactCap = String(req.headers["x-artifact-capability"] ?? "");
        if (artifactCap) {
          if (!deps.artifactUploadToken) {
            return void json(res, 403, { error: "ARTIFACT_INGEST_DISABLED" });
          }
          const b64 = String(body.data_base64 ?? "");
          // Bound the wire payload BEFORE decode: base64 inflates ~4/3,
          // so anything beyond the artifact cap encoding is rejected
          // without materializing it.
          if (b64.length > Math.ceil(MAX_ARTIFACT_BYTES * 4 / 3) + 64) {
            return void json(res, 413, { error: "FAIL_CLOSED_ARTIFACT_TOO_LARGE" });
          }
          let buf: Buffer;
          try {
            buf = Buffer.from(b64, "base64");
          } catch {
            return void json(res, 400, { error: "invalid base64" });
          }
          if (!buf.length) return void json(res, 400, { error: "FAIL_CLOSED_ARTIFACT_EMPTY" });
          if (buf.length > MAX_ARTIFACT_BYTES) {
            return void json(res, 413, { error: "FAIL_CLOSED_ARTIFACT_TOO_LARGE" });
          }
          const acceptance = c.acceptArtifactUpload(deps.artifactUploadToken, artifactCap, {
            filename: body.filename,
            mission_id: body.mission_id,
            task_id: body.task_id,
            bytes: buf,
          });
          const art = acceptance.artifact;
          // Delivery compatibility: materialize the same verified bytes
          // into the project outbox under the governed naming convention
          // so the TELEGRAM_DELIVERY FILES seam resolves it exactly as a
          // legacy upload would. Outbox presence remains storage only —
          // send authority still comes from a canonical delivery request.
          const outboxDir = c.missionOutboxDir(String(art.mission_id));
          let materialized = false;
          if (outboxDir) {
            const filename = compatOutboxBasename(String(art.logical_name ?? "file"));
            const taskPrefix = String(art.task_id).replace(/[^\w.\-]/g, "_").slice(-40);
            // R1.7 — inject the canonical artifact identity between
            // taskPrefix and basename: two distinct logical artifacts
            // can never collide on one compat file, while the
            // `-<basename>` suffix keeps the delivery resolver's
            // endsWith() match working (ambiguous suffixes fail closed
            // inside the resolver, never guess).
            const frag = String(art.artifact_id).replace(/^ART_/, "").slice(0, 16);
            fs.mkdirSync(outboxDir, { recursive: true });
            const dest = path.join(outboxDir, `${taskPrefix}-${frag}-${filename}`);
            const tmp = `${dest}.tmp-${process.pid}-${ulid()}`;
            const fh = fs.openSync(tmp, "w");
            try {
              fs.writeSync(fh, buf);
              fs.fsyncSync(fh);
            } finally {
              fs.closeSync(fh);
            }
            fs.renameSync(tmp, dest);
            materialized = true;
          }
          // R1.8 — canonical response carries logical references only;
          // no absolute host path is disclosed to the remote executor.
          return void json(res, 200, {
            ok: true,
            artifact_id: art.artifact_id,
            sha256: art.sha256,
            byte_size: art.byte_size,
            replayed: acceptance.replayed,
            storage_ref: `pair-artifact://sha256/${String(art.sha256)}`,
            materialized,
          });
        }
        if (!deps.outboxToken || String(req.headers["x-outbox-token"] ?? "") !== deps.outboxToken) {
          return void json(res, 403, { error: "UNAUTHORIZED_OUTBOX_TOKEN" });
        }
        const missionId = String(body.mission_id ?? "");
        const outboxDir = c.missionOutboxDir(missionId);
        if (!outboxDir) return void json(res, 404, { error: "unknown mission_id" });
        const filename = path.basename(String(body.filename ?? "file")).replace(/[^\w.\-]/g, "_");
        const ext = path.extname(filename).toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".md", ".txt"].includes(ext)) {
          return void json(res, 400, { error: "file type not allowed" });
        }
        let buf: Buffer;
        try {
          buf = Buffer.from(String(body.data_base64 ?? ""), "base64");
        } catch {
          return void json(res, 400, { error: "invalid base64" });
        }
        if (!buf.length || buf.length > 8 * 1024 * 1024) {
          return void json(res, 400, { error: "empty or oversize (>8MB)" });
        }
        fs.mkdirSync(outboxDir, { recursive: true });
        const taskPrefix = String(body.task_id ?? "remote").replace(/[^\w.\-]/g, "_").slice(-40);
        const dest = path.join(outboxDir, `${taskPrefix}-${filename}`);
        fs.writeFileSync(dest, buf);
        return void json(res, 200, { ok: true, path: dest, bytes: buf.length, canonical: false });
      }

      // F1 §10 — read-only canonical artifact projection (no host paths).
      if (method === "GET" && p === "/api/artifacts") {
        return void json(res, 200, {
          artifacts: c.artifacts(url.searchParams.get("mission_id") ?? undefined),
        });
      }
      const artifactGet = p.match(/^\/api\/artifacts\/([^/]+)$/);
      if (method === "GET" && artifactGet) {
        const a = c.artifact(decodeURIComponent(artifactGet[1]));
        if (!a) return void json(res, 404, { error: "NOT_FOUND" });
        return void json(res, 200, { artifact: a });
      }
      // Incident R2 — explicit telegram delivery authority. The bridge polls
      // the QUEUED canonical requests (durable, restart-safe) and acks each
      // manifested artifact after a successful transport. An outbox file is
      // storage only — it NEVER appears here without a governed delivery.
      if (method === "GET" && p === "/api/telegram-deliveries") {
        const state = url.searchParams.get("state") ?? undefined;
        return void json(res, 200, { deliveries: c.telegramDeliveries(state) });
      }
      // R4 §5 — the legacy /ack endpoint is REMOVED: it could flip a
      // QUEUED payload to SENT with no SENDING and no message_id. The
      // governed /transition lifecycle is the ONLY mutation path.
      // R3 §7 — explicit transport lifecycle: QUEUED→SENDING→SENT |
      // FAILED | UNKNOWN_SIDE_EFFECT per artifact (or the TEXT request),
      // plus the UNSENDABLE destination hold. Replaces filename-based
      // send proof entirely.
      const transitionMatch = p.match(
        /^\/api\/telegram-deliveries\/([^/]+)\/transition$/,
      );
      if (method === "POST" && transitionMatch) {
        const reqEntity = c.transitionTelegramDelivery(
          decodeURIComponent(transitionMatch[1]),
          {
            artifact: body.artifact === undefined ? undefined : body.artifact,
            to: body.to === undefined ? undefined : String(body.to),
            message_id: body.message_id,
            error: body.error === undefined ? undefined : String(body.error),
          } as never,
        );
        // R7 §5 — exclusive claim surface: a SENDING transition returns
        // the acquisition outcome explicitly so a transport actor never
        // infers send authority from a stale projection.
        if (
          reqEntity &&
          typeof reqEntity === "object" &&
          "acquired" in (reqEntity as Record<string, unknown>)
        ) {
          const acq = reqEntity as {
            acquired: boolean;
            request: Record<string, unknown>;
            attempt_id?: string;
            reason?: string;
          };
          return void json(res, 200, {
            delivery: acq.request,
            acquired: acq.acquired === true,
            attempt_id: acq.attempt_id ?? null,
            reason: acq.reason ?? null,
          });
        }
        return void json(res, 200, { delivery: reqEntity });
      }

      // Broker fetch: remote executor releases a named credential. R3 §2:
      // the worker credential is a TASK-SCOPED capability (x-broker-capability)
      // minted server-side from PAIR_BROKER_TOKEN — the master token itself
      // is NEVER a valid worker credential. After HMAC verification the
      // claims must match the body ids and the canonical task binding; then
      // P13 §25 (mission+task binding, mission pin, current secret_policy,
      // business isolation, P12 executor check, vault value) still applies.
      if (isBrokerFetch) {
        const capability = String(req.headers["x-broker-capability"] ?? "");
        if (!deps.broker || !deps.brokerToken || !capability) {
          return void json(res, 403, { error: "UNAUTHORIZED_BROKER_CAPABILITY" });
        }
        const missionId = String(body.mission_id ?? "");
        const taskId = String(body.task_id ?? "");
        const credentialName = String(body.credential_name ?? "");
        const authz = c.authorizeBrokerFetch(
          missionId,
          taskId,
          credentialName,
          capability,
          deps.brokerToken,
        );
        if (!authz.granted) {
          deps.broker.deny(credentialName, {
            mission_id: missionId || null,
            task_id: taskId || null,
          });
          const notFound = /^FAIL_CLOSED_(MISSION|TASK)_/.test(authz.reason);
          return void json(res, notFound ? 404 : 403, { error: authz.reason });
        }
        const cred = deps.broker.release(credentialName, {
          mission_id: missionId,
          task_id: taskId || null,
        });
        if (!cred) {
          deps.broker.deny(credentialName, {
            mission_id: missionId,
            task_id: taskId || null,
          });
          return void json(res, 404, { error: "FAIL_CLOSED_CREDENTIAL_NOT_INSTALLED" });
        }
        return void json(res, 200, {
          name: cred.name,
          kind: cred.kind,
          domains: cred.domains,
          value: cred.value,
        });
      }
      // F2 §14 — the remote consume lane: the remote worker presents an
      // acread1 consume capability in x-artifact-consume-capability and a
      // single artifact_id in the body; the response is the exact CAS
      // byte slice plus identity headers. No paths, no listing.
      if (isArtifactFetch) {
        const capability = String(
          req.headers["x-artifact-consume-capability"] ?? "",
        );
        // R1.5/R2.4 — ONE canonical consume master, resolved ONCE at
        // bootstrap and injected: artifactConsumeToken, falling back to
        // the artifact upload master (serve-mission-control resolves
        // PAIR_ARTIFACT_UPLOAD_TOKEN || PAIR_BROKER_TOKEN into either).
        // PAIR_OUTBOX_TOKEN is NEVER consume authority, and request
        // handling never inspects ambient env.
        const master = deps.artifactConsumeToken ?? deps.artifactUploadToken;
        if (!master || !capability) {
          return void json(res, 403, { error: "UNAUTHORIZED_ARTIFACT_CONSUME" });
        }
        try {
          const { artifact, bytes } = c.fetchArtifactForConsumption(master, capability, {
            artifact_id: body.artifact_id,
          });
          // R1.6 companion — ASCII-safe identity headers only; the raw
          // logical name would crash the response on non-ASCII names and
          // the consumer already carries the pinned name contract-side.
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "x-artifact-id": String(artifact.artifact_id),
            "x-artifact-sha256": String(artifact.sha256),
            "x-artifact-byte-size": String(artifact.byte_size),
          });
          res.end(bytes);
          return;
        } catch (e) {
          const code = e instanceof PairError ? e.code : "FAIL_CLOSED";
          const status =
            code === "FAIL_CLOSED_ARTIFACT_VERIFICATION" ||
            code === "FAIL_CLOSED_ARTIFACT_HANDOFF_MISSING" ||
            code === "FAIL_CLOSED_ARTIFACT_EXECUTION_UNKNOWN"
              ? 404
              : 403;
          return void json(res, status, { error: code });
        }
      }

      if (method === "GET" && p === "/api/health") return void json(res, 200, c.health());
      if (method === "GET" && p === "/api/metrics") return void json(res, 200, c.metrics());
      if (method === "GET" && p === "/api/missions") {
        return void json(res, 200, { missions: c.missions() });
      }
      let m = p.match(/^\/api\/missions\/([^/]+)$/);
      if (method === "GET" && m) return void json(res, 200, c.missionDetail(m[1]));
      m = p.match(/^\/api\/missions\/([^/]+)\/dag$/);
      if (method === "GET" && m) return void json(res, 200, c.missionDag(m[1]));
      m = p.match(/^\/api\/missions\/([^/]+)\/timeline$/);
      if (method === "GET" && m) return void json(res, 200, c.timeline(m[1]));
      m = p.match(/^\/api\/missions\/([^/]+)\/evidence$/);
      if (method === "GET" && m) return void json(res, 200, c.evidence(m[1]));
      // Workspace file viewer — list all, or read one via ?path=<relpath>.
      // Read-only, clamped to the mission's authorized workspaces.
      m = p.match(/^\/api\/missions\/([^/]+)\/files$/);
      if (method === "GET" && m) {
        const rel = url.searchParams.get("path");
        return void json(res, 200, rel ? c.workspaceFile(m[1], rel) : c.workspaceFiles(m[1]));
      }
      if (method === "GET" && p === "/api/projects") return void json(res, 200, c.projects());
      // §4.2 — provider/model/route read projections (read-only).
      if (method === "GET" && p === "/api/providers") return void json(res, 200, c.providers());
      if (method === "GET" && p === "/api/models") return void json(res, 200, c.models());
      if (method === "GET" && p === "/api/routes") return void json(res, 200, c.routes());
      m = p.match(/^\/api\/models\/([^/]+)\/routable$/);
      if (method === "GET" && m) return void json(res, 200, c.modelRoutable(m[1]));
      if (method === "GET" && p === "/api/routing") return void json(res, 200, c.routing());
      // Executor Management read model — the dashboard's supported-
      // executor surface (intent + qualification + availability +
      // missing prerequisites + bound-this-process). Read-only.
      if (method === "GET" && p === "/api/executors") {
        return void json(res, 200, c.executors(deps.executorBoundIds?.() ?? []));
      }
      if (method === "GET" && p === "/api/recovery") return void json(res, 200, c.recovery());
      // P18.4-B — per-mission liveness + recovery operations projection
      // (persisted/observed/derived/unknown classification; read-only).
      m = p.match(/^\/api\/missions\/([^/]+)\/operations$/);
      if (method === "GET" && m) return void json(res, 200, c.missionOperations(m[1]));
      // P18.4-B — operator rollup: bounded aggregate counts over
      // canonical rows (nothing inferred, nothing synthesized).
      if (method === "GET" && p === "/api/operations") {
        return void json(res, 200, c.operationsOverview());
      }
      if (method === "GET" && p === "/api/approvals") return void json(res, 200, c.approvals());
      if (method === "GET" && p === "/api/experience") return void json(res, 200, c.experience());
      if (method === "GET" && p === "/api/selfmod") return void json(res, 200, c.selfImprovement());
      // Recurring mission triggers (mission_schedule entities).
      if (method === "GET" && p === "/api/schedules") return void json(res, 200, { schedules: c.schedules() });
      // Cost guard read model — remote spend usage vs the daily cap.
      if (method === "GET" && p === "/api/cost") return void json(res, 200, c.cost());
      // P13 monetary + secret governance read models (metadata only —
      // never credential values).
      if (method === "GET" && p === "/api/cost-policies") {
        return void json(res, 200, { cost_policies: c.costPolicies() });
      }
      if (method === "GET" && p === "/api/cost-profiles") {
        return void json(res, 200, { cost_profiles: c.costProfiles() });
      }
      if (method === "GET" && p === "/api/secret-policies") {
        return void json(res, 200, { secret_policies: c.secretPolicies() });
      }
      // Operator credential management — MC-token gated (the gate above).
      // Values are write-only: list/upsert return metadata, never the secret.
      if (method === "GET" && p === "/api/credentials") {
        return void json(res, 200, { credentials: deps.broker?.list() ?? [] });
      }

      // ---- mutations (operator authority required) -------------------------
      if (method === "POST" && !operator) {
        throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", p);
      }
      if (method === "POST" && p === "/api/credentials") {
        if (!deps.broker) return void json(res, 404, { error: "broker not configured" });
        try {
          const meta = deps.broker.upsert({
            name: String(body.name ?? ""),
            value: String(body.value ?? ""),
            domains: Array.isArray(body.domains) ? (body.domains as string[]).map(String) : [],
            kind: String(body.kind ?? "token"),
          });
          return void json(res, 200, meta);
        } catch (e) {
          return void json(res, 400, { error: String((e as Error).message) });
        }
      }
      if (method === "POST" && p === "/api/credentials/delete") {
        if (!deps.broker) return void json(res, 404, { error: "broker not configured" });
        return void json(res, 200, { removed: deps.broker.remove(String(body.name ?? "")) });
      }
      // Executor ON/OFF — durable operator intent (audited via the
      // canonical event journal, OCC-safe on concurrent flips). The
      // CapabilityRouter rejects DISABLED at route time and
      // GovernedTaskGate re-proves at dispatch time, so OFF blocks
      // every NEW dispatch (incl. retries/reroutes) without cancelling
      // running executions. ON never bypasses qualification/health/
      // capability/route gates.
      m = p.match(/^\/api\/executors\/([^/]+)\/state$/);
      if (method === "POST" && m) {
        const enabled = (body as Record<string, unknown>).enabled;
        if (enabled !== true && enabled !== false) {
          return void json(res, 400, { error: "FAIL_CLOSED_EXECUTOR_STATE_REQUIRED" });
        }
        return void json(
          res,
          200,
          c.setExecutorEnabled(decodeURIComponent(m[1]), enabled, canonicalOperatorActor(operator, p)),
        );
      }
      // P13 governance mutations — operator + CAS + audited, metadata only.
      if (method === "POST" && p === "/api/cost-policies") {
        // R3 §3: create-only — an existing identity fails closed; callers
        // must use the CAS /update path to change authority.
        return void json(res, 200, c.createCostPolicy(body, `operator:${operatorRef(operator, p)}`));
      }
      if (method === "POST" && p === "/api/cost-policies/update") {
        // R1 §6: split API control fields from the strict policy payload —
        // `cost_policy_id` + `expected_version` are control, not fields.
        const { expected_version, cost_policy_id, ...policyPayload } = body;
        if (expected_version == null || !Number.isInteger(Number(expected_version))) {
          return void json(res, 400, { error: "FAIL_CLOSED_COST_POLICY_VERSION_REQUIRED" });
        }
        return void json(
          res,
          200,
          c.updateCostPolicy(
            { ...policyPayload, cost_policy_id: String(cost_policy_id ?? "") },
            `operator:${operatorRef(operator, p)}`,
            Number(expected_version),
          ),
        );
      }
      if (method === "POST" && p === "/api/cost-profiles") {
        // R3 §3: create-only — an existing (ref_type, ref_id) identity
        // fails closed; callers must use the CAS /update path.
        return void json(res, 200, c.createCostProfile(body, `operator:${operatorRef(operator, p)}`));
      }
      if (method === "POST" && p === "/api/cost-profiles/update") {
        // R1 §6: `expected_version` is an API control field — never part
        // of the strict profile payload.
        const { expected_version, ...profilePayload } = body;
        if (expected_version == null || !Number.isInteger(Number(expected_version))) {
          return void json(res, 400, { error: "FAIL_CLOSED_COST_PROFILE_VERSION_REQUIRED" });
        }
        return void json(
          res,
          200,
          c.updateCostProfile(profilePayload, `operator:${operatorRef(operator, p)}`, Number(expected_version)),
        );
      }
      if (method === "POST" && p === "/api/secret-policies") {
        return void json(res, 200, c.createSecretPolicy(body, `operator:${operatorRef(operator, p)}`));
      }
      if (method === "POST" && p === "/api/secret-policies/update") {
        // R1 §6: `policy_id`/`expected_version` are control fields; the
        // strict secret-policy payload validator never sees them.
        const { policy_id, expected_version, ...secretPayload } = body;
        if (expected_version == null || !Number.isInteger(Number(expected_version))) {
          return void json(res, 400, { error: "FAIL_CLOSED_SECRET_POLICY_VERSION_REQUIRED" });
        }
        return void json(
          res,
          200,
          c.updateSecretPolicy(
            String(policy_id ?? ""),
            secretPayload,
            Number(expected_version),
            `operator:${operatorRef(operator, p)}`,
          ),
        );
      }
      if (method === "POST" && p === "/api/secret-policies/revoke") {
        return void json(
          res,
          200,
          c.revokeSecretPolicy(String(body.policy_id ?? ""), `operator:${operatorRef(operator, p)}`),
        );
      }
      // Phase B two-step submit: preview persists a durable
      // mission_plan_preview (READY); confirm consumes exactly it.
      if (method === "POST" && p === "/api/missions/preview") {
        rejectCallerOperatorGoal(body);
        /* P18.6 — a governed owner-approved goal amendment: the caller
           references an APPROVAL ROW by id; the server resolves the
           persisted amended goal (never client text), binds the
           approval evidence into mission metadata for confirm-time
           re-proof, and lets the amended revision drive planning
           through the normal operator_goal authority seam. */
        const previewBody = resolveGoalIntentApprovalBody(
          deps.store,
          body,
          operator,
        );
        const ex = deps.planExpander ? await deps.planExpander(previewBody) : { input: previewBody };
        const expanded = (ex as { input?: Record<string, unknown> }).input ?? (ex as Record<string, unknown>);
        const planner = (ex as { planner?: never }).planner;
        return void json(res, 200, c.createPlanPreview({ ...expanded, operator_id: operator } as never, planner as never));
      }
      // P18.6 — approve material interpretation items minted by a
      // preview's pinned run: server-side only, bound to the pinned
      // analysis + persisted goal text. The mint enforces the
      // authenticated actor's authority over the referenced preview
      // (READY lifecycle + operator ownership) inside the store seam.
      // `supplied` distinguishes supplying missing information from
      // accepting an assumption. Returns the approval row; the operator
      // then previews the amended revision via goal_intent_approval_id.
      if (method === "POST" && p === "/api/goal-intent/approve") {
        const previewId = String(body.preview_id ?? "");
        const preview = deps.store?.tryGet("mission_plan_preview", previewId) as
          | Record<string, unknown>
          | null
          | undefined;
        if (!preview) {
          throw new IntegrityError("FAIL_CLOSED_PREVIEW_MISSING", `preview ${previewId}`);
        }
        const mi = (preview.mission_input ?? {}) as Record<string, unknown>;
        const baseGoal = String(mi.operator_goal ?? mi.goal ?? "");
        const approval = approveGoalIntentItems(deps.store!, {
          preview_id: previewId,
          base_goal: baseGoal,
          item_ids: Array.isArray(body.item_ids) ? body.item_ids.map(String) : [],
          supplied:
            body.supplied != null && typeof body.supplied === "object" && !Array.isArray(body.supplied)
              ? (body.supplied as Record<string, unknown>)
              : null,
          operator_id: operator ?? null,
          actor: `operator:${operatorRef(operator, p)}`,
        });
        return void json(res, 200, {
          approval_id: approval.approval_id,
          revision_digest: approval.revision_digest,
          analysis_digest: approval.analysis_digest,
          item_ids: approval.item_ids,
          item_statements: approval.item_statements,
          resolutions: approval.resolutions,
          amended_goal_sha256: approval.amended_goal_sha256,
        });
      }
      /* UI-V2 Phase B — governed NL intake DRAFT seam. Read-only +
         advisory: bounded interpretation + deterministic draft proposal
         for owner review. Nothing canonical is created here — the commit
         stays on /api/vnext/objectives (canonical service, dedup_key) or
         the mission preview/confirm path. Mode OFF or unavailable wiring
         still serves the manual draft honestly. */
      if (method === "POST" && p === "/api/v1/intake/draft") {
        const actor = canonicalOperatorActor(operator, p);
        const goal = String(body.goal ?? "").trim();
        if (!goal || goal.length > INTAKE_MAX_GOAL) {
          return void json(res, 400, {
            error: "INVALID_GOAL",
            detail: `goal must be 1..${INTAKE_MAX_GOAL} chars`,
          });
        }
        const businessId =
          body.business_id == null ? null : String(body.business_id).trim() || null;
        const projectId =
          body.project_id == null ? null : String(body.project_id).trim() || null;
        if (businessId) {
          /* Scope binding must be real — an unknown business_id fails
             closed rather than binding interpretation evidence to a
             tenant that may not exist. */
          if (!deps.business) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
          try {
            deps.business.getBusiness(businessId);
          } catch {
            return void json(res, 404, { error: "BUSINESS_NOT_FOUND", business_id: businessId });
          }
        }
        /* Advisory seam must never block the manual path — a provider
           * failure degrades to typed unavailable evidence + manual
           * draft, mirroring the run-pinned seam's fail-open-advisory /
           * fail-closed-authority contract. */
        let interpreted: Record<string, unknown> | null = null;
        let intakeError: string | null = null;
        if (deps.intakeAnalyze) {
          try {
            interpreted = await deps.intakeAnalyze({
              goal,
              business_id: businessId,
              project_id: projectId,
              operator_id: actor,
            });
          } catch (e) {
            intakeError = `intake_analyze:${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`;
            interpreted = null;
          }
        }
        const analysis =
          interpreted && typeof interpreted === "object"
            ? (interpreted.analysis as Record<string, unknown> | null | undefined) ?? null
            : null;
        const draft =
          analysis != null
            ? deriveIntakeDraft(analysis as never)
            : deriveManualDraft(goal);
        return void json(res, 200, {
          schema_version: INTAKE_DRAFT_SCHEMA,
          mode: (interpreted?.mode as string | undefined) ?? semanticMode(),
          status: intakeError
            ? "unavailable"
            : (interpreted?.status as string | undefined) ?? "off",
          unavailable_reason:
            intakeError ?? ((interpreted?.unavailable_reason as string | undefined) ?? null),
          analysis_digest: (interpreted?.analysis_digest as string | undefined) ?? null,
          source_goal_sha: (interpreted?.source_goal_sha as string | undefined) ?? null,
          provider_requests: (interpreted?.provider_requests as number | undefined) ?? 0,
          ambiguity_class: (interpreted?.ambiguity_class as string | undefined) ?? null,
          items: (analysis?.items as unknown[] | undefined) ?? [],
          draft,
        });
      }
      if (method === "GET" && p.match(/^\/api\/plan-previews\/[^/]+$/)) {
        const id = p.split("/")[3];
        return void json(res, 200, c.planPreview(id));
      }
      // Explicit confirmation seam: {preview_id, plan_digest} — consumes the
      // persisted preview and mints the mission, idempotently.
      if (method === "POST" && p === "/api/missions/confirm") {
        rejectCallerOperatorGoal(body);
        const confirm = (body.confirm_plan ?? {}) as { preview_id?: string; digest?: string };
        const previewId = String(body.preview_id ?? confirm.preview_id ?? "");
        const planDigest = String(body.plan_digest ?? confirm.digest ?? "");
        return void json(res, 200, c.confirmPlanPreview({ preview_id: previewId, plan_digest: planDigest, operator_id: operator }));
      }
      if (method === "POST" && p === "/api/missions") {
        rejectCallerOperatorGoal(body);
        // A confirm payload (preview_id+digest) consumes the persisted
        // preview — NEVER re-plans. A bare submit plans once through the
        // failover chain and immediately consumes its own preview, so every
        // entry point still lands on exactly one pinned plan.
        const confirm = (body.confirm_plan ?? {}) as { preview_id?: string; digest?: string };
        if (confirm.preview_id || body.preview_id) {
          const previewId = String(body.preview_id ?? confirm.preview_id);
          const planDigest = String(body.plan_digest ?? confirm.digest ?? "");
          return void json(res, 200, c.confirmPlanPreview({ preview_id: previewId, plan_digest: planDigest, operator_id: operator }));
        }
        const ex = deps.planExpander ? await deps.planExpander(body) : { input: body };
        const expanded = (ex as { input?: Record<string, unknown> }).input ?? (ex as Record<string, unknown>);
        const planner = (ex as { planner?: never }).planner;
        const preview = c.createPlanPreview({ ...expanded, operator_id: operator } as never, planner as never);
        return void json(res, 200, c.confirmPlanPreview({ preview_id: String(preview.preview_id), plan_digest: String(preview.plan_digest), operator_id: operator }));
      }
      m = p.match(/^\/api\/missions\/([^/]+)\/(pause|resume|cancel|acknowledge|reconcile)$/);
      if (method === "POST" && m) {
        const [, missionId, action] = m;
        const out =
          action === "pause" ? c.pauseMission(missionId, operator)
          : action === "resume" ? c.resumeMission(missionId, operator)
          : action === "cancel" ? c.cancelMission(missionId, operator)
          : action === "acknowledge" ? c.acknowledgeTerminal(missionId, operator)
          : c.requestReconciliation(missionId, operator, String(body.execution_id ?? "") || undefined);
        return void json(res, 200, out);
      }
      m = p.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
      if (method === "POST" && m) {
        const out =
          m[2] === "approve"
            ? c.approve(m[1], operator, body.scope as Record<string, unknown> | undefined, String(body.reason ?? "") || undefined)
            : c.deny(m[1], operator, body.scope as Record<string, unknown> | undefined, String(body.reason ?? "") || undefined);
        return void json(res, 200, out);
      }
      m = p.match(/^\/api\/promotions\/([^/]+)\/(approve|reject)$/);
      if (method === "POST" && m) {
        const out =
          m[2] === "approve"
            ? c.approvePromotion(m[1], operator)
            : c.rejectPromotion(m[1], operator, String(body.reason ?? "rejected via control"));
        return void json(res, 200, out);
      }
      if (method === "POST" && p === "/api/schedules") {
        return void json(
          res,
          200,
          c.createSchedule({
            goal: String(body.goal ?? ""),
            cron: String(body.cron ?? ""),
            project_id: String(body.project_id ?? "") || undefined,
            name: String(body.name ?? "") || undefined,
            metadata: (body.metadata as Record<string, unknown>) ?? {},
            operator_id: operator,
          }),
        );
      }
      m = p.match(/^\/api\/schedules\/([^/]+)\/(enable|disable|delete)$/);
      if (method === "POST" && m) {
        const out =
          m[2] === "delete"
            ? c.deleteSchedule(m[1], operator)
            : c.setScheduleEnabled(m[1], m[2] === "enable", operator);
        return void json(res, 200, out);
      }
      if (method === "POST" && p === "/api/tick") {
        return void json(res, 200, c.tick());
      }
      // ---------- business layer ----------
      const biz = deps.business;
      if (method === "GET" && p === "/api/businesses") {
        return void json(res, 200, { businesses: biz ? biz.listBusinesses() : [] });
      }
      if (method === "POST" && p === "/api/businesses") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.createBusiness({
          name: String(body.name ?? ""), project_id: String(body.project_id ?? ""),
          description: String(body.description ?? "") || undefined,
          currency: String(body.currency ?? "") || undefined,
          operator_id: operatorRef(operator, p),
        }));
      }
      m = p.match(/^\/api\/businesses\/([^/]+)$/);
      if (method === "GET" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.detail(m[1]));
      }
      if (method === "GET" && p === "/api/org-agents") {
        return void json(res, 200, { agents: biz ? biz.listOrgAgents() : [] });
      }
      if (method === "POST" && p === "/api/org-agents") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.createOrgAgent({
          business_id: String(body.business_id ?? ""), title: String(body.title ?? ""),
          department: String(body.department ?? ""), role: String(body.role ?? "") || undefined,
          reports_to: String(body.reports_to ?? "") || undefined,
          executor_binding: String(body.executor_binding ?? "") || undefined,
          operator_id: operatorRef(operator, p),
        }));
      }
      m = p.match(/^\/api\/org-agents\/([^/]+)\/(pause|resume|terminate)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const st = m[2] === "pause" ? "PAUSED" : m[2] === "resume" ? "ACTIVE" : "TERMINATED";
        return void json(res, 200, biz.setOrgAgentStatus(m[1], st, canonicalOperatorActor(operator, p)));
      }
      // P12: agent execution contract management — canonical business-layer
      // ops only; CAS-protected, audited, business-isolated.
      m = p.match(/^\/api\/org-agents\/([^/]+)\/contract$/);
      if (m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        if (method === "GET") {
          return void json(res, 200, { contract: biz.getAgentContract(m[1]) });
        }
        if (method === "POST" || method === "PUT") {
          return void json(res, 200, biz.upsertAgentContract(
            m[1], canonicalOperatorActor(operator, p),
            body.policy as Record<string, unknown> | undefined,
            typeof body.expected_version === "number" ? body.expected_version : undefined,
          ));
        }
      }
      m = p.match(/^\/api\/org-agents\/([^/]+)\/contract\/(enable|disable)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.setAgentContractStatus(
          m[1], m[2] === "disable" ? "DISABLED" : "ACTIVE", canonicalOperatorActor(operator, p)));
      }
      m = p.match(/^\/api\/org-agents\/([^/]+)\/effective-policy$/);
      if (method === "GET" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.inspectAgentPolicy(m[1]));
      }
      if (method === "GET" && p === "/api/work-items") {
        const bid = url.searchParams.get("business_id") ?? undefined;
        return void json(res, 200,
          { work_items: biz ? stripClaimToken(biz.listWorkItems(bid)) : [] });
      }
      if (method === "POST" && p === "/api/work-items") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.createWorkItem({
          business_id: String(body.business_id ?? ""), title: String(body.title ?? ""),
          goal: String(body.goal ?? ""), department: String(body.department ?? "") || undefined,
          assignee_agent_id: String(body.assignee_agent_id ?? "") || undefined,
          objective_id: String(body.objective_id ?? "") || undefined,
          priority: typeof body.priority === "number" ? body.priority : undefined,
          operator_id: operatorRef(operator, p),
        }));
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/(claim|release|heartbeat|comment|block|unblock|artifacts|messages)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const [, wid, wact] = m;
        if (wact === "messages") {
          return void json(res, 200, biz.sendWorkforceMessage({
            business_id: String(body.business_id ?? ""),
            work_item_id: wid,
            sender_type: (String(body.sender_type ?? "OPERATOR") as "AGENT" | "OPERATOR"),
            sender_agent_id: String(body.sender_agent_id ?? "") || null,
            sender_operator_id: String(body.sender_operator_id ?? operator) || null,
            recipient_agent_id: String(body.recipient_agent_id ?? ""),
            kind: String(body.kind ?? "NOTE"),
            body: String(body.body ?? ""),
            correlation_id: String(body.correlation_id ?? "") || null,
          }));
        }
        const out =
          wact === "claim" ? biz.claimWorkItem(wid, String(body.agent_id ?? ""), canonicalOperatorActor(operator, p))
          : wact === "release" ? biz.releaseClaim(wid, canonicalOperatorActor(operator, p), String(body.claim_token ?? "") || undefined)
          : wact === "heartbeat" ? biz.heartbeatWorkItem(
              wid, String(body.agent_id ?? ""), String(body.claim_token ?? ""), canonicalOperatorActor(operator, p))
          : wact === "comment" ? biz.commentOnWorkItem(wid, String(body.author ?? operator), String(body.body ?? ""))
          : wact === "block" ? biz.blockWorkItem(wid, String(body.reason ?? ""), canonicalOperatorActor(operator, p))
          : wact === "unblock" ? biz.unblockWorkItem(wid, canonicalOperatorActor(operator, p))
          : biz.attachWorkItemArtifact(wid, {
              name: String(body.name ?? ""), uri: String(body.uri ?? ""),
              content_type: String(body.content_type ?? "") || undefined,
            }, canonicalOperatorActor(operator, p));
        // The raw token is returned ONLY by the claim creation response;
        // every other work-item payload has it stripped (P2 §2).
        return void json(res, 200, wact === "claim" ? out : stripClaimToken(out));
      }
      // P2: GET claim → safe lease metadata only (never token material);
      // GET messages → the item's collaboration thread; inbox + ack.
      m = p.match(/^\/api\/work-items\/([^/]+)\/(claim|messages)$/);
      if (method === "GET" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const [, wid, wact] = m;
        const out = wact === "claim"
          ? (biz.getWorkItemClaim(wid) ?? { work_item_id: wid, state: "NONE" })
          : { messages: biz.listWorkItemMessages(wid) };
        return void json(res, 200, stripClaimToken(out));
      }
      m = p.match(/^\/api\/org-agents\/([^/]+)\/inbox$/);
      if (method === "GET" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, { messages: biz.inboxForAgent(m[1]) });
      }
      m = p.match(/^\/api\/workforce\/messages\/([^/]+)\/ack$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.ackWorkforceMessage(
          m[1], String(body.agent_id ?? ""), canonicalOperatorActor(operator, p)));
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/(open|assign|cancel|review)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const [, wid, wact] = m;
        const out =
          wact === "open"
            ? biz.openWorkItem(wid, canonicalOperatorActor(operator, p), undefined, {
                // Phase C — direct delegated opens run through the SAME
                // shared async Planner Pool seam before the sole
                // bound-mission authority commits. The awaited plan is
                // authorized for the canonical enriched bound-mission
                // goal; openWorkItem re-proves its goal digest inside
                // the dedup write. Planner absent/exhausted propagates
                // fail-closed — never a template mission.
                prepared_plan: await biz.prepareDelegatedPlan(wid, canonicalOperatorActor(operator, p)),
              })
          : wact === "assign" ? biz.assignWorkItem(wid, String(body.assignee_agent_id ?? ""), canonicalOperatorActor(operator, p))
          : wact === "review" ? biz.reviewWorkItem(wid, {
              reviewer_agent_id: String(body.reviewer_agent_id ?? ""),
              decision: String(body.decision ?? ""),
            }, canonicalOperatorActor(operator, p))
          : biz.cancelWorkItem(wid, canonicalOperatorActor(operator, p)); // governed cancel: live mission cancelled first, then CANCELLED
        return void json(res, 200, out);
      }
      // ----- P14 Workforce V2 Phase 1: governed work graph -----
      const wf = deps.workforce;
      m = p.match(/^\/api\/work-items\/([^/]+)\/decompose$/);
      if (method === "POST" && m) {
        if (!wf) return void json(res, 404, { error: "WORKFORCE_DISABLED" });
        return void json(res, 200, wf.decomposeWorkItem(m[1], {
          decomposition_id: String(body.decomposition_id ?? ""),
          children: Array.isArray(body.children) ? body.children : [],
        }, canonicalOperatorActor(operator, p)));
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/delegate$/);
      if (method === "POST" && m) {
        if (!wf) return void json(res, 404, { error: "WORKFORCE_DISABLED" });
        return void json(res, 200, wf.delegateWorkItem({
          work_item_id: m[1],
          delegated_by_agent_id: String(body.delegated_by_agent_id ?? ""),
          delegated_to_agent_id: String(body.delegated_to_agent_id ?? ""),
          reason: body.reason === undefined ? undefined : String(body.reason),
          delegation_key: body.delegation_key === undefined ? undefined : String(body.delegation_key),
        }, canonicalOperatorActor(operator, p)));
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/dependencies$/);
      if (method === "PUT" && m) {
        if (!wf) return void json(res, 404, { error: "WORKFORCE_DISABLED" });
        return void json(res, 200, wf.setWorkItemDependencies(
          m[1],
          Array.isArray(body.depends_on) ? body.depends_on.map(String) : [],
          typeof body.expected_version === "number" ? body.expected_version : -1,
          canonicalOperatorActor(operator, p),
        ));
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/completion$/);
      if (method === "GET" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const v = biz.workCompletionFor(m[1]);
        return void json(res, 200, {
          work_item_id: m[1],
          status: String(v.work_item.status),
          canonically_complete: v.canonically_complete,
          completion: v.completion,
        });
      }
      m = p.match(/^\/api\/businesses\/([^/]+)\/work-graph$/);
      if (method === "GET" && m) {
        if (!wf) return void json(res, 404, { error: "WORKFORCE_DISABLED" });
        return void json(res, 200, wf.workGraph(m[1]));
      }
      if (method === "GET" && p === "/api/routines") {
        const bid = url.searchParams.get("business_id") ?? undefined;
        return void json(res, 200, { routines: biz ? biz.listRoutines(bid) : [] });
      }
      if (method === "POST" && p === "/api/routines") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.createRoutine({
          business_id: String(body.business_id ?? ""), name: String(body.name ?? ""),
          goal_template: String(body.goal_template ?? ""), cron: String(body.cron ?? ""),
          department: String(body.department ?? "") || undefined,
          assignee_agent_id: String(body.assignee_agent_id ?? "") || undefined,
          operator_id: operatorRef(operator, p),
        }));
      }
      m = p.match(/^\/api\/routines\/([^/]+)\/(enable|disable)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.setRoutineEnabled(m[1], m[2] === "enable", canonicalOperatorActor(operator, p)));
      }
      if (method === "GET" && p === "/api/objectives") {
        const bid = url.searchParams.get("business_id") ?? undefined;
        return void json(res, 200, { objectives: biz ? biz.listObjectives(bid) : [] });
      }
      if (method === "POST" && p === "/api/objectives") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.createObjective({
          business_id: String(body.business_id ?? ""), title: String(body.title ?? ""),
          description: String(body.description ?? "") || undefined,
          parent_objective_id: String(body.parent_objective_id ?? "") || undefined,
          metric: String(body.metric ?? "") || undefined,
          target: String(body.target ?? "") || undefined,
          operator_id: canonicalOperatorActor(operator, p),
        }));
      }
      // ----- P15.7 — canonical vnext Objective API (P15.1 authority) -----
      // Distinct namespace from the legacy /api/objectives compat API;
      // both delegate to the same P15.1 ObjectiveAuthorityService.
      if (method === "GET" && p === "/api/vnext/objectives") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const bid = url.searchParams.get("business_id") ?? undefined;
        const rows = biz.objectives.list(bid);
        // Strict canonical read — a corrupt row rejects the whole list
        // rather than being silently trusted or silently discarded.
        for (const r of rows) biz.objectives.assertCanonicalRow(r);
        return void json(res, 200, { objectives: rows });
      }
      if (method === "POST" && p === "/api/vnext/objectives") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.objectives.create({
          business_id: String(body.business_id ?? ""),
          title: body.title === undefined ? undefined : String(body.title),
          description: body.description === undefined ? undefined : String(body.description),
          statement: body.statement === undefined ? undefined : String(body.statement),
          parent_objective_id: body.parent_objective_id === undefined ? undefined : String(body.parent_objective_id),
          owner_authority_id: body.owner_authority_id === undefined ? undefined : String(body.owner_authority_id),
          metric: body.metric === undefined ? undefined : String(body.metric),
          target: body.target === undefined || body.target === null ? undefined : String(body.target),
          kpis: body.kpis === undefined ? undefined : body.kpis as Array<Record<string, unknown>>,
          deadline: body.deadline === undefined ? undefined : body.deadline as string | null,
          budget_ceiling_microusd: body.budget_ceiling_microusd === undefined ? undefined : Number(body.budget_ceiling_microusd),
          currency: body.currency === undefined ? undefined : String(body.currency),
          // Pass-through, never coerced: P15.1 normalizeStringList is the
          // canonical validator — a scalar or non-string element rejects
          // the whole create (F1).
          hard_constraints: body.hard_constraints as string[] | undefined,
          success_conditions: body.success_conditions as string[] | undefined,
          stop_conditions: body.stop_conditions as string[] | undefined,
          dedup_key: body.dedup_key === undefined ? undefined : String(body.dedup_key),
          // Edge gate (audit M1): String(undefined|{}|null) would mint
          // `operator:undefined`-class owners — identities any caller
          // could then claim by echoing the same garbage header. The
          // owner_authority_id minted here is write authority forever,
          // so a coercion-artifact identity fails closed, never mints.
          operator_id: canonicalOperatorActor(operator, p),
        }));
      }
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)$/);
      if (method === "GET" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.objectives.get(m[1]));
      }
      // ----- P15.7 — CEO operating trigger (ONE bounded pass) -----
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/ceo-cycle$/);
      if (method === "POST" && m) {
        if (!biz || !wf || !deps.store) {
          return void json(res, 404, { error: "OPERATING_LOOP_DISABLED" });
        }
        ceoOps ??= createDefaultObjectiveOperatingService({
          store: deps.store,
          business: biz,
          workforce: wf,
          objectives: biz.objectives,
          workstreams: new ObjectiveWorkstreamService({
            store: deps.store, business: biz, workforce: wf,
            objectives: biz.objectives,
          }),
          invoker: deps.ceoInvoker,
        });
        const out = await ceoOps.service.runObjectivePass({
          objective_id: m[1], actor: canonicalOperatorActor(operator, p),
        });
        return void json(res, 200, out);
      }
      // ----- P15.10-D — owner-scoped KPI auto-verification grants -----
      // grant/revoke/disable/status: owner-only, fails closed via the
      // service's authority contract. Grants are the ONLY opt-in path for
      // delegated KPI progress writes; default OFF everywhere else.
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/kpi-verification$/);
      if (method === "POST" && m) {
        if (!biz || !wf || !deps.store) {
          return void json(res, 404, { error: "OPERATING_LOOP_DISABLED" });
        }
        ceoOps ??= createDefaultObjectiveOperatingService({
          store: deps.store,
          business: biz,
          workforce: wf,
          objectives: biz.objectives,
          workstreams: new ObjectiveWorkstreamService({
            store: deps.store, business: biz, workforce: wf,
            objectives: biz.objectives,
          }),
          invoker: deps.ceoInvoker,
        });
        const svc = ceoOps.kpiVerification;
        const kpiActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        const action = String(body.action ?? "");
        if (action === "status") {
          return void json(res, 200, svc.status(m[1]!, kpiActor));
        }
        if (action === "grant") {
          // Grant + eligible wake are one canonical transaction. If either
          // write fails, no partial grant survives the failed request.
          const objectiveId = m[1]!;
          const granted = deps.store.immediate(() => {
            const saved = svc.grant(objectiveId, {
              actor: kpiActor,
              kpi_id: String(body.kpi_id ?? ""),
              rule: body.rule,
              expires_at: String(body.expires_at ?? ""),
              idempotency_key: String(body.idempotency_key ?? crypto.randomUUID()),
            });
            deps.autoScheduler?.notifyKpiVerifierGrant(
              objectiveId, String(saved.authorization_id));
            return saved;
          });
          return void json(res, 200, granted);
        }
        if (action === "revoke" || action === "disable") {
          return void json(res, 200, svc.control(m[1]!, String(body.authorization_id ?? ""), {
            actor: kpiActor,
            action,
            idempotency_key: String(body.idempotency_key ?? crypto.randomUUID()),
          }));
        }
        throw new IntegrityError("FAIL_CLOSED_KPI_VERIFY", `action ${action} unsupported`);
      }
      /* ----- P15.9 Step-0 — owner-scoped measurement / evidence /
         amendment. These HTTP seams were absent: the P15.1 authority
         methods recordProgress / attachEvidence / amend existed but
         were unreachable over the wire (curl-only for kpi-verification,
         nothing for the rest). Owner proof comes ONLY from the trusted
         x-operator-id header — a body-declared owner field is never
         authority. The verifier inside the evidence is always the
         header-derived actor itself (operator:<id>): the P15.1
         assertOwnerVerifier gate then requires actor ===
         owner_authority_id, so a non-owner fails closed inside the
         service. All semantics (scope, terminal, ledger idempotency,
         CAS version, AMENDABLE_KEYS, budget re-proof) stay in
         ObjectiveAuthorityService — the route only authenticates and
         passes schema-checked inputs through. accountBudget is
         deliberately NOT exposed: the service does not assertOwner for
         it (it is the canonical cost-pipeline seam), so an HTTP seam
         would weaken the call discipline for zero owner-facing need. */
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/(progress|evidence|amend)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        // Header-only authority — the shared edge gate also rejects
        // coercion-artifact identities (a row minted under a garbage
        // owner can never be claimed by echoing that garbage back).
        const ownerActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        const ownerAction = m[2]!;
        const businessId = String(body.business_id ?? "");
        if (ownerAction === "amend") {
          if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
            throw new IntegrityError(
              "FAIL_CLOSED_OBJECTIVE_AMEND",
              "patch must be a non-null object (keys restricted by AMENDABLE_KEYS in the authority service)",
            );
          }
          return void json(res, 200, biz.objectives.amend(m[1]!, {
            business_id: businessId,
            patch: body.patch as Record<string, unknown>,
            reason: body.reason === undefined ? undefined : String(body.reason),
            actor: ownerActor,
            /* Idempotency anchor (R2 M2′): without it an ambiguous
               retry after a committed-but-lost response would bump
               terms_version and invalidate pinned reviews twice. */
            idempotency_key: body.idempotency_key === undefined
              ? undefined : String(body.idempotency_key),
          }));
        }
        /* progress + evidence share the owner-verifier evidence shape:
           - verifier is ALWAYS the header-derived actor — a
             body-supplied verifier can never substitute authority;
           - evidence_key is REQUIRED (the canonical idempotency
             anchor): a server-minted key would defeat ledger dedup on
             an ambiguous transport retry;
           - source is pinned to "owner-console" — the honest
             provenance label of THIS seam; a body-chosen source would
             let a caller falsify where the evidence came from. */
        const evidenceKey = String(body.evidence_key ?? "");
        if (!evidenceKey) {
          throw new IntegrityError(
            "FAIL_CLOSED_OBJECTIVE_FIELD",
            "evidence_key is required — it is the canonical idempotency anchor",
          );
        }
        const evidence = {
          evidence_key: evidenceKey,
          verifier: ownerActor,
          source: "owner-console",
        };
        const note = body.note === undefined ? undefined : String(body.note);
        if (ownerAction === "progress") {
          // typeof-strict: Number(null)===0 / Number("")===0 would
          // otherwise mint a silent zero measurement.
          if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
            throw new IntegrityError(
              "FAIL_CLOSED_OBJECTIVE_FIELD",
              "value must be a finite JSON number",
            );
          }
          return void json(res, 200, biz.objectives.recordProgress(m[1]!, {
            business_id: businessId,
            kpi_id: String(body.kpi_id ?? ""),
            value: body.value,
            evidence,
            note,
            actor: ownerActor,
          }));
        }
        return void json(res, 200, biz.objectives.attachEvidence(m[1]!, {
          business_id: businessId,
          evidence,
          note,
          actor: ownerActor,
        }));
      }
      // ----- P15.10-B — owner-scoped RECONCILE_ONLY scheduler status -----
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/auto-scheduler$/);
      if (m && method === "GET") {
        if (!biz || !deps.autoScheduler) {
          return void json(res, 404, { error: "AUTO_SCHEDULER_DISABLED" });
        }
        const schedulerActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        // P15.10-C R3 F3 — readiness is the driver's OWN truthful
        // proof for THIS objective, not a deployment flag.
        const r = deps.autoDriver?.readiness(m[1]!, schedulerActor);
        return void json(res, 200, {
          auto_scheduler: deps.autoScheduler.status(m[1]!, schedulerActor,
            deps.autoDriver
              ? { enabled: true, driver_missing: [],
                  runnable: r?.objective_runnable === true,
                  reasons: (r?.reasons as string[] | undefined) ?? [] }
              : undefined),
        });
      }
      // ----- P15.10-C — owner-scoped autonomous driver status (read-only) -----
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/auto-driver$/);
      if (m && method === "GET") {
        if (!biz || !deps.autoDriver) {
          return void json(res, 404, { error: "AUTO_DRIVER_DISABLED" });
        }
        const driverActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        return void json(res, 200, {
          auto_driver: deps.autoDriver.status(m[1]!, driverActor),
        });
      }
      // ----- P15.10-A — objective auto-policy control plane -----
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/auto-policy$/);
      if (m && (method === "GET" || method === "POST")) {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "AUTO_POLICY_DISABLED" });
        }
        // Canonical actor derivation — same convention the Objective
        // create path uses (`operator:<id>`), so an owner who created
        // the objective with a raw header can operate its policy with
        // the same raw header. Body-declared identity never consulted.
        const policyActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        autoPolicySvc ??= new ObjectiveAutoPolicyService(deps.store, biz.objectives);
        // P15.10-C R3 F3 — truthful readiness: the driver's own
        // canonical proof for this objective (scheduler READY + policy
        // effective + no quarantine + provable cost binding + budget
        // room), never just "a driver process exists".
        const policyObjectiveId = m[1]!;
        const policyWithDriver = (st: ReturnType<ObjectiveAutoPolicyService["status"]>) => {
          if (!deps.autoDriver) return st;
          const r = deps.autoDriver.readiness(policyObjectiveId, policyActor);
          return { ...st,
            driver_ready: r.objective_runnable === true,
            objective_runnable: r.objective_runnable === true,
            driver_integrated: true,
            driver_missing: ((r.reasons as string[] | undefined) ?? []) };
        };
        if (method === "GET") {
          return void json(res, 200, {
            auto_policy: policyWithDriver(autoPolicySvc.status(m[1]!, policyActor)),
          });
        }
        // F3 — strict boundary typing: NO coercion of authority fields.
        // Malformed types are rejected with zero mutation before the
        // service sees them; the service re-validates independently.
        const malformed =
          typeof body.action !== "string" ||
          typeof body.idempotency_key !== "string" ||
          (body.policy_version !== undefined && !Number.isInteger(body.policy_version)) ||
          (body.limits !== undefined &&
            (typeof body.limits !== "object" || body.limits === null || Array.isArray(body.limits))) ||
          (body.halt_scope !== undefined && typeof body.halt_scope !== "string") ||
          (body.halt_reason !== undefined && typeof body.halt_reason !== "string");
        if (malformed) {
          return void json(res, 400, { error: "FAIL_CLOSED_POLICY_SCHEMA" });
        }
        return void json(res, 200, {
          auto_policy: policyWithDriver(autoPolicySvc.control({
            objective_id: m[1]!,
            actor: policyActor,
            action: body.action as string,
            policy_version: body.policy_version as number | undefined,
            limits: body.limits,
            idempotency_key: body.idempotency_key as string,
            halt_scope: body.halt_scope,
            halt_reason: body.halt_reason,
          })),
        });
      }
      // ===== P18.1 — Operator Control Center owner seams =====
      // Owner-facing HTTP for the canonical P18 substrate that
      // previously required sidecar calls: objective relations
      // (DEPENDS_ON/CONFLICTS/SUPERSEDES), org-agent duties, objective
      // status transitions, and aggregated scheduler/driver
      // observability. Same contract as every vnext route: the ONLY
      // authority source is the x-operator-id header canonicalized via
      // canonicalOperatorActor; all semantics — bilateral/N-lateral
      // owner proof, business scope, CAS, idempotent replay, proven
      // rows — live inside the canonical services. The route
      // authenticates and schema-checks only; it never writes a store
      // row and never substitutes a body-declared owner.
      const relationSvc = () =>
        new ObjectiveRelationService(deps.store!);
      const dutySvc = () =>
        new OrgAgentDutyService(deps.store!);
      // Owner proof for objective-scoped reads: the canonical row's
      // owner_authority_id must equal the header actor — the same
      // assertion the authority service makes internally. A foreign
      // owner learns nothing about the objective's relation/duty
      // surface (403 code-only, per the shared error mapping).
      const ownedObjective = (objectiveId: string) => {
        const row = biz!.objectives.get(objectiveId);
        if (String(row.owner_authority_id) !==
            canonicalOperatorActor(req.headers["x-operator-id"], p)) {
          throw new IntegrityError(
            "FAIL_CLOSED_OBJECTIVE_AUTHORITY", p);
        }
        return row;
      };
      // Business-scope proof (portfolio convention): the actor must
      // strictly own at least one objective in the business — a
      // tampered row anywhere fails closed before any projection.
      const assertBusinessScope = (businessId: string, actor: string) => {
        const owned = biz!.objectives.strictEnumerate().filter(
          (o) => String(o.business_id) === businessId &&
            String(o.owner_authority_id) === actor);
        if (!owned.length) {
          throw new IntegrityError("FAIL_CLOSED_PORTFOLIO_SCOPE", p);
        }
        return owned;
      };
      // ----- P18.1-B — objective relations: reads + owner mutations --
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/relations$/);
      if (m && method === "GET") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "RELATIONS_DISABLED" });
        }
        ownedObjective(m[1]!); // owner proof
        const rels = relationSvc();
        return void json(res, 200, {
          relations: rels.relationsFor(m[1]!),
          admission: rels.admissionView(m[1]!),
        });
      }
      if (m && method === "POST") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "RELATIONS_DISABLED" });
        }
        const relActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        // Strict request typing BEFORE the service sees anything —
        // wrong JSON types are a typed 400 with zero mutation; the
        // service re-validates kind/endpoints/authority independently.
        if (
          typeof body.to_objective_id !== "string" ||
          typeof body.kind !== "string" ||
          (body.note !== undefined && body.note !== null && typeof body.note !== "string") ||
          (body.dedup_key !== undefined && typeof body.dedup_key !== "string")
        ) {
          return void json(res, 400, {
            error: "FAIL_CLOSED_RELATION_REQUEST",
            detail: "to_objective_id + kind required strings; note/dedup_key optional strings",
          });
        }
        return void json(res, 200, {
          relation: relationSvc().create({
            from_objective_id: m[1]!,
            to_objective_id: body.to_objective_id as string,
            kind: body.kind as string,
            actor: relActor,
            note: body.note === undefined ? undefined : (body.note as string | null),
            dedup_key: body.dedup_key === undefined ? undefined : (body.dedup_key as string),
          }),
        });
      }
      // Advisory preview — reports CURRENT canonical state and the
      // implication the proposed edge would have. Advisory only: the
      // authoritative validation (bilateral authority, acyclicity,
      // business scope) happens inside create() at commit time; this
      // surface exists so the operator can see consequences before
      // confirming. No write is possible on this route.
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/relations\/preview$/);
      if (m && method === "POST") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "RELATIONS_DISABLED" });
        }
        const from = ownedObjective(m[1]!); // owner proof
        if (typeof body.to_objective_id !== "string" ||
            typeof body.kind !== "string") {
          return void json(res, 400, {
            error: "FAIL_CLOSED_RELATION_REQUEST",
            detail: "to_objective_id + kind required strings",
          });
        }
        const fromId = m[1]!;
        const toId = body.to_objective_id as string;
        const kind = body.kind as string;
        if (!["DEPENDS_ON", "CONFLICTS", "SUPERSEDES"].includes(kind)) {
          return void json(res, 200, {
            advisory: true, valid: false,
            errors: [`unknown kind ${kind}`],
          });
        }
        const rels = relationSvc();
        const businessId = String(from.business_id ?? "");
        const edges = rels.relationsForBusiness(businessId);
        const errors: string[] = [];
        let toRow: Record<string, unknown> | null = null;
        try { toRow = biz.objectives.get(toId) as Record<string, unknown>; }
        catch { errors.push(`objective ${toId} not found`); }
        if (toRow && String(toRow.business_id ?? "") !== businessId) {
          errors.push("cross-business relation");
        }
        if (toRow && String(toRow.owner_authority_id ?? "") !==
            String(from.owner_authority_id ?? "")) {
          errors.push("target objective has a different owner (bilateral authority required)");
        }
        if (toId === fromId) errors.push("self-relation is meaningless");
        const duplicate = edges.find((r) =>
          r.kind === kind && r.state !== "REVOKED" &&
          ((r.from_objective_id === fromId && r.to_objective_id === toId) ||
            (kind === "CONFLICTS" && r.from_objective_id === toId &&
              r.to_objective_id === fromId)));
        if (duplicate) errors.push(`identical ${kind} edge already exists (${duplicate.relation_id})`);
        // Advisory cycle reachability over ACTIVE DEPENDS_ON — a hint
        // for the operator; create() runs the authoritative check.
        let wouldCycle = false;
        if (kind === "DEPENDS_ON" && !errors.length) {
          const active = edges.filter(
            (r) => r.kind === "DEPENDS_ON" && r.state === "ACTIVE");
          const seen = new Set<string>([toId]);
          const stack = [toId];
          while (stack.length) {
            const cur = stack.pop()!;
            if (cur === fromId) { wouldCycle = true; break; }
            for (const e of active) {
              if (e.from_objective_id === cur && !seen.has(e.to_objective_id)) {
                seen.add(e.to_objective_id); stack.push(e.to_objective_id);
              }
            }
          }
          if (wouldCycle) errors.push("would create a DEPENDS_ON cycle");
        }
        // Scope hygiene: when the target is cross-business or
        // foreign-owned, its status never leaks into the advisory —
        // the operator only learns "not yours to touch".
        const scopeLeak = errors.some(
          (e) => e.includes("different owner") || e.includes("cross-business"));
        const toStatus = !scopeLeak && toRow ? String(toRow.status ?? "") : null;
        const implications = scopeLeak ? {} : ({
          DEPENDS_ON: {
            effect: `${fromId} will not be admitted until ${toId} is ACHIEVED or superseded`,
            current_target_status: toStatus,
            would_block_now: toStatus !== "ACHIEVED",
          },
          CONFLICTS: {
            effect: `${fromId} and ${toId} must never hold concurrent active leases`,
            symmetric: true,
          },
          SUPERSEDES: {
            effect: `${fromId} declares itself the replacement for ${toId}; dependents of ${toId} are released when ${fromId} is ACHIEVED`,
            requires: `${fromId} must reach ACHIEVED for the release to fire`,
          },
        } as Record<string, Record<string, unknown>>)[kind] ?? {};
        return void json(res, 200, {
          advisory: true,
          valid: errors.length === 0,
          errors,
          kind,
          from_objective_id: fromId,
          to_objective_id: toId,
          implications,
          current: {
            relations: rels.relationsFor(fromId).length,
            admission: errors.length ? undefined : rels.admissionView(fromId),
          },
        });
      }

      m = p.match(/^\/api\/vnext\/relations\/([^/]+)\/(suspend|resume|revoke)$/);
      if (m && method === "POST") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "RELATIONS_DISABLED" });
        }
        const relActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        return void json(res, 200, {
          relation: relationSvc().control({
            relation_id: m[1]!,
            action: m[2]!.toUpperCase() as "SUSPEND" | "RESUME" | "REVOKE",
            actor: relActor,
          }),
        });
      }
      m = p.match(/^\/api\/vnext\/businesses\/([^/]+)\/relations$/);
      if (m && method === "GET") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "RELATIONS_DISABLED" });
        }
        const actor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        const owned = assertBusinessScope(m[1]!, actor);
        const ownedIds = new Set(owned.map((o) => String(o.objective_id)));
        // Edges entirely inside the owned scope only — identical
        // honesty bound as the portfolio projection.
        return void json(res, 200, {
          relations: relationSvc().relationsForBusiness(m[1]!).filter(
            (r) => ownedIds.has(r.from_objective_id) &&
              ownedIds.has(r.to_objective_id)),
        });
      }
      // ----- P18.1-C — org-agent duties: reads + owner mutations -----
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/duties$/);
      if (m && method === "GET") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "DUTIES_DISABLED" });
        }
        ownedObjective(m[1]!); // owner proof
        return void json(res, 200, {
          duties: dutySvc().dutiesForObjective(m[1]!),
        });
      }
      m = p.match(/^\/api\/vnext\/org-agents\/([^/]+)\/duties$/);
      if (m && method === "GET") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "DUTIES_DISABLED" });
        }
        const actor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        const agentId = m[1]!;
        const agent = biz.listOrgAgents().find(
          (a) => String(a.agent_id) === agentId);
        // No existence oracle: an unknown agent and a foreign-owned
        // agent get the same authority failure — 404-vs-403 must never
        // disclose that the agent exists outside the caller's scope.
        if (!agent) {
          return void json(res, 403, {
            error: "FAIL_CLOSED_BUSINESS_SCOPE",
            detail: "actor does not own this agent's business scope",
          });
        }
        const owned = assertBusinessScope(String(agent.business_id ?? ""), actor);
        const ownedIds = new Set(owned.map((o) => String(o.objective_id)));
        // Scoped-honest read: only duties whose covered objectives are
        // ALL owned by the actor enter the projection — a duty
        // spanning foreign coverage is invisible, never partially
        // disclosed (portfolio edge-honesty convention).
        return void json(res, 200, {
          duties: dutySvc().dutiesForAgent(agentId).filter(
            (d) => d.objective_ids.every((o) => ownedIds.has(o))),
        });
      }
      if (m && method === "POST") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "DUTIES_DISABLED" });
        }
        const dutyActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        if (!Array.isArray(body.objective_ids) ||
            body.objective_ids.some((v) => typeof v !== "string") ||
            (body.note !== undefined && body.note !== null && typeof body.note !== "string") ||
            (body.dedup_key !== undefined && typeof body.dedup_key !== "string")) {
          return void json(res, 400, {
            error: "FAIL_CLOSED_DUTY_REQUEST",
            detail: "objective_ids must be a string array; note/dedup_key optional strings",
          });
        }
        return void json(res, 200, {
          duty: dutySvc().create({
            org_agent_id: m[1]!,
            objective_ids: body.objective_ids as string[],
            actor: dutyActor,
            note: body.note === undefined ? undefined : (body.note as string | null),
            dedup_key: body.dedup_key === undefined ? undefined : (body.dedup_key as string),
          }),
        });
      }
      m = p.match(/^\/api\/vnext\/duties\/([^/]+)\/(suspend|resume|revoke)$/);
      if (m && method === "POST") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "DUTIES_DISABLED" });
        }
        const dutyActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        return void json(res, 200, {
          duty: dutySvc().control({
            duty_id: m[1]!,
            action: m[2]!.toUpperCase() as "SUSPEND" | "RESUME" | "REVOKE",
            actor: dutyActor,
          }),
        });
      }
      m = p.match(/^\/api\/vnext\/businesses\/([^/]+)\/duties$/);
      if (m && method === "GET") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "DUTIES_DISABLED" });
        }
        const actor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        const owned = assertBusinessScope(m[1]!, actor);
        const ownedIds = new Set(owned.map((o) => String(o.objective_id)));
        const svc = dutySvc();
        const seen = new Map<string, unknown>();
        for (const agent of biz.listOrgAgents(m[1]!)) {
          for (const d of svc.dutiesForAgent(String(agent.agent_id))) {
            // Duties fully inside the owned objective scope only —
            // partial/foreign coverage never enters the projection.
            if (d.objective_ids.every((o) => ownedIds.has(o))) {
              seen.set(d.duty_id, d);
            }
          }
        }
        return void json(res, 200, { duties: [...seen.values()] });
      }
      // ----- P18.1-D — objective status transitions -----------------
      // PAUSE/RESUME/CANCEL via the canonical transitionStatus — the
      // service owns the legal-transition table, terminal guards and
      // owner proof; the route only types the request. The operator
      // surface is deliberately narrower than the service table:
      // ACHIEVED/INFEASIBLE stay behind the review-signoff gate (P15.10
      // A2) — an unevidenced owner-declared completion is not allowed
      // through this seam.
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/transition$/);
      if (m && method === "POST") {
        if (!biz) {
          return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        }
        const trActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        if (typeof body.to !== "string" || typeof body.business_id !== "string" ||
            (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string")) {
          return void json(res, 400, {
            error: "FAIL_CLOSED_OBJECTIVE_TRANSITION_REQUEST",
            detail: "to + business_id required strings; reason optional string",
          });
        }
        const trTo = String(body.to);
        if (trTo !== "ACTIVE" && trTo !== "PAUSED" && trTo !== "CANCELLED") {
          return void json(res, 400, {
            error: "FAIL_CLOSED_OBJECTIVE_TRANSITION_REQUEST",
            detail: `to ${trTo} not allowed on this seam — ` +
              "operator controls are PAUSE/RESUME/CANCEL only; " +
              "ACHIEVED requires the canonical review sign-off",
          });
        }
        return void json(res, 200, {
          objective: biz.objectives.transitionStatus(m[1]!, {
            business_id: body.business_id as string,
            to: body.to as never,
            reason: body.reason === undefined || body.reason === null
              ? undefined : String(body.reason),
            actor: trActor,
          }),
        });
      }
      // ----- P18.1-E — aggregated operations observability ----------
      // One-call per-objective operational view: canonical objective
      // row + policy/scheduler/driver/admission/duty state. Every field
      // is an existing owner-scoped read — nothing here is inferred.
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/operations$/);
      if (m && method === "GET") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "OPERATIONS_DISABLED" });
        }
        const opsActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        const objectiveId = m[1]!;
        autoPolicySvc ??= new ObjectiveAutoPolicyService(deps.store, biz.objectives);
        const policy = autoPolicySvc.statusReadOnly(objectiveId, opsActor);
        const rels = relationSvc();
        const admission = rels.admissionView(objectiveId);
        const driver = deps.autoDriver
          ? deps.autoDriver.statusReadOnly(objectiveId, opsActor)
          : null;
        // Truthful readiness (P15.10-C R3 F3): the driver's own
        // objective-level proof — same convention as /auto-scheduler.
        // readiness() may commit the canonical lazy EXPIRED transition
        // (same behavior as the existing policy GET — not a pure read).
        const r = deps.autoDriver?.readiness(objectiveId, opsActor);
        return void json(res, 200, {
          operations: {
            objective_id: objectiveId,
            objective: biz.objectives.get(objectiveId),
            auto_policy: policy,
            auto_scheduler: deps.autoScheduler
              ? deps.autoScheduler.status(objectiveId, opsActor,
                  deps.autoDriver
                    ? { enabled: true, driver_missing: [],
                        runnable: r?.objective_runnable === true,
                        reasons: (r?.reasons as string[] | undefined) ?? [] }
                    : undefined)
              : null,
            auto_driver: driver,
            admission,
            relations: rels.relationsFor(objectiveId),
            duties: dutySvc().dutiesForObjective(objectiveId),
          },
        });
      }
      // Company-level operations overview — per owned-objective queue
      // snapshot for the cockpit table. Read-only composition over the
      // same owner-scoped status seams.
      m = p.match(/^\/api\/vnext\/businesses\/([^/]+)\/operations$/);
      if (m && method === "GET") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "OPERATIONS_DISABLED" });
        }
        const actor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        const owned = assertBusinessScope(m[1]!, actor);
        autoPolicySvc ??= new ObjectiveAutoPolicyService(deps.store, biz.objectives);
        const rows = owned.map((o) => {
          const oid = String(o.objective_id);
          const rec: Record<string, unknown> = {
            objective_id: oid,
            status: o.status,
            title: o.title ?? o.statement ?? null,
            updated_at: o.updated_at,
          };
          // Absent component → NOT_OBSERVED. IntegrityError is NEVER
          // masked as absence — a wedged/corrupt row surfaces its typed
          // code so the operator sees the fail-closed truth.
          const obsOrWedge = (e: unknown) =>
            e instanceof IntegrityError ? `UNPROVEN:${e.code}` : "NOT_OBSERVED";
          try {
            rec.auto_policy_effective =
              autoPolicySvc!.statusReadOnly(oid, actor).effective;
          } catch (e) {
            rec.auto_policy_effective = obsOrWedge(e);
          }
          if (deps.autoScheduler) {
            try {
              const s = deps.autoScheduler.status(oid, actor) as
                Record<string, unknown>;
              rec.queue_state = s.queue_state;
              rec.pending_generation = s.pending_generation;
              rec.claimed_generation = s.claimed_generation;
              rec.blocked_reason = s.blocked_reason;
              rec.next_due = s.next_due;
              rec.lease = s.lease;
              rec.owner_action_required = s.owner_action_required;
            } catch (e) {
              rec.queue_state = obsOrWedge(e);
            }
          } else {
            rec.queue_state = "NOT_OBSERVED";
          }
          if (deps.autoDriver) {
            try {
              const d = deps.autoDriver.statusReadOnly(oid, actor) as
                Record<string, unknown>;
              rec.driver_last_outcome = d.last_outcome;
              rec.capability_gap = d.capability_gap;
            } catch (e) {
              rec.driver_last_outcome = obsOrWedge(e);
            }
          } else {
            rec.driver_last_outcome = "NOT_OBSERVED";
          }
          return rec;
        });
        return void json(res, 200, { operations: rows });
      }
      // ----- P18.1-G — integrity observability (read-only probe) ----
      // Reports whether the canonical strict reads an admission gate
      // depends on currently prove or wedge. A wedge is reported with
      // its typed error code — the probe NEVER repairs, reindexes, or
      // weakens the fail-closed contract; admission itself still
      // wedges on the same strict reads.
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/integrity$/);
      if (m && method === "GET") {
        if (!biz || !deps.store) {
          return void json(res, 404, { error: "INTEGRITY_DISABLED" });
        }
        ownedObjective(m[1]!); // owner proof
        const checks: Array<Record<string, unknown>> = [];
        const probe = (name: string, fn: () => unknown) => {
          try {
            const out = fn();
            checks.push({ name, ok: true, result: out });
          } catch (e) {
            const err = e as { code?: string; message?: string };
            checks.push({
              name, ok: false,
              code: err.code ?? "ERROR",
              detail: String(err.message ?? e).slice(0, 300),
            });
          }
        };
        const probeOid = m[1]!;
        const rels = relationSvc();
        probe("relation_admission_view", () => rels.admissionView(probeOid));
        probe("relation_rows", () => rels.relationsFor(probeOid).length);
        probe("duty_rows", () => dutySvc().dutiesForObjective(probeOid).length);
        probe("objective_row", () => biz!.objectives.get(probeOid).status);
        const wedged = checks.filter((c) => c.ok === false);
        return void json(res, 200, {
          objective_id: m[1],
          status: wedged.length ? "WEDGED" : "CLEAN",
          checks,
          // Honest contract note: this is observability, not repair.
          remediation: wedged.length
            ? "Canonical strict reads wedge fail-closed; recovery requires the documented corruption-remediation procedure — no automatic repair exists."
            : null,
        });
      }
      // ----- P15.9-A1 — Company Cockpit canonical read projections ----
      // READ-ONLY: selective fields composed through existing strict
      // reads. Same owner-scope contract as auto-policy/kpi-verification:
      // actor is derived from x-operator-id (never a body field), and the
      // projection serves only owner_authority_id matches — foreign
      // objectives/businesses fail closed. MC token remains the transport
      // credential; no new authorization mechanism is claimed here.
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/cockpit$/);
      if (method === "GET" && m) {
        if (!biz || !wf || !deps.store) {
          return void json(res, 404, { error: "COCKPIT_DISABLED" });
        }
        const cockpitActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        cockpitSvc ??= new ObjectiveCockpitService({
          store: deps.store,
          business: biz,
          workforce: wf,
          objectives: biz.objectives,
          workstreams: new ObjectiveWorkstreamService({
            store: deps.store, business: biz, workforce: wf,
            objectives: biz.objectives,
          }),
          autoPolicy: autoPolicySvc ??= new ObjectiveAutoPolicyService(
            deps.store, biz.objectives),
          autoDriver: deps.autoDriver,
          artifacts: deps.artifacts,
        });
        return void json(res, 200, {
          cockpit: cockpitSvc.objectiveCockpit(m[1]!, cockpitActor),
        });
      }
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/reviews$/);
      if (method === "GET" && m) {
        if (!biz || !wf || !deps.store) {
          return void json(res, 404, { error: "COCKPIT_DISABLED" });
        }
        const reviewsActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        cockpitSvc ??= new ObjectiveCockpitService({
          store: deps.store,
          business: biz,
          workforce: wf,
          objectives: biz.objectives,
          workstreams: new ObjectiveWorkstreamService({
            store: deps.store, business: biz, workforce: wf,
            objectives: biz.objectives,
          }),
          autoPolicy: autoPolicySvc ??= new ObjectiveAutoPolicyService(
            deps.store, biz.objectives),
          autoDriver: deps.autoDriver,
          artifacts: deps.artifacts,
        });
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam === null ? 50 : Number(limitParam);
        if (!Number.isFinite(limit) || limit < 1) {
          return void json(res, 400, { error: "FAIL_CLOSED_COCKPIT_LIMIT" });
        }
        return void json(res, 200,
          cockpitSvc.objectiveReviews(m[1]!, reviewsActor, limit));
      }
      // ----- P15.10-A2 — owner review sign-off (accept ACHIEVED) -----
      // The ONE mutation seam that lets the objective owner accept a
      // TARGET_MET_CANDIDATE review. All authority/pin/active-work
      // validation lives in ObjectiveReviewSignoffService; the route
      // only binds the operator actor. "request_changes" is NOT
      // implemented — no owner feedback seam exists yet.
      m = p.match(/^\/api\/vnext\/objectives\/([^/]+)\/review-signoff$/);
      if (method === "POST" && m) {
        if (!biz || !wf || !deps.store) {
          return void json(res, 404, { error: "OPERATING_LOOP_DISABLED" });
        }
        const signoffActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        // R1-F2 — strict request schema BEFORE any coercion: wrong JSON
        // types (arrays/objects/numbers) are a typed 400 client error
        // with zero mutation — String(body.action) must never turn
        // ["accept"] into "accept".
        for (const [f, v] of [
          ["action", body.action],
          ["review_id", body.review_id],
          ["idempotency_key", body.idempotency_key],
        ] as const) {
          if (typeof v !== "string" || !v.trim()) {
            return void json(res, 400, {
              error: "FAIL_CLOSED_REVIEW_SIGNOFF_REQUEST",
              detail: `${f} must be a non-empty string`,
            });
          }
        }
        if (
          body.reason !== undefined && body.reason !== null &&
          typeof body.reason !== "string"
        ) {
          return void json(res, 400, {
            error: "FAIL_CLOSED_REVIEW_SIGNOFF_REQUEST",
            detail: "reason must be a string when present",
          });
        }
        const signoffSvc = new ObjectiveReviewSignoffService({
          store: deps.store,
          objectives: biz.objectives,
          reviewDeps: {
            store: deps.store,
            business: biz,
            workforce: wf,
            objectives: biz.objectives,
            workstreams: new ObjectiveWorkstreamService({
              store: deps.store, business: biz, workforce: wf,
              objectives: biz.objectives,
            }),
          },
        });
        return void json(res, 200, {
          signoff: signoffSvc.signoff(m[1]!, {
            actor: signoffActor,
            action: body.action as string,
            review_id: body.review_id as string,
            idempotency_key: body.idempotency_key as string,
            reason: body.reason === undefined || body.reason === null
              ? undefined : (body.reason as string),
          }),
        });
      }
      m = p.match(/^\/api\/vnext\/businesses\/([^/]+)\/company$/);
      if (method === "GET" && m) {
        if (!biz || !wf || !deps.store) {
          return void json(res, 404, { error: "COCKPIT_DISABLED" });
        }
        const companyActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        cockpitSvc ??= new ObjectiveCockpitService({
          store: deps.store,
          business: biz,
          workforce: wf,
          objectives: biz.objectives,
          workstreams: new ObjectiveWorkstreamService({
            store: deps.store, business: biz, workforce: wf,
            objectives: biz.objectives,
          }),
          autoPolicy: autoPolicySvc ??= new ObjectiveAutoPolicyService(
            deps.store, biz.objectives),
          autoDriver: deps.autoDriver,
          artifacts: deps.artifacts,
        });
        return void json(res, 200, {
          company: cockpitSvc.businessCompany(m[1]!, companyActor),
        });
      }
      // ----- P18-B — business portfolio over canonical relations ----
      // READ-ONLY advisory projection (same owner-scope contract as
      // /company): the actor's owned objectives annotated with the
      // proven relation graph + derived dependency state. It never
      // gates admission/scheduling — P18-C consumes the same seams.
      m = p.match(/^\/api\/vnext\/businesses\/([^/]+)\/portfolio$/);
      if (method === "GET" && m) {
        if (!biz || !wf || !deps.store) {
          return void json(res, 404, { error: "PORTFOLIO_DISABLED" });
        }
        const portfolioActor = canonicalOperatorActor(req.headers["x-operator-id"], p);
        portfolioSvc ??= new ObjectivePortfolioService({
          store: deps.store,
          objectives: biz.objectives,
          relations: new ObjectiveRelationService(deps.store),
        });
        // No read-budget wrap — deliberately identical availability
        // bounds to /company, whose scope proof makes the same org-wide
        // strict enumeration. The scheduler's {1024,512} budget is
        // calibrated for per-objective reads in autonomous loops; here
        // it would trip at a fraction of the intended bound (org-wide
        // multiplicative charging) with no matching safety gain —
        // every loop in this projection is progression-bounded and a
        // corrupt row already fails closed loudly, so work is O(org
        // size), never pathological.
        return void json(res, 200, {
          portfolio: portfolioSvc.businessPortfolio(m[1]!, portfolioActor),
        });
      }
      if (method === "GET" && p === "/api/budgets") {
        const bid = url.searchParams.get("business_id") ?? undefined;
        return void json(res, 200, { budgets: biz ? biz.listBudgetPolicies(bid) : [] });
      }
      if (method === "POST" && p === "/api/budgets") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.createBudgetPolicy({
          business_id: String(body.business_id ?? ""),
          scope_type: String(body.scope_type ?? "") as never,
          scope_id: String(body.scope_id ?? "") || undefined,
          period: String(body.period ?? "DAY") as never,
          max_missions: Number(body.max_missions ?? 0),
          hard_stop: body.hard_stop !== false,
          operator_id: operatorRef(operator, p),
        }));
      }
      // ----- P15.8-D — conversation layer (Chat + governed drafts) -----
      // Every route delegates to the canonical services; the handler
      // never writes store rows directly. Operator identity comes ONLY
      // from the trusted request boundary (`x-operator-id`, falling back
      // to body.operator_id per the existing model) — never from a
      // caller-chosen session owner field.
      if (p === "/api/conversations" || p.startsWith("/api/conversations/")) {
        const conv = deps.conversation;
        if (!conv) return void json(res, 404, { error: "CONVERSATION_DISABLED" });
        // ----- P16-D — verified read-grant management -------------------
        // Matched BEFORE the session-id routes (`/api/conversations/<id>`
        // would otherwise swallow `/api/conversations/read-grants`). The
        // uniform POST operator-id gate above still applies (every admin
        // call carries an x-operator-id like the conversation turns do —
        // its VALUE is unused on the admin lane). Authority is the
        // credential class itself: adminBearer ⇒ actor "admin" (may
        // delegate any declared scope); otherwise the MC-token operator
        // claim ⇒ `operator:<id>` (may vouch only its own
        // canonically-provable scope — enforced in the service).
        if (p === "/api/conversations/read-grants" || p.startsWith("/api/conversations/read-grants/")) {
          const grants = conv.readGrants;
          if (!grants) return void json(res, 404, { error: "CONVERSATION_READ_GRANTS_DISABLED" });
          const actor_kind = adminBearer ? "admin" : "operator";
          const actor = adminBearer
            ? "admin"
            : operator === undefined ? undefined : canonicalOperatorActor(operator, p);
          if (actor === undefined) {
            throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", p);
          }
          if (method === "POST" && p === "/api/conversations/read-grants") {
            const scope = body.scope as Record<string, unknown> | undefined;
            const minted = grants.grant({
              actor,
              actor_kind,
              principal_ref: String(body.principal_ref ?? ""),
              operator_ref: String(body.operator_ref ?? ""),
              scope: {
                objective_ids: Array.isArray(scope?.objective_ids) ? scope.objective_ids.map(String) : [],
                business_ids: Array.isArray(scope?.business_ids) ? scope.business_ids.map(String) : [],
                own_footprint: scope?.own_footprint === true,
              },
              expires_at: Number(body.expires_at),
              idempotency_key: body.idempotency_key === undefined ? undefined : String(body.idempotency_key),
            });
            return void json(res, 200, minted);
          }
          m = p.match(/^\/api\/conversations\/read-grants\/([^/]+)\/(disable|revoke)$/);
          if (method === "POST" && m) {
            return void json(res, 200, grants.control(m[1]!, {
              actor,
              actor_kind,
              action: m[2] as "disable" | "revoke",
            }));
          }
          // Status: admin sees everything; an operator claim sees only
          // grants it minted or that vouch its own operator_ref (no
          // cross-principal enumeration, no existence leak).
          const visible = <T extends { granted_by: string; operator_ref: string }>(rows: T[]) =>
            actor_kind === "admin" ? rows : rows.filter((g) => g.granted_by === actor || g.operator_ref === actor);
          m = p.match(/^\/api\/conversations\/read-grants\/([^/]+)$/);
          if (method === "GET" && m) {
            return void json(res, 200, { grants: visible(grants.status({ grant_id: m[1]! })) });
          }
          if (method === "GET" && p === "/api/conversations/read-grants") {
            const pref = url.searchParams.get("principal_ref");
            return void json(res, 200, { grants: visible(grants.status({ principal_ref: pref ?? undefined })) });
          }
          return void json(res, 404, { error: "NOT_FOUND", path: p });
        }
        if (!operator) {
          throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", p);
        }
        if (method === "GET" && p === "/api/conversations") {
          const state = url.searchParams.get("state");
          return void json(res, 200, {
            sessions: conv.sessions.listSessions({
              operator_id: operator,
              state: (state as never) ?? null,
            }),
          });
        }
        if (method === "POST" && p === "/api/conversations") {
          return void json(res, 200, {
            session: conv.sessions.createSession({
              owner_operator_id: operator,
              title: body.title === undefined ? undefined : String(body.title),
              client_request_id: body.client_request_id === undefined
                ? undefined : String(body.client_request_id),
              correlation_id: body.correlation_id === undefined
                ? undefined : String(body.correlation_id),
            }),
          });
        }
        m = p.match(/^\/api\/conversations\/([^/]+)$/);
        if (method === "GET" && m) {
          return void json(res, 200, {
            session: conv.sessions.getSession(m[1]!, operator),
          });
        }
        m = p.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        if (method === "GET" && m) {
          const afterSeq = url.searchParams.get("after_seq");
          const limit = url.searchParams.get("limit");
          return void json(res, 200, conv.sessions.listMessages(m[1]!, {
            operator_id: operator,
            after_seq: afterSeq === null ? null : Number(afterSeq),
            limit: limit === null ? null : Number(limit),
          }));
        }
        m = p.match(/^\/api\/conversations\/([^/]+)\/turns$/);
        if (method === "POST" && m) {
          if (!conv.reasoning) {
            return void json(res, 404, { error: "CONVERSATION_REASONING_DISABLED" });
          }
          const out = await conv.reasoning.turn({
            session_id: m[1]!,
            operator_id: operator,
            // Phase 1 — the verified principal for the status hook. Only
            // the credential class minted at THIS boundary can produce
            // "admin"; `x-operator-id` is a claimed identity used for
            // session ownership/scoping, never for privilege.
            principal: {
              kind: adminBearer ? "admin" : "operator",
              operator_id: operator,
            },
            // F2/F3 + R3 — read_only separates read-query purpose from
            // mission-creation purpose. It is set when (a) the request
            // is authenticated ONLY by the admin credential (status-read
            // authority — it can never materialize a draft or any other
            // write), or (b) the caller explicitly declares
            // `read_only: true` in the request contract. The declared
            // flag can only NARROW the caller's own authority — it can
            // never widen it (OR-ed, never substituted for credential
            // checks). (A caller who also presents the MC token keeps
            // the normal proposal flow when it does not opt out.)
            read_only:
              (adminBearer && !mcAuthenticated) ||
              body.read_only === true,
            body: String(body.body ?? ""),
            idempotency_key: body.idempotency_key === undefined
              ? undefined : String(body.idempotency_key),
            correlation_id: body.correlation_id === undefined
              ? undefined : String(body.correlation_id),
          });
          // P15.8-F — a model proposal is materialized HERE, never inside
          // the reasoning service: deterministic project resolution then
          // the canonical MissionDraftService mints the draft. Bound to
          // the operator message id → a replayed turn converges onto the
          // same draft; ambiguous/no project mints nothing. R1: the
          // durable proposal replays too — a crash before the first
          // materialization is recovered by the idempotent mint below.
          if (out.proposal && conv.drafts) {
            const projRes = resolveProposalProject(deps.store!);
            if (projRes.kind === "resolved") {
              try {
                const draft = conv.drafts.createDraft({
                  session_id: m[1]!,
                  operator_id: operator,
                  project_id: projRes.project_id,
                  goal: out.proposal.goal,
                  client_request_id: `proposal:${out.message.message_id}`,
                });
                return void json(res, 200, {
                  ...out,
                  proposal: { goal: out.proposal.goal, draft },
                });
              } catch (e) {
                // A proposal that cannot mint a canonical draft is
                // surfaced honestly — still zero missions.
                return void json(res, 200, {
                  ...out,
                  proposal: {
                    goal: out.proposal.goal,
                    rejected: e instanceof IntegrityError ? e.code : "ERROR",
                  },
                });
              }
            }
            return void json(res, 200, {
              ...out,
              proposal: { goal: out.proposal.goal, project_candidates: projRes.candidates },
            });
          }
          return void json(res, 200, out);
        }
        m = p.match(/^\/api\/conversations\/([^/]+)\/close$/);
        if (method === "POST" && m) {
          return void json(res, 200, {
            session: conv.sessions.closeSession(m[1]!, {
              operator_id: operator,
              correlation_id: body.correlation_id === undefined
                ? undefined : String(body.correlation_id),
            }),
          });
        }
        // ---- governed mission drafts (P15.8-C bridge; the ONLY
        //      conversation→mission path — Task Entry is untouched) ----
        m = p.match(/^\/api\/conversations\/([^/]+)\/drafts$/);
        if (m) {
          if (!conv.drafts) {
            return void json(res, 404, { error: "CONVERSATION_DRAFTS_DISABLED" });
          }
          if (method === "GET") {
            const state = url.searchParams.get("state");
            return void json(res, 200, {
              drafts: conv.drafts.listDrafts({
                session_id: m[1]!, operator_id: operator,
                state: state ?? undefined,
              }),
            });
          }
          if (method === "POST") {
            return void json(res, 200, {
              draft: conv.drafts.createDraft({
                session_id: m[1]!, operator_id: operator,
                project_id: String(body.project_id ?? ""),
                goal: String(body.goal ?? ""),
                // Pass-through, never coerced — the canonical validator
                // owns list/risk semantics (same contract as vnext).
                granted_permissions: body.granted_permissions as string[] | undefined,
                authorized_workspaces: body.authorized_workspaces as string[] | undefined,
                risk_ceiling: body.risk_ceiling === undefined ? undefined : String(body.risk_ceiling),
                client_request_id: body.client_request_id === undefined
                  ? undefined : String(body.client_request_id),
                supersedes_draft_id: body.supersedes_draft_id === undefined
                  ? undefined : String(body.supersedes_draft_id),
                correlation_id: body.correlation_id === undefined
                  ? undefined : String(body.correlation_id),
              }),
            });
          }
        }
        m = p.match(/^\/api\/conversations\/([^/]+)\/drafts\/([^/]+)$/);
        if (method === "GET" && m) {
          if (!conv.drafts) {
            return void json(res, 404, { error: "CONVERSATION_DRAFTS_DISABLED" });
          }
          return void json(res, 200, {
            draft: conv.drafts.getDraft({
              session_id: m[1]!, operator_id: operator, draft_id: m[2]!,
            }),
          });
        }
        m = p.match(/^\/api\/conversations\/([^/]+)\/drafts\/([^/]+)\/(confirm|reject)$/);
        if (method === "POST" && m) {
          if (!conv.drafts) {
            return void json(res, 404, { error: "CONVERSATION_DRAFTS_DISABLED" });
          }
          if (m[3] === "reject") {
            return void json(res, 200, {
              draft: conv.drafts.rejectDraft({
                session_id: m[1]!, operator_id: operator, draft_id: m[2]!,
                correlation_id: body.correlation_id === undefined
                  ? undefined : String(body.correlation_id),
              }),
            });
          }
          // Confirm binds the EXACT draft identity + digest the operator
          // was shown — never a re-resolved "latest" proposal.
          const out = await conv.drafts.confirmDraft({
            session_id: m[1]!, operator_id: operator, draft_id: m[2]!,
            expected_digest: String(body.expected_digest ?? body.draft_digest ?? ""),
            kind: body.kind === undefined ? undefined : String(body.kind),
          });
          return void json(res, 200, out);
        }
        return void json(res, 404, { error: "NOT_FOUND", path: p });
      }
      // ---- Telegram conversation ingress (P15.8-E) ------------------
      // The bridge forwards each update to ONE endpoint; ALL authority
      // decisions live in TelegramConversationService against the
      // canonical conversation/draft services. The boundary operator
      // must equal `telegram:<chat_id>` — the service re-enforces it.
      if (p === "/api/telegram/conversation" || p.startsWith("/api/telegram/conversation/")) {
        const tg = deps.conversation?.telegram;
        if (!tg) {
          return void json(res, 404, { error: "TELEGRAM_CONVERSATION_DISABLED" });
        }
        if (!operator) {
          throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", p);
        }
        const chatId = String(body.chat_id ?? url.searchParams.get("chat_id") ?? "");
        if (method === "POST" && p === "/api/telegram/conversation/ingress") {
          return void json(res, 200, await tg.ingress({
            operator_id: operator,
            chat_id: chatId,
            chat_type: body.chat_type === undefined ? undefined : String(body.chat_type),
            update_id: Number(body.update_id),
            text: String(body.text ?? ""),
            reply_to_message_id: body.reply_to_message_id === undefined
              ? undefined : Number(body.reply_to_message_id),
          }));
        }
        if (method === "POST" && p === "/api/telegram/conversation/new") {
          // update_id binds the rotation to Telegram's update identity —
          // a replayed /new update converges onto the recorded session.
          return void json(res, 200, tg.newChatSession({
            operator_id: operator, chat_id: chatId,
            update_id: Number(body.update_id),
          }));
        }
        if (method === "GET" && p === "/api/telegram/conversation/pending") {
          return void json(res, 200, {
            drafts: tg.listPending({ operator_id: operator, chat_id: chatId }),
          });
        }
        if (method === "POST" && p === "/api/telegram/conversation/draft") {
          return void json(res, 200, tg.prepareDraft({
            operator_id: operator,
            chat_id: chatId,
            project_id: String(body.project_id ?? ""),
            goal: String(body.goal ?? ""),
            update_id: Number(body.update_id),
            granted_permissions: body.granted_permissions as string[] | undefined,
            authorized_workspaces: body.authorized_workspaces as string[] | undefined,
            risk_ceiling: body.risk_ceiling === undefined ? undefined : String(body.risk_ceiling),
          }));
        }
        m = p.match(/^\/api\/telegram\/conversation\/refs\/([^/]+)\/(prompt-sent|confirm|reject)$/);
        if (method === "POST" && m) {
          if (m[2] === "prompt-sent") {
            return void json(res, 200, {
              ref: tg.bindPromptMessage({
                operator_id: operator, chat_id: chatId, ref_id: m[1]!,
                message_id: Number(body.message_id),
              }),
            });
          }
          if (m[2] === "reject") {
            return void json(res, 200, {
              draft: tg.rejectByRef({
                operator_id: operator, chat_id: chatId, ref_id: m[1]!,
              }),
            });
          }
          return void json(res, 200, await tg.confirmByRef({
            operator_id: operator,
            chat_id: chatId,
            chat_type: body.chat_type === undefined ? undefined : String(body.chat_type),
            ref_id: m[1]!,
            kind: "explicit",
          }));
        }
        return void json(res, 404, { error: "NOT_FOUND", path: p });
      }
      json(res, 404, { error: "NOT_FOUND", path: p });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const status =
        e.code === "FAIL_CLOSED_OPERATOR_ID_REQUIRED" ||
        e.code === "FAIL_CLOSED_POLICY_FORBIDDEN" ||
        e.code === "FAIL_CLOSED_POLICY_OWNER" ||
        e.code === "FAIL_CLOSED_COCKPIT_AUTHORITY" ||
        e.code === "FAIL_CLOSED_OBJECTIVE_AUTHORITY" ||
        e.code === "FAIL_CLOSED_OBJECTIVE_UNVERIFIED" ||
        e.code === "FAIL_CLOSED_OBJECTIVE_SCOPE" ||
        e.code === "FAIL_CLOSED_BRAIN_AUTHORITY" ||
        e.code === "FAIL_CLOSED_BRAIN_SCOPE" ||
        e.code === "FAIL_CLOSED_CONVERSATION_READ_GRANT_AUTHORITY" ||
        e.code === "FAIL_CLOSED_COMPANY_SCOPE" ||
        e.code === "FAIL_CLOSED_PORTFOLIO_SCOPE" ||
        e.code === "FAIL_CLOSED_RELATION_AUTHORITY" ||
        e.code === "FAIL_CLOSED_RELATION_BUSINESS" ||
        e.code === "FAIL_CLOSED_DUTY_AUTHORITY" ||
        e.code === "FAIL_CLOSED_DUTY_BUSINESS" ? 403
        : e.code === "NOT_FOUND" ? 404
        : e.code?.startsWith("FAIL_CLOSED") ? 409
        : 500;
      /* 403 responses carry the CODE only — authority-check messages
         name the real owner/business ids ("actor X is not owner Y"),
         and echoing them to a denied foreign caller would disclose
         canonical scope internals (R2 M4′). The code is sufficient for
         the UI's fail-closed handling. */
      json(res, status, status === 403
        ? { error: e.code ?? "ERROR" }
        : { error: e.code ?? "ERROR", detail: String(e.message ?? error) });
    }
  });
}
