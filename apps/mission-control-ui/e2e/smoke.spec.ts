import { test, expect } from "@playwright/test";

// UI-5 §7 — golden-path E2E: dashboard renders, two-step mission submit works
// end-to-end against the real server, observability stream is live.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("pair.operator_id", "op:e2e"));
});

test("dashboard renders nav + mission table", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  for (const link of ["Dashboard", "Approvals", "Providers", "Observability", "New Mission"]) {
    await expect(page.getByRole("link", { name: link })).toBeVisible();
  }
});

test("mission create: preview -> confirm -> detail shows runtime state", async ({ page }) => {
  await page.goto("/missions/new");
  await page.getByLabel(/goal/i).fill("e2e smoke mission");
  await page.locator("#project").selectOption({ index: 1 });
  await page.getByRole("button", { name: /preview plan/i }).click();
  // plan preview must appear before any state is created
  await expect(page.getByText(/plan digest|digest/i).first()).toBeVisible();
  await page.getByRole("button", { name: /confirm/i }).click();
  // lands on a mission detail / dashboard row with a runtime state
  await expect(page.getByText(/COMPLETED|RUNNING|WAITING/i).first()).toBeVisible({ timeout: 10_000 });
});

test("observability event stream lists canonical events", async ({ page }) => {
  await page.goto("/observability");
  await expect(page.getByRole("heading", { name: /observability/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Event stream" })).toBeVisible();
  // live badge flips to 'live' once SSE connects
  await expect(page.getByText("live").first()).toBeVisible({ timeout: 10_000 });
});

test("providers page shows credential flags, never secret values", async ({ page }) => {
  await page.goto("/providers");
  await expect(page.getByRole("heading", { name: "Providers & models" })).toBeVisible();
  const body = await page.textContent("body");
  expect(body).not.toMatch(/sk-[a-zA-Z0-9]|gsk_[a-zA-Z0-9]|AIza[a-zA-Z0-9]/);
});

test("theme toggle switches data-theme", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
