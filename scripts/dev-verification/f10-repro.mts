import { extractGoalContract, contractRequirements } from "../../src/pair/goal-contract.js";
import { assertPlanCoverage } from "../../src/pair/plan-coverage.js";

const task = (k: string, i: string, extra: Record<string, unknown> = {}) => ({
  task_key: k, task_instruction: i, ...extra,
});
const show = (label: string, goal: string, tasks: unknown[]) => {
  const c = extractGoalContract(goal);
  const cons = contractRequirements(c).filter((r) => r.kind === "constraint");
  const ceilings = cons.map((r) => r.ceiling ?? r.maxAmount ?? null);
  let verdict = "PASS/PRESERVED";
  try { const r = assertPlanCoverage(c, tasks as never[]) as unknown; verdict = JSON.stringify(r) ?? "ok"; }
  catch (e) { verdict = (e as Error).message.split(",")[0].slice(0, 110); }
  console.log(label.padEnd(10), JSON.stringify(ceilings), "→", verdict);
};

console.log("--- enforce ---");
show("money-u ", "analyze the market, không quá 50 USD", [task("t1","analyze the market under a $30 budget")]);
show("money-o ", "analyze the market, không quá 50 USD", [task("t1","analyze the market spending $600")]);
show("money-vnd","analyze the market, không quá 50 USD", [task("t1","analyze the market for 600 USD")]);
show("money-noe","analyze the market, không quá 50 USD", [task("t1","analyze the market")]);
show("req-over", "sync the data, no more than 100 requests", [task("t1","sync the data with 500 requests")]);
show("req-und", "sync the data, no more than 100 requests", [task("t1","sync the data with 60 requests")]);
show("req-none", "sync the data, no more than 100 requests", [task("t1","sync the data")]);
show("unrel   ", "sync the data, no more than 100 requests", [task("t1","sync the data on port 8080")]);
show("task-o  ", "build the report, tối đa 3 tác vụ", [task("a","build the report intro"),task("b","build the report body"),task("c","build the report annex"),task("d","build the report index")]);
show("task-ok ", "build the report, tối đa 3 tác vụ", [task("a","build the report")]);
show("obl-ok  ", "produce at most 50 reports", [task("t1","produce 30 reports")]);
show("obl-over", "produce at most 50 reports", [task("t1","produce 60 reports")]);
show("obl-none", "produce at most 50 reports", [task("t1","produce the reports")]);
show("exact   ", "produce exactly 3 reports", [task("t1","produce 3 reports")]);
show("exact-o ", "produce exactly 3 reports", [task("t1","produce 5 reports")]);
show("dur     ", "finish the audit, tối đa 3 ngày", [task("t1","finish the audit")]);
show("files   ", "research crypto, at most 3 files", [task("t1","research crypto and write 5 files")]);
