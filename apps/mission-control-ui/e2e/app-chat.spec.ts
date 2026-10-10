import { test, expect, type Page } from "@playwright/test";
import { mcToken, seedSession } from "./helpers";

/* P15.9-B5.4 — /app/chat E2E: conversation layer on the canonical P15.8
 * contract. Golden paths run against the REAL backend (stub-reply seam —
 * never a real model call); malformed/stale/proposal cases use LABELED
 * route interceptions so the canonical backend stays authoritative.
 * Central invariant asserted throughout: chat text never executes — only
 * the pinned-draft confirmation POST mints a mission. */

const HEADERS = () => ({
  "content-type": "application/json",
  "x-operator-id": "op:e2e",
  authorization: `Bearer ${mcToken()}`,
});

const mkSession = async (page: Page, title?: string) => {
  const r = await page.request.post("/api/conversations", {
    headers: HEADERS(),
    data: title ? { title } : {},
  });
  if (!r.ok()) throw new Error(`create session → ${r.status()}`);
  return (await r.json()).session.session_id as string;
};

const mkDraft = async (page: Page, sid: string, goal: string) => {
  const pr = await page.request.get("/api/projects", { headers: HEADERS() });
  const projects = await pr.json();
  const pid = projects[0].project_id as string;
  const r = await page.request.post(`/api/conversations/${sid}/drafts`, {
    headers: HEADERS(),
    data: { project_id: pid, goal },
  });
  if (!r.ok()) throw new Error(`create draft → ${r.status()} ${await r.text()}`);
  return (await r.json()).draft;
};

const firstProject = async (page: Page) => {
  const pr = await page.request.get("/api/projects", { headers: HEADERS() });
  return (await pr.json())[0] as { project_id: string; name?: string };
};

const countPosts = (page: Page, re: RegExp) => {
  let n = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && re.test(r.url())) n++;
  });
  return () => n;
};

const uniq = () => Math.random().toString(36).slice(2, 8);

test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

/* ---------- sessions list / create / select / deep link ---------- */

test("app-chat: list → create → select → deep-link restore, real counts", async ({ page }) => {
  const sid = await mkSession(page, `e2e-${uniq()}`);
  await page.request.post(`/api/conversations/${sid}/turns`, {
    headers: HEADERS(), data: { body: "hello-a" },
  });
  await page.goto("/app/chat");
  const nav = page.waitForURL(/\/app\/chat\?s=/);
  await page.getByRole("button", { name: "Create" }).click();
  await nav;
  // header shows REAL state + identity + count (never fabricated)
  await expect(page.locator(".chathead")).toContainText("OPEN");
  await expect(page.locator(".chathead")).toContainText("owner op:e2e");
  // deep-link restore into the seeded session shows its actual count
  await page.goto(`/app/chat?s=${sid}`);
  await expect(page.locator(".chathead")).toContainText("2 msgs"); // operator + stub reply
  await expect(page.getByText("hello-a")).toBeVisible();
  await expect(page.getByText("PAIR trả lời mô phỏng")).toBeVisible();
});

/* ---------- turn golden path + chronological roles ---------- */

test("app-chat: turn renders operator + assistant chronologically; survives reload", async ({ page }) => {
  const sid = await mkSession(page);
  await page.goto(`/app/chat?s=${sid}`);
  const composer = page.locator(".chatcomposer textarea");
  await composer.fill("msg-one");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
  await composer.fill("msg-two");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".chatmsg.operator").last()).toContainText("msg-two");
  const roles = await page.locator(".chatrole").allTextContents();
  expect(roles[0]).toBe("operator");
  expect(roles[1]).toBe("assistant");
  await page.reload();
  await expect(page.getByText("msg-one")).toBeVisible();
  await expect(page.getByText("msg-two")).toBeVisible();
});

/* ---------- single-flight: dblclick → exactly one POST ---------- */

test("app-chat: double-click Send fires exactly one turn POST, zero mission POSTs", async ({ page }) => {
  const sid = await mkSession(page);
  await page.goto(`/app/chat?s=${sid}`);
  const turns = countPosts(page, /\/conversations\/[^/]+\/turns/);
  const missions = countPosts(page, /\/api\/missions(\/|$)/);
  await page.locator(".chatcomposer textarea").fill("dbl");
  await page.getByRole("button", { name: "Send", exact: true }).dblclick();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
  expect(turns()).toBe(1);
  expect(missions()).toBe(0); // a turn NEVER executes
});

