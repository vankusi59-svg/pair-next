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
if (process.env.PAIR_DSH_HOME) governed.set(DSH_EXECUTOR_ID, new DshExecutorAdapter({ journalRoot, routeResolver: (id) => service.routes.getRoute(id) }));
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
const planner = (input) => {
  const goal = String(input.mission.goal);
  const llm = input.mission?.metadata?.llm_plan;
  if (Array.isArray(llm) && llm.length) {
    // Safety re-check at the seam: sanitize again (defense in depth — the
    // API edge already sanitized; validatePlanProposal validates next).
    const { tasks } = sanitizePlan(llm, LLM_PLANNER_CAPS, 5, executorCapSets());
    if (tasks.length) {
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
      return { tasks };
    }
  }
  const tasks = [{
    task_key: "T1",
    title: "record mission goal",
    task_instruction: goal,
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
  // Per-task execution cap; slow planner-route models (nvidia glm-5.3) need
  // more than the 120s default for multi-step tasks.
  taskTimeoutS: Number(process.env.PAIR_TASK_TIMEOUT_S ?? 120),
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
let planProviders = [];
let modelRoutesRegistered = 0;
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
        signal: AbortSignal.timeout(Number(process.env.PAIR_MODEL_PROBE_TIMEOUT_MS ?? 8000)),
      });
      return { outcome: r.ok ? "AUTH_OK" : r.status === 401 || r.status === 403 ? "AUTH_FAILED" : "UNREACHABLE", latency_ms: Date.now() - t0, detail: `http_${r.status}` };
    } catch (err) {
      return { outcome: "UNREACHABLE", latency_ms: Date.now() - t0, detail: String(err).slice(0, 120) };
    }
  };

  if (governed.has(DSH_EXECUTOR_ID)) {
    const wanted = [
      String(process.env.PAIR_DSH_MODEL_ROUTE ?? "gemini:gemini-3.1-flash-lite"),
      String(process.env.PAIR_DSH_FALLBACK_ROUTE ?? "cloudflare:@cf/zai-org/glm-4.7-flash"),
    ];
    for (const extra of String(process.env.PAIR_DSH_EXTRA_ROUTES ?? "groq:openai/gpt-oss-20b").split(",")) {
      const r = extra.trim();
      if (r && !wanted.includes(r)) wanted.push(r);
    }
    for (const route of wanted) {
      const [pid, mid] = route.split(":");
      const prov = pc.getProvider(pid);
      const me = mcat.getModelByIds(pid, mid);
      if (!prov || !me) { console.log("MODEL_ROUTE: skip", route, "(not discovered)"); continue; }
      // Provider-level: real access probe then canonical qualify() gates.
      await validator.validateAccess(pid, { probe: httpProbe(prov, mid), actor: "PAIR_MC" });
      const pq = validator.qualify(pid, { actor: "PAIR_MC" });
      if (!pq.qualified) { console.log("MODEL_ROUTE:", route, "provider NOT qualified", JSON.stringify(pq.gates)); continue; }
      pc.setLifecycle(pid, "QUALIFIED");
      // REMOVED catalog entries are simply NOT ROUTABLE — skip them
      // before the probe path (probeModel fail-closes on REMOVED, which
      // would crash boot). qualifyModel's MODEL_NOT_REMOVED gate keeps
      // them unqualified everywhere else too.
      if ((me.conditions ?? []).includes("REMOVED")) {
        console.log("MODEL_ROUTE:", route, "model REMOVED — skipped");
        continue;
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
      if (!mq.qualified) { console.log("MODEL_ROUTE:", route, "model NOT qualified", JSON.stringify(mq.gates), "probe:", prb.result); continue; }
      const b = ensureBinding(service, {
        executor_id: DSH_EXECUTOR_ID,
        provider_id: pid,
        model_entry_id: String(me.model_entry_id),
        transport_compat: "OPENAI_COMPLETIONS",
      });
      qualifyBinding(service, String(b.binding_id));
      console.log("MODEL_ROUTE:", route, "QUALIFIED (probe", prb.result + ") bound to", DSH_EXECUTOR_ID);
      // Qualified routes double as the LLM planner's failover chain, in
      // boot priority order — quota/timeout/errors on one fall to the next.
      planProviders.push({
        route,
        endpoint: endpointOf(prov),
        credentialEnv: String(prov.credential_reference_name ?? ""),
        model: mid,
      });
      // Each qualified model also becomes a canonical executor route so
      // task dispatch goes through route decisions (RE_ROUTE failover,
      // decision receipts, per-model cost/telemetry). Priority preserves
      // boot order; the legacy single RTE_DSH_ACP route is disabled below
      // whenever at least one model route qualified.
      const modelRouteId = `RTE_DSH_${pid}_${mid}`.replace(/[^A-Za-z0-9_]+/g, "_").toUpperCase();
      const dshCaps = (service.routes.getRoute("RTE_DSH_ACP")?.capabilities) ?? [];
      if (!service.routes.getRoute(modelRouteId)) {
        service.routes.registerRoute({
          route_id: modelRouteId,
          route_kind: "REMOTE_GATEWAY_API",
          enabled: true,
          eligibility_state: "QUALIFIED",
          qualification_state: "QUALIFIED",
          capabilities: dshCaps,
          priority: 10 + modelRoutesRegistered * 10,
          executor_hint: DSH_EXECUTOR_ID,
          model_entry_id: String(me.model_entry_id),
          model_id: mid,
          metadata: {
            provider_id: pid,
            model_id: mid,
            credential_env: String(prov.credential_reference_name ?? ""),
            model_route: route,
            transport: "ACP_STDIO",
          },
        }, "PAIR_MC");
      }
      if (!service.routes.bindingFor(DSH_EXECUTOR_ID, modelRouteId)) {
        service.routes.registerBinding({
          executor_id: DSH_EXECUTOR_ID,
          route_id: modelRouteId,
          mechanism: "SPAWN_ENV",
          qualification_state: "QUALIFIED",
        }, "PAIR_MC");
      }
      modelRoutesRegistered++;
    }
    // With canonical model routes live, the single env-pinned executor
    // route is disabled — dispatch must go through a model route decision
    // (fail-closed rather than silently reverting to the env default). It
    // stays enabled only when no model route qualified at all.
    if (modelRoutesRegistered > 0) {
      service.routes.setRouteEnabled("RTE_DSH_ACP", false, "PAIR_MC");
      console.log("MODEL_ROUTE: RTE_DSH_ACP disabled —", modelRoutesRegistered, "canonical model route(s) registered");
    }
    // Other discovered models get DISCOVERED bindings — the routes page shows
    // them as unqualified fallbacks with their failing gate.
    for (const m of mcat.listModels()) {
      ensureBinding(service, {
        executor_id: DSH_EXECUTOR_ID,
        provider_id: String(m.provider_family),
        model_entry_id: String(m.model_entry_id),
        transport_compat: "OPENAI_COMPLETIONS",
      });
    }
  }
}
sup.resume();

