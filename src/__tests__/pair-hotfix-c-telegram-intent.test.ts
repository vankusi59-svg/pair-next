/**
 * HOTFIX-C — Telegram CONTENT-PRODUCTION vs DELIVERY intent
 * (`plan-dataflow.ts::detectTelegramDeliveryIntent`).
 *
 * Root cause (live): the production work-item goal
 *   "Sản xuất gói bài đăng Telegram sẵn dùng gồm bài giới thiệu giá trị
 *    kênh, hướng dẫn công cụ miễn phí, nội dung giáo dục quản trị rủi ro
 *    và lời mời chia sẻ; kèm lịch đăng, playbook phân phối và mẫu theo
 *    dõi nguồn tham gia, ghi nhận artifact cùng bằng chứng thực thi được
 *    xác minh qua canonical chain."
 * made the intent detector return `requested=true` — TWO candidate
 * `đăng` tokens (`bài đăng`, `lịch đăng`) inside CLAUSE_SPAN of the
 * Telegram mention — so the governed presence gate threw
 * FAIL_CLOSED_DELIVERY_TASK_MISSING on a pure production plan.
 * Pre-fix verified: requested=true on BASE 72d3715.
 *
 * Fix: Vietnamese noun heads sit BEFORE the token — a bounded left
 * neighbor (`bài`, `lịch`, `gói`, classifiers/determiners/numerals/
 * content nouns/write-verbs) makes `đăng` a noun compound; the compound
 * verb `đăng ký` (subscribe) is likewise never a send. Verb-object
 * order ("đăng bài lên kênh") is untouched; independent delivery
 * clauses in the same goal still authorize.
 */
import { describe, expect, it } from "vitest";
import {
  detectTelegramDeliveryIntent,
  assertDeliveryTaskPresence,
  reconcilePlanDataflow,
  isDeliveryTask,
  PAIR_DELIVERY_INJECTION_KEY,
} from "../pair/plan-dataflow.js";
import {
  makeServeCanonicalizer,
  SERVE_LLM_PLANNER_CAPS,
} from "../pair/serve-planner.js";

const FULL_SETS = [SERVE_LLM_PLANNER_CAPS.slice()];

const NETREQ_LOCAL = {
  source_kind: "LOCAL",
  access_intent: "READ",
  freshness: "NOT_REQUIRED",
} as const;

const work = (
  key: string,
  instruction: string,
  caps: string[],
  depends_on: string[] = [],
) => ({
  task_key: key,
  title: key,
  task_instruction: instruction,
  required_capabilities: caps,
  depends_on,
  metadata: { network_requirement: NETREQ_LOCAL },
});

/** The exact live work-item goal (verbatim, UTF-8 VN). */
const PROD_GOAL =
  "Sản xuất gói bài đăng Telegram sẵn dùng gồm bài giới thiệu giá trị kênh, " +
  "hướng dẫn công cụ miễn phí, nội dung giáo dục quản trị rủi ro và lời mời " +
  "chia sẻ; kèm lịch đăng, playbook phân phối và mẫu theo dõi nguồn tham gia, " +
  "ghi nhận artifact cùng bằng chứng thực thi được xác minh qua canonical chain.";

const PRODUCTION_TASKS = () => [
  work("T1", "soạn bài giới thiệu giá trị kênh và hướng dẫn công cụ miễn phí", ["REASONING"]),
  work("T2", "soạn lịch đăng và playbook phân phối", ["REASONING"], ["T1"]),
  work("T3", "tổng hợp gói artifact và bằng chứng thực thi", ["REASONING"], ["T2"]),
];

