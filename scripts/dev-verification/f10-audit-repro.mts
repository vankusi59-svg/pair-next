import { extractGoalContract } from "../../src/pair/goal-contract.js";
import { assertPlanCoverage } from "../../src/pair/plan-coverage.js";
const cons = (g: string) => extractGoalContract(g).constraints;
const cov = (g: string, tasks: any[]) => assertPlanCoverage(extractGoalContract(g), tasks);
const w = (k: string, i: string, extra?: any) => ({ task_key: k, title: k, task_instruction: i, required_capabilities: ["REASONING"], depends_on: [], ...(extra ?? {}), metadata: { network_requirement: { source_kind: "LOCAL", access_intent: "READ", freshness: "NOT_REQUIRED" }, ...(extra?.metadata ?? {}) } });
const run = (label: string, fn: () => any, expectThrow?: RegExp) => {
  try { const r = fn(); console.log(`${expectThrow ? "FAIL" : "PASS"} ${label}: ${expectThrow ? "no throw" : JSON.stringify(r).slice(0, 160)}`); }
  catch (e: any) { console.log(`${expectThrow && expectThrow.test(String(e.code ?? e.message)) ? "PASS" : "FAIL"} ${label}: threw ${e.code ?? e.message}`); }
};
// F1 — currency/word-gap ceilings must mint
for (const g of ["analyze the market, spend at most $1.50", "do it, at most $500", "cap it, at most USD 500", "limit work, maximum of 5 tasks", "xử lý, vượt quá 5 files"]) {
  const c = cons(g);
  console.log(`F1 ${JSON.stringify(g)} -> ceiling=${JSON.stringify(c[0]?.ceiling)} maxAmount=${c[0]?.maxAmount}`);
}
// F2 — decimal ceilings must not inflate
for (const g of ["x, spend at most 2.5 files", "x, budget at most $9.99"]) {
  const c = cons(g);
  console.log(`F2 ${JSON.stringify(g)} -> ceiling=${JSON.stringify(c[0]?.ceiling)} maxAmount=${c[0]?.maxAmount}`);
}
// F3 — cross-currency evidence
run("F3 đồng ceiling vs $ evidence → PRESERVED", () => cov("phân tích thị trường, tối đa 100 đồng", [w("t", "phân tích thị trường spending $50")]).rows.find((r: any) => r.kind === "constraint")?.state);
run("F3 đồng ceiling vs 500 đồng → VIOLATION", () => cov("phân tích thị trường, tối đa 100 đồng", [w("t", "phân tích thị trường với 500 đồng")]), /VIOLATION/);
// F4 — budget + object ceiling on one clause → both enforced
run("F4 budget+files: $800 task violates $500", () => cov("ship it, budget $500 max 3 files", [w("t", "ship it for $800")]), /VIOLATION/);
run("F4 budget+files: 5 files violates 3", () => cov("ship it, budget $500 max 3 files", [w("t", "ship it writing 5 files")]), /VIOLATION/);
// F4b — only + ceiling in one clause
run("F4b only slack + discord task → VIOLATION/INCOMPLETE", () => cov("send alerts only slack at most 3 tasks", [w("t", "send alerts via discord")]), /VIOLATION|INCOMPLETE/);
// F5 — modifier gap + aggregation
run("F5 5 technical reports > 3 → VIOLATION", () => cov("write docs, no more than 3 reports", [w("t", "write 5 technical reports")]), /VIOLATION/);
run("F5 4 files + 4 files under 5 → VIOLATION (sum)", () => cov("build it, at most 5 files", [w("a", "build it writing 4 files"), w("b", "build it writing 4 files")]), /VIOLATION/);
run("F5 5 technical reports under 5 → PROVEN", () => cov("write docs, no more than 5 reports", [w("t", "write 5 technical reports")]).rows.find((r: any) => r.kind === "constraint")?.state);
// F6 — currency-as-gap no longer mints floor
console.log(`F6 không quá usd 50 -> ${JSON.stringify(cons("x, không quá usd 50")[0])}`);
// F7 — OBL restatement with adjective
run("F7 produce 5 technical reports covers at-most-5", () => cov("produce at most 5 reports", [w("t", "produce 5 technical reports")]).rows[0]?.state);
// Regression sanity
run("R under-limit money → PROVEN", () => cov("analyze the market, không quá 50 USD", [w("t", "analyze the market under a $30 budget")]).rows.find((r: any) => r.kind === "constraint")?.state);
run("R no evidence → PRESERVED", () => cov("analyze the market, không quá 50 USD", [w("t", "analyze the market")]).rows.find((r: any) => r.kind === "constraint")?.state);
run("R task-count under → PROVEN", () => cov("build the report, tối đa 3 tác vụ", [w("a", "build the report")]).rows.find((r: any) => r.kind === "constraint")?.state);
