/**
 * Spec-bound harness: an Automaton harness that executes a PAIR_WORKER_FILE
 * spec's declared ops deterministically — no inference, no tool selection.
 * The spec IS the program; the harness is the confined executor.
 *
 * Runs inside LocalWorkerPool like every other Automaton worker (role
 * "pair_native_spec" via HarnessRegistry); worker-local identity is
 * supplemental — canonical IDs stay on the PAIR side (spec.json).
 */

import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { BaseHarness } from "../agent/harnesses/base-harness.js";
import type { HarnessTool } from "../agent/harness-types.js";
import type { TaskResult } from "../orchestration/task-graph.js";
import { appendJsonl, canonicalJson, digest, pathWithin, sha256File, utcnow } from "./canonical.js";
import { IntegrityError } from "./errors.js";
import {
  AUTOMATON_HARNESS_DENIED_OPS,
  AUTOMATON_HARNESS_WORKER_KIND,
  workerFilePaths,
  WORKER_RESULT_SCHEMA,
} from "./worker-protocol.js";
import type { WorkerSpec } from "./worker-protocol.js";

export const PAIR_SPEC_ROLE = "pair_native_spec";

export interface SpecBinding {
  spec: WorkerSpec;
}

/**
 * taskId → spec binding. Registered by the runner before spawn; read by the
 * harness at initialize() so worker identity stays runtime-local while the
 * canonical spec travels through PAIR_WORKER_FILE.
 */
export class SpecBindingRegistry {
  private readonly bindings = new Map<string, SpecBinding>();

  bind(taskId: string, binding: SpecBinding): void {
    this.bindings.set(taskId, binding);
  }

  unbind(taskId: string): void {
    this.bindings.delete(taskId);
  }

  get(taskId: string): SpecBinding | null {
    return this.bindings.get(taskId) ?? null;
  }
}

interface OpOutcome {
  index: number;
  op: string;
  args_digest: string;
  status: "COMPLETED" | "FAILED";
  detail?: string;
}

export class SpecBoundHarness extends BaseHarness {
  readonly id = "pair_native_spec";
  readonly description =
    "PAIR_WORKER_FILE spec-bound executor: runs declared ops deterministically inside workspace policy.";
  static bindings = new SpecBindingRegistry();

  private binding!: SpecBinding;
  private journalSeq = 0;
  private opsCompleted: OpOutcome[] = [];
  private finishResult: Record<string, unknown> | null = null;
  private lastReadOutput = "";

  get spec(): WorkerSpec {
    return this.binding.spec;
  }

  private journal(event: string, fields: Record<string, unknown> = {}): void {
    const paths = workerFilePaths(this.spec.run_root);
    appendJsonl(paths.workerJournal, {
      seq: this.journalSeq++,
      at: utcnow(),
      event,
      worker_execution_id: this.spec.worker_execution_id,
      governed_task_id: this.spec.governed_task_id,
      ...fields,
    });
  }

  override async initialize(
    task: Parameters<BaseHarness["initialize"]>[0],
    context: Parameters<BaseHarness["initialize"]>[1],
  ): Promise<void> {
    const binding = SpecBoundHarness.bindings.get(task.id);
    if (!binding) {
      throw new IntegrityError("FAIL_CLOSED_SPEC_BINDING_MISSING", task.id);
    }
    this.binding = binding;
    // Confinement: the spec workspace must sit inside the pool's
    // allowedEditRoot (the governed sandbox root); ops are confined further
    // to policy.allowed_paths inside resolveOpPath.
    if (!pathWithin(this.spec.workspace_root, context.allowedEditRoot)) {
      throw new IntegrityError(
        "FAIL_CLOSED_SPEC_WORKSPACE_BINDING",
        `${this.spec.workspace_root} outside ${context.allowedEditRoot}`,
      );
    }
    await super.initialize(task, context);
    this.journal("worker_started", {
      task_runtime_id: task.id,
      spec_digest: digest(this.spec),
      op_count: this.spec.ops.length,
    });
  }

