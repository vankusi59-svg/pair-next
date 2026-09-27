/**
 * AcpExecutorAdapterBase — TypeScript port of donor acp_base.py (a557df2).
 *
 * Provider-neutral governed ACP executor: frozen ExecutorAdapter lifecycle,
 * canonical PAIR execution identity, durable run_root journal + session /
 * permission / update evidence, workspace before/after snapshots feeding
 * artifact provenance, permission-brokered tool calls, negotiated-resume
 * probe, and idempotent re-dispatch. Concrete providers (DSH, Codex-ACP)
 * supply only identity + launch + provider probe hooks.
 */

import fs from "node:fs";
import path from "node:path";
import { IntegrityError } from "./errors.js";
import {
  atomicWriteJson,
  digest,
  sha256File,
  utcnow,
  workerExecutionId,
} from "./canonical.js";
import type { ExecutorAdapter } from "./adapter.js";
import { AcpProcess, resumeMechanism, sessionFeatures, type AcpLaunch } from "./acp-transport.js";
import { AcpPermissionBroker } from "./acp-permissions.js";

export const ACP_JOURNAL_SCHEMA = "pair.os.vnext.acp-execution-journal.v1";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

interface ExecutionRecord {
  execution_id: string;
  governed_task_id: string;
  mission_id?: string;
  task_id?: string;
  correlation_id?: string;
  run_root: string;
  status: string;
  proc?: AcpProcess;
  session_id?: string;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
  /** true when this record was rebuilt from on-disk journal (not a live spawn). */
  recovered?: boolean;
}

export function acpRunRoot(journalRoot: string, executionId: string): string {
  return path.join(journalRoot, "acp", executionId);
}

