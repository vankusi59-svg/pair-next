/**
 * UI-V2 Phase B — intake draft derivation: the non-authoritative
 * proposal builder. Proves: no invented KPIs/numbers/dates/budgets;
 * provenance tags match field grounding; unresolved interpretation
 * items never become field values; kind suggestion is deterministic;
 * the manual fallback only carries the operator's own words.
 */
import { describe, expect, it } from "vitest";
import {
  deriveIntakeDraft,
  deriveManualDraft,
  INTAKE_DRAFT_SCHEMA,
} from "../pair/objective-intake.js";
import type { GoalIntentAnalysis, IntentItem } from "../pair/semantic-goal-understanding.js";

let seq = 0;
const item = (partial: Partial<IntentItem>): IntentItem => ({
  id: `i${++seq}`,
  category: "requirement",
  source_span: null,
  statement: "s",
  authority: "EXPLICIT_OPERATOR",
  confidence: "high",
  ...partial,
});

const analysis = (items: IntentItem[]): GoalIntentAnalysis => ({
  schema_version: "pair.goal-intent-analysis.v1",
  analysis_digest: "d".repeat(64),
  operator_goal_sha256: "g".repeat(64),
  context_digest: null,
  scope: { business_id: "BIZ_x", objective_id: null, work_item_id: null, project_id: null },
  items,
  reconciliation: { confirmed_ids: [], conflicts: [], proposed_ids: [] },
  ambiguity: { class: "HARMLESS", reasons: [] },
  provider: { model: "m", requests: 1, latency_ms: 1, unavailable: [] },
  created_at: "2026-10-27T00:00:00.000Z",
});

describe("deriveManualDraft", () => {
  it("carries only the operator's words; everything else unresolved", () => {
    const d = deriveManualDraft("Viết kịch bản video đầu tiên. Bao gồm hook 5 giây.");
    expect(d.schema_version).toBe(INTAKE_DRAFT_SCHEMA);
    expect(d.suggested_kind).toBe("mission");
    expect(d.title.value).toBe("Viết kịch bản video đầu tiên");
    expect(d.title.provenance).toBe("explicit");
    expect(d.statement.value).toContain("Bao gồm hook 5 giây");
    expect(d.kpis).toHaveLength(0);
    expect(d.deadline.value).toBeNull();
    expect(d.budget_ceiling_microusd.value).toBeNull();
    expect(d.hard_constraints).toHaveLength(0);
    expect(d.questions).toHaveLength(0);
  });

  it("handles empty goal safely", () => {
    const d = deriveManualDraft("   ");
    expect(d.title.value).toBeNull();
    expect(d.statement.value).toBeNull();
  });
});

