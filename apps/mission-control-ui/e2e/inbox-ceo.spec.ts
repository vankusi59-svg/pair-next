import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

/* P15.9-B4 — Owner Inbox + CEO Workspace. Real backend seeds where a
   public-API seed route exists; contract-shaped fixtures for pending
   reviews, truncation and the global approvals queue (no public seed
   route produces a PENDING approval row). */
const OP = "op:e2e";
const OWNER = "operator:op:e2e";

async function apiPost(page: Page, path: string, body: Record<string, unknown>) {
  const r = await page.request.post(`/api${path}`, {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
    data: body,
  });
  expect(r.ok(), `${path} -> ${r.status()}`).toBeTruthy();
  return r.json();
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

async function mkBusiness(page: Page, tag: string): Promise<string> {
  const prjs = (await page.request.get("/api/projects", {
    headers: { authorization: `Bearer ${mcToken()}`, "x-operator-id": OP },
  }).then((r) => r.json())) as Array<Record<string, unknown>>;
  const project_id = String(prjs[0]?.project_id ?? prjs[0]?.entity_id ?? "default");
  const b = await apiPost(page, "/businesses", {
    name: `e2e-b4-${tag}-${uniq()}`, project_id, description: "B4 e2e",
  });
  return String(b.business_id ?? b.entity_id);
}

async function mkObjective(page: Page, businessId: string, title: string, owner = OWNER) {
  const r = await apiPost(page, "/vnext/objectives", {
    business_id: businessId, title,
    statement: "Produce deliverables.",
    kpis: [{ kpi_id: "k_deliver", name: "deliverables", unit: "count", direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: "2030-12-31", budget_ceiling_microusd: 500000,
    owner_authority_id: owner,
    dedup_key: `e2e-b4-${uniq()}`,
  });
  return String(r.objective_id);
}

async function seedBiz(page: Page, bizId: string) {
  await seedSession(page);
  await page.addInitScript((id: string) => {
    localStorage.setItem("pair.business_id", id);
  }, bizId);
}

const companyFixture = (biz: string, objectives: Array<Record<string, unknown>>, counts: Record<string, number>, truncated = false) => ({
  company: {
    business: { business_id: biz, name: "Fixture Co", description: null, currency: "USD", status: "ACTIVE", project_id: "p", created_at: "2026-01-01T00:00:00Z" },
    objectives,
    objectives_total_owned: counts["objectives_owned"],
    objectives_truncated: truncated,
    counts,
  },
});

const reviewObj = (id: string, title: string, fresh: boolean, status = "RUNNING") => ({
  objective_id: id, title, status, deadline: null, created_at: "2026-01-01T00:00:00Z",
  budget: { ceiling_microusd: 1000000, consumed_microusd: 0, canonically_proven: true },
  kpi_summary: { total: 1, met: fresh ? 1 : 0, gap: fresh ? 0 : 1, unverified: 0, all_targets_met: fresh, canonically_proven: true },
  latest_review: {
    review_id: `r-${id}`, outcome: "TARGET_MET_CANDIDATE",
    owner_action_required: fresh, recommended_status: fresh ? "ACHIEVED" : null,
    created_at: "2026-06-01T00:00:00Z",
  },
  review_count: 1,
});

test.beforeEach(async ({ page }) => { await seedSession(page); });

/* ---------- Owner Inbox ---------- */

test("inbox: fresh pending reviews render with exact count; terminal stale pins never shown", async ({ page }) => {
  const biz = "BIZ_inbox_fix";
  /* R1-F4 — contract-consistent truncation fixture: 230 owned, 200
     returned, and 200 ACTUAL summary rows (backend bounds at 200).
     targets_met_pending=7 is the authoritative total over ALL owned
     objectives — including the 30 outside this returned page — so the
     exact total legitimately exceeds the fresh rows shown. */
  const objectives = [
    reviewObj("OBJ_p1", "Sign-off one", true),
    reviewObj("OBJ_p2", "Sign-off two", true),
    ...Array.from({ length: 198 }, (_, i) => reviewObj(`OBJ_h${i}`, `Hist ${i}`, false)),
  ];
  expect(objectives).toHaveLength(200);
  await page.route(`**/api/vnext/businesses/${biz}/company`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      companyFixture(biz, objectives, { objectives_owned: 230, objectives_returned: 200, targets_met_pending: 7 }, true),
    ) }));
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await expect(page.getByText("7 pending exact across all owned objectives")).toBeVisible();
  await expect(page.getByText(/partial/)).toBeVisible();
  // displayed pending rows = the fresh, returned subset only (2 of 200)
  await expect(page.locator(".need .nrow", { hasText: "fresh pin" })).toHaveCount(2);
  await expect(page.getByText("Sign-off one")).toBeVisible();
  await expect(page.getByText("Sign-off two")).toBeVisible();
  await expect(page.getByText("Hist 0")).toHaveCount(0); // historical flags never become pending rows
  // filter tabs truthful counts: review=7 exact, approval=0 loaded, halt=—
  await expect(page.getByRole("tab", { name: /^review/ })).toContainText("7");
  await expect(page.getByRole("tab", { name: /^approval/ })).toContainText("0");
  // A2: "Accept" is live when a canonical review is pinned (opens the
  // sign-off dialog); the owner-feedback seam stays honestly disabled.
  await expect(page.getByRole("button", { name: "Request changes (A2)" }).first()).toBeDisabled();
  await expect(page.getByTitle(/API_MISSING — owner feedback seam/).first()).toBeVisible();
});

