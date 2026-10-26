import { extractGoalContract } from "../../src/pair/goal-contract.js";
import { assertPlanCoverage } from "../../src/pair/plan-coverage.js";
const cov = (g: string, tasks: any[]) => assertPlanCoverage(extractGoalContract(g), tasks);
const w = (k: string, i: string) => ({ task_key: k, title: k, task_instruction: i, required_capabilities: ["REASONING"], depends_on: [], metadata: { network_requirement: { source_kind: "LOCAL", access_intent: "READ", freshness: "NOT_REQUIRED" } } });
const run = (label: string, fn: () => any, expectThrow?: RegExp) => {
  try { const r = fn(); console.log(`${expectThrow ? "FAIL" : "PASS"} ${label}: ${JSON.stringify(r).slice(0, 120)}`); }
  catch (e: any) { console.log(`${expectThrow && expectThrow.test(String(e.code ?? e.message)) ? "PASS" : "FAIL"} ${label}: threw ${e.code}`); }
};
run("F5 5 technical reports > 3 → VIOLATION", () => cov("write reports, no more than 3 reports", [w("t", "write 5 technical reports")]), /VIOLATION/);
run("F5 5 technical reports = 5 → PROVEN", () => cov("write reports, no more than 5 reports", [w("t", "write 5 technical reports")]).rows.find((r: any) => r.kind === "constraint")?.state);
run("F5 no evidence → PRESERVED", () => cov("write reports, no more than 5 reports", [w("t", "write reports")]).rows.find((r: any) => r.kind === "constraint")?.state);
