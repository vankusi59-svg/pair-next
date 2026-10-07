/** GOAL_CONTRACT_PRODUCE_OBJECT_BINDING — regression matrix.
 *
 * A filename may mint DEL_* only when bounded deterministic grammar shows
 * a produce directive actually governs that filename — never by mere
 * clause-level co-occurrence of a produce verb and a file token. The M3
 * live blocker was a fabricated DEL_001: `tạo` governed "PR" while
 * FILE_RE picked up the modify-target `.test.ts` in the same run-on
 * clause (CASE_B false-positive).
 *
 * Negative cases here are non-vacuous: they mint on the pre-binding
 * clause-scope extractor and must NOT mint after the fix. Positive cases
 * pin the legitimate coverage that must survive (multi-file lists,
 * input→output association). */
import { describe, expect, it } from "vitest";
import { extractGoalContract } from "../pair/goal-contract.js";

const dels = (goal: string) =>
  extractGoalContract(goal).deliverables.map((d) => d.target);

const M3 =
  'Dùng remote cloud executor tạo PR trên vankusi59-svg/pair-next sửa test R5.1-crash trong src/__tests__/pair-f4-delivery-provenance.test.ts: pin attempt_started_at về timestamp cố định trước mốc reconcile "2026-10-05T02:00:00.000Z" để test không còn phụ thuộc giờ thật.';

describe("goal contract — produce→object binding: legitimate outputs kept", () => {
  it("Create report.md → DEL report.md", () => {
    expect(dels("Create report.md")).toEqual(["report.md"]);
  });

  it("Write results to report.test.ts → DEL report.test.ts", () => {
    expect(dels("Write results to report.test.ts")).toEqual([
      "report.test.ts",
    ]);
  });

  it("Tạo report.md → DEL report.md", () => {
    expect(dels("Tạo report.md")).toEqual(["report.md"]);
  });

  it("Tạo hai file a.txt và b.txt → DEL a.txt + b.txt (multi-file list preserved)", () => {
    expect(dels("Tạo hai file a.txt và b.txt")).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("Tạo a.md, b.csv và c.txt → all three DELs", () => {
    expect(dels("Tạo a.md, b.csv và c.txt")).toEqual([
      "a.md",
      "b.csv",
      "c.txt",
    ]);
  });

  it("Đọc notes.md và tạo report.md → only report.md (clause split + binding agree)", () => {
    expect(dels("Đọc notes.md và tạo report.md")).toEqual(["report.md"]);
  });
});

describe("goal contract — produce→object binding: input/output association", () => {
  it("Create report.md from notes.md → DEL report.md only, NOT notes.md (non-vacuous)", () => {
    expect(dels("Create report.md from notes.md")).toEqual(["report.md"]);
  });
});

describe("goal contract — produce→object binding: modify/source files never mint", () => {
  it("Modify src/foo.test.ts → no DEL", () => {
    expect(dels("Modify src/foo.test.ts")).toEqual([]);
  });

  it("Fix src/foo.test.ts and create a PR → no DEL (non-vacuous shape, split clause)", () => {
    expect(dels("Fix src/foo.test.ts and create a PR")).toEqual([]);
  });

  it("Sửa src/foo.test.ts để tạo PR → no DEL (non-vacuous: 'tạo' governs PR, file is modify-target)", () => {
    expect(dels("Sửa src/foo.test.ts để tạo PR")).toEqual([]);
  });

  it("Tạo PR sau khi sửa src/foo.test.ts → no DEL (non-vacuous: file sits past an action boundary)", () => {
    expect(dels("Tạo PR sau khi sửa src/foo.test.ts")).toEqual([]);
  });

  it("exact M3 goal → NO DEL_001 for the .test.ts modify-target (non-vacuous: minted CASE_B false-positive before)", () => {
    expect(dels(M3)).toEqual([]);
  });
});

/** R1 audit — over-narrowing adversarial cases. The binding must not
 *  lose legitimate deliverables: noun-phrase modifiers ("báo cáo phân
 *  tích", "test report") and destination-capable prepositions ("in",
 *  "trong") are NOT file-boundary evidence. All four mint cases below
 *  failed on the first binding iteration (non-vacuous). */
describe("goal contract — produce→object binding R1: no legitimate DEL lost", () => {
  it("Tạo báo cáo phân tích report.md → DEL report.md ('phân tích' is noun-phrase material, not a governing verb)", () => {
    expect(dels("Tạo báo cáo phân tích report.md")).toEqual(["report.md"]);
  });

  it("Create test report.md → DEL report.md ('test' modifies the noun, does not govern the file)", () => {
    expect(dels("Create test report.md")).toEqual(["report.md"]);
  });

  it("Write results in report.md → DEL report.md ('in' is destination-capable, not a source boundary)", () => {
    expect(dels("Write results in report.md")).toEqual(["report.md"]);
  });

  it("Viết kết quả trong report.md → DEL report.md ('trong' destination usage mints)", () => {
    expect(dels("Viết kết quả trong report.md")).toEqual(["report.md"]);
  });

  it("Viết từ notes.md ra report.md → DEL report.md only (source phrase does not hide the governing verb from a destination file)", () => {
    expect(dels("Viết từ notes.md ra report.md")).toEqual(["report.md"]);
  });

  it("Tạo biểu đồ từ dữ liệu trong data.csv → NO DEL (source-locative 'trong' phrase: 'từ' still bounds the file)", () => {
    expect(dels("Tạo biểu đồ từ dữ liệu trong data.csv")).toEqual([]);
  });

  it("Sửa lỗi trong src/foo.test.ts để tạo PR → NO DEL ('trong' removal stays safe: 'sửa' still governs)", () => {
    expect(dels("Sửa lỗi trong src/foo.test.ts để tạo PR")).toEqual([]);
  });

  it("Phân tích a.txt và tạo b.md → DEL b.md only (fragment removal: clause-start still bounds the analysis input)", () => {
    expect(dels("Phân tích a.txt và tạo b.md")).toEqual(["b.md"]);
  });
});

/** R2 audit — in/trong ambiguity. Passthrough locatives must distinguish
 *  `produce FILE-content in FILE` (file = deliverable) from
 *  `produce NON-FILE object in FILE` (file = the object's location).
 *  The first four no-mint cases all minted on the pre-R2 build
 *  (non-vacuous). */
describe("goal contract — produce→object binding R2: locative object class", () => {
  it("Write results in report.md → DEL report.md (file-content object)", () => {
    expect(dels("Write results in report.md")).toEqual(["report.md"]);
  });

  it("Viết kết quả trong report.md → DEL report.md (file-content object)", () => {
    expect(dels("Viết kết quả trong report.md")).toEqual(["report.md"]);
  });

  it("Create PR in src/foo.ts → NO DEL (non-vacuous: minted pre-patch — PR is the produced object, file is its location)", () => {
    expect(dels("Create PR in src/foo.ts")).toEqual([]);
  });

  it("Tạo PR trong src/foo.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Tạo PR trong src/foo.ts")).toEqual([]);
  });

  it("Create report in report.md → DEL report.md ('report' is file-content, not a non-file object)", () => {
    expect(dels("Create report in report.md")).toEqual(["report.md"]);
  });

  it("Tạo báo cáo trong report.md → DEL report.md", () => {
    expect(dels("Tạo báo cáo trong report.md")).toEqual(["report.md"]);
  });

  it("Create issue in src/foo.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Create issue in src/foo.ts")).toEqual([]);
  });

  it("Tạo commit trong src/foo.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Tạo commit trong src/foo.ts")).toEqual([]);
  });

  it("Create a PR in src/foo.ts → NO DEL (article filler does not hide the non-file object)", () => {
    expect(dels("Create a PR in src/foo.ts")).toEqual([]);
  });

  it("Create pull request in src/foo.ts → NO DEL (multi-word non-file object)", () => {
    expect(dels("Create pull request in src/foo.ts")).toEqual([]);
  });

  it("Tạo test trong src/foo.ts → NO DEL ('test' produced object locates the file)", () => {
    expect(dels("Tạo test trong src/foo.ts")).toEqual([]);
  });
});

