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

/** The codex home a spawned child resolves — explicit CODEX_HOME, else
 *  the platform default (~/.codex via HOME/USERPROFILE). Mirrors what
 *  the child itself sees: the persisted session lives in this dir. */
export function codexHomeDir(env: CodexCliEnv | undefined): string | null {
  const configured = codexCliEnvGet(env, "CODEX_HOME");
  if (configured) return configured;
  const home =
    codexCliEnvGet(env, "HOME") ?? codexCliEnvGet(env, "USERPROFILE");
  return home ? path.join(home, ".codex") : null;
}

/** The effective Codex CLI authentication mode a governed child would
 *  run under (R2-F1). `codex exec` resolves auth as: env API key (never
 *  forwarded to governed children — codexCliChildEnv strips it; the
 *  executor adapter strips it for autonomous dispatch) → the persisted
 *  session file. So auth.json's STRUCTURE is the effective mode:
 *  an explicit `auth_mode` field takes precedence over credential-shape
 *  inference (R3); absent it, a non-empty stored OPENAI_API_KEY or any
 *  alternative persisted credential family is metered/contradictory
 *  billing even when ambient env keys are absent; a ChatGPT OAuth
 *  `tokens` session is the only subscription identity. SECRET-SAFE: key names and field
 *  shapes only — credential values are never read out, logged or
 *  persisted. Anything missing/unparsable/contradictory fails closed. */
export type CodexAuthMode = "CHATGPT" | "API_KEY" | "UNAUTHENTICATED" | "AMBIGUOUS";

export function codexAuthMode(env: CodexCliEnv | undefined): CodexAuthMode {
  const home = codexHomeDir(env);
  if (!home) return "UNAUTHENTICATED";
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, "auth.json"), "utf8");
  } catch {
    return "UNAUTHENTICATED";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "AMBIGUOUS";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "AMBIGUOUS";
  }
  const rec = parsed as Record<string, unknown>;
  // ChatGPT OAuth session material — the real codex-rs shape carries
  // access_token + refresh_token strings plus an id_token claim set.
  const tokens = rec.tokens;
  const t = (tokens !== null && typeof tokens === "object" &&
    !Array.isArray(tokens)) ? tokens as Record<string, unknown> : null;
  const tokensValid = t !== null &&
    typeof t.access_token === "string" && t.access_token !== "" &&
    typeof t.refresh_token === "string" && t.refresh_token !== "" &&
    t.id_token != null;

  // AUDIT R3 F1 — codex-rs' persisted resolver gives an explicit
  // auth_mode precedence over credential-shape inference. Accept only
  // "chatgpt" backed by valid OAuth session material; every other
  // explicit mode — including "apikey" — is a non-subscription
  // declaration no matter how valid coexisting tokens look, and a
  // malformed/unknown declaration is unverifiable → fail closed.
  const declared = rec.auth_mode;
  if (typeof declared === "string" && declared.trim() !== "") {
    const m = declared.trim().toLowerCase();
    if (m === "chatgpt") {
      if (tokensValid) return "CHATGPT";
      return tokens == null ? "UNAUTHENTICATED" : "AMBIGUOUS";
    }
    if (m === "apikey") return "API_KEY";
    return "AMBIGUOUS";
  }
  if (declared !== undefined && declared !== null) return "AMBIGUOUS";

  // auth_mode absent — credential-shape inference. A non-empty
  // persisted API key resolves API-key billing inside the CLI even when
  // ambient env keys are absent.
  const storedKey = rec.OPENAI_API_KEY;
  if (typeof storedKey === "string" && storedKey.trim() !== "") return "API_KEY";
  // Contradictory alternative credential families — a persisted PAT or
  // bedrock key set is a DIFFERENT non-subscription authority the CLI
  // can resolve; alongside OAuth tokens the effective mode is
  // unprovable → fail closed, never CHATGPT.
  for (const field of [
    "personal_access_token", "bedrock_api_key", "bedrock_access_keys",
  ]) {
    const v = rec[field];
    if (typeof v === "string" && v.trim() !== "") return "AMBIGUOUS";
    if (Array.isArray(v) ? v.length > 0
        : v !== null && v !== undefined && typeof v === "object" &&
          Object.keys(v as Record<string, unknown>).length > 0) {
      return "AMBIGUOUS";
    }
  }
  if (tokensValid) return "CHATGPT";
  return "AMBIGUOUS";
}

