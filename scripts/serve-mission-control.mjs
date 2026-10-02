#!/usr/bin/env node
/**
 * Serve PAIR Mission Control: real governed control plane + HTTP API + UI.
 *
 *   node scripts/serve-mission-control.mjs
 *
 * Env:
 *   PAIR_MC_PORT        port (default 8788)
 *   PAIR_MC_DIR         durable state dir (default ./.pair-mc)
 *   PAIR_MC_UI_DIR      built SPA dir (default apps/mission-control-ui/dist;
 *                       falls back to legacy inline UI when absent)
 *   PAIR_DSH_HOME       dsh settings home (enables DSH executor when set)
 *   CODEX_HOME          codex auth home (enables CODEX executor when set)
 *   PAIR_DEVIN_API_KEY  Devin API key (cog_...); without it DEVIN registers
 *                       UNQUALIFIED (fail-closed, shown in UI with reason)
 *   PAIR_DEVIN_ORG_ID   optional Devin org override
 *   PAIR_DSH_MODEL_ROUTE  optional provider:model override
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../dist/state/database.js";
import {
  llmPlan,
  sanitizePlan,
  ApprovalQueue,
  CodexCliExecutorAdapter,
  DevinExecutorAdapter,
  DshExecutorAdapter,
  createDshModelRouter,
  ExecutorRegistry,
  ExperienceExtractor,
  ExperienceService,
  ExperienceVerifier,
  VerifiedExperienceRoutingAdvisor,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionScheduleService,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
  BusinessLayer,
  WorkforceService,
  CredentialBroker,
  ReconciliationService,
  RecoveryController,
  SelfImprovementController,
  createMissionControlServer,
  registerGovernedExecutors,
  runProviderDiscovery,
  runModelDiscovery,
  ProviderCatalog,
  ModelEvidenceCatalog,
  ensureBinding,
  qualifyBinding,
  ProviderValidator,
  probeModel,
  qualifyModel,
  CODEX_EXECUTOR_ID,
  DEVIN_EXECUTOR_ID,
  DSH_EXECUTOR_ID,
  PAIR_NATIVE_EXECUTOR_ID,
  IntegrityError,
  PolicyError,
  modelProbeTimeoutMs,
  llmPlannerTimeoutMs,
  taskTimeoutSeconds,
  planPreviewTtlSeconds,
  devinBlockedGraceMs,
  resolveMcToken,
  runPlannerFailover,
  dedupePlannerCandidates,
  reconcileModelRoleAssignments,
  resolveConfiguredModelRoleRoute,
  assertCanonicalModelRoleStateDisjoint,
  assertPlannerModelRole,
  assertPlannerCandidateEligible,
  assertDshExecutionModelRole,
  beginPlannerRun,
  persistPlannerAttemptStart,
  settlePlannerAttempt,
  finishPlannerRun,
  validatePlanProposal,
  reconcilePlanDataflow,
  detectTelegramDeliveryIntent,
  CANONICAL_BOOKKEEPING_INSTRUCTION,
  telegramDeliveryMaxAttempts,
  telegramDeliveryStaleAfterMs,
  telegramDeliveryTransportTimeoutMs,
  assertTelegramDeliveryTiming,
  modelRoleOf,
  MODEL_ROLE,
  utcnow,
} from "../dist/pair/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = process.env.PAIR_MC_DIR ?? path.join(root, ".pair-mc");
fs.mkdirSync(dir, { recursive: true });
// Reuse an existing project's workspace on restart — durable state survives
// reboots; only mint a new ws-* dir when no project exists yet.
const persistedProjects = new PairEvidenceStore(path.join(dir, "pair.db")).list("project");
const workspace = persistedProjects[0]?.root_location
  ? String(persistedProjects[0].root_location)
  : fs.mkdtempSync(path.join(dir, "ws-"));
const journalRoot = path.join(dir, "journal");
fs.mkdirSync(journalRoot, { recursive: true });

// Phase A — validated runtime configuration. One canonical parse/validate
// seam (env-config): every value is explicitly parsed, finite, positive, and
// bounded; malformed input FAILS CLOSED here, before any side effects.
const cfgProbeTimeoutMs = modelProbeTimeoutMs();   // PAIR_MODEL_PROBE_TIMEOUT_MS (ms, 500..120000)
const cfgPlannerTimeoutMs = llmPlannerTimeoutMs(); // PAIR_LLM_PLANNER_TIMEOUT_MS (ms, 2000..900000)
const cfgTaskTimeoutS = taskTimeoutSeconds();      // PAIR_TASK_TIMEOUT_S (s, 5..7200)
const cfgPreviewTtlS = planPreviewTtlSeconds();    // PAIR_PLAN_PREVIEW_TTL_S (s, 30..86400)
const cfgDevinBlockedGraceMs = devinBlockedGraceMs(); // PAIR_DEVIN_BLOCKED_GRACE_MS (ms, 5000..1800000) — blocked-clock only, never the task budget
// R6 §3-4 — canonical Telegram delivery timing: SENDING lease > transport
// timeout, enforced fail-closed here at startup.
const cfgTgStaleAfterMs = telegramDeliveryStaleAfterMs();       // PAIR_TG_DELIVERY_STALE_AFTER_MS (ms, 5000..600000)
const cfgTgTransportTimeoutMs = telegramDeliveryTransportTimeoutMs(); // PAIR_TG_DELIVERY_TRANSPORT_TIMEOUT_MS (ms, 1000..300000)
assertTelegramDeliveryTiming({
  staleAfterMs: cfgTgStaleAfterMs,
  transportTimeoutMs: cfgTgTransportTimeoutMs,
});
console.log(`TG_DELIVERY_TIMING: stale_after=${cfgTgStaleAfterMs}ms > transport_timeout=${cfgTgTransportTimeoutMs}ms`);
console.log(`EXEC_TIMEOUT: canonical governed budget PAIR_TASK_TIMEOUT_S=${cfgTaskTimeoutS}s → task.timeout (all executors) | Devin blockedGraceMs=${cfgDevinBlockedGraceMs} (separate blocked clock)`);

// Phase A — MC token: explicit env > persistent file > generated 256-bit
// (chmod 600). No static defaults anywhere; server + bridge share this seam.
const mcToken = resolveMcToken();
console.log(`MC_TOKEN: resolved via ${mcToken.source} (file=${mcToken.path})`);

// Phase A — canonical model-role pools. PAIR_PLANNER_MODEL_ROUTE names the
// planner's model route; PAIR_DSH_* routes name DSH_EXECUTION candidates.
// The two pools must be canonically disjoint — enforced below via
// model_entry_id, never route spelling alone.
// Phase B — the Planner pool is an ORDERED failover chain: primary route
// first, then fallback, then extras, in configured order (deduped on the
// resolved canonical model_entry_id). Planner failover NEVER borrows a
// DSH_EXECUTION model — pools stay disjoint as canonical authority.
const PLANNER_PRIMARY_ROUTE = String(process.env.PAIR_PLANNER_MODEL_ROUTE ?? "gemini:gemini-3.1-flash-lite").trim();
const PLANNER_FALLBACK_ROUTE = String(process.env.PAIR_PLANNER_FALLBACK_ROUTE ?? "").trim();
const PLANNER_ROUTES = [PLANNER_PRIMARY_ROUTE];
if (PLANNER_FALLBACK_ROUTE) PLANNER_ROUTES.push(PLANNER_FALLBACK_ROUTE);
for (const extra of String(process.env.PAIR_PLANNER_EXTRA_ROUTES ?? "").split(",")) {
  const r = extra.trim();
  if (r && !PLANNER_ROUTES.includes(r)) PLANNER_ROUTES.push(r);
}
const DSH_PRIMARY_ROUTE = String(process.env.PAIR_DSH_MODEL_ROUTE ?? "cloudflare:@cf/zai-org/glm-4.7-flash").trim();
const DSH_FALLBACK_ROUTE = String(process.env.PAIR_DSH_FALLBACK_ROUTE ?? "groq:openai/gpt-oss-20b").trim();
const DSH_ROUTES = [DSH_PRIMARY_ROUTE, DSH_FALLBACK_ROUTE];
for (const extra of String(process.env.PAIR_DSH_EXTRA_ROUTES ?? "").split(",")) {
  const r = extra.trim();
  if (r && !DSH_ROUTES.includes(r)) DSH_ROUTES.push(r);
}
// Cheap static pre-check: identical route spelling across pools fails fast;
// the canonical model_entry_id overlap check runs after discovery.
for (const pr of PLANNER_ROUTES) {
  if (pr && DSH_ROUTES.includes(pr)) {
    throw new IntegrityError("FAIL_CLOSED_MODEL_ROLE_OVERLAP", `route ${pr} configured for both PLANNER_COORDINATOR and DSH_EXECUTION`);
  }
}

const automaton = createDatabase(path.join(dir, "state.db"));
const store = new PairEvidenceStore(path.join(dir, "pair.db"));
const service = new PairControlPlane(store);

const noopInf = { chat: async () => { throw new Error("harness must not call inference"); } };
const noopCmp = {
  exec: async () => { throw new Error("no remote compute"); },
  writeFile: async () => { throw new Error("no remote compute"); },
  readFile: async () => { throw new Error("no remote compute"); },
};
const runner = new PairNativeWorkerRunner({
  db: automaton.raw,
  config: { name: "pair-mc", logLevel: "error" },
  identity: { name: "pair-mc" },
  inference: noopInf,
  compute: noopCmp,
  journalRoot,
  allowedEditRoot: dir,
});
const native = new PairNativeExecutorAdapter(runner);

const adapters = new Map([[PAIR_NATIVE_EXECUTOR_ID, native]]);
const governed = new Map();
let dshAdapter = null;
if (process.env.PAIR_DSH_HOME) {
  dshAdapter = new DshExecutorAdapter({
    journalRoot,
    // Runtime model pin follows the resolved DSH primary route (role pool),
    // never an unexamined env position. Legacy fallback only — when the
    // Phase C model router is bound below, the router-selected model wins.
    envReader: (n) => (n === "PAIR_DSH_MODEL_ROUTE" ? DSH_PRIMARY_ROUTE : process.env[n]),
    // Runtime role guard: the model DSH is about to execute with must hold
    // DSH_EXECUTION in canonical authority — a PLANNER-pool model fails closed.
    modelRoleAssertion: (provider, model) => {
      const me = new ModelEvidenceCatalog(store).getModelByIds(provider, model);
      if (!me) throw new IntegrityError("FAIL_CLOSED_MODEL_ROLE_UNASSIGNED", `no catalog entry for ${provider}:${model}`);
      assertDshExecutionModelRole(store, String(me.model_entry_id));
    },
  });
  governed.set(DSH_EXECUTOR_ID, dshAdapter);
}
if (process.env.CODEX_HOME) governed.set(CODEX_EXECUTOR_ID, new CodexCliExecutorAdapter({ journalRoot }));
// DEVIN registers unconditionally — without PAIR_DEVIN_API_KEY it stays
// UNQUALIFIED (fail-closed) and the UI shows the missing credential env name.
// Cost guard — caps remote Devin dispatches per UTC day (ACU spend) and the
// PAIR_COST_HALT=1 kill-switch. Rejections settle FAILED/BUDGET_EXCEEDED →
// recovery escalates to the operator instead of silently spending.
const MAX_REMOTE_PER_DAY = Number(process.env.PAIR_MAX_REMOTE_TASKS_PER_DAY ?? 10);
// Runtime-flippable halt: bridges/ops drop this file to stop remote spend
// without restarting the server (same effect as PAIR_COST_HALT=1).
const COST_HALT_FILE = process.env.PAIR_COST_HALT_FILE ?? path.join(dir, "COST_HALT");
const isCostHalted = () =>
  process.env.PAIR_COST_HALT === "1" || fs.existsSync(COST_HALT_FILE);
const remoteDispatchesToday = () => {
  const today = utcnow().slice(0, 10);
  return service.store
    .list("executor_execution")
    .filter((e) => String(e.executor_id) === DEVIN_EXECUTOR_ID && String(e.created_at ?? "").startsWith(today))
    .length;
};
governed.set(
  DEVIN_EXECUTOR_ID,
  new DevinExecutorAdapter({
    journalRoot,
    // Canonical config injected explicitly: the governed task.timeout wins
    // per dispatch; these are adapter-level fallbacks/blocked-clock only.
    taskTimeoutMs: cfgTaskTimeoutS * 1000,
    blockedGraceMs: cfgDevinBlockedGraceMs,
    costGuard: () => {
      if (isCostHalted())
        return { allowed: false, reason: "COST_HALT: cost halt active (env or halt file) — all remote dispatch blocked" };
      const n = remoteDispatchesToday();
      if (n >= MAX_REMOTE_PER_DAY)
        return { allowed: false, reason: `BUDGET_EXCEEDED: remote dispatch budget ${n}/${MAX_REMOTE_PER_DAY} per day reached` };
      return { allowed: true };
    },
  }),
);
for (const [id, a] of governed) adapters.set(id, a);

const gate = new GovernedTaskGate(service);
const registry = new ExecutorRegistry(service);
// Layer C — verified experience (advisory only): the extraction sweep folds
// terminal executions into CANDIDATE experience, the verifier checklist
// promotes what survives, and the routing advisor re-ranks *already-eligible*
// executors. Nothing here grants permissions, bypasses qualification, or
// opens a gate — the experience firewall stays fail-closed by construction.
const experience = new ExperienceService(service);
const experienceExtractor = new ExperienceExtractor(service, experience);
const experienceVerifier = new ExperienceVerifier(service, experience);
const routingAdvisor = new VerifiedExperienceRoutingAdvisor(service, experience);
const PAIR_ENV = {
  os: process.platform,
  arch: process.arch,
  node: process.version,
  policy_version: "v1",
};
const router = new MissionRouter(service, gate, routingAdvisor, PAIR_ENV);
const recovery = new RecoveryController(service);
const recon = new ReconciliationService(service, adapters);
const approvals = new ApprovalQueue(service);
const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
const selfmod = new SelfImprovementController(service, {
  repoRoot: root,
  selfmodRoot: path.join(dir, "selfmod"),
});
// Planner (P-UI-6): when the mission carries metadata.llm_plan — a
// sanitized task list produced by llmPlan() at the API edge — the planner
// returns it verbatim (re-validated by validatePlanProposal downstream,
// and pinned by the confirm digest). Without it, the template planner
// below runs: T1 PAIR_NATIVE records the goal, T2 DSH/Gemini analysis,
// optional T3 Codex when the goal mentions code/script/python.
const LLM_PLANNER_CAPS = [
  "AUTOMATON_TASK_EXECUTION", "FILE_OPERATIONS", "REASONING",
  "CODE_GENERATION", "CODE_EDITING", "SHELL_EXECUTION", "PYTHON_EXECUTION",
  "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION",
  "TELEGRAM_DELIVERY",
];
// Capability sets of the currently-qualified executors — sanitizePlan drops
// any task whose required_capabilities no single executor can serve.
const executorCapSets = () =>
  [...adapters.values()]
    .map((a) => {
      try {
        const c = a.capabilities();
        if (c.qualified === false) return [];
        return c.capability_ids ?? c.capabilities ?? [];
      } catch {
        return [];
      }
    })
    .filter((s) => s.length);
// THE ONE canonical LLM-plan preparation seam (Phase B R1 §7): sanitize +
// deterministic PAIR_NATIVE contract enrichment. The failover winner-check
// and the mission planner both run THIS function — the failover-validated
// list, the pinned canonical_tasks, and the committed plan are the same
// list by construction, never two subtly different transformations.
const canonicalizeLlmTasks = (rawTasks, goal) => {
  const { tasks } = sanitizePlan(rawTasks, LLM_PLANNER_CAPS, 5, executorCapSets());
  if (!tasks.length) return [];
  // PAIR_NATIVE tasks need an expected_output_contract worker_spec —
  // the LLM cannot emit one, so inject the canonical write-file
  // contract for any native-capability task that lacks it.
  for (const t of tasks) {
    if (!t.required_capabilities.includes("AUTOMATON_TASK_EXECUTION")) continue;
    t.metadata ??= {};
    if (t.metadata.expected_output_contract) continue;
    t.metadata.expected_output_contract = {
      type: "TASK_RESULT",
      worker_spec: {
        ops: [
          { op: "write_text_file", path: "mission_goal.txt", content: goal, idempotency_class: "WRITE", risk_class: "MEDIUM" },
          { op: "finish", result: { summary: "goal recorded" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
        ],
        limits: { max_ops: 4, timeout_seconds: 30 },
        allowed_ops: ["write_text_file", "finish"],
      },
    };
  }
  // Incident R1/R2 — deterministic artifact data-flow reconciliation at
  // THE canonical seam, before validatePlanProposal + plan_digest: a
  // task consuming an artifact must depend on its unique earlier
  // producer (missing edges injected with durable repair evidence);
  // unbound/ambiguous/backward producers throw FAIL_CLOSED_PLAN_DATAFLOW_*
  // so the failover winner-check treats the raw plan as PLAN_INVALID.
  // The telegram delivery authority is the operator REQUEST alone: the
  // planner cannot mint a TELEGRAM_DELIVERY task unless the pinned
  // canonical intent says the goal asked for it (R2 §2).
  reconcilePlanDataflow(tasks, {
    telegramIntent: detectTelegramDeliveryIntent(String(goal ?? "")),
  });
  return tasks;
};
const planner = (input) => {
  const goal = String(input.mission.goal);
  // Phase B pinned plan: a confirmed preview carries the EXACT persisted
  // canonical task list — return it verbatim (validatePlanProposal
  // re-validates; commitPlan pins the manifest). The planner is never
  // re-invoked for a pinned mission.
  const pinned = input.mission?.metadata?.pinned_plan_tasks;
  if (Array.isArray(pinned) && pinned.length) {
    return { tasks: pinned };
  }
  const llm = input.mission?.metadata?.llm_plan;
  if (Array.isArray(llm) && llm.length) {
    // Same canonical seam the failover used — sanitize + enrich + the
    // downstream validatePlanProposal. Idempotent on its own output.
    const tasks = canonicalizeLlmTasks(llm, goal);
    if (tasks.length) return { tasks };
  }
  const tasks = [{
    task_key: "T1",
    title: "record mission goal",
    // R8 §3 — PAIR-owned bookkeeping instruction: the goal text is
    // payload written by worker_spec, never a task directive (an
    // operator send request must not leak into the instruction).
    task_instruction: CANONICAL_BOOKKEEPING_INSTRUCTION,
    required_capabilities: ["AUTOMATON_TASK_EXECUTION"],
    depends_on: [],
    metadata: {
      expected_output_contract: {
        type: "TASK_RESULT",
        worker_spec: {
          ops: [
            { op: "write_text_file", path: "mission_goal.txt", content: goal, idempotency_class: "WRITE", risk_class: "MEDIUM" },
            { op: "finish", result: { summary: "goal recorded" }, idempotency_class: "READ_ONLY", risk_class: "LOW" },
          ],
          limits: { max_ops: 4, timeout_seconds: 30 },
          allowed_ops: ["write_text_file", "finish"],
        },
      },
    },
  }];
  if (governed.has(DSH_EXECUTOR_ID)) {
    tasks.push({
      task_key: "T2",
      title: "llm analysis (dsh)",
      task_instruction:
        `The workspace contains mission_goal.txt holding the operator's goal: "${goal}". Produce a genuine deliverable for that goal's subject matter — analyze the topic itself (never just restate or describe the goal) — write findings to analysis.txt, then reply DONE.`,
      required_capabilities: ["REASONING"],
      depends_on: ["T1"],
      metadata: {},
    });
  }
  if (governed.has(CODEX_EXECUTOR_ID) && /codex|python|script|code/i.test(goal)) {
    tasks.push({
      task_key: "T3",
      title: "codex step",
      task_instruction:
        "Create codex_out.txt in the workspace containing a short note implementing or summarizing the mission goal, then reply DONE.",
      required_capabilities: ["PYTHON_EXECUTION"],
      depends_on: ["T2"].filter((k) => tasks.some((t) => t.task_key === k)),
      metadata: {},
    });
  }
  return { tasks };
};
const runtime = new MissionRuntime({
  service, gate, router, adapters, scheduler, approvals, reconciliation: recon, recovery,
  planner,
  taskTimeoutSeconds: cfgTaskTimeoutS,
  // R3 §3 — exactly-one configured default destination for missions that
  // did NOT originate from a Telegram chat. Unset/ambiguous → explicit
  // deliveries mint UNSENDABLE (fail closed, never broadcast).
  telegramDeliveryDefaultChatId: process.env.PAIR_TG_DELIVERY_CHAT_ID || undefined,
  // R4 §3 — canonical delivery retry ceiling (bounded 1..10, default 3).
  telegramDeliveryMaxAttempts: telegramDeliveryMaxAttempts(),
});
const sup = new MissionSupervisor(service, runtime, recovery, recon);
// Extraction sweep: every executor_execution whose result was collected folds
// into experience candidates (dedup is by canonical evidence ref, so a repeat
// scan is a semantic no-op), then each candidate runs the deterministic
// verifier checklist. Verification failures just leave the row
// CANDIDATE/QUALIFIED — experience is advisory and never opens gates itself.
const EXPERIENCE_VERIFIER_ID = "PAIR_EXPERIENCE_VERIFIER";
const experienceSweep = () => {
  for (const e of store.list("executor_execution")) {
    if (!e.result_state) continue;
    try {
      for (const cand of experienceExtractor.fromExecution(String(e.execution_id), {
        origin: "REAL_EXECUTION",
        environment: PAIR_ENV,
      })) {
        try {
          let row = cand;
          const id = String(row.experience_id);
          if (String(row.status) === "CANDIDATE") {
            row = experienceVerifier.verifyAndQualify(id, EXPERIENCE_VERIFIER_ID);
          }
          if (String(row.status) === "QUALIFIED") {
            experienceVerifier.verifyAndActivate(id, EXPERIENCE_VERIFIER_ID);
          }
        } catch {
          // stays CANDIDATE/QUALIFIED — retried on the next sweep
        }
      }
    } catch {
      // execution not extractable — skip
    }
  }
};
experienceSweep();
setInterval(experienceSweep, 15_000).unref();
// Credential broker: local vault (chmod 600, outside the canonical store
// since entities must stay secret-free) + every release audited as a
// canonical event keyed to the requesting mission.
const broker = new CredentialBroker({
  vaultPath: path.join(dir, "vault.json"),
  audit: (e) =>
    store.event({
      entity_type: "mission",
      entity_id: e.mission_id ?? "unknown",
      event_type: e.event_type,
      actor: "credential-broker",
      metadata: { credential_name: e.credential_name, task_id: e.task_id, granted: e.granted },
    }),
});
const schedules = new MissionScheduleService(service);
const control = new MissionControl({
  service, runtime, supervisor: sup, scheduler, approvals, reconciliation: recon,
  observability: new MissionObservability(service), selfmod, planner,
  schedules,
  costHaltFile: COST_HALT_FILE,
  planPreviewTtlSeconds: cfgPreviewTtlS,
  // R6 §3 — canonical SENDING lease for the delivery read path
  // (PAIR_TG_DELIVERY_STALE_AFTER_MS, bounded, validated at startup).
  telegramDeliveryStaleAfterMs: cfgTgStaleAfterMs,
});
const business = new BusinessLayer({ store, control, schedules });
const workforce = new WorkforceService({ store, business });
// WFV2 §8: restart reconcile — forged/incompletely-materialized graph
// provenance is quarantined before any work item can open.
{
  const g = workforce.reconcileWorkGraph();
  if (g.quarantined.length) {
    console.log("WORK_GRAPH:", `quarantined ${g.quarantined.length} forged node(s)`);
  }
}

registry.register({
  executor_id: PAIR_NATIVE_EXECUTOR_ID,
  executor_type: "AUTOMATON_WORKER",
  capabilities: ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION"],
  health_state: "READY",
  status: "ENABLED",
  metadata: {
    qualification_state: "QUALIFIED", max_concurrency: 2,
    permission_modes: ["READ", "WRITE", "FILE_READ", "FILE_WRITE"],
    workspace_modes: ["EXPLICIT_WORKSPACE"], routing_priority: 100, supports_cancel: true,
  },
});
service.routes.seedPairNativeRoute();
for (const c of ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "PYTHON_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION", "CODE_EDITING", "REASONING", "REMOTE_CLOUD_TASK_EXECUTION", "AUTONOMOUS_CODE_EXECUTION", "TELEGRAM_DELIVERY"])
  service.registerCapability(c, { risk_class: "LOW" });
if (governed.size) {
  const reg = registerGovernedExecutors(service, governed, "PAIR_MC", {
    priorities: { DEEPSEEK_HARNESS: 40, CODEX: 60, DEVIN: 80 },
  });
  console.log("ROUTABLE:", reg.routable.join(", "));
}
if (!persistedProjects.length) {
  service.createProject({ name: "default", root_location: workspace });
}

// §4.2 — populate provider/model catalogs from canonical discovery sources
// (dsh settings, executor-advertised observations). Read-only projections.
let planProvider = null;
// Phase B — ordered planner failover candidates (qualified at boot).
const plannerCandidates = [];
if (process.env.PAIR_DSH_HOME || process.env.CODEX_HOME) {
  const dres = runProviderDiscovery(store, {
    context: { env: process.env, dshHome: process.env.PAIR_DSH_HOME, codexHome: process.env.CODEX_HOME },
  });
  // Credential-env resolvability is a real check: mark access observed +
  // discovery-eligible so model claims can fold in.
  const pc = new ProviderCatalog(store);
  for (const p of pc.listProviders()) {
    const envName = String(p.credential_reference_name ?? "");
    pc.recordAccessObservation(String(p.provider_id), envName && process.env[envName] ? "AUTH_OK" : "AUTH_REQUIRED");
    pc.setLifecycle(String(p.provider_id), "MODEL_DISCOVERY_ELIGIBLE");
  }
  const mres = await runModelDiscovery(store, {
    context: { env: process.env, dshHome: process.env.PAIR_DSH_HOME },
  });
  console.log("DISCOVERY: providers", JSON.stringify({ created: dres.created, updated: dres.updated, errors: dres.errors }));
  console.log("DISCOVERY: models", JSON.stringify({ created: mres.created, updated: mres.updated, errors: mres.errors }));

  // Canonical qualification (P6): real provider probe + tier-1 model probe +
  // qualifyModel gates — nothing is marked QUALIFIED without live evidence.
  const validator = new ProviderValidator(store);
  const mcat = new ModelEvidenceCatalog(store);
  const endpointOf = (p) => String(p.endpoint_reference ?? p.configured_endpoint_identity ?? "");
  const httpProbe = (provider, modelId) => async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${endpointOf(provider)}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env[String(provider.credential_reference_name)] ?? ""}`,
        },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(cfgProbeTimeoutMs),
      });
      return { outcome: r.ok ? "AUTH_OK" : r.status === 401 || r.status === 403 ? "AUTH_FAILED" : "UNREACHABLE", latency_ms: Date.now() - t0, detail: `http_${r.status}` };
    } catch (err) {
      return { outcome: "UNREACHABLE", latency_ms: Date.now() - t0, detail: String(err).slice(0, 120) };
    }
  };

  if (governed.has(DSH_EXECUTOR_ID)) {
    // Phase A — canonical role pools: resolve configured routes to catalog
    // model_entry_ids, enforce Planner∩DSH=∅ BEFORE assigning roles, then
    // record each model's role. Qualification remains a separate gate — a
    // role never substitutes for it.
    // R2 — strict configured-route resolution: EVERY configured route must
    // resolve to a canonical model_entry or boot fails closed BEFORE any
    // role mutation. No .filter(Boolean) — an unresolved configured route
    // is never silently dropped into a smaller pool.
    const resolveCfg = (route, role) =>
      resolveConfiguredModelRoleRoute((p, m) => mcat.getModelByIds(p, m), { route, role });
    const plannerRefs = PLANNER_ROUTES.map((r) => resolveCfg(r, MODEL_ROLE.PLANNER_COORDINATOR));
    const dshRefs = DSH_ROUTES.map((r) => resolveCfg(r, MODEL_ROLE.DSH_EXECUTION));
    // Dedupe by canonical entry (operator may set fallback=primary for a
    // single-route DSH pool) — dedupe AFTER resolution, never drop.
    const seen = new Set();
    const dshPool = dshRefs.filter((r) => (seen.has(r.model_entry_id) ? false : (seen.add(r.model_entry_id), true)));
    // R1 — canonical reconciliation: the ACTIVE assignment set converges to
    // exactly the desired pools in one atomic step (stale rows revoked to
    // role=null, changed roles reassigned, all audited — history preserved
    // in events). Then assert the resulting STORED state is disjoint, not
    // merely the configured refs.
    const roleRes = reconcileModelRoleAssignments(store, {
      planner: plannerRefs,
      dsh: dshPool,
      actor: "PAIR_MC",
    });
    console.log("MODEL_ROLE: reconciled", JSON.stringify(roleRes));
    assertCanonicalModelRoleStateDisjoint(store);

    const qualifyRoute = async ({ ref, pid, mid, model_entry_id }, bindToDsh) => {
      const prov = pc.getProvider(pid);
      const me = mcat.getModelByIds(pid, mid);
      if (!prov || !me) return null;
      // Provider-level: real access probe then canonical qualify() gates.
      await validator.validateAccess(pid, { probe: httpProbe(prov, mid), actor: "PAIR_MC" });
      const pq = validator.qualify(pid, { actor: "PAIR_MC" });
      if (!pq.qualified) { console.log("MODEL_ROUTE:", ref, "provider NOT qualified", JSON.stringify(pq.gates)); return null; }
      pc.setLifecycle(pid, "QUALIFIED");
      // REMOVED catalog entries are simply NOT ROUTABLE — skip them
      // before the probe path (probeModel fail-closes on REMOVED, which
      // would crash boot). qualifyModel's MODEL_NOT_REMOVED gate keeps
      // them unqualified everywhere else too.
      if ((me.conditions ?? []).includes("REMOVED")) {
        console.log("MODEL_ROUTE:", ref, "model REMOVED — skipped");
        return null;
      }
      // Model-level: tier-1 liveness probe proves text_inference, then
      // qualifyModel gates on probe receipts.
      const prb = await probeModel(store, String(me.model_entry_id), 1, {
        probeFn: async () => {
          const r = await httpProbe(prov, mid)();
          return { result: r.outcome === "AUTH_OK" ? "PASS" : r.outcome === "RATE_LIMITED" ? "RATE_LIMITED" : "FAIL", latency_ms: r.latency_ms, capability_evidence: r.outcome === "AUTH_OK" ? { text_inference: "PASS" } : {}, requests_used: 1, tokens_used: 1 };
        },
        capability: "text_inference",
        executorId: DSH_EXECUTOR_ID,
        actor: "PAIR_MC",
      });
      const mq = qualifyModel(store, String(me.model_entry_id), { capability_scope: ["text_inference"], actor: "PAIR_MC" });
      if (!mq.qualified) { console.log("MODEL_ROUTE:", ref, "model NOT qualified", JSON.stringify(mq.gates), "probe:", prb.result); return null; }
      if (bindToDsh) {
        const b = ensureBinding(service, {
          executor_id: DSH_EXECUTOR_ID,
          provider_id: pid,
          model_entry_id: String(me.model_entry_id),
          transport_compat: "OPENAI_COMPLETIONS",
        });
        qualifyBinding(service, String(b.binding_id));
        console.log("MODEL_ROUTE:", ref, "QUALIFIED (probe", prb.result + ") bound to", DSH_EXECUTOR_ID);
      } else {
        console.log("MODEL_ROUTE:", ref, "QUALIFIED (probe", prb.result + ") — planner only");
      }
      return { prov, me };
    };

    // Planner pool: qualified separately, never bound to DSH_EXECUTOR_ID.
    // Phase B: collect EVERY qualified route in configured order — the
    // failover chain walks them deterministically at plan time.
    for (const r of plannerRefs) {
      const q = await qualifyRoute(r, false);
      if (q) {
        plannerCandidates.push({
          model_entry_id: r.model_entry_id,
          ref: r.ref,
          provider: r.pid,
          model: r.mid,
          endpoint: endpointOf(q.prov),
          credentialEnv: String(q.prov.credential_reference_name ?? ""),
        });
      }
    }
    // DSH execution pool.
    for (const r of dshRefs) await qualifyRoute(r, true);
    // Other discovered models get DISCOVERED bindings — the routes page shows
    // them as unqualified fallbacks with their failing gate. PLANNER-pool
    // models are excluded: a planner-role model is not a DSH candidate.
    for (const m of mcat.listModels()) {
      if (modelRoleOf(store, String(m.model_entry_id)) === MODEL_ROLE.PLANNER_COORDINATOR) continue;
      ensureBinding(service, {
        executor_id: DSH_EXECUTOR_ID,
        provider_id: String(m.provider_family),
        model_entry_id: String(m.model_entry_id),
        transport_compat: "OPENAI_COMPLETIONS",
      });
    }
    // Phase C — governed DSH model routing: the canonical candidate pool is
    // the resolved+deduped configured pool (primary → fallback → extras).
    // Qualification is proven per-invocation by the router's eligibility
    // gates (never trusted from boot memory); binding authority comes from
    // canonical model_binding rows minted above.
    if (dshAdapter && dshPool.length) {
      dshAdapter.bindModelRouter(
        createDshModelRouter({ service, executorId: DSH_EXECUTOR_ID, candidates: dshPool }),
        service,
      );
      console.log(
        "DSH_MODEL_POOL:",
        JSON.stringify(dshPool.map((c) => `${c.ref}@${c.model_entry_id}`)),
      );
    }
  }
}
sup.resume();

// Phase B plan proposer: runs the canonical Planner failover chain at the
// API edge — deterministic order, one whole canonically-valid plan wins.
// R1: durable evidence — a `planner_run` row opens before the loop, every
// attempt is persisted STARTED before the model is invoked and settled
// after; exhaustion settles the run EXHAUSTED with all failed rows durable.
// R1: zero eligible candidates with a configured pool →
// FAIL_CLOSED_PLANNER_NO_ELIGIBLE — never a silent template/T1 fallback.
const knownCapabilityIds = () =>
  new Set(store.list("capability").map((c) => String(c.capability_id)));
const planExpander = async (input) => {
  const candidates = dedupePlannerCandidates(plannerCandidates);
  if (typeof input.goal !== "string" || !input.goal.trim()) {
    return { input };
  }
  const goal = String(input.goal);
  // The planner_run row opens before any candidate check so even a
  // zero-eligible request leaves durable canonical evidence (run FAILED
  // / FAIL_CLOSED_PLANNER_NO_ELIGIBLE), never a silent template fallback.
  const run = beginPlannerRun(store, {
    project_id: input.project_id != null ? String(input.project_id) : undefined,
    operator_id: input.operator_id,
    routes: candidates.map((c) => c.ref),
    actor: "PAIR_PLANNER",
  });
  try {
    if (PLANNER_ROUTES.length && !candidates.length) {
      throw new IntegrityError(
        "FAIL_CLOSED_PLANNER_NO_ELIGIBLE",
        JSON.stringify({ configured_routes: PLANNER_ROUTES }),
      );
    }
    const res = await runPlannerFailover({
      candidates,
      // §9 — full canonical eligibility re-proved before EVERY invocation
      // (role still held, model usable, provider still eligible, never a
      // DSH_EXECUTION model/alias borrowed into planning).
      assertEligible: (c) => assertPlannerCandidateEligible(store, c.model_entry_id),
      // §6/§7 — ONE canonical task-preparation seam: sanitize + native
      // contract enrichment + the same validatePlanProposal the preview
      // pins. A non-empty raw plan failing canonical validation is
      // FAILED/PLAN_INVALID and the next candidate is tried.
      canonicalize: (tasks) => {
        const canon = canonicalizeLlmTasks(tasks, goal);
        validatePlanProposal({ tasks: canon }, knownCapabilityIds());
        return canon;
      },
      planFn: (c) =>
        llmPlan(goal, {
          endpoint: `${c.endpoint}/chat/completions`,
          credentialEnv: c.credentialEnv,
          model: c.model,
          timeoutMs: cfgPlannerTimeoutMs,
          allowedCapabilities: LLM_PLANNER_CAPS,
          capabilitySets: executorCapSets(),
        }),
      onAttemptStart: (base) =>
        persistPlannerAttemptStart(store, {
          planner_run_id: String(run.planner_run_id),
          project_id: input.project_id != null ? String(input.project_id) : undefined,
          record: base,
          actor: "PAIR_PLANNER",
        }).planner_attempt_id,
      onAttemptEnd: (paid, rec) =>
        settlePlannerAttempt(store, {
          planner_attempt_id: String(paid),
          record: rec,
          winner: rec.outcome === "SUCCESS",
          actor: "PAIR_PLANNER",
        }),
      onExhausted: () =>
        finishPlannerRun(store, {
          planner_run_id: String(run.planner_run_id),
          outcome: "EXHAUSTED",
          actor: "PAIR_PLANNER",
        }),
    });
    finishPlannerRun(store, {
      planner_run_id: String(run.planner_run_id),
      outcome: "WINNER_SELECTED",
      winner_attempt_no: res.winner.attempt_no,
      actor: "PAIR_PLANNER",
    });
    return {
      input: {
        ...input,
        metadata: {
          ...(typeof input.metadata === "object" && input.metadata ? input.metadata : {}),
          llm_plan: res.tasks,
          plan_source: "LLM",
          plan_model: res.winner.model,
          plan_warnings: res.warnings,
        },
      },
      planner: {
        planner_run_id: String(run.planner_run_id),
        attempts: res.attempts,
        winner: res.winner,
        warnings: res.warnings,
        allowed_capabilities: LLM_PLANNER_CAPS,
        capability_sets: executorCapSets(),
      },
    };
  } catch (e) {
    if (!(e instanceof IntegrityError && e.code === "FAIL_CLOSED_PLANNER_EXHAUSTED")) {
      finishPlannerRun(store, {
        planner_run_id: String(run.planner_run_id),
        outcome: "FAILED",
        error_code: e instanceof IntegrityError || e instanceof PolicyError ? e.code : "REQUEST_ERROR",
        actor: "PAIR_PLANNER",
      });
    }
    throw e;
  }
};
const uiDir = process.env.PAIR_MC_UI_DIR ?? path.join(root, "apps/mission-control-ui/dist");
const server = createMissionControlServer({
  control,
  staticDir: fs.existsSync(path.join(uiDir, "index.html")) ? uiDir : undefined,
  planExpander,
  // PAIR_MC_TOKEN gates every /api/* request (Bearer header or ?token= for
  // SSE). Unset = open local mode; always set it when the port is reachable
  // by anyone but you (e.g. a public preview URL).
  authToken: mcToken.token,
  // Narrow-scope upload token for remote executor file deliverables
  // (POST /api/outbox). Separate from PAIR_MC_TOKEN on purpose — remote
  // agents see this value in their prompt, so it must not grant API access.
  outboxToken: process.env.PAIR_OUTBOX_TOKEN || undefined,
  // Credential broker: PAIR_BROKER_TOKEN is the server-side master secret
  // that mints/verifies task-scoped capabilities for POST /api/broker/fetch.
  // Remote agents carry ONLY a minted x-broker-capability bound to their
  // mission/task/governed-task/executor — never the master token. Operator
  // management rides the normal MC-token routes /api/credentials.
  broker,
  brokerToken: process.env.PAIR_BROKER_TOKEN || undefined,
  // Business layer: companies/org-agents/work-items/routines/budgets —
  // always on; entities live in the canonical store alongside missions.
  business,
  workforce,
});
const port = Number(process.env.PAIR_MC_PORT ?? 8788);
server.listen(port, () => {
  console.log(`PAIR Mission Control on http://localhost:${port} (ui=${fs.existsSync(path.join(uiDir, "index.html")) ? uiDir : "legacy"})`);
});
setInterval(() => {
  sup.tick();
  // fire due cron schedules through canonical submit, expanding each goal
  // through the same LLM plan seam the API edge uses
  control.tickSchedules(undefined, planExpander).catch((e) =>
    console.error("tickSchedules:", String(e).slice(0, 200)));
}, 1000).unref();
