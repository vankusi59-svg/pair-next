/**
 * codex-cli-transport — the ONE generic auth-safe Codex CLI invocation
 * primitive (P15.3 R2 addendum §C).
 *
 *   codex-cli-transport.ts        (generic: executable resolution, safe
 *       |                          child env, CODEX_HOME forwarding,
 *       |                          API-key stripping, spawn, timeout/kill,
 *       |                          scratch dir, final-message collection,
 *       |                          bounded stderr, exit classification)
 *       +-- Codex Planner transport (codex-planner.ts: planner argv,
 *       |                          planner schema/prompt/gates)
 *       +-- Codex CEO_DECISION transport (ceo-decision.ts: CEO argv,
 *                                      CEO schema/prompt/gates)
 *
 * The role contracts are NEVER merged: the caller supplies its own argv
 * profile, output schema, and prompt. This file owns only the mechanics.
 *
 * AUTH INVARIANT: CODEX_API_KEY / OPENAI_API_KEY are deliberately NOT
 * forwarded to the child — `codex exec` env API-key auth can take
 * precedence over the persisted ChatGPT session, and an ambient key in
 * the PAIR parent must never silently flip reasoning onto API billing.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { PairEvidenceStore } from "./store.js";
import { ProviderCatalog } from "./provider-catalog.js";
import { ModelEvidenceCatalog, canonicalModelId } from "./model-catalog.js";

export const CODEX_CLI_PROVIDER_ID = "codex-cli";
export const CODEX_CLI_PROTOCOL_FAMILY = "CODEX_CLI";
export const CODEX_CLI_ENDPOINT = "codex-cli://local";

/** Codex-transport warning vocabulary — role transports map these onto
 *  their own failure-class enums. */
export const CODEX_CLI_WARNING = {
  CLI_MISSING: "CODEX_CLI_MISSING",
  AUTH_FAILED: "CODEX_AUTH_FAILED",
  MODEL_UNAVAILABLE: "CODEX_MODEL_UNAVAILABLE",
  TIMEOUT: "CODEX_TIMEOUT",
  RATE_LIMITED: "CODEX_RATE_LIMITED",
  OUTPUT_INVALID: "CODEX_OUTPUT_INVALID",
  SPAWN_ERROR: "CODEX_SPAWN_ERROR",
} as const;

export type CodexCliEnv = NodeJS.ProcessEnv | ((name: string) => string | undefined);

export function codexCliEnvGet(env: CodexCliEnv | undefined, name: string): string | undefined {
  if (!env) return process.env[name];
  return typeof env === "function" ? env(name) : env[name];
}

export function resolveCodexExecutable(env: CodexCliEnv | undefined): string | null {
  const configured =
    codexCliEnvGet(env, "PAIR_CODEX_PLANNER_EXECUTABLE") ??
    codexCliEnvGet(env, "PAIR_CODEX_EXECUTABLE");
  if (configured) return configured;
  try {
    const resolved = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/** Child env: minimal inherited surface only; CODEX_HOME pins the
 *  persisted ChatGPT session. API-key variables are deliberately absent —
 *  an ambient OPENAI_API_KEY/CODEX_API_KEY in the PAIR parent is never
 *  visible to the reasoning child. Nothing is logged or persisted. */
export function codexCliChildEnv(env: CodexCliEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "PATH", "HOME", "LANG", "LC_ALL", "CODEX_HOME", "NODE_PATH",
    // test-only fake-executable controls — inert for the real binary
    "FAKE_CODEX_BEHAVIOR", "FAKE_CODEX_PIDFILE", "FAKE_CODEX_INVOKELOG", "FAKE_CODEX_ENVFILE",
  ]) {
    const v = codexCliEnvGet(env, k);
    if (v) out[k] = v;
  }
  return out;
}

export interface CodexCliSpawnResult {
  status: "COMPLETED" | "FAILED" | "TIMEOUT" | "SPAWN_FAILED";
  code: number | null;
  stderrTail: string;
  error?: string;
}

