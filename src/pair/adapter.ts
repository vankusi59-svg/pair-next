/**
 * ExecutorAdapter contract (donor standalone_core/executor_adapter.py) and
 * the PAIR_NATIVE adapter: the Automaton LocalWorkerPool + Harness runtime
 * exposed through the canonical PAIR executor boundary.
 *
 * PAIR_NATIVE is NOT a provider, NOT a model, NOT a second orchestrator.
 * It reports capability and runtime evidence; it never owns mission state,
 * permission expansion, retries, validation, or completion authority.
 */

import fs from "node:fs";
import { IntegrityError, NotFoundError } from "./errors.js";
import {
  atomicWriteJson,
  sha256File,
  utcnow,
  workerExecutionId,
  pathWithin,
} from "./canonical.js";
import type { PairNativeWorkerRunner } from "./worker-runner.js";
import {
  AUTOMATON_HARNESS_DENIED_OPS,
  AUTOMATON_HARNESS_WORKER_KIND,
  AUTOMATON_HARNESS_OP_CONTRACTS,
  readExecutionJournal,
  readWorkerResult,
  specDigest,
  validateWorkerSpec,
  workerFilePaths,
  WORKER_RESULT_SCHEMA,
  WORKER_SPEC_SCHEMA,
} from "./worker-protocol.js";
import type { WorkerSpec } from "./worker-protocol.js";

export interface ExecutorAdapter {
  readonly executor_id: string;
  probe(): Record<string, unknown>;
  qualify(): Record<string, unknown>;
  capabilities(): Record<string, unknown>;
  prepare_task(task: Record<string, unknown>): Record<string, unknown>;
  dispatch(
    task: Record<string, unknown>,
    context?: Record<string, unknown> | null,
  ): Record<string, unknown>;
  observe(executionId: string): Record<string, unknown>;
  cancel(executionId: string): Record<string, unknown>;
  collect_result(executionId: string): Record<string, unknown>;
  collect_artifacts(executionId: string): Array<Record<string, unknown>>;
  health(): Record<string, unknown>;
  /** Optional: consult run_root evidence for a governed task's dispatch. */
  dispatch_evidence?(governedTaskId: string):
    | { dispatched: boolean; execution_id?: string }
    | undefined;
}

export const PAIR_NATIVE_EXECUTOR_ID = "PAIR_NATIVE";
export const PAIR_NATIVE_CAPABILITIES = [
  "FILE_OPERATIONS",
  "AUTOMATON_TASK_EXECUTION",
] as const;

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

export class PairNativeExecutorAdapter implements ExecutorAdapter {
  readonly executor_id = PAIR_NATIVE_EXECUTOR_ID;
  readonly worker_kind = AUTOMATON_HARNESS_WORKER_KIND;
  private readonly executions = new Map<string, Record<string, unknown>>();

  constructor(private readonly runner: PairNativeWorkerRunner) {}

  probe(): Record<string, unknown> {
    const ok = this.runner.journalRootAvailable();
    return {
      executor_id: this.executor_id,
      available: ok,
      state: ok ? "READY" : "DEGRADED",
      worker_kind: this.worker_kind,
      live_e2e: ok,
    };
  }

  qualify(): Record<string, unknown> {
    const ok = this.runner.journalRootAvailable();
    return {
      executor_id: this.executor_id,
      qualified: ok,
      dispatch_enabled: ok,
      worker_kind: this.worker_kind,
      reasons: ok ? [] : ["JOURNAL_ROOT_UNAVAILABLE"],
    };
  }

  capabilities(): Record<string, unknown> {
    const q = this.qualify();
    return {
      executor_id: this.executor_id,
      capability_ids: [...PAIR_NATIVE_CAPABILITIES],
      qualified: q.qualified,
      dispatch_enabled: q.dispatch_enabled,
      supported_worker_kinds: [this.worker_kind],
      op_contracts: Object.keys(AUTOMATON_HARNESS_OP_CONTRACTS),
      denied_by_default_ops: AUTOMATON_HARNESS_DENIED_OPS,
    };
  }

  health(): Record<string, unknown> {
    const q = this.qualify();
    return {
      executor_id: this.executor_id,
      state: q.qualified ? "READY" : "DEGRADED",
      active_executions: [...this.executions.values()].filter(
        (e) => !TERMINAL_STATES.has(String(e.status)),
      ).length,
      worker_runtime: "LocalWorkerPool",
    };
  }

  private requireFields(task: Record<string, unknown>, fields: string[]): void {
    for (const f of fields) {
      if (task[f] === undefined || task[f] === null || task[f] === "") {
        throw new IntegrityError("FAIL_CLOSED_GOVERNED_TASK_CONTRACT_INCOMPLETE", f);
      }
    }
  }

