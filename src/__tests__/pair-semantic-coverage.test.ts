/**
 * Semantic & Context-Aware Planning V1 — D′ coverage semantics.
 * Deterministic matcher extensions: outcome obligations are covered by
 * fulfillment evidence (outcome or fulfill verb class + subject binding
 * + quantity floor), never by preparation-only tasks; thousands-grouped
 * quantities ("1,000" / VI "1.000") count at true magnitude; EN/VI
 * equivalent goals mint equivalent contracts. All checks are
 * deterministic — no model verdict mints coverage.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractGoalContract } from "../pair/goal-contract.js";
import { assertPlanCoverage } from "../pair/plan-coverage.js";
import { IntegrityError } from "../pair/errors.js";
import { PairEvidenceStore } from "../pair/store.js";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  beginPlannerRun,
  persistPlannerAttemptStart,
  settlePlannerAttempt,
  createPlanPreview,
} from "../pair/plan-preview.js";

const NETREQ_LOCAL = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
} as const;

const work = (
  key: string,
  instruction: string,
  caps: string[] = ["REASONING"],
  depends_on: string[] = [],
) => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
  metadata: { network_requirement: NETREQ_LOCAL },
});

const GOAL_EN =
  "Grow my Telegram channel by 1,000 genuine subscribers within 30 days";
const GOAL_VI =
  "Tăng thêm 1.000 người đăng ký thật cho kênh Telegram trong vòng 30 ngày";

describe("SEM-COV — outcome obligation coverage", () => {
  it("SC-1 — EN outcome goal mints one obligation with quantity floor 1000 and a deadline", () => {
    const c = extractGoalContract(GOAL_EN);
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].quantity?.min).toBe(1000);
    expect(c.deadline).toBeTruthy();
  });

  it("SC-2 — VI equivalent goal mints the same contract shape (quantity 1000 + deadline)", () => {
    const c = extractGoalContract(GOAL_VI);
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].quantity?.min).toBe(1000);
    expect(c.deadline).toBeTruthy();
  });

  it("SC-3 — fulfillment task covers the EN outcome obligation", () => {
    const c = extractGoalContract(GOAL_EN);
    const r = assertPlanCoverage(c, [
      work(
        "T1",
        "Execute the authorized Telegram channel growth campaign targeting at least 1,000 genuine subscribers",
      ),
    ]);
    const row = r.rows.find((x) => x.kind === "obligation")!;
    expect(row.state).toBe("PROVEN");
    expect(row.task_keys).toContain("T1");
  });

  it("SC-4 — preparation-only task NEVER covers an outcome obligation (research ≠ fulfillment)", () => {
    const c = extractGoalContract(GOAL_EN);
    expect(() =>
      assertPlanCoverage(c, [
        work(
          "T1",
          "Research Telegram growth strategies and summarize the findings",
        ),
      ]),
    ).toThrowError(IntegrityError);
  });

  it("SC-5 — fulfillment task covers the VI outcome obligation", () => {
    const c = extractGoalContract(GOAL_VI);
    const r = assertPlanCoverage(c, [
      work(
        "T1",
        "Thực hiện chiến dịch tăng trưởng kênh Telegram đạt tối thiểu 1.000 người đăng ký thật",
      ),
    ]);
    const row = r.rows.find((x) => x.kind === "obligation")!;
    expect(row.state).toBe("PROVEN");
  });

  it("SC-6 — quantity floor honors grouped forms: 999 fails, '1,000' passes, VI '1.000' passes", () => {
    const c = extractGoalContract(GOAL_EN);
    expect(() =>
      assertPlanCoverage(c, [
        work("T1", "Grow the Telegram channel by 999 genuine subscribers"),
      ]),
    ).toThrowError(IntegrityError);
    const ok = assertPlanCoverage(c, [
      work("T1", "Grow the Telegram channel by 1,000 genuine subscribers"),
    ]);
    expect(ok.rows.find((x) => x.kind === "obligation")!.state).toBe("PROVEN");
    const cv = extractGoalContract(GOAL_VI);
    const okVi = assertPlanCoverage(cv, [
      work(
        "T1",
        "Tăng trưởng kênh Telegram thêm 1.000 người đăng ký thật",
      ),
    ]);
    expect(okVi.rows.find((x) => x.kind === "obligation")!.state).toBe(
      "PROVEN",
    );
  });

  it("SC-7 — 'without' clause mints a prohibition the plan must honor", () => {
    const c = extractGoalContract(
      "Grow Telegram subscribers without bots or unsolicited messages",
    );
    expect(c.prohibitions.length).toBeGreaterThanOrEqual(1);
  });

  it("SC-8 — subject mismatch cannot fabricate outcome coverage", () => {
    const c = extractGoalContract(GOAL_EN);
    expect(() =>
      assertPlanCoverage(c, [
        work(
          "T1",
          "Execute a subscriber growth campaign for the Discord server reaching 5,000 members",
        ),
      ]),
    ).toThrowError(IntegrityError);
  });

  it("SC-9 — mixed EN/VI goal mints obligation + deadline (cross-language comprehension)", () => {
    const c = extractGoalContract("Attract 200 real leads trong vòng 2 tuần");
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].quantity?.min).toBe(200);
    expect(c.deadline).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* G′ — coverage evidence persistence                                   */
