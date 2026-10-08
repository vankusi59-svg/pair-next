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
 *   PAIR_MC_TOKEN       — Mission Control bearer token. Canonical resolution
 *                         shared with the server (env > $PAIR_HOME/pair-mc-token
 *                         > generated 256-bit, chmod 600) — never a default.
 *   PAIR_MC_DIR         — state dir for allow file / COST_HALT lever
 *   PAIR_TG_ALLOW_FILE  — override allowlist path
 *   PAIR_UI_BASE        — optional UI base URL for links in notifications
 */
import fs from "node:fs";
import path from "node:path";
import {
  resolveMcToken,
  transportTelegramDelivery,
  telegramDeliveryTransportTimeoutMs,
  makeNonReentrant,
} from "../dist/pair/index.js";
// R6 §4/§7 — canonical bounded transport timeout (PAIR_TG_DELIVERY_
// TRANSPORT_TIMEOUT_MS). A send outliving it is UNKNOWN_SIDE_EFFECT —
// never definite failure, never a blind resend.
const TG_TRANSPORT_TIMEOUT_MS = telegramDeliveryTransportTimeoutMs();

const TG_TOKEN = process.env.PAIR_TG_BOT_TOKEN ?? "";
const MC_URL = (process.env.PAIR_MC_URL ?? "http://localhost:8788").replace(/\/+$/, "");
const MC_TOKEN = resolveMcToken().token;
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

// PAIR_TG_API_BASE — TEST-ONLY seam pointing the bot transport at a
// mocked Telegram API (e2e drives the real bridge against a local
// recorder). Never set it in production.
const TG_API = (process.env.PAIR_TG_API_BASE ?? `https://api.telegram.org/bot${TG_TOKEN}`).replace(/\/+$/, "");