test("inbox: adversarial terminal+flag row never renders as pending", async ({ page }) => {
  /* Impossible canonical combination (ACHIEVED + fresh
     owner_action_required) — kept in its own test, OUT of the
     contract-shaped fixtures. The lane must still fail closed and
     only show the genuinely fresh RUNNING row. */
  const biz = "BIZ_inbox_adv";
  await page.route(`**/api/vnext/businesses/${biz}/company`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      companyFixture(biz, [
        reviewObj("OBJ_ok", "Genuinely pending", true),
        reviewObj("OBJ_t", "Terminal flagged", true, "ACHIEVED"),
      ], { objectives_owned: 2, objectives_returned: 2, targets_met_pending: 2 }),
    ) }));
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await expect(page.getByText("Genuinely pending")).toBeVisible();
  await expect(page.getByText("Terminal flagged")).toHaveCount(0);
});

test("inbox: stale pending disappears after canonical flag flips", async ({ page }) => {
  const biz = "BIZ_inbox_flip";
  let fresh = true;
  await page.route(`**/api/vnext/businesses/${biz}/company`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      companyFixture(biz, [reviewObj("OBJ_f", "Was pending", fresh)],
        { objectives_owned: 1, objectives_returned: 1, targets_met_pending: fresh ? 1 : 0 }),
    ) }));
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await expect(page.getByText("Was pending")).toBeVisible();
  // canonical pin now stale → flag flips; remount refetches and it is gone
  fresh = false;
  await page.goto("/app/company");
  await page.goto("/app/inbox");
  await expect(page.getByText("Was pending")).toHaveCount(0);
  await expect(page.getByText("Nothing pending — fresh pin check is clean.")).toBeVisible();
});

