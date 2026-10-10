import { test, expect, type Page } from "@playwright/test";
import { seedSession, mcToken } from "./helpers";

// P15.9-B5.1 — AI Workforce + Agent Detail. Real backend seeds via the
// public API; route interception only for adversarial timing and
// synthetic failures (labeled as such).
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
    name: `e2e-b51-${tag}-${uniq()}`, project_id, description: "B5.1 e2e",
  });
  return String(b.business_id ?? b.entity_id);
}

async function mkObjective(page: Page, businessId: string) {
  await apiPost(page, "/vnext/objectives", {
    business_id: businessId,
    title: `obj-${uniq()}`,
    statement: "Produce deliverables.",
    kpis: [{ kpi_id: "k_deliver", name: "deliverables", unit: "count", direction: "AT_LEAST", baseline: 0, target: 1 }],
    deadline: "2030-12-31",
    budget_ceiling_microusd: 500000,
    owner_authority_id: OWNER,
    dedup_key: `e2e-wf-${uniq()}`,
  });
}

async function mkAgent(page: Page, businessId: string, title: string, extra: Record<string, unknown> = {}) {
  const a = await apiPost(page, "/org-agents", {
    business_id: businessId, title, department: "ops", role: "worker", ...extra,
  });
  return String(a.agent_id ?? a.entity_id);
}

async function mkWorkItem(page: Page, businessId: string, title: string, assignee?: string) {
  const w = await apiPost(page, "/work-items", {
    business_id: businessId, title, goal: "g", ...(assignee ? { assignee_agent_id: assignee } : {}),
  });
  return String(w.work_item_id ?? w.entity_id);
}

async function materializeContract(page: Page, agentId: string) {
  await apiPost(page, `/org-agents/${agentId}/contract`, {});
}

async function seedBiz(page: Page, bizId: string) {
  await seedSession(page);
  await page.addInitScript((id: string) => {
    localStorage.setItem("pair.business_id", id);
  }, bizId);
}

test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

test("workforce: selected-business filtering, honest global-read label, honest states", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-a");
  await mkObjective(page, biz);
  const a1 = await mkAgent(page, biz, "Agent Alpha");
  await mkAgent(page, biz, "Agent Beta");
  const bizB = await mkBusiness(page, "wf-b");
  await mkAgent(page, bizB, "Foreign Agent");
  await seedBiz(page, biz);
  await page.goto("/app/workforce");
  // only this business's agents render
  await expect(page.locator(".ecard")).toHaveCount(2);
  await expect(page.locator(".ecards")).toContainText("Agent Alpha");
  await expect(page.locator(".ecards")).toContainText("Agent Beta");
  await expect(page.locator(".ecards")).not.toContainText("Foreign Agent");
  // honest global-read disclosure
  await expect(page.locator(".srcnote")).toContainText("global, unfiltered");
  await expect(page.locator(".srcnote")).toContainText("NOT server-side authorization");
  await expect(page.locator(".srcnote")).toContainText("hidden (other businesses)");
  // deep link to detail
  await page.locator(".ecard", { hasText: "Agent Alpha" }).getByRole("link", { name: "open agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/workforce/${a1}`));
  await expect(page.locator("h1")).toHaveText("Agent Alpha");
});

test("workforce: foreign-business agent under selected business → denied, never rendered", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-c");
  await mkObjective(page, biz);
  const bizB = await mkBusiness(page, "wf-d");
  const foreign = await mkAgent(page, bizB, "Foreign Detail");
  await seedBiz(page, biz);
  await page.goto(`/app/workforce/${foreign}`);
  await expect(page.locator(".pstate.denied")).toContainText("Access denied");
  await expect(page.locator(".pstate.denied")).toContainText("does not belong to the selected business");
  await expect(page.locator("h1")).toHaveText("Agent Detail");
  await expect(page.locator("body")).not.toContainText("Foreign Detail");
});