/* ---------- ambiguous turn failure: key reuse, no auto-retry ---------- */

test("app-chat: turn 500 → honest note, composer kept, retry replays SAME idempotency key", async ({ page }) => {
  const sid = await mkSession(page);
  await page.goto(`/app/chat?s=${sid}`);
  let calls = 0;
  const keys: string[] = [];
  await page.route(`**/api/conversations/${sid}/turns`, async (route) => {
    calls++;
    keys.push(String((route.request().postDataJSON() as { idempotency_key?: string }).idempotency_key));
    if (calls === 1) return route.fulfill({ status: 500, body: `{"error":"Boom"}` });
    return route.continue();
  });
  await page.locator(".chatcomposer textarea").fill("retry-me");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/outcome is unknown.*may have committed/)).toBeVisible();
  // no auto-retry fired
  await page.waitForTimeout(600);
  expect(calls).toBe(1);
  // composer text preserved for the deliberate retry
  await expect(page.locator(".chatcomposer textarea")).toHaveValue("retry-me");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
  expect(calls).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[0]).toBe(keys[1]); // SAME key replayed
});

/* ---------- CLOSED session blocks sends ---------- */

test("app-chat: close via dialog → CLOSED state, composer disabled, sends blocked", async ({ page }) => {
  const sid = await mkSession(page);
  await page.goto(`/app/chat?s=${sid}`);
  await page.getByRole("button", { name: "Close conversation" }).click();
  await page.locator(".cdlg").getByRole("button", { name: "Close conversation" }).click();
  await expect(page.locator(".chathead")).toContainText("CLOSED", { timeout: 10_000 });
  await expect(page.getByText("Conversation is CLOSED")).toBeVisible();
  await expect(page.locator(".chatcomposer textarea")).toHaveCount(0);
});

/* ---------- >200 messages: tail window, earlier, dedup, reload ---------- */

test("app-chat: >200 messages — tail, Load Earlier, dedup, reload restores tail", async ({ page }) => {
  test.setTimeout(90_000);
  const sid = await mkSession(page);
  for (let i = 0; i < 101; i++) { // 202 committed messages
    const r = await page.request.post(`/api/conversations/${sid}/turns`, {
      headers: HEADERS(), data: { body: `seed-${i}` },
    });
    if (!r.ok()) throw new Error(`seed turn ${i} → ${r.status()}`);
  }
  await page.goto(`/app/chat?s=${sid}`);
  await expect(page.getByText("seed-100")).toBeVisible();
  await expect(page.getByText("seed-0")).toBeHidden();
  await page.getByRole("button", { name: /Load earlier/ }).click();
  await expect(page.getByText("seed-0")).toBeVisible();
  await expect(page.getByText("seed-100")).toBeVisible();
  for (const i of [0, 50, 100]) {
    await expect(page.locator(".chatmsg-b").filter({ hasText: `seed-${i}` })).toHaveCount(1);
  }
  await page.reload();
  await expect(page.getByText("seed-100")).toBeVisible();
  await expect(page.getByText("seed-0")).toBeHidden();
});

/* ---------- proposal ambiguous → picker → real draft ---------- */

test("app-chat: ambiguous proposal → verified picker → draft via proposal:<mid> binding", async ({ page }) => {
  const sid = await mkSession(page);
  const proj = await firstProject(page);
  await page.goto(`/app/chat?s=${sid}`);
  // LABELED INTERCEPTION: the stub reply never proposes; inject the
  // ambiguous-proposal turn result the canonical contract returns.
  await page.route(`**/api/conversations/${sid}/turns`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { message_id: "m-prop", session_id: sid, seq: 1, role: "operator", body: "x", created_at: "t" },
        reply: { message_id: "m-rep", session_id: sid, seq: 2, role: "assistant", body: "r", created_at: "t" },
        reused: false,
        proposal: { goal: "verify candidate flow", project_candidates: [{ project_id: proj.project_id, name: proj.name ?? proj.project_id }] },
      }),
    }),
  );
  await page.locator(".chatcomposer textarea").fill("make a mission");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Proposal — choose a project")).toBeVisible();
  await expect(page.getByText(`client_request_id: proposal:m-prop`)).toBeVisible();
  await page.locator("#projsel").selectOption(proj.project_id);
  const drafts = countPosts(page, /\/conversations\/[^/]+\/drafts/);
  await page.getByRole("button", { name: /Create draft \(pending confirmation\)/ }).click();
  expect(drafts()).toBe(1);
  // canonical draft appears PENDING — still zero missions
  const card = page.locator(".draftcard", { hasText: "verify candidate flow" });
  await expect(card).toBeVisible();
  await expect(card.getByText("PENDING_CONFIRMATION")).toBeVisible();
});