/** Recursive workspace snapshot: relpath → {sha256, size}. Run-root excluded. */
export function snapshotWorkspace(root: string, exclude?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const skip = exclude ? path.resolve(exclude) : null;
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (skip && (p === skip || p.startsWith(skip + path.sep))) continue;
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        out[path.relative(root, p)] = { sha256: sha256File(p), byte_size: fs.statSync(p).size };
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

export function buildGovernedPrompt(task: Record<string, unknown>): string {
  const allowed = ((task.allowed_paths as string[]) ?? [])
    .map((p) => `- ${p}`)
    .join("\n");
  const constraints = ((task.constraints as string[]) ?? [])
    .map((c) => `- ${c}`)
    .join("\n");
  const deps = (task.dependency_outputs as unknown[]) ?? [];
  const depBlock = deps.length
    ? "DEPENDENCY TASK OUTPUTS — already collected by upstream governed executors. Use verbatim:\n" +
      JSON.stringify(deps, null, 1) +
      "\n\n"
    : "";
  return (
    "PAIR OS GOVERNED SOFTWARE TASK. You are a replaceable executor, not mission authority.\n" +
    `Mission ID: ${task.mission_id}\nTask ID: ${task.task_id}\nPlan revision: ${task.plan_revision ?? ""}\n` +
    `Correlation ID: ${task.correlation_id}\n` +
    `Task instruction: ${task.task_instruction}\n\n` +
    depBlock +
    "HARD WORKSPACE BOUNDARY:\n" +
    `- workspace: ${task.workspace}\n- allowed paths:\n${allowed}\n` +
    "Never access or modify a path outside the workspace/allowed paths. Never read credential stores or dump secrets.\n" +
    "Do not expand permissions, enable networking, deploy, publish, change credentials, or modify PAIR authority/policy.\n" +
    `PAIR constraints:\n${constraints}\n\n` +
    "Perform only the bounded task. Return the final response ONLY as JSON: " +
    '{"status":"COMPLETED"|"FAILED","summary":"...","artifacts":[{"path":relative_path}]}'
  );
}

export abstract class AcpExecutorAdapterBase implements ExecutorAdapter {
  abstract readonly executor_id: string;
  abstract readonly runtime_type: string;
  readonly invocation_method: string = "acp stdio json-rpc";
  protected readonly capability_ids: string[] = [];

  private readonly executions = new Map<string, ExecutionRecord>();
  private lastProbe: Record<string, unknown> | null = null;
  private lastQualification: Record<string, unknown> | null = null;

  constructor(
    protected readonly deps: {
      journalRoot: string;
      timeoutSeconds?: number;
      /** Test/extension seam: force a launch descriptor (e.g. fixture agent). */
      launchOverride?: AcpLaunch | null;
      /** Restrict env vars passed to provider probe for credential checks. */
      envReader?: (name: string) => string | undefined;
    },
  ) {}

  /* ------------------------------------------------ provider hooks ----- */
  /** Resolve the launch descriptor, or null when the runtime is absent. */
  protected abstract resolveLaunch(): AcpLaunch | null;
  /** Minimal provider env pins — never the full process env. */
  protected providerEnv(): Record<string, string> {
    return {};
  }
  /** Provider-specific probe fields (version, model route, auth presence). */
  protected providerProbe(launch: AcpLaunch, limitations: string[]): Record<string, unknown> {
    void launch;
    void limitations;
    return {};
  }
  /** Post-session/new provider pinning (model route, mode, config options). */
  protected async postSessionSetup(
    proc: AcpProcess,
    sessionId: string,
    session: Record<string, unknown>,
    features: Record<string, unknown>,
    task: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    void proc;
    void sessionId;
    void session;
    void features;
    void task;
    return {};
  }
  /** Required env var names for auth — presence only, values never read into evidence. */
  protected credentialEnvNames(): string[] {
    return [];
  }

  private env(name: string): string | undefined {
    return (this.deps.envReader ?? ((n) => process.env[n]))(name);
  }

  /* ----------------------------------------------------------- probe --- */
  probe(): Record<string, unknown> {
    const limitations: string[] = [];
    const launch = this.deps.launchOverride ?? this.resolveLaunch();
    const base: Record<string, unknown> = {
      executor_id: this.executor_id,
      runtime_type: this.runtime_type,
      invocation_method: this.invocation_method,
      authority_role: "REPLACEABLE_EXECUTOR_ADAPTER_ONLY",
      capabilities: [],
      session_features: {},
      authenticated: false,
      credential_env: this.credentialEnvNames(),
      limitations,
    };
    if (!launch) {
      Object.assign(base, {
        available: false,
        state: "UNAVAILABLE",
        limitations: [...limitations, "EXECUTABLE_NOT_FOUND"],
      });
      this.lastProbe = base;
      return base;
    }
    const creds = this.credentialEnvNames();
    const authenticated = creds.length === 0 || creds.some((n) => Boolean(this.env(n)));
    if (!authenticated) limitations.push("CREDENTIAL_NOT_RESOLVABLE");
    Object.assign(base, this.providerProbe(launch, limitations), {
      available: true,
      state: "READY",
      launch: { command: launch.command, args: launch.args, evidence: launch.evidence },
      authenticated,
    });
    this.lastProbe = base;
    return base;
  }

  qualify(): Record<string, unknown> {
    const probe = this.lastProbe ?? this.probe();
    const qualified = probe.available === true && (probe.limitations as string[]).length === 0;
    const result = {
      executor_id: this.executor_id,
      qualified,
      dispatch_enabled: qualified,
      state: qualified ? "QUALIFIED" : "UNQUALIFIED",
      transport: { type: "ACP_STDIO", qualified },
      reasons: (probe.limitations as string[]) ?? [],
      probe_digest: digest({ probe }),
    };
    this.lastQualification = result;
    return result;
  }

  capabilities(): Record<string, unknown> {
    const q = this.lastQualification ?? this.qualify();
    const ids = q.qualified ? [...this.capability_ids] : [];
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
      permission_envelope: {
        workspace: task.workspace,
        allowed_paths: task.allowed_paths ?? [],
        permissions: task.permissions ?? [],
        constraints: task.constraints ?? [],
      },
    };
  }

  /* --------------------------------------------------------- dispatch -- */
  dispatch(
    task: Record<string, unknown>,
    context?: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const q = this.qualify();
    if (!q.qualified || !q.dispatch_enabled) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_UNQUALIFIED", this.executor_id);
    }
    for (const f of [
      "governed_task_id",
      "mission_id",
      "task_id",
      "workspace",
      "correlation_id",
      "governance_digest",
    ]) {
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

    const runRoot = acpRunRoot(this.deps.journalRoot, executionId);
    const journalPath = path.join(runRoot, "execution_journal.json");
    if (fs.existsSync(journalPath)) return this.rehydrate(executionId, runRoot);

    const launch = this.deps.launchOverride ?? this.resolveLaunch();
    if (!launch) {
      throw new IntegrityError("FAIL_CLOSED_ACP_LAUNCH_UNRESOLVED", this.executor_id);
    }

    fs.mkdirSync(runRoot, { recursive: true });
    const before = snapshotWorkspace(workspace, runRoot);
    atomicWriteJson(path.join(runRoot, "before_snapshot.json"), before);
    atomicWriteJson(path.join(runRoot, "spec.json"), task);
    const prompt = buildGovernedPrompt(task);
    const journal: Record<string, unknown> = {
      schema: ACP_JOURNAL_SCHEMA,
      execution_id: executionId,
      executor_id: this.executor_id,
      runtime_type: this.runtime_type,
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: governedTaskId,
      correlation_id: task.correlation_id,
      workspace,
      run_root: runRoot,
      prompt_sha256: digest({ prompt }),
      spec_sha256: digest(task),
      status: "DISPATCHED",
      created_at: utcnow(),
      acp_session_id: null, // supplemental only — never identity
      attempt_id: context?.attempt_id ?? null,
    };
    atomicWriteJson(journalPath, journal);

    const record: ExecutionRecord = {
      execution_id: executionId,
      governed_task_id: governedTaskId,
      mission_id: String(task.mission_id),
      task_id: String(task.task_id),
      correlation_id: String(task.correlation_id),
      run_root: runRoot,
      status: "RUNNING",
      started_at: utcnow(),
    };
    this.executions.set(executionId, record);
    void this.runSession(record, task, launch, prompt, before).catch(() => undefined);
    return this.recordFor(record);
  }

  private recordFor(rec: ExecutionRecord): Record<string, unknown> {
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

  private async runSession(
    rec: ExecutionRecord,
    task: Record<string, unknown>,
    launch: AcpLaunch,
    prompt: string,
    before: Record<string, unknown>,
  ): Promise<void> {
    const runRoot = rec.run_root;
    const updatesLog = path.join(runRoot, "session_updates.jsonl");
    const decisionsLog = path.join(runRoot, "permission_decisions.jsonl");
    const journalPath = path.join(runRoot, "execution_journal.json");
    const broker = new AcpPermissionBroker({
      workspace: task.workspace,
      allowed_paths: task.allowed_paths ?? [],
      permissions: task.permissions ?? [],
      requested_tools: task.requested_tools ?? [],
      constraints: task.constraints ?? [],
    });
    const proc = new AcpProcess(launch, this.providerEnv());
    rec.proc = proc;
    try {
      await proc.start(
        (_sessionId, toolCall, options, meta) => {
          const d = broker.decide(toolCall, options, meta);
          fs.appendFileSync(decisionsLog, JSON.stringify({ ts: utcnow(), ...d.decision, tool_call_kind: toolCall.kind }) + "\n");
          return d.outcome;
        },
        (sessionId, update) => {
          fs.appendFileSync(updatesLog, JSON.stringify({ ts: utcnow(), session_id: sessionId, update }) + "\n");
        },
      );
      const init = await proc.initialize(30);
      const features = sessionFeatures(init);
      const session = await proc.newSession(String(task.workspace), 60);
      const sessionId = String(session.sessionId ?? session.session_id ?? "");
      rec.session_id = sessionId;
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      journal.status = "RUNNING";
      journal.acp_session_id = sessionId;
      journal.agent_info = features.agent_info;
      journal.session_features = { ...features, raw_capabilities: undefined };
      journal.resume_mechanism = resumeMechanism(features);
      journal.started_at = utcnow();
      atomicWriteJson(journalPath, journal);
      const setup = await this.postSessionSetup(proc, sessionId, session, features, task);
      if (Object.keys(setup).length) {
        journal.post_session_setup = setup;
        atomicWriteJson(journalPath, journal);
      }
      const timeout = Number(task.timeout ?? this.deps.timeoutSeconds ?? 300);
      const promptResp = await proc.prompt(sessionId, prompt, timeout);
      const stopReason = String(promptResp.stopReason ?? promptResp.stop_reason ?? "end_turn");
      this.finish(rec, task, before, stopReason === "cancelled" ? "CANCELLED" : "COMPLETED", null);
    } catch (error) {
      const code = (error as { code?: string }).code ?? String(error);
      const status = code === "ACP_REQUEST_TIMEOUT" ? "TIMEOUT" : "FAILED";
      this.finish(rec, task, before, status, code);
    } finally {
      proc.close();
    }
  }

  private finish(
    rec: ExecutionRecord,
    task: Record<string, unknown>,
    before: Record<string, unknown>,
    status: string,
    errorCode: string | null,
  ): void {
    const runRoot = rec.run_root;
    const after = snapshotWorkspace(String(task.workspace), runRoot);
    atomicWriteJson(path.join(runRoot, "after_snapshot.json"), after);
    // Artifacts = files created or changed inside the governed workspace.
    const artifacts = Object.keys(after)
      .filter((rel) => {
        const prev = before[rel] as { sha256?: string } | undefined;
        return !prev || prev.sha256 !== (after[rel] as { sha256: string }).sha256;
      })
      .map((rel) => {
        const full = path.join(String(task.workspace), rel);
        return {
          path: rel,
          absolute_path: full,
          sha256: (after[rel] as { sha256: string }).sha256,
          byte_size: (after[rel] as { byte_size: number }).byte_size,
          provenance: this.runtime_type,
        };
      });
    const result = {
      schema: "pair.os.vnext.execution-result.v1",
      executor_id: this.executor_id,
      execution_id: rec.execution_id,
      governed_task_id: rec.governed_task_id,
      mission_id: rec.mission_id,
      task_id: rec.task_id,
      correlation_id: rec.correlation_id,
      status,
      error: errorCode ? { class: errorCode, message: errorCode } : null,
      summary: status === "COMPLETED" ? "acp session completed" : `acp ${status.toLowerCase()}`,
      artifacts,
      started_at: rec.started_at,
      completed_at: utcnow(),
    };
    atomicWriteJson(path.join(runRoot, "result.json"), result);
    rec.status = status;
    rec.finished_at = utcnow();
    rec.error = errorCode;
    const journalPath = path.join(runRoot, "execution_journal.json");
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      journal.status = status;
      journal.finished_at = rec.finished_at;
      journal.error = errorCode;
      atomicWriteJson(journalPath, journal);
    } catch {
      /* noop */
    }
  }

  /* -------------------------------------------------------- observe ---- */
  observe(executionId: string): Record<string, unknown> {
    const rec = this.executions.get(executionId) ?? this.rehydrateRecord(executionId);
    return {
      executor_id: this.executor_id,
      execution_id: executionId,
      status: rec?.status ?? "UNKNOWN",
      session_alive: rec?.proc?.processAlive ?? false,
      run_root: rec?.run_root ?? null,
    };
  }

  private rehydrateRecord(executionId: string): ExecutionRecord | null {
    const runRoot = acpRunRoot(this.deps.journalRoot, executionId);
    const journalPath = path.join(runRoot, "execution_journal.json");
    if (!fs.existsSync(journalPath)) return null;
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const resultPath = path.join(runRoot, "result.json");
    let status = String(journal.status ?? "UNKNOWN");
    if (fs.existsSync(resultPath)) {
      status = String(JSON.parse(fs.readFileSync(resultPath, "utf8")).status);
    } else if (!TERMINAL.has(status)) {
      status = "UNKNOWN"; // process is gone; side-effect state ambiguous
    }
    const rec: ExecutionRecord = {
      execution_id: executionId,
      governed_task_id: String(journal.governed_task_id),
      mission_id: String(journal.mission_id),
      task_id: String(journal.task_id),
      correlation_id: String(journal.correlation_id),
      run_root: runRoot,
      status,
      session_id: journal.acp_session_id ?? undefined,
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
    const proc = rec.proc;
    rec.status = "CANCELLED";
    if (proc && rec.session_id) {
      void proc
        .cancelSession(rec.session_id, 15)
        .catch(() => undefined)
        .finally(() => proc.close());
    } else {
      proc?.close();
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
      // No canonical result — never invent success.
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
    const journalPath = path.join(
      acpRunRoot(this.deps.journalRoot, executionId),
      "execution_journal.json",
    );
    if (fs.existsSync(journalPath)) return { dispatched: true, execution_id: executionId };
    const rec = this.executions.get(executionId);
    return rec ? { dispatched: true, execution_id: executionId } : { dispatched: false };
  }
}
