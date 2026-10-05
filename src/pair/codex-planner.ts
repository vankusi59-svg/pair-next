/**
 * codex-planner.ts — CPL-1: Codex CLI planner transport.
 *
 * A dedicated PLANNER-side provider: `codex-cli:<model>` candidates invoke
 * `codex exec` directly as a plan proposer — NEVER the governed
 * CodexCliExecutorAdapter dispatch path. The planner child runs under a
 * read-only permission profile with network disabled and produces only
 * planner output (a task DAG on --output-last-message): no governed task,
 * no dispatch journal, no workspace mutation, no capability grants, no
 * artifact authority.
 *
 * Same contract as every planner transport: output is untrusted text that
 * flows through `sanitizePlan` → `canonicalizeLlmTasks` →
 * `validatePlanProposal`; exit code 0 is not authoritative — malformed or
 * canonically-invalid output is a typed FAILED attempt, then failover.
 *
 * Usability is proven by a real non-interactive invocation at route
 * qualification (CLI present + auth usable + model available + schema
 * output works), recorded through the canonical provider/model probe
 * seams — config presence alone never counts as eligibility.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { IntegrityError } from "./errors.js";
import { PLANNER_FAILURE_CLASS, type PlannerFailureClass } from "./planner-pool.js";
import {
  buildPlannerUserPrompt,
  plannerSystemPrompt,
  LLM_PLAN_RESERVED_CAPABILITY_WARNING,
  reservedAutomatonMisuseKey,
  extractPlanJson,
  sanitizePlan,
  isBookkeepingShapedTask,
  resolveWorkTaskBudget,
  LLM_PLANNER_MIN_TASKS,
  type PlannerRejectionContext,
} from "./llm-planner.js";
import { assertPlannerCandidateEligible, assertPlannerRoleAndDisjoint } from "./model-role.js";
import { providerModelEligibility } from "./model-routable.js";
import type { PairEvidenceStore } from "./store.js";
import { ProviderCatalog } from "./provider-catalog.js";
import { ModelEvidenceCatalog, canonicalModelId } from "./model-catalog.js";
import { ProviderValidator } from "./provider-validation.js";
import { probeModel, qualifyModel } from "./model-probing.js";
import { CODEX_EXECUTOR_ID } from "./codex-adapter.js";
import type { PlannerCandidate } from "./planner-pool.js";
import type { PlannerEligibilityRejection } from "./model-role.js";

export const CODEX_CLI_PROVIDER_ID = "codex-cli";
export const CODEX_CLI_PROTOCOL_FAMILY = "CODEX_CLI";
export const CODEX_CLI_ENDPOINT = "codex-cli://local";
export const CODEX_PLANNER_DEFAULT_MODEL = "gpt-6.1-sol";
export const CODEX_PLANNER_DEFAULT_TIMEOUT_MS = 900_000;

/** Codex-transport warning codes — mapped onto PlannerFailureClass in
 *  classifyPlannerFailure (planner-pool.ts). */
export const CODEX_PLANNER_WARNING = {
  CLI_MISSING: "CODEX_CLI_MISSING",
  AUTH_FAILED: "CODEX_AUTH_FAILED",
  MODEL_UNAVAILABLE: "CODEX_MODEL_UNAVAILABLE",
  TIMEOUT: "CODEX_TIMEOUT",
  RATE_LIMITED: "CODEX_RATE_LIMITED",
  OUTPUT_INVALID: "CODEX_OUTPUT_INVALID",
  SPAWN_ERROR: "CODEX_SPAWN_ERROR",
  PLAN_DEGENERATE: "CODEX_PLAN_DEGENERATE",
} as const;

export type CodexPlannerEnv = NodeJS.ProcessEnv | ((name: string) => string | undefined);

function envGet(env: CodexPlannerEnv | undefined, name: string): string | undefined {
  if (!env) return process.env[name];
  return typeof env === "function" ? env(name) : env[name];
}

export interface CodexPlannerInvokeConfig {
  /** Absolute codex executable (default: `which codex`). */
  executable?: string;
  /** CODEX_HOME (auth home). Passed through to the child. */
  env?: CodexPlannerEnv;
  /** Model pinned via `-m` on every planner invocation. */
  model: string;
  timeoutMs?: number;
  /** Directory the planner child runs in (read-only profile); a per-
   *  invocation scratch subdir is created for schema/output artifacts. */
  scratchDir: string;
  allowedCapabilities: string[];
  capabilitySets?: string[][];
  maxTasks?: number;
  /** P-REASK — bounded rejection feedback on the ONE canonical-rejection
   *  re-ask; rendered into the SAME canonical prompt builder as every
   *  other transport (MINIMAL-REPAIR, never F3 alternative-plan). */
  rejectionContext?: PlannerRejectionContext;
}