export async function spawnCodexCli(
  command: string,
  args: string[],
  prompt: string,
  runDir: string,
  timeoutMs: number,
  env: CodexCliEnv | undefined,
): Promise<CodexCliSpawnResult> {
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: runDir,
      env: codexCliChildEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return { status: "SPAWN_FAILED", code: null, stderrTail: "", error: String(e).slice(0, 200) };
  }
  let stderrBuf = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrBuf = (stderrBuf + d.toString("utf8")).slice(-8192); // bounded tail only
  });
  child.stdout?.resume(); // output is the --output-last-message file; stdout events are discarded
  try {
    child.stdin?.write(prompt);
    child.stdin?.end();
  } catch {
    /* child may exit before stdin flush */
  }
  return await new Promise<CodexCliSpawnResult>((resolve) => {
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

/** stderr/exit classifier → the shared failure vocabulary. */
export function classifyCodexCliExit(code: number | null, stderr: string): string {
  const s = stderr.toLowerCase();
  if (/401|403|unauthoriz|authentication|not logged in|login required|invalid api key|access denied|forbidden/.test(s))
    return CODEX_CLI_WARNING.AUTH_FAILED;
  if (/model.*(not found|not available|unavailable|does not exist|unsupported|unknown|no longer available)|unknown model|no access to|404/.test(s))
    return CODEX_CLI_WARNING.MODEL_UNAVAILABLE;
  if (/429|rate.?limit|quota|insufficient_quota|usage limit|too many requests/.test(s))
    return CODEX_CLI_WARNING.RATE_LIMITED;
  return `${CODEX_CLI_WARNING.SPAWN_ERROR}${code != null ? `:${code}` : ""}`;
}

export interface CodexCliInvokeConfig {
  executable: string;
  model: string;
  timeoutMs: number;
  /** Scratch root — a per-invocation run dir is created under it. */
  scratchDir: string;
  /** Role-side argv builder: (runDir, schemaPath, finalPath) → args.
   *  Owns the role's permission profile — the generic primitive never
   *  chooses it. */
  argv: (runDir: string, schemaPath: string, finalPath: string) => string[];
  /** Schema-constrained output file written to the run dir when set. */
  schema?: Record<string, unknown>;
  /** Prefix for the per-invocation scratch subdir name. */
  runPrefix?: string;
  /** Byte bound on the role's final-message file (R3.C). When set, the
   *  file is statted BEFORE any read — an oversized output is reported
   *  as `finalOversized` without an unbounded readFileSync allocation. */
  maxFinalBytes?: number;
  /** When true the per-invocation run dir (schema.json + final.txt —
   *  the RAW model output) is removed on every outcome. CEO passes
   *  this: raw CEO output is never durable evidence. The Planner
   *  retains its current semantics (run dirs preserved). */
  removeRunDir?: boolean;
}

export interface CodexCliInvokeOutcome {
  result: CodexCliSpawnResult;
  finalText: string | null;
  /** true when the final-message file exceeded `maxFinalBytes` —
   *  the file was NEVER read. */
  finalOversized: boolean;
}

/** Real non-interactive codex invocation — one typed outcome + the
 *  collected final message (untrusted text; exit 0 is never authority).
 *
 *  SCRATCH HYGIENE (R3.C): with `removeRunDir` set, the per-invocation
 *  run dir — including the raw final-message text and the schema file —
 *  is removed on EVERY outcome (COMPLETED / FAILED / TIMEOUT /
 *  SPAWN_FAILED / oversized / spawn throw). Raw model output exists
 *  only in memory; the durable evidence is the caller's
 *  response_digest. The configured scratch ROOT itself is never
 *  deleted. Callers that leave `removeRunDir` unset retain the prior
 *  behavior (run dir preserved — e.g. the Planner contract). */
export async function invokeCodexCli(
  cfg: CodexCliInvokeConfig,
  prompt: string,
  env: CodexCliEnv | undefined,
): Promise<CodexCliInvokeOutcome> {
  const runDir = path.join(
    cfg.scratchDir,
    `${cfg.runPrefix ?? "cx"}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(runDir, { recursive: true });
  try {
    const schemaPath = path.join(runDir, "schema.json");
    const finalPath = path.join(runDir, "final.txt");
    if (cfg.schema) fs.writeFileSync(schemaPath, JSON.stringify(cfg.schema));
    const args = cfg.argv(runDir, schemaPath, finalPath);
    const result = await spawnCodexCli(cfg.executable, args, prompt, runDir, cfg.timeoutMs, env);
    let finalText: string | null = null;
    let finalOversized = false;
    if (fs.existsSync(finalPath)) {
      // Bound BEFORE allocation — an oversized final file is never
      // read into memory.
      const size = fs.statSync(finalPath).size;
      if (cfg.maxFinalBytes !== undefined && size > cfg.maxFinalBytes) {
        finalOversized = true;
      } else {
        finalText = fs.readFileSync(finalPath, "utf8");
      }
    }
    return { result, finalText, finalOversized };
  } finally {
    if (cfg.removeRunDir) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* cleanup is best-effort; never mask the typed outcome */
      }
    }
  }
}

/** The ONE canonical candidate identity for the codex-cli provider —
 *  used by catalog seeding AND by STALE re-observation so the
 *  re-observed identity is byte-identical. */
export function codexCliProviderCandidate(): Record<string, unknown> {
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

/** Role-neutral canonical catalog seed: the `codex-cli` provider + a
 *  `codex-cli:<model>` model_entry. The SAME entry may serve
 *  PLANNER_COORDINATOR and CEO_DECISION invocations without a second
 *  provider/model authority. */
export function ensureCodexCliCatalog(
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