/* ---------- malformed proposal candidates → blocked, honest ---------- */

test("app-chat: malformed proposal candidates → blocked note, no picker, no draft POST", async ({ page }) => {
  const sid = await mkSession(page);
  await page.goto(`/app/chat?s=${sid}`);
  await page.route(`**/api/conversations/${sid}/turns`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { message_id: "m-bad", session_id: sid, seq: 1, role: "operator", body: "x", created_at: "t" },
        reply: { message_id: "m-rep2", session_id: sid, seq: 2, role: "assistant", body: "r", created_at: "t" },
        reused: false,
        proposal: { goal: "g", project_candidates: [{}] },
      }),
    }),
  );
  const drafts = countPosts(page, /\/conversations\/[^/]+\/drafts/);
  await page.locator(".chatcomposer textarea").fill("go");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/candidates were malformed/)).toBeVisible();
  await expect(page.locator("#projsel")).toHaveCount(0);
  expect(drafts()).toBe(0);
});

/* ---------- proposal rejected → canonical reason shown ---------- */

test("app-chat: proposal rejected → canonical reason, zero drafts", async ({ page }) => {
  const sid = await mkSession(page);
  await page.goto(`/app/chat?s=${sid}`);
  await page.route(`**/api/conversations/${sid}/turns`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { message_id: "m-rej", session_id: sid, seq: 1, role: "operator", body: "x", created_at: "t" },
        reply: { message_id: "m-rep3", session_id: sid, seq: 2, role: "assistant", body: "r", created_at: "t" },
        reused: false,
        proposal: { goal: "g", rejected: "FAIL_CLOSED_X" },
      }),
    }),
  );
  await page.locator(".chatcomposer textarea").fill("go");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/rejected by the canonical contract \(FAIL_CLOSED_X\)/)).toBeVisible();
  await expect(page.getByText("Zero missions")).toBeVisible();
});

/* ---------- draft lifecycle: card fields → confirm → mission link ---------- */

test("app-chat: draft card full terms → pinned confirm → CONFIRMED + canonical mission link", async ({ page }) => {
  const sid = await mkSession(page);
  const draft = await mkDraft(page, sid, `e2e-goal-${uniq()}`);
  await page.goto(`/app/chat?s=${sid}`);
  const card = page.locator(".draftcard");
  await expect(card).toBeVisible();
  await expect(card.getByText("PENDING_CONFIRMATION")).toBeVisible();
  // exact persisted terms rendered — digest + project + goal + expiry
  await expect(card).toContainText(draft.draft_digest.slice(0, 16));
  await expect(card).toContainText(draft.project_id);
  await expect(card).toContainText(draft.goal);
  await expect(card).toContainText("expires_at");
  const confirms = countPosts(page, /\/drafts\/[^/]+\/confirm/);
  await card.getByRole("button", { name: "Confirm…" }).click();
  const dlg = page.locator(".cdlg");
  // dialog pins the EXACT digest of the displayed draft
  await expect(dlg).toContainText(draft.draft_digest);
  await expect(dlg).toContainText(draft.project_id);
  await dlg.getByRole("button", { name: "Confirm draft" }).click();
  expect(confirms()).toBe(1);
  await expect(card.getByText("CONFIRMED", { exact: true })).toBeVisible({ timeout: 15_000 });
  const link = card.getByRole("link", { name: /mission MSN_/ });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/app\/missions\/MSN_/);
});

/* ---------- reject: pinned, deduped, terminal ---------- */