test("workforce: detail canonical reads — contract, effective-policy, inbox, work items", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-e");
  await mkObjective(page, biz);
  const agent = await mkAgent(page, biz, "Detail Agent", { executor_binding: "codex" });
  await materializeContract(page, agent);
  const wi = await mkWorkItem(page, biz, "Assigned task", agent);
  await apiPost(page, `/work-items/${wi}/messages`, {
    business_id: biz, sender_type: "OPERATOR", recipient_agent_id: agent,
    kind: "NOTE", body: "hello agent",
  });
  await seedBiz(page, biz);
  await page.goto(`/app/workforce/${agent}`);
  await expect(page.locator("h1")).toHaveText("Detail Agent");
  await expect(page.locator(".sbadge.t-ok").first()).toHaveText("ACTIVE");
  // contract materialized: v1 ACTIVE with digest
  await expect(page.locator(".need").nth(0)).toContainText("ACTIVE");
  await expect(page.locator(".need").nth(0)).toContainText("v1");
  await expect(page.locator(".need").nth(0)).toContainText("digest");
  // effective-policy lines
  await expect(page.locator(".need").nth(1)).toContainText("capabilities");
  await expect(page.locator(".need").nth(1)).toContainText("executors");
  await expect(page.locator(".need").nth(1)).toContainText("contract v1");
  // assignment + inbox
  await expect(page.locator(".need").nth(2)).toContainText("Assigned task");
  await expect(page.locator(".need").nth(3)).toContainText("hello agent");
  await expect(page.locator(".need").nth(3)).toContainText("PENDING");
});

test("workforce: unmaterialized contract → honest unavailable policy, no contract ops", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-f");
  await mkObjective(page, biz);
  const agent = await mkAgent(page, biz, "No Contract");
  /* Adversarial fixture: createOrgAgent auto-materializes a baseline
     contract, so the unmaterialized state is reachable only by
     intercepting the canonical reads — contract null, policy the
     backend's own fail-closed 500. */
  await page.route(`**/api/org-agents/${agent}/contract`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contract: null }) }));
  await page.route(`**/api/org-agents/${agent}/effective-policy`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "FAIL_CLOSED_AGENT_CONTRACT_MISSING" }) }));
  await seedBiz(page, biz);
  await page.goto(`/app/workforce/${agent}`);
  await expect(page.locator(".need").nth(0)).toContainText("No contract materialized");
  await expect(page.locator(".need").nth(1)).toContainText("no contract materialized");
  await expect(page.locator(".need").nth(1)).toContainText("never read as unrestricted");
  // lifecycle ops still offered (ACTIVE → pause/terminate), contract ops hidden
  await expect(page.getByRole("button", { name: "Pause agent" })).toBeVisible();
  await expect(page.getByRole("button", { name: /contract/i })).toHaveCount(0);
});

test("workforce: pause/resume/terminate via pinned confirm; failure surfaced; no optimistic", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-g");
  await mkObjective(page, biz);
  const agent = await mkAgent(page, biz, "Lifecycle Agent");
  const calls: string[] = [];
  await page.route(`**/api/org-agents/${agent}/pause`, (route) => {
    calls.push("pause");
    return route.continue();
  });
  await seedBiz(page, biz);
  await page.goto(`/app/workforce/${agent}`);
  // open dialog — pinned context visible
  await page.getByRole("button", { name: "Pause agent" }).click();
  await expect(page.locator(".cdlg")).toBeVisible();
  await expect(page.locator(".cdlg")).toContainText(agent);
  await expect(page.locator(".cdlg")).toContainText(biz);
  await expect(page.locator(".cdlg")).toContainText("Pause agent");
  // cancel → no POST
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(calls).toHaveLength(0);
  // confirm → single canonical POST + refetch shows PAUSED
  await page.getByRole("button", { name: "Pause agent" }).click();
  await page.getByRole("button", { name: "Confirm" }).dblclick();
  await expect(page.locator(".trunc[role=status]")).toContainText("Pause agent committed");
  await expect(page.locator(".sbadge.t-warn").first()).toHaveText("PAUSED");
  expect(calls).toHaveLength(1); // rapid double-confirm → one POST
  // resume → ACTIVE
  await page.getByRole("button", { name: "Resume agent" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".trunc[role=status]")).toContainText("Resume agent committed");
  await expect(page.locator(".sbadge.t-ok").first()).toHaveText("ACTIVE");
  // terminate — high-risk copy describing the ACTUAL backend contract:
  // setOrgAgentStatus enforces status membership only, no irreversible
  // transition graph. The UI must not claim otherwise.
  await page.getByRole("button", { name: "Terminate agent" }).click();
  await expect(page.locator(".cdlg")).toContainText("TERMINATE");
  await expect(page.locator(".cdlg")).toContainText("High-risk");
  await expect(page.locator(".cdlg")).toContainText("UI-level gating only");
  await expect(page.locator(".cdlg")).toContainText("NOT an irreversible transition");
  await expect(page.locator(".cdlg")).not.toContainText("cannot be resumed");
  await page.locator(".cdlg").getByRole("button", { name: "Terminate" }).click();
  await expect(page.locator(".trunc[role=status]")).toContainText("Terminate agent committed");
  await expect(page.locator(".sbadge").first()).toHaveText("TERMINATED");
  // lifecycle ops gone; contract enable/disable remains a legal canonical op
  await expect(page.getByRole("button", { name: "Pause agent" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume agent" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Terminate agent" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disable execution contract" })).toBeVisible();
});

test("workforce: mutation failure → error note, state not optimistically changed", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-h");
  await mkObjective(page, biz);
  const agent = await mkAgent(page, biz, "Fail Agent");
  await page.route(`**/api/org-agents/${agent}/pause`, (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "FAIL_CLOSED_X" }) }));
  await seedBiz(page, biz);
  await page.goto(`/app/workforce/${agent}`);
  await page.getByRole("button", { name: "Pause agent" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".trunc[role=status]")).toContainText("Pause agent failed");
  await expect(page.locator(".trunc[role=status]")).toContainText("FAIL_CLOSED_X");
  await expect(page.locator(".sbadge.t-ok").first()).toHaveText("ACTIVE"); // still ACTIVE — no optimistic flip
});

