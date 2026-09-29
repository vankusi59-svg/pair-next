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
import { IntegrityError, PolicyError } from "./errors.js";
import type { MissionControl } from "./mission-control.js";
import type { CredentialBroker } from "./credential-broker.js";
import type { BusinessLayer } from "./business.js";

export interface MissionControlServerDeps {
  control: MissionControl;
  /** Serve a built SPA (e.g. apps/mission-control-ui/dist) for non-/api GETs. */
  staticDir?: string;
  /**
   * Optional plan-expansion seam (P-UI-6): runs at the API edge before
   * previewMission/startMission, e.g. an LLM planner that fills
   * metadata.llm_plan. Proposal-only — the injected planner still validates
   * and the confirm digest still gates submission. Absent → no expansion.
   */
  planExpander?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /**
   * Optional bearer token gate: when set, every `/api/*` request must carry
   * `Authorization: Bearer <token>` (or `?token=` for SSE EventSource, which
   * cannot send headers). Static SPA assets stay public so the UI can load
   * and ask for the token. Unset → no gate (local dev default).
   */
  authToken?: string;
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
  /** Optional business layer: companies → org agents → work items →
   *  routines → budgets, all dispatching through startMission. */
  business?: BusinessLayer;
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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function createMissionControlServer(
  deps: MissionControlServerDeps,
): http.Server {
  const c = deps.control;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";
    const body = method === "POST" ? await readBody(req) : {};
    // POST /api/outbox and /api/broker/fetch carry their own narrow tokens —
    // exempt from the MC gate.
    const isOutboxUpload = method === "POST" && p === "/api/outbox";
    const isBrokerFetch = method === "POST" && p === "/api/broker/fetch";
    if (deps.authToken && p.startsWith("/api/") && !isOutboxUpload && !isBrokerFetch) {
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const q = url.searchParams.get("token") ?? "";
      if (bearer !== deps.authToken && q !== deps.authToken) {
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
        return void json(res, 200, { ok: true, path: dest, bytes: buf.length });
      }

      // Broker fetch: remote executor releases a named credential. The
      // broker token is TRANSPORT auth only — P13 §25 additionally requires
      // a valid mission+task binding, a mission-pinned grant, the current
      // secret_policy, business isolation, scope, P12 executor check, and
      // a vault value. Every denial audits with its reason; the value
      // travels only in this response.
      if (isBrokerFetch) {
        if (!deps.broker || !deps.brokerToken || String(req.headers["x-broker-token"] ?? "") !== deps.brokerToken) {
          return void json(res, 403, { error: "UNAUTHORIZED_BROKER_TOKEN" });
        }
        const missionId = String(body.mission_id ?? "");
        const taskId = String(body.task_id ?? "");
        const credentialName = String(body.credential_name ?? "");
        const authz = c.authorizeCredentialFetch(missionId, taskId, credentialName);
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
      if (method === "GET" && p === "/api/recovery") return void json(res, 200, c.recovery());
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
      // P13 governance mutations — operator + CAS + audited, metadata only.
      if (method === "POST" && p === "/api/cost-policies") {
        return void json(res, 200, c.upsertCostPolicy(body, `operator:${operator}`));
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
            `operator:${operator}`,
            Number(expected_version),
          ),
        );
      }
      if (method === "POST" && p === "/api/cost-profiles") {
        return void json(res, 200, c.upsertCostProfile(body, `operator:${operator}`));
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
          c.updateCostProfile(profilePayload, `operator:${operator}`, Number(expected_version)),
        );
      }
      if (method === "POST" && p === "/api/secret-policies") {
        return void json(res, 200, c.createSecretPolicy(body, `operator:${operator}`));
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
            `operator:${operator}`,
          ),
        );
      }
      if (method === "POST" && p === "/api/secret-policies/revoke") {
        return void json(
          res,
          200,
          c.revokeSecretPolicy(String(body.policy_id ?? ""), `operator:${operator}`),
        );
      }
      // §4.3 two-step submit: preview creates no state; confirm must carry
      // the exact plan digest the operator saw.
      if (method === "POST" && p === "/api/missions/preview") {
        const expanded = deps.planExpander ? await deps.planExpander(body) : body;
        return void json(res, 200, c.previewMission(expanded as Parameters<typeof c.previewMission>[0]));
      }
      if (method === "POST" && p === "/api/missions") {
        // Direct submitters (Telegram bridge, API clients, scripts) never
        // call /preview — expand the goal into an LLM plan here so every
        // submit path gets the same plan quality as the UI's Plan & run.
        // When the caller already supplies metadata.llm_plan (UI two-step)
        // we keep it verbatim; a caller-supplied confirm_plan.digest is still
        // validated by startMission, otherwise we pin the plan we just
        // computed.
        const bodyMeta = (body as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
        const expanded =
          deps.planExpander && !bodyMeta?.llm_plan
            ? await deps.planExpander(body as Parameters<typeof deps.planExpander>[0])
            : (body as Record<string, unknown>);
        const digestPinned =
          (expanded.confirm_plan as { digest?: string } | undefined)?.digest ??
          c.previewMission(expanded as Parameters<typeof c.previewMission>[0]).plan_digest;
        return void json(res, 200, c.startMission({ ...expanded, goal: String(expanded.goal ?? ""), project_id: String(expanded.project_id ?? ""), operator_id: operator, confirm_plan: { digest: digestPinned } } as never));
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
            ? c.approve(m[1], operator, (body.scope as Record<string, unknown>) ?? {}, String(body.reason ?? "") || undefined)
            : c.deny(m[1], operator, (body.scope as Record<string, unknown>) ?? {}, String(body.reason ?? "") || undefined);
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
          currency: String(body.currency ?? "") || undefined, operator_id: String(operator),
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
          operator_id: String(operator),
        }));
      }
      m = p.match(/^\/api\/org-agents\/([^/]+)\/(pause|resume|terminate)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const st = m[2] === "pause" ? "PAUSED" : m[2] === "resume" ? "ACTIVE" : "TERMINATED";
        return void json(res, 200, biz.setOrgAgentStatus(m[1], st, String(operator)));
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
            m[1], String(operator),
            body.policy as Record<string, unknown> | undefined,
            typeof body.expected_version === "number" ? body.expected_version : undefined,
          ));
        }
      }
      m = p.match(/^\/api\/org-agents\/([^/]+)\/contract\/(enable|disable)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.setAgentContractStatus(
          m[1], m[2] === "disable" ? "DISABLED" : "ACTIVE", String(operator)));
      }
      m = p.match(/^\/api\/org-agents\/([^/]+)\/effective-policy$/);
      if (method === "GET" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.inspectAgentPolicy(m[1]));
      }
      if (method === "GET" && p === "/api/work-items") {
        const bid = url.searchParams.get("business_id") ?? undefined;
        return void json(res, 200, { work_items: biz ? biz.listWorkItems(bid) : [] });
      }
      if (method === "POST" && p === "/api/work-items") {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.createWorkItem({
          business_id: String(body.business_id ?? ""), title: String(body.title ?? ""),
          goal: String(body.goal ?? ""), department: String(body.department ?? "") || undefined,
          assignee_agent_id: String(body.assignee_agent_id ?? "") || undefined,
          objective_id: String(body.objective_id ?? "") || undefined,
          priority: typeof body.priority === "number" ? body.priority : undefined,
          operator_id: String(operator),
        }));
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/(claim|release|comment|block|unblock|artifacts)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const [, wid, wact] = m;
        const out =
          wact === "claim" ? biz.claimWorkItem(wid, String(body.agent_id ?? ""), String(operator))
          : wact === "release" ? biz.releaseClaim(wid, String(operator), String(body.claim_token ?? "") || undefined)
          : wact === "comment" ? biz.commentOnWorkItem(wid, String(body.author ?? operator), String(body.body ?? ""))
          : wact === "block" ? biz.blockWorkItem(wid, String(body.reason ?? ""), String(operator))
          : wact === "unblock" ? biz.unblockWorkItem(wid, String(operator))
          : biz.attachWorkItemArtifact(wid, {
              name: String(body.name ?? ""), uri: String(body.uri ?? ""),
              content_type: String(body.content_type ?? "") || undefined,
            }, String(operator));
        return void json(res, 200, out);
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/(open|assign|cancel)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const [, wid, wact] = m;
        const out =
          wact === "open" ? biz.openWorkItem(wid, String(operator))
          : wact === "assign" ? biz.assignWorkItem(wid, String(body.assignee_agent_id ?? ""), String(operator))
          : biz.cancelWorkItem(wid, String(operator)); // governed cancel: live mission cancelled first, then CANCELLED
        return void json(res, 200, out);
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
          operator_id: String(operator),
        }));
      }
      m = p.match(/^\/api\/routines\/([^/]+)\/(enable|disable)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        return void json(res, 200, biz.setRoutineEnabled(m[1], m[2] === "enable", String(operator)));
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
          operator_id: String(operator),
        }));
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
          operator_id: String(operator),
        }));
      }
      json(res, 404, { error: "NOT_FOUND", path: p });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const status =
        e.code === "FAIL_CLOSED_OPERATOR_ID_REQUIRED" ? 403
        : e.code === "NOT_FOUND" ? 404
        : e.code?.startsWith("FAIL_CLOSED") ? 409
        : 500;
      json(res, status, { error: e.code ?? "ERROR", detail: String(e.message ?? error) });
    }
  });
}
