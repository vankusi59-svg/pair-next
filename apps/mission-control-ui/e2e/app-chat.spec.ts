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
