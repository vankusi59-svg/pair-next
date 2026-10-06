/**
 * DEBT C — sentence-final bare host extraction (live EXHAUSTED incident).
 *
 * `BARE_DOTTED_RE` right-lookahead `(?![\w/.-])` treated a
 * sentence-final `.` as token-continuing, so `...trên github.com. Mỗi
 * task...` minted NO host — the goal silently authorized only mql5.com
 * and every instruction naming github.com died UNAUTHORIZED_SOURCE →
 * FAIL_CLOSED_PLAN_NETWORK_REQUIREMENT_INVALID → re-ask → EXHAUSTED.
 * Fix: a `.` on the right blocks the match only when a label char
 * actually follows (`\.(?=[\w-])`); `@` joins the left-boundary guard
 * so `a@github.com.` never mints email-derived authority.
 */
import { describe, expect, it } from "vitest";
import {
  extractGoalHosts,
  goalAuthorizesHost,
} from "../pair/network-requirement.js";

const INCIDENT_GOAL =
  "Nghiên cứu song song hai phần: một task phân tích xu hướng EA MT5 hiện tại trên mql5.com, một task nghiên cứu các repository EA/algorithmic trading liên quan trên github.com. Mỗi task phải tạo artifact riêng trong outbox/. Sau khi cả hai hoàn tất, một task thứ ba đọc cả hai artifact, so sánh và tạo outbox/opportunity_report.md. Không gửi Telegram.";

describe("DEBT C — sentence-final bare host extraction", () => {
  it("C1 — 'github.com.' cuối câu mint host (trước: mất hoàn toàn)", () => {
    expect(extractGoalHosts("nghiên cứu repository trên github.com.")).toEqual(
      new Set(["github.com"]),
    );
  });

  it("C2 — 'github.com.' đứng giữa text (cuối clause, còn câu sau) vẫn mint", () => {
    expect(
      extractGoalHosts("liên quan trên github.com. Mỗi task phải tạo artifact"),
    ).toEqual(new Set(["github.com"]));
  });

  it("C3 — punctuation khác giữ nguyên: , : ! ? ; đều mint như trước", () => {
    for (const tail of [",", ":", "!", "?", ";"]) {
      expect(extractGoalHosts(`trên github.com${tail} tiếp`)).toEqual(
        new Set(["github.com"]),
      );
    }
  });

  it("C4 — 'a@github.com.' KHÔNG mint authority (email-derived host blocked)", () => {
    expect(extractGoalHosts("liên hệ a@github.com. rồi xong")).toEqual(new Set());
    expect(extractGoalHosts("mail admin@github.com, xong")).toEqual(new Set());
  });

  it("C5 — 'mql5.com.evil.org' vẫn là MỘT token nguyên, không truncate", () => {
    expect(extractGoalHosts("x mql5.com.evil.org y")).toEqual(
      new Set(["mql5.com.evil.org"]),
    );
  });

  it("C6 — 'outbox/report.md' / 'math.txt' / '1.2.3' behavior không đổi (vẫn không phải host)", () => {
    expect(extractGoalHosts("ghi vào outbox/report.md xong")).toEqual(new Set());
    expect(extractGoalHosts("đọc math.txt cuối.")).toEqual(new Set());
    expect(extractGoalHosts("dùng phiên bản 1.2.3 nhé")).toEqual(new Set());
  });

  it("C7 — 'github.com/path' bare-with-path vẫn không mint (boundary / giữ nguyên)", () => {
    expect(
      extractGoalHosts("xem github.com/NousResearch/hermes-agent kỹ"),
    ).toEqual(new Set());
  });

  it("C8 — URL-form branch không đổi semantics: https://host. cuối câu vẫn mint", () => {
    expect(extractGoalHosts("trên https://github.com. Mỗi task")).toEqual(
      new Set(["github.com"]),
    );
  });

  it("C9 — incident goal mint đủ {mql5.com, github.com} → github.com authorized", () => {
    const hosts = extractGoalHosts(INCIDENT_GOAL);
    expect(hosts).toEqual(new Set(["mql5.com", "github.com"]));
    expect(goalAuthorizesHost("github.com", hosts)).toBe(true);
    expect(goalAuthorizesHost("api.github.com", hosts)).toBe(true);
    expect(goalAuthorizesHost("mql5.com", hosts)).toBe(true);
    expect(goalAuthorizesHost("evil.com", hosts)).toBe(false);
  });
});
