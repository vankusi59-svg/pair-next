/**
 * PairNativeWorkerRunner — drives one PAIR_WORKER_FILE spec through the
 * existing Automaton LocalWorkerPool + HarnessRegistry + TaskGraph.
 *
 * Canonical identities (worker_execution_id / execution_id / governed_task_id)
 * stay on the PAIR side in spec.json; Automaton goalId/taskId/workerId are
 * recorded as supplemental worker-local identity in worker_child.json.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { HarnessRegistry } from "../agent/harness-registry.js";
import type { WorkerInferenceClient } from "../agent/harness-types.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import { insertGoal, insertTask, updateTaskStatus, getTaskById } from "../state/database.js";
import type { AutomatonConfig, AutomatonIdentity, ComputeClient } from "../types.js";
import { utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import { PAIR_SPEC_ROLE, SpecBoundHarness } from "./spec-harness.js";
import { readWorkerResult, workerFilePaths } from "./worker-protocol.js";
import type { WorkerSpec } from "./worker-protocol.js";

export interface RunnerDeps {
  db: Database.Database;
  config: AutomatonConfig;
  identity: AutomatonIdentity;
  inference: WorkerInferenceClient;
  compute: ComputeClient;
  journalRoot: string;
  /**
   * Outer confinement root: every spec.workspace_root must resolve inside it.
   * Defaults to cwd so governed workspaces under the repo/test root work.
   */
  allowedEditRoot?: string;
}

interface RunnerCallbacks {
  onStarted?: (child: Record<string, unknown>) => void;
  onFinished?: (status: string) => void;
}

interface LiveExecution {
  executionId: string;
  workerId: string;
  taskId: string;
  goalId: string;
  runRoot: string;
  deadlineAt: number;
  done: boolean;
  timer: NodeJS.Timeout;
  status?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

export class PairNativeWorkerRunner {
  private readonly pool: LocalWorkerPool;
  private readonly live = new Map<string, LiveExecution>();

  constructor(private readonly deps: RunnerDeps) {
    const registry = new HarnessRegistry();
    registry.register(PAIR_SPEC_ROLE, SpecBoundHarness);
    this.pool = new LocalWorkerPool({
      db: deps.db,
      inference: deps.inference,
      compute: deps.compute,
      harnessRegistry: registry,
      identity: deps.identity,
      config: deps.config,
      // Spec-bound harness enforces: spec.workspace_root ⊆ allowedEditRoot,
      // and ops are confined to spec.policy.allowed_paths.
      allowedEditRoot: deps.allowedEditRoot ?? process.cwd(),
    });
  }

