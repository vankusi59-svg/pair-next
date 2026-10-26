#!/usr/bin/env node
/**
 * P18.6 — REAL-MODEL goal-intent E2E (never mocks, never fabricated).
 *
 * Qualifies the codex-cli planner transport via codexPlannerProbe, then
 * drives each scenario through the REAL provider call —
 * codexSemanticAnalyze → validateIntentItems → reconcileIntent →
 * classifyAmbiguity — and scores interpretation expectations.
 *
 * Verdicts: REAL_MODEL_PASS | REAL_MODEL_PARTIAL | BLOCKED_REAL_MODEL.
 * A missing/absent provider or auth failure reports BLOCKED honestly.
 *
 * Usage: node scripts/dev-verification/goal-intent-real-e2e.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexPlannerProbe,
  codexSemanticAnalyze,
  validateIntentItems,
  reconcileIntent,
  classifyAmbiguity,
  semanticMode,
} from "../../dist/pair/index.js";

const REPO = "D:/PAIR_NEXT_2410";
const OUT_DIR = path.join(REPO, "docs", "p18-6");
const MODEL = "gpt-6.1-sol";
const TIMEOUT_MS = 300_000;

const CASES = [
  {
    id: "R-1", lang: "en", family: "outcome+constraint",
    goal: "Grow my Telegram channel by 1,000 genuine subscribers within 30 days without buying ads",
    expect: { categories: ["primary_outcome"], any_of: [["quantity", "temporal", "prohibition", "hard_constraint"]] },
  },
  {
    id: "R-2", lang: "vi", family: "outcome-equivalent",
    goal: "Tăng trưởng kênh Telegram, kéo thêm người đăng ký thật",
    expect: { categories: ["primary_outcome"] },
  },
  {
    id: "R-3", lang: "vi", family: "prohibition",
    goal: "Không làm phiền khách hàng hiện tại và không gửi tin nhắn spam",
    expect: { categories: ["prohibition"] },
  },
  {
    id: "R-4", lang: "mixed", family: "mixed-language",
    goal: "Attract 200 real leads trong vòng 2 tuần, ưu tiên giải pháp miễn phí",
    expect: { categories: ["primary_outcome"], any_of: [["soft_preference", "temporal", "quantity"]] },
  },
  {
    id: "R-5", lang: "vi", family: "conditional",
    goal: "Nếu phương án A không hiệu quả thì thử phương án B",
    expect: { categories: ["conditional"] },
  },
  {
    id: "R-6", lang: "en", family: "ambiguity-honest",
    goal: "Improve the product",
    expect: { ambiguity_min: "MATERIAL", any_of: [["ambiguity", "missing_information", "primary_outcome"]] },
  },
  {
    id: "R-7", lang: "vi", family: "hard-constraint",
    goal: "Chỉ sử dụng dữ liệu nội bộ, tối đa 500 nghìn đồng",
    expect: { categories: ["hard_constraint"], any_of: [["quantity", "hard_constraint"]] },
  },
  {
    id: "R-8", lang: "en", family: "preference-priority",
    goal: "Prioritize organic reach first, then consider low-cost partnerships",
    expect: { categories: ["priority"], any_of: [["soft_preference", "priority"]] },
  },
];

const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), "pair-intent-e2e-"));
const report = {
  contract: "pair.goal-intent-real-e2e.v1",
  model: MODEL,
  semantic_mode_env: process.env.PAIR_SEMANTIC_MODE ?? "off",
  started_at: new Date().toISOString(),
  cases: [],
  provider_requests_total: 0,
};

// Qualification gate — BLOCKED honestly when the real transport is absent.
const probe = await codexPlannerProbe({
  model: MODEL, timeoutMs: TIMEOUT_MS, scratchDir: path.join(scratchBase, "probe"),
});
report.probe = probe;
if (probe.outcome !== "AUTH_OK") {
  report.verdict = "BLOCKED_REAL_MODEL";
  report.blocked_reason = `probe ${probe.outcome}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "GOAL_INTENT_REAL_E2E.json"), JSON.stringify(report, null, 1) + "\n");
  console.log(`BLOCKED_REAL_MODEL — ${report.blocked_reason}`);
  process.exit(2);
}

const ambRank = { HARMLESS: 0, MATERIAL: 1, AUTHORITY_CRITICAL: 2 };
let pass = 0;
for (const cse of CASES) {
  const counter = { requests: 0 };
  const t0 = Date.now();
  const raw = await codexSemanticAnalyze(cse.goal, null, {
    model: MODEL, timeoutMs: TIMEOUT_MS,
    scratchDir: path.join(scratchBase, cse.id),
    providerCounter: counter,
  });
  const rec = { id: cse.id, lang: cse.lang, family: cse.family, provider_requests: counter.requests, latency_ms: Date.now() - t0 };
  report.provider_requests_total += counter.requests;
  if ("unavailable" in raw) {
    rec.verdict = "UNAVAILABLE";
    rec.reason = raw.unavailable;
    report.cases.push(rec);
    continue;
  }
  const items = validateIntentItems(raw.items);
  if (!items) {
    rec.verdict = "SCHEMA_INVALID";
    report.cases.push(rec);
    continue;
  }
  const r = reconcileIntent(items, cse.goal);
  const amb = classifyAmbiguity(r, items);
  const cats = new Set(items.map((i) => i.category));
  const failures = [];
  for (const c of cse.expect.categories ?? []) {
    if (!cats.has(c)) failures.push(`missing ${c}`);
  }
  if (cse.expect.any_of?.length) {
    for (const group of cse.expect.any_of) {
      if (!group.some((g) => cats.has(g))) failures.push(`none of ${group.join("|")}`);
    }
  }
  if (cse.expect.ambiguity_min && ambRank[amb.class] < ambRank[cse.expect.ambiguity_min]) {
    failures.push(`ambiguity ${amb.class} < ${cse.expect.ambiguity_min}`);
  }
  rec.categories = [...cats];
  rec.ambiguity_class = amb.class;
  rec.items = items.map((i) => ({ id: i.id, category: i.category, statement: i.statement, authority: i.authority, confidence: i.confidence }));
  rec.conflicts = r.conflicts;
  rec.verdict = failures.length ? "FAIL" : "PASS";
  rec.failures = failures;
  if (!failures.length) pass++;
  report.cases.push(rec);
}

report.score = `${pass}/${CASES.length}`;
report.verdict = pass === CASES.length ? "REAL_MODEL_PASS" : pass >= Math.ceil(CASES.length * 0.75) ? "REAL_MODEL_PARTIAL" : "REAL_MODEL_FAIL";
report.finished_at = new Date().toISOString();
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "GOAL_INTENT_REAL_E2E.json"), JSON.stringify(report, null, 1) + "\n");
console.log(`${report.verdict} — ${report.score} · requests=${report.provider_requests_total} · model=${MODEL}`);
for (const c of report.cases) {
  console.log(`  ${c.id} ${c.verdict} ${c.ambiguity_class ?? ""} ${(c.failures ?? []).join("; ")}`);
}
process.exit(report.verdict === "REAL_MODEL_FAIL" ? 1 : 0);
