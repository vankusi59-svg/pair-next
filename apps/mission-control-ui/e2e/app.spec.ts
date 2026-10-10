import { test, expect } from "@playwright/test";
import { seedSession } from "./helpers";

// P15.9-B1 — new /app/* shell: parallel route tree, honest placeholders,
// business switcher manual-entry contract, mobile nav, theme, keyboard.
test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

test("/app/company renders new shell + honest no-business state", async ({ page }) => {
  await page.goto("/app/company");
  await expect(page.getByRole("heading", { name: "Company Cockpit" })).toBeVisible();
  await expect(page.locator(".pstate .t")).toHaveText("No business selected");
  // sidebar groups + links per B.3
  for (const g of ["Overview", "Business", "Operations", "System"]) {
    await expect(page.locator(".anav .group", { hasText: g })).toBeVisible();
  }
  for (const l of ["Company Cockpit", "Owner Inbox", "Objectives", "CEO Workspace", "Workforce", "Missions", "Chat"]) {
    await expect(page.locator(".anav a", { hasText: l })).toBeVisible();
  }
});

test("placeholder pages exist for every unimplemented B4-B6 route", async ({ page }) => {
  /* /app/company, /app/objectives*, /app/inbox, /app/ceo are real
     B2–B4 pages now — only destinations still placeholder-honest. */
  const routes: Array<[string, string]> = [
    ["/app/workforce", "AI Workforce"],
    ["/app/missions", "Mission Operations"],
    ["/app/missions/new", "Task Entry"],
    ["/app/chat", "Chat"],
    ["/app/system/providers", "Providers & Models"],
    ["/app/system/observability", "Observability"],
    ["/app/system/schedules", "Schedules"],
    ["/app/system/cost", "Cost & Usage"],
    ["/app/system/settings", "Settings"],
  ];
  for (const [path, title] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText("Not implemented yet")).toBeVisible();
  }
});

test("business switcher stores manual business_id, never enumerates", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => calls.push(r.url()));
  await page.goto("/app/company");
  await page.getByRole("button", { name: "business switcher" }).click();
  await page.getByLabel("business id").fill("BIZ_e2e_demo");
  await page.getByRole("button", { name: "Use" }).click();
  await expect(page.getByRole("button", { name: "business switcher" })).toContainText("BIZ_e2e_demo");
  // persists across reload
  await page.reload();
  await expect(page.getByRole("button", { name: "business switcher" })).toContainText("BIZ_e2e_demo");
  // switcher must not call the unfiltered businesses list
  expect(calls.filter((u) => u.includes("/api/businesses"))).toEqual([]);
});

test("/ still serves the legacy dashboard unchanged", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Task Entry" })).toBeVisible();
  await expect(page.locator(".appshell")).toHaveCount(0);
});

test("theme toggle works in the new shell", async ({ page }) => {
  await page.goto("/app/company");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "toggle theme" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("mobile viewport: bottom tab bar + drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/app/company");
  await expect(page.locator(".aside")).toBeHidden();
  await expect(page.locator(".atabbar")).toBeVisible();
  await page.getByRole("button", { name: "more navigation" }).click();
  await expect(page.locator(".adrawer")).toBeVisible();
  await page.locator(".adrawer .anav a", { hasText: "Schedules" }).click();
  await expect(page).toHaveURL(/\/app\/system\/schedules/);
});

// ---- R1 F1: tablet (768-1199) ----
test("tablet: icon rail links have accessible names + topbar switcher", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/app/company");
  await expect(page.locator(".aside")).toBeVisible();
  await expect(page.locator(".aside .bizswitch")).toBeHidden();
  // icon-rail links keep accessible names even with .lbl hidden
  const obj = page.locator(".aside .anav a", { hasText: "Objectives" });
  await expect(page.getByRole("link", { name: "Objectives" }).first()).toHaveAttribute("title", "Objectives");
  await obj.first().click();
  await expect(page).toHaveURL(/\/app\/objectives$/);
  // topbar switcher works on tablet
  const sw = page.locator(".atobiz");
  await expect(sw).toBeVisible();
  await sw.getByRole("button", { name: "business switcher" }).click();
  await page.locator(".atobiz").getByLabel("business id").fill("BIZ_tablet");
  await page.locator(".atobiz").getByRole("button", { name: "Use" }).click();
  await expect(sw.getByRole("button", { name: "business switcher" })).toContainText("BIZ_tablet");
});