test("app-chat: reject via dialog → REJECTED terminal, confirm never offered again", async ({ page }) => {
  const sid = await mkSession(page);
  await mkDraft(page, sid, `rej-${uniq()}`);
  await page.goto(`/app/chat?s=${sid}`);
  const card = page.locator(".draftcard");
  const rejects = countPosts(page, /\/drafts\/[^/]+\/reject/);
  await card.getByRole("button", { name: "Reject…" }).click();
  await page.locator(".cdlg").getByRole("button", { name: "Reject draft" }).click();
  expect(rejects()).toBe(1);
  await expect(card.getByText("REJECTED", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(card.getByRole("button", { name: "Confirm…" })).toHaveCount(0);
});

/* ---------- revision: new draft supersedes — old persists ---------- */

test("app-chat: revise mints a NEW draft (supersedes) — old stays, distinct object", async ({ page }) => {
  const sid = await mkSession(page);
  const orig = await mkDraft(page, sid, `orig-${uniq()}`);
  await page.goto(`/app/chat?s=${sid}`);
  await page.locator(".draftcard").getByRole("button", { name: /Revise/ }).click();
  const form = page.locator(".chatprop");
  await expect(form).toContainText(`Revise draft ${orig.draft_id}`);
  await expect(page.locator("#df-goal")).toHaveValue(orig.goal);
  await page.locator("#df-proj").selectOption(orig.project_id);
  await page.locator("#df-goal").fill(`${orig.goal}-v2`);
  const creates = countPosts(page, /\/conversations\/[^/]+\/drafts$/);
  await form.getByRole("button", { name: "Create draft" }).click();
  expect(creates()).toBe(1);
  await expect(page.locator(".draftcard")).toHaveCount(2);
  await expect(page.getByText("supersedes", { exact: true })).toBeVisible();
  await expect(page.getByText(orig.draft_id).first()).toBeVisible();
  await expect(page.locator(".draftcard", { hasText: `${orig.goal}-v2` })).toBeVisible();
});

/* ---------- expired / non-pending drafts never confirmable ---------- */

test("app-chat: wall-clock-expired pending draft → badge + disabled confirm, zero confirm POSTs", async ({ page }) => {
  const sid = await mkSession(page);
  const draft = await mkDraft(page, sid, `exp-${uniq()}`);
  await page.route(`**/api/conversations/${sid}/drafts`, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const expired = { ...draft, expires_at: "2000-01-01T00:00:00Z" };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ drafts: [expired] }) });
  });
  const confirms = countPosts(page, /\/drafts\/[^/]+\/confirm/);
  await page.goto(`/app/chat?s=${sid}`);
  const card = page.locator(".draftcard");
  await expect(card.getByText("EXPIRED (wall-clock)")).toBeVisible();
  // the confirm path is never even opened — the card button itself is disabled
  await expect(card.getByRole("button", { name: "Confirm…" })).toBeDisabled();
  expect(confirms()).toBe(0);
});

/* ---------- malformed collections → MALFORMED, never fake-empty ---------- */

test("app-chat: malformed payloads → MALFORMED panels, never fabricated empties", async ({ page }) => {
  const sid = await mkSession(page);
  // sessions [null]
  await page.route("**/api/conversations", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: `{"sessions":[null]}` });
  });
  await page.goto("/app/chat");
  await expect(page.getByText("MALFORMED", { exact: true })).toBeVisible();
  await expect(page.getByText("No conversations")).toHaveCount(0);
  await page.unroute("**/api/conversations");
  // messages [null]
  await page.route(`**/api/conversations/${sid}/messages*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: `{"messages":[null]}` }));
  await page.goto(`/app/chat?s=${sid}`);
  await expect(page.getByText("MALFORMED", { exact: true })).toBeVisible();
  await expect(page.getByText("Empty conversation")).toHaveCount(0);
  await page.unroute(`**/api/conversations/${sid}/messages*`);
  // drafts [null]
  await page.route(`**/api/conversations/${sid}/drafts`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: `{"drafts":[null]}` }));
  await page.goto(`/app/chat?s=${sid}`);
  await expect(page.getByText("MALFORMED", { exact: true })).toBeVisible();
  await expect(page.getByText("No drafts")).toHaveCount(0);
});

test("app-chat: canonical empty list → genuine EmptyState (no fake data)", async ({ page }) => {
  await page.route("**/api/conversations", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: `{"sessions":[]}` });
  });
  await page.goto("/app/chat");
  await expect(page.getByText("No conversations")).toBeVisible();
});

/* ---------- auth failure → visible fail-closed state, no prompt ---------- */

test("app-chat: 401 → visible Unauthorized/Forbidden error, no fabricated data", async ({ page }) => {
  await page.route("**/api/conversations", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 401, contentType: "application/json", body: `{"error":"UNAUTHORIZED","detail":"bad token"}` });
  });
  await page.goto("/app/chat");
  await expect(page.locator(".chatside").getByText("UNAUTHORIZED")).toBeVisible();
  await expect(page.locator(".chatlist")).toHaveCount(0);
});

/* ---------- session-switch isolation: late A never paints into B ---------- */

test("app-chat: switch A→B while A loads — late A response never touches B", async ({ page }) => {
  const sidA = await mkSession(page, `A-${uniq()}`);
  const titleB = `B-${uniq()}`;
  const sidB = await mkSession(page, titleB);
  await page.request.post(`/api/conversations/${sidA}/turns`, { headers: HEADERS(), data: { body: "AAA-UNIQUE" } });
  await page.request.post(`/api/conversations/${sidB}/turns`, { headers: HEADERS(), data: { body: "BBB-UNIQUE" } });
  let releaseA: (() => void) | null = null;
  await page.route(`**/api/conversations/${sidA}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise<void>((res) => { releaseA = res; });
    return route.continue();
  });
  await page.goto(`/app/chat?s=${sidA}`);
  await page.waitForTimeout(300); // A still in-flight
  await page.locator(".chatitem", { hasText: titleB }).first().click();
  await expect(page.locator(".chatmsg-b", { hasText: "BBB-UNIQUE" })).toBeVisible({ timeout: 10_000 });
  try { releaseA?.(); } catch { /* deferred route may have been aborted */ }
  await page.waitForTimeout(800); // give the late A response time to arrive
  await expect(page.getByText("AAA-UNIQUE")).toHaveCount(0);
  await expect(page.locator(".chatmsg-b", { hasText: "BBB-UNIQUE" })).toBeVisible();
});