  getToolDefs(): HarnessTool[] {
    // Spec-bound harnesses expose no model-callable tools: the spec is fixed.
    return [];
  }

  buildSystemPrompt(): string {
    return "PAIR_WORKER_FILE spec-bound executor (no interactive prompt).";
  }

  buildTaskPrompt(): string {
    return String(this.spec.task_instruction ?? "");
  }

  /** Resolve a spec path arg: must land inside policy.allowed_paths. */
  private resolveOpPath(raw: string): string {
    if (path.isAbsolute(raw) || raw.includes("..")) {
      const resolved = path.resolve(this.spec.workspace_root, raw);
      const ok = this.spec.policy.allowed_paths.some((ap) => pathWithin(resolved, ap));
      if (!ok) {
        throw new IntegrityError("FAIL_CLOSED_OP_PATH_OUT_OF_SCOPE", raw);
      }
      return resolved;
    }
    const resolved = path.resolve(this.spec.workspace_root, raw);
    const ok = this.spec.policy.allowed_paths.some((ap) => pathWithin(resolved, ap));
    if (!ok) {
      throw new IntegrityError("FAIL_CLOSED_OP_PATH_OUT_OF_SCOPE", raw);
    }
    return resolved;
  }

  private async runOp(index: number, op: Record<string, unknown>): Promise<string> {
    const name = String(op.op);
    if (AUTOMATON_HARNESS_DENIED_OPS.includes(name)) {
      throw new IntegrityError("FAIL_CLOSED_WORKER_OP_NOT_ALLOWED", `denied:${name}`);
    }
    if (!this.spec.policy.allowed_ops.includes(name)) {
      throw new IntegrityError("FAIL_CLOSED_V2_OP_DISABLED", name);
    }
    switch (name) {
      case "read_text_file": {
        const p = this.resolveOpPath(String(op.path));
        const content = await fs.readFile(p, "utf8");
        this.lastReadOutput = content;
        return content.slice(0, 10_000) || "(empty file)";
      }
      case "write_text_file": {
        const p = this.resolveOpPath(String(op.path));
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, String(op.content), "utf8");
        this.artifacts.push(path.relative(this.spec.workspace_root, p));
        return p;
      }
      case "append_text_file": {
        const p = this.resolveOpPath(String(op.path));
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.appendFile(p, String(op.content), "utf8");
        this.artifacts.push(path.relative(this.spec.workspace_root, p));
        return p;
      }
      case "sleep_ms": {
        const ms = Math.min(Math.max(Number(op.ms) || 0, 0), 10_000);
        await new Promise((resolve) => setTimeout(resolve, ms));
        return `slept ${ms}ms`;
      }
      case "finish": {
        this.finishResult = (op.result as Record<string, unknown>) ?? {};
        return "FINISHED";
      }
      default:
        throw new IntegrityError("FAIL_CLOSED_WORKER_OP_NOT_ALLOWED", name);
    }
  }

  async execute(): Promise<TaskResult> {
    const spec = this.spec;
    const startedAt = Date.now();
    const deadline = startedAt + spec.limits.timeout_seconds * 1000;
    let failure: { class: string; detail: string } | null = null;
    let status: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT" = "COMPLETED";

    for (const [index, op] of spec.ops.entries()) {
      const name = String(op.op);
      const argsDigest = digest(op);
      this.journal("op_started", { index, op: name, args_digest: argsDigest });
      if (this.context.abortSignal.aborted) {
        status = "CANCELLED";
        failure = { class: "CANCELLED", detail: "worker aborted before op" };
        this.journal("op_failed", { index, op: name, error: "aborted" });
        break;
      }
      if (Date.now() > deadline) {
        status = "TIMEOUT";
        failure = { class: "TIMEOUT", detail: "spec timeout_seconds exceeded" };
        this.journal("op_failed", { index, op: name, error: "timeout" });
        break;
      }
      try {
        const detail = await this.runOp(index, op);
        this.opsCompleted.push({ index, op: name, args_digest: argsDigest, status: "COMPLETED" });
        this.journal("op_completed", { index, op: name, args_digest: argsDigest });
        if (name === "finish") {
          break;
        }
        void detail;
      } catch (error) {
        status = "FAILED";
        failure = {
          class: error instanceof IntegrityError ? error.code : "EXECUTION_ERROR",
          detail: error instanceof Error ? error.message : String(error),
        };
        this.opsCompleted.push({
          index,
          op: name,
          args_digest: argsDigest,
          status: "FAILED",
          detail: failure.detail,
        });
        this.journal("op_failed", {
          index,
          op: name,
          error: `${failure.class}:${failure.detail}`,
        });
        break;
      }
    }

    // Explicit result state: a spec that ran all ops but never hit `finish`
    // is ambiguous → FAILED, never silently COMPLETED.
    if (status === "COMPLETED" && !this.finishResult) {
      status = "FAILED";
      failure = {
        class: "FAIL_CLOSED_WORKER_NO_FINISH",
        detail: "spec completed without finish op",
      };
      this.journal("worker_no_finish", {});
    }

    const paths = workerFilePaths(spec.run_root);
    this.journal("worker_finished", {
      status,
      error: failure,
      ops_completed: this.opsCompleted.length,
    });
    this.writeResultFile(status, failure, startedAt);

    const output = this.finishResult
      ? String(this.finishResult.summary ?? this.finishResult.output ?? "spec executed")
      : `${failure?.class ?? status}: ${failure?.detail ?? "spec did not finish"}`;
    return {
      success: status === "COMPLETED",
      output: this.lastReadOutput && status === "COMPLETED"
        ? `${output}\n---\nlast_read:\n${this.lastReadOutput.slice(0, 2000)}`
        : output,
      artifacts: [...new Set(this.artifacts)],
      costCents: this.context.budget.costUsedCents,
      duration: Date.now() - startedAt,
    };
  }

  /** result.json — the only canonical worker result. */
  private writeResultFile(
    status: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT",
    failure: { class: string; detail: string } | null,
    startedAt: number,
  ): void {
    const spec = this.spec;
    const paths = workerFilePaths(spec.run_root);
    const artifacts = [...new Set(this.artifacts)].map((rel) => {
      const abs = path.resolve(spec.workspace_root, rel);
      return {
        path: rel,
        sha256: fsSync.existsSync(abs) ? sha256File(abs) : null,
        byte_size: fsSync.existsSync(abs) ? fsSync.statSync(abs).size : 0,
      };
    });
    const result = {
      schema: WORKER_RESULT_SCHEMA,
      worker_execution_id: spec.worker_execution_id,
      execution_id: spec.execution_id,
      governed_task_id: spec.governed_task_id,
      mission_id: spec.mission_id,
      task_id: spec.task_id,
      correlation_id: spec.correlation_id,
      worker_kind: AUTOMATON_HARNESS_WORKER_KIND,
      status,
      output: this.finishResult ?? {},
      summary: this.finishResult ? String(this.finishResult.summary ?? "") : "",
      artifacts,
      ops_completed: this.opsCompleted,
      started_at: new Date(startedAt).toISOString(),
      completed_at: utcnow(),
      error: failure,
      provenance: {
        producer: PAIR_SPEC_ROLE,
        worker_kind: AUTOMATON_HARNESS_WORKER_KIND,
        transport: "AUTOMATON_LOCAL_WORKER_POOL",
      },
    };
    const tmp = `${paths.result}.tmp-${process.pid}`;
    fsSync.mkdirSync(path.dirname(paths.result), { recursive: true });
    fsSync.writeFileSync(tmp, canonicalJson(result) + "\n", "utf8");
    fsSync.renameSync(tmp, paths.result);
  }
}