test("inbox: global approvals labeled, approve+deny confirm → refetch; reject shows error", async ({ page }) => {
  const biz = await mkBusiness(page, "apr");
  await mkObjective(page, biz, `apr-${uniq()}`); // badge needs a succeeding company read (0-owned → 403)
  let approvals: Array<Record<string, unknown>> = [
    { approval_id: "APR_a1", mission_id: "MSN_x1", reason: "shell.write on ws:repo", requested_action: "shell.write", status: "PENDING", scope: { ws: "repo", op: "write" } },
    { approval_id: "APR_d1", mission_id: "MSN_x2", reason: "deploy prod", requested_action: "deploy", status: "PENDING", scope: { env: "prod" } },
  ];
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/approvals", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(approvals) });
    }
    return route.fallback();
  });
  await page.route("**/api/approvals/*/approve", async (route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    approvals = approvals.filter((a) => !route.request().url().includes(String(a.approval_id)));
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/approvals/*/deny", async (route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    approvals = approvals.filter((a) => !route.request().url().includes(String(a.approval_id)));
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await expect(page.getByText(/global queue.*not scoped to the selected business/i)).toBeVisible();
  await expect(page.locator(".need .tt", { hasText: "APR_a1" })).toBeVisible();
  // R1-F1 — badge converges from canonical refetch: 2 → 1 → 0 (no
  // optimistic local decrement; aria-live region announces updates)
  const badge = page.locator(".aside .ibadge-live");
  await expect(badge).toHaveAttribute("aria-live", "polite");
  await expect(badge).toHaveText("2");
  // approve with PINNED scope — dialog shows read-only decision context
  await page.getByRole("button", { name: "Approve" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("APR_a1");
  await expect(dlg).toContainText("MSN_x1");
  await expect(dlg).toContainText("requests shell.write");
  await expect(dlg).toContainText('{"ws":"repo","op":"write"}');
  // duplicate-submit protection: a real double-click on confirm still
  // produces exactly ONE POST (first click commits + unmounts the dialog)
  await dlg.getByRole("button", { name: "Approve" }).dblclick();
  await expect(page.locator(".trunc")).toContainText("approve committed");
  await expect(page.locator(".need .tt", { hasText: "APR_a1" })).toHaveCount(0);
  await expect(badge).toHaveText("1"); // badge refetched canonical — converged
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toContain("/api/approvals/APR_a1/approve");
  expect(posts[0]!.body.scope).toEqual({ ws: "repo", op: "write" });
  // deny the second
  await page.getByRole("button", { name: "Deny" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Deny" }).click();
  await expect(page.locator(".trunc")).toContainText("deny committed");
  expect(posts).toHaveLength(2);
  expect(posts[1]!.url).toContain("/deny");
  await expect(page.getByText("No pending approvals")).toBeVisible();
  await expect(badge).toHaveText("0");
});

test("inbox: empty {} scope is valid and posted verbatim", async ({ page }) => {
  const biz = await mkBusiness(page, "apr-empty");
  const posts: Array<Record<string, unknown>> = [];
  await page.route("**/api/approvals", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
        { approval_id: "APR_e", mission_id: "MSN_e", reason: "x", status: "PENDING", scope: {}, scope_digest: "dg0" },
      ]) });
    }
    return route.fallback();
  });
  await page.route("**/api/approvals/*/approve", (route) => {
    posts.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: "Approve" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText('{}');               // valid empty scope shown, not "missing"
  await expect(dlg).not.toContainText("MISSING");
  await dlg.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".trunc")).toContainText("approve committed");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.scope).toEqual({});                 // posted verbatim — never reconstructed
});

test("inbox: missing/malformed canonical scope fails closed — confirm disabled, zero POSTs", async ({ page }) => {
  const biz = await mkBusiness(page, "apr-noscope");
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { approval_id: "APR_missing", mission_id: "MSN_m", reason: "x", status: "PENDING" },              // no scope key
      { approval_id: "APR_bad", mission_id: "MSN_b", reason: "y", status: "PENDING", scope: "notanobj" }, // malformed
    ]) }));
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  for (const label of ["Approve", "Deny"]) {
    await page.getByRole("button", { name: label }).first().click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("MISSING / MALFORMED");
    await expect(dlg).toContainText("fail closed");
    await expect(dlg.getByRole("button", { name: label })).toBeDisabled(); // never substitutes {}
    await dlg.getByRole("button", { name: "Cancel" }).click();
  }
  await page.waitForTimeout(300);
  expect(posts.filter((u) => u.includes("/api/approvals/"))).toEqual([]);
});

