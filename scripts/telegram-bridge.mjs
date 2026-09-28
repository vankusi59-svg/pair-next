#!/usr/bin/env node
/**
 * PAIR Mission Control — Telegram bridge (two-way).
 *
 * Long-polls Telegram for messages, submits missions through the canonical
 * Mission Control API (auth + operator id — never bypasses the governed
 * chain), and pushes notifications back: mission state transitions and
 * pending approvals.
 *
 * Security: only whitelisted Telegram chat ids may command. The allowlist
 * lives at <PAIR_MC_DIR>/telegram-allow.json (or PAIR_TG_ALLOW_FILE). When it
 * is empty/absent the bridge runs in discovery mode — it answers every
 * message with the sender's chat_id and executes nothing (fail-closed).
 *
 * Env:
 *   PAIR_TG_BOT_TOKEN   (required) — bot token from @BotFather
 *   PAIR_MC_URL         (default http://localhost:8788)
 *   PAIR_MC_TOKEN       — Mission Control bearer token (if auth enabled)
 *   PAIR_MC_DIR         — state dir for allow file / COST_HALT lever
 *   PAIR_TG_ALLOW_FILE  — override allowlist path
 *   PAIR_UI_BASE        — optional UI base URL for links in notifications
 */
import fs from "node:fs";
import path from "node:path";

const TG_TOKEN = process.env.PAIR_TG_BOT_TOKEN ?? "";
const MC_URL = (process.env.PAIR_MC_URL ?? "http://localhost:8788").replace(/\/+$/, "");
const MC_TOKEN = process.env.PAIR_MC_TOKEN ?? "";
const MC_DIR = process.env.PAIR_MC_DIR ?? path.join(process.cwd(), ".pair-mc");
const ALLOW_FILE = process.env.PAIR_TG_ALLOW_FILE ?? path.join(MC_DIR, "telegram-allow.json");
const HALT_FILE = process.env.PAIR_COST_HALT_FILE ?? path.join(MC_DIR, "COST_HALT");
const UI_BASE = (process.env.PAIR_UI_BASE ?? "").replace(/\/+$/, "");

if (!TG_TOKEN) {
  console.error("telegram-bridge: PAIR_TG_BOT_TOKEN is required");
  process.exit(1);
}
fs.mkdirSync(path.dirname(ALLOW_FILE), { recursive: true });
fs.mkdirSync(path.dirname(HALT_FILE), { recursive: true });

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

