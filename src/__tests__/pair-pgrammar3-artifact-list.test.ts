/**
 * P-GRAMMAR3 — artifact/dataflow grammar: Vietnamese verb attribution +
 * multi-artifact produce lists (live incident: a Vietnamese instruction
 * extracted produces=[] → deliverable unproduced →
 * FAIL_CLOSED_PLAN_INCOMPLETE → planner EXHAUSTED on a trivial mission).
 *
 * Truth table pinned by operator mandate:
 *  G1 "Tạo hai file input/a.txt và input/b.txt"  → produces both
 *  G2 "Tạo 2 file a.md và b.json"                → both
 *  G3 "Tạo các file a.md, b.csv và c.txt"        → all 3
 *  G4 "Create two files a.txt and b.txt"         → both
 *  G5 "Write x.md, y.json and z.csv"             → all 3
 *  G6 "Đọc input/a.txt và input/b.txt"           → produces []
 *  G7 "So sánh a.txt và b.txt"                   → produces []
 *  G8 "Tạo report.md rồi đọc input/a.txt ..."    → produces only report.md
 *  G9 "Create a.txt and b.txt, then summarize into outbox/comparison.md"
 *      → producer artifacts per current multi-stage semantics
 *
 * False-positive guards: consume/check/delivery verbs must never mint
 * `produces`; the VI verbs share the same nearest-verb attribution as EN.
 */

import { describe, expect, it } from "vitest";
import { extractGoalContract } from "../pair/goal-contract.js";
import { assertPlanCoverage } from "../pair/plan-coverage.js";
import {
  extractTaskDataflow,
  reconcilePlanDataflow,
} from "../pair/plan-dataflow.js";

const df = (instruction: string) =>
  extractTaskDataflow({ task_key: "T", task_instruction: instruction });

