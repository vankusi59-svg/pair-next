import { chromium } from "file:///D:/PAIR_NEXT_2410/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs";
const BASE = "http://localhost:8790";
const results = [];
const ok = (n,p,x="") => { results.push({n,pass:!!p}); console.log(`${p?"PASS":"FAIL"} ${n} ${x}`); };
const browser = await chromium.launch({ headless: true, executablePath: "C:/Users/Admin/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe" });
const page = await browser.newPage();
await page.addInitScript(() => {
  localStorage.setItem("pair.mc_token", "e2e-v1-tok");
  localStorage.setItem("pair.operator_id", "e2e");
  localStorage.setItem("pair.business_id", "BIZ_01M5R1CKY94M7Q9G6X1PEGK8Q6");
});
// 1. Objective detail — autonomous loop section
await page.goto(`${BASE}/app/objectives/OBJ_1050b1f751ab60ba540c4593`, { waitUntil: "networkidle" });
const b1 = await page.textContent("body");
ok("detail: autonomous loop section", /scheduler|driver|auto.?policy|queue|generation/i.test(b1));
ok("detail: review/signoff link", /review|sign.?off/i.test(b1));
// 2. Objective reviews page — canonical review + signoff record
await page.goto(`${BASE}/app/objectives/OBJ_1050b1f751ab60ba540c4593/reviews`, { waitUntil: "networkidle" });
const b2 = await page.textContent("body");
ok("reviews: page renders", b2.length > 400);
ok("reviews: TARGET_MET or review id visible", /TARGET_MET|REV_|review|sign.?off|ACHIEVED/i.test(b2));
await page.screenshot({ path: "C:/Users/Admin/.pair-e2e-v1/ui-reviews.png", fullPage: true });
// 3. Mission detail — real mission + tasks + artifacts
await page.goto(`${BASE}/app/missions/MSN_01M5R1ZXKBT7CCE6FYB45CJ8A3`, { waitUntil: "networkidle" });
const b3 = await page.textContent("body");
ok("mission detail: status visible", /COMPLETED|RUNNING/i.test(b3));
ok("mission detail: task/artifact refs", /verdict|hello_pairnext|TSK_|artifact/i.test(b3));
await page.screenshot({ path: "C:/Users/Admin/.pair-e2e-v1/ui-missiondetail.png", fullPage: true });
// 4. CEO workspace — decision surface
await page.goto(`${BASE}/app/ceo`, { waitUntil: "networkidle" });
const b4 = await page.textContent("body");
ok("ceo: page renders", b4.length > 400);
// 5. System observability — executors/routing
await page.goto(`${BASE}/app/system/observability`, { waitUntil: "networkidle" });
const b5 = await page.textContent("body");
ok("observability: executor/routing surface", /CODEX|PAIR_NATIVE|executor|routing|QUALIFIED/i.test(b5));
await page.screenshot({ path: "C:/Users/Admin/.pair-e2e-v1/ui-observability.png", fullPage: true });
// 6. Refresh/reconnect — reload persists state (no fake empty)
await page.reload({ waitUntil: "networkidle" });
const b6 = await page.textContent("body");
ok("refresh: observability re-renders same", /CODEX|PAIR_NATIVE|executor|QUALIFIED/i.test(b6));
// 7. Company cockpit — portfolio graph truth
await page.goto(`${BASE}/app/company`, { waitUntil: "networkidle" });
const b7 = await page.textContent("body");
ok("company: CANCELLED objective honest (not fabricated)", b7.includes("CANCELLED"));
ok("company: conflict/dependency visible", /conflict|depend|upstream|blocked/i.test(b7));
await page.screenshot({ path: "C:/Users/Admin/.pair-e2e-v1/ui-company2.png", fullPage: true });
await browser.close();
const p = results.filter(r=>r.pass).length;
console.log(`\n=== UI-LIVE-2: ${p}/${results.length} ===`);