// ---- Telegram transport ----------------------------------------------------
// Errors are classified: definite (Telegram API said no → bounded retry)
// vs unknown (network/parse died inside the call — acceptance ambiguous).
// Only governed delivery code consumes the classification; notification
// sends stay best-effort.
async function tg(method, params = {}) {
  let res;
  try {
    res = await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (e) {
    e.tgKind = "unknown";
    throw e;
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    e.tgKind = "unknown";
    throw e;
  }
  if (!res.ok || data.ok === false) {
    const e = new Error(`tg ${method}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    e.tgKind = "fail";
    throw e;
  }
  return data.result;
}

function send(chatId, text, extra = {}) {
  const s = String(text).slice(0, 4000); // telegram hard limit is 4096
  return tg("sendMessage", { chat_id: chatId, text: s, disable_web_page_preview: true, ...extra }).catch((e) =>
    console.error("send fail", chatId, String(e)),
  );
}

// Conversation replies are bounded and chunked — a model reply never
// becomes an unbounded wall of messages and never carries parse_mode.
function sendReply(chatId, text) {
  const s = String(text ?? "");
  const chunks = [];
  for (let i = 0; i < s.length && chunks.length < 3; i += 3800) {
    chunks.push(s.slice(i, i + 3800));
  }
  if (s.length > 3 * 3800) chunks[2] = chunks[2].slice(0, 3790) + "…(rút gọn)";
  return chunks.reduce((p, c) => p.then(() => send(chatId, c)), Promise.resolve());
}

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// Binary deliverable: photos go through sendPhoto (visible inline), other
// allowed files through sendDocument. Multipart upload via FormData.
// R3 — HASHED BYTES === NETWORK BYTES: governed deliveries materialize
// and digest-verify the payload ONCE upstream; the uploader builds
// FormData from THOSE bytes and NEVER re-reads filePath (the path
// stays filename/path evidence only, `name` is the manifested
// artifact's canonical filename).
async function sendFile(chatId, filePath, fileBytes, displayName) {
  const name = displayName ?? path.basename(filePath);
  const ext = path.extname(name).toLowerCase();
  const method = IMG_EXT.has(ext) ? "sendPhoto" : "sendDocument";
  const field = IMG_EXT.has(ext) ? "photo" : "document";
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (!fileBytes) {
    const e = new Error("FAIL_CLOSED_TELEGRAM_FILE_BYTES_MISSING");
    e.tgKind = "fail";
    throw e;
  }
  fd.append(field, new Blob([fileBytes]), name);
  fd.append("caption", `📎 ${name}`);
  let res;
  try {
    res = await fetch(`${TG_API}/${method}`, { method: "POST", body: fd });
  } catch (e) {
    e.tgKind = "unknown";
    throw e;
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    e.tgKind = "unknown";
    throw e;
  }
  if (!res.ok || data.ok === false) {
    const e = new Error(`tg ${method}: ${res.status} ${String(data.description ?? "").slice(0, 150)}`);
    e.tgKind = "fail";
    throw e;
  }
  return data.result;
}

// R3 §5 — governed transport: PROPAGATES failure classification instead
// of the best-effort `send()` which swallows it. Definite API failure →
// {kind:"fail"}; thrown/ambiguous acceptance → {kind:"unknown"}.
async function governedSend({ chatId, text, filePath, fileBytes, name }) {
  try {
    const result = filePath
      ? await sendFile(chatId, filePath, fileBytes, name)
      : await tg("sendMessage", {
          chat_id: chatId,
          text: String(text ?? "").slice(0, 4000),
          disable_web_page_preview: true,
        });
    // R4 §2 — a claimed success WITHOUT a real message_id is ambiguous:
    // validate response evidence here, never trust `ok` alone.
    const mid = result?.message_id;
    // R5 §4 — Bot API message_id is an Integer; only positive safe ints.
    const validId =
      typeof mid === "number" && Number.isSafeInteger(mid) && mid > 0;
    if (!validId) {
      return { kind: "unknown", error: "acceptance_unproven:no message_id" };
    }
    return { kind: "ok", message_id: mid };
  } catch (e) {
    return e?.tgKind === "fail"
      ? { kind: "fail", error: String(e).slice(0, 300) }
      : { kind: "unknown", error: String(e).slice(0, 300) };
  }
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
async function handleCommand(chatId, text, ctx = {}) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  const op = `telegram:${chatId}`;
  const updateId = ctx.updateId;
  const replyTo = ctx.replyTo ?? null;

  switch (cmd.toLowerCase()) {
    case "/start":
    case "/help":
      return send(
        chatId,
        [
          "PAIR OS — trò chuyện bằng tin nhắn thường. Mission chỉ chạy qua draft + xác nhận.",
          "",
          "/draft <project_id> <goal> — chuẩn bị mission draft (không chạy gì)",
          "/drafts — các draft đang chờ xác nhận",
          "/projects — danh sách project để chọn",
          "/new — bắt đầu phiên trò chuyện mới",
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
    // ---- P15.8-E — conversation layer commands ------------------------
    case "/new": {
      const r = await mc("POST", "/api/telegram/conversation/new", { chat_id: String(chatId) }, op);
      return send(chatId, `Phiên trò chuyện mới: ${r.session.session_id.slice(0, 14)}…`);
    }
    case "/projects": {
      const projects = await mc("GET", "/api/projects").catch(() => []);
      const xs = Array.isArray(projects) ? projects : projects.projects ?? [];
      if (!xs.length) return send(chatId, "Chưa có project canonical nào.");
      return send(
        chatId,
        "Projects:\n" + xs.map((x) => `${x.project_id} — ${trunc(x.name ?? "", 60)}`).join("\n"),
      );
    }
    case "/drafts": {
      const d = await mc("GET", `/api/telegram/conversation/pending?chat_id=${encodeURIComponent(String(chatId))}`, undefined, op);
      const list = d.drafts ?? [];
      if (!list.length) return send(chatId, "Không có draft nào đang chờ xác nhận.");
      return send(chatId, list.map((x) => `${x.draft_id}\n  goal: ${trunc(x.goal, 70)}\n  project: ${x.project_id} · hết hạn ${x.expires_at}`).join("\n\n"));
    }
    case "/draft": {
      // /draft <project_id> <goal>  — explicit draft prep (ZERO missions).
      // Reply-bound form: reply to your own message with "/draft <project_id>"
      // → the replied text becomes the goal.
      const [projArg, ...goalParts] = arg.split(/\s+/).filter(Boolean);
      const replyGoal = replyTo?.text ? String(replyTo.text).trim() : "";
      const goal = (goalParts.join(" ") || replyGoal).trim();
      if (!projArg || !goal) {
        const projects = await mc("GET", "/api/projects").catch(() => []);
        const xs = Array.isArray(projects) ? projects : projects.projects ?? [];
        return send(
          chatId,
          "Dùng: /draft <project_id> <goal>\n(hoặc reply một tin nhắn của bạn bằng /draft <project_id>)\n\nProjects:\n" +
            (xs.length ? xs.map((x) => `  ${x.project_id} — ${trunc(x.name ?? "", 50)}`).join("\n") : "  (chưa có project)"),
        );
      }
      const d = await mc("POST", "/api/telegram/conversation/draft", {
        chat_id: String(chatId),
        project_id: projArg,
        goal,
        // The update id makes a replayed /draft converge onto the same
        // draft server-side; a missing id (shouldn't happen) falls back
        // to a random — never deduped worse than before.
        update_id: updateId ?? Math.floor(Math.random() * 1e9),
      }, op);
      // The confirmation prompt — inline buttons carry ONLY the opaque
      // ref id; the full draft digest lives server-side (callback_data
      // is 64 bytes — never enough for a digest, by design).
      const prompt = await tg("sendMessage", {
        chat_id: chatId,
        text: [
          "GOVERNED MISSION DRAFT — chờ xác nhận",
          `draft: ${d.draft.draft_id}`,
          `project: ${d.draft.project_id}`,
          `goal: ${trunc(d.draft.goal, 200)}`,
          `permissions: ${(d.draft.granted_permissions ?? []).join(", ") || "—"}`,
          `workspaces: ${(d.draft.authorized_workspaces ?? []).join(", ") || "—"}`,
          `risk ceiling: ${d.draft.risk_ceiling ?? "system default"}`,
          `hết hạn: ${d.draft.expires_at}`,
          "",
          "Bấm Confirm để submit đúng draft này — hoặc reply tin nhắn này bằng \"OK\"/\"xác nhận\".",
        ].join("\n"),
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Confirm", callback_data: `c:${d.ref.ref_id}` },
            { text: "❌ Reject", callback_data: `r:${d.ref.ref_id}` },
          ]],
        },
      });
      if (prompt?.message_id) {
        await mc("POST", `/api/telegram/conversation/refs/${d.ref.ref_id}/prompt-sent`,
          { chat_id: String(chatId), message_id: prompt.message_id }, op).catch(() => {});
      }
      return;
    }
    default:
      return send(chatId, `Lệnh không hiểu: ${cmd}. /help để xem danh sách.`);
  }
}

// ---- P15.8-E — conversation ingress -----------------------------------
// Ordinary text NEVER creates a mission. Each message goes to the
// canonical ingress: deterministic classification (reply-bound ack vs
// conversation), session binding and dedup live server-side. Errors map
// to honest bounded messages — internals never leak into the chat.
const ERR_TEXT = {
  FAIL_CLOSED_TELEGRAM_CHAT_TYPE: "Chat nhóm không hỗ trợ — chỉ private chat (V1).",
  FAIL_CLOSED_TELEGRAM_REF_EXPIRED: "Draft đã hết hạn — tạo draft mới bằng /draft.",
  FAIL_CLOSED_TELEGRAM_REF_STATE: "Prompt này đã được xử lý — không còn hiệu lực.",
  FAIL_CLOSED_TELEGRAM_REF_NOT_FOUND: "Không tìm thấy quyền xác nhận tương ứng.",
  FAIL_CLOSED_TELEGRAM_REF_OWNERSHIP: "Quyền xác nhận không thuộc chat này.",
  FAIL_CLOSED_CONVERSATION_ACK_NONE: "Không có draft nào đang chờ để xác nhận.",
  FAIL_CLOSED_CONVERSATION_ACK_AMBIGUOUS: "Có nhiều hơn một draft đang chờ — dùng nút Confirm để chọn đúng draft.",
  FAIL_CLOSED_CONVERSATION_DRAFT_DIGEST: "Điều khoản draft đã thay đổi — xác nhận bị từ chối.",
  FAIL_CLOSED_CONVERSATION_DRAFT_STATE: "Draft không còn ở trạng thái chờ xác nhận.",
  FAIL_CLOSED_CONVERSATION_DRAFT_SUBMISSION_EXPIRED: "Preview đã hết hạn trước khi submit — tạo draft mới.",
};

function friendlyErr(e) {
  const s = String(e);
  for (const [code, txt] of Object.entries(ERR_TEXT)) {
    if (s.includes(code)) return txt;
  }
  return `Lỗi: ${trunc(s.replace(/https?:\/\/\S+/g, ""), 160)}`;
}

// The update being processed — set by the poll loop before dispatch so
// every downstream call (turn, draft) dedups on the stable update id.
let currentUpdateId = 0;

async function handleMessage(chatId, msg) {
  const text = String(msg?.text ?? "").trim();
  if (!text) return;
  const op = `telegram:${chatId}`;
  const chatType = msg?.chat?.type ?? "private";
  if (text.startsWith("/")) {
    return handleCommand(chatId, text, {
      updateId: currentUpdateId,
      replyTo: msg?.reply_to_message ?? null,
    });
  }
  try {
    const r = await mc("POST", "/api/telegram/conversation/ingress", {
      chat_id: String(chatId),
      chat_type: chatType,
      update_id: currentUpdateId,
      text,
      reply_to_message_id: msg?.reply_to_message?.message_id ?? undefined,
    }, op);
    if (r.kind === "ack_confirmed") {
      return send(chatId, `✅ Draft ${r.draft_id} đã xác nhận → mission ${r.mission_id}${uiLink(r.mission_id)}`);
    }
    if (r.kind === "reasoning_unavailable") {
      return send(chatId, "AI reasoning hiện không khả dụng — thử lại sau. (Mission/draft vẫn hoạt động bình thường qua /draft.)");
    }
    return sendReply(chatId, r.reply ?? "");
  } catch (e) {
    return send(chatId, friendlyErr(e));
  }
}

// callback_query — inline Confirm/Reject. callback_data = c:<ref> |
// r:<ref>; the ref resolves to the FULL draft digest server-side.
async function handleCallback(cb) {
  const chatId = cb?.message?.chat?.id;
  const data = String(cb?.data ?? "");
  const answer = (text) =>
    tg("answerCallbackQuery", { callback_query_id: cb.id, text: String(text).slice(0, 190) }).catch(() => {});
  if (chatId === undefined || !data) return;
  const allow = allowedChats();
  if (!allow.has(String(chatId))) {
    return answer("Không có quyền.");
  }
  const op = `telegram:${chatId}`;
  const chatType = cb?.message?.chat?.type ?? "private";
  const ref = data.slice(2);
  try {
    if (data.startsWith("c:")) {
      const r = await mc("POST", `/api/telegram/conversation/refs/${ref}/confirm`,
        { chat_id: String(chatId), chat_type: chatType }, op);
      // Remove the buttons — a consumed prompt can never confirm twice.
      await tg("editMessageReplyMarkup", {
        chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
      await answer("Đã xác nhận.");
      return send(chatId, `✅ Draft ${r.draft.draft_id} → mission ${r.mission_id}${uiLink(r.mission_id)}`);
    }
    if (data.startsWith("r:")) {
      await mc("POST", `/api/telegram/conversation/refs/${ref}/reject`,
        { chat_id: String(chatId) }, op);
      await tg("editMessageReplyMarkup", {
        chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
      await answer("Đã từ chối.");
      return send(chatId, "❌ Draft đã bị từ chối — không mission nào được tạo.");
    }
    return answer("callback không hiểu");
  } catch (e) {
    return answer(friendlyErr(e));
  }
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

    // Incident R2+R3 — EXPLICIT delivery authority only. The bridge
    // NEVER scans the outbox and NEVER broadcasts: it polls the
    // canonical telegram_delivery_request queue and transports each
    // manifested artifact to EXACTLY the request's bound destination
    // through the shared governed-transport module. Durable lifecycle
    // QUEUED→SENDING→SENT|FAILED|UNKNOWN_SIDE_EFFECT lives server-side;
    // no filename ".sent" mark is transport proof. The allowlist is an
    // authorization check only — a bound destination not in it → hold.
    const deliveries =
      (await mc("GET", "/api/telegram-deliveries?state=QUEUED").catch(() => ({})))?.deliveries ?? [];
    for (const req of deliveries) {
      const t = (artifact, body) =>
        mc(
          "POST",
          `/api/telegram-deliveries/${encodeURIComponent(String(req.delivery_id))}/transition`,
          { artifact: artifact ?? null, ...body },
        );
      try {
        await transportTelegramDelivery({
          request: req,
          transport: { send: governedSend },
          isAllowed: (chatId) => allowList.has(String(chatId)),
          backend: {
            // R7 §4 — exclusive acquire: the HTTP transition returns
            // {delivery, acquired, attempt_id}; ONLY acquired===true is
            // send authority — a stale projection is not.
            begin: async (a) => {
              const r = await t(a, { to: "SENDING" });
              return {
                acquired: r?.acquired === true,
                attempt_id: r?.attempt_id ?? undefined,
                reason: r?.reason ?? undefined,
              };
            },
            sent: (a, ev) => t(a, { to: "SENT", message_id: ev?.message_id ?? null }),
            failed: (a, err) => t(a, { to: "FAILED", error: err }),
            unknown: (a, err) => t(a, { to: "UNKNOWN", error: err }),
            unsendable: (reason) => t(null, { to: "UNSENDABLE", error: reason }),
          },
          readText: (p) => fs.readFileSync(p, "utf8"),
          textPrefix: "📨 ",
          timeoutMs: TG_TRANSPORT_TIMEOUT_MS,
        });
      } catch (e) {
        console.error("delivery", req.delivery_id, String(e).slice(0, 160));
      }
    }
  } catch (e) {
    console.error("notify loop:", String(e).slice(0, 200));
  }
}

// ---- main loop -----------------------------------------------------------------
async function main() {
  const me = await tg("getMe");
  // Register the slash-command menu so "/" shows available commands.
  await tg("setMyCommands", {
    commands: [
      { command: "help", description: "danh sách lệnh" },
      { command: "status", description: "tổng quan hệ thống + spend" },
      { command: "missions", description: "5 mission gần nhất" },
      { command: "approvals", description: "yêu cầu chờ duyệt" },
      { command: "approve", description: "duyệt approval" },
      { command: "deny", description: "từ chối approval" },
      { command: "halt", description: "chặn remote dispatch" },
      { command: "unhalt", description: "mở lại remote dispatch" },
      { command: "id", description: "chat id của bạn" },
      { command: "new", description: "phiên chat mới" },
      { command: "draft", description: "chuẩn bị mission draft" },
      { command: "drafts", description: "draft chờ xác nhận" },
      { command: "projects", description: "danh sách project" },
    ],
  }).catch((e) => console.error("setMyCommands:", String(e)));
  console.log(`telegram-bridge: bot @${me.username} (${me.id}) → ${MC_URL}`);
  console.log(`telegram-bridge: allow file ${ALLOW_FILE}; halt lever ${HALT_FILE}`);

  // Durable poll cursor — a restart resumes AFTER the last processed
  // update instead of replaying Telegram's 24h backlog. This is ONLY a
  // delivery cursor (bridge state dir), never mission authority; a lost
  // file still converges through server-side update-id dedup.
  const OFFSET_FILE = process.env.PAIR_TG_OFFSET_FILE ?? path.join(MC_DIR, "telegram-offset.json");
  const loadOffset = () => {
    try {
      const n = Number(JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8")).offset);
      return Number.isSafeInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  let offset = loadOffset();
  const saveOffset = () => {
    try {
      fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }) + "\n");
    } catch (e) {
      console.error("offset save:", String(e).slice(0, 120));
    }
  };
  // R6 §6 — defense-in-depth: an interval tick while the previous
  // notifyLoop is still in flight is skipped. The DURABLE SENDING lease
  // (attempt_started_at + PAIR_TG_DELIVERY_STALE_AFTER_MS) remains the
  // canonical correctness mechanism — this only prevents two poll
  // cycles racing inside this process.
  const notifyGuarded = makeNonReentrant(() => notifyLoop(allowedChats()));
  setInterval(() => void notifyGuarded(), 5000);
  for (;;) {
    let updates;
    try {
      updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
    } catch (e) {
      console.error("getUpdates:", String(e).slice(0, 200));
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates ?? []) {
      offset = Math.max(offset, u.update_id + 1);
      saveOffset();
      currentUpdateId = u.update_id;
      const cb = u.callback_query;
      if (cb) {
        try {
          await handleCallback(cb);
        } catch (e) {
          console.error("callback:", String(e).slice(0, 300));
        }
        continue;
      }
      const msg = u.message;
      const chatId = msg?.chat?.id;
      const text = msg?.text;
      if (chatId === undefined || !text) continue;
      const allow = allowedChats();
      try {
        if (!allow.size) {
          // Discovery mode — fail-closed: echo the chat id, execute nothing.
          console.log(`discovery: chat_id=${chatId} text=${trunc(text, 60)}`);
          await send(chatId, `PAIR bridge chưa có allowlist.\nchat_id của bạn: ${chatId}\nGửi id này cho admin để được cấp quyền.`);
        } else if (!allow.has(String(chatId))) {
          await send(chatId, "Bạn không có quyền điều khiển PAIR (chat_id không trong allowlist).");
        } else {
          await handleMessage(String(chatId), msg);
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
