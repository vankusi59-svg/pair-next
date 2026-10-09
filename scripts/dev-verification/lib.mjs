// PAIR Development Verification Harness V1 — declarative core.
// Pure functions only: classification, risk, claim schema, plan
// selection. No I/O here — run.mjs supplies git/exec; tests inject
// fake inputs. Never an authority source for production PAIR.

export const SURFACES = [
  "PLANNER", "DELIVERY", "CONVERSATION", "MISSION_DRAFT",
  "MISSION_CONTROL", "GATE_ROUTER", "ARTIFACT", "REMOTE_EXECUTION",
  "RECOVERY_REPLAY", "BUSINESS_OBJECTIVE", "TELEGRAM_INGRESS", "UI",
  "DEV_INFRA",
];

/** Literal file → surfaces (exact path match wins over prefixes). */
const SURFACE_FILES = {
  "src/pair/serve-planner.ts": ["PLANNER", "DELIVERY", "RECOVERY_REPLAY"],
  "src/pair/plan-dataflow.ts": ["PLANNER", "DELIVERY"],
  "src/pair/llm-planner.ts": ["PLANNER"],
  "src/pair/codex-planner.ts": ["PLANNER"],
  "src/pair/planner-pool.ts": ["PLANNER"],
  "src/pair/plan-coverage.ts": ["PLANNER"],
  "src/pair/plan-feasibility.ts": ["PLANNER"],
  "src/pair/goal-contract.ts": ["PLANNER"],
  "src/pair/sanitizer.ts": ["PLANNER"],
  "src/pair/mission-draft.ts": ["MISSION_DRAFT", "CONVERSATION"],
  "src/pair/plan-preview.ts": ["MISSION_DRAFT"],
  "src/pair/proposal.ts": ["CONVERSATION", "MISSION_DRAFT"],
  "src/pair/conversation-session.ts": ["CONVERSATION"],
  "src/pair/conversation-reasoning.ts": ["CONVERSATION"],
  "src/pair/telegram-conversation.ts": ["TELEGRAM_INGRESS", "CONVERSATION"],
  "src/pair/telegram-delivery.ts": ["DELIVERY", "TELEGRAM_INGRESS"],
  "src/pair/telegram-transport.ts": ["TELEGRAM_INGRESS", "DELIVERY"],
  "src/pair/output-language.ts": ["DELIVERY"],
  "src/pair/mission-control.ts": ["MISSION_CONTROL"],
  "src/pair/mission-control-server.ts": ["MISSION_CONTROL"],
  "src/pair/mission-observability.ts": ["MISSION_CONTROL"],
  "src/pair/mc-token.ts": ["MISSION_CONTROL"],
  "src/pair/mission-router.ts": ["GATE_ROUTER"],
  "src/pair/mission-runtime.ts": ["RECOVERY_REPLAY", "GATE_ROUTER"],
  "src/pair/mission-supervisor.ts": ["RECOVERY_REPLAY"],
  "src/pair/mission-schedule.ts": ["RECOVERY_REPLAY"],
  "src/pair/mission-scheduler.ts": ["RECOVERY_REPLAY"],
  "src/pair/gate.ts": ["GATE_ROUTER"],
  "src/pair/capability-router.ts": ["GATE_ROUTER"],
  "src/pair/route-selector.ts": ["GATE_ROUTER"],
  "src/pair/route-ledger.ts": ["GATE_ROUTER"],
  "src/pair/route-registry.ts": ["GATE_ROUTER"],
  "src/pair/routing-projection.ts": ["GATE_ROUTER"],
  "src/pair/executor-registry.ts": ["GATE_ROUTER"],
  "src/pair/model-routable.ts": ["GATE_ROUTER"],
  "src/pair/worker-protocol.ts": ["GATE_ROUTER", "REMOTE_EXECUTION"],
  "src/pair/worker-runner.ts": ["GATE_ROUTER", "REMOTE_EXECUTION"],
  "src/pair/work-graph.ts": ["PLANNER", "RECOVERY_REPLAY"],
  "src/pair/recovery-controller.ts": ["RECOVERY_REPLAY"],
  "src/pair/reconciliation.ts": ["RECOVERY_REPLAY"],
  "src/pair/persistence.ts": ["RECOVERY_REPLAY"],
  "src/pair/store.ts": ["RECOVERY_REPLAY"],
  "src/pair/business.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-authority.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-workstream.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-operating-loop.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-adaptive-review.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/ceo-decision.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/ceo-planning-cycle.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/ceo-runtime.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/workforce-allocation.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/workforce-allocation-evidence.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/work-open-binding.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/work-completion.ts": ["RECOVERY_REPLAY"],
  "src/pair/promotion-service.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/experience.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/experience-advisors.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/experience-extraction.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/experience-verifier.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/self-improvement.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/routine-mirror.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/graph-authority.ts": ["RECOVERY_REPLAY"],
  "src/pair/adapter.ts": ["REMOTE_EXECUTION"],
  "src/pair/codex-adapter.ts": ["REMOTE_EXECUTION"],
  "src/pair/codex-cli-transport.ts": ["REMOTE_EXECUTION", "PLANNER"],
  "src/pair/devin-executor.ts": ["REMOTE_EXECUTION"],
  "src/pair/dsh-adapter.ts": ["REMOTE_EXECUTION"],
  "src/pair/dsh-model-router.ts": ["REMOTE_EXECUTION"],
  "src/pair/multi-executor.ts": ["REMOTE_EXECUTION"],
  "src/pair/acp-executor.ts": ["REMOTE_EXECUTION"],
  "src/pair/acp-permissions.ts": ["REMOTE_EXECUTION"],
  "src/pair/acp-transport.ts": ["REMOTE_EXECUTION"],
  "src/pair/cost.ts": ["MISSION_CONTROL"],
  "src/pair/service.ts": ["MISSION_CONTROL"],
  "src/pair/approval-queue.ts": ["GATE_ROUTER"],
  "src/pair/canonical.ts": ["RECOVERY_REPLAY"],
  "src/pair/errors.ts": ["DEV_INFRA"],
  "src/pair/index.ts": ["DEV_INFRA"],
  "src/pair/env-config.ts": ["MISSION_CONTROL"],
  "src/pair/model-catalog.ts": ["GATE_ROUTER"],
  "src/pair/model-discovery.ts": ["GATE_ROUTER"],
  "src/pair/model-probing.ts": ["GATE_ROUTER"],
  "src/pair/model-role.ts": ["GATE_ROUTER"],
  "src/pair/provider-catalog.ts": ["GATE_ROUTER"],
  "src/pair/provider-discovery.ts": ["GATE_ROUTER"],
  "src/pair/provider-validation.ts": ["GATE_ROUTER"],
  "src/pair/credential-broker.ts": ["GATE_ROUTER"],
  "src/pair/broker-capability.ts": ["GATE_ROUTER"],
  "src/pair/secret-policy.ts": ["MISSION_CONTROL"],
  "src/pair/network-requirement.ts": ["PLANNER", "GATE_ROUTER"],
  "src/pair/spec-harness.ts": ["ARTIFACT"],
  "scripts/serve-mission-control.mjs":
    ["MISSION_CONTROL", "MISSION_DRAFT", "CONVERSATION", "TELEGRAM_INGRESS"],
  "scripts/start-pair-live.sh": ["MISSION_CONTROL"],
  "scripts/pair-bootstrap.sh": ["DEV_INFRA"],
  "scripts/telegram-bridge.mjs": ["TELEGRAM_INGRESS"],
  "scripts/automaton.sh": ["DEV_INFRA"],
};

