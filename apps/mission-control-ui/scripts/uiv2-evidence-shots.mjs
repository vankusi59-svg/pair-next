#!/usr/bin/env node
/* UI-V2 evidence screenshots — real browser captures of the PR build.
 * Views: owner cockpit, NL intake + reviewed draft, objective detail
 * default + advanced tabs, mission workspace, nav collapsed/expanded,
 * mobile cockpit + intake — dark + light, desktop 1440×900 / mobile
 * 390×844. No secrets written — the token lives only in localStorage. */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.PAIR_MC_BASE ?? "http://localhost:8797";
const TOKEN = process.env.PAIR_MC_TOKEN ?? "shot-token-123";
const BIZ = process.env.SHOT_BIZ ?? "BIZ_01M5YFTDQ97RVKV8KKGBZ648W7";
const OBJ = process.env.SHOT_OBJ ?? "OBJ_4ea13b2d2c27478ad1e24e0a";
const OUT = path.resolve("../../../docs/ui-v2/evidence/screenshots");
const CHROME = process.env.CHROME_BIN ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const GOAL =
  "Xây kế hoạch nội dung 30 ngày cho kênh TikTok giáo dục trading XAUUSD, hạn 2026-12-31, ngân sách $150";

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });

async function shot(ctx, url, name, opts = {}) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  if (opts.act) await opts.act(page);
  await page.waitForTimeout(opts.settle ?? 400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: opts.full ?? false });
  console.log("shot:", name);
  await page.close();
}

async function ctxFor(width, height, theme) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    baseURL: BASE,
  });
  await ctx.addInitScript(
    ([t, b]) => {
      localStorage.setItem("pair.mc_token", t);
      localStorage.setItem("pair.operator_id", "op:shots");
      localStorage.setItem("pair.business_id", b);
    },
    [TOKEN, BIZ],
  );
  return ctx;
}

const analyze = async (page) => {
  await page.locator(".v2hero-in").fill(GOAL);
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await page.locator(".draftwrap").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
};

// ---------- desktop dark ----------
const dd = await ctxFor(1440, 900, "dark");
await shot(dd, "/app/home", "01-cockpit-desktop-dark");
await shot(dd, "/app/new", "02-intake-empty-desktop-dark");
await shot(dd, "/app/new", "03-intake-draft-desktop-dark", { act: analyze });
await shot(dd, `/app/objectives/${OBJ}`, "04-objective-overview-desktop-dark");
await shot(dd, `/app/objectives/${OBJ}?tab=nang-cao`, "05-objective-advanced-desktop-dark");
await shot(dd, "/app/missions", "06-missions-desktop-dark");
await shot(dd, "/app/missions/new", "07-task-entry-desktop-dark");
await shot(dd, "/app/home", "08-nav-advanced-desktop-dark", {
  act: async (p) => {
    await p.locator(".anav .advtoggle").first().click();
    await p.waitForTimeout(300);
  },
});
await shot(dd, "/app/inbox", "09-inbox-desktop-dark");
await shot(dd, "/app/workforce", "10-workforce-desktop-dark");
await dd.close();

// ---------- desktop light ----------
const dl = await ctxFor(1440, 900, "light");
await shot(dl, "/app/home", "11-cockpit-desktop-light");
await shot(dl, "/app/new", "12-intake-draft-desktop-light", { act: analyze });
await shot(dl, `/app/objectives/${OBJ}`, "13-objective-overview-desktop-light");
await dl.close();

// ---------- mobile 390×844 dark ----------
const md = await ctxFor(390, 844, "dark");
await shot(md, "/app/home", "14-cockpit-mobile-dark");
await shot(md, "/app/new", "15-intake-draft-mobile-dark", { act: analyze });
await shot(md, `/app/objectives/${OBJ}`, "16-objective-mobile-dark");
await md.close();

await browser.close();
console.log("done →", OUT);