// P-UI-6 plan expander: LLM-proposes a task DAG for the goal at the API
// edge (preview only). Runs only when a provider route qualified at boot;
// any failure → llmPlan falls back to the minimal T1 plan itself.
const planExpander = async (input) => {
  if (!planProviders.length || typeof input.goal !== "string" || !input.goal.trim()) return input;
  // Failover: try each qualified route in boot priority order; a quota/
  // timeout/http/parse failure on one model falls through to the next.
  const planTimeoutMs = Number(process.env.PAIR_LLM_PLANNER_TIMEOUT_MS ?? 20000);
  const failedRoutes = [];
  let res = null;
  for (const p of planProviders) {
    const r = await llmPlan(String(input.goal), {
      endpoint: `${p.endpoint}/chat/completions`,
      credentialEnv: p.credentialEnv,
      model: p.model,
      allowedCapabilities: LLM_PLANNER_CAPS,
      capabilitySets: executorCapSets(),
      timeoutMs: planTimeoutMs,
    });
    if (r.tasks.length) { res = r; break; }
    failedRoutes.push(`${p.route}[${r.warnings.join(",") || "NO_TASKS"}]`);
  }
  if (!res) {
    // Degenerate/unusable plan — fail closed: a T1-only plan would run and
    // report COMPLETED having done nothing. FAIL_CLOSED_* code → HTTP 409.
    const e = new Error(`planner produced no usable task plan across ${planProviders.length} route(s) (${failedRoutes.join(" | ") || "none"})`);
    e.code = "FAIL_CLOSED_PLAN_DEGENERATE";
    throw e;
  }
  return {
    ...input,
    metadata: {
      ...(typeof input.metadata === "object" && input.metadata ? input.metadata : {}),
      llm_plan: res.tasks,
      plan_source: res.source,
      plan_model: res.model,
      plan_warnings: failedRoutes.length
        ? [...res.warnings, `LLM_PLANNER_FAILOVER ${failedRoutes.join(" | ")}`]
        : res.warnings,
    },
  };
};
const uiDir = process.env.PAIR_MC_UI_DIR ?? path.join(root, "apps/mission-control-ui/dist");
const server = createMissionControlServer({
  control,
  staticDir: fs.existsSync(path.join(uiDir, "index.html")) ? uiDir : undefined,
  planExpander,
  // PAIR_MC_TOKEN gates every /api/* request (Bearer header or ?token= for
  // SSE). Unset = open local mode; always set it when the port is reachable
  // by anyone but you (e.g. a public preview URL).
  authToken: process.env.PAIR_MC_TOKEN || undefined,
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