/** Prefix rules — only consulted when no exact file match exists. */
const SURFACE_PREFIXES = [
  ["src/pair/artifact-", ["ARTIFACT"]],
  ["src/pair/conversation-", ["CONVERSATION"]],
  ["src/pair/objective-", ["BUSINESS_OBJECTIVE"]],
  ["src/pair/ceo-", ["BUSINESS_OBJECTIVE"]],
  ["src/pair/workforce-", ["BUSINESS_OBJECTIVE"]],
  ["src/pair/recovery-", ["RECOVERY_REPLAY"]],
  ["src/pair/telegram-", ["TELEGRAM_INGRESS"]],
  ["src/pair/route-", ["GATE_ROUTER"]],
  ["src/pair/routing-", ["GATE_ROUTER"]],
  ["src/pair/model-", ["GATE_ROUTER"]],
  ["src/pair/provider-", ["GATE_ROUTER"]],
  ["src/pair/experience-", ["BUSINESS_OBJECTIVE"]],
  ["apps/mission-control-ui/", ["UI"]],
  ["scripts/dev-verification/", ["DEV_INFRA"]],
  [".pair-verification/", ["DEV_INFRA"]],
  ["src/__tests__/", ["DEV_INFRA"]],
  ["e2e/", ["UI"]],
  ["docs/", ["DEV_INFRA"]],
];