/** R3 audit — the generic root cause behind in/trong: any non-file
 *  produced object can sit before the locative, so a denylist can never
 *  close it. The locative may only lead to a mint when positive bounded
 *  evidence shows FILE-content semantics (results/report/kết quả/báo
 *  cáo/...). Everything else → no mint: the produced object merely
 *  locates the file. All six first cases minted pre-patch
 *  (non-vacuous). */
describe("goal contract — produce→object binding R3: positive file-content evidence", () => {
  it("Create function in src/foo.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Create function in src/foo.ts")).toEqual([]);
  });

  it("Tạo hàm trong src/foo.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Tạo hàm trong src/foo.ts")).toEqual([]);
  });

  it("Create class Foo in src/foo.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Create class Foo in src/foo.ts")).toEqual([]);
  });

  it("Create method in src/foo.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Create method in src/foo.ts")).toEqual([]);
  });

  it("Create API endpoint in src/server.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Create API endpoint in src/server.ts")).toEqual([]);
  });

  it("Tạo endpoint trong src/server.ts → NO DEL (non-vacuous: minted pre-patch)", () => {
    expect(dels("Tạo endpoint trong src/server.ts")).toEqual([]);
  });

  it("Write the results in report.md → DEL report.md (positive evidence survives fillers)", () => {
    expect(dels("Write the results in report.md")).toEqual(["report.md"]);
  });

  it("Write docs in docs.md → DEL docs.md (doc-family content)", () => {
    expect(dels("Write docs in docs.md")).toEqual(["docs.md"]);
  });
});