test("inbox: row vanished after dialog open — confirm still posts the PINNED scope", async ({ page }) => {
  const biz = await mkBusiness(page, "apr-vanish");
  let approvals: Array<Record<string, unknown>> = [
    { approval_id: "APR_v", mission_id: "MSN_v", reason: "x", status: "PENDING", scope: { pinned: "yes" } },
  ];
  const posts: Array<Record<string, unknown>> = [];
  await page.route("**/api/approvals", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(approvals) });
    }
    return route.fallback();
  });
  await page.route("**/api/approvals/*/approve", (route) => {
    posts.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "ALREADY_RESOLVED", detail: "resolved elsewhere" }) });
  });
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("dialog")).toContainText('{"pinned":"yes"}');
  approvals = []; // row vanished from the canonical queue after the dialog opened
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".trunc")).toContainText("approve failed"); // backend is authoritative — rejection surfaces
  expect(posts).toHaveLength(1);
  expect(posts[0]!.scope).toEqual({ pinned: "yes" }); // pinned at open — never re-read or broadened
});

test("inbox: badge failure states — unavailable on failed read, partial without business", async ({ page }) => {
  // failed approvals read → badge is unavailable (!), never a fake zero
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await page.goto("/app/company");
  await expect(page.locator(".aside .ibadge-live")).toHaveText("!");
});

test("mobile: inbox badge on tab bar — count, partial and failure states", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const biz = await mkBusiness(page, "mob");
  await mkObjective(page, biz, `mob-${uniq()}`); // company read must succeed for a proven count
  let rows: Array<Record<string, unknown>> = [
    { approval_id: "APR_m1", status: "PENDING", scope: {} },
    { approval_id: "APR_m2", status: "PENDING", scope: {} },
  ];
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }));
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  const tab = page.locator(".atabbar");
  await expect(tab).toBeVisible();
  const badge = tab.locator(".ibadge-live");
  await expect(badge).toHaveAttribute("aria-live", "polite");
  await expect(badge).toHaveText("2"); // same canonical count as desktop — one shared provider
  // desktop and mobile render the SAME resolved state (one provider)
  await expect(page.locator(".aside .ibadge-live")).toHaveText(await badge.textContent() ?? "");
  // partial state: a fresh page WITHOUT a business selection → the
  // approvals-only count renders with the + partial marker
  const p2 = await page.context().newPage();
  await p2.setViewportSize({ width: 390, height: 800 });
  await p2.addInitScript(() => localStorage.removeItem("pair.business_id"));
  await p2.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }));
  await p2.goto("/app/inbox");
  await expect(p2.locator(".atabbar .ibadge-live")).toHaveText("2+");
  // failure state: failed read → unavailable, never a fake zero
  await p2.unroute("**/api/approvals");
  await p2.route("**/api/approvals", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await p2.reload();
  await expect(p2.locator(".atabbar .ibadge-live")).toHaveText("!");
  await p2.close();
});

test("badge: business-bound counts — A's count never renders under B; late A cannot overwrite", async ({ page }) => {
  const bizA = "BIZ_badge_a";
  const bizB = await mkBusiness(page, "badge-b");
  await mkObjective(page, bizB, `bgb-${uniq()}`);
  let delayA = 0;
  await page.route(`**/api/vnext/businesses/${bizA}/company`, async (route) => {
    if (delayA) await new Promise((r) => setTimeout(r, delayA));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      companyFixture(bizA, [reviewObj("OBJ_a", "A pending", true)],
        { objectives_owned: 9, objectives_returned: 1, targets_met_pending: 9 }, true),
    ) });
  });
  // bizB: real company → 1 objective, 0 pending reviews; 1 pending approval below → badge 1
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { approval_id: "APR_b", status: "PENDING", scope: {} },
    ]) }));
  await seedBiz(page, bizA);
  await page.goto("/app/inbox");
  const badge = page.locator(".aside .ibadge-live");
  await expect(badge).toHaveText("10"); // 9 pending + 1 approval

  // switch A→B: the A-bound count must never paint under B
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill(bizB);
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(badge).not.toHaveText("10");
  await expect(badge).toHaveText("1"); // B's fresh canonical count

  // delayed A response can never overwrite B either: reselect A with a
  // 500ms-late company response, switch to B before it resolves
  delayA = 500;
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill(bizA);
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill(bizB);
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(badge).toHaveText("1");
  await page.waitForTimeout(700); // A's response lands late — must not overwrite
  await expect(badge).toHaveText("1");
});

