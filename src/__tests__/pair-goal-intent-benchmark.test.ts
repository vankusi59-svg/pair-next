/**
 * P18.6 — seeded goal-intent benchmark runner (61 scenarios).
 *
 * Loads fixtures/goal-intent-benchmark.json and drives every scenario
 * through the REAL semantic pipeline — analyzeGoal → schema validation
 * → deterministic reconcileIntent → classifyAmbiguity → rendered
 * advisory block — with the seeded model response injected at the
 * provider seam (bounded fixture items stand in for the ONE provider
 * request; real-model qualification is reported separately, never
 * fabricated).
 *
 * Scoring (dataset rubric): a scenario is CORRECT iff every check
 * passes — categories_include ⊆ analyzed categories, ambiguity_class
 * equal when specified, conflict presence, authority bounds, min
 * item count. Gate: ≥90% correct on the clearly-specified set.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { analyzeGoal, type GoalIntentAnalysis } from "../pair/semantic-goal-understanding.js";

const FIXTURE = path.join(
  __dirname,
  "..",
  "..",
  "scripts",
  "dev-verification",
  "fixtures",
  "goal-intent-benchmark.json",
);

interface Scenario {
  id: string;
  lang: string;
  family: string;
  goal: string;
  fixture_items: Array<Record<string, unknown>>;
  expect: {
    categories_include?: string[];
    ambiguity_class?: string;
    has_conflict?: boolean;
    authority_must_not_be?: string[];
    min_items?: number;
  };
}

const dataset = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as {
  schema: string;
  denominator: number;
  rubric: string;
  scenarios: Scenario[];
};

const SCOPE = {
  business_id: null,
  objective_id: null,
  work_item_id: null,
  project_id: "bench",
};

async function runScenario(s: Scenario): Promise<{
  ok: boolean;
  failures: string[];
}> {
  const failures: string[] = [];
  const out = await analyzeGoal({
    goal: s.goal,
    context_digest: "bench",
    contextBlock: null,
    model: "benchmark-fixture",
    scope: SCOPE,
    analyze: async () => ({ items: s.fixture_items, latency_ms: 0 }),
  });
  if ("unavailable" in out) {
    return { ok: false, failures: [`unavailable: ${out.unavailable.join(",")}`] };
  }
  const a = out as GoalIntentAnalysis;
  const cats = new Set(a.items.map((i) => i.category));
  for (const c of s.expect.categories_include ?? []) {
    if (!cats.has(c as never)) failures.push(`missing category ${c}`);
  }
  if (s.expect.ambiguity_class != null && a.ambiguity.class !== s.expect.ambiguity_class) {
    failures.push(`ambiguity ${a.ambiguity.class} != ${s.expect.ambiguity_class}`);
  }
  if (s.expect.has_conflict != null) {
    const has = a.reconciliation.conflicts.length > 0;
    if (has !== s.expect.has_conflict) failures.push("conflict presence mismatch");
  }
  for (const forb of s.expect.authority_must_not_be ?? []) {
    if (a.items.some((i) => i.authority === forb)) {
      failures.push(`forbidden authority ${forb} present`);
    }
  }
  if (s.expect.min_items != null && a.items.length < s.expect.min_items) {
    failures.push(`items ${a.items.length} < ${s.expect.min_items}`);
  }
  return { ok: failures.length === 0, failures };
}

describe("P18.6 — goal-intent benchmark (61 seeded scenarios)", () => {
  it("every family is represented ≥1", () => {
    const fams = new Set(dataset.scenarios.map((s) => s.family));
    for (const f of [
      "paraphrase", "negation", "preference", "temporal", "quantity",
      "conditional", "ambiguity", "contradiction", "context",
      "injection", "permission", "exception", "entity", "secondary",
    ]) {
      expect(fams.has(f), `family ${f}`).toBe(true);
    }
    expect(dataset.scenarios.length).toBeGreaterThanOrEqual(60);
  });

  it("≥90% correct on the clearly-specified set", async () => {
    const results: Array<{ id: string; ok: boolean; failures: string[] }> = [];
    for (const s of dataset.scenarios) {
      // unique context_digest per scenario → no cross-scenario cache hits
      const r = await analyzeGoal({
        goal: s.goal,
        context_digest: `bench-${s.id}`,
        contextBlock: null,
        model: "benchmark-fixture",
        scope: SCOPE,
        analyze: async () => ({ items: s.fixture_items, latency_ms: 0 }),
      }).then((out) => {
        if ("unavailable" in out) {
          return { ok: false, failures: [`unavailable: ${out.unavailable.join(",")}`] };
        }
        return null;
      });
      const rr = r ?? (await runScenario(s));
      results.push({ id: s.id, ok: rr.ok, failures: rr.failures });
    }
    const correct = results.filter((r) => r.ok).length;
    const score = correct / results.length;
    fs.mkdirSync(path.join(__dirname, "..", "..", "docs", "p18-6"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "..", "..", "docs", "p18-6", "GOAL_INTENT_BENCHMARK_RESULTS.json"),
      JSON.stringify(
        {
          schema: dataset.schema,
          lane: "seeded-fixture (deterministic pipeline)",
          denominator: results.length,
          correct,
          score: Number(score.toFixed(4)),
          rubric: dataset.rubric,
          failures: results.filter((r) => !r.ok),
        },
        null,
        1,
      ) + "\n",
      "utf8",
    );
    expect(score).toBeGreaterThanOrEqual(0.9);
  });
});
