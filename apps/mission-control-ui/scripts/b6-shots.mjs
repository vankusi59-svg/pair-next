// B6 acceptance screenshots — deterministic, isolated synthetic fixture env.
//
// Provenance (B6 R2): this script spawns its OWN serve-mission-control.mjs
// with a fresh PAIR_MC_DIR created per run (mkdtemp pair-b6-shots-*), a
// synthetic token "b6-fixture-token" (PAIR_MC_TOKEN override — the real
// ~/pair-mc-token dev credential is never touched), stub conversation
// replies and the template planner. The single business shown in populated
// shots is created through the canonical POST /api/businesses inside that
// env and its id is asserted before capture. No production credential or
// production business data can appear: the server is spawned by this
// script, its env is logged (dir + port), and every populated shot asserts
// the selected business actually rendered (fails on "No business
// selected"). No .catch() suppression on navigation.

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.B6_SHOT_PORT || 8792);
const BASE = `http://localhost:${PORT}`;
const OUT = new URL("../../../docs/P15_9_B6/screenshots/", import.meta.url).pathname;
const TOKEN = "b6-fixture-token"; // synthetic, passed via PAIR_MC_TOKEN — never the real dev credential
const OPERATOR = "op:e2e";
const MC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pair-b6-shots-"));

const server = spawn("node", ["../../scripts/serve-mission-control.mjs"], {
  env: {
    ...process.env,
    PAIR_MC_PORT: String(PORT),
    PAIR_MC_DIR: MC_DIR,
    PAIR_MC_TOKEN: TOKEN,
    PAIR_CONVERSATION_STUB_REPLY: "PAIR stub reply (b6 shots).",
    PAIR_MC_TEMPLATE_PLANNER: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.on("error", (e) => { console.error("server spawn failed", e); process.exit(1); });
console.log(`fixture env: PAIR_MC_DIR=${MC_DIR} PORT=${PORT} token=synthetic`);

const api = async (p, init = {}) => {
  const r = await fetch(BASE + p, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "x-operator-id": OPERATOR,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return r;
};

// wait for the fixture server to answer /api/health with OUR synthetic token
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    const r = await api("/api/health");
    if (r.ok) up = true;
  } catch { /* still starting */ }
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error("fixture server never came up"); server.kill(); process.exit(1); }

// affirmative isolation check: the env must start EMPTY (fresh dir proof),
// then we create exactly one synthetic business and pin its id
const bizList0 = await (await api("/api/businesses")).json();
if (!Array.isArray(bizList0.businesses) || bizList0.businesses.length !== 0) {
  console.error("fixture env not empty — aborting (isolation violated)");
  server.kill(); process.exit(1);
}
const created = await (await api("/api/businesses", {
  method: "POST",
  body: JSON.stringify({ name: "b6-fixture-demo", goal: "B6 screenshot fixture", project_id: (await (await api("/api/projects")).json())[0].project_id }),
})).json();
const BIZ = created.business_id;
if (!/^BIZ_/.test(BIZ ?? "")) { console.error("business create failed", created); server.kill(); process.exit(1); }
console.log(`fixture business: ${BIZ} (synthetic, created in ${MC_DIR})`);

// seed ONE synthetic objective via the canonical contract — backend derives
// owner_authority_id from x-operator-id (operator:op:e2e); never forged.
// Company scope requires the actor to own >=1 objective in the business.
const OBJ_TITLE = "B6 fixture objective";
const objRes = await api("/api/vnext/objectives", {
  method: "POST",
  body: JSON.stringify({
    business_id: BIZ,
    title: OBJ_TITLE,
    statement: "Seed objective for B6 populated-state screenshot evidence.",
    kpis: [{ kpi_id: "KPI_B6_SHOTS", name: "deliverables", unit: "count",
      direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: "2999-01-01T00:00:00.000Z",
    budget_ceiling_microusd: 500000,
    dedup_key: "b6-fixture-objective",
  }),
});
const createdObj = await objRes.json();
const OID = createdObj.objective_id;
if (!objRes.ok || !/^OBJ_/.test(OID ?? "")) { console.error("objective create failed", objRes.status, createdObj); server.kill(); process.exit(1); }
// verify backend-derived ownership + canonical company read BEFORE capturing
if (String(createdObj.owner_authority_id) !== `operator:${OPERATOR}`) {
  console.error(`objective owner ${createdObj.owner_authority_id} !== operator:${OPERATOR}`); server.kill(); process.exit(1);
}
if (String(createdObj.business_id) !== BIZ) {
  console.error(`objective business_id ${createdObj.business_id} !== ${BIZ}`); server.kill(); process.exit(1);
}
const compRes = await api(`/api/vnext/businesses/${BIZ}/company`);
const company = await compRes.json();
if (!compRes.ok || String(company.company?.business?.business_id) !== BIZ) {
  console.error("company API not 200/populated", compRes.status, company); server.kill(); process.exit(1);
}
if (!(company.company?.objectives ?? []).some((o) => String(o.objective_id) === OID)) {
  console.error("company read missing seeded objective", company.company?.objectives); server.kill(); process.exit(1);
}
console.log(`fixture objective: ${OID} owner=operator:${OPERATOR} company=200 verified`);

// shots: [path, name, w, h, marker] — marker = text that MUST render for a
// valid populated-state capture (real data, not an error string).
const shots = [
  ["/app/company", "company", 1440, 900, "b6-fixture-demo"],
  ["/app/objectives", "objectives", 1440, 900, OBJ_TITLE],
  ["/app/inbox", "inbox", 768, 1024, null],
  ["/app/missions", "missions", 1440, 900, null],
  ["/app/system/cost", "system-cost", 1024, 768, null],
  ["/app/system/providers", "system-providers", 1440, 900, null],
  ["/app/company", "company-mobile", 390, 844, "b6-fixture-demo"],
  ["/app/chat", "chat-mobile", 390, 844, null],
];
const ERROR_RE = /access denied|fail_closed_[a-z_]+|no business selected/i;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? "/home/ubuntu/.local/bin/google-chrome",
});
try {
  for (const theme of ["light", "dark"]) {
    for (const [pathName, name, w, h, marker] of shots) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      // serialize credentials + business id explicitly into the page context
      await page.addInitScript(
        ([tok, op, biz, th]) => {
          localStorage.setItem("pair.mc_token", tok);
          localStorage.setItem("pair.operator_id", op);
          localStorage.setItem("pair.business_id", biz);
          localStorage.setItem("pair.theme", th);
        },
        [TOKEN, OPERATOR, BIZ, theme],
      );
      const resp = await page.goto(BASE + pathName, { waitUntil: "networkidle" });
      if (!resp || !resp.ok) throw new Error(`navigation to ${pathName} failed: ${resp?.status()}`);

      // affirmative assertions before capture
      const stored = await page.evaluate(() => localStorage.getItem("pair.business_id"));
      if (stored !== BIZ) throw new Error(`${name}: pair.business_id=${stored}, expected ${BIZ}`);
      // wait for real data rendering — not just main.amain presence:
      // populated shots must show the marker text; every shot must be
      // free of canonical error/denied states before capture.
      await page.waitForSelector("main.amain", { timeout: 15000 });
      if (marker) {
        await page.waitForFunction(
          (m) => document.querySelector("main.amain")?.textContent?.includes(m),
          marker, { timeout: 15000 },
        ).catch(() => { throw new Error(`${name}: marker "${marker}" never rendered — populated state not proven`); });
      }
      await page.waitForTimeout(800);
      const bodyText = await page.locator("main.amain").innerText();
      if (ERROR_RE.test(bodyText)) {
        throw new Error(`${name}: canonical error/denied state rendered — not valid evidence`);
      }
      if (marker && !bodyText.includes(marker)) {
        throw new Error(`${name}: marker "${marker}" absent at capture`);
      }
      await page.screenshot({ path: `${OUT}${name}-${theme}.png` });
      await page.close();
      console.log(`shot ${name}-${theme} OK${marker ? ` (verified "${marker}")` : ""}`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}
console.log("done — all captures verified against the isolated fixture env");