test("badge: invalidation generation — stale count hidden during refetch; failed refetch → unavailable", async ({ page }) => {
  const biz = await mkBusiness(page, "badge-iv");
  await mkObjective(page, biz, `biv-${uniq()}`);
  let delayRefetch = 0;
  let approvals: Array<Record<string, unknown>> = [
    { approval_id: "APR_1", status: "PENDING", scope: {} },
    { approval_id: "APR_2", status: "PENDING", scope: {} },
  ];
  await page.route("**/api/approvals", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (delayRefetch) await new Promise((r) => setTimeout(r, delayRefetch));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(approvals) });
  });
  await page.route("**/api/approvals/*/approve", (route) => {
    approvals = approvals.filter((a) => a.approval_id !== "APR_1");
    delayRefetch = 400; // slow canonical refetch AFTER the mutation
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  const badge = page.locator(".aside .ibadge-live");
  await expect(badge).toHaveText("2");
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".trunc")).toContainText("approve committed");
  await expect(badge).not.toHaveText("2");  // previous generation hidden during refetch
  await expect(badge).toHaveText("1");      // then fresh canonical count

  // failed refetch → unavailable, never stale-or-zero: invalidate via
  // a second successful mutation while GET /api/approvals now fails
  delayRefetch = 0;
  await page.route("**/api/approvals/*/approve", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/api/approvals", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".trunc")).toContainText("approve committed");
  await expect(badge).toHaveText("!");
});

test("badge: ABA reuse — stale A resolution never repaints across lifecycle generations", async ({ page }) => {
  const bizA = "BIZ_aba_a";
  const bizB = "BIZ_aba_b";
  let pendA = 9;
  let delayB = 0;
  let approvals: Array<Record<string, unknown>> = [{ approval_id: "APR_a", status: "PENDING", scope: {} }];
  await page.route(`**/api/vnext/businesses/${bizA}/company`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      companyFixture(bizA, [reviewObj("OBJ_a", "A pending", true)],
        { objectives_owned: pendA, objectives_returned: 1, targets_met_pending: pendA }, true),
    ) }));
  await page.route(`**/api/vnext/businesses/${bizB}/company`, async (route) => {
    if (delayB) await new Promise((r) => setTimeout(r, delayB));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      companyFixture(bizB, [reviewObj("OBJ_b", "B pending", true)],
        { objectives_owned: 1, objectives_returned: 1, targets_met_pending: 1 }),
    ) });
  });
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(approvals) }));
  await seedBiz(page, bizA);
  await page.goto("/app/inbox");
  const badge = page.locator(".aside .ibadge-live");
  const mbadge = page.locator(".atabbar .ibadge-live");
  await expect(badge).toHaveText("10"); // A: 9 pending + 1 approval

  // canonical approval data changes mid-flight; A's next read must show NEW data
  approvals = [];
  pendA = 8;
  delayB = 600;

  // A→B with B delayed
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill(bizB);
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(badge).not.toHaveText("10");
  // B→A BEFORE B resolves — old A resolution (forReq=0) must never repaint
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill(bizA);
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(badge).not.toHaveText("10");
  // converges to A's NEWLY returned canonical count (8 pending + 0 approvals)
  await expect(badge).toHaveText("8");
  // late B response lands now — can never overwrite A's newer lifecycle
  await page.waitForTimeout(800);
  await expect(badge).toHaveText("8");
  // desktop and mobile render the same bound state
  expect(await mbadge.textContent()).toBe(await badge.textContent());
});