  journalRootAvailable(): boolean {
    try {
      fs.mkdirSync(this.deps.journalRoot, { recursive: true });
      fs.accessSync(this.deps.journalRoot, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  runRootFor(executionId: string): string {
    return path.join(this.deps.journalRoot, executionId);
  }

  /** Dispatch a validated spec. Async — observe()/collect_result() poll files. */
  start(spec: WorkerSpec, callbacks: RunnerCallbacks = {}): { worker_id: string } {
    const runRoot = this.runRootFor(spec.execution_id);
    const db = this.deps.db;

    // Automaton-side runtime rows (supplemental IDs).
    const goalId = insertGoal(db, {
      title: `[PAIR] ${spec.governed_task_id}`,
      description: `Governed execution ${spec.execution_id} for mission ${spec.mission_id}`,
      status: "active",
    });
    const timeoutMs = spec.limits.timeout_seconds * 1000;
    const taskId = insertTask(db, {
      goalId,
      title: `governed:${spec.governed_task_id}`,
      description: String(spec.task_instruction ?? spec.governed_task_id),
      status: "pending",
      agentRole: PAIR_SPEC_ROLE,
      timeoutMs,
      maxRetries: 0,
      result: null,
    });
    updateTaskStatus(db, taskId, "running");
    const row = getTaskById(db, taskId);
    if (!row) {
      throw new IntegrityError("FAIL_CLOSED_TASKGRAPH_WRITE", taskId);
    }

    SpecBoundHarness.bindings.bind(taskId, { spec });

    const spawned = this.pool.spawn({
      id: taskId,
      parentId: null,
      goalId,
      title: `governed:${spec.governed_task_id}`,
      description: String(spec.task_instruction ?? ""),
      status: "running",
      assignedTo: null,
      agentRole: PAIR_SPEC_ROLE,
      priority: 50,
      dependencies: [],
      result: null,
      metadata: {
        estimatedCostCents: 0,
        actualCostCents: 0,
        maxRetries: 0,
        retryCount: 0,
        timeoutMs,
        createdAt: utcnow(),
        startedAt: utcnow(),
        completedAt: null,
      },
    });

    const exec: LiveExecution = {
      executionId: spec.execution_id,
      workerId: spawned.sandboxId,
      taskId,
      goalId,
      runRoot,
      deadlineAt: Date.now() + timeoutMs,
      done: false,
      timer: setTimeout(() => {
        this.onTimeout(spec.execution_id);
      }, timeoutMs),
    };
    this.live.set(spec.execution_id, exec);

    callbacks.onStarted?.({
      worker_id: spawned.sandboxId,
      worker_address: spawned.address,
      worker_name: spawned.name,
      automaton_task_id: taskId,
      automaton_goal_id: goalId,
      harness_id: PAIR_SPEC_ROLE,
      worker_execution_id: spec.worker_execution_id,
      spawned_at: utcnow(),
      supplemental: true,
    });

    void this.pool
      .waitFor(spawned.sandboxId)
      ?.then(() => this.onWorkerDone(spec.execution_id))
      .catch(() => this.onWorkerDone(spec.execution_id));

    return { worker_id: spawned.sandboxId };
  }

  private onWorkerDone(executionId: string): void {
    const exec = this.live.get(executionId);
    if (!exec) {
      return;
    }
    exec.done = true;
    clearTimeout(exec.timer);
    const result = readWorkerResult(exec.runRoot);
    exec.status = result?.status ?? "UNKNOWN";
  }

  private onTimeout(executionId: string): void {
    const exec = this.live.get(executionId);
    if (!exec || exec.done) {
      return;
    }
    exec.timedOut = true;
    this.pool.cancel(exec.workerId);
    // The harness also detects the deadline between ops; whichever writes
    // result.json first wins. If it never writes, the adapter synthesizes
    // a TIMEOUT failure — never a silent success.
    void this.pool.waitFor(exec.workerId)?.finally(() => {
      exec.done = true;
      const existing = readWorkerResult(exec.runRoot);
      if (!existing || (existing.status !== "TIMEOUT" && existing.status !== "COMPLETED")) {
        if (!existing) {
          this.writeSyntheticResult(exec, "TIMEOUT", "spec timeout_seconds exceeded");
        }
      }
      exec.status = "TIMEOUT";
    });
  }

  private writeSyntheticResult(
    exec: LiveExecution,
    status: "TIMEOUT" | "FAILED" | "CANCELLED",
    detail: string,
  ): void {
    const paths = workerFilePaths(exec.runRoot);
    const specRaw = fs.readFileSync(paths.spec, "utf8");
    const spec = JSON.parse(specRaw) as WorkerSpec;
    const result = {
      schema: "pair.os.executor-expansion.worker-result.v1",
      worker_execution_id: spec.worker_execution_id,
      execution_id: spec.execution_id,
      governed_task_id: spec.governed_task_id,
      mission_id: spec.mission_id,
      task_id: spec.task_id,
      correlation_id: spec.correlation_id,
      worker_kind: spec.worker_kind,
      status,
      output: {},
      summary: detail,
      artifacts: [],
      ops_completed: [],
      completed_at: utcnow(),
      error: { class: status, detail },
      synthesized_by: "PAIR_RUNNER",
    };
    fs.writeFileSync(paths.result, JSON.stringify(result) + "\n", "utf8");
  }

  cancel(executionId: string): boolean {
    const exec = this.live.get(executionId);
    if (!exec || exec.done) {
      return false;
    }
    exec.cancelled = true;
    const cancelled = this.pool.cancel(exec.workerId);
    void this.pool.waitFor(exec.workerId)?.finally(() => {
      exec.done = true;
      if (!readWorkerResult(exec.runRoot)) {
        this.writeSyntheticResult(exec, "CANCELLED", "cancelled by governed requester");
      }
      exec.status = "CANCELLED";
    });
    return cancelled;
  }

  isRunning(executionId: string): boolean {
    const exec = this.live.get(executionId);
    return !!exec && !exec.done;
  }

  isTimedOut(executionId: string): boolean {
    const exec = this.live.get(executionId);
    return !!exec && !exec.done && Date.now() > exec.deadlineAt;
  }

  async shutdown(): Promise<void> {
    for (const exec of this.live.values()) {
      if (!exec.done) {
        this.pool.cancel(exec.workerId);
      }
      clearTimeout(exec.timer);
    }
    await this.pool.shutdown();
  }
}