describe("deriveIntakeDraft", () => {
  it("maps explicit primary outcome + categories; never invents fields", () => {
    const a = analysis([
      item({ id: "i1", category: "primary_outcome", statement: "Kênh video XAUUSD M15 ra mắt 7 ngày" }),
      item({ id: "i2", category: "hard_constraint", statement: "Không đăng video lên kênh nào" }),
      item({ id: "i3", category: "prohibition", statement: "Không gửi Telegram" }),
      item({ id: "i4", category: "deliverable", statement: "file content_calendar_7d.md" }),
    ]);
    const d = deriveIntakeDraft(a);
    expect(d.title.value).toContain("XAUUSD");
    expect(d.title.provenance).toBe("explicit");
    expect(d.hard_constraints.map((c) => c.statement)).toEqual([
      "Không đăng video lên kênh nào",
      "Không gửi Telegram",
    ]);
    expect(d.hard_constraints[0].provenance).toBe("explicit");
    expect(d.success_conditions[0].statement).toContain("content_calendar_7d.md");
    expect(d.success_conditions[0].provenance).toBe("suggested"); // mapped field
    expect(d.workstreams).toHaveLength(1);
    /* no numeric/temporal items → nothing fabricated */
    expect(d.kpis).toHaveLength(0);
    expect(d.deadline.value).toBeNull();
    expect(d.budget_ceiling_microusd.value).toBeNull();
    expect(d.suggested_kind).toBe("mission");
  });

  it("extracts only grounded KPI targets and USD ceilings", () => {
    const a = analysis([
      item({ id: "i1", category: "primary_outcome", statement: "Bán EA trên MQL5" }),
      item({ id: "i2", category: "quantity", statement: "ít nhất 3 kịch bản được duyệt" }),
      item({ id: "i3", category: "quantity", statement: "ngân sách tối đa 100 USD" }),
      item({ id: "i4", category: "temporal", statement: "hạn 2026-11-15" }),
    ]);
    const d = deriveIntakeDraft(a);
    expect(d.kpis).toHaveLength(1);
    expect(d.kpis[0].target).toBe(3);
    expect(d.kpis[0].provenance).toBe("suggested");
    expect(d.budget_ceiling_microusd.value).toBe(100_000_000);
    expect(d.budget_ceiling_microusd.provenance).toBe("explicit");
    expect(d.currency.value).toBe("USD");
    expect(d.deadline.value).toBe("2026-11-15");
    /* deadline + budget + kpi + ≥? → objective suggestion */
    expect(d.suggested_kind).toBe("objective");
  });

  it("honors magnitude words and currency-prefix forms", () => {
    const a = analysis([
      item({ id: "i1", category: "primary_outcome", statement: "Bán EA" }),
      item({ id: "i2", category: "quantity", statement: "tối đa 2 triệu USD" }),
    ]);
    const d = deriveIntakeDraft(a);
    expect(d.budget_ceiling_microusd.value).toBe(2_000_000_000_000);
    const b = analysis([
      item({ id: "i1", category: "primary_outcome", statement: "Bán EA" }),
      item({ id: "i2", category: "quantity", statement: "budget $250 total" }),
    ]);
    const d2 = deriveIntakeDraft(b);
    expect(d2.budget_ceiling_microusd.value).toBe(250_000_000);
    expect(d2.currency.value).toBe("USD");
  });

  it("keeps non-USD budget as hint only — ceiling stays unresolved", () => {
    const a = analysis([
      item({ id: "i1", category: "primary_outcome", statement: "Mở rộng kênh" }),
      item({ id: "i2", category: "quantity", statement: "ngân sách 2 triệu VND" }),
    ]);
    const d = deriveIntakeDraft(a);
    expect(d.budget_hint.value).toContain("VND");
    expect(d.budget_ceiling_microusd.value).toBeNull();
    expect(d.budget_ceiling_microusd.provenance).toBe("unresolved");
    expect(d.currency.value).toBe("VND");
    /* the VND quantity item is a budget signal, not a KPI */
    expect(d.kpis).toHaveLength(0);
  });

  it("resolves relative deadlines deterministically as suggested", () => {
    const a = analysis([
      item({ id: "i1", category: "primary_outcome", statement: "Chuỗi video" }),
      item({ id: "i2", category: "temporal", statement: "trong 30 ngày" }),
    ]);
    const d = deriveIntakeDraft(a);
    expect(d.deadline.value).toBe("2026-11-26"); // 2026-10-27 + 30d
    expect(d.deadline.provenance).toBe("suggested");
  });

  it("unresolved/missing items become questions — never field values", () => {
    const a = analysis([
      item({ id: "i1", category: "primary_outcome", statement: "Sản phẩm EA" }),
      item({
        id: "i2",
        category: "missing_information",
        statement: "Ngân sách tối đa 500 USD?",
        authority: "UNRESOLVED",
        alternatives: ["500 USD", "1000 USD"],
      }),
      item({
        id: "i3",
        category: "ambiguity",
        statement: "Kênh nào?",
        authority: "UNRESOLVED",
      }),
    ]);
    const d = deriveIntakeDraft(a);
    expect(d.questions.map((q) => q.item_id)).toEqual(["i2", "i3"]);
    expect(d.questions[0].alternatives).toEqual(["500 USD", "1000 USD"]);
    /* a numeric UNRESOLVED statement must NOT mint a budget or KPI */
    expect(d.budget_ceiling_microusd.value).toBeNull();
    expect(d.kpis).toHaveLength(0);
  });

  it("model-inferred fields are suggested, never explicit", () => {
    const a = analysis([
      item({
        id: "i1",
        category: "primary_outcome",
        statement: "Xây hệ thống",
        authority: "MODEL_INFERRED",
      }),
      item({
        id: "i2",
        category: "hard_constraint",
        statement: "không vượt quá giới hạn",
        authority: "MODEL_INFERRED",
      }),
    ]);
    const d = deriveIntakeDraft(a);
    expect(d.title.provenance).toBe("suggested");
    expect(d.hard_constraints[0].provenance).toBe("suggested");
  });
});
