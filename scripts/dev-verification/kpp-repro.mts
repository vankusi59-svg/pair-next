import { extractGoalContract, contractRequirements } from "../../src/pair/goal-contract.ts";

for (const g of [
  "Viết báo cáo trước 10 giờ",
  "Tăng 500 người đăng ký trong vòng 30 giờ",
  "Viết bài trong vòng 30 phút",
  "Viết báo cáo trong 30 giây",
  "Xong trong khoảng 30 giây",
  "Gửi kết quả trước ngày 15",
  "viết báo cáo trước thứ 6",
  "trước tuần 15",
  "quý 3 nộp báo cáo",
  "finish by day 365",
  "trước ngày 15/10",
  "chỉ cần viết báo cáo",
  "chỉ muốn xem giá vàng",
  "chỉ được dùng CSV khi tải dữ liệu",
  "chỉ số giá",
  "tăng 500 đăng ký chỉ trong 30 ngày",
  "tháng 500 đơn mỗi tháng",
  "không quá 50 USD mỗi tháng",
  "Grow the channel by 500 subscribers within 30 days",
]) {
  const c = extractGoalContract(g);
  const con = contractRequirements(c).filter((r) => r.kind === "constraint");
  console.log(
    JSON.stringify({
      g,
      obl: c.obligations.map((o) => ({ t: o.text, q: o.quantity })),
      ddl: !!c.deadline,
      only: con.map((r) => (r as { onlyTerms?: string[] }).onlyTerms ?? null),
    }),
  );
}