describe("HOTFIX-C telegram intent — content-production vs delivery", () => {
  describe("negative intent — VN/EN production noun compounds", () => {
    it.each([
      // HC1 — exact live goal: `bài đăng` + `lịch đăng` both inside span.
      PROD_GOAL,
      // HC2 — numeral + classifier compound.
      "Sản xuất 10 bài đăng Telegram",
      // HC3 — `nội dung` + `lịch đăng` compounds.
      "Tạo gói nội dung và lịch đăng cho kênh Telegram",
      // HC4 — EN plural noun (never matched the verb boundary) + schedule.
      "Create five Telegram posts and a posting schedule",
      // HC5 — production wording inside a non-delivery task instruction.
      "Soạn gói bài đăng Telegram cho chiến dịch tuần này",
      // HC6 — `đăng ký` = subscribe, never a send instruction.
      "đăng ký kênh Telegram để nhận tin",
      // HC7 — negation still negates the real verb form.
      "Không đăng bài lên Telegram",
    ])("requested=false: %s", (goal) => {
      expect(detectTelegramDeliveryIntent(goal).requested).toBe(false);
    });
  });

  describe("positive intent — verb-object order and independent send clauses preserved", () => {
    it.each([
      // HC8 — `đăng` + object AFTER = real publish verb.
      "Đăng bài lên Telegram",
      "Đăng tin lên Telegram",
      // HC9 — `gửi` verb clause.
      "Gửi kết quả lên kênh Telegram",
      // HC10 — EN verb form with object between verb and channel.
      "Post the report to Telegram",
      // HC11 — noun compound first, then an INDEPENDENT send clause.
      "Viết 5 bài đăng rồi gửi các bài đó lên Telegram",
      "Soạn lịch đăng xong gửi bài lên Telegram",
    ])("requested=true: %s", (goal) => {
      expect(detectTelegramDeliveryIntent(goal).requested).toBe(true);
    });
  });

  describe("integration — governed seams", () => {
    it("HC12: production plan + production intent passes canonical reconcile — zero delivery tasks (the persisted/fallback MISSING path)", () => {
      const intent = detectTelegramDeliveryIntent(PROD_GOAL);
      expect(intent.requested).toBe(false);
      const { tasks } = reconcilePlanDataflow(PRODUCTION_TASKS(), {
        telegramIntent: intent,
      });
      expect(tasks.filter(isDeliveryTask)).toHaveLength(0);
    });

    it("HC13: production goal through the serve canonicalizer — no injection, no throw", () => {
      const canon = makeServeCanonicalizer({ executorCapSets: () => FULL_SETS });
      const out = canon(PRODUCTION_TASKS(), PROD_GOAL);
      expect(out.filter(isDeliveryTask)).toHaveLength(0);
    });

    it("HC14: a TRUE delivery intent with zero delivery tasks still fails MISSING at the presence gate", () => {
      const intent = detectTelegramDeliveryIntent("Đăng bài lên Telegram");
      expect(intent.requested).toBe(true);
      expect(() =>
        assertDeliveryTaskPresence(PRODUCTION_TASKS(), intent)
      ).toThrow(/DELIVERY_TASK_MISSING/);
    });

    it("HC15: genuine-omission injection still works — real intent + zero emission ⇒ governed delivery task injected", () => {
      const canon = makeServeCanonicalizer({ executorCapSets: () => FULL_SETS });
      const goal = "Gửi kết quả lên kênh Telegram";
      const raw = [
        work("T1", "đọc dữ liệu và tổng hợp kết quả", ["REASONING"]),
        work("T2", "tóm tắt phân tích", ["REASONING"], ["T1"]),
      ];
      const out = canon(raw, goal);
      const injected = out.filter(isDeliveryTask);
      expect(injected).toHaveLength(1);
      const rec = (injected[0]!.metadata as Record<string, unknown>)[
        PAIR_DELIVERY_INJECTION_KEY
      ] as { reason: string; authority: string };
      expect(rec.reason).toBe("DELIVERY_TASK_INJECTED");
      expect(rec.authority).toBe("OPERATOR_TELEGRAM_INTENT");
    });

    it("HC16: unauthorized emission still fails closed — delivery task without operator request", () => {
      const canon = makeServeCanonicalizer({ executorCapSets: () => FULL_SETS });
      const raw = [
        ...PRODUCTION_TASKS(),
        work("T4", "send summary.txt to telegram", ["TELEGRAM_DELIVERY"], ["T3"]),
      ];
      expect(() => canon(raw, PROD_GOAL)).toThrow(/TELEGRAM_DELIVERY_INTENT/);
    });
  });
});