// ---- Telegram transport ----------------------------------------------------
async function tg(method, params = {}) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`tg ${method}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

function send(chatId, text) {
  const s = String(text).slice(0, 4000); // telegram hard limit is 4096
  return tg("sendMessage", { chat_id: chatId, text: s, disable_web_page_preview: true }).catch((e) =>
    console.error("send fail", chatId, String(e)),
  );
}

// ---- Mission Control client ------------------------------------------------
async function mc(method, p, body, operator) {
  const headers = { "content-type": "application/json" };
  if (MC_TOKEN) headers.authorization = `Bearer ${MC_TOKEN}`;
  if (operator) headers["x-operator-id"] = operator;
  const res = await fetch(`${MC_URL}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`mc ${method} ${p}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// ---- allowlist --------------------------------------------------------------
function allowedChats() {
  try {
    const xs = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));
    return new Set(Array.isArray(xs) ? xs.map(String) : []);
  } catch {
    return new Set();
  }
}

const trunc = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

const uiLink = (missionId) => (UI_BASE ? `\n${UI_BASE}/missions/${missionId}` : "");

// ---- command handlers -------------------------------------------------------
async function handleCommand(chatId, text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  const op = `telegram:${chatId}`;

  switch (cmd.toLowerCase()) {
    case "/start":
    case "/help":
      return send(
        chatId,
        [
          "PAIR OS — ra lệnh bằng tin nhắn thường = tạo mission.",
          "",
          "/status — tổng quan (missions, spend, approvals)",
          "/missions — 5 mission gần nhất",
          "/approvals — yêu cầu đang chờ duyệt",
          "/approve <id> — duyệt | /deny <id> — từ chối",
          "/halt — chặn mọi dispatch remote (kill-switch)",
          "/unhalt — mở lại",
          "/id — chat id của bạn",
        ].join("\n"),
      );
    case "/id":
      return send(chatId, `chat_id: ${chatId}`);
    case "/status": {
      const [health, cost, approvals] = await Promise.all([
        mc("GET", "/api/health"),
        mc("GET", "/api/cost"),
        mc("GET", "/api/approvals"),
      ]);
      const pending = (Array.isArray(approvals) ? approvals : []).filter((a) => a.status === "PENDING").length;
      const h = health?.health ?? health ?? {};
      const execLines = Object.entries(h)
        .slice(0, 12)
        .map(([k, v]) => `${k}: ${v?.state ?? "?"}`)
        .join("\n");
      return send(
        chatId,
        [
          `Remote spend hôm nay: ${cost.remote_dispatches_today}/${cost.remote_daily_limit}${cost.cost_halt ? " — ĐANG HALT" : ""}`,
          `Schedules active: ${cost.schedules_active}`,
          `Approvals chờ duyệt: ${pending}`,
          "",
          execLines,
        ].join("\n"),
      );
    }
    case "/missions": {
      const d = await mc("GET", "/api/missions");
      const xs = (d.missions ?? []).slice(-5).reverse();
      if (!xs.length) return send(chatId, "Chưa có mission nào.");
      return send(
        chatId,
        xs
          .map(
            (m) =>
              `${m.runtime_state ?? m.status} ${m.mission_id}\n  ${trunc(m.goal, 80)}`,
          )
          .join("\n\n"),
      );
    }
    case "/approvals": {
      const a = await mc("GET", "/api/approvals");
      const pending = (Array.isArray(a) ? a : a.approvals ?? []).filter((x) => x.status === "PENDING");
      if (!pending.length) return send(chatId, "Không có approval nào đang chờ.");
      return send(
        chatId,
        pending
          .map(
            (x) =>
              `${x.approval_id}\n  ${trunc(x.requested_action ?? x.type ?? "", 40)} — ${trunc(x.reason ?? x.detail ?? "", 90)}\n  /approve ${x.approval_id}  |  /deny ${x.approval_id}`,
          )
          .join("\n\n"),
      );
    }
    case "/approve":
    case "/deny": {
      if (!arg) return send(chatId, `Cần id: ${cmd} <approval_id>`);
      const a = await mc("GET", "/api/approvals");
      const pending = (Array.isArray(a) ? a : a.approvals ?? []).filter((x) => x.status === "PENDING");
      const target = pending.find((x) => String(x.approval_id) === arg || String(x.approval_id).endsWith(arg));
      if (!target) return send(chatId, `Không thấy approval pending khớp "${arg}". /approvals để xem danh sách.`);
      const action = cmd.slice(1); // approve | deny
      await mc("POST", `/api/approvals/${target.approval_id}/${action}`, { scope: target.scope ?? {} }, op);
      return send(chatId, `${action === "approve" ? "Đã duyệt" : "Đã từ chối"} ${target.approval_id}.`);
    }
    case "/halt": {
      fs.writeFileSync(HALT_FILE, `halted by telegram ${chatId} at ${new Date().toISOString()}\n`);
      return send(chatId, "COST HALT bật — mọi dispatch remote (DEVIN) sẽ bị chặn ngay. /unhalt để mở lại.");
    }
    case "/unhalt": {
      fs.rmSync(HALT_FILE, { force: true });
      return send(chatId, "COST HALT tắt — remote dispatch hoạt động lại (trong trần ngân sách ngày).");
    }
    default:
      return send(chatId, `Lệnh không hiểu: ${cmd}. /help để xem danh sách.`);
  }
}

async function handleMessage(chatId, text) {
  const t = String(text ?? "").trim();
  if (!t) return;
  if (t.startsWith("/")) return handleCommand(chatId, t);

  // Free text = mission goal.
  const projects = await mc("GET", "/api/projects").catch(() => []);
  const projectId = projects?.[0]?.project_id ?? "";
  const d = await mc("POST", "/api/missions", { goal: t, project_id: projectId }, `telegram:${chatId}`);
  await send(chatId, `Mission tạo xong: ${d.mission_id}\n${trunc(t, 120)}${uiLink(d.mission_id)}`);
}

// ---- notification watcher ----------------------------------------------------
const lastMissionState = new Map();
const lastApprovalIds = new Set();
let seeded = false;

async function notifyLoop(allowList) {
  if (!allowList.size) return;
  try {
    const d = await mc("GET", "/api/missions");
    const cur = new Map();
    for (const m of d.missions ?? []) {
      const st = String(m.runtime_state ?? m.status ?? "");
      cur.set(String(m.mission_id), { st, goal: String(m.goal ?? "") });
    }
    const a = await mc("GET", "/api/approvals");
    const pending = (Array.isArray(a) ? a : a.approvals ?? []).filter((x) => x.status === "PENDING");
    const curApprovals = new Set(pending.map((x) => String(x.approval_id)));

    if (!seeded) {
      // Snapshot — don't spam history on bridge start.
      for (const [id, v] of cur) lastMissionState.set(id, v.st);
      for (const id of curApprovals) lastApprovalIds.add(id);
      seeded = true;
      return;
    }

    for (const [id, v] of cur) {
      const prev = lastMissionState.get(id);
      if (prev === v.st) continue;
      lastMissionState.set(id, v.st);
      if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ABORTED", "WAITING_APPROVAL"].includes(v.st)) {
        const icon = v.st === "COMPLETED" ? "✅" : v.st === "WAITING_APPROVAL" ? "⏸" : "❌";
        for (const c of allowList)
          await send(c, `${icon} Mission ${v.st}: ${id}\n${trunc(v.goal, 100)}${uiLink(id)}`);
      }
    }
    for (const id of curApprovals) {
      if (lastApprovalIds.has(id)) continue;
      lastApprovalIds.add(id);
      const x = pending.find((y) => String(y.approval_id) === id);
      for (const c of allowList)
        await send(
          c,
          `⏸ Cần duyệt: ${id}\n${trunc(x?.requested_action ?? x?.type ?? "", 40)} — ${trunc(x?.reason ?? x?.detail ?? "", 90)}\n/approve ${id}  |  /deny ${id}`,
        );
    }
  } catch (e) {
    console.error("notify loop:", String(e).slice(0, 200));
  }
}

// ---- main loop -----------------------------------------------------------------
async function main() {
  const me = await tg("getMe");
  console.log(`telegram-bridge: bot @${me.username} (${me.id}) → ${MC_URL}`);
  console.log(`telegram-bridge: allow file ${ALLOW_FILE}; halt lever ${HALT_FILE}`);

  let offset = 0;
  setInterval(() => notifyLoop(allowedChats()), 5000);
  for (;;) {
    let updates;
    try {
      updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
    } catch (e) {
      console.error("getUpdates:", String(e).slice(0, 200));
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates ?? []) {
      offset = Math.max(offset, u.update_id + 1);
      const msg = u.message;
      const chatId = msg?.chat?.id;
      const text = msg?.text;
      if (chatId === undefined || !text) continue;
      const allow = allowedChats();
      try {
        if (!allow.size) {
          // Discovery mode — fail-closed: echo the chat id, execute nothing.
          await send(chatId, `PAIR bridge chưa có allowlist.\nchat_id của bạn: ${chatId}\nGửi id này cho admin để được cấp quyền.`);
        } else if (!allow.has(String(chatId))) {
          await send(chatId, "Bạn không có quyền điều khiển PAIR (chat_id không trong allowlist).");
        } else {
          await handleMessage(String(chatId), text);
        }
      } catch (e) {
        console.error("handle:", String(e).slice(0, 300));
        await send(chatId, `Lỗi: ${trunc(String(e), 200)}`);
      }
    }
  }
}

main().catch((e) => {
  console.error("telegram-bridge fatal:", e);
  process.exit(1);
});