test("inbox: approval rejection reports error without optimistic resolve", async ({ page }) => {
  const biz = await mkBusiness(page, "apr-rej");
  await page.route("**/api/approvals", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
        { approval_id: "APR_r", mission_id: "MSN_r", reason: "x", status: "PENDING", scope: {} },
      ]) });
    }
    return route.fallback();
  });
  await page.route("**/api/approvals/*/approve", (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "ALREADY_RESOLVED", detail: "resolved elsewhere" }) }));
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".trunc")).toContainText("approve failed");
  await expect(page.locator(".need .tt", { hasText: "APR_r" })).toBeVisible(); // still pending — not optimistically resolved
});

test("inbox: approvals 401 → credential state, no prompt, no reload", async ({ page }) => {
  const biz = await mkBusiness(page, "apr401");
  let prompted = false;
  page.on("dialog", () => { prompted = true; });
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "UNAUTHORIZED", detail: "bad token" }) }));
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await expect(page.getByText(/credentials were rejected/)).toBeVisible();
  expect(prompted).toBe(false);
  await expect(page.getByRole("tab", { name: /^approval/ })).toContainText("?");
});

test("inbox: HALT lane is API_MISSING — never a fabricated count", async ({ page }) => {
  const biz = await mkBusiness(page, "halt-lane");
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await expect(page.getByText("HALT aggregation unavailable — API_MISSING")).toBeVisible();
  await expect(page.getByRole("tab", { name: /^halt/ })).toContainText("—");
  await page.getByRole("tab", { name: /^halt/ }).click();
  await expect(page.getByRole("link", { name: "open objectives →" })).toBeVisible();
});

test("inbox: no business → reviews lane honest; global approvals still work", async ({ page }) => {
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { approval_id: "APR_nb", mission_id: "MSN_n", reason: "x", status: "PENDING", scope: {} },
    ]) }));
  await page.goto("/app/inbox");
  await expect(page.locator(".pstate .t").first()).toHaveText("No business selected");
  await expect(page.locator(".need .tt", { hasText: "APR_nb" })).toBeVisible(); // lack of business ≠ empty queue
});

test("inbox: business switch clears stale pending rows", async ({ page }) => {
  const bizA = "BIZ_inbox_a";
  const bizB = await mkBusiness(page, "inbox-b");
  await mkObjective(page, bizB, `inb-${uniq()}`);
  await page.route(`**/api/vnext/businesses/${bizA}/company`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      companyFixture(bizA, [reviewObj("OBJ_x", "Pending A", true)], { objectives_owned: 1, objectives_returned: 1, targets_met_pending: 1 }),
    ) }));
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await seedBiz(page, bizA);
  await page.goto("/app/inbox");
  await expect(page.getByText("Pending A", { exact: true })).toBeVisible();
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill(bizB);
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(page.getByText("Pending A", { exact: true })).toHaveCount(0);
  await expect(page.getByText("0 pending exact across all owned objectives")).toBeVisible();
});

test("inbox: read renders no unintended POSTs", async ({ page }) => {
  const biz = await mkBusiness(page, "read-only");
  const writes: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET") writes.push(r.url()); });
  await seedBiz(page, biz);
  await page.goto("/app/inbox");
  await expect(page.getByRole("heading", { name: "Owner Inbox" })).toBeVisible();
  await expect(page.getByText("No pending approvals")).toBeVisible();
  expect(writes).toEqual([]);
});

/* ---------- CEO Workspace ---------- */

test("ceo: selector scoped to owned objectives; cockpit projection renders", async ({ page }) => {
  const biz = await mkBusiness(page, "ceo");
  const o1 = await mkObjective(page, biz, `ceo1-${uniq()}`);
  await mkObjective(page, biz, `ceo2-${uniq()}`);
  const foreign = await mkBusiness(page, "ceo-f");
  const fo = await mkObjective(page, foreign, `foreign-${uniq()}`, "operator:someone-else");
  await seedBiz(page, biz);
  await page.goto("/app/ceo");
  const sel = page.getByLabel("objective selector");
  await expect(sel).toBeVisible();
  const options = await sel.locator("option").allTextContents();
  expect(options.length).toBe(3); // placeholder + 2 owned
  expect(options.join(" ")).not.toContain(fo);
  await sel.selectOption(o1);
  await expect(page).toHaveURL(new RegExp(`objective=${o1}`));
  await expect(page.getByText("No canonical plan binding yet")).toBeVisible();
  await expect(page.getByText("No reviews yet.")).toBeVisible();
  await expect(page.getByText(/full decision browsing: API_MISSING/)).toBeVisible();
  await expect(page.getByRole("link", { name: "objective detail →" })).toBeVisible();
});

