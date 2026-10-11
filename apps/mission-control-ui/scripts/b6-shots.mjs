// B6 acceptance screenshots — deterministic, sanitized (demo fixture data only).
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mcToken = () =>
  process.env.PAIR_MC_TOKEN ||
  fs.readFileSync(path.join(process.env.PAIR_HOME ?? os.homedir(), "pair-mc-token"), "utf8").trim();

const base = process.env.BASE_URL || "http://localhost:8790";
const out = "../../docs/P15_9_B6/screenshots";
const shots = [
  ["/app/company", "company", 1440, 900],
  ["/app/objectives", "objectives", 1440, 900],
  ["/app/inbox", "inbox", 768, 1024],
  ["/app/missions", "missions", 1440, 900],
  ["/app/system/cost", "system-cost", 1024, 768],
  ["/app/system/providers", "system-providers", 1440, 900],
  ["/app/company", "company-mobile", 390, 844],
  ["/app/chat", "chat-mobile", 390, 844],
];
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? "/home/ubuntu/.local/bin/google-chrome",
});
for (const theme of ["light", "dark"]) {
  for (const [path, name, w, h] of shots) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.addInitScript((t) => {
      localStorage.setItem("pair.mc_token", t);
      localStorage.setItem("pair.operator_id", "op:e2e");
      localStorage.setItem("pair.theme", document.documentElement.dataset.theme || "light");
    }, mcToken());
    await page.addInitScript((th) => localStorage.setItem("pair.theme", th), theme);
    await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${name}-${theme}.png` });
    await page.close();
    console.log(`shot ${name}-${theme}`);
  }
}
await browser.close();