function resolveExecutable(env: CodexPlannerEnv | undefined): string | null {
  const configured = envGet(env, "PAIR_CODEX_PLANNER_EXECUTABLE") ?? envGet(env, "PAIR_CODEX_EXECUTABLE");
  if (configured) return configured;
  try {
    const resolved = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/** Child env: minimal inherited surface only; CODEX_HOME pins the
 *  persisted ChatGPT session. CODEX_API_KEY/OPENAI_API_KEY are
 *  deliberately NOT forwarded (R1.B): `codex exec` env API-key auth can
 *  take precedence over the persisted ChatGPT session — an ambient key in
 *  the PAIR parent must never silently flip the planner onto API billing.
 *  Nothing is logged or persisted from it. */
function childEnv(env: CodexPlannerEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "PATH", "HOME", "LANG", "LC_ALL", "CODEX_HOME", "NODE_PATH",
    // test-only fake-executable controls — inert for the real binary
    "FAKE_CODEX_BEHAVIOR", "FAKE_CODEX_PIDFILE", "FAKE_CODEX_INVOKELOG", "FAKE_CODEX_ENVFILE",
  ]) {
    const v = envGet(env, k);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Planner argv — mirrors the governed executor's hard isolation profile
 * (--ignore-user-config --strict-config so host config can never silently
 * shape a plan; approval_policy=never; web_search disabled — the planner
 * must not fetch), but read-only + network off and bounded to the scratch
 * root. The model is pinned with -m so evidence names the real model.
 */
function plannerArgv(model: string, runDir: string, schemaPath: string, finalPath: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--color", "never",
    "--config", "approval_policy=never",
    "--config", "web_search=disabled",
    "--config", "default_permissions=pair_planner",
    "--config", "permissions.pair_planner.extends=:workspace",
    "--config", `permissions.pair_planner.filesystem={':minimal'='read','${runDir}'='read'}`,
    "--config", "permissions.pair_planner.network.enabled=false",
    "--config", `permissions.pair_planner.workspace_roots={'${runDir}'=true}`,
    "-m", model,
    "-C", runDir,
    "--output-schema", schemaPath,
    "--output-last-message", finalPath,
    "--json",
  ];
}

interface SpawnResult {
  status: "COMPLETED" | "FAILED" | "TIMEOUT" | "SPAWN_FAILED";
  code: number | null;
  stderrTail: string;
  error?: string;
}

async function spawnCodex(
  command: string,
  args: string[],
  prompt: string,
  runDir: string,
  timeoutMs: number,
  env: CodexPlannerEnv | undefined,
): Promise<SpawnResult> {
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: runDir,
      env: childEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return { status: "SPAWN_FAILED", code: null, stderrTail: "", error: String(e).slice(0, 200) };
  }
  let stderrBuf = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrBuf = (stderrBuf + d.toString("utf8")).slice(-8192); // bounded tail only
  });
  child.stdout?.resume(); // planner output is the --output-last-message file; stdout events are discarded
  try {
    child.stdin?.write(prompt);
    child.stdin?.end();
  } catch {
    /* child may exit before stdin flush */
  }
  return await new Promise<SpawnResult>((resolve) => {
    const tail = () => stderrBuf.slice(-4000);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      resolve({ status: "TIMEOUT", code: null, stderrTail: tail(), error: "CODEX_TIMEOUT" });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: "SPAWN_FAILED", code: null, stderrTail: tail(), error: String(e).slice(0, 200) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        status: code === 0 ? "COMPLETED" : "FAILED",
        code,
        stderrTail: tail(),
      });
    });
  });
}

/** stderr/exit classifier → the mandate's failure vocabulary. */
function classifyCodexExit(code: number | null, stderr: string): string {
  const s = stderr.toLowerCase();
  if (/401|403|unauthoriz|authentication|not logged in|login required|invalid api key|access denied|forbidden/.test(s))
    return CODEX_PLANNER_WARNING.AUTH_FAILED;
  if (/model.*(not found|not available|unavailable|does not exist|unsupported|unknown|no longer available)|unknown model|no access to|404/.test(s))
    return CODEX_PLANNER_WARNING.MODEL_UNAVAILABLE;
  if (/429|rate.?limit|quota|insufficient_quota|usage limit|too many requests/.test(s))
    return CODEX_PLANNER_WARNING.RATE_LIMITED;
  return `${CODEX_PLANNER_WARNING.SPAWN_ERROR}${code != null ? `:${code}` : ""}`;
}