/* ---------- confirm pinned to original session across a switch ---------- */

test("app-chat: confirm in-flight during switch → result never paints into the new session", async ({ page }) => {
  const sidA = await mkSession(page);
  const sidB = await mkSession(page);
  await mkDraft(page, sidA, `pin-${uniq()}`);
  await page.goto(`/app/chat?s=${sidA}`);
  const card = page.locator(".draftcard");
  await card.getByRole("button", { name: "Confirm…" }).click();
  let release: (() => void) | null = null;
  await page.route(`**/api/conversations/${sidA}/drafts/*/confirm`, async (route) => {
    await new Promise<void>((res) => { release = res; });
    return route.continue();
  });
  await page.locator(".cdlg").getByRole("button", { name: "Confirm draft" }).click();
  // switch while the POST is still in-flight (modal blocks sidebar clicks
  // by design — a URL/deep-link switch exercises the same guard path)
  await page.goto(`/app/chat?s=${sidB}`);
  try { release?.(); } catch { /* may already be released */ }
  await page.waitForTimeout(1200);
  // no mission link / confirmation note may appear inside session B
  await expect(page.getByRole("link", { name: /mission MSN_/ })).toHaveCount(0);
  await expect(page.getByText(/Draft confirmed/)).toHaveCount(0);
});

/* ---------- mobile ---------- */

test("app-chat: mobile viewport keeps sessions + composer usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const titleMob = `mob-${uniq()}`;
  await mkSession(page, titleMob);
  await page.goto("/app/chat");
  await page.locator(".chatitem", { hasText: titleMob }).first().click();
  await page.locator(".chatcomposer textarea").fill("mobile check");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
});

/* ---------- new-session turn key never crosses sessions ---------- */