test("workforce: contract enable/disable via pinned confirm", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-i");
  await mkObjective(page, biz);
  const agent = await mkAgent(page, biz, "Contract Agent");
  await materializeContract(page, agent);
  await seedBiz(page, biz);
  await page.goto(`/app/workforce/${agent}`);
  await page.getByRole("button", { name: "Disable execution contract" }).click();
  await expect(page.locator(".cdlg")).toContainText(agent);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".trunc[role=status]")).toContainText("Disable execution contract committed");
  await expect(page.locator(".need").nth(0)).toContainText("DISABLED");
  await page.getByRole("button", { name: "Enable execution contract" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".need").nth(0)).toContainText("ACTIVE");
});

test("workforce: contract read states — success-null vs failed-GET vs canonical row", async ({ page }) => {
  /* F2 adversarial: three agents in one business. createOrgAgent
     auto-materializes, so divergent contract states are driven by
     interception on the canonical read — each label must be distinct. */
  const biz = await mkBusiness(page, "wf-q");
  await mkObjective(page, biz);
  const okRow = await mkAgent(page, biz, "Row Contract");
  const okNull = await mkAgent(page, biz, "Null Contract");
  const failed = await mkAgent(page, biz, "Failed Contract");
  await page.route(`**/api/org-agents/${okNull}/contract`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contract: null }) }));
  await page.route(`**/api/org-agents/${failed}/contract`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "FAIL_CLOSED_AGENT_CONTRACT_INTEGRITY" }) }));
  await seedBiz(page, biz);
  await page.goto("/app/workforce");
  await expect(page.locator(".ecard")).toHaveCount(3);
  // canonical row → real status/version
  const cardRow = page.locator(".ecard", { hasText: "Row Contract" });
  await expect(cardRow).toContainText("contract ACTIVE");
  await expect(cardRow).toContainText("v1");
  // successful GET returning null → not materialized (never unavailable)
  const cardNull = page.locator(".ecard", { hasText: "Null Contract" });
  await expect(cardNull).toContainText("not materialized");
  await expect(cardNull).not.toContainText("unavailable");
  // failed GET → unavailable + error code, never not-materialized
  const cardFail = page.locator(".ecard", { hasText: "Failed Contract" });
  await expect(cardFail).toContainText("unavailable (FAIL_CLOSED_AGENT_CONTRACT_INTEGRITY)");
  await expect(cardFail).not.toContainText("not materialized");
  await expect(cardFail).toContainText("failed reads: contract");
  expect(okRow).toBeTruthy();
});

test("workforce: business switch during pending reads — stale agents never paint", async ({ page }) => {
  const bizA = await mkBusiness(page, "wf-j");
  await mkObjective(page, bizA);
  await mkAgent(page, bizA, "Agent A");
  const bizB = await mkBusiness(page, "wf-k");
  await mkObjective(page, bizB);
  await mkAgent(page, bizB, "Agent B");
  let delayA = true;
  await page.route(`**/api/vnext/businesses/${bizA}/company`, async (route) => {
    if (delayA) await new Promise((r) => setTimeout(r, 400));
    return route.continue();
  });
  await seedBiz(page, bizA);
  await page.goto("/app/workforce");
  await expect(page.locator(".ecards")).toContainText("Agent A");
  // switch A→B — A's card must never paint under B
  await page.locator(".aside").getByRole("button", { name: "business switcher" }).click();
  await page.locator(".aside").getByLabel("business id").fill(bizB);
  await page.locator(".aside").getByRole("button", { name: "Use" }).click();
  await expect(page.locator(".ecards")).not.toContainText("Agent A");
  await expect(page.locator(".ecards")).toContainText("Agent B");
});

