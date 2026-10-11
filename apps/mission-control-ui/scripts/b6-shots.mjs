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

const shots = [
  ["/app/company", "company", 1440, 900, true],
  ["/app/objectives", "objectives", 1440, 900, true],
  ["/app/inbox", "inbox", 768, 1024, false],
  ["/app/missions", "missions", 1440, 900, false],
  ["/app/system/cost", "system-cost", 1024, 768, false],
  ["/app/system/providers", "system-providers", 1440, 900, false],
  ["/app/company", "company-mobile", 390, 844, true],
  ["/app/chat", "chat-mobile", 390, 844, false],
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? "/home/ubuntu/.local/bin/google-chrome",
});
try {
  for (const theme of ["light", "dark"]) {
    for (const [pathName, name, w, h, expectsBiz] of shots) {
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
      await page.waitForSelector("main.amain", { timeout: 15000 });
      await page.waitForTimeout(1200);
      const bodyText = await page.locator("main.amain").innerText();
      if (expectsBiz) {
        if (/no business selected/i.test(bodyText)) {
          throw new Error(`${name}: populated shot shows "No business selected" — environment not seeded`);
        }
        if (!bodyText.includes(BIZ) && !/b6-fixture-demo/i.test(bodyText)) {
          throw new Error(`${name}: fixture business not rendered in page text`);
        }
      }
      await page.screenshot({ path: `${OUT}${name}-${theme}.png` });
      await page.close();
      console.log(`shot ${name}-${theme} OK${expectsBiz ? " (business rendered)" : ""}`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}
console.log("done — all captures verified against the isolated fixture env");