/** Authority-sensitive paths — any hit makes the change HIGH risk. */
const HIGH_RISK_FILES = new Set([
  "src/pair/serve-planner.ts",
  "src/pair/plan-dataflow.ts",
  "src/pair/plan-preview.ts",
  "src/pair/mission-draft.ts",
  "src/pair/gate.ts",
  "src/pair/mission-router.ts",
  "src/pair/capability-router.ts",
  "src/pair/route-ledger.ts",
  "src/pair/route-registry.ts",
  "src/pair/route-selector.ts",
  "src/pair/routing-projection.ts",
  "src/pair/executor-registry.ts",
  "src/pair/model-routable.ts",
  "src/pair/conversation-session.ts",
  "src/pair/proposal.ts",
  "src/pair/telegram-delivery.ts",
  "src/pair/telegram-transport.ts",
  "src/pair/output-language.ts",
  "src/pair/artifact-authority.ts",
  "src/pair/artifact-capability.ts",
  "src/pair/artifact-consume-capability.ts",
  "src/pair/artifact-handoff.ts",
  "src/pair/artifact-validation.ts",
  "src/pair/credential-broker.ts",
  "src/pair/broker-capability.ts",
  "src/pair/secret-policy.ts",
  "src/pair/env-config.ts",
  "src/pair/mc-token.ts",
  "src/pair/recovery-controller.ts",
  "src/pair/reconciliation.ts",
  "src/pair/persistence.ts",
  "src/pair/store.ts",
  "src/pair/mission-runtime.ts",
  "src/pair/mission-supervisor.ts",
  "src/pair/work-completion.ts",
  "src/pair/approval-queue.ts",
  "src/pair/agent-contract.ts",
  "src/pair/goal-contract.ts",
  "src/pair/network-requirement.ts",
  "src/pair/spec-harness.ts",
  // mission control plane — endpoints mint/confirm/bind missions
  "src/pair/mission-control.ts",
  "src/pair/mission-control-server.ts",
  "src/pair/service.ts",
  "src/pair/promotion-service.ts",
  // runtime boundary scripts compose the live authority seams
  "scripts/serve-mission-control.mjs",
  "scripts/telegram-bridge.mjs",
  "scripts/start-pair-live.sh",
]);
const HIGH_RISK_PREFIXES = [
  "src/pair/artifact-", "src/pair/recovery-", "src/pair/conversation-",
  "src/pair/telegram-", "src/pair/plan-",
];
const LOW_RISK_PREFIXES = [
  "apps/mission-control-ui/", "docs/", "src/__tests__/",
  "scripts/dev-verification/", ".pair-verification/", "e2e/",
];
const LOW_RISK_FILES = new Set([
  "README.md", "CHANGELOG.md", "LICENSE",
]);

const isTestOrDocOnly = (f) =>
  LOW_RISK_PREFIXES.some((p) => f.startsWith(p)) || LOW_RISK_FILES.has(f) ||
  f.endsWith(".md") || f.endsWith(".txt");

export function classifyFiles(changedFiles) {
  const surfaces = new Set();
  const unknownProduction = [];
  for (const f of changedFiles) {
    const exact = SURFACE_FILES[f];
    const pref = SURFACE_PREFIXES.find(([p]) => f.startsWith(p));
    const hit = exact ?? pref?.[1];
    if (hit) {
      hit.forEach((s) => surfaces.add(s));
      continue;
    }
    if (isTestOrDocOnly(f)) {
      surfaces.add(f.startsWith("apps/") ? "UI" : "DEV_INFRA");
      continue;
    }
    // Unknown scripts are NOT assumed dev-only: scripts/ also hosts real
    // runtime seams (serve-mission-control, telegram-bridge, bootstrap).
    // Unmapped script files get the same conservative treatment as
    // unmapped production — broad pack + HIGH risk, never silent LOW.
    if (f.startsWith("scripts/") || f.startsWith("bin/")) {
      unknownProduction.push(f);
      surfaces.add("DEV_INFRA");
      continue;
    }
    if (f.startsWith("src/") || f.startsWith("packages/")) {
      unknownProduction.push(f);
      surfaces.add("DEV_INFRA"); // labelled, but risk treats it HIGH
      continue;
    }
    surfaces.add("DEV_INFRA");
  }
  return { surfaces: [...surfaces].sort(), unknownProduction };
}

export function classifyRisk(changedFiles, { unknownProduction = [] } = {}) {
  const reasons = [];
  let risk = "LOW";
  const bump = (r, why) => {
    const order = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    if (order[r] > order[risk]) risk = r;
    reasons.push(why);
  };
  const high = changedFiles.filter(
    (f) => HIGH_RISK_FILES.has(f) ||
      HIGH_RISK_PREFIXES.some((p) => f.startsWith(p)),
  );
  if (high.length) {
    bump("HIGH",
      `authority-sensitive files: ${high.slice(0, 5).join(", ")}${high.length > 5 ? ` (+${high.length - 5} more)` : ""}`);
  }
  if (unknownProduction.length) {
    bump("HIGH",
      `unmapped production files get conservative broad verification: ${unknownProduction.slice(0, 3).join(", ")}`);
  }
  const medium = changedFiles.filter(
    (f) => !isTestOrDocOnly(f) && !high.includes(f) &&
      !unknownProduction.includes(f),
  );
  if (medium.length) {
    bump("MEDIUM",
      `production/config files without authority-boundary impact: ${medium.slice(0, 5).join(", ")}`);
  }
  if (!reasons.length) reasons.push("docs/tests/dev-infra only");
  return { risk, reason: reasons.join("; ") };
}