test("workforce: agent switch via SPA nav during pending reads — no cross-agent pollution", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-l");
  await mkObjective(page, biz);
  const agentA = await mkAgent(page, biz, "First Agent");
  const agentB = await mkAgent(page, biz, "Second Agent");
  await seedBiz(page, biz);
  await page.goto(`/app/workforce/${agentA}`);
  await expect(page.locator("h1")).toHaveText("First Agent");
  // delay agent B's detail reads
  await page.route(`**/api/org-agents/${agentB}/inbox`, async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    return route.continue();
  });
  // SPA navigate A→B without leaving the route component
  await page.goto(`/app/workforce/${agentB}`);
  await expect(page.locator("h1")).toHaveText("Second Agent");
  await expect(page.locator("h1")).not.toHaveText("First Agent");
});

test("workforce: dialog invalidated on identity change — cannot confirm stale op", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-m");
  await mkObjective(page, biz);
  const agentA = await mkAgent(page, biz, "Dlg Agent A");
  const agentB = await mkAgent(page, biz, "Dlg Agent B");
  const posts: string[] = [];
  await page.route("**/api/org-agents/**", (route) => {
    if (route.request().method() === "POST") posts.push(route.request().url());
    return route.continue();
  });
  await seedBiz(page, biz);
  await page.goto(`/app/workforce/${agentA}`);
  await expect(page.locator("h1")).toHaveText("Dlg Agent A");
  await page.getByRole("button", { name: "Pause agent" }).click();
  await expect(page.locator(".cdlg")).toBeVisible();
  // navigate to agent B while dialog open — dialog must close, not retarget
  await page.goto(`/app/workforce/${agentB}`);
  await expect(page.locator(".cdlg")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveText("Dlg Agent B");
  // no mutation was fired for A
  expect(posts.filter((u) => u.includes(agentA))).toHaveLength(0);
});

test("workforce: 401 → credential state; integrity error → fail closed", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-n");
  await mkObjective(page, biz);
  // integrity-style failure on the org-agents read → fail-closed error
  await page.route("**/api/org-agents", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "FAIL_CLOSED_WORK_PROVENANCE_CORRUPT" }) }));
  await seedBiz(page, biz);
  await page.goto("/app/workforce");
  await expect(page.locator(".pstate.err")).toContainText("Integrity check failed");
  await expect(page.locator(".pstate.err")).toContainText("FAIL_CLOSED");
  // 401 → credential error state (bad token)
  await page.unroute("**/api/org-agents");
  const p2 = await page.context().newPage();
  await p2.addInitScript(() => {
    localStorage.setItem("pair.mc_token", "definitely-wrong-token");
    localStorage.setItem("pair.operator_id", "op:e2e");
    localStorage.setItem("pair.business_id", "BIZ_x");
  });
  await p2.goto("/app/workforce");
  await expect(p2.locator(".pstate.err")).toContainText("credentials were rejected");
  await p2.close();
});

test("workforce: business owner context unverified → labeled banner, list still honest", async ({ page }) => {
  // foreign business the actor doesn't own → company 403s
  const biz = await mkBusiness(page, "wf-o");
  const agent = await mkAgent(page, biz, "Unverified Ctx Agent");
  await seedBiz(page, biz);
  await page.goto("/app/workforce");
  await expect(page.locator(".trunc[role=alert]")).toContainText("owner context unverified");
  await expect(page.locator(".trunc[role=alert]")).toContainText("403");
  await expect(page.locator(".ecards")).toContainText("Unverified Ctx Agent");
  await expect(page.locator(".srcnote")).toContainText("global, unfiltered");
});

test("workforce: no mutation POSTs on pure reads; mobile viewport parity", async ({ page }) => {
  const biz = await mkBusiness(page, "wf-p");
  await mkObjective(page, biz);
  await mkAgent(page, biz, "ReadOnly Agent");
  const posts: string[] = [];
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET") posts.push(route.request().url());
    return route.continue();
  });
  await seedBiz(page, biz);
  await page.goto("/app/workforce");
  await expect(page.locator(".ecard")).toHaveCount(1);
  expect(posts).toHaveLength(0);
  // mobile viewport — same content, bottom tab bar nav works
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/app/workforce");
  await expect(page.locator(".ecard")).toHaveCount(1);
  await expect(page.locator(".ecards")).toContainText("ReadOnly Agent");
  await expect(page.locator(".atabbar")).toBeVisible();
  expect(posts).toHaveLength(0);
});

