import { describe, expect, it } from "vitest";
import {
  assertPlanDataflow,
  extractTaskDataflow,
  reconcilePlanDataflow,
} from "../pair/plan-dataflow.js";

const df = (instruction: string) =>
  extractTaskDataflow({ task_key: "T", task_instruction: instruction });

describe("DEBT-A — production incident (hermes-agent plan)", () => {
  const T1 =
    "Truy cập https://github.com/NousResearch/hermes-agent và nghiên cứu repository NousResearch/hermes-agent. Thu thập README, cấu trúc mã nguồn và các thông tin công khai cần thiết về kiến trúc, khả năng chính và hạn chế. Chỉ sử dụng website github.com, không truy cập website khác hoặc theo liên kết ra ngoài github.com. Ghi đầy đủ phát hiện, đường dẫn nguồn GitHub và những điểm chưa xác minh vào hermes_findings.md. Return the full findings as final result text, then reply DONE.";
  const T2 =
    "Đọc hermes_findings.md và viết bản tóm tắt bằng tiếng Việt về repository NousResearch/hermes-agent vào outbox/hermes_review.md, gồm kiến trúc, khả năng chính và hạn chế. Dẫn các nguồn đã được ghi trong hermes_findings.md, phân biệt thông tin đã xác minh với nhận định và điểm chưa rõ. Không truy cập thêm website nào. Tạo thư mục outbox nếu cần, then reply DONE.";

  it("A1. T1: produces [hermes_findings.md], consumes [] — github.com is a host, not an artifact", () => {
    expect(df(T1)).toEqual({
      produces: ["hermes_findings.md"],
      consumes: [],
    });
  });

  it("A2. T2: consumes hermes_findings.md (đọc + passive ref), produces outbox/hermes_review.md only", () => {
    expect(df(T2)).toEqual({
      produces: ["outbox/hermes_review.md"],
      consumes: ["hermes_findings.md"],
    });
  });

  it("A3. full incident plan passes reconcile + assertPlanDataflow — no UNBOUND_INPUT", () => {
    const { tasks } = reconcilePlanDataflow([
      {
        task_key: "T1",
        task_instruction: T1,
        depends_on: [],
        required_capabilities: ["NETWORK_ACCESS", "SHELL_EXECUTION"],
      },
      {
        task_key: "T2",
        task_instruction: T2,
        depends_on: ["T1"],
        required_capabilities: ["REASONING", "FILE_OPERATIONS"],
      },
    ]);
    expect(() => assertPlanDataflow(tasks)).not.toThrow();
  });
});

describe("DEBT-A B — hosts/domains never mint artifacts", () => {
  it("B1. 'Chỉ sử dụng website github.com' → no artifact", () => {
    const d = df(
      "Chỉ sử dụng website github.com, không truy cập website khác. Ghi kết quả vào outbox/r.md.",
    );
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual(["outbox/r.md"]);
  });

  it("B2. 'use github.com' (EN consume verb) → no artifact", () => {
    const d = df("use github.com to fetch data and write outbox/r.md");
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual(["outbox/r.md"]);
  });

  it("B3. 'đọc tài liệu trên react.dev' → no artifact", () => {
    const d = df("đọc tài liệu trên react.dev rồi viết vào outbox/r.md");
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual(["outbox/r.md"]);
  });

  it("B4. 'example.org' bare mention → no artifact", () => {
    const d = df("Tham khảo example.org và so sánh input/a.txt");
    expect(d.consumes).toEqual(["input/a.txt"]);
    expect(d.produces).toEqual([]);
  });

  it("B5. 'api.openai.com' multi-label stays invisible AND leaf 'openai.com' never mints", () => {
    const d = df("Truy cập api.openai.com để lấy docs và viết outbox/s.md");
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual(["outbox/s.md"]);
  });
});

describe("DEBT-A C — version strings never mint artifacts", () => {
  it("C1. 'Dùng model gpt-6.1 và version v1.2' → neither mints", () => {
    const d = df(
      "Dùng model gpt-6.1 và version v1.2 để phân tích input/a.txt. Viết kết quả vào outbox/r.md.",
    );
    expect(d.consumes).toEqual(["input/a.txt"]);
    expect(d.produces).toEqual(["outbox/r.md"]);
  });

  it("C2. 'use version 2.4' → no artifact", () => {
    const d = df("use version 2.4 and read input/a.txt then write outbox/r.md");
    expect(d.consumes).toEqual(["input/a.txt"]);
    expect(d.produces).toEqual(["outbox/r.md"]);
  });
});

describe("DEBT-A D — real workspace artifacts still mint", () => {
  it("D1. 'Đọc input/a.txt' → consume", () => {
    expect(df("Đọc input/a.txt").consumes).toEqual(["input/a.txt"]);
  });

  it("D2. 'Đọc input/a.txt và input/b.txt' → both consumes (P-GRAMMAR3 list intact)", () => {
    expect(df("Đọc input/a.txt và input/b.txt").consumes).toEqual([
      "input/a.txt",
      "input/b.txt",
    ]);
  });

  it("D3. 'Ghi kết quả vào report.md' → produce", () => {
    expect(df("Ghi kết quả vào report.md").produces).toEqual(["report.md"]);
  });

  it("D4. 'Tạo outbox/result.json' → produce", () => {
    expect(df("Tạo outbox/result.json").produces).toEqual([
      "outbox/result.json",
    ]);
  });

  it("D5. 'Đọc src/index.ts' → consume", () => {
    expect(df("Đọc src/index.ts").consumes).toEqual(["src/index.ts"]);
  });

  it("D6. P-GRAMMAR3 list: 'Tạo hai file input/a.txt và input/b.txt' → both produced", () => {
    expect(df("Tạo hai file input/a.txt và input/b.txt").produces).toEqual([
      "input/a.txt",
      "input/b.txt",
    ]);
  });
});

