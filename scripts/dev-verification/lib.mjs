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
  "src/pair/replan-generation.ts": ["PLANNER", "RECOVERY_REPLAY"],
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
  "src/pair/operational-query.ts": ["MISSION_CONTROL", "CONVERSATION"],
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
  "src/pair/objective-auto-policy.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-auto-driver.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-capability-gap.ts": ["BUSINESS_OBJECTIVE"],
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
  "src/pair/brain-context.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/reasoning-brief.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/scoped-memory.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-relation.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-portfolio.ts": ["BUSINESS_OBJECTIVE"],
  "src/pair/objective-cockpit.ts": ["BUSINESS_OBJECTIVE"],
  "src/memory/semantic.ts": ["BUSINESS_OBJECTIVE"],
  "src/memory/procedural.ts": ["BUSINESS_OBJECTIVE"],
  "src/state/schema.ts": ["BUSINESS_OBJECTIVE"],
  "src/state/database.ts": ["BUSINESS_OBJECTIVE"],
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
  "src/pair/replan-generation.ts",
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
    "pair-p15-9a-company-cockpit.test.ts",
    "pair-p15-9-step0-owner-actions.test.ts",
    "pair-p15-6-objective-operating-loop.test.ts",
    "pair-p14-foundation.test.ts",
    "pair-p16-a-brain-context.test.ts",
    "pair-p16-b-reasoning-brief.test.ts",
    "pair-p17-scope-tenancy.test.ts",
    "pair-p18-a-objective-relation.test.ts",
    "pair-p18-b-portfolio.test.ts",
    "pair-p18-c-parallel-gating.test.ts",
    "pair-p18-d-cross-objective-handoff.test.ts",
  ],
  TELEGRAM_INGRESS: [
    "pair-p15-8e-telegram.test.ts",
    "pair-p15-8e-bridge-e2e.test.ts",
  ],
  UI: [], // covered by tsc + build; no focused vitest pack in V1
  DEV_INFRA: ["dev-verification.test.ts"],
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
  /* ---- win32 platform baselines (Phase C measured BASE==HEAD, zero
   *  regressions) ----------------------------------------------------------
   * The dev host is Windows + Node 24: artifact materialization requires
   * /proc/self/fd (secureReadContained) and directory fsync — both absent
   * on win32 — so artifact-adjacent tests fail closed upstream of their
   * assertions; spawn/path/shell tests assume unix semantics. Every entry
   * below was verified failure-identical between BASE 9c09d91 and the
   * Phase C HEAD (full-suite comparison, per-file per-test). `max` is the
   * exact baseline count — any additional failure in that file is FAIL.
   *
   * AUDIT R1 F1 — every win32 entry carries `platform: "win32"`: on any
   * other platform these baselines are INERT (the budget filter drops
   * them) so a Linux failure can never hide behind a Windows exception. */
  { file: `${T}command-injection.test.ts`,
    pattern: /.+/, max: 5,
    platform: "win32",
    note: "win32 shell/path baseline (unix-only path construction/spawn semantics) — identical on BASE" },
  { file: `${T}dev-verification.test.ts`,
    pattern: /.+/, max: 20,
    platform: "win32",
    note: "win32 shell/path baseline (unix-only path construction/spawn semantics) — identical on BASE" },
  { file: `${T}orchestration/local-worker-harness.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-acr1-capability-reject-evidence.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-bootstrap.test.ts`,
    pattern: /.+/, max: 15,
    platform: "win32",
    note: "win32 shell/path baseline (unix-only path construction/spawn semantics) — identical on BASE" },
  { file: `${T}pair-covmap-coverage-map.test.ts`,
    pattern: /.+/, max: 2,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-cpl1-codex-planner.test.ts`,
    pattern: /.+/, max: 22,
    platform: "win32",
    note: "win32 shell/path baseline (unix-only path construction/spawn semantics) — identical on BASE" },
  { file: `${T}pair-dsn1-consume-name-normalization.test.ts`,
    pattern: /.+/, max: 10,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f1-artifact-authority.test.ts`,
    pattern: /.+/, max: 12,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f1-r1-remediation.test.ts`,
    pattern: /.+/, max: 19,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f1-r2-remediation.test.ts`,
    pattern: /.+/, max: 58,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f2-artifact-handoff.test.ts`,
    pattern: /.+/, max: 33,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f2-r1-remediation.test.ts`,
    pattern: /.+/, max: 40,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f2-r2-remediation.test.ts`,
    pattern: /.+/, max: 16,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f2-r3-remediation.test.ts`,
    pattern: /.+/, max: 13,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f2-r4-remediation.test.ts`,
    pattern: /^(?:A[1-7]|B1)\./, max: 8,
    platform: "win32",
    note: "win32 shell baseline — all 8 tests spawn unix-only dependency-fetch " +
      "recipes (measured: every failure is exit 127, BASE==HEAD on 02c5944). " +
      "Selector is title-scoped (A1-A7, B1): any NEW test failing in this file " +
      "is FAIL. Limitation: the matcher sees test titles only — the exit-127 " +
      "cause was verified manually from run output, not by the matcher." },
  { file: `${T}pair-f3-r1-remediation.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f4-delivery-provenance.test.ts`,
    pattern: /.+/, max: 30,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-f5-remote-producer-closure.test.ts`,
    pattern: /.+/, max: 48,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-hotfix-a-cross-mission-input.test.ts`,
    pattern: /.+/, max: 32,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-hotfix-b-redispatch-after-unblock.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-hotfix-d-delegated-delivery.test.ts`,
    pattern: /.+/, max: 3,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-network-binding-repair.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-network-requirement-r3.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-output-delivery-contract.test.ts`,
    pattern: /.+/, max: 10,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p0-win32-codex.test.ts`,
    pattern: /^C2 real ingest: the workspace artifact ACCEPTED via canonical authority$/,
    max: 1,
    platform: "win32",
    note: "win32 ingest baseline — ONLY C2 (secureReadContained ingest seam unproven on this host); identical on BASE a8a3ca6" },
  { file: `${T}pair-p0-win32-runtime.test.ts`,
    // Exactly the 28 observed failures — A8/A9/A15/B4 PASS on this host
    // (paths that never touch the opened-object ingest seam) and stay
    // unmasked: a regression there is a real signal, not a baseline.
    pattern: /^(A[1-7]|A1[0-4]|B[1-3]|B5|C[1-9]|C1[0-2]) /,
    max: 28,
    platform: "win32",
    note: "win32 ingest baseline — secureReadContained/handle-bound materialization unproven on this host; identical on BASE a8a3ca6 (measured: 28)" },
  { file: `${T}pair-p10.test.ts`,
    pattern: /.+/, max: 10,
    platform: "win32",
    note: "win32 shell/path baseline (unix-only path construction/spawn semantics) — identical on BASE" },
  { file: `${T}pair-p11.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p15-10d-met-branch-fold.test.ts`,
    pattern: /.+/, max: 7,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p15-10d-r1.test.ts`,
    pattern: /.+/, max: 7,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p15-10d.test.ts`,
    pattern: /.+/, max: 15,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p15-3-ceo-planning-cycle.test.ts`,
    pattern: /.+/, max: 9,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p15-8-hotfix1-delivery-injection.test.ts`,
    pattern: /.+/, max: 2,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p15-8e-telegram.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p15-9a-company-cockpit.test.ts`,
    pattern: /.+/, max: 12,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p15-a2-review-signoff.test.ts`,
    pattern: /.+/, max: 16,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-phase-b.test.ts`,
    pattern: /I: mission pinned \/approved → authorizedRoots is exactly the snapshot$/,
    max: 1, platform: "win32",
    note: "win32 path baseline — canonicalWorkspacePath('/approved') → 'D:\\approved' (unix-only path semantics); verified identical on BASE" },
  { file: `${T}pair-phase-b.test.ts`,
    pattern: /N: multi-workspace snapshot → canonicalized deduplicated roots$/,
    max: 1, platform: "win32",
    note: "win32 path baseline — '/a','/b','/a/..' canonicalize to drive-prefixed paths; verified identical on BASE" },
  { file: `${T}pair-phase-b.test.ts`,
    pattern: /§16 direct service: explicit ws → roots exactly that list, no hidden project root$/,
    max: 1, platform: "win32",
    note: "win32 path baseline — '/explicit' canonicalizes to 'D:\\explicit'; verified identical on BASE" },
  { file: `${T}pair-p2.test.ts`,
    pattern: /.+/, max: 2,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p3.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p4.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p5.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-p7-live.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-phase-a.test.ts`,
    pattern: /.+/, max: 3,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-phase-b.test.ts`,
    pattern: /.+/, max: 6,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}pair-planner-dataflow-incident.test.ts`,
    pattern: /.+/, max: 35,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}path-protection.test.ts`,
    pattern: /.+/, max: 1,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
  { file: `${T}skills-hardening.test.ts`,
    pattern: /.+/, max: 12,
    platform: "win32",
    note: "win32 shell/path baseline (unix-only path construction/spawn semantics) — identical on BASE" },
  { file: `${T}tools-security.test.ts`,
    pattern: /.+/, max: 3,
    platform: "win32",
    note: "win32 artifact-materialization baseline (secureReadContained needs /proc/self/fd; dir fsync EPERM) — identical on BASE" },
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