/* ---------------- invariants + module packs ---------------- */

const T = "src/__tests__/";
const HF1 = `${T}pair-p15-8-hotfix1-delivery-injection.test.ts`;

export const INVARIANTS = [
  { id: "INV_CONV_001", surfaces: ["CONVERSATION"],
    desc: "Ordinary conversation text alone cannot grant execution authority.",
    tests: [{ file: `${T}pair-p15-8b-conversation-reasoning.test.ts` }] },
  { id: "INV_PLAN_001", surfaces: ["PLANNER"],
    desc: "Planner/model output cannot grant authority merely by emitting metadata/capabilities.",
    tests: [{ file: `${T}pair-prv2a-planner-modernization.test.ts`, pattern: "RESERVED_CAPABILITY|misuse" }] },
  { id: "INV_DELIVERY_001", surfaces: ["DELIVERY"],
    desc: "Telegram delivery authority requires explicit operator delivery intent.",
    tests: [{ file: HF1, pattern: "INTENT" }] },
  { id: "INV_DELIVERY_002", surfaces: ["DELIVERY"],
    desc: "PAIR delivery-task injection is allowed only for proven TRUE planner omission.",
    tests: [{ file: HF1, pattern: "omission|inject" }] },
  { id: "INV_DELIVERY_RAW_001", surfaces: ["DELIVERY", "PLANNER"],
    desc: "A TELEGRAM_DELIVERY emission lost during first sanitize/canonical preparation must never be reclassified as true omission.",
    tests: [{ file: HF1, pattern: "INVALIDATED|AMBIGUOUS" }] },
  { id: "INV_REPLAY_001", surfaces: ["RECOVERY_REPLAY", "DELIVERY"],
    desc: "Persisted canonical authority cannot silently mutate on replay.",
    tests: [{ file: HF1, pattern: "persisted|replay" }] },
  { id: "INV_EXEC_001", surfaces: ["GATE_ROUTER", "REMOTE_EXECUTION"],
    desc: "An executor cannot widen its governed required capabilities.",
    tests: [{ file: `${T}pair-route-capability-authority.test.ts` }] },
  { id: "INV_ARTIFACT_001", surfaces: ["ARTIFACT"],
    desc: "Remote-produced artifacts are not trusted until canonical artifact acceptance.",
    tests: [{ file: `${T}pair-f1-artifact-authority.test.ts` }] },
  { id: "INV_ARTIFACT_002", surfaces: ["ARTIFACT"],
    desc: "Artifact consume/producer binding remains fail-closed on ambiguity/unbound producer.",
    tests: [{ file: `${T}pair-f2-artifact-handoff.test.ts` }] },
  { id: "INV_MISSION_001", surfaces: ["MISSION_DRAFT", "MISSION_CONTROL"],
    desc: "Mission execution authority must derive from canonical confirmed/authorized mission state, not model prose.",
    tests: [{ file: `${T}pair-p15-8c-mission-confirmation.test.ts` }] },
  { id: "INV_SECRETS_001", surfaces: ["MISSION_CONTROL", "REMOTE_EXECUTION"],
    desc: "Credentials and secret-bearing config never reach surfaces, logs, or untrusted contexts.",
    tests: [{ file: `${T}tools-security.test.ts` }] },
];