test("app-chat: different session → fresh idempotency key", async ({ page }) => {
  const sidA = await mkSession(page);
  const sidB = await mkSession(page);
  await page.goto(`/app/chat?s=${sidA}`);
  const keys: string[] = [];
  await page.route("**/api/conversations/*/turns", async (route) => {
    keys.push(String((route.request().postDataJSON() as { idempotency_key?: string }).idempotency_key));
    return route.continue();
  });
  await page.locator(".chatcomposer textarea").fill("same text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
  await page.locator(".chatitem", { hasText: sidB }).click();
  await page.waitForURL(new RegExp(`s=${sidB}`));
  await page.locator(".chatcomposer textarea").fill("same text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]); // key never crosses sessions
});

/* ---------- R1-F1: cross-session composer + mutation isolation ---------- */

test("app-chat R1-F1: unsent composer text never crosses into another session", async ({ page }) => {
  const a = await mkSession(page);
  const b = await mkSession(page);
  await page.goto(`/app/chat?s=${a}`);
  await page.locator(".chatcomposer textarea").fill("unsent-a-text");
  await page.goto(`/app/chat?s=${b}`);
  await expect(page.locator(".chathead")).toContainText(b, { timeout: 10_000 });
  // B's composer must not display A's unsent text
  await expect(page.locator(".chatcomposer textarea")).toHaveValue("");
  // …and never sends it
  let sentBody: string | null = null;
  await page.route(`**/api/conversations/${b}/turns`, async (route) => {
    sentBody = (route.request().postDataJSON() as { body?: string }).body ?? null;
    await route.continue();
  });
  await page.locator(".chatcomposer textarea").fill("b-text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
  expect(sentBody).toBe("b-text");
});

test("app-chat R1-F1: late failing turn paints only on its own session; deliberate retry on return replays the same key", async ({ page }) => {
  const a = await mkSession(page);
  const b = await mkSession(page);
  await page.goto(`/app/chat?s=${a}`);
  let release: (() => void) | null = null;
  let calls = 0;
  const keys: string[] = [];
  await page.route(`**/api/conversations/${a}/turns`, async (route) => {
    calls++;
    keys.push(String(route.request().postDataJSON()?.idempotency_key));
    if (calls === 1) {
      await new Promise<void>((res) => { release = res; });
      return route.fulfill({ status: 500, body: `{"error":"Boom"}` });
    }
    return route.continue();
  });
  await page.locator(".chatcomposer textarea").fill("turn-a");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForTimeout(400); // turn A still in-flight
  /* SPA navigation (sidebar) keeps refs — pendingSubmit survives for the
     deliberate retry; a full reload would legitimately reset it. */
  await page.locator(".chatitem", { hasText: b }).first().click();
  await page.waitForURL(new RegExp(`s=${b}`));
  await expect(page.locator(".chathead")).toContainText(b, { timeout: 10_000 });
  try { release?.(); } catch { /* route released */ }
  await page.waitForTimeout(800); // let the late failure land
  await expect(page.locator(".warn.note")).toHaveCount(0); // no A-specific error inside B
  // Return to A — composer was cleared by policy, but the retry keeps its identity
  await page.locator(".chatitem", { hasText: a }).first().click();
  await page.waitForURL(new RegExp(`s=${a}`));
  await expect(page.locator(".chatcomposer textarea")).toHaveValue("");
  await page.locator(".chatcomposer textarea").fill("turn-a");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
  expect(calls).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[0]).toBe(keys[1]); // SAME key replayed
});

test("app-chat R1-F1: late failing confirm paints no A-specific note or dialog inside B", async ({ page }) => {
  const a = await mkSession(page);
  const b = await mkSession(page);
  await mkDraft(page, a, `cfl-${uniq()}`);
  await page.goto(`/app/chat?s=${a}`);
  await page.locator(".draftcard").getByRole("button", { name: "Confirm…" }).click();
  let release: (() => void) | null = null;
  await page.route(`**/api/conversations/${a}/drafts/*/confirm`, async (route) => {
    await new Promise<void>((res) => { release = res; });
    return route.fulfill({ status: 500, body: `{"error":"Boom"}` });
  });
  await page.locator(".cdlg").getByRole("button", { name: "Confirm draft" }).click();
  /* SPA switch while the confirm POST is in-flight — the modal blocks
     sidebar clicks by design, so drive the same code path via history
     navigation (React Router handles popstate without a reload; refs and
     guards stay live, unlike page.goto which reloads everything). */
  await page.evaluate((sid) => {
    history.pushState({}, "", `/app/chat?s=${sid}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, b);
  await expect(page.locator(".chathead")).toContainText(b, { timeout: 10_000 });
  try { release?.(); } catch { /* released */ }
  await page.waitForTimeout(900);
  await expect(page.locator(".warn.note")).toHaveCount(0);
  await expect(page.locator(".cdlg")).toHaveCount(0);
  await expect(page.getByText(/Confirmation outcome is unknown/)).toHaveCount(0);
});

/* ---------- R1-F2: proposal project binding ---------- */

test("app-chat R1-F2: new proposal resets the pick; held validation keeps Create disabled; verified pick → exactly one draft POST", async ({ page }) => {
  const sid = await mkSession(page);
  const proj = await firstProject(page);
  await page.goto(`/app/chat?s=${sid}`);
  let turn = 0;
  await page.route(`**/api/conversations/${sid}/turns`, (route) => {
    turn++;
    const msgId = `m-prop-${turn}`;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { message_id: msgId, session_id: sid, seq: turn * 2 - 1, role: "operator", body: "x", created_at: "t" },
        reply: { message_id: `${msgId}-r`, session_id: sid, seq: turn * 2, role: "assistant", body: "r", created_at: "t" },
        reused: false,
        proposal: {
          goal: `proposal-${turn}`,
          project_candidates: [{ project_id: proj.project_id, name: proj.name ?? proj.project_id }],
        },
      }),
    });
  });
  const drafts = countPosts(page, /\/conversations\/[^/]+\/drafts/);
  const createBtn = page.getByRole("button", { name: /Create draft \(pending confirmation\)/ });
  // Proposal A → pick the candidate, validation ready
  await page.locator(".chatcomposer textarea").fill("prop a");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("client_request_id: proposal:m-prop-1")).toBeVisible();
  await page.locator("#projsel").selectOption(proj.project_id);
  await expect(createBtn).toBeEnabled();
  // Register a HELD projects route BEFORE proposal B arrives — B's
  // canonical validation must not resolve until released.
  let releaseProjects: (() => void) | null = null;
  await page.route("**/api/projects", async (route) => {
    await new Promise<void>((res) => { releaseProjects = res; });
    return route.continue();
  });
  // Proposal B arrives — the previous pick MUST reset (bound to its own message)
  await page.locator(".chatcomposer textarea").fill("prop b");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("client_request_id: proposal:m-prop-2")).toBeVisible();
  // B's project validation is held → Create disabled (the select only
  // renders once canonical evidence is proven), zero POSTs
  await expect(createBtn).toBeDisabled();
  await page.waitForTimeout(400);
  expect(drafts()).toBe(0);
  // Release valid canonical evidence → select reappears with NO stale
  // pick carried over → explicit re-selection → exactly one POST
  try { releaseProjects?.(); } catch { /* released */ }
  await expect(page.locator("#projsel")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#projsel")).toHaveValue("");
  await page.locator("#projsel").selectOption(proj.project_id);
  await expect(createBtn).toBeEnabled();
  await createBtn.click();
  await expect(page.locator(".draftcard", { hasText: "proposal-2" })).toBeVisible({ timeout: 10_000 });
  expect(drafts()).toBe(1);
});

/* ---------- R1-F3: malformed 200 preserves turn idempotency ---------- */

test("app-chat R1-F3: malformed 200 on a committed turn → unverified outcome; deliberate retry replays same key, one canonical pair", async ({ page }) => {
  const sid = await mkSession(page);
  await page.goto(`/app/chat?s=${sid}`);
  let calls = 0;
  const keys: string[] = [];
  await page.route(`**/api/conversations/${sid}/turns`, async (route) => {
    calls++;
    keys.push(String(route.request().postDataJSON()?.idempotency_key));
    if (calls === 1) {
      const resp = await route.fetch(); // REAL backend commits the turn
      expect(resp.ok()).toBeTruthy();
      // Corrupt the 200 the client sees — a malformed success is NOT proof
      return route.fulfill({ response: resp, body: `{"message":null}` });
    }
    return route.continue();
  });
  await page.locator(".chatcomposer textarea").fill("f3-turn");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/could not be verified.*malformed/)).toBeVisible();
  // recoverability retained: composer + pendingSubmit kept
  await expect(page.locator(".chatcomposer textarea")).toHaveValue("f3-turn");
  // canonical reconciliation refetched — the committed pair shows in-thread
  await expect(page.locator(".chatmsg-b", { hasText: "f3-turn" })).toHaveCount(1);
  await expect(page.locator(".chatmsg-b", { hasText: "PAIR trả lời mô phỏng" })).toHaveCount(1);
  // no auto-retry was attempted
  await page.waitForTimeout(500);
  expect(calls).toBe(1);
  // deliberate retry → SAME key, never a second turn
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForTimeout(1000);
  expect(calls).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[0]).toBe(keys[1]);
  // canonical proof: exactly ONE operator+assistant pair exists
  const mr = await page.request.get(`/api/conversations/${sid}/messages?after_seq=0`, { headers: HEADERS() });
  const msgs = ((await mr.json()).messages ?? []) as { role?: string; body?: string }[];
  expect(msgs.filter((m) => m.role === "operator" && m.body === "f3-turn")).toHaveLength(1);
  expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
});
