import { test, expect } from "@playwright/test";

/* Personal Mode E2E — PAIR_PERSONAL_MODE=local (see
   playwright.personal.config.ts for the two-listener webServer env).

   What must be TRUE for the mission:
   - /app/home renders the UI-V2 dashboard with NO token prompt and NO
     operator-id prompt — the server-managed session cookie is the
     credential.
   - The browser never carries the raw MC token: no localStorage
     pair.mc_token is required and no ?token= query appears — including
     on the SSE /api/events stream.
   - The shell shows the canonical session owner, business auto-restores
     or is empty (fresh e2e DB has zero objectives → a fresh personal
     operator is minted), and Settings presents the connected state.
   - The remote ingress listener (separate port) never honors a personal
     cookie as sufficient authority — bearer is still required there. */

const PORT = process.env.PAIR_E2E_PORT ?? "8792";
const LOCAL = `http://localhost:${PORT}`;
const REMOTE = `http://localhost:${process.env.PAIR_MC_REMOTE_PORT ?? "8793"}`;

test.describe("personal mode — local session lane", () => {
  test("dashboard renders with zero credential prompts", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto("/app/home");
    // The shell chrome renders — proof the session cookie satisfied the
    // API gate (no session ⇒ these routes render nothing).
    await expect(page.getByRole("navigation", { name: "primary" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".opchip")).toBeVisible();
    // No access-token prompt, ever — the zero-friction guarantee.
    expect(dialogs.filter((m) => m.includes("token"))).toHaveLength(0);
    // And the browser was never asked for the raw credential:
    const stored = await page.evaluate(() => localStorage.getItem("pair.mc_token"));
    expect(stored ?? "").toBe("");
  });

  test("SSE /api/events stream carries no token query", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/events")) urls.push(r.url());
    });
    // The shared event bus mounts on Observability — /app/home doesn't
    // subscribe. The stream must authenticate via the session cookie.
    await page.goto("/app/system/observability");
    await expect(page.getByRole("navigation", { name: "primary" })).toBeVisible({
      timeout: 15_000,
    });
    // Give the event bus a beat to connect.
    await page.waitForTimeout(1500);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).not.toContain("token=");
  });

  test("settings shows connected personal session, not a token form", async ({ page }) => {
    await page.goto("/app/system/settings");
    await expect(page.getByText("Đã kết nối", { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
    // Manual token fields exist but are folded behind advanced.
    const tok = page.locator("#tokin");
    if (await tok.count()) {
      await expect(tok.first()).not.toBeVisible();
    }
  });

  test("operator chip shows the canonical session identity", async ({ page }) => {
    await page.goto("/app/home");
    await expect(page.getByRole("navigation", { name: "primary" })).toBeVisible({
      timeout: 15_000,
    });
    const chip = page.locator(".opchip");
    await expect(chip).toBeVisible();
    // The bound canonical identity — never the "no operator" fallback.
    // Fresh e2e store → the server mints operator:personal:<hex>.
    const title = await chip.getAttribute("title");
    expect(title).toMatch(/operator: (operator:personal:|op:)/);
  });
});

test.describe("personal mode — remote ingress stays bearer-only", () => {
  test("remote listener rejects cookie-only requests", async ({ browser }) => {
    const local = await browser.newContext();
    const page = await local.newPage();
    await page.goto(`${LOCAL}/app/home`);
    await expect(page.getByRole("navigation", { name: "primary" })).toBeVisible({
      timeout: 15_000,
    });
    const cookie = (await local.cookies()).find((c) => c.name === "pair_ps");
    expect(cookie).toBeTruthy();

    const remote = await browser.newContext();
    await remote.addCookies([{ name: cookie!.name, value: cookie!.value, url: REMOTE }]);
    const res = await remote.request.get(`${REMOTE}/api/objectives`);
    expect(res.status()).toBe(401);
    await local.close();
    await remote.close();
  });

  test("remote listener cannot mint a session", async ({ request }) => {
    const res = await request.post(`${REMOTE}/api/personal/session/bootstrap`, {
      headers: { Origin: `${REMOTE}` },
      failOnStatusCode: false,
    });
    // The personal lane is gated to the local ingress class — on the
    // remote listener bootstrap can never mint (401 auth gate / 403
    // ingress classification).
    expect([401, 403]).toContain(res.status());
  });
});
