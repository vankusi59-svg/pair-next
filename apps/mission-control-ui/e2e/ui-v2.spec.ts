import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

/* UI-V2 — owner-first experience. Exercises the flagship NL intake
 * (draft → review/edit → explicit confirm → canonical commit), the
 * owner cockpit, objective workspace tabs, mobile/desktop layouts,
 * themes, deep links, and fail-closed handling — all against the real
 * server (semantic OFF in e2e → honest manual drafts). */

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
const OP = "op:e2e";

async function apiPost(page: Page, path: string, body: Record<string, unknown>) {
  const r = await page.request.post(`/api${path}`, {
    headers: {
      authorization: `Bearer ${mcToken()}`,
      "x-operator-id": OP,
      "content-type": "application/json",
    },
    data: body,
  });
  expect(r.status(), `${path} → ${r.status()}`).toBeLessThan(300);
  return r.json() as Promise<Record<string, unknown>>;
}

async function mkBusiness(page: Page, tag: string): Promise<{ id: string; name: string }> {
  const name = `e2e-v2-${tag}-${uniq()}`;
  const prjs = (await page.request.get("/api/projects", {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as Array<Record<string, unknown>>;
  const project_id = String(prjs[0]?.project_id ?? prjs[0]?.entity_id ?? "default");
  const b = await apiPost(page, "/businesses", { name, project_id, description: "v2 e2e" });
  return { id: String(b.business_id ?? b.entity_id), name };
}

async function seedBiz(page: Page, bizId: string) {
  await seedSession(page);
  await page.addInitScript((id: string) => {
    localStorage.setItem("pair.business_id", id);
  }, bizId);
}

const GOAL = "Xây kế hoạch nội dung 30 ngày cho kênh TikTok giáo dục trading, hạn 2026-12-31, ngân sách $150";

// ---------- Owner cockpit ----------
test("v2: home renders hero, stats, VN nav — hero hands off to intake", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/home");
  await expect(page.getByRole("heading", { name: /Bạn muốn PairNext thực hiện điều gì/i })).toBeVisible();
  await expect(page.locator(".stats .stat").first()).toBeVisible();
  for (const l of ["Tổng quan", "Mục tiêu", "Công việc", "Phê duyệt", "Nhân sự AI"]) {
    await expect(page.locator(".anav").getByRole("link", { name: l, exact: true })).toBeVisible();
  }
  // hero goal carries through to the intake page
  await page.locator(".v2hero-in").fill("Viết kế hoạch marketing Q1");
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await expect(page).toHaveURL(/\/app\/new\?goal=/);
  await expect(page.locator(".v2hero-in")).toHaveValue("Viết kế hoạch marketing Q1");
});

// ---------- NL intake: draft → mission ----------
test("v2 intake: VN goal → honest manual draft (semantic OFF) → mission confirm", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/new");
  await page.locator(".v2hero-in").fill(GOAL);
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await expect(page.locator(".draftwrap")).toBeVisible({ timeout: 15000 });
  // semantic OFF → draft badge must state manual, never imply model read it
  await expect(page.locator(".drcard-h .sbadge")).toContainText(/nháp thủ công/i);
  // provenance tags render on the draft fields
  await expect(page.locator(".pvtag").first()).toBeVisible();
  await expect(page.locator(".draftwrap")).toContainText("từ văn bản của bạn");
  // governance card — model output never self-authorizes
  await expect(page.locator(".govlist")).toContainText(/AI suy luận không phải authority/i);
  await expect(page.locator(".govlist")).toContainText(/không có phân tích AI|mode:/i);
  // mission kind → canonical MissionNew with the goal carried over
  await page.getByRole("radio", { name: /Mission — một công việc/ }).click();
  await page.getByRole("button", { name: /Tiếp tục — xem trước kế hoạch Mission/ }).click();
  await expect(page).toHaveURL(/\/app\/missions\/new\?goal=/);
  await expect(page.locator("textarea[aria-label='goal']")).toHaveValue(/.+/);
});

// ---------- NL intake: draft → edit → canonical objective ----------
test("v2 intake: draft → edit → explicit confirm → canonical objective created", async ({ page }) => {
  const biz = await mkBusiness(page, "obj");
  await seedBiz(page, biz.id);
  await page.goto("/app/new");
  await page.locator(".v2hero-in").fill(GOAL);
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await expect(page.locator(".draftwrap")).toBeVisible({ timeout: 15000 });
  await page.getByRole("radio", { name: /Objective — mục tiêu kinh doanh/ }).click();
  // owner edits before commit — edited field must carry its own provenance
  await page.locator("#dr-title").fill("Kế hoạch nội dung 30 ngày — đã chỉnh");
  await expect(page.locator(".pv-edited").first()).toBeVisible();
  await page.getByRole("button", { name: "Tạo Objective →" }).click();
  await expect(page.locator(".cdlg")).toBeVisible();
  await page.locator(".cdlg-f button.primary").click();
  // success state shows the canonical id from the real API
  await expect(page.locator(".pstate", { hasText: "Objective đã được tạo" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".pstate code")).toContainText(/^OBJ_/);
  // canonical truth: objective persisted under the selected business
  const list = await page.request.get(`/api/vnext/objectives?business_id=${biz.id}`, {
    headers: { authorization: `Bearer ${mcToken()}` },
  }).then((r) => r.json()) as { objectives: Array<Record<string, unknown>> };
  const created = list.objectives.find((o) => o.title === "Kế hoạch nội dung 30 ngày — đã chỉnh");
  expect(created, "objective persisted under the selected business").toBeTruthy();
  // deep link to the canonical detail page
  await page.getByRole("button", { name: /Mở Objective/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/objectives/${created!.objective_id}`));
});

// ---------- Intake fail-closed: no business ----------
test("v2 intake: objective path fails closed when no business selected", async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => localStorage.removeItem("pair.business_id"));
  await page.goto("/app/new");
  await page.locator(".v2hero-in").fill(GOAL);
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await expect(page.locator(".draftwrap")).toBeVisible({ timeout: 15000 });
  await page.getByRole("radio", { name: /Objective — mục tiêu kinh doanh/ }).click();
  await expect(page.getByRole("button", { name: "Tạo Objective →" })).toBeDisabled();
  await expect(page.locator(".dractions .hint")).toContainText(/chọn business/i);
});

// ---------- Intake numeric honesty: negative/invalid budget never silently dropped ----------
test("v2 intake: negative budget blocked — invalid values never silently dropped", async ({ page }) => {
  const biz = await mkBusiness(page, "negbudget");
  await seedBiz(page, biz.id);
  await page.goto("/app/new");
  await page.locator(".v2hero-in").fill(GOAL);
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await expect(page.locator(".draftwrap")).toBeVisible({ timeout: 15000 });
  await page.getByRole("radio", { name: /Objective — mục tiêu kinh doanh/ }).click();
  const budget = page.getByLabel("Ngân sách trần USD");
  const confirmBtn = page.getByRole("button", { name: "Tạo Objective →" });

  /* Finite-but-negative budgets used to pass validation then get dropped
     from the create body — now they block confirm with a stated reason. */
  for (const bad of ["-5", "-0.5", "abc", "Infinity", "1e999"]) {
    await budget.fill(bad);
    await expect(confirmBtn, `budget "${bad}" must block confirm`).toBeDisabled();
  }
  await expect(page.getByText(/Nhập số USD hợp lệ/)).toBeVisible();

  /* Empty = unset (allowed); zero and positive are explicit values that
     must actually reach the canonical create body — not be dropped. */
  await budget.fill("");
  await expect(confirmBtn).toBeEnabled();
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/vnext/objectives", async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue();
  });
  await budget.fill("25");
  await confirmBtn.click();
  await expect(page.locator(".cdlg")).toBeVisible();
  await page.locator(".cdlg-f button.primary").click();
  await expect(page.locator(".pstate", { hasText: "Objective đã được tạo" })).toBeVisible({ timeout: 15000 });
  expect(body).toBeTruthy();
  expect(body!.budget_ceiling_microusd, "positive budget reaches the canonical body as microusd").toBe(25_000_000);
  expect(body!.currency).toBe("USD");
});

// ---------- Intake fail-closed: analysis error never commits ----------
test("v2 intake: analyze failure shows error, creates nothing", async ({ page }) => {
  await page.route("**/api/v1/intake/draft", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "UNAUTHORIZED_MC_TOKEN" }) }));
  await seedSession(page);
  await page.goto("/app/new");
  await page.locator(".v2hero-in").fill(GOAL);
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await expect(page.locator(".pstate.err")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".pstate.err")).toContainText(/không phân tích được/i);
  await expect(page.locator(".draftwrap")).toHaveCount(0);
});

// ---------- Objective workspace tabs ----------
test("v2: objective detail owner tabs + deep link to Nâng cao", async ({ page }) => {
  const biz = await mkBusiness(page, "tabs");
  await apiPost(page, "/vnext/objectives", {
    business_id: biz.id,
    title: `v2-tabs-${uniq()}`,
    statement: "Produce deliverables.",
    kpis: [{ kpi_id: "k1", name: "deliverables", unit: "count", direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: "2030-12-31",
    budget_ceiling_microusd: 500000,
    owner_authority_id: `operator:${OP}`,
    dedup_key: `e2e-v2-${uniq()}`,
  });
  const list = await page.request.get(`/api/vnext/objectives?business_id=${biz.id}`, {
    headers: { authorization: `Bearer ${mcToken()}` },
  }).then((r) => r.json()) as { objectives: Array<Record<string, unknown>> };
  const oid = String(list.objectives[0].objective_id);
  await seedBiz(page, biz.id);
  await page.goto(`/app/objectives/${oid}`);
  for (const t of ["Tổng quan", "Kế hoạch", "Thực thi", "Kết quả", "Nâng cao"]) {
    await expect(page.getByRole("tab", { name: t })).toBeVisible();
  }
  // legacy cockpit sections stay reachable under Nâng cao
  await page.getByRole("tab", { name: "Nâng cao" }).click();
  await expect(page).toHaveURL(/tab=nang-cao/);
  // deep link lands directly on a tab
  await page.goto(`/app/objectives/${oid}?tab=ket-qua`);
  await expect(page.getByRole("tab", { name: "Kết quả" })).toHaveAttribute("aria-selected", "true");
});

// ---------- Layout / theme / keyboard ----------
test("v2: mobile 390×844 — rail hidden, bottom tabs, drawer reaches advanced", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedSession(page);
  await page.goto("/app/home");
  await expect(page.locator(".aside")).toBeHidden();
  await expect(page.locator(".atabbar")).toBeVisible();
  await expect(page.locator(".atabbar")).toContainText("Phê duyệt");
  await page.getByRole("button", { name: "more navigation" }).click();
  await expect(page.locator(".adrawer")).toBeVisible();
  // advanced destinations stay reachable on mobile
  await page.locator(".adrawer .anav a", { hasText: "Schedules" }).click();
  await expect(page).toHaveURL(/\/app\/system\/schedules/);
});

test("v2: dark + light themes render the owner cockpit", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/home");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "toggle theme" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("heading", { name: /Bạn muốn PairNext thực hiện điều gì/i })).toBeVisible();
});

test("v2: keyboard — skip link + VN nav focusable", async ({ page }) => {
  await seedSession(page);
  await page.goto("/app/home");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByRole("link", { name: "Phê duyệt" }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/inbox/);
});

// ---------- Blocker A: workstreams are suggestion-only ----------
test("v2 intake: analyzing a goal issues ZERO canonical creates — suggestion never writes", async ({ page }) => {
  const biz = await mkBusiness(page, "nowrite");
  const creates: string[] = [];
  await page.route("**/api/**", (route) => {
    const u = route.request().url();
    const m = route.request().method();
    /* The intake draft call itself is the only sanctioned POST; every
       other write surface is a violation. */
    if (m !== "GET" && !u.includes("/v1/intake/draft")) creates.push(`${m} ${u}`);
    return route.fallback();
  });
  await seedBiz(page, biz.id);
  await page.goto("/app/new");
  await page.locator(".v2hero-in").fill(GOAL);
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await expect(page.locator(".draftwrap")).toBeVisible();
  await expect(page.locator(".draftwrap")).toContainText("Bản nháp");
  expect(creates).toEqual([]);
});

test("v2 intake: workstream suggestions are honest — nothing persisted without owner confirm", async ({ page }) => {
  const biz = await mkBusiness(page, "wshint");
  /* Fixture response carrying workstreams — semantic OFF in e2e means
     the real server returns a manual draft without them, so the copy
     is verified against a shaped advisory payload. */
  await page.route("**/api/v1/intake/draft", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schema_version: "pair.intake-draft.v1",
        mode: "guarded",
        status: "analyzed",
        unavailable_reason: null,
        analysis_digest: "a".repeat(64),
        source_goal_sha: "g".repeat(64),
        provider_requests: 1,
        ambiguity_class: "TRIVIAL",
        items: [],
        draft: {
          suggested_kind: "objective",
          title: { value: "Test objective", provenance: "suggested" },
          statement: { value: "goal text", provenance: "explicit" },
          deadline: { value: null, provenance: "unresolved" },
          budget_ceiling_microusd: { value: null, provenance: "unresolved" },
          budget_hint: { value: null, provenance: "unresolved" },
          kpis: [],
          hard_constraints: [],
          success_conditions: [],
          workstreams: [
            { statement: "ws one", provenance: "suggested" },
            { statement: "ws two", provenance: "suggested" },
          ],
          questions: [],
        },
      }),
    }),
  );
  await seedBiz(page, biz.id);
  await page.goto("/app/new");
  await page.locator(".v2hero-in").fill(GOAL);
  await page.getByRole("button", { name: /Phân tích yêu cầu/ }).click();
  await expect(page.locator(".draftwrap")).toBeVisible();
  /* Honest copy: labeled suggestion-only, explicitly not persisted,
     explicitly not auto-created as work items. */
  await expect(page.getByText("Kế hoạch gợi ý")).toBeVisible();
  await expect(page.getByText(/KHÔNG được lưu hay tự tạo công việc/)).toBeVisible();
  await expect(page.getByText(/không tạo work item\/mission từ danh sách này/i)).toBeVisible();
  /* Objective path: confirm dialog discloses exactly what is persisted. */
  await page.getByRole("radio", { name: /Objective/ }).click();
  await page.getByRole("button", { name: "Tạo Objective →" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Kế hoạch gợi ý");
  await expect(page.getByRole("dialog")).toContainText("KHÔNG được lưu");
  await page.getByRole("button", { name: "Cancel" }).click();
  /* Mission path: only the goal statement travels. */
  await page.getByRole("radio", { name: /Mission/ }).click();
  await expect(page.getByText(/Chỉ nội dung mục tiêu được chuyển sang Task Entry/)).toBeVisible();
  await page.getByRole("button", { name: /Tiếp tục — xem trước kế hoạch Mission/ }).click();
  await expect(page).toHaveURL(/\/app\/missions\/new\?goal=goal%20text/);
});