describe("DEBT-A E — '.js' ambiguity truth table", () => {
  it("E1. 'Đọc file node.js' file context → consume node.js (kept)", () => {
    expect(df("Đọc file node.js").consumes).toEqual(["node.js"]);
  });

  it("E2. 'Tham khảo node.js docs' → docs marker, no artifact", () => {
    const d = df("Tham khảo node.js docs rồi viết outbox/r.md");
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual(["outbox/r.md"]);
  });

  it("E3. 'website node.js' → website marker, no artifact", () => {
    const d = df("Sử dụng thông tin trên website node.js và viết outbox/r.md");
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual(["outbox/r.md"]);
  });

  it("E4. 'trên node.js' — bare trên is NOT external evidence; `đọc` mints consume (ambiguous → no heuristic expansion, R2.A)", () => {
    const d = df("Đọc tài liệu trên node.js và viết outbox/r.md");
    expect(d.consumes).toEqual(["node.js"]);
    expect(d.produces).toEqual(["outbox/r.md"]);
  });

  it("E5. 'Đọc src/node.js' → real path always mints", () => {
    expect(df("Đọc src/node.js").consumes).toEqual(["src/node.js"]);
  });
});

describe("DEBT-A F — passive '(đã) được <produce-verb> trong X' never invents a producer", () => {
  it("F1. passive cite → consume hermes_findings.md, produce only outbox/", () => {
    const d = df(
      "Đọc các phát hiện đã được ghi trong hermes_findings.md và viết bản tóm tắt vào outbox/hermes_review.md",
    );
    expect(d.produces).toEqual(["outbox/hermes_review.md"]);
    expect(d.consumes).toEqual(["hermes_findings.md"]);
  });

  it("F2. 'được viết trong' variant also demotes", () => {
    const d = df("Tóm tắt nội dung được viết trong report.md rồi lưu kết quả vào outbox/t.md");
    expect(d.produces).toEqual(["outbox/t.md"]);
    expect(d.consumes).toEqual(["report.md"]);
  });

  it("F3. control: 'Ghi kết quả vào x.md' active → produce", () => {
    expect(df("Ghi kết quả vào x.md").produces).toEqual(["x.md"]);
    expect(df("Ghi kết quả vào x.md").consumes).toEqual([]);
  });

  it("F4. control: 'Viết nội dung và lưu trong y.md' active → produce", () => {
    expect(df("Viết nội dung và lưu trong y.md").produces).toEqual(["y.md"]);
  });
});

describe("DEBT-A R2.A — bare 'trên' is not external evidence", () => {
  it("R2A.1. 'Đọc dữ liệu trên report.md' → consume report.md", () => {
    expect(df("Đọc dữ liệu trên report.md").consumes).toEqual(["report.md"]);
  });

  it("R2A.2. 'Kiểm tra dữ liệu trên baseline.csv' → consume baseline.csv", () => {
    expect(df("Kiểm tra dữ liệu trên baseline.csv").consumes).toEqual([
      "baseline.csv",
    ]);
  });

  it("R2A.3. 'So sánh dữ liệu trên baseline.csv' → consume baseline.csv", () => {
    expect(df("So sánh dữ liệu trên baseline.csv").consumes).toEqual([
      "baseline.csv",
    ]);
  });

  it("R2A.4. 'Lưu kết quả trên report.md' → produce via `lưu`, never rejected", () => {
    expect(df("Lưu kết quả trên report.md").produces).toEqual(["report.md"]);
  });
});

describe("DEBT-A R2.B — passive semantics: vào destination / trong evidence / negation", () => {
  it("R2B.1. 'Kết quả được ghi vào report.md' — passive destination keeps PRODUCE, never consume", () => {
    const d = df("Kết quả được ghi vào report.md");
    expect(d.produces).toEqual(["report.md"]);
    expect(d.consumes).toEqual([]);
  });

  it("R2B.2. 'Báo cáo được lưu vào outbox/report.md' — destination produce, not UNBOUND input", () => {
    const d = df("Báo cáo được lưu vào outbox/report.md");
    expect(d.produces).toEqual(["outbox/report.md"]);
    expect(d.consumes).toEqual([]);
  });

  it("R2B.3. 'Không được ghi trong report.md' — prohibition mints nothing", () => {
    const d = df("Không được ghi trong report.md");
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual([]);
  });

  it("R2B.4. 'Không được ghi vào report.md' — negated passive destination mints nothing", () => {
    const d = df("Không được ghi vào report.md");
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual([]);
  });

  it("R2B.5. 'được <verb> trong X' WITHOUT independent read evidence → mention ignored, never guessed", () => {
    const d = df("Kết quả được ghi trong report.md");
    expect(d.consumes).toEqual([]);
    expect(d.produces).toEqual([]);
  });

  it("R2B.6. 'được <verb> trong X' WITH independent read evidence → consume", () => {
    const d = df("Đọc các phát hiện đã được ghi trong hermes_findings.md");
    expect(d.consumes).toEqual(["hermes_findings.md"]);
    expect(d.produces).toEqual([]);
  });

  it("R2B.7. incident T2 pinned — passive cite consumes findings, produces only the review", () => {
    const d = df(
      "Đọc hermes_findings.md và viết bản tóm tắt bằng tiếng Việt vào outbox/hermes_review.md. Dẫn các nguồn đã được ghi trong hermes_findings.md.",
    );
    expect(d.consumes).toEqual(["hermes_findings.md"]);
    expect(d.produces).toEqual(["outbox/hermes_review.md"]);
  });
});