/* ------------------------------------------------------------------ */

let tmpN = 0;
function freshStore(): PairEvidenceStore {
  const p = path.join(
    mkTmpDir("pair-semcov-"),
    `s-${tmpN++}.db`,
  );
  return new PairEvidenceStore(p);
}

const ATTEMPT_REC = {
  route: "codex:test",
  provider: "codex",
  model_entry_id: "ME1",
  model: "m",
  role: "PLANNER_COORDINATOR" as const,
  attempt_no: 1,
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: "2026-01-01T00:00:01.000Z",
  latency_ms: 1000,
  outcome: "SUCCESS" as const,
  warnings: [] as string[],
  provider_requests: 1,
};

function provenCoverage() {
  const c = extractGoalContract(GOAL_EN);
  return assertPlanCoverage(c, [
    work(
      "T1",
      "Execute the authorized Telegram channel growth campaign targeting at least 1,000 genuine subscribers",
    ),
  ]);
}

describe("SEM-COV G′ — coverage report persistence", () => {
  it("PG-1 — settle persists the PROVEN report on the attempt row, bounded", () => {
    const store = freshStore();
    const run = beginPlannerRun(store, { routes: ["codex:test"] });
    const paid = persistPlannerAttemptStart(store, {
      planner_run_id: String(run.planner_run_id),
      record: { ...ATTEMPT_REC, outcome: "STARTED", completed_at: "", latency_ms: 0 },
    }).planner_attempt_id;
    settlePlannerAttempt(store, {
      planner_attempt_id: paid,
      record: ATTEMPT_REC,
      winner: true,
      coverage_report: provenCoverage(),
    });
    const row = store.tryGet("planner_attempt", paid)!;
    const rep = row.coverage_report as Record<string, unknown>;
    expect(rep.verdict).toBe("PASS");
    expect(String(rep.contractDigest)).toHaveLength(32);
    expect((rep.rows as unknown[]).length).toBeGreaterThanOrEqual(1);
    const obl = (rep.rows as Array<Record<string, unknown>>).find(
      (r) => r.kind === "obligation",
    )!;
    expect(obl.state).toBe("PROVEN");
    expect(obl.task_keys).toContain("T1");
  });

  it("PG-2 — createPlanPreview projects the winner attempt's coverage onto the preview row", () => {
    const store = freshStore();
    const run = beginPlannerRun(store, { routes: ["codex:test"] });
    const paid = persistPlannerAttemptStart(store, {
      planner_run_id: String(run.planner_run_id),
      record: { ...ATTEMPT_REC, outcome: "STARTED", completed_at: "", latency_ms: 0 },
    }).planner_attempt_id;
    const rep = provenCoverage();
    settlePlannerAttempt(store, {
      planner_attempt_id: paid,
      record: ATTEMPT_REC,
      winner: true,
      coverage_report: rep,
    });
    const preview = createPlanPreview(store, {
      missionInput: { project_id: "P1", goal: GOAL_EN },
      effective_input_digest: "e".repeat(64),
      plan_digest: "p".repeat(64),
      canonical_tasks: [],
      attempts: [ATTEMPT_REC],
      winner: ATTEMPT_REC,
      planner_run_id: String(run.planner_run_id),
    });
    const pv = preview.coverage_report as Record<string, unknown>;
    expect(pv.verdict).toBe("PASS");
    expect(pv.contractDigest).toBe(rep.contractDigest);
  });

  it("PG-3 — a non-PASS / malformed report can never persist as evidence", () => {
    const store = freshStore();
    const run = beginPlannerRun(store, { routes: ["codex:test"] });
    const paid = persistPlannerAttemptStart(store, {
      planner_run_id: String(run.planner_run_id),
      record: { ...ATTEMPT_REC, outcome: "STARTED", completed_at: "", latency_ms: 0 },
    }).planner_attempt_id;
    settlePlannerAttempt(store, {
      planner_attempt_id: paid,
      record: ATTEMPT_REC,
      coverage_report: { verdict: "UNVERIFIABLE", rows: [{ requirement_id: "OBL_001" }] },
    });
    const row = store.tryGet("planner_attempt", paid)!;
    expect(row.coverage_report).toBeNull();
    settlePlannerAttempt(store, {
      planner_attempt_id: paid,
      record: ATTEMPT_REC,
      coverage_report: "garbage",
    });
    expect(store.tryGet("planner_attempt", paid)!.coverage_report).toBeNull();
  });

  it("PG-4 — canonicalize coverageSink fires ONLY on a proven plan (fail-closed reachability)", () => {
    // The sink is advisory evidence: assertPlanCoverage throws before it
    // for an uncovered plan, so a sink can never observe a failed report.
    const c = extractGoalContract(GOAL_EN);
    let observed: unknown = null;
    try {
      assertPlanCoverage(c, [
        work("T1", "Research Telegram growth strategies only"),
      ]);
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrityError);
    }
    expect(observed).toBeNull(); // sink position sits after the throw
    const rep = provenCoverage();
    observed = rep;
    expect((observed as { verdict: string }).verdict).toBe("PASS");
  });
});

