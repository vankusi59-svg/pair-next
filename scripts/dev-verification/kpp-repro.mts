import { extractGoalContract, contractRequirements } from "../../src/pair/goal-contract.ts";

for (const g of [
  // F1 — không cần relief-vs-ban
  "loại bỏ các phần không cần thiết trong báo cáo",
  "viết báo cáo, không cần kiểm tra lại",
  "không cần dùng martingale",
  // F2 — deadline date shapes
  "submit the report by 15/10",
  "nộp trước ngày 15/10",
  // F3 — ranges
  "viết báo cáo trong 30-45 ngày",
  "finish in 2-3 weeks",
  "trong vòng 5-7 giờ",
  // F4 — constraint-shaped backstop ceiling
  "budget max $500 for the analysis",
  "tối đa tháng 500 đơn hàng",
  // regression anchors
  "Viết báo cáo trước 10 giờ",
  "Tăng 500 người đăng ký trong vòng 30 giờ",
  "không dùng martingale",
  "Grow the channel by 500 subscribers within 30 days",
]) {
  const c = extractGoalContract(g);
  const reqs = contractRequirements(c);
  console.log(
    JSON.stringify({
      g,
      obl: c.obligations.map((o) => ({ t: o.text, q: o.quantity })),
      ddl: !!c.deadline,
      pro: reqs.filter((r) => r.kind === "prohibition").map((r) => (r as { terms?: string[] }).terms),
    }),
  );
}