/** True only when the effective autonomous auth mode is a ChatGPT
 *  subscription session — the live, file-backed proof behind
 *  subscription-only invocation. Re-resolved on every call: a
 *  `codex logout` / `login --with-api-key` between admission and
 *  invocation is never trusted from a cached verdict. */
export function codexChatgptSessionProven(
  env: CodexCliEnv | undefined,
): boolean {
  return codexAuthMode(env) === "CHATGPT";
}

export function resolveCodexExecutable(env: CodexCliEnv | undefined): string | null {
  const configured =
    codexCliEnvGet(env, "PAIR_CODEX_PLANNER_EXECUTABLE") ??
    codexCliEnvGet(env, "PAIR_CODEX_EXECUTABLE");
  if (configured) return configured;
  return resolveCodexExecutableSystem(env);
}

/** Platform-native codex discovery with NO env-override reads — the
 *  executor lane's resolution primitive (its own configured seam is
 *  checked by the caller before falling through here). */
export function resolveCodexExecutableSystem(env: CodexCliEnv | undefined): string | null {
  if (process.platform === "win32") {
    return resolveCodexExecutableWin32(env);
  }
  try {
    const resolved = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/** Windows-native codex executable resolution — no `which`, no shell.
 *
 *  Order mirrors Windows command resolution, with the security-critical
 *  preference that a REAL PE image always beats a batch shim:
 *    1. PATHEXT-ordered PATH scan — first `codex<ext>` that exists as a
 *       file wins within a directory; `.exe`/`.com` candidates are
 *       remembered before `.cmd`/`.bat` shims.
 *    2. The native install root — `%LOCALAPPDATA%\OpenAI\Codex\bin\<ver>\
 *       codex.exe` — is scanned so an npm-installed `codex.cmd` shim on
 *       PATH still resolves to its underlying PE image (spawning a
 *       `.cmd` directly is rejected by modern Node without a shell).
 *    3. If only a batch shim exists, it is returned and the caller
 *       launches it through `windowsSpawnTarget`'s COMSPEC wrapper with
 *       a strict argv whitelist — never `shell: true` free-form. */
function resolveCodexExecutableWin32(env: CodexCliEnv | undefined): string | null {
  const isFile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const exts = (
    codexCliEnvGet(env, "PATHEXT") ??
    process.env.PATHEXT ??
    ".COM;.EXE;.BAT;.CMD"
  )
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  let batchCandidate: string | null = null;
  for (const dirEntry of (codexCliEnvGet(env, "PATH") ?? process.env.PATH ?? "").split(path.delimiter)) {
    const dirName = dirEntry.trim();
    if (!dirName) continue;
    for (const ext of exts) {
      const cand = path.join(dirName, `codex${ext}`);
      if (!isFile(cand)) continue;
      if (ext === ".exe" || ext === ".com") return cand;
      batchCandidate ??= cand;
    }
  }
  const localApp = codexCliEnvGet(env, "LOCALAPPDATA") ?? process.env.LOCALAPPDATA;
  if (localApp) {
    const binRoot = path.join(localApp, "OpenAI", "Codex", "bin");
    try {
      const versions = fs.readdirSync(binRoot).sort().reverse();
      for (const v of versions) {
        const cand = path.join(binRoot, v, "codex.exe");
        if (isFile(cand)) return cand;
      }
    } catch {
      /* install root absent — fall through to the batch shim */
    }
  }
  return batchCandidate;
}

const WIN32_BATCH_EXT = new Set([".cmd", ".bat"]);
/** argv fragments a COMSPEC-wrapped launch may carry. The grammar admits
 *  only token characters (paths, `key='value'` config pairs, model ids,
 *  TOML tables): every cmd metacharacter — `& | < > ^ % ! " ( ) [ ] ;`
 *  `$ # ? *` backtick — is rejected, so nothing outside it can ever
 *  reach the `cmd /c` line. `{}` are retained (TOML inline tables in
 *  governed argv) — they are not cmd metacharacters and stay inert
 *  inside the per-token quoting below. */
const WIN32_CMD_ARG_SAFE = /^[A-Za-z0-9_./\\:=,'@+\-~{} ]*$/;

/** Launch target for `spawn`/`execFileSync`: a real `.exe`/`.com` image is
 *  spawned directly (CreateProcess — no shell involvement at all). A
 *  `.cmd`/`.bat` shim can only run through `cmd.exe /d /s /c`, and every
 *  token is additionally wrapped in double quotes so cmd cannot re-parse
 *  metacharacter adjacency — `"` itself is rejected by the grammar so the
 *  quoting cannot be escaped. Returns null when the launch cannot be made
 *  safe — the caller fails closed rather than invoking an unsafe shell. */
export function windowsSpawnTarget(
  command: string,
  args: string[],
): { command: string; args: string[]; verbatim: boolean } | null {
  if (process.platform !== "win32") return { command, args, verbatim: false };
  const base = path.basename(command).toLowerCase();
  const isBatch = WIN32_BATCH_EXT.has(path.extname(base));
  if (!isBatch) {
    // Ambiguous batch-lookalike names ("codex.cmd&calc", "codex.cmd
    // evil", "codex.bat%PATH%") would bypass the extension check and
    // reach CreateProcess as-is — reject rather than classify.
    if (/\.(?:cmd|bat)/.test(base) || !WIN32_CMD_ARG_SAFE.test(base)) {
      return null;
    }
    return { command, args, verbatim: false };
  }
  const comspec = process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
  if (
    !WIN32_CMD_ARG_SAFE.test(command) ||
    args.some((a) => !WIN32_CMD_ARG_SAFE.test(a))
  ) {
    return null;
  }
  // cmd /s strips the first+last quote of the /c string — wrap the whole
  // line in an outer quote pair so every token's own quotes survive. The
  // caller must spawn with windowsVerbatimArguments so Node does not add
  // its own quoting layer on top of this constructed line.
  const line = `"${[command, ...args].map((t) => `"${t}"`).join(" ")}"`;
  return { command: comspec, args: ["/d", "/s", "/c", line], verbatim: true };
}

/** Child env: minimal inherited surface only; CODEX_HOME pins the
 *  persisted ChatGPT session. API-key variables are deliberately absent —
 *  an ambient OPENAI_API_KEY/CODEX_API_KEY in the PAIR parent is never
 *  visible to the reasoning child. Nothing is logged or persisted. */
export function codexCliChildEnv(env: CodexCliEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "PATH", "HOME", "LANG", "LC_ALL", "CODEX_HOME", "NODE_PATH",
    // Windows process essentials — a stripped env leaves the child
    // without SystemRoot (DNS/TLS/CreateProcess internals), a writable
    // Temp, or its own install/config roots under LOCALAPPDATA and
    // USERPROFILE. Each is still whitelist-forwarded, never ambient.
    "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "OS",
    "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME",
    "USERDOMAIN", "APPDATA", "LOCALAPPDATA", "ProgramData", "PUBLIC",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
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
  const target = windowsSpawnTarget(command, args);
  if (!target) {
    return {
      status: "SPAWN_FAILED", code: null, stderrTail: "",
      error: "CODEX_SPAWN_TARGET_UNSAFE",
    };
  }
  let child: ChildProcess;
  try {
    child = spawn(target.command, target.args, {
      cwd: runDir,
      env: codexCliChildEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: target.verbatim,
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
