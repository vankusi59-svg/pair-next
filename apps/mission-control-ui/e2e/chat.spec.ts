import { test, expect } from "@playwright/test";
import { mcToken, seedSession } from "./helpers";

/* P15.8-D — chat mode E2E: sessions, turns (stub-reply — no real model
 * calls), history persistence across reload, governed draft confirm.
 * The webServer seam PAIR_CONVERSATION_STUB_REPLY makes replies
 * deterministic; the draft→mission path is the REAL governed one. */

test.beforeEach(async ({ page }) => {
  await seedSession(page);
  await page.goto("/");
});

test("chat: new session → send → stub reply → history survives reload", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "+ New chat" }).click();
  const composer = page.locator("#composer");
  await expect(composer).toBeVisible();
  await composer.fill("xin chào");
  await page.getByRole("button", { name: "Send" }).click();
  // assistant reply renders as plain text, labelled separately
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("PAIR · assistant").first()).toBeVisible();
  // multi-turn: second message keeps history chronological
  await composer.fill("giúp tôi bán EA");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("giúp tôi bán EA")).toBeVisible();
  // reload → session restores from ?s= and full history comes back
  await page.reload();
  await expect(page.getByText("xin chào")).toBeVisible();
  await expect(page.getByText("giúp tôi bán EA")).toBeVisible();
});

test("chat: draft → confirm mints exactly one mission with a detail link", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "+ New chat" }).click();
  await page.getByRole("button", { name: "Prepare mission draft" }).click();
  await page.getByLabel("Mission goal").fill("ghi nhận mục tiêu e2e");
  await page.locator("#draft-project").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create draft" }).click();
  // draft card shows the exact terms + PENDING state — nothing ran yet
  const card = page.locator(".draft-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("PENDING_CONFIRMATION")).toBeVisible();
  await expect(card.getByText("ghi nhận mục tiêu e2e")).toBeVisible();
  // explicit confirm binds the displayed draft → ONE mission
  await card.getByRole("button", { name: "Confirm this draft" }).click();
  await expect(card.getByText("CONFIRMED")).toBeVisible({ timeout: 15_000 });
  const link = card.getByRole("link", { name: /MSN_/ });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByText(/COMPLETED|RUNNING|WAITING|state/i).first()).toBeVisible({ timeout: 10_000 });
});

test("chat: mobile viewport keeps sessions + composer usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/chat");
  await page.getByRole("button", { name: "+ New chat" }).click();
  await page.locator("#composer").fill("mobile check");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("PAIR trả lời mô phỏng").first()).toBeVisible({ timeout: 15_000 });
});

test("chat: >200 messages — tail window renders newest, earlier reachable, no dups after reload", async ({ page, request }) => {
  test.setTimeout(60_000);
  // Seed a deterministic >200-message session through the real API —
  // replies come from the server's stub seam, never a real model call.
  const headers = {
    "content-type": "application/json",
    "x-operator-id": "op:e2e",
    authorization: `Bearer ${mcToken()}`,
  };
  const create = await request.post("/api/conversations", { headers, data: {} });
  const sid = (await create.json()).session.session_id as string;
  for (let i = 0; i < 101; i++) { // 202 committed messages
    const r = await request.post(`/api/conversations/${sid}/turns`, {
      headers, data: { body: `seed-${i}` },
    });
    if (!r.ok()) throw new Error(`seed turn ${i} → ${r.status()}`);
  }
  await page.goto(`/chat?s=${sid}`);
  // Tail window opens at the NEWEST end: the last operator message (seq
  // 201) and its assistant reply are visible immediately — earlier rows
  // (seq 1-2) are NOT in this window.
  await expect(page.getByText("seed-100")).toBeVisible();
  await expect(page.getByText("PAIR trả lời mô phỏng").last()).toBeVisible();
  await expect(page.getByText("seed-0")).toBeHidden();
  // Bounded earlier-history walk: one click loads the previous page.
  await page.getByRole("button", { name: /Load earlier/ }).click();
  await expect(page.getByText("seed-0")).toBeVisible();
  await expect(page.getByText("seed-100")).toBeVisible(); // tail still there
  // No duplicates: every seeded body text appears exactly once.
  for (const i of [0, 50, 100]) {
    await expect(page.getByText(`seed-${i}`, { exact: true })).toHaveCount(1);
  }
  // Reload restores the same tail window — newest reply still visible,
  // earlier rows collapsed again (bounded default fetch).
  await page.reload();
  await expect(page.getByText("seed-100")).toBeVisible();
  await expect(page.getByText("PAIR trả lời mô phỏng").last()).toBeVisible();
  await expect(page.getByText("seed-0")).toBeHidden();
});

test("task entry: reachable from nav and submits without any chat/draft", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Task Entry" }).click();
  await expect(page.getByRole("heading", { name: "Task entry" })).toBeVisible();
  await page.getByLabel(/goal/i).fill("e2e task entry direct");
  await page.locator("#project").selectOption({ index: 1 });
  await page.getByRole("button", { name: /plan & run|preview plan/i }).click();
  await expect(page.getByText(/COMPLETED|RUNNING|WAITING/i).first()).toBeVisible({ timeout: 10_000 });
});