  /** Worker spec embedded in the governed task's expected_output_contract. */
  private workerSpecFrom(task: Record<string, unknown>): Record<string, unknown> {
    const contract = task.expected_output_contract as
      | Record<string, unknown>
      | undefined;
    const spec = contract?.worker_spec as Record<string, unknown> | undefined;
    if (!spec || typeof spec !== "object") {
      throw new IntegrityError("FAIL_CLOSED_WORKER_SPEC_MISSING", String(task.task_id));
    }
    return spec;
  }

  prepare_task(task: Record<string, unknown>): Record<string, unknown> {
    this.requireFields(task, [
      "governed_task_id",
      "mission_id",
      "task_id",
      "workspace",
      "correlation_id",
      "expected_output_contract",
    ]);
    const q = this.qualify();
    if (!q.qualified) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_UNQUALIFIED", this.executor_id);
    }
    const workerSpec = this.workerSpecFrom(task);
    const previewExecutionId = workerExecutionId(
      this.executor_id,
      String(task.governed_task_id),
    );
    const preview = this.buildSpec(task, previewExecutionId, workerSpec, /*preview*/ true);
    validateWorkerSpec(preview);
    return {
      executor_id: this.executor_id,
      prepared: true,
      worker_kind: this.worker_kind,
      preview_spec_digest: specDigest(preview),
      expected_worker_execution_id: previewExecutionId,
    };
  }

  private buildSpec(
    task: Record<string, unknown>,
    executionId: string,
    workerSpec: Record<string, unknown>,
    preview = false,
  ): WorkerSpec {
    const workspace = String(task.workspace);
    const runRoot = this.runner.runRootFor(executionId);
    const contract = task.expected_output_contract as Record<string, unknown>;
    const ops = (workerSpec.ops ?? contract.worker_ops ?? []) as WorkerSpec["ops"];
    const declaredAllowedPaths =
      (workerSpec.allowed_paths as string[] | undefined) ??
      (task.allowed_paths as string[] | undefined) ??
      [workspace];
    const allowedOps =
      (workerSpec.allowed_ops as string[] | undefined) ??
      Object.keys(AUTOMATON_HARNESS_OP_CONTRACTS).filter(
        (op) => !AUTOMATON_HARNESS_DENIED_OPS.includes(op),
      );
    const limits = (workerSpec.limits as Record<string, unknown> | undefined) ?? {};
    return {
      schema: WORKER_SPEC_SCHEMA,
      worker_kind: this.worker_kind,
      worker_execution_id: executionId,
      execution_id: executionId,
      governed_task_id: String(task.governed_task_id),
      mission_id: String(task.mission_id),
      task_id: String(task.task_id),
      correlation_id: String(task.correlation_id),
      workspace_root: workspace,
      run_root: preview ? "<preview>" : runRoot,
      allowed_paths: declaredAllowedPaths,
      limits: {
        max_ops: Number(limits.max_ops ?? Math.max(ops.length, 8)),
        timeout_seconds: Number(limits.timeout_seconds ?? task.timeout ?? 300),
      },
      policy: {
        workspace_root: workspace,
        allowed_paths: declaredAllowedPaths,
        allowed_ops: allowedOps,
        denied_ops: AUTOMATON_HARNESS_DENIED_OPS,
      },
      ops,
      task_instruction: task.task_instruction,
      permissions: task.permissions ?? [],
      constraints: task.constraints ?? [],
    };
  }

  dispatch(
    task: Record<string, unknown>,
    context?: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const q = this.qualify();
    if (!q.qualified || !q.dispatch_enabled) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTOR_UNQUALIFIED", this.executor_id);
    }
    this.requireFields(task, [
      "governed_task_id",
      "mission_id",
      "task_id",
      "workspace",
      "correlation_id",
      "governance_digest",
    ]);
    if (task.executor_id !== this.executor_id) {
      throw new IntegrityError(
        "FAIL_CLOSED_EXECUTOR_ROUTING_MISMATCH",
        String(task.executor_id),
      );
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
    if (existing) {
      const { result: _omit, ...rec } = existing;
      return rec;
    }
    const runRoot = this.runner.runRootFor(executionId);
    const paths = workerFilePaths(runRoot);
    if (fs.existsSync(paths.executionJournal)) {
      return this.rehydrate(executionId, runRoot);
    }

    const workerSpec = this.workerSpecFrom(task);
    const spec = this.buildSpec(task, executionId, workerSpec);
    validateWorkerSpec(spec);

    fs.mkdirSync(runRoot, { recursive: true });
    atomicWriteJson(paths.spec, spec);
    const journal = {
      schema: "pair.os.executor-expansion.execution-journal.v1",
      execution_id: executionId,
      executor_id: this.executor_id,
      worker_kind: this.worker_kind,
      mission_id: task.mission_id,
      task_id: task.task_id,
      governed_task_id: governedTaskId,
      correlation_id: task.correlation_id,
      workspace,
      run_root: runRoot,
      spec_sha256: specDigest(spec),
      spec_path: paths.spec,
      status: "DISPATCHED",
      created_at: utcnow(),
      op_count: spec.ops.length,
      timeout_seconds: spec.limits.timeout_seconds,
      attempt_id: context?.attempt_id ?? null,
    };
    atomicWriteJson(paths.executionJournal, journal);

    const record: Record<string, unknown> = {
      executor_id: this.executor_id,
      execution_id: executionId,
      mission_id: task.mission_id,
      task_id: task.task_id,
      status: "RUNNING",
      started_at: utcnow(),
      finished_at: null,
      correlation_id: task.correlation_id,
      governed_task_id: governedTaskId,
      workspace,
      run_root: runRoot,
    };
    this.executions.set(executionId, record);
    this.runner.start(spec, {
      onStarted: (child) => {
        atomicWriteJson(paths.workerChild, child);
        journal.status = "RUNNING";
        (journal as Record<string, unknown>).worker_started_at = utcnow();
        atomicWriteJson(paths.executionJournal, journal);
      },
      onFinished: (status) => {
        const rec = this.executions.get(executionId);
        if (rec && rec.status === "RUNNING") {
          rec.status = status;
          rec.finished_at = utcnow();
        }
      },
    });
    return { ...record };
  }

  private rehydrate(executionId: string, runRoot: string): Record<string, unknown> {
    const journal = readExecutionJournal(runRoot);
    if (!journal) {
      throw new IntegrityError("FAIL_CLOSED_EXECUTION_JOURNAL_MISSING", executionId);
    }
    const result = readWorkerResult(runRoot);
    const status = result ? result.status : this.runner.isRunning(executionId) ? "RUNNING" : "UNKNOWN";
    const record: Record<string, unknown> = {
      executor_id: this.executor_id,
      execution_id: executionId,
      mission_id: journal.mission_id,
      task_id: journal.task_id,
      governed_task_id: journal.governed_task_id,
      correlation_id: journal.correlation_id,
      workspace: journal.workspace,
      run_root: runRoot,
      status,
      started_at: journal.worker_started_at ?? journal.created_at,
      finished_at: result ? result.completed_at : null,
      result: result ?? undefined,
      recovered: true,
    };
    this.executions.set(executionId, record);
    const { result: _omit, ...out } = record;
    return out;
  }

  observe(executionId: string): Record<string, unknown> {
    let rec = this.executions.get(executionId);
    if (!rec) {
      const runRoot = this.runner.runRootFor(executionId);
      if (fs.existsSync(workerFilePaths(runRoot).executionJournal)) {
        this.rehydrate(executionId, runRoot);
        rec = this.executions.get(executionId);
      }
    }
    if (!rec) {
      throw new NotFoundError(`execution:${executionId}`);
    }
    if (!TERMINAL_STATES.has(String(rec.status))) {
      const result = readWorkerResult(String(rec.run_root));
      if (result) {
        rec.status = result.status;
        rec.finished_at = result.completed_at;
      } else if (!this.runner.isRunning(executionId)) {
        // Worker gone without result — ambiguous, classify never as success.
        rec.status = "UNKNOWN";
        rec.finished_at = utcnow();
        rec.dead_worker_classification = "WORKER_EXITED_WITHOUT_RESULT";
      } else if (this.runner.isTimedOut(executionId)) {
        this.cancel(executionId);
        rec = this.executions.get(executionId)!;
      }
      if (rec.status === "UNKNOWN") {
        // Persist the ambiguity so it survives restart.
        const paths = workerFilePaths(String(rec.run_root));
        const journal = readExecutionJournal(String(rec.run_root));
        if (journal && journal.status !== "UNKNOWN") {
          journal.status = "UNKNOWN";
          journal.events = [
            ...(journal.events ?? []),
            { at: utcnow(), event: "WORKER_EXITED_WITHOUT_RESULT" },
          ];
          atomicWriteJson(paths.executionJournal, journal);
        }
      }
    }
    const { result: _omit, ...out } = rec;
    return { ...out };
  }

  cancel(executionId: string): Record<string, unknown> {
    const rec = this.executions.get(executionId);
    if (!rec) {
      throw new NotFoundError(`execution:${executionId}`);
    }
    this.runner.cancel(executionId);
    const paths = workerFilePaths(String(rec.run_root));
    const journal = readExecutionJournal(String(rec.run_root));
    if (journal) {
      journal.status = "CANCELLED";
      (journal as Record<string, unknown>).cancelled_at = utcnow();
      atomicWriteJson(paths.executionJournal, journal);
    }
    rec.status = "CANCELLED";
    rec.finished_at = utcnow();
    const { result: _omit, ...out } = rec;
    return { ...out };
  }

  private resultBindingOk(result: Record<string, unknown>, rec: Record<string, unknown>): boolean {
    return (
      result.worker_execution_id === rec.execution_id &&
      result.execution_id === rec.execution_id &&
      result.governed_task_id === rec.governed_task_id &&
      result.mission_id === rec.mission_id &&
      result.task_id === rec.task_id
    );
  }

  collect_result(executionId: string): Record<string, unknown> {
    let rec = this.executions.get(executionId);
    if (!rec) {
      const runRoot = this.runner.runRootFor(executionId);
      if (fs.existsSync(workerFilePaths(runRoot).executionJournal)) {
        this.rehydrate(executionId, runRoot);
        rec = this.executions.get(executionId);
      }
    }
    if (!rec) {
      throw new NotFoundError(`execution:${executionId}`);
    }
    if (rec.result) {
      return rec.result as Record<string, unknown>;
    }
    const runRoot = String(rec.run_root);
    const paths = workerFilePaths(runRoot);
    let result = readWorkerResult(runRoot) as Record<string, unknown> | null;
    if (result && !this.resultBindingOk(result, rec)) {
      throw new IntegrityError("FAIL_CLOSED_WORKER_RESULT_BINDING_MISMATCH", executionId);
    }
    if (!result) {
      if (["DISPATCHED", "RUNNING"].includes(String(rec.status))) {
        this.observe(executionId);
        rec = this.executions.get(executionId)!;
        if (!TERMINAL_STATES.has(String(rec.status)) && rec.status !== "UNKNOWN") {
          throw new IntegrityError("FAIL_CLOSED_EXECUTION_NOT_TERMINAL", executionId);
        }
      }
      // No canonical result.json — never invent success.
      const journal = readExecutionJournal(runRoot);
      const detail =
        rec.dead_worker_classification ?? "RESULT_MISSING_AFTER_TERMINAL";
      result = {
        schema: WORKER_RESULT_SCHEMA,
        status: rec.status === "CANCELLED" ? "CANCELLED" : "FAILED",
        worker_kind: this.worker_kind,
        execution_id: executionId,
        worker_execution_id: executionId,
        mission_id: rec.mission_id ?? journal?.mission_id,
        task_id: rec.task_id ?? journal?.task_id,
        governed_task_id: rec.governed_task_id ?? journal?.governed_task_id,
        correlation_id: rec.correlation_id,
        started_at: rec.started_at ?? journal?.worker_started_at,
        completed_at: utcnow(),
        output: `worker outcome unknown: ${String(detail)}`,
        artifacts: [],
        ops_completed: [],
        retryability: "NON_RETRYABLE",
        structured_errors: [String(detail)],
        error: { class: String(detail), detail: String(detail) },
        synthesized_by: "PAIR_ADAPTER",
        provenance: { producer: this.executor_id, worker_result_missing: true },
      };
    }
    const enriched: Record<string, unknown> = { ...result };
    enriched.executor_id = this.executor_id;
    const safeHash = (p: string) => (fs.existsSync(p) ? sha256File(p) : null);
    enriched.artifact_evidence = {
      journal_sha256: safeHash(paths.workerJournal),
      result_sha256: safeHash(paths.result),
      spec_sha256: readExecutionJournal(runRoot)?.spec_digest ?? readExecutionJournal(runRoot)?.spec_sha256,
      stdout_sha256: safeHash(paths.workerStdout),
      stderr_sha256: safeHash(paths.workerStderr),
      run_root: runRoot,
    };
    enriched.provenance = {
      ...(typeof result.provenance === "object" && result.provenance ? result.provenance : {}),
      producer: this.executor_id,
      worker_kind: this.worker_kind,
      transport: "AUTOMATON_LOCAL_WORKER_POOL",
      spec_sha256: readExecutionJournal(runRoot)?.spec_sha256,
      pair_execution_id: executionId,
    };
    rec.result = enriched;
    if (rec.status === "RUNNING" || rec.status === "UNKNOWN") {
      rec.status = String(result.status ?? "FAILED");
      rec.finished_at = utcnow();
    }
    return enriched;
  }

  collect_artifacts(executionId: string): Array<Record<string, unknown>> {
    const result = this.collect_result(executionId);
    return (result.artifacts as Array<Record<string, unknown>>) ?? [];
  }

  /** Donor seam: does file evidence exist for a governed task's dispatch? */
  dispatch_evidence(governedTaskId: string): {
    dispatched: boolean;
    execution_id?: string;
  } {
    const executionId = workerExecutionId(this.executor_id, governedTaskId);
    const runRoot = this.runner.runRootFor(executionId);
    const journal = readExecutionJournal(runRoot);
    if (!journal) {
      return { dispatched: false };
    }
    return { dispatched: true, execution_id: executionId };
  }
}

export { pathWithin };
