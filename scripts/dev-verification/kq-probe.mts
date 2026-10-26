import { extractGoalContract, contractRequirements } from "../../src/pair/goal-contract.ts";
const c = extractGoalContract("Research VPN providers, không quá 50 USD mỗi tháng");
console.log(JSON.stringify(c.obligations.map((o) => ({ t: o.text, q: o.quantity }))));
console.log(JSON.stringify(contractRequirements(c).map((r) => ({ id: r.id, kind: r.kind, ot: (r as { onlyTerms?: string[] }).onlyTerms }))));