// OpenAI strict structured outputs: every object level needs
// additionalProperties:false and required covering all properties.
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task_key", "title", "task_instruction", "required_capabilities", "depends_on"],
        properties: {
          task_key: { type: "string" },
          title: { type: "string" },
          task_instruction: { type: "string" },
          required_capabilities: { type: "array", items: { type: "string" } },
          depends_on: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** Ping schema for the qualification probe — verifies schema-constrained
 *  output support without forcing the plan shape onto a liveness check. */
const PING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

/** Real non-interactive codex invocation — returns one typed outcome. */
async function invokeRaw(
  cfg: { executable: string; model: string; timeoutMs: number; scratchDir: string; schema?: Record<string, unknown> },
  prompt: string,
  env: CodexPlannerEnv | undefined,
): Promise<{ result: SpawnResult; finalText: string | null }> {
  const runDir = path.join(cfg.scratchDir, `pl-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(runDir, { recursive: true });
  const schemaPath = path.join(runDir, "schema.json");
  const finalPath = path.join(runDir, "final.txt");
  fs.writeFileSync(schemaPath, JSON.stringify(cfg.schema ?? PLAN_SCHEMA));
  const args = plannerArgv(cfg.model, runDir, schemaPath, finalPath);
  const result = await spawnCodex(cfg.executable, args, prompt, runDir, cfg.timeoutMs, env);
  const finalText = fs.existsSync(finalPath) ? fs.readFileSync(finalPath, "utf8") : null;
  return { result, finalText };
}

/**
 * Boot-time qualification probe — proves CLI present + auth usable + model
 * invocable via a REAL invocation (never "config looks right"). Outcome
 * vocabulary is consumed by ProviderValidator.validateAccess /
 * recordProbeObservation, so the typed reason lands in durable state
 * (probe_state PROBE_<outcome>, auth_state) for per-attempt eligibility.
 */
export async function codexPlannerProbe(opts: {
  model: string;
  timeoutMs?: number;
  scratchDir: string;
  env?: CodexPlannerEnv;
}): Promise<{ outcome: string; latency_ms: number; detail: string }> {
  const t0 = Date.now();
  const exe = resolveExecutable(opts.env);
  if (!exe) {
    return { outcome: "CLI_MISSING", latency_ms: Date.now() - t0, detail: "codex executable not resolvable" };
  }
  const ping = {
    executable: exe,
    model: opts.model,
    // R1.C — the configured probe budget is authoritative verbatim: no
    // hidden codex-specific ceiling/floor on top of it.
    timeoutMs: opts.timeoutMs ?? 60_000,
    scratchDir: opts.scratchDir,
    schema: PING_SCHEMA,
  };
  let out: Awaited<ReturnType<typeof invokeRaw>>;
  try {
    out = await invokeRaw(ping, `Reply with exactly: {"ok": true}`, opts.env);
  } catch (e) {
    return { outcome: "UNREACHABLE", latency_ms: Date.now() - t0, detail: String(e).slice(0, 160) };
  }
  const { result, finalText } = out;
  const detail = (result.stderrTail || result.error || "").slice(0, 160);
  if (result.status === "TIMEOUT") return { outcome: "TIMEOUT", latency_ms: Date.now() - t0, detail };
  if (result.status === "SPAWN_FAILED") {
    const warn = /ENOENT|not found/i.test(result.error ?? "") ? "CLI_MISSING" : "UNREACHABLE";
    return { outcome: warn, latency_ms: Date.now() - t0, detail: (result.error ?? "spawn failed").slice(0, 160) };
  }
  if (result.status === "FAILED") {
    const warn = classifyCodexExit(result.code, result.stderrTail);
    const outcome =
      warn === CODEX_PLANNER_WARNING.AUTH_FAILED ? "AUTH_FAILED"
      : warn === CODEX_PLANNER_WARNING.MODEL_UNAVAILABLE ? "MODEL_UNAVAILABLE"
      : warn === CODEX_PLANNER_WARNING.RATE_LIMITED ? "RATE_LIMITED"
      : "UNREACHABLE";
    return { outcome, latency_ms: Date.now() - t0, detail: detail || warn };
  }
  // COMPLETED — a real response must exist; schema-constrained output is the
  // contract the planner relies on, so an empty/absent final message fails.
  if (!finalText || !finalText.trim()) {
    return { outcome: "UNREACHABLE", latency_ms: Date.now() - t0, detail: "empty final message" };
  }
  return { outcome: "AUTH_OK", latency_ms: Date.now() - t0, detail: `invocation_ok code=0` };
}

/**
 * The planner invocation: spawn codex under the planner profile, read the
 * schema-constrained final message, sanitize through the SAME plan contract
 * every transport uses. Never throws for model-side failures — returns
 * typed warnings the failover classifier maps onto PlannerFailureClass.
 */
export async function codexPlannerPlan(
  goal: string,
  cfg: CodexPlannerInvokeConfig,
): Promise<{ tasks: Array<Record<string, unknown>>; warnings: string[] }> {
  const exe = cfg.executable ?? resolveExecutable(cfg.env);
  if (!exe) return { tasks: [], warnings: [CODEX_PLANNER_WARNING.CLI_MISSING] };
  const timeoutMs = cfg.timeoutMs ?? CODEX_PLANNER_DEFAULT_TIMEOUT_MS;
  const workBudget = resolveWorkTaskBudget(goal, cfg.maxTasks);
  const prompt =
    `${plannerSystemPrompt()}\n\n${buildPlannerUserPrompt(goal, {
      allowedCapabilities: cfg.allowedCapabilities,
      capabilitySets: cfg.capabilitySets,
      maxTasks: cfg.maxTasks,
      rejectionContext: cfg.rejectionContext,
    })}`;
  let out: Awaited<ReturnType<typeof invokeRaw>>;
  try {
    out = await invokeRaw({ executable: exe, model: cfg.model, timeoutMs, scratchDir: cfg.scratchDir }, prompt, cfg.env);
  } catch (e) {
    return { tasks: [], warnings: [`${CODEX_PLANNER_WARNING.SPAWN_ERROR}:${String(e).slice(0, 80)}`] };
  }
  const { result, finalText } = out;
  if (result.status === "TIMEOUT") return { tasks: [], warnings: [CODEX_PLANNER_WARNING.TIMEOUT] };
  if (result.status === "SPAWN_FAILED") {
    if (/ENOENT|not found/i.test(result.error ?? "")) return { tasks: [], warnings: [CODEX_PLANNER_WARNING.CLI_MISSING] };
    return { tasks: [], warnings: [`${CODEX_PLANNER_WARNING.SPAWN_ERROR}:${(result.error ?? "").slice(0, 80)}`] };
  }
  if (result.status === "FAILED") {
    return { tasks: [], warnings: [classifyCodexExit(result.code, result.stderrTail)] };
  }
  if (!finalText || !finalText.trim()) {
    return { tasks: [], warnings: [CODEX_PLANNER_WARNING.OUTPUT_INVALID] };
  }
  let parsed: unknown;
  try {
    parsed = extractPlanJson(finalText);
  } catch {
    return { tasks: [], warnings: [CODEX_PLANNER_WARNING.OUTPUT_INVALID] };
  }
  const rawTasks = (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(rawTasks) || !rawTasks.length) {
    return { tasks: [], warnings: ["LLM_PLAN_NO_TASKS"] };
  }
  // PRV2-A R1.A — reserved-capability misuse fails the candidate typed;
  // AUTOMATON is never stripped off a mixed task and pretended away.
  const misuseKey = reservedAutomatonMisuseKey(rawTasks as Array<Record<string, unknown>>);
  if (misuseKey) {
    return { tasks: [], warnings: [`${LLM_PLAN_RESERVED_CAPABILITY_WARNING}:${misuseKey}`] };
  }
  // R1.A — sanitize keeps the PAIR-reserved AUTOMATON key ONLY so a pure
  // bookkeeping-shaped emission survives to the canonicalize seam for
  // deterministic normalization; it is never model-visible and can never
  // survive as a work task (the misuse check above rejects it first).
  const sanitizeCaps = cfg.allowedCapabilities.includes("AUTOMATON_TASK_EXECUTION")
    ? cfg.allowedCapabilities
    : [...cfg.allowedCapabilities, "AUTOMATON_TASK_EXECUTION"];
  const { tasks, warnings } = sanitizePlan(
    rawTasks as Parameters<typeof sanitizePlan>[0],
    sanitizeCaps,
    workBudget,
    cfg.capabilitySets,
  );
  if (!tasks.length) return { tasks: [], warnings: ["LLM_PLAN_ALL_INVALID", ...warnings] };
  // PRV2-A §D — degenerate = ZERO usable work tasks (a bookkeeping-only
  // plan performs no work; PAIR injects bookkeeping itself).
  const usable = tasks.filter(
    (t) => !isBookkeepingShapedTask(t, sanitizeCaps),
  );
  if (usable.length < LLM_PLANNER_MIN_TASKS) {
    return { tasks: [], warnings: [...warnings, CODEX_PLANNER_WARNING.PLAN_DEGENERATE] };
  }
  return { tasks, warnings };
}

/** argv the planner child runs under — exposed for evidence/tests: proves
 *  the planner transport carries --ephemeral --ignore-user-config and a
 *  read-only, network-disabled profile (never governed-dispatch flags). */
export function codexPlannerArgvForTest(
  model: string,
  runDir: string,
  schemaPath = path.join(runDir, "schema.json"),
  finalPath = path.join(runDir, "final.txt"),
): string[] {
  return plannerArgv(model, runDir, schemaPath, finalPath);
}

/**
 * Per-attempt eligibility for codex-cli candidates (R1.A) — the FULL
 * canonical Phase E eligibility every planner transport must satisfy:
 * role + planner/DSH disjointness + `providerModelEligibility` (all
 * provider/model authority gates) via the shared canonical seam
 * `assertPlannerCandidateEligible`. Authority violations keep the
 * canonical THROW semantics (FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE /
 * role / overlap codes — never a failover verdict); availability
 * rejections pass through verbatim, then are enriched with codex-typed
 * failure classes read from the DURABLE probe evidence so
 * planner_attempt rows stay transport-faithful.
 */
export function assertCodexPlannerCandidateEligible(
  store: PairEvidenceStore,
  candidate: Pick<PlannerCandidate, "model_entry_id" | "provider" | "model">,
): PlannerEligibilityRejection | void {
  let verdict: PlannerEligibilityRejection | void;
  try {
    verdict = assertPlannerCandidateEligible(store, candidate.model_entry_id);
  } catch (e) {
    // CPL-1 R5 — an authority throw whose EVERY failed gate is an
    // operational preflight gate AND current durable codex probe/auth
    // evidence proves an operational failure is a typed availability
    // rejection (failover-eligible: ZERO plan, Gemini proceeds), not a
    // whole-pool abort. Receipt/identity/linkage gate failures,
    // DISABLED/REMOVED conditions, and unrecognized evidence all keep
    // throwing. Never returns success — only full eligibility PASS may
    // invoke the planner.
    if (e instanceof IntegrityError && String(e.code ?? "") === "FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE") {
      const ops = codexOperationalFailureRejection(store, candidate, e);
      if (ops) return ops;
    }
    throw e;
  }
  if (!verdict) return;
  // Availability-channel verdict only (authority already threw above).
  // The last recorded probe outcome may carry a more specific codex
  // failure type than the generic availability class — translate for
  // evidence; the verdict's failed-gate reason is preserved verbatim.
  const typed = codexProbeStateFailureClass(store, candidate);
  return typed ? { reject: true, failure_class: typed, reason: verdict.reason } : verdict;
}

/** Codex-typed failure class from the durable provider probe_state, when
 *  it is more specific than the generic availability class. */
function codexProbeStateFailureClass(
  store: PairEvidenceStore,
  candidate: Pick<PlannerCandidate, "provider">,
): PlannerFailureClass | null {
  const provider = new ProviderCatalog(store).getProvider(String(candidate.provider));
  const probeState = String(provider?.probe_state ?? "");
  return probeState === "PROBE_CLI_MISSING" ? PLANNER_FAILURE_CLASS.CLI_MISSING
    : probeState === "PROBE_TIMEOUT" ? PLANNER_FAILURE_CLASS.TIMEOUT
    : probeState === "PROBE_RATE_LIMITED" ? PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED
    : probeState === "PROBE_MODEL_UNAVAILABLE" ? PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE
    : null;
}

/** The only AUTHORITY gates durable codex preflight evidence can explain:
 *  the provider could not prove QUALIFIED/AUTH_OK/NOT_BLOCKED because a
 *  bounded operational probe/validation already recorded WHY. Receipt and
 *  provider↔model linkage gates stay structural. Availability gates
 *  (PROBE_CURRENT, MODEL_QUALIFIED, …) failing alongside is expected —
 *  they ARE the operational evidence. */
const OPERATIONAL_EXPLAINABLE_GATES = new Set([
  "PROVIDER_QUALIFIED",
  "PROVIDER_AUTH_OK",
  "PROVIDER_NOT_BLOCKED",
]);
const CANONICAL_AUTHORITY_GATES = new Set([
  "PROVIDER_QUALIFIED",
  "PROVIDER_AUTH_OK",
  "PROVIDER_NOT_BLOCKED",
  "PROVIDER_RECEIPT_CURRENT",
  "MODEL_RECEIPT_CURRENT",
  "MODEL_PROVIDER_MATCH",
  "MODEL_PROVIDER_IDENTITY_CONSISTENT",
]);

/**
 * CPL-1 R5 — convert an eligibility authority throw into a typed
 * failover-eligible rejection ONLY when (a) every failed gate is
 * operational-preflight, (b) no DISABLED/REMOVED operator condition is
 * present, and (c) the durable probe_state/auth_state records a
 * recognized operational codex failure (CLI_MISSING, TIMEOUT,
 * RATE_LIMITED, MODEL_UNAVAILABLE, AUTH_FAILED/CREDENTIAL_MISSING,
 * UNREACHABLE). UNQUALIFIED alone is NOT sufficient — it only converts
 * alongside proven operational probe evidence. Returns null when the
 * throw cannot be explained operationally (caller rethrows).
 */
function codexOperationalFailureRejection(
  store: PairEvidenceStore,
  candidate: Pick<PlannerCandidate, "model_entry_id" | "provider">,
  e: IntegrityError,
): PlannerEligibilityRejection | null {
  let failed: string[] = [];
  try {
    const detail = JSON.parse(String(e.detail ?? "{}")) as { failed_gates?: string[] };
    failed = Array.isArray(detail.failed_gates) ? detail.failed_gates : [];
  } catch {
    return null;
  }
  const failedAuthority = failed.filter((g) => CANONICAL_AUTHORITY_GATES.has(g));
  if (!failedAuthority.length || !failedAuthority.every((g) => OPERATIONAL_EXPLAINABLE_GATES.has(g))) return null;
  const provider = new ProviderCatalog(store).getProvider(String(candidate.provider));
  const conditions = (provider?.conditions ?? []) as string[];
  if (conditions.some((c) => c === "DISABLED" || c === "REMOVED")) return null;
  const probeState = String(provider?.probe_state ?? "");
  const authState = String(provider?.auth_state ?? "");
  const typed =
    codexProbeStateFailureClass(store, candidate)
    ?? (["PROBE_AUTH_FAILED", "PROBE_AUTH_REJECTED", "PROBE_CREDENTIAL_MISSING"].includes(probeState)
      ? PLANNER_FAILURE_CLASS.AUTH_REJECTED
      : probeState === "PROBE_UNREACHABLE"
        ? PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE
        : authState === "AUTH_FAILED" || authState === "CREDENTIAL_MISSING"
          ? PLANNER_FAILURE_CLASS.AUTH_REJECTED
          : authState === "UNREACHABLE" || authState === "ACCESS_DENIED"
            ? PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE
            : null);
  return typed
    ? { reject: true, failure_class: typed, reason: `${failed.join(",")}|operational_evidence:${probeState || authState}` }
    : null;
}

/**
 * ONE bounded canonical refresh/requalification cycle for the codex-cli
 * planner provider+model (R1 §3A) — the SAME seams boot qualification
 * uses: validateAccess (real bounded probe → durable probe_state/
 * auth_state) → qualify (provider qualification receipt) → probeModel
 * (model probe receipt) → qualifyModel (model qualification receipt,
 * supersedes a stale epoch). No shadow qualification: every write goes
 * through the existing canonical Provider/Model evidence seams, and the
 * verdict is never returned here — callers re-run FULL eligibility.
 */
export async function refreshCodexPlannerQualification(
  store: PairEvidenceStore,
  opts: {
    provider_id: string;
    model_entry_id: string;
    model: string;
    scratchDir: string;
    /** Canonical configured probe budget (PAIR_MODEL_PROBE_TIMEOUT_MS). */
    timeoutMs: number;
    env?: CodexPlannerEnv;
    actor?: string;
  },
): Promise<{
  access_outcome: string;
  provider_qualified: boolean;
  model_probe_result: string | null;
  model_qualified: boolean;
}> {
  const actor = opts.actor ?? "PAIR_PLANNER";
  const codexProbe = () =>
    codexPlannerProbe({
      model: opts.model,
      scratchDir: opts.scratchDir,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });
  const pc = new ProviderCatalog(store);
  // CPL-1 R3.A + R4 — structural pre-probe guard on a FRESH canonical read
  // at refresh start (closes the plan-time TOCTOU: marks installed after
  // the availability verdict are observed here too). Explicit operator/
  // authority marks fail closed BEFORE any codexPlannerProbe — provider
  // DISABLED/REMOVED; model REMOVED/DEPRECATED/BLOCKED / planner↔DSH
  // overlap via the shared role seam; and the canonical identity-linkage
  // authority gates MODEL_PROVIDER_MATCH / MODEL_PROVIDER_IDENTITY_CONSISTENT
  // via the shared providerModelEligibility projection. R4.A — UNQUALIFIED
  // is transient qualification residue, NOT an operator denial: the normal
  // canonical qualify chain below legitimately clears it after a
  // successful requalification (issueQualificationReceipt removes it), so
  // it must not deadlock recovery here. R4.B — only the two linkage gates
  // are checked pre-probe: PROVIDER_QUALIFIED/probe-currentness/receipt
  // gates are intentionally NOT required (legitimate bootstrap starts
  // unqualified/unprobed and is exactly what this seam re-mints).
  const structural = ((pc.getProvider(opts.provider_id)?.conditions ?? []) as string[]).filter(
    (c) => c === "DISABLED" || c === "REMOVED",
  );
  const linkage = providerModelEligibility(store, opts.provider_id, opts.model_entry_id);
  const failedLinkage = (["MODEL_PROVIDER_MATCH", "MODEL_PROVIDER_IDENTITY_CONSISTENT"] as const).filter(
    (g) => linkage.gates[g] === "FAIL",
  );
  if (structural.length > 0 || failedLinkage.length > 0) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE",
      JSON.stringify({ model_entry_id: opts.model_entry_id, structural_conditions: structural, failed_gates: failedLinkage }),
    );
  }
  assertPlannerRoleAndDisjoint(store, opts.model_entry_id);
  // R2.B — canonical re-observation for a STALE provider before the
  // re-probe: a legitimate current observation through the SAME
  // ProviderCatalog.upsertCandidate authority seam that seeding uses
  // (identical codex-cli identity facets) clears STALE → REAPPEARED and
  // demotes stale authority (lifecycle DISCOVERY_ELIGIBLE, AUTH_REQUIRED,
  // UNPROBED, receipt pointer cleared) so the normal
  // validateAccess→qualify chain must re-mint authority. Gated to
  // STALE-only: REMOVED/DISABLED/UNQUALIFIED are operator/authority marks
  // — they never reach the refresh seam (upfront authority throw) and
  // must never auto-revive through re-observation.
  const conditions = new Set(((pc.getProvider(opts.provider_id)?.conditions ?? []) as string[]));
  if (conditions.has("STALE") && !conditions.has("REMOVED") && !conditions.has("DISABLED")) {
    pc.upsertCandidate(codexCliProviderCandidate(), actor);
  }
  const validator = new ProviderValidator(store);
  const acc = await validator.validateAccess(opts.provider_id, { probe: codexProbe, actor });
  const pq = validator.qualify(opts.provider_id, { actor });
  if (pq.qualified) pc.setLifecycle(opts.provider_id, "QUALIFIED", { actor });
  const me = store.tryGet("model_entry", opts.model_entry_id);
  let modelProbeResult: string | null = null;
  let modelQualified = false;
  if (me && !((me.conditions as string[]) ?? []).includes("REMOVED")) {
    const prb = await probeModel(store, opts.model_entry_id, 1, {
      probeFn: async () => {
        const r = await codexProbe();
        return {
          result: r.outcome === "AUTH_OK" ? "PASS" : r.outcome === "RATE_LIMITED" ? "RATE_LIMITED" : "FAIL",
          latency_ms: r.latency_ms,
          capability_evidence: r.outcome === "AUTH_OK" ? { text_inference: "PASS" } : {},
          requests_used: 1,
          tokens_used: 1,
        };
      },
      capability: "text_inference",
      executorId: CODEX_EXECUTOR_ID,
      actor,
    });
    modelProbeResult = String(prb.result ?? null);
    modelQualified = qualifyModel(store, opts.model_entry_id, {
      capability_scope: ["text_inference"],
      actor,
    }).qualified;
  }
  return {
    access_outcome: String(acc.outcome),
    provider_qualified: pq.qualified,
    model_probe_result: modelProbeResult,
    model_qualified: modelQualified,
  };
}

/**
 * Codex-first canonical eligibility with bounded refresh (R1 §3).
 * Classification is the canonical two-channel split — never a
 * hand-written gate list:
 *
 *   - AUTHORITY violations (role/disjoint + the canonical AUTHORITY_GATES:
 *     PROVIDER_QUALIFIED/AUTH_OK/NOT_BLOCKED/RECEIPT_CURRENT,
 *     MODEL_PROVIDER_MATCH/IDENTITY_CONSISTENT/RECEIPT_CURRENT) throw
 *     BEFORE any refresh — structural/operator rejections are never
 *     retried.
 *   - AVAILABILITY rejections (probe/currentness/health/scope evidence
 *     the canonical projection calls failover-eligible) earn exactly ONE
 *     bounded canonical refresh via `refreshCodexPlannerQualification`,
 *     then the FULL canonical eligibility is re-proved. PASS → the
 *     candidate is invoked and stays priority #1; still-reject → the
 *     typed failed attempt settles (reason records both verdicts) and
 *     failover continues to the next candidate.
 */
export async function assertCodexPlannerCandidateEligibleWithRefresh(
  store: PairEvidenceStore,
  candidate: Pick<PlannerCandidate, "model_entry_id" | "provider" | "model">,
  deps: {
    /** The bounded canonical refresh cycle (production wires
     *  refreshCodexPlannerQualification; tests may substitute). */
    refresh: () => Promise<unknown>;
  },
): Promise<PlannerEligibilityRejection | void> {
  const verdict = assertCodexPlannerCandidateEligible(store, candidate);
  if (!verdict) return; // eligible now, or authority threw before this point
  // Refreshable rejection → exactly ONE bounded canonical refresh. Snapshot
  // operator marks first: marks that APPEAR during the refresh still abort
  // (a concurrent operator revocation is never availability evidence).
  const operatorMarksBefore = providerOperatorMarks(store, candidate);
  try {
    await deps.refresh();
  } catch (e) {
    // Integrity/authority-typed failures inside the canonical refresh
    // seams propagate (e.g. a model REMOVED mid-flight) — they are not
    // failover evidence. Anything else means the refresh could not even
    // run; the original typed rejection stands.
    if (e instanceof IntegrityError) throw e;
    return {
      ...verdict,
      reason: `${verdict.reason}|refresh_error:${String(e instanceof Error ? e.name : e).slice(0, 60)}`,
    };
  }
  let after: PlannerEligibilityRejection | void;
  try {
    after = assertCodexPlannerCandidateEligible(store, candidate);
  } catch (e) {
    // Post-refresh authority failure (§4A FAIL path): if the ONLY new
    // authority fact is evidence the refresh itself legitimately
    // committed — a failed canonical requalification stamping
    // UNQUALIFIED — the attempt settles typed FAILED and failover
    // proceeds (the durable mark stays for the operator; the NEXT
    // invocation re-throws upfront). Newly-appearing DISABLED/REMOVED
    // marks (concurrent operator action) and receipt/identity-gate
    // violations are always structural → propagate.
    if (!(e instanceof IntegrityError) || String(e.code ?? "") !== "FAIL_CLOSED_PLANNER_PROVIDER_INELIGIBLE") throw e;
    const marksAfter = providerOperatorMarks(store, candidate);
    const freshOperatorMark = [...OPERATOR_MARKS].some((m) => !operatorMarksBefore.has(m) && marksAfter.has(m));
    if (freshOperatorMark) throw e;
    const failed = postRefreshFailedGates(store, candidate);
    if (failed.some((g) => POST_REFRESH_STRUCTURAL_GATES.has(g))) throw e;
    const typed = codexProbeStateFailureClass(store, candidate) ?? PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE;
    return {
      reject: true,
      failure_class: typed,
      reason: `${verdict.reason}|refresh_failed:${failed.join(",") || String(e.code)}`,
    };
  }
  if (!after) return; // canonical refresh repaired currentness → priority #1 kept
  return { ...after, reason: `${verdict.reason}|refresh_failed:${after.reason}` };
}

/** Current failed gate names from the canonical eligibility computation
 *  (read-only — used to label a post-refresh authority failure). */
function postRefreshFailedGates(
  store: PairEvidenceStore,
  candidate: Pick<PlannerCandidate, "model_entry_id" | "provider">,
): string[] {
  const model = store.tryGet("model_entry", String(candidate.model_entry_id));
  const pid = String(model?.provider_id ?? candidate.provider);
  const elig = providerModelEligibility(store, pid, String(candidate.model_entry_id));
  return Object.entries(elig.gates).filter(([, v]) => v === "FAIL").map(([k]) => k);
}

/** DISABLED/REMOVED/UNQUALIFIED-style operator marks on the provider row.
 *  Snapshot compared across the bounded refresh: a mark that newly
 *  appears mid-refresh (concurrent operator action) must abort, while a
 *  mark the refresh itself committed (a legitimately-failed canonical
 *  requalification stamping UNQUALIFIED) is availability evidence. */
function providerOperatorMarks(
  store: PairEvidenceStore,
  candidate: Pick<PlannerCandidate, "model_entry_id" | "provider">,
): Set<string> {
  const model = store.tryGet("model_entry", String(candidate.model_entry_id));
  const pid = String(model?.provider_id ?? candidate.provider);
  const provider = new ProviderCatalog(store).getProvider(pid);
  return new Set(((provider?.conditions ?? []) as string[]).map(String));
}

const OPERATOR_MARKS = new Set(["DISABLED", "REMOVED"]);
/** Failed gates that are always structural after a refresh — receipt or
 *  identity violations can never be auto-repaired by a planner refresh. */
const POST_REFRESH_STRUCTURAL_GATES = new Set([
  "PROVIDER_RECEIPT_CURRENT",
  "MODEL_RECEIPT_CURRENT",
  "MODEL_PROVIDER_MATCH",
  "MODEL_PROVIDER_IDENTITY_CONSISTENT",
]);

/**
 * Seed the codex-cli provider + model_entry into the canonical catalogs so
 * a `codex-cli:<model>` planner route resolves through the EXISTING strict
 * configured-route seam (resolveConfiguredModelRoleRoute) — the candidate
 * then carries a real model_entry_id that role assignment, disjointness
 * enforcement, eligibility, and planner_attempt evidence all bind to.
 */
/** The ONE canonical candidate identity for the codex-cli planner
 *  provider — used by seeding AND by STALE re-observation (R2.B) so the
 *  re-observed identity is byte-identical: provider_id=codex-cli,
 *  LOCAL_CLI, CODEX_CLI protocol family, codex-cli://local endpoint. */
function codexCliProviderCandidate(): Record<string, unknown> {
  return {
    provider_native_id: CODEX_CLI_PROVIDER_ID,
    provider_id: CODEX_CLI_PROVIDER_ID,
    provider_type: "LOCAL_CLI",
    protocol_family: CODEX_CLI_PROTOCOL_FAMILY,
    provider_family: CODEX_CLI_PROVIDER_ID,
    configured_endpoint_identity: CODEX_CLI_ENDPOINT,
    endpoint_reference: CODEX_CLI_ENDPOINT,
    credential_reference_name: null,
    credential_envs: [],
    capabilities: [],
    source_id: "PAIR_PROVIDER_REGISTRY",
  };
}

export function ensureCodexCliPlannerCatalog(
  store: PairEvidenceStore,
  model: string,
  actor = "PAIR_MC",
): string {
  const pc = new ProviderCatalog(store);
  pc.upsertCandidate(codexCliProviderCandidate(), actor);
  const mcat = new ModelEvidenceCatalog(store);
  mcat.upsertModelClaim(
    {
      provider_id: CODEX_CLI_PROVIDER_ID,
      provider_family: CODEX_CLI_PROVIDER_ID,
      model_id: model,
      display_name: `Codex CLI ${model}`,
      capability_hints: ["text_inference"],
    },
    actor,
  );
  return canonicalModelId(CODEX_CLI_PROVIDER_ID, model);
}
