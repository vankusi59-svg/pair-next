import { subjectAnchors, externalSubjectKeys } from "../../src/pair/llm-planner.js";
import { extractGoalContract, contractRequirements } from "../../src/pair/goal-contract.js";
import { assertPlanCoverage } from "../../src/pair/plan-coverage.js";
const c = extractGoalContract("produce exactly 3 reports");
for (const r of contractRequirements(c)) {
  console.log(r.id, r.kind, JSON.stringify(r.text), JSON.stringify(r.quantity));
  console.log("  anchors:", [...subjectAnchors(r.text)], "keys:", [...externalSubjectKeys(r.text)]);
}
const t = { task_key: "t1", task_instruction: "produce 3 reports" };
console.log("task anchors:", [...subjectAnchors("produce 3 reports")], "keys:", [...externalSubjectKeys("produce 3 reports")]);
try { console.log("verdict:", JSON.stringify(assertPlanCoverage(c, [t] as never[]))); }
catch (e) { console.log("THROW:", (e as Error).message.slice(0, 200)); }
