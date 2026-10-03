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

export interface MissionControlServerDeps {
  control: MissionControl;
  /** Serve a built SPA (e.g. apps/mission-control-ui/dist) for non-/api GETs. */
  staticDir?: string;
  /**
   * Plan-proposal seam (Phase B): runs the Planner failover chain at the
   * API edge and returns { input, planner } where `input` carries the
   * winning sanitized task list (metadata.llm_plan) and `planner` is the
   * attempt/provenance evidence persisted with the durable preview.
   * Absent → deterministic template planning only.
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

export function createMissionControlServer(
  deps: MissionControlServerDeps,
): http.Server {
  const c = deps.control;
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
    if (deps.authToken && p.startsWith("/api/") && !isOutboxUpload && !isBrokerFetch && !isArtifactFetch) {
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
        // R3 §3: create-only — an existing identity fails closed; callers
        // must use the CAS /update path to change authority.
        return void json(res, 200, c.createCostPolicy(body, `operator:${operator}`));
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
        // R3 §3: create-only — an existing (ref_type, ref_id) identity
        // fails closed; callers must use the CAS /update path.
        return void json(res, 200, c.createCostProfile(body, `operator:${operator}`));
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
      // Phase B two-step submit: preview persists a durable
      // mission_plan_preview (READY); confirm consumes exactly it.
      if (method === "POST" && p === "/api/missions/preview") {
        const ex = deps.planExpander ? await deps.planExpander(body) : { input: body };
        const expanded = (ex as { input?: Record<string, unknown> }).input ?? (ex as Record<string, unknown>);
        const planner = (ex as { planner?: never }).planner;
        return void json(res, 200, c.createPlanPreview({ ...expanded, operator_id: operator } as never, planner as never));
      }
      if (method === "GET" && p.match(/^\/api\/plan-previews\/[^/]+$/)) {
        const id = p.split("/")[3];
        return void json(res, 200, c.planPreview(id));
      }
      // Explicit confirmation seam: {preview_id, plan_digest} — consumes the
      // persisted preview and mints the mission, idempotently.
      if (method === "POST" && p === "/api/missions/confirm") {
        const confirm = (body.confirm_plan ?? {}) as { preview_id?: string; digest?: string };
        const previewId = String(body.preview_id ?? confirm.preview_id ?? "");
        const planDigest = String(body.plan_digest ?? confirm.digest ?? "");
        return void json(res, 200, c.confirmPlanPreview({ preview_id: previewId, plan_digest: planDigest, operator_id: operator }));
      }
      if (method === "POST" && p === "/api/missions") {
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
          operator_id: String(operator),
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
          wact === "claim" ? biz.claimWorkItem(wid, String(body.agent_id ?? ""), String(operator))
          : wact === "release" ? biz.releaseClaim(wid, String(operator), String(body.claim_token ?? "") || undefined)
          : wact === "heartbeat" ? biz.heartbeatWorkItem(
              wid, String(body.agent_id ?? ""), String(body.claim_token ?? ""), String(operator))
          : wact === "comment" ? biz.commentOnWorkItem(wid, String(body.author ?? operator), String(body.body ?? ""))
          : wact === "block" ? biz.blockWorkItem(wid, String(body.reason ?? ""), String(operator))
          : wact === "unblock" ? biz.unblockWorkItem(wid, String(operator))
          : biz.attachWorkItemArtifact(wid, {
              name: String(body.name ?? ""), uri: String(body.uri ?? ""),
              content_type: String(body.content_type ?? "") || undefined,
            }, String(operator));
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
          m[1], String(body.agent_id ?? ""), String(operator)));
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/(open|assign|cancel|review)$/);
      if (method === "POST" && m) {
        if (!biz) return void json(res, 404, { error: "BUSINESS_LAYER_DISABLED" });
        const [, wid, wact] = m;
        const out =
          wact === "open" ? biz.openWorkItem(wid, String(operator))
          : wact === "assign" ? biz.assignWorkItem(wid, String(body.assignee_agent_id ?? ""), String(operator))
          : wact === "review" ? biz.reviewWorkItem(wid, {
              reviewer_agent_id: String(body.reviewer_agent_id ?? ""),
              decision: String(body.decision ?? ""),
            }, String(operator))
          : biz.cancelWorkItem(wid, String(operator)); // governed cancel: live mission cancelled first, then CANCELLED
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
        }, String(operator)));
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
        }, String(operator)));
      }
      m = p.match(/^\/api\/work-items\/([^/]+)\/dependencies$/);
      if (method === "PUT" && m) {
        if (!wf) return void json(res, 404, { error: "WORKFORCE_DISABLED" });
        return void json(res, 200, wf.setWorkItemDependencies(
          m[1],
          Array.isArray(body.depends_on) ? body.depends_on.map(String) : [],
          typeof body.expected_version === "number" ? body.expected_version : -1,
          String(operator),
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
