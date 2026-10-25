#!/usr/bin/env node
/* P18.4 Phase D4 — real-browser evidence capture against a live MC
 * instance backed by authentic canonical state (tmp/p184-live).
 * Captures: screenshots, interaction trace, redacted API responses,
 * canonical-vs-rendered comparison, pass/fail matrix. No secrets are
 * written — the token never enters artifacts. */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.PAIR_MC_BASE ?? "http://localhost:8801";
const OUT = path.resolve("tmp/p184-browser-evidence");
const MID_SETTLED = "MSN_01M5T0G5NMTEVA6FX1741KT01K"; // SETTLED exec + pending ABORT
const MID_ABORTED = "MSN_01M5T0BHJ24Q5YCH6E5MG0NDM2"; // ABORTED, no execs
const tok = fs.readFileSync(path.join(process.env.HOME ?? os.homedir(), "pair-mc-token"), "utf8").trim();
const CHROME = process.env.CHROME_BIN ??
  "C:\\Users\\Admin\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe";

fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ check: name, result: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ colorScheme: "dark" });
const apiLog = [];
page.on("response", (r) => {
  if (r.url().includes("/api/")) apiLog.push(`${r.request().method()} ${r.url().replace(BASE, "")} -> ${r.status()}`);
});
await page.addInitScript((t) => {
  localStorage.setItem("pair.mc_token", t);
  localStorage.setItem("pair.operator_id", "op:e2e");
}, tok);

// Canonical truth for comparison (redacted: no headers/cookies stored).
const H = { authorization: `Bearer ${tok}` };
const canon = {};
for (const mid of [MID_SETTLED, MID_ABORTED]) {
  canon[mid] = await (await fetch(`${BASE}/api/missions/${mid}/operations`, { headers: H })).json();
}
fs.writeFileSync(path.join(OUT, "api-operations-redacted.json"),
  JSON.stringify(canon, null, 2).replaceAll(tok, "<redacted>"));

// D1 — Mission Detail on the settled+pending mission.
await page.goto(`${BASE}/app/missions/${MID_SETTLED}`);
await page.getByRole("heading", { name: /execution health/i }).waitFor({ timeout: 15000 });
check("D1.execHealth.heading", true);
await page.getByRole("heading", { name: /recovery operations/i }).waitFor({ timeout: 15000 });
const execCanon = canon[MID_SETTLED].execution_health?.executions ?? [];
const settledRow = execCanon.find((e) => e.derived?.stage === "SETTLED");
const pageText = await page.locator("body").innerText();
check("D1.execHealth.settledRowRendered", !!settledRow && pageText.includes(String(settledRow.execution_id).slice(0, 24)),
  `stage=${settledRow?.derived?.stage} settle_complete=${settledRow?.persisted?.settle_complete}`);
check("D1.recoveryOps.pendingBadge", pageText.includes("PENDING RECOVERY"),
  `pending action=${canon[MID_SETTLED].recovery_ops?.pending_recovery?.action}`);
check("D1.recoveryOps.runtimeBadge", pageText.includes(String(canon[MID_SETTLED].recovery_ops?.runtime_state)),
  `runtime=${canon[MID_SETTLED].recovery_ops?.runtime_state}`);
await page.screenshot({ path: path.join(OUT, "d1-mission-detail-settled.png"), fullPage: true });

// D1 — ABORTED mission with no executions renders honest states.
await page.goto(`${BASE}/app/missions/${MID_ABORTED}`);
await page.getByRole("heading", { name: /execution health/i }).waitFor({ timeout: 15000 });
const abText = await page.locator("body").innerText();
check("D1.execHealth.honestEmpty", abText.includes("No executions in the liveness projection"),
  `canon execs=${(canon[MID_ABORTED].execution_health?.executions ?? []).length}`);
await page.screenshot({ path: path.join(OUT, "d1-mission-detail-aborted.png"), fullPage: true });

// D2 — System Observability operations rollup.
await page.goto(`${BASE}/app/system/observability`);
await page.getByRole("tab", { name: /operations/i }).click();
await page.getByText(/GET \/api\/operations/).waitFor({ timeout: 15000 });
const ovText = await page.locator("body").innerText();
check("D2.rollup.metrics", /missions_active|active supervised missions/i.test(ovText));
await page.screenshot({ path: path.join(OUT, "d2-operations-rollup.png"), fullPage: true });

// D3 — auth gates from the browser context.
const unauth = await page.request.fetch(`${BASE}/api/missions/${MID_SETTLED}/operations`);
check("D3.api.noToken401", unauth.status() === 401, `status=${unauth.status()}`);

// Wire log — POSTs and request volume sanity.
fs.writeFileSync(path.join(OUT, "api-wire.log"), apiLog.join("\n"));
const posts = apiLog.filter((l) => l.startsWith("POST"));
check("D4.wire.noUnexpectedMutations", posts.length === 0, `POSTs=${posts.length}`);
check("D4.wire.boundedPolling", apiLog.length < 300, `api calls=${apiLog.length}`);

fs.writeFileSync(path.join(OUT, "pass-fail-matrix.json"), JSON.stringify(results, null, 2));
await browser.close();
const fails = results.filter((r) => r.result === "FAIL");
console.log(`\n${results.length - fails.length}/${results.length} PASS — artifacts in ${OUT}`);
process.exit(fails.length ? 1 : 0);
