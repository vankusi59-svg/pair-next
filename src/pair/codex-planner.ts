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
  extractPlanJson,
  sanitizePlan,
  LLM_PLANNER_DEFAULT_MAX_TASKS,
  LLM_PLANNER_MIN_TASKS,
} from "./llm-planner.js";
import { assertPlannerRoleAndDisjoint } from "./model-role.js";
import type { PairEvidenceStore } from "./store.js";
import { ProviderCatalog } from "./provider-catalog.js";
import { ModelEvidenceCatalog, canonicalModelId } from "./model-catalog.js";
import type { PlannerCandidate } from "./planner-pool.js";
import type { PlannerEligibilityRejection } from "./model-role.js";

export const CODEX_CLI_PROVIDER_ID = "codex-cli";
export const CODEX_CLI_PROTOCOL_FAMILY = "CODEX_CLI";
export const CODEX_CLI_ENDPOINT = "codex-cli://local";
export const CODEX_PLANNER_DEFAULT_MODEL = "gpt-6.1-sol";
export const CODEX_PLANNER_DEFAULT_TIMEOUT_MS = 120_000;

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

/** Child env: secrets pinned only when present; CODEX_HOME needed for
 *  ChatGPT auth files. Nothing is logged or persisted from it. */
function childEnv(env: CodexPlannerEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "PATH", "HOME", "LANG", "LC_ALL", "CODEX_HOME", "NODE_PATH",
    "OPENAI_API_KEY", "CODEX_API_KEY",
    // test-only fake-executable controls — inert for the real binary
    "FAKE_CODEX_BEHAVIOR", "FAKE_CODEX_PIDFILE",
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
    timeoutMs: Math.min(opts.timeoutMs ?? 60_000, 60_000),
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
  const prompt =
    `${plannerSystemPrompt()}\n\n${buildPlannerUserPrompt(goal, {
      allowedCapabilities: cfg.allowedCapabilities,
      capabilitySets: cfg.capabilitySets,
      maxTasks: cfg.maxTasks ?? LLM_PLANNER_DEFAULT_MAX_TASKS,
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
  const { tasks, warnings } = sanitizePlan(
    rawTasks as Parameters<typeof sanitizePlan>[0],
    cfg.allowedCapabilities,
    cfg.maxTasks ?? LLM_PLANNER_DEFAULT_MAX_TASKS,
    cfg.capabilitySets,
  );
  if (!tasks.length) return { tasks: [], warnings: ["LLM_PLAN_ALL_INVALID", ...warnings] };
  if (tasks.length < LLM_PLANNER_MIN_TASKS) {
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
 * Per-attempt eligibility for codex-cli candidates — the transport-specific
 * extension the failover seam permits. Role + planner/DSH disjointness +
 * model authority conditions keep THROW semantics (authority, never
 * failover); usability is read from DURABLE probe/access evidence written
 * by qualification (no silent config presence), with provider/model
 * availability translated into typed failover-eligible rejections.
 */
export function assertCodexPlannerCandidateEligible(
  store: PairEvidenceStore,
  candidate: Pick<PlannerCandidate, "model_entry_id" | "provider" | "model">,
): PlannerEligibilityRejection | void {
  const model = assertPlannerRoleAndDisjoint(store, candidate.model_entry_id);
  // Authority conditions on the model itself stay fail-closed (operator
  // marks / lifecycle removals are never a retryable availability signal).
  const conditions = (model.conditions as string[]) ?? [];
  const authorityHit = conditions.find((c) => ["REMOVED", "DEPRECATED", "BLOCKED"].includes(c));
  if (authorityHit) {
    throw new IntegrityError(
      "FAIL_CLOSED_PLANNER_MODEL_AUTHORITY",
      JSON.stringify({ model_entry_id: candidate.model_entry_id, condition: authorityHit }),
    );
  }
  const provider = new ProviderCatalog(store).getProvider(candidate.provider);
  if (!provider) {
    return { reject: true, failure_class: PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE, reason: "provider_missing" };
  }
  // Availability → typed failover-eligible reject derived from the LAST
  // recorded probe/access evidence (never silently assumed usable).
  const authState = String(provider.auth_state ?? "");
  const probeState = String(provider.probe_state ?? "");
  const lifecycle = String(provider.lifecycle_state ?? "");
  if (authState === "AUTH_FAILED") {
    return { reject: true, failure_class: PLANNER_FAILURE_CLASS.AUTH_REJECTED, reason: "auth_failed" };
  }
  if (probeState === "PROBE_CLI_MISSING") {
    return { reject: true, failure_class: PLANNER_FAILURE_CLASS.CLI_MISSING, reason: "cli_missing" };
  }
  if (probeState === "PROBE_MODEL_UNAVAILABLE") {
    return { reject: true, failure_class: PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE, reason: "model_unavailable" };
  }
  if (probeState === "PROBE_TIMEOUT") {
    return { reject: true, failure_class: PLANNER_FAILURE_CLASS.TIMEOUT, reason: "timeout" };
  }
  if (probeState === "PROBE_RATE_LIMITED") {
    return { reject: true, failure_class: PLANNER_FAILURE_CLASS.QUOTA_RATE_LIMITED, reason: "rate_limited" };
  }
  if (probeState.startsWith("PROBE_") || probeState === "UNPROBED") {
    return {
      reject: true,
      failure_class: PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE,
      reason: `probe_state:${probeState}`,
    };
  }
  if (lifecycle !== "QUALIFIED" && lifecycle !== "ACCESS_VALIDATED" && lifecycle !== "PROBED") {
    return {
      reject: true,
      failure_class: PLANNER_FAILURE_CLASS.PROVIDER_UNAVAILABLE,
      reason: `lifecycle:${lifecycle}`,
    };
  }
  if (String(model.lifecycle_state ?? "") !== "QUALIFIED") {
    return {
      reject: true,
      failure_class: PLANNER_FAILURE_CLASS.MODEL_UNAVAILABLE,
      reason: `model_lifecycle:${String(model.lifecycle_state ?? "UNKNOWN")}`,
    };
  }
  return;
}

/**
 * Seed the codex-cli provider + model_entry into the canonical catalogs so
 * a `codex-cli:<model>` planner route resolves through the EXISTING strict
 * configured-route seam (resolveConfiguredModelRoleRoute) — the candidate
 * then carries a real model_entry_id that role assignment, disjointness
 * enforcement, eligibility, and planner_attempt evidence all bind to.
 */
export function ensureCodexCliPlannerCatalog(
  store: PairEvidenceStore,
  model: string,
  actor = "PAIR_MC",
): string {
  const pc = new ProviderCatalog(store);
  pc.upsertCandidate(
    {
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
    },
    actor,
  );
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
