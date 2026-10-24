import { chromium } from "file:///D:/PAIR_NEXT_2410/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({ headless: true, executablePath: "C:/Users/Admin/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe" });
const page = await browser.newPage();
await page.addInitScript(() => {
  localStorage.setItem("pair.mc_token", "e2e-v1-tok");
  localStorage.setItem("pair.operator_id", "e2e");
});
page.on("console", m => { if (m.type()==="error") console.log("PAGE-ERR:", m.text().slice(0,150)); });
await page.goto("http://localhost:8790/app/objectives", { waitUntil: "networkidle" });
console.log("BODY:", (await page.textContent("body")).slice(0,1500));
await browser.close();