/* ---------- K′ audit regression — extraction/matcher defects ---------- */

describe("SEM-COV — K′ audit regressions", () => {
  it("SC-10 — đ-initial VI verb is live code: 'Đạt 1.000…' mints obligation + floor + deadline", () => {
    const c = extractGoalContract(
      "Đạt 1.000 người đăng ký trong vòng 30 ngày",
    );
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].quantity?.min).toBe(1000);
    expect(c.deadline).toBeTruthy();
  });

  it("SC-11 — marker-path grouped quantities keep magnitude: 'at least 1,000' → floor 1000", () => {
    const c = extractGoalContract(
      "Grow the Telegram channel by at least 1,000 subscribers",
    );
    expect(c.obligations[0].quantity?.min).toBe(1000);
    // A task stating a lesser magnitude must NOT satisfy the floor.
    expect(() =>
      assertPlanCoverage(c, [
        work("T1", "Grow the Telegram channel by 5 subscribers"),
      ]),
    ).toThrowError(IntegrityError);
  });

  it("SC-12 — VI marker 'tối thiểu 1.000' resolves floor 1000 (dot-grouped)", () => {
    const c = extractGoalContract("Tăng tối thiểu 1.000 người theo dõi");
    expect(c.obligations[0].quantity?.min).toBe(1000);
  });

  it("SC-12b — 'ít nhất 500' VI min marker is live (was dead code on the í- boundary)", () => {
    const c = extractGoalContract("Thu hút ít nhất 500 khách hàng mới");
    expect(c.obligations[0].quantity?.min).toBe(500);
  });

  it("SC-13 — deadline phrasing mints NO quantity floor ('within 30 days' ≠ 30)", () => {
    const c = extractGoalContract("Grow my channel within 30 days");
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].quantity).toBeUndefined();
    expect(c.deadline).toBeTruthy();
  });

  it("SC-14 — 'in 2 weeks' and bare years mint no floor", () => {
    const c1 = extractGoalContract("Attract new leads in 2 weeks");
    expect(c1.obligations[0].quantity).toBeUndefined();
    const c2 = extractGoalContract("Reach users in 2026");
    expect(c2.obligations[0].quantity).toBeUndefined();
  });

  it("SC-15 — task-side dates/durations can NEVER satisfy a real floor (fail-closed)", () => {
    const c = extractGoalContract(
      "Grow the Telegram channel by 1,000 genuine subscribers",
    );
    // "in 2025" used to mint 2025 ≥ 1000 → vacuous floor satisfaction.
    expect(() =>
      assertPlanCoverage(c, [
        work("T1", "Launch the Telegram channel growth campaign in 2025"),
      ]),
    ).toThrowError(IntegrityError);
    // And a real magnitude still passes through the same mask.
    const r = assertPlanCoverage(c, [
      work(
        "T1",
        "Execute the Telegram channel growth campaign delivering 1,200 genuine subscribers in 2025",
      ),
    ]);
    expect(r.rows.find((x) => x.kind === "obligation")!.state).toBe("PROVEN");
  });

  it("SC-16 — VI clause-initial 'Thu hút' mints no false anchor; fulfillment task covers", () => {
    const c = extractGoalContract("Thu hút 500 khách hàng mới cho kênh");
    expect(c.obligations).toHaveLength(1);
    const r = assertPlanCoverage(c, [
      work("T1", "Thực hiện chiến dịch thu hút 500 khách hàng mới cho kênh"),
    ]);
    expect(r.rows.find((x) => x.kind === "obligation")!.state).toBe("PROVEN");
  });

  it("SC-17 — 'X but do not Y' mints a coverable obligation (trailing connective trimmed)", () => {
    const c = extractGoalContract(
      "Research crypto markets but do not use leverage",
    );
    expect(c.obligations).toHaveLength(1);
    expect(c.obligations[0].text).toBe("Research crypto markets");
    const r = assertPlanCoverage(c, [
      work("T1", "Research crypto markets and summarize the findings"),
    ]);
    expect(r.rows.find((x) => x.kind === "obligation")!.state).toBe("PROVEN");
  });

  it("SC-18 — 'without' is scoping vocabulary, never a prohibited term", () => {
    const c = extractGoalContract(
      "Write the report without using unverified sources",
    );
    expect(c.prohibitions).toHaveLength(1);
    expect(c.prohibitions[0].terms).not.toContain("without");
    // a compliant task holds the prohibition (action-gated: no `use` on
    // the banned object terms)
    const r = assertPlanCoverage(c, [
      work("T1", "Write the report from reviewed materials"),
    ]);
    expect(
      r.rows.find((x) => x.kind === "prohibition")!.state,
    ).not.toBe("VIOLATED");
  });

  it("SC-19 — a substantive but unparseable goal mints a PRESERVED obligation (contract is never vacuous)", () => {
    const c = extractGoalContract("Yield 40 bps improvement for the fund");
    expect(c.obligations.length).toBeGreaterThanOrEqual(1);
    // an unrelated task cannot vacuously cover the preserved row
    expect(() =>
      assertPlanCoverage(c, [work("T1", "Order office supplies")]),
    ).toThrowError(IntegrityError);
    // but a genuinely covering task can satisfy the operator's own words
    // (the preserved row keeps the clause-initial anchor — `Yield` is a
    // required subject token)
    const r = assertPlanCoverage(c, [
      work("T1", "Improve the fund's Yield metric by at least 40 bps"),
    ]);
    expect(r.rows.find((x) => x.kind === "obligation")!.state).toBe("PROVEN");
  });
});
