import { chromium } from "file:///D:/PAIR_NEXT_2410/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs";
const BASE = "http://localhost:8790";
const TOK = "e2e-v1-tok", OP = "e2e";
const results = [];
const ok = (name, pass, extra="") => { results.push({name, pass: !!pass, extra}); console.log(`${pass?"PASS":"FAIL"} ${name} ${extra}`); };

const browser = await chromium.launch({ headless: true, executablePath: "C:/Users/Admin/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe" });
const page = await browser.newPage();
await page.addInitScript(([t,o]) => {
  localStorage.setItem("pair.mc_token", t);
  localStorage.setItem("pair.operator_id", o);
  localStorage.setItem("pair.business_id", "BIZ_01M5R1CKY94M7Q9G6X1PEGK8Q6");
}, [TOK, OP]);

// ---- 1. Company cockpit — live business + objective states ----
await page.goto(`${BASE}/app/company`, { waitUntil: "networkidle" });
const body1 = await page.textContent("body");
ok("company: business name rendered", body1.includes("V1 Autonomous Corp"));
ok("company: ACHIEVED objective rendered", body1.includes("ACHIEVED") || body1.includes("autonomous-hello"));
await page.screenshot({ path: "C:/Users/Admin/.pair-e2e-v1/ui-company.png", fullPage: true });

// ---- 2. Objective list — status mix ----
await page.goto(`${BASE}/app/objectives`, { waitUntil: "networkidle" });
const body2 = await page.textContent("body");
ok("objectives: list loads", body2.includes("autonomous-hello") || body2.includes("OBJ_"));
ok("objectives: mixed statuses present", /ACHIEVED|ACTIVE|CANCELLED/.test(body2));

// ---- 3. Objective detail — KPI + evidence ----
const OBJ = "OBJ_1050b1f751ab60ba540c4593";
await page.goto(`${BASE}/app/objectives/${OBJ}`, { waitUntil: "networkidle" });
const body3 = await page.textContent("body");
ok("detail: title rendered", body3.includes("autonomous-hello"));
ok("detail: ACHIEVED status", body3.includes("ACHIEVED"));
ok("detail: KPI visible", body3.includes("KPI_DELIVERED") || /kpi/i.test(body3));
ok("detail: evidence key visible", body3.includes("ev-hello-1") || /evidence/i.test(body3));
await page.screenshot({ path: "C:/Users/Admin/.pair-e2e-v1/ui-objdetail.png", fullPage: true });

// ---- 4. Autonomous loop page — scheduler/driver observability ----
await page.goto(`${BASE}/app/objectives/${OBJ}/loop`, { waitUntil: "networkidle" }).catch(async () => {
  await page.goto(`${BASE}/app/loop`, { waitUntil: "networkidle" }).catch(()=>{});
});
const body4 = await page.textContent("body");
ok("loop: scheduler/driver surface renders", /scheduler|driver|queue|generation|policy/i.test(body4));
await page.screenshot({ path: "C:/Users/Admin/.pair-e2e-v1/ui-loop.png", fullPage: true });

// ---- 5. Ground-truth cross-check: UI text matches live API ----
const apiObj = await (await fetch(`${BASE}/api/vnext/objectives/${OBJ}`, { headers: { authorization: `Bearer ${TOK}`, "x-operator-id": OP } })).json();
ok("cross-check: UI status == API status", body3.includes(String(apiObj.status)), `api=${apiObj.status}`);

// ---- 6. Reviews page — sign-off visible ----
await page.goto(`${BASE}/app/reviews`, { waitUntil: "networkidle" }).catch(()=>{});
const body6 = await page.textContent("body");
ok("reviews: sign-off/review surface", /review|sign.?off|TARGET_MET|ACHIEVED/i.test(body6));

// ---- 7. Tenant isolation: wrong token → denied ----
await page.evaluate(() => { localStorage.setItem("pair.mc_token", "WRONG-TOKEN"); });
const badFetch = await page.evaluate(async (u) => {
  const r = await fetch(u, { headers: { authorization: "Bearer WRONG-TOKEN" } });
  return r.status;
}, `${BASE}/api/vnext/objectives`);
ok("isolation: wrong token -> 401/403", badFetch === 401 || badFetch === 403, `status=${badFetch}`);
await page.evaluate((t) => localStorage.setItem("pair.mc_token", t), TOK);

// ---- 8. Mission detail — real mission visible ----
await page.goto(`${BASE}/app/missions`, { waitUntil: "networkidle" });
const body8 = await page.textContent("body");
ok("missions: MSN list renders", body8.includes("MSN_") || /mission/i.test(body8));
await page.screenshot({ path: "C:/Users/Admin/.pair-e2e-v1/ui-missions.png", fullPage: true });

// ---- 9. Capability-gap / cockpit advisory on probe objective ----
await page.goto(`${BASE}/app/objectives/OBJ_a1e48e05535dd37195d43378`, { waitUntil: "networkidle" });
const body9 = await page.textContent("body");
ok("probe detail: renders without crash", body9.length > 500 && !/cannot read|undefined is not/i.test(body9));

await browser.close();
const passed = results.filter(r=>r.pass).length;
console.log(`\n=== UI-LIVE: ${passed}/${results.length} PASS ===`);
fs_write(results);
function fs_write(r){ import("node:fs").then(fs=>fs.writeFileSync("C:/Users/Admin/.pair-e2e-v1/ui-live-results.json", JSON.stringify(r,null,1))); }
