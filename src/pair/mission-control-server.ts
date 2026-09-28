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
 "Experience":"/api/experience","Self-Improvement":"/api/selfmod"};
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
 view.innerHTML=html;
}
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

      // ---- mutations (operator authority required) -------------------------
      if (method === "POST" && !operator) {
        throw new IntegrityError("FAIL_CLOSED_OPERATOR_ID_REQUIRED", p);
      }
      // §4.3 two-step submit: preview creates no state; confirm must carry
      // the exact plan digest the operator saw.
      if (method === "POST" && p === "/api/missions/preview") {
        const expanded = deps.planExpander ? await deps.planExpander(body) : body;
        return void json(res, 200, c.previewMission(expanded as Parameters<typeof c.previewMission>[0]));
      }
      if (method === "POST" && p === "/api/missions") {
        // Submit does not re-expand — the operator confirms the previewed
        // plan verbatim via metadata.llm_plan + confirm_plan.digest; the
        // digest mismatch check rejects anything altered since preview.
        return void json(res, 200, c.startMission({ ...(body as Record<string, string>), goal: String(body.goal ?? ""), project_id: String(body.project_id ?? ""), operator_id: operator } as never));
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
      if (method === "POST" && p === "/api/tick") {
        return void json(res, 200, c.tick());
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
