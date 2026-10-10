import { describe, expect, it } from "vitest";
import { detectTelegramDeliveryIntent } from "../pair/plan-dataflow.js";

/**
 * Telegram delivery-intent — bare `báo` inside Vietnamese compound nouns.
 *
 * Root cause reproduced on the P15.10-D post-merge E2E stack: three real
 * governed mission goals (CEO-authored, Vietnamese) started "Lập báo cáo
 * nghiên cứu ... thành viên Telegram ..." and `DELIVERY_VERB_RE` matched
 * bare `báo` inside the compound nouns `báo cáo` (report), `chỉ báo`
 * (indicator) and `quảng bá` (promotion). The clause check then bound the
 * match to the nearby Telegram mention → `requested:true` →
 * `FAIL_CLOSED_DELIVERY_TASK_MISSING` at plan time.
 *
 * The pinned contract this file protects in BOTH directions:
 * - compound nouns never authorize a send (N1–N6 below);
 * - the true Vietnamese delivery usage "báo <object> qua/lên telegram"
 *   (pinned by R3: "báo kết quả qua telegram") keeps returning true.
 */

describe("delivery intent — bare `báo` inside compound nouns must not authorize a send", () => {
  // Exact effective mission.goal values captured in
  // /home/ubuntu/pair-mc-p15d-e2e/evidence-snapshot-delivery-intent-2026-10-10T0152Z
  const REAL_FAILING_GOALS = [
    "Lập báo cáo nghiên cứu có nguồn kiểm chứng về nhu cầu chỉ báo MT5 miễn phí, nhóm người dùng mục tiêu, cách thu hút thành viên Telegram và các giới hạn quảng bá; nêu rõ thông tin sản phẩm còn thiếu, không suy diễn tính năng hoặc hiệu quả giao dịch. Không đăng công khai hoặc dùng dịch vụ trả phí.",
    "Lập báo cáo nghiên cứu về nhu cầu người dùng MT5, cách quảng bá chỉ báo miễn phí và hành trình tham gia Telegram; phân biệt thông tin có nguồn kiểm chứng với giả định, xác định thông tin sản phẩm còn thiếu. Không đăng bài công khai hoặc sử dụng dịch vụ trả phí.",
    "Lập báo cáo nghiên cứu về nhu cầu người dùng, lợi ích và giới hạn của chỉ báo, cách quảng bá tương tự và hành trình tham gia Telegram; phân biệt thông tin có căn cứ với giả định, không hứa hẹn lợi nhuận. Không đăng bài công khai hoặc sử dụng dịch vụ trả phí.",
  ];

  for (const [i, goal] of REAL_FAILING_GOALS.entries()) {
    it(`E2E mission goal ${i + 1} — "báo cáo" research deliverable → requested:false`, () => {
      expect(detectTelegramDeliveryIntent(goal).requested).toBe(false);
    });
  }

  const NEGATIVES: Array<[string, string]> = [
    ["N1", "Nghiên cứu chỉ báo MT5 để tăng thành viên Telegram."],
    ["N2", "Viết báo cáo phân tích về tăng trưởng Telegram."],
    ["N3", "Xây dựng báo cáo nghiên cứu các kênh quảng bá Telegram."],
    ["N4", "Không gửi báo cáo lên Telegram."],
    ["N5", "Không đăng bài công khai."],
    ["N6", "Đề xuất 3 kênh phân phối và 5 ý tưởng quảng bá."],
    // compound variants that must stay negative even near a mention
    ["N7", "Cập nhật chỉ báo momentum và báo cáo so sánh qua Telegram."],
    ["N8", "Phân tích quảng bá chỉ báo miễn phí trong cộng đồng Telegram."],
  ];
  for (const [id, goal] of NEGATIVES) {
    it(`${id} → requested:false (${goal.slice(0, 60)})`, () => {
      expect(detectTelegramDeliveryIntent(goal).requested).toBe(false);
    });
  }

  const POSITIVES: Array<[string, string]> = [
    ["P1", "báo kết quả qua telegram"],
    ["P2", "Gửi báo cáo lên Telegram."],
    ["P3", "Send report.txt to Telegram."],
    ["P4", "Đăng nội dung lên kênh Telegram."],
    ["P5", "Gửi file report.md qua Telegram."],
    ["P6", "Báo kết quả phân tích lên nhóm Telegram."],
  ];
  for (const [id, goal] of POSITIVES) {
    it(`${id} → requested:true (${goal.slice(0, 60)})`, () => {
      expect(detectTelegramDeliveryIntent(goal).requested).toBe(true);
    });
  }
});