// ---- R1 F1 residual: shared selected-business state across viewports ----
test("switcher state syncs across desktop -> tablet -> desktop without reload", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => calls.push(r.url()));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app/company");
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill("BIZ_A");
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(page.locator(".aside .bizswitch .v")).toHaveText("BIZ_A");
  // resize to tablet: rail hides sidebar switcher, topbar switcher shows
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator(".atobiz .bizswitch .v")).toHaveText("BIZ_A");
  await page.locator(".atobiz").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".atobiz").getByLabel("business id").fill("BIZ_B");
  await page.locator(".atobiz").getByRole("button", { name: "Use" }).click();
  await expect(page.locator(".atobiz .bizswitch .v")).toHaveText("BIZ_B");
  // back to desktop without reload: sidebar reflects BIZ_B
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".aside .bizswitch .v")).toHaveText("BIZ_B");
  const stored = await page.evaluate(() => localStorage.getItem("pair.business_id"));
  expect(stored).toBe("BIZ_B");
  expect(calls.filter((u) => u.includes("/api/businesses"))).toEqual([]);
});

// ---- R1 F2: drawer modal keyboard behavior ----
test("drawer: focus in, Esc out, Tab trapped, focus returns to More", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/app/company");
  const more = page.getByRole("button", { name: "more navigation" });
  await more.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "More navigation" });
  await expect(dlg).toBeVisible();
  // focus entered the dialog (close button is first focusable)
  const inside = await page.evaluate(() => document.querySelector(".adrawer")!.contains(document.activeElement));
  expect(inside).toBe(true);
  // Tab cycles within the drawer — never escapes to the page behind
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const ok = await page.evaluate(() => document.querySelector(".adrawer")!.contains(document.activeElement));
    expect(ok).toBe(true);
  }
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Shift+Tab");
    const ok = await page.evaluate(() => document.querySelector(".adrawer")!.contains(document.activeElement));
    expect(ok).toBe(true);
  }
  // Escape closes + focus returns to the More trigger
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(more).toBeFocused();
  // explicit close control works too
  await more.click();
  await page.getByRole("button", { name: "close navigation menu" }).click();
  await expect(dlg).toBeHidden();
});

// ---- R1 F3: token isolation + contrast ----
function contrast(fg: string, bg: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const toHex = (c: string) => {
    if (c.startsWith("#")) {
      return c.length === 4 ? "#" + c.slice(1).split("").map((x) => x + x).join("") : c;
    }
    const m = c.match(/\d+/g)!.map(Number);
    return "#" + m.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
  };
  const a = lum(toHex(fg)), b = lum(toHex(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("legacy theme tokens are not overridden by the new shell", async ({ page }) => {
  await page.goto("/");
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(accent).toBe("#3b82f6"); // legacy app.css value, not the appshell token
});

test("text-3 / unknown tokens meet 4.5:1 contrast in both themes", async ({ page }) => {
  await page.goto("/app/company");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const v = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector(".appshell")!);
      return { t3: cs.getPropertyValue("--text-3").trim(), unk: cs.getPropertyValue("--unknown").trim(), bg: cs.getPropertyValue("--bg-surface").trim() };
    });
    expect(contrast(v.t3, v.bg), `${theme} --text-3`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v.unk, v.bg), `${theme} --unknown`).toBeGreaterThanOrEqual(4.5);
  }
});

test("keyboard: skip link + nav landmarks focusable", async ({ page }) => {
  await page.goto("/app/company");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByRole("link", { name: "Objectives" }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/objectives/);
});
