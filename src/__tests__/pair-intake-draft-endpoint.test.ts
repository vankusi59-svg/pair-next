/**
 * UI-V2 Phase B — /api/v1/intake/draft endpoint: governed NL intake.
 * Proves: operator required; bounded goal validation; business scope
 * fails closed; OFF/unavailable still serves the manual draft; the
 * analyzed path derives the draft server-side from advisory evidence;
 * nothing canonical is created (read-only + advisory).
 */
import { describe, expect, it } from "vitest";
import http from "node:http";
import type { Server } from "node:http";
import { createMissionControlServer } from "../pair/mission-control-server.js";
import type { GoalIntentAnalysis, IntentItem } from "../pair/semantic-goal-understanding.js";

const item = (partial: Partial<IntentItem>): IntentItem => ({
  id: "i1",
  category: "requirement",
  source_span: null,
  statement: "s",
  authority: "EXPLICIT_OPERATOR",
  confidence: "high",
  ...partial,
});

const analysisFixture = (items: IntentItem[]): GoalIntentAnalysis => ({
  schema_version: "pair.goal-intent-analysis.v1",
  analysis_digest: "a".repeat(64),
  operator_goal_sha256: "g".repeat(64),
  context_digest: null,
  scope: { business_id: "BIZ_ok", objective_id: null, work_item_id: null, project_id: null },
  items,
  reconciliation: { confirmed_ids: [], conflicts: [], proposed_ids: [] },
  ambiguity: { class: "MATERIAL", reasons: ["x"] },
  provider: { model: "m", requests: 1, latency_ms: 3, unavailable: [] },
  created_at: "2026-10-27T00:00:00.000Z",
});

interface Cfg {
  business?: Record<string, unknown>;
  intakeAnalyze?: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
}

async function boot(cfg: Cfg): Promise<{ server: Server; port: number }> {
  const server = createMissionControlServer({
    control: {} as never,
    business: cfg.business as never,
    intakeAnalyze: cfg.intakeAnalyze,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
}

const post = (
  port: number,
  body: Record<string, unknown> | string,
  headers: Record<string, string> = {},
) =>
  new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const rq = http.request(
      {
        host: "127.0.0.1", port, path: "/api/v1/intake/draft", method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (rs) => {
        const chunks: Buffer[] = [];
        rs.on("data", (c: Buffer) => chunks.push(c));
        rs.on("end", () =>
          resolve({
            status: rs.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
          }),
        );
      },
    );
    rq.on("error", reject);
    rq.end(typeof body === "string" ? body : JSON.stringify(body));
  });

const OP = { "x-operator-id": "op:e2e" };
const fakeBiz = {
  getBusiness: (id: string) => {
    if (id !== "BIZ_ok") throw new Error("not found");
    return { business_id: id };
  },
};

describe("UI-V2 /api/v1/intake/draft", () => {
  it("rejects without operator, empty goal, oversized goal", async () => {
    const { server, port } = await boot({});
    try {
      expect((await post(port, { goal: "x" })).status).toBe(403);
      expect((await post(port, { goal: "  " }, OP)).status).toBe(400);
      expect((await post(port, { goal: "y".repeat(4001) }, OP)).status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("manual draft when no analyzer wired — honest mode:off, no fabrication", async () => {
    const { server, port } = await boot({ business: fakeBiz });
    try {
      const r = await post(
        port,
        { goal: "Viết kế hoạch nội dung 7 ngày", business_id: "BIZ_ok" },
        OP,
      );
      expect(r.status).toBe(200);
      expect(r.json.mode).toBe("off");
      expect(r.json.status).toBe("off");
      const d = r.json.draft as Record<string, { value?: unknown; provenance?: string }>;
      expect((d.title as { value?: unknown }).value).toContain("Viết kế hoạch");
      expect((d.title as { provenance?: string }).provenance).toBe("explicit");
      expect(d.kpis as unknown[]).toHaveLength(0);
      expect((d.deadline as { value?: unknown }).value).toBeNull();
      expect(r.json.analysis_digest).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("unknown business fails closed 404 — never binds scope to a phantom tenant", async () => {
    let called = 0;
    const { server, port } = await boot({
      business: fakeBiz,
      intakeAnalyze: async () => {
        called++;
        return null;
      },
    });
    try {
      const r = await post(port, { goal: "g", business_id: "BIZ_evil" }, OP);
      expect(r.status).toBe(404);
      expect(r.json.error).toBe("BUSINESS_NOT_FOUND");
      expect(called).toBe(0); // fail BEFORE any provider spend
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("analyzed path: scope passes through, draft derives server-side", async () => {
    let seen: Record<string, unknown> | null = null;
    const analysis = analysisFixture([
      item({ id: "i1", category: "primary_outcome", statement: "Bán EA trên MQL5" }),
      item({ id: "i2", category: "quantity", statement: "ngân sách tối đa 100 USD" }),
      item({
        id: "i3", category: "missing_information", authority: "UNRESOLVED",
        statement: "Thời hạn?",
      }),
    ]);
    const { server, port } = await boot({
      business: fakeBiz,
      intakeAnalyze: async (input) => {
        seen = input;
        return {
          mode: "guarded",
          status: "analyzed",
          analysis_digest: analysis.analysis_digest,
          source_goal_sha: analysis.operator_goal_sha256,
          provider_requests: 1,
          ambiguity_class: "MATERIAL",
          analysis,
        };
      },
    });
    try {
      const r = await post(port, { goal: "Bán EA trên MQL5", business_id: "BIZ_ok" }, OP);
      expect(r.status).toBe(200);
      expect(r.json.mode).toBe("guarded");
      expect(r.json.status).toBe("analyzed");
      expect(r.json.analysis_digest).toBe(analysis.analysis_digest);
      expect(seen).not.toBeNull();
      expect(seen!.business_id).toBe("BIZ_ok");
      expect(seen!.operator_id).toBe("operator:op:e2e");
      const d = r.json.draft as Record<string, unknown>;
      expect((d.title as { value?: unknown }).value).toContain("MQL5");
      expect((d.budget_ceiling_microusd as { value?: unknown }).value).toBe(100_000_000);
      expect((d.questions as Array<{ item_id: string }>).map((q) => q.item_id)).toContain("i3");
      /* items surface for the review rail — bounded, advisory */
      expect((r.json.items as unknown[]).length).toBe(3);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("unavailable interpretation → truthful status + manual draft", async () => {
    const { server, port } = await boot({
      business: fakeBiz,
      intakeAnalyze: async () => ({
        mode: "guarded",
        status: "unavailable",
        unavailable_reason: "provider:timeout",
        analysis_digest: null,
        source_goal_sha: null,
        provider_requests: 1,
        ambiguity_class: "MATERIAL",
        analysis: null,
      }),
    });
    try {
      const r = await post(port, { goal: "g objective", business_id: "BIZ_ok" }, OP);
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("unavailable");
      expect(r.json.unavailable_reason).toBe("provider:timeout");
      const d = r.json.draft as Record<string, { value?: unknown }>;
      expect((d.statement as { value?: unknown }).value).toBe("g objective");
      expect(d.kpis as unknown[]).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("analyzer throwing still degrades to manual draft (never a 500 on advisory)", async () => {
    const { server, port } = await boot({
      business: fakeBiz,
      intakeAnalyze: async () => {
        throw new Error("provider blew up");
      },
    });
    try {
      const r = await post(port, { goal: "g objective", business_id: "BIZ_ok" }, OP);
      expect(r.status).toBe(200);
      const d = r.json.draft as Record<string, { value?: unknown }>;
      expect((d.statement as { value?: unknown }).value).toBe("g objective");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
