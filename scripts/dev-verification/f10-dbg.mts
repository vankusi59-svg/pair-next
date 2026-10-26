import { subjectAnchors, externalSubjectKeys } from "../../src/pair/llm-planner.js";
import { extractGoalContract, contractRequirements } from "../../src/pair/goal-contract.js";
const c = extractGoalContract("produce at most 50 reports");
for (const r of contractRequirements(c)) {
  console.log(r.id, r.kind, JSON.stringify(r.text), "qty:", JSON.stringify(r.quantity), "ceil:", JSON.stringify(r.ceiling));
  console.log("  anchors:", [...subjectAnchors(r.text)], "keys:", [...externalSubjectKeys(r.text)]);
}
for (const t of ["produce 30 reports", "produce 60 reports", "write the reports"]) {
  console.log(t, "→ anchors:", [...subjectAnchors(t)]);
}