describe("P-GRAMMAR3 A — Vietnamese produce lists (incident shape)", () => {
  it("G1. Tạo hai file input/a.txt và input/b.txt → produces exactly both paths", () => {
    expect(df("Tạo hai file input/a.txt và input/b.txt").produces).toEqual([
      "input/a.txt",
      "input/b.txt",
    ]);
  });

  it("G2. Tạo 2 file a.md và b.json → both produced", () => {
    expect(df("Tạo 2 file a.md và b.json").produces).toEqual([
      "a.md",
      "b.json",
    ]);
  });

  it("G3. Tạo các file a.md, b.csv và c.txt → all 3 produced", () => {
    expect(df("Tạo các file a.md, b.csv và c.txt").produces).toEqual([
      "a.md",
      "b.csv",
      "c.txt",
    ]);
  });

  it("G4. Create two files a.txt and b.txt → both produced", () => {
    expect(df("Create two files a.txt and b.txt").produces).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("G5. Write x.md, y.json and z.csv → all 3 produced", () => {
    expect(df("Write x.md, y.json and z.csv").produces).toEqual([
      "x.md",
      "y.json",
      "z.csv",
    ]);
  });

  it("sibling VI produce verbs share the same attribution — Ghi hai file / Viết report và chart", () => {
    expect(df("Ghi hai file x.txt và y.txt").produces).toEqual([
      "x.txt",
      "y.txt",
    ]);
    expect(df("Viết report.md và chart.csv").produces.sort()).toEqual([
      "chart.csv",
      "report.md",
    ]);
  });
});

describe("P-GRAMMAR3 B — consume/check/delivery verbs never mint produces", () => {
  it("G6. Đọc input/a.txt và input/b.txt → consumes, NOT produces", () => {
    const r = df("Đọc input/a.txt và input/b.txt");
    expect(r.produces).toEqual([]);
    expect(r.consumes).toEqual(["input/a.txt", "input/b.txt"]);
  });

  it("G7. So sánh a.txt và b.txt → NOT produces", () => {
    const r = df("So sánh a.txt và b.txt");
    expect(r.produces).toEqual([]);
    expect(r.consumes).toEqual(["a.txt", "b.txt"]);
  });

  it("Gửi report.md và chart.png tới Telegram → NOT newly-produced (delivery semantics unchanged)", () => {
    expect(df("Gửi report.md và chart.png tới Telegram").produces).toEqual([]);
  });

  it("Kiểm tra result.csv và summary.md → NOT produces", () => {
    expect(df("Kiểm tra result.csv và summary.md").produces).toEqual([]);
  });
});

describe("P-GRAMMAR3 C — mixed clauses + boundary forms", () => {
  it("G8. Tạo report.md rồi đọc input/a.txt và input/b.txt → produces only report.md, consumes both inputs", () => {
    const r = df("Tạo report.md rồi đọc input/a.txt và input/b.txt");
    expect(r.produces).toEqual(["report.md"]);
    expect(r.consumes).toEqual(["input/a.txt", "input/b.txt"]);
  });

  it("G9. Create a.txt and b.txt, then summarize them into outbox/comparison.md → multi-stage semantics preserved", () => {
    const r = df(
      "Create a.txt and b.txt, then summarize them into outbox/comparison.md",
    );
    expect(r.produces).toEqual([
      "a.txt",
      "b.txt",
      "outbox/comparison.md",
    ]);
  });

  it("tóm tắt … vào outbox/<file> transfers to a produce (vào = VI destination marker)", () => {
    expect(df("Tóm tắt nội dung vào outbox/sum.md").produces).toEqual([
      "outbox/sum.md",
    ]);
  });

  it("diacritic-edge lexemes attribute correctly — mở/đọc … trong file stays a consume", () => {
    const r = df("Đọc dữ liệu trong file data.csv");
    expect(r.produces).toEqual([]);
    expect(r.consumes).toEqual(["data.csv"]);
  });
});

describe("P-GRAMMAR3 D — Goal Contract keeps full relative paths", () => {
  it("dir-scoped deliverable targets keep their directory: input/a.txt is NOT basename-dropped", () => {
    const c = extractGoalContract(
      "Tạo hai file input/a.txt và input/b.txt với nội dung mẫu khác nhau, rồi tạo outbox/comparison.md bằng tiếng Việt.",
    );
    const targets = c.deliverables.map((d) => d.target);
    expect(targets).toContain("input/a.txt");
    expect(targets).toContain("outbox/comparison.md");
  });

  it("bare filenames keep their bare target (no regression)", () => {
    const c = extractGoalContract("create report.md");
    expect(c.deliverables[0].target).toBe("report.md");
  });
});

describe("P-GRAMMAR3 E — incident mission end-to-end", () => {
  const GOAL =
    "Tạo hai file input/a.txt và input/b.txt với nội dung mẫu khác nhau, " +
    "sau đó dùng một task khác đọc cả hai file, so sánh điểm giống nhau, " +
    "khác nhau và mâu thuẫn, rồi tạo outbox/comparison.md bằng tiếng Việt. " +
    "Không truy cập Internet và không sử dụng bất kỳ nguồn bên ngoài nào.";

  const tasks = [
    {
      task_key: "T2",
      task_instruction:
        "Tạo hai file input/a.txt và input/b.txt với nội dung mẫu khác nhau " +
        "bằng tiếng Việt về cùng một chủ đề, có điểm giống nhau, khác nhau " +
        "và ít nhất một mâu thuẫn rõ ràng. Không truy cập Internet.",
      required_capabilities: ["FILE_OPERATIONS"],
      depends_on: [],
    },
    {
      task_key: "T3",
      task_instruction:
        "Đọc cả hai file input/a.txt và input/b.txt, so sánh điểm giống " +
        "nhau, khác nhau và mâu thuẫn, rồi tạo outbox/comparison.md " +
        "bằng tiếng Việt.",
      required_capabilities: ["REASONING", "FILE_OPERATIONS"],
      depends_on: ["T2"],
    },
  ];

  it("T2 produces both inputs; T3 consumes both and produces the report", () => {
    const t2 = extractTaskDataflow(tasks[0]);
    const t3 = extractTaskDataflow(tasks[1]);
    expect(t2.produces).toEqual(["input/a.txt", "input/b.txt"]);
    expect(t2.consumes).toEqual([]);
    expect(t3.consumes).toEqual(["input/a.txt", "input/b.txt"]);
    expect(t3.produces).toEqual(["outbox/comparison.md"]);
  });

  it("coverage + reconcile PASS — no FAIL_CLOSED_PLAN_INCOMPLETE on the exact incident shape", () => {
    const contract = extractGoalContract(GOAL);
    const report = assertPlanCoverage(contract, tasks);
    expect(report.rows.every((r) => r.state !== "VIOLATED")).toBe(true);
    const out = reconcilePlanDataflow(tasks);
    const t3 = out.tasks.find((t) => t.task_key === "T3")!;
    expect(
      (
        t3.metadata as Record<string, { consumes?: string[] }>
      ).pair_dataflow.consumes,
    ).toEqual(["input/a.txt", "input/b.txt"]);
  });
});
