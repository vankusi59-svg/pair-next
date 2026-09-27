/**
 * CodexCliExecutorAdapter — governed Codex executor (NATIVE_CLI /
 * CODEX_CLI_JSONL), the canonical donor "CODEX" identity (codex_cli.py,
 * a557df2). Chosen over codex-acp because the donor's canonical CODEX
 * executor is the CLI transport: `codex exec --json` emits a structured
 * NDJSON event stream — no terminal parsing — and PAIR permission profiles
 * carry the governed boundary.
 *
 * Spawn shape (donor-faithful):
 *   codex exec --ephemeral --skip-git-repo-check --ignore-user-config
 *     --ignore-rules --strict-config --color never
 *     --config approval_policy=never --config web_search=disabled
 *     --config default_permissions=pair_(workspace|read) + profile args
 *     -C <workspace> --output-schema <schema> --output-last-message <final>
 *     --json   (prompt on stdin)
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { IntegrityError } from "./errors.js";
import { atomicWriteJson, digest, sha256File, utcnow, workerExecutionId } from "./canonical.js";
import type { ExecutorAdapter } from "./adapter.js";
import { buildGovernedPrompt, snapshotWorkspace } from "./acp-executor.js";

export const CODEX_EXECUTOR_ID = "CODEX";
export const CODEX_RUNTIME_TYPE = "OPENAI_CODEX_CLI";
export const CODEX_CAPABILITY_IDS = [
  "CODE_GENERATION",
  "CODE_EDITING",
  "FILE_OPERATIONS",
  "SHELL_EXECUTION",
  "REASONING",
  "PYTHON_EXECUTION",
] as const;

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);
const CODEX_JOURNAL_SCHEMA = "pair.os.vnext.codex-execution-journal.v1";

interface CodexExecution {
  execution_id: string;
  governed_task_id: string;
  mission_id?: string;
  task_id?: string;
  correlation_id?: string;
  run_root: string;
  status: string;
  child?: ChildProcess;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
  recovered?: boolean;
}

export function codexRunRoot(journalRoot: string, executionId: string): string {
  return path.join(journalRoot, "codex", executionId);
}

export class CodexCliExecutorAdapter implements ExecutorAdapter {
  readonly executor_id = CODEX_EXECUTOR_ID;
  readonly runtime_type = CODEX_RUNTIME_TYPE;
  readonly invocation_method = "codex exec";

  private readonly executions = new Map<string, CodexExecution>();
  private lastProbe: Record<string, unknown> | null = null;
  private lastQualification: Record<string, unknown> | null = null;

  constructor(
    private readonly deps: {
      journalRoot: string;
      timeoutSeconds?: number;
      /** Executable override (tests point at a fixture; prod resolves `codex`). */
      executable?: string;
      /** Extra argv inserted before `exec` (e.g. fixture wrappers). */
      executableArgs?: string[];
      envReader?: (name: string) => string | undefined;
    },
  ) {}

  private env(name: string): string | undefined {
    return (this.deps.envReader ?? ((n) => process.env[n]))(name);
  }

  private resolveExecutable(): { command: string; prefixArgs: string[] } | null {
    if (this.deps.executable) {
      return {
        command: this.deps.executable,
        prefixArgs: this.deps.executableArgs ?? [],
      };
    }
    try {
      const resolved = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
      return resolved ? { command: resolved, prefixArgs: [] } : null;
    } catch {
      return null;
    }
  }

  probe(): Record<string, unknown> {
    const limitations: string[] = [];
    const exe = this.resolveExecutable();
    const base: Record<string, unknown> = {
      executor_id: this.executor_id,
      runtime_type: this.runtime_type,
      invocation_method: this.invocation_method,
      authority_role: "REPLACEABLE_EXECUTOR_ADAPTER_ONLY",
      capabilities: [],
      limitations,
      authenticated: false,
    };
    if (!exe) {
      this.lastProbe = {
        ...base,
        available: false,
        state: "UNAVAILABLE",
        limitations: ["CODEX_EXECUTABLE_NOT_FOUND"],
      };
      return this.lastProbe;
    }
    let version: string | null = null;
    try {
      version =
        execFileSync(exe.command, [...exe.prefixArgs, "--version"], {
          encoding: "utf8",
          timeout: 10_000,
        }).trim() || null;
    } catch {
      limitations.push("CODEX_VERSION_CHECK_FAILED");
    }
    // Auth presence WITHOUT reading values: env vars or CODEX_HOME session files.
    const credEnv = ["OPENAI_API_KEY", "CODEX_API_KEY"];
    const codexHome = this.env("CODEX_HOME");
    const authFilesExist = Boolean(
      codexHome && fs.existsSync(path.join(codexHome, "auth.json")),
    );
    const authenticated = credEnv.some((n) => Boolean(this.env(n))) || authFilesExist;
    if (!authenticated) limitations.push("CODEX_CREDENTIAL_NOT_RESOLVABLE");
    this.lastProbe = {
      ...base,
      available: true,
      state: "READY",
      codex_version: version,
      codex_home_present: Boolean(codexHome),
      credential_env: credEnv,
      authenticated,
      executable: exe.command,
    };
    return this.lastProbe;
  }

  qualify(): Record<string, unknown> {
    const probe = this.lastProbe ?? this.probe();
    const qualified = probe.available === true && (probe.limitations as string[]).length === 0;
    const result = {
      executor_id: this.executor_id,
      qualified,
      dispatch_enabled: qualified,
      state: qualified ? "QUALIFIED" : "UNQUALIFIED",
      transport: { type: "NATIVE_CLI", qualified },
      reasons: probe.limitations ?? [],
      probe_digest: digest({ probe }),
    };
    this.lastQualification = result;
    return result;
  }

  capabilities(): Record<string, unknown> {
    const q = this.lastQualification ?? this.qualify();
    const ids = q.qualified ? [...CODEX_CAPABILITY_IDS] : [];
    return { executor_id: this.executor_id, capability_ids: ids, capabilities: ids };
  }

  health(): Record<string, unknown> {
    const running = [...this.executions.values()].filter((e) => !TERMINAL.has(e.status));
    const probe = this.lastProbe ?? this.probe();
    return {
      executor_id: this.executor_id,
      state: probe.state ?? "UNAVAILABLE",
      active_executions: running.length,
      last_probe: probe,
    };
  }

  prepare_task(task: Record<string, unknown>): Record<string, unknown> {
    const executionId = workerExecutionId(this.executor_id, String(task.governed_task_id));
    const prompt = buildGovernedPrompt(task);
    return {
      executor_id: this.executor_id,
      prepared: true,
      expected_worker_execution_id: executionId,
      prompt_sha256: digest({ prompt }),
      permission_profile:
        ((task.permissions as string[]) ?? []).includes("WRITE") ||
        ((task.permissions as string[]) ?? []).includes("FILE_WRITE")
          ? "pair_workspace"
          : "pair_read",
    };
  }

  private permissionArgs(task: Record<string, unknown>): string[] {
    const perms = new Set(((task.permissions as string[]) ?? []).map(String));
    const writeAllowed = perms.has("WRITE") || perms.has("FILE_WRITE");
    const profile = writeAllowed ? "pair_workspace" : "pair_read";
    const workspace = path.resolve(String(task.workspace));
    const allowedRoots = ((task.allowed_paths as string[]) ?? [workspace])
      .map((p) => path.resolve(p));
    const grants = allowedRoots
      .filter((r) => r !== workspace)
      .map((r) => `'${r}'='${writeAllowed ? "write" : "read"}'`)
      .join(",");
    const filesystem =
      "{':minimal'='read',':workspace_roots'={'.'='" +
      (writeAllowed ? "write" : "read") +
      "'}" +
      (grants ? "," + grants : "") +
      "}";
    return [
      "--config", `default_permissions=${profile}`,
      "--config", `permissions.${profile}.extends=:workspace`,
      "--config", `permissions.${profile}.filesystem=${filesystem}`,
      "--config", `permissions.${profile}.network.enabled=false`,
      "--config", `permissions.${profile}.workspace_roots.'${workspace}'=true`,
    ];
  }

  dispatch(
    task: Record<string, unknown>,
    context?: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const q = this.qualify();
    if (!q.qualified || !q.dispatch_enabled) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_UNQUALIFIED", this.executor_id);
    }
    for (const f of ["governed_task_id", "mission_id", "task_id", "workspace", "correlation_id", "governance_digest"]) {
      if (task[f] == null) throw new IntegrityError("FAIL_CLOSED_REQUEST_FIELD_MISSING", f);
    }
    if (task.executor_id !== this.executor_id) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_ROUTING_MISMATCH", String(task.executor_id));
    }
    if (task.governance_state !== "DISPATCH_AUTHORIZED" || task.dispatch_enabled !== true) {
      throw new IntegrityError(
        "FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED",
        String(task.governance_state),
      );
    }
    const workspace = String(task.workspace);
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      throw new IntegrityError("FAIL_CLOSED_WORKSPACE_MISSING", workspace);
    }
    const governedTaskId = String(task.governed_task_id);
    const executionId = workerExecutionId(this.executor_id, governedTaskId);
    const existing = this.executions.get(executionId);
    if (existing) return this.recordFor(existing);

    const runRoot = codexRunRoot(this.deps.journalRoot, executionId);
    const journalPath = path.join(runRoot, "execution_journal.json");
    if (fs.existsSync(journalPath)) return this.rehydrate(executionId, runRoot);
    const exe = this.resolveExecutable();
    if (!exe) throw new IntegrityError("FAIL_CLOSED_CODEX_EXECUTABLE_NOT_FOUND", this.executor_id);

    fs.mkdirSync(runRoot, { recursive: true });
    const before = snapshotWorkspace(workspace, runRoot);
    atomicWriteJson(path.join(runRoot, "before_snapshot.json"), before);
    atomicWriteJson(path.join(runRoot, "spec.json"), task);
    const prompt = buildGovernedPrompt(task);
    const schemaPath = path.join(runRoot, "result.schema.json");
    const finalPath = path.join(runRoot, "final.json");
    atomicWriteJson(schemaPath, {
      type: "object",
      properties: {
        status: { type: "string", enum: ["COMPLETED", "FAILED", "CANCELLED"] },
        summary: { type: "string" },
        artifacts: { type: "array", items: { type: "object", properties: { path: { type: "string" } } } },
      },
      required: ["status"],
    });
    const args = [
      ...exe.prefixArgs,
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--color", "never",
      "--config", "approval_policy=never",
      "--config", "web_search=disabled",
      ...this.permissionArgs(task),
      "-C", workspace,
      "--output-schema", schemaPath,
      "--output-last-message", finalPath,
      "--json",
    ];
    const journal: Record<string, unknown> = {
      schema: CODEX_JOURNAL_SCHEMA,
      execution_id: executionId,
      executor_id: this.executor_id,
      runtime_type: this.runtime_type,
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: governedTaskId,
      correlation_id: task.correlation_id,
      workspace,
      run_root: runRoot,
      argv_sha256: digest({ argv: [exe.command, ...args] }),
      prompt_sha256: digest({ prompt }),
      status: "DISPATCHED",
      created_at: utcnow(),
      attempt_id: context?.attempt_id ?? null,
    };
    atomicWriteJson(journalPath, journal);

    const rec: CodexExecution = {
      execution_id: executionId,
      governed_task_id: governedTaskId,
      mission_id: String(task.mission_id),
      task_id: String(task.task_id),
      correlation_id: String(task.correlation_id),
      run_root: runRoot,
      status: "RUNNING",
      started_at: utcnow(),
    };
    this.executions.set(executionId, rec);
    void this.runProcess(rec, task, exe.command, args, prompt, before).catch(() => undefined);
    return this.recordFor(rec);
  }

  private recordFor(rec: CodexExecution): Record<string, unknown> {
    return {
      executor_id: this.executor_id,
      execution_id: rec.execution_id,
      governed_task_id: rec.governed_task_id,
      run_root: rec.run_root,
      status: rec.status,
      started_at: rec.started_at,
      finished_at: rec.finished_at ?? null,
      recovered: rec.recovered === true,
    };
  }

  private async runProcess(
    rec: CodexExecution,
    task: Record<string, unknown>,
    command: string,
    args: string[],
    prompt: string,
    before: Record<string, unknown>,
  ): Promise<void> {
    const runRoot = rec.run_root;
    const transcriptPath = path.join(runRoot, "stdout.jsonl");
    const journalPath = path.join(runRoot, "execution_journal.json");
    const timeoutMs = Number(task.timeout ?? this.deps.timeoutSeconds ?? 300) * 1000;
    const events: string[] = [];
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: String(task.workspace),
        env: this.childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.finish(rec, task, before, "FAILED", `CODEX_SPAWN_FAILED:${(error as Error).message}`);
      return;
    }
    rec.child = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      events.push(line);
      fs.appendFileSync(transcriptPath, line + "\n");
    });
    child.stderr?.on("data", (d) => fs.appendFileSync(path.join(runRoot, "stderr.txt"), d));
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* noop */
    }
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    journal.status = "RUNNING";
    journal.pid = child.pid;
    journal.started_at = utcnow();
    atomicWriteJson(journalPath, journal);

    const outcome = await new Promise<{ status: string; error: string | null }>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
        resolve({ status: "TIMEOUT", error: "CODEX_TIMEOUT" });
      }, timeoutMs);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (rec.status === "CANCELLED") {
          resolve({ status: "CANCELLED", error: "CANCELLED" });
        } else if (signal === "SIGKILL" && !fs.existsSync(path.join(runRoot, "final.json"))) {
          resolve({ status: "TIMEOUT", error: "CODEX_TIMEOUT" });
        } else if (code === 0) {
          resolve({ status: "COMPLETED", error: null });
        } else {
          resolve({ status: "FAILED", error: `CODEX_EXIT_${code ?? signal}` });
        }
      });
    });
    this.finish(rec, task, before, outcome.status, outcome.error);
  }

  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "CODEX_HOME", "NODE_PATH"]) {
      const v = this.env(k);
      if (v) env[k] = v;
    }
    // Donor parity: resolved credentials are pinned into the child env, never
    // recorded into evidence.
    for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY"]) {
      const v = this.env(k);
      if (v) env[k] = v;
    }
    return env;
  }

  private finish(
    rec: CodexExecution,
    task: Record<string, unknown>,
    before: Record<string, unknown>,
    status: string,
    errorCode: string | null,
  ): void {
    const runRoot = rec.run_root;
    const workspace = String(task.workspace);
    const after = snapshotWorkspace(workspace, runRoot);
    atomicWriteJson(path.join(runRoot, "after_snapshot.json"), after);
    const artifacts = Object.keys(after)
      .filter((rel) => {
        const prev = before[rel] as { sha256?: string } | undefined;
        return !prev || prev.sha256 !== (after[rel] as { sha256: string }).sha256;
      })
      .map((rel) => ({
        path: rel,
        absolute_path: path.join(workspace, rel),
        sha256: (after[rel] as { sha256: string }).sha256,
        byte_size: (after[rel] as { byte_size: number }).byte_size,
        provenance: this.runtime_type,
      }));
    let summary = `codex ${status.toLowerCase()}`;
    const finalPath = path.join(runRoot, "final.json");
    if (fs.existsSync(finalPath)) {
      try {
        const final = JSON.parse(fs.readFileSync(finalPath, "utf8"));
        if (final.summary) summary = String(final.summary);
        if (final.status === "FAILED" && status === "COMPLETED") {
          status = "FAILED";
          errorCode = "CODEX_AGENT_REPORTED_FAILURE";
        }
      } catch {
        /* malformed final.json — keep process-derived status */
      }
    }
    atomicWriteJson(path.join(runRoot, "result.json"), {
      schema: "pair.os.vnext.execution-result.v1",
      executor_id: this.executor_id,
      execution_id: rec.execution_id,
      governed_task_id: rec.governed_task_id,
      mission_id: rec.mission_id,
      task_id: rec.task_id,
      correlation_id: rec.correlation_id,
      status,
      error: errorCode ? { class: errorCode, message: errorCode } : null,
      summary,
      artifacts,
      started_at: rec.started_at,
      completed_at: utcnow(),
    });
    rec.status = status;
    rec.finished_at = utcnow();
    rec.error = errorCode;
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(runRoot, "execution_journal.json"), "utf8"));
      journal.status = status;
      journal.finished_at = rec.finished_at;
      journal.error = errorCode;
      atomicWriteJson(path.join(runRoot, "execution_journal.json"), journal);
    } catch {
      /* noop */
    }
  }

  observe(executionId: string): Record<string, unknown> {
    const rec = this.executions.get(executionId) ?? this.rehydrateRecord(executionId);
    return {
      executor_id: this.executor_id,
      execution_id: executionId,
      status: rec?.status ?? "UNKNOWN",
      process_alive: rec?.child != null && rec.child.exitCode === null,
      run_root: rec?.run_root ?? null,
    };
  }

  private rehydrateRecord(executionId: string): CodexExecution | null {
    const runRoot = codexRunRoot(this.deps.journalRoot, executionId);
    const journalPath = path.join(runRoot, "execution_journal.json");
    if (!fs.existsSync(journalPath)) return null;
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const resultPath = path.join(runRoot, "result.json");
    let status = String(journal.status ?? "UNKNOWN");
    if (fs.existsSync(resultPath)) {
      status = String(JSON.parse(fs.readFileSync(resultPath, "utf8")).status);
    } else if (!TERMINAL.has(status)) {
      status = "UNKNOWN"; // process gone; side-effect state ambiguous
    }
    const rec: CodexExecution = {
      execution_id: executionId,
      governed_task_id: String(journal.governed_task_id),
      mission_id: String(journal.mission_id),
      task_id: String(journal.task_id),
      correlation_id: String(journal.correlation_id),
      run_root: runRoot,
      status,
      started_at: journal.started_at ?? journal.created_at,
      finished_at: journal.finished_at ?? null,
      error: journal.error ?? null,
      recovered: true,
    };
    this.executions.set(executionId, rec);
    return rec;
  }

  private rehydrate(executionId: string, runRoot: string): Record<string, unknown> {
    const rec = this.rehydrateRecord(executionId);
    return this.recordFor(rec!);
  }

  cancel(executionId: string): Record<string, unknown> {
    const rec = this.executions.get(executionId) ?? this.rehydrateRecord(executionId);
    if (!rec) throw new IntegrityError("FAIL_CLOSED_EXECUTION_NOT_FOUND", executionId);
    if (TERMINAL.has(rec.status)) return this.recordFor(rec);
    rec.status = "CANCELLED";
    try {
      rec.child?.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (rec.child && rec.child.exitCode === null) rec.child.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }, 2000).unref();
    } catch {
      /* noop */
    }
    rec.finished_at = utcnow();
    return this.recordFor(rec);
  }

  collect_result(executionId: string): Record<string, unknown> {
    const rec = this.executions.get(executionId) ?? this.rehydrateRecord(executionId);
    if (!rec) throw new IntegrityError("FAIL_CLOSED_EXECUTION_NOT_FOUND", executionId);
    const resultPath = path.join(rec.run_root, "result.json");
    if (!fs.existsSync(resultPath)) {
      if (["DISPATCHED", "RUNNING", "UNKNOWN"].includes(rec.status)) {
        throw new IntegrityError("FAIL_CLOSED_EXECUTION_NOT_TERMINAL", executionId);
      }
      return {
        schema: "pair.os.vnext.execution-result.v1",
        executor_id: this.executor_id,
        execution_id: executionId,
        governed_task_id: rec.governed_task_id,
        mission_id: rec.mission_id,
        task_id: rec.task_id,
        correlation_id: rec.correlation_id,
        status: rec.status === "CANCELLED" ? "CANCELLED" : "FAILED",
        error: { class: rec.error ?? "RESULT_MISSING_AFTER_TERMINAL" },
        summary: "result missing after terminal state",
        artifacts: [],
        completed_at: rec.finished_at ?? utcnow(),
      };
    }
    return JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  }

  collect_artifacts(executionId: string): Array<Record<string, unknown>> {
    const result = this.collect_result(executionId);
    return (result.artifacts as Array<Record<string, unknown>>) ?? [];
  }

  dispatch_evidence(governedTaskId: string): { dispatched: boolean; execution_id?: string } {
    const executionId = workerExecutionId(this.executor_id, governedTaskId);
    if (fs.existsSync(path.join(codexRunRoot(this.deps.journalRoot, executionId), "execution_journal.json"))) {
      return { dispatched: true, execution_id: executionId };
    }
    return this.executions.has(executionId)
      ? { dispatched: true, execution_id: executionId }
      : { dispatched: false };
  }
}
