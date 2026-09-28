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
 *   PAIR_DSH_MODEL_ROUTE  optional provider:model override
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../dist/state/database.js";
import {
  ApprovalQueue,
  CodexCliExecutorAdapter,
  DshExecutorAdapter,
  ExecutorRegistry,
  GovernedTaskGate,
  MissionControl,
  MissionObservability,
  MissionRouter,
  MissionRuntime,
  MissionScheduler,
  MissionSupervisor,
  PairControlPlane,
  PairEvidenceStore,
  PairNativeExecutorAdapter,
  PairNativeWorkerRunner,
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
  DSH_EXECUTOR_ID,
  PAIR_NATIVE_EXECUTOR_ID,
} from "../dist/pair/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = process.env.PAIR_MC_DIR ?? path.join(root, ".pair-mc");
fs.mkdirSync(dir, { recursive: true });
const workspace = fs.mkdtempSync(path.join(dir, "ws-"));
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
if (process.env.PAIR_DSH_HOME) governed.set(DSH_EXECUTOR_ID, new DshExecutorAdapter({ journalRoot }));
if (process.env.CODEX_HOME) governed.set(CODEX_EXECUTOR_ID, new CodexCliExecutorAdapter({ journalRoot }));
for (const [id, a] of governed) adapters.set(id, a);

const gate = new GovernedTaskGate(service);
const registry = new ExecutorRegistry(service);
const router = new MissionRouter(service, gate);
const recovery = new RecoveryController(service);
const recon = new ReconciliationService(service, adapters);
const approvals = new ApprovalQueue(service);
const scheduler = new MissionScheduler(service, { mission_concurrency: 2 });
const selfmod = new SelfImprovementController(service, {
  repoRoot: root,
  selfmodRoot: path.join(dir, "selfmod"),
});
// Demo planner: T1 records the goal via PAIR_NATIVE (guaranteed artifact),
// T2 asks DSH (Gemini by default) to read it and produce analysis.txt — a
// real governed LLM call routed by capability (REASONING is DSH-only).
// Optional T3 Codex step when the goal mentions code/script/python.
// Falls back to T1-only when governed executors are absent.
const planner = (input) => {
  const goal = String(input.mission.goal);
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
        "The workspace contains mission_goal.txt with the mission goal. Read it and create analysis.txt containing a short analysis of the goal, then reply DONE.",
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
});
const sup = new MissionSupervisor(service, runtime, recovery, recon);
const control = new MissionControl({
  service, runtime, supervisor: sup, scheduler, approvals, reconciliation: recon,
  observability: new MissionObservability(service), selfmod, planner,
});

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
for (const c of ["FILE_OPERATIONS", "AUTOMATON_TASK_EXECUTION", "PYTHON_EXECUTION", "SHELL_EXECUTION", "CODE_GENERATION", "CODE_EDITING", "REASONING", "REMOTE_CLOUD_TASK_EXECUTION"])
  service.registerCapability(c, { risk_class: "LOW" });
if (governed.size) {
  const reg = registerGovernedExecutors(service, governed, "PAIR_MC");
  console.log("ROUTABLE:", reg.routable.join(", "));
}
service.createProject({ name: "default", root_location: workspace });

// §4.2 — populate provider/model catalogs from canonical discovery sources
// (dsh settings, executor-advertised observations). Read-only projections.
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
        signal: AbortSignal.timeout(8000),
      });
      return { outcome: r.ok ? "AUTH_OK" : r.status === 401 || r.status === 403 ? "AUTH_FAILED" : "UNREACHABLE", latency_ms: Date.now() - t0, detail: `http_${r.status}` };
    } catch (err) {
      return { outcome: "UNREACHABLE", latency_ms: Date.now() - t0, detail: String(err).slice(0, 120) };
    }
  };

  if (governed.has(DSH_EXECUTOR_ID)) {
    const wanted = [
      String(process.env.PAIR_DSH_MODEL_ROUTE ?? "gemini:gemini-3.1-flash-lite"),
      String(process.env.PAIR_DSH_FALLBACK_ROUTE ?? "groq:openai/gpt-oss-20b"),
    ];
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

const uiDir = process.env.PAIR_MC_UI_DIR ?? path.join(root, "apps/mission-control-ui/dist");
const server = createMissionControlServer({
  control,
  staticDir: fs.existsSync(path.join(uiDir, "index.html")) ? uiDir : undefined,
});
const port = Number(process.env.PAIR_MC_PORT ?? 8788);
server.listen(port, () => {
  console.log(`PAIR Mission Control on http://localhost:${port} (ui=${fs.existsSync(path.join(uiDir, "index.html")) ? uiDir : "legacy"})`);
});
setInterval(() => sup.tick(), 1000).unref();