export const PACKS = {
  PLANNER: [
    "pair-llm-planner.test.ts", "pair-cpl1-codex-planner.test.ts",
    "pair-prv2a-planner-modernization.test.ts",
    "pair-planner-dataflow-incident.test.ts",
    "pair-planner-prompt-contract.test.ts",
    "pair-planner-contract-simplify.test.ts",
    "pair-goal-contract-produce-binding.test.ts",
    "pair-network-requirement.test.ts",
    "pair-f3-plan-feasibility.test.ts",
    "pair-p15-8-hotfix1-delivery-injection.test.ts",
  ],
  DELIVERY: [
    "pair-p15-8-hotfix1-delivery-injection.test.ts",
    "pair-ops-telegram-delivery.test.ts",
    "pair-output-delivery-contract.test.ts",
    "pair-f4-delivery-provenance.test.ts",
  ],
  CONVERSATION: [
    "pair-p15-8a-conversation-authority.test.ts",
    "pair-p15-8b-conversation-reasoning.test.ts",
    "pair-p15-8d-web-chat.test.ts",
    "pair-p15-8f-proposal.test.ts",
  ],
  MISSION_DRAFT: [
    "pair-p15-8c-mission-confirmation.test.ts",
    "pair-p15-8f-proposal.test.ts",
  ],
  MISSION_CONTROL: [
    "pair-p15-7-operator-trigger.test.ts",
    "pair-p15-8d-web-chat.test.ts",
  ],
  GATE_ROUTER: [
    "pair-route-capability-authority.test.ts",
    "pair-acr1-capability-reject-evidence.test.ts",
  ],
  ARTIFACT: [
    "pair-f1-artifact-authority.test.ts",
    "pair-f1-r1-remediation.test.ts",
    "pair-f1-r2-remediation.test.ts",
    "pair-f2-artifact-handoff.test.ts",
    "pair-f2-r2-remediation.test.ts",
    "pair-f2-r3-remediation.test.ts",
    "pair-f2-r4-remediation.test.ts",
    "pair-host-artifact-negative-space.test.ts",
    "pair-f4-delivery-provenance.test.ts",
  ],
  REMOTE_EXECUTION: [
    "pair-p6.test.ts", "pair-p7.test.ts",
    "pair-cpl1-codex-planner.test.ts",
  ],
  RECOVERY_REPLAY: [
    "pair-f3-replan-closure.test.ts",
    "pair-live-ops-recovery-closure.test.ts",
    "pair-planning-stall-r1.test.ts",
    "pair-runtime-hardening.test.ts",
    "pair-p15-8e-bridge-e2e.test.ts",
  ],
  BUSINESS_OBJECTIVE: [
    "pair-p15-1-objective-authority.test.ts",
    "pair-p15-2-objective-workstream.test.ts",
    "pair-p15-3-ceo-planning-cycle.test.ts",
    "pair-p15-3w-ceo-runtime-wiring.test.ts",
    "pair-p15-4-workforce-allocation.test.ts",
    "pair-p15-5-kpi-review.test.ts",
    "pair-p15-6-objective-operating-loop.test.ts",
    "pair-p14-foundation.test.ts",
  ],
  TELEGRAM_INGRESS: [
    "pair-p15-8e-telegram.test.ts",
    "pair-p15-8e-bridge-e2e.test.ts",
  ],
  UI: [], // covered by tsc + build; no focused vitest pack in V1
  DEV_INFRA: ["dev-verification.test.ts", "dev-workflow-policy.test.ts"],
  // Conservative fallback for unmapped production files.
  UNKNOWN_BROAD: [
    "pair-planner-dataflow-incident.test.ts",
    "pair-p15-8-hotfix1-delivery-injection.test.ts",
    "pair-output-delivery-contract.test.ts",
    "pair-p15-8a-conversation-authority.test.ts",
    "pair-p15-8c-mission-confirmation.test.ts",
    "pair-route-capability-authority.test.ts",
    "pair-f1-artifact-authority.test.ts",
    "pair-f2-artifact-handoff.test.ts",
  ],
};

/** Documented environment-dependent failures tolerated inside packs:
 *  reported as KNOWN_BASELINE, never counted as FAIL. */
export const TOLERATED_FAILURES = [
  { file: `${T}pair-f4-delivery-provenance.test.ts`,
    pattern: /R5\.1-crash/, max: 1,
    note: "documented flake — fault-injection timing on this sandbox" },
  { file: `${T}pair-p5.test.ts`,
    pattern: /DSH registration/, max: 1,
    note: "probe expects executables absent; sandbox has them installed" },
  { file: `${T}pair-p5.test.ts`,
    pattern: /CODEX registration/, max: 1,
    note: "probe expects executables absent; sandbox has them installed" },
];

/* ---------------- patch claim schema ---------------- */