test("ceo: workstreams + review timeline from canonical projections (fixtures)", async ({ page }) => {
  const biz = "BIZ_ceo_fix";
  const oid = "OBJ_ceo1";
  await page.route(`**/api/vnext/businesses/${biz}/company`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      companyFixture(biz, [reviewObj(oid, "CEO obj", false)],
        { objectives_owned: 1, objectives_returned: 1, targets_met_pending: 0 }),
    ) }));
  await page.route(`**/api/vnext/objectives/${oid}/cockpit`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      cockpit: {
        objective: { objective_id: oid, business_id: biz, status: "RUNNING", title: "ceo fixture", statement: null, description: null, owner_authority_id: OWNER, deadline: null, currency: "USD", terms_version: 1, version: 1, created_at: "2026-10-10T00:00:00Z",
          budget_ceiling_microusd: 500000, budget_consumed_microusd: 0 },
        lifecycle: { objective_status: "RUNNING", all_targets_met: false, latest_review_outcome: "WAIT", owner_action_required: false, recommended_status: "CONTINUE" },
        observation_error: null,
        kpi_summary: { all_targets_met: false, verified_kpi_count: 1, unverified_kpi_count: 0, gap_kpi_count: 1 },
        workstreams: [{ workstream_key: "wsA", work_item_id: "WI-A", workstream_status: "IN_PROGRESS", completion_proven: false, allocation_state: "ALLOCATED", selected_agent_id: "agent-x", delegated_child: { work_item_id: "DL-A", status: "IN_PROGRESS", completion_proven: false, bound_mission: true, lifecycle_class: "DELEGATED", mission: { mission_id: "MSN_c1", status: "RUNNING", runtime_state: "WORKING", bound_open_id: "OPEN-1" } } }],
        observer: { active: 0, intervention: 0, exhausted: 0 },
        missions: [{ mission_id: "MSN_c1", status: "RUNNING", runtime_state: "WORKING", bound_open_id: "OPEN-1" }],
        artifacts: [], artifacts_truncated: false, artifacts_dropped_unverified: 0,
        latest_review: { review_id: "REV-l", outcome: "WAIT", owner_action_required: false, recommended_status: "CONTINUE", wait_reason: "wsA in flight", binding_id: "BND-1", review_observation_digest: "dg", source_ceo_decision_id: "DEC-7", strategy_revision_id: "SR-3", all_targets_met: false, verified_kpi_count: 1, unverified_kpi_count: 0, gap_kpi_count: 1, created_by: "ceo", created_at: "2026-10-10T00:00:00Z" },
        review_count: 1, auto_policy: null, auto_driver: null,
      },
    }) }));
  await page.route(`**/api/vnext/objectives/${oid}/reviews*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      reviews: [
        { review_id: "REV-2", outcome: "WAIT", owner_action_required: false, recommended_status: "CONTINUE", wait_reason: "wsA in flight", binding_id: "BND-1", review_observation_digest: "dg2", source_ceo_decision_id: "DEC-7", strategy_revision_id: "SR-3", all_targets_met: false, verified_kpi_count: 1, unverified_kpi_count: 0, gap_kpi_count: 1, created_by: "ceo", created_at: "2026-10-10T02:00:00Z" },
        { review_id: "REV-1", outcome: "GAP", owner_action_required: false, recommended_status: null, wait_reason: null, binding_id: "BND-1", review_observation_digest: "dg1", source_ceo_decision_id: "DEC-6", strategy_revision_id: "SR-2", all_targets_met: false, verified_kpi_count: 0, unverified_kpi_count: 0, gap_kpi_count: 1, created_by: "ceo", created_at: "2026-10-09T02:00:00Z" },
      ],
      total: 2, returned: 2, truncated: false,
    }) }));
  await seedBiz(page, biz);
  await page.goto(`/app/ceo?objective=${oid}`);
  await expect(page.locator(".need .tt", { hasText: "wsA" })).toBeVisible();
  await expect(page.getByText("agent-x")).toBeVisible();
  await expect(page.getByText(/DL-A IN_PROGRESS/)).toBeVisible();
  await expect(page.getByText("rev SR-3")).toBeVisible();
  await expect(page.getByText("MSN_c1", { exact: false }).first()).toBeVisible();
  // timeline newest-first, decision refs + historical flag labeled
  const first = page.locator(".rvrow").first();
  await expect(first).toContainText("REV-2");
  await expect(first).toContainText("DEC-7");
  await expect(first).toContainText("(historical)");
  // no auto pass on load
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
  await page.waitForTimeout(400);
  expect(posts.filter((u) => u.includes("ceo-cycle"))).toEqual([]);
});

test("ceo: manual pass — confirm dialog, distinct result panel, refetch", async ({ page }) => {
  const biz = await mkBusiness(page, "ceo-pass");
  const oid = await mkObjective(page, biz, `ceop-${uniq()}`);
  let cockpitReads = 0;
  page.on("request", (r) => { if (r.url().includes(`/vnext/objectives/${oid}/cockpit`)) cockpitReads++; });
  await page.route(`**/api/vnext/objectives/${oid}/ceo-cycle`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      outcome: "DISPATCHED_MISSION", objective_id: oid, mission_id: "MSN_pass1",
      ceo_decision_id: "DEC_pass1", strategy_revision_id: "SR_p1", review_id: "REV_p1",
    }) }));
  await seedBiz(page, biz);
  await page.goto(`/app/ceo?objective=${oid}`);
  await page.getByRole("button", { name: "Run CEO pass" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // double-click on confirm still produces exactly one POST (first
  // click commits + unmounts the dialog)
  await page.getByRole("dialog").getByRole("button", { name: "Run CEO pass" }).dblclick();
  await expect(page.getByText("CEO pass committed — invocation result shown below")).toBeVisible();
  // invocation result is a distinct surface — never a review outcome
  const passPanel = page.getByLabel("latest pass invocation result");
  await expect(passPanel.getByText("DISPATCHED_MISSION")).toBeVisible();
  await expect(passPanel).toContainText("MSN_pass1");
  await expect(passPanel).toContainText("API_MISSING");
  await expect(passPanel).toContainText("DEC_pass1");
  // projections refetched after commit
  expect(cockpitReads).toBeGreaterThanOrEqual(2);
});

test("ceo: in-flight pass result cannot pollute another objective", async ({ page }) => {
  const biz = await mkBusiness(page, "ceo-inf");
  const o1 = await mkObjective(page, biz, `infc1-${uniq()}`);
  const o2 = await mkObjective(page, biz, `infc2-${uniq()}`);
  await page.route(`**/api/vnext/objectives/${o1}/ceo-cycle`, async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "WAIT", objective_id: o1 }) });
  });
  await seedBiz(page, biz);
  await page.goto(`/app/ceo?objective=${o1}`);
  await page.getByRole("button", { name: "Run CEO pass" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Run CEO pass" }).click();
  await page.getByLabel("objective selector").selectOption(o2);
  await page.waitForTimeout(1200);
  await expect(page.getByText("CEO pass committed")).toHaveCount(0);
  await expect(page.getByText("DISPATCHED")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run CEO pass" })).toBeEnabled();
});

test("ceo: foreign objective id via deep link → denied, never rendered", async ({ page }) => {
  const biz = await mkBusiness(page, "ceo-deny");
  const foreign = await mkBusiness(page, "ceo-denyf");
  const fo = await mkObjective(page, foreign, `fobj-${uniq()}`, "operator:someone-else");
  await seedBiz(page, biz);
  await page.goto(`/app/ceo?objective=${fo}`);
  await expect(page.getByText("Access denied")).toBeVisible();
});