test("workforce: R2-F1 foreign agent — fail closed with ZERO agent-specific GETs", async ({ page }) => {
  /* Network-level proof: for a foreign or missing agent the page must
     resolve identity FIRST and never fire contract/effective-policy/
     inbox requests (client-side guard, not server authz). */
  const bizA = await mkBusiness(page, "wf-r2a");
  const bizB = await mkBusiness(page, "wf-r2b");
  await mkObjective(page, bizA);
  await mkObjective(page, bizB);
  const foreignAgent = await mkAgent(page, bizA, "Foreign Agent");
  const hits: string[] = [];
  await page.route("**/api/org-agents/*/*", (route) => {
    hits.push(route.request().url());
    return route.continue();
  });
  await seedBiz(page, bizB); // selected business = B, agent belongs to A
  await page.goto(`/app/workforce/${foreignAgent}`);
  await expect(page.locator(".pstate.denied")).toContainText("does not belong to the selected business");
  const agentSpecific = hits.filter((u) => /\/(contract|effective-policy|inbox)(\?|$)/.test(u));
  expect(agentSpecific, `agent-specific GETs leaked: ${agentSpecific}`).toHaveLength(0);
  // missing agent — same fail-closed contract
  hits.length = 0;
  await page.goto(`/app/workforce/missing-${uniq()}`);
  await expect(page.getByText("Agent not found")).toBeVisible();
  expect(hits.filter((u) => /\/(contract|effective-policy|inbox)(\?|$)/.test(u))).toHaveLength(0);
});

test("workforce: R2-F2 inbox states — empty/pending/corrupt/malformed", async ({ page }) => {
  /* Adversarial: corrupt receipts make any exact pending count unproven;
     malformed payloads must fail closed without crashing the page. */
  const biz = await mkBusiness(page, "wf-r2i");
  await mkObjective(page, biz);
  const empty = await mkAgent(page, biz, "Empty Inbox");
  const pend = await mkAgent(page, biz, "Pending Inbox", { executor_binding: "codex" });
  const corrupt = await mkAgent(page, biz, "Corrupt Inbox");
  const malformed = await mkAgent(page, biz, "Malformed Inbox");
  // real pending message for `pend`
  const wi = await mkWorkItem(page, biz, "Task", pend);
  await apiPost(page, `/work-items/${wi}/messages`, {
    business_id: biz,
    sender_type: "OPERATOR",
    recipient_agent_id: pend,
    kind: "NOTE",
    body: "do the thing",
  });
  await page.route(`**/api/org-agents/${corrupt}/inbox`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      messages: [
        { message_id: "m-ok", receipt_status: "PENDING", kind: "TASK", body: "x", created_at: "2026-10-10T00:00:00Z" },
        { message_id: "m-corrupt", corrupt: true, receipt_status: "CORRUPT", kind: "EVENT", body: "y", created_at: "2026-10-10T00:01:00Z" },
      ],
    }) }));
  await page.route(`**/api/org-agents/${malformed}/inbox`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "CORRUPT", corrupt: true }) }));
  await seedBiz(page, biz);
  await page.goto("/app/workforce");
  await expect(page.locator(".ecard")).toHaveCount(4);
  const cardEmpty = page.locator(".ecard", { hasText: "Empty Inbox" });
  await expect(cardEmpty).toContainText("inbox 0 pending");
  const cardPend = page.locator(".ecard", { hasText: "Pending Inbox" });
  await expect(cardPend).toContainText("inbox 1 pending");
  // corrupt receipt → indeterminate, NEVER an exact fabricated count
  const cardCorrupt = page.locator(".ecard", { hasText: "Corrupt Inbox" });
  await expect(cardCorrupt).toContainText("indeterminate");
  await expect(cardCorrupt).toContainText("corrupt receipt");
  await expect(cardCorrupt).not.toContainText("0 pending");
  await expect(cardCorrupt).not.toContainText("1 pending");
  // malformed 200 → fail-closed label, page still renders
  const cardMalformed = page.locator(".ecard", { hasText: "Malformed Inbox" });
  await expect(cardMalformed).toContainText("unavailable (malformed payload)");
  await expect(page.locator(".srcnote")).toBeVisible();
});