export class HarnessError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `:${detail}` : ""}`);
    this.code = code;
  }
}

const CLAIM_FIELDS = [
  "claim_id", "title", "affected_surfaces", "required_tests",
  "invariants", "description", "risk_override",
];

export function validateClaim(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HarnessError("VERIFY_CLAIM_SCHEMA", "claim must be an object");
  }
  const c = raw;
  for (const k of Object.keys(c)) {
    if (!CLAIM_FIELDS.includes(k)) {
      throw new HarnessError("VERIFY_CLAIM_SCHEMA", `unknown field ${k}`);
    }
  }
  if (typeof c.claim_id !== "string" || !/^[A-Za-z0-9_.-]{3,80}$/.test(c.claim_id)) {
    throw new HarnessError("VERIFY_CLAIM_SCHEMA", "claim_id must be 3-80 [A-Za-z0-9_.-]");
  }
  if (typeof c.title !== "string" || !c.title.trim() || c.title.length > 300) {
    throw new HarnessError("VERIFY_CLAIM_SCHEMA", "title must be non-empty <=300");
  }
  if (c.description !== undefined &&
      (typeof c.description !== "string" || c.description.length > 2000)) {
    throw new HarnessError("VERIFY_CLAIM_SCHEMA", "description must be string <=2000");
  }
  const arr = (v, name, re) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      throw new HarnessError("VERIFY_CLAIM_SCHEMA", `${name} must be an array`);
    }
    if (v.length > 100) {
      throw new HarnessError("VERIFY_CLAIM_SCHEMA", `${name} >100 entries`);
    }
    for (const x of v) {
      if (typeof x !== "string" || (re && !re.test(x))) {
        throw new HarnessError("VERIFY_CLAIM_SCHEMA", `${name} bad entry ${x}`);
      }
    }
    return v;
  };
  const surfaces = arr(c.affected_surfaces, "affected_surfaces");
  for (const s of surfaces) {
    if (!SURFACES.includes(s)) {
      throw new HarnessError("VERIFY_CLAIM_SCHEMA", `unknown surface ${s}`);
    }
  }
  const requiredTests = arr(c.required_tests, "required_tests");
  // A patch claim without executable proof is vacuous: required_tests
  // must name at least one selector the harness can actually run.
  if (requiredTests.length === 0) {
    throw new HarnessError("VERIFY_CLAIM_SCHEMA",
      "required_tests must declare at least one executable selector");
  }
  const invariants = arr(c.invariants, "invariants");
  const invIds = new Set(INVARIANTS.map((i) => i.id));
  for (const i of invariants) {
    if (!invIds.has(i)) {
      throw new HarnessError("VERIFY_CLAIM_SCHEMA", `unknown invariant ${i}`);
    }
  }
  // risk_override may only RAISE — never downgrade below the classifier.
  if (c.risk_override !== undefined) {
    if (!["MEDIUM", "HIGH"].includes(c.risk_override)) {
      throw new HarnessError("VERIFY_CLAIM_SCHEMA",
        "risk_override may only be MEDIUM or HIGH (never a downgrade)");
    }
  }
  return {
    claim_id: c.claim_id,
    title: c.title,
    affected_surfaces: surfaces,
    required_tests: requiredTests,
    invariants,
    description: c.description ?? "",
    risk_override: c.risk_override ?? null,
  };
}

/* ---------------- self-audit evidence schema ---------------- */

/** The self-audit categories an agent must account for — each is either
 *  reviewed or explicitly skipped with a reason (never silently absent). */
export const AUDIT_CATEGORIES = [
  "LOGIC_INVARIANTS", "AUTH_SECURITY", "STATE_LIFECYCLE",
  "IDEMPOTENCY_REPLAY", "CONCURRENCY_CAS", "EDGE_COMPAT", "UI_API",
];
/** Max auto-repair rounds per handoff — a 4th round means stop+report. */
export const MAX_REPAIR_ROUNDS = 3;

const AUDIT_FIELDS = [
  "audit_id", "categories_reviewed", "categories_skipped", "findings",
  "fixes", "remaining_risks", "repair_rounds", "verdict",
];
const FINDING_FIELDS = [
  "id", "severity", "area", "description", "repro", "found_by", "status",
];
const FIX_FIELDS = ["finding_id", "regression_tests", "note"];
const SKIP_FIELDS = ["category", "reason"];
const AUDIT_SEVS = ["P0", "P1", "P2", "P3"];
const AUDIT_STATUS = ["OPEN", "FIXED", "ACCEPTED_RISK"];
const AUDIT_FOUND_BY = ["SELF", "EXTERNAL"];
const AUDIT_VERDICTS = ["PASS", "BLOCKED"];

export function validateAuditEvidence(raw) {
  const bad = (d) => {
    throw new HarnessError("VERIFY_AUDIT_SCHEMA", d);
  };
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    bad("evidence must be an object");
  }
  const e = raw;
  for (const k of Object.keys(e)) {
    if (!AUDIT_FIELDS.includes(k)) bad(`unknown field ${k}`);
  }
  if (typeof e.audit_id !== "string" ||
      !/^[A-Za-z0-9_.-]{3,80}$/.test(e.audit_id)) {
    bad("audit_id must be 3-80 [A-Za-z0-9_.-]");
  }
  const strArr = (v, name, max, len) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) bad(`${name} must be an array`);
    if (v.length > max) bad(`${name} >${max} entries`);
    for (const x of v) {
      if (typeof x !== "string" || x.length > len) bad(`${name} bad entry`);
    }
    return v;
  };
  // Category coverage: every audit category is either reviewed or skipped
  // with a reason — an unmentioned category means the audit forgot it.
  if (!Array.isArray(e.categories_reviewed)) {
    bad("categories_reviewed must be an array");
  }
  const reviewed = [...e.categories_reviewed];
  for (const c of reviewed) {
    if (!AUDIT_CATEGORIES.includes(c)) bad(`unknown category ${c}`);
  }
  if (new Set(reviewed).size !== reviewed.length) {
    bad("categories_reviewed has duplicates");
  }
  const skippedArr = e.categories_skipped ?? [];
  if (!Array.isArray(skippedArr) || skippedArr.length > 20) {
    bad("categories_skipped must be an array <=20");
  }
  const skipped = [];
  for (const s of skippedArr) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      bad("categories_skipped entries must be objects");
    }
    for (const k of Object.keys(s)) {
      if (!SKIP_FIELDS.includes(k)) bad(`categories_skipped field ${k}`);
    }
    if (!AUDIT_CATEGORIES.includes(s.category)) {
      bad(`unknown skipped category ${s.category}`);
    }
    if (typeof s.reason !== "string" || !s.reason.trim() ||
        s.reason.length > 300) {
      bad(`skipped category ${s.category} needs a non-empty reason`);
    }
    skipped.push(s.category);
  }
  if (new Set(skipped).size !== skipped.length) {
    bad("categories_skipped has duplicates");
  }
  const overlap = reviewed.filter((c) => skipped.includes(c));
  if (overlap.length) {
    bad(`categories both reviewed and skipped: ${overlap.join(", ")}`);
  }
  const covered = new Set([...reviewed, ...skipped]);
  const missing = AUDIT_CATEGORIES.filter((c) => !covered.has(c));
  if (missing.length) {
    bad(`audit must account for every category — unaccounted: ` +
      missing.join(", "));
  }
  // Findings: every defect records severity, reproduction and provenance
  // (self-found vs externally reported).
  const findings = e.findings ?? [];
  if (!Array.isArray(findings) || findings.length > 50) {
    bad("findings must be an array <=50");
  }
  const ids = new Set();
  const normFindings = findings.map((f, i) => {
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      bad(`findings[${i}] must be an object`);
    }
    for (const k of Object.keys(f)) {
      if (!FINDING_FIELDS.includes(k)) bad(`findings[${i}] field ${k}`);
    }
    if (typeof f.id !== "string" || !f.id.trim() || f.id.length > 40) {
      bad(`findings[${i}].id must be non-empty <=40`);
    }
    if (ids.has(f.id)) bad(`duplicate finding id ${f.id}`);
    ids.add(f.id);
    if (!AUDIT_SEVS.includes(f.severity)) {
      bad(`findings[${i}].severity must be ${AUDIT_SEVS.join("/")}`);
    }
    if (f.area !== undefined &&
        (typeof f.area !== "string" || f.area.length > 160)) {
      bad(`findings[${i}].area must be string <=160`);
    }
    if (typeof f.description !== "string" || !f.description.trim() ||
        f.description.length > 800) {
      bad(`findings[${i}].description must be non-empty <=800`);
    }
    if (typeof f.repro !== "string" || !f.repro.trim() ||
        f.repro.length > 800) {
      bad(`findings[${i}].repro must record how to reproduce <=800`);
    }
    if (!AUDIT_FOUND_BY.includes(f.found_by)) {
      bad(`findings[${i}].found_by must be ${AUDIT_FOUND_BY.join("/")}`);
    }
    if (!AUDIT_STATUS.includes(f.status)) {
      bad(`findings[${i}].status must be ${AUDIT_STATUS.join("/")}`);
    }
    return f;
  });
  // Fixes bind to real finding ids and name executable regression proof.
  const fixes = e.fixes ?? [];
  if (!Array.isArray(fixes) || fixes.length > 50) {
    bad("fixes must be an array <=50");
  }
  const normFixes = fixes.map((f, i) => {
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      bad(`fixes[${i}] must be an object`);
    }
    for (const k of Object.keys(f)) {
      if (!FIX_FIELDS.includes(k)) bad(`fixes[${i}] field ${k}`);
    }
    if (typeof f.finding_id !== "string" || !ids.has(f.finding_id)) {
      bad(`fixes[${i}].finding_id must reference a finding id`);
    }
    if (!Array.isArray(f.regression_tests) ||
        f.regression_tests.length === 0 || f.regression_tests.length > 10) {
      bad(`fixes[${i}].regression_tests must be 1-10 paths`);
    }
    for (const t of f.regression_tests) {
      if (typeof t !== "string" || !t.trim() || t.length > 300) {
        bad(`fixes[${i}].regression_tests bad path`);
      }
    }
    if (f.note !== undefined &&
        (typeof f.note !== "string" || f.note.length > 400)) {
      bad(`fixes[${i}].note must be string <=400`);
    }
    return f;
  });
  const remainingRisks = strArr(e.remaining_risks, "remaining_risks",
    20, 400);
  if (e.repair_rounds !== undefined &&
      (!Number.isInteger(e.repair_rounds) || e.repair_rounds < 0)) {
    bad("repair_rounds must be a non-negative integer");
  }
  if ((e.repair_rounds ?? 0) > MAX_REPAIR_ROUNDS) {
    bad(`repair_rounds exceeds max ${MAX_REPAIR_ROUNDS} — stop and ` +
      "report BLOCKED instead");
  }
  if (!AUDIT_VERDICTS.includes(e.verdict)) {
    bad(`verdict must be ${AUDIT_VERDICTS.join("/")}`);
  }
  return {
    audit_id: e.audit_id,
    categories_reviewed: reviewed,
    categories_skipped: skippedArr,
    findings: normFindings,
    fixes: normFixes,
    remaining_risks: remainingRisks,
    repair_rounds: e.repair_rounds ?? 0,
    verdict: e.verdict,
  };
}

/**
 * Consistency gate over validated evidence — pure. The harness supplies
 * `missingRegressionFiles` (paths named in fixes that do not exist).
 * The agent may NOT mark PASS while critical findings stay unresolved.
 */
export function auditConsistency(evidence, missingRegressionFiles = []) {
  const failures = [];
  const openCrit = evidence.findings.filter(
    (f) => (f.severity === "P0" || f.severity === "P1") &&
      f.status !== "FIXED");
  if (openCrit.length) {
    failures.push(`unresolved P0/P1 findings: ` +
      openCrit.map((f) => `${f.id}(${f.severity},${f.status})`).join(", "));
  }
  if (evidence.verdict === "BLOCKED") {
    failures.push("audit verdict BLOCKED — agent reports a critical " +
      "issue it could not repair");
  }
  const fixedNoProof = evidence.findings.filter((f) =>
    f.status === "FIXED" &&
    !evidence.fixes.some((x) => x.finding_id === f.id));
  if (fixedNoProof.length) {
    failures.push("FIXED findings without a fix/regression-test entry: " +
      fixedNoProof.map((f) => f.id).join(", "));
  }
  for (const m of missingRegressionFiles) {
    failures.push(`regression test file does not exist: ${m}`);
  }
  return { ok: failures.length === 0, failures };
}

/** Selector: "path" or "path#pattern" (pattern → vitest -t). */
export function parseSelector(sel) {
  const i = sel.indexOf("#");
  if (i < 0) return { file: sel, pattern: null };
  return { file: sel.slice(0, i), pattern: sel.slice(i + 1) || null };
}

/* ---------------- plan selection ---------------- */

export function planVerification({ changedFiles, claim, full }) {
  const { surfaces, unknownProduction } = classifyFiles(changedFiles);
  if (claim) {
    for (const s of claim.affected_surfaces) {
      if (!surfaces.includes(s)) surfaces.push(s);
    }
    surfaces.sort();
  }
  let { risk, reason } = classifyRisk(changedFiles, { unknownProduction });
  if (claim?.risk_override &&
      { MEDIUM: 1, HIGH: 2 }[claim.risk_override] > { LOW: 0, MEDIUM: 1, HIGH: 2 }[risk]) {
    risk = claim.risk_override;
    reason += `; claim risk_override → ${risk}`;
  }
  const surfaceSet = new Set(surfaces);
  const invSelected = INVARIANTS.filter(
    (inv) => inv.surfaces.some((s) => surfaceSet.has(s)) ||
      (claim?.invariants ?? []).includes(inv.id),
  );
  const claimTests = (claim?.required_tests ?? []).map(parseSelector);
  const invariantTests = invSelected.flatMap((inv) =>
    inv.tests.map((t) => ({ ...t, invariant: inv.id })),
  );
  const packFiles = new Set();
  for (const s of surfaces) for (const f of PACKS[s] ?? []) packFiles.add(f);
  if (unknownProduction.length) {
    for (const f of PACKS.UNKNOWN_BROAD) packFiles.add(f);
  }
  const moduleTests = [...packFiles].sort().map((f) => ({
    file: `${T}${f}`, pattern: null,
  }));
  return {
    surfaces,
    unknownProduction,
    risk,
    reason,
    claim,
    claimTests,
    invariants: invSelected.map((i) => ({ id: i.id, desc: i.desc })),
    invariantTests,
    moduleTests,
    fullSuite: full === true || risk === "HIGH" ? "RUN" : "NOT_RUN",
  };
}
